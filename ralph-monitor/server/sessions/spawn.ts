// Spawn-primitive: prepareSpawn + spawnSession + resumeSession.
//
// `prepareSpawn` does the pre-flight bookkeeping — validate the project,
// resolve the cwd, allocate the UUID + JSONL path, INSERT the row with a NULL
// pid.
//
// `spawnSession` builds on top: calls `prepareSpawn`, spawns the real claude
// PTY child via bun-pty, registers the handle, updates the row with the live
// pid, and emits `session.created`. The synchronous-registration invariant —
// `register()` is called immediately after `pty.spawn()` returns and before
// any `await` — guarantees an external observer never sees a "live row, no
// handle" half-state. If registration throws, spawnSession SIGTERMs the child
// (waiting up to 5s before SIGKILL) and hard-deletes the row.
//
// `resumeSession` re-spawns `claude --resume <id>` for an existing dormant
// session, falling back to `--session-id` (fresh spawn under the same uuid)
// when the JSONL doesn't exist on disk yet (session was created but never had
// a turn before the server died).

import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import * as pty from 'bun-pty'
import type { IPty, IPtyForkOptions, IExitEvent } from 'bun-pty'

import { getDb } from '../db'
import { getProjectById } from '../db/projects'
import {
  createSession,
  getSessionById,
  hardDeleteSession,
  updateSession,
} from '../db/sessions'
import { encodeClaudeProjectDir } from '../jsonl/paths'
import { store } from '../store'
import { register, unregister, type PtyHandle } from './registry'
import { RingBuffer } from './ringBuffer'
import { withProjectLock } from './spawnMutex'
import { computeSessionStatus } from './status'

export const DEFAULT_PTY_BUFFER_BYTES = 262144
export const DEFAULT_PTY_GRACE_MS = 60000

function readBufferBytesEnv(): number {
  const raw = process.env.RALPH_MONITOR_PTY_BUFFER_BYTES
  if (raw === undefined) return DEFAULT_PTY_BUFFER_BYTES
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `[ralph-monitor] invalid RALPH_MONITOR_PTY_BUFFER_BYTES=${raw!}, falling back to ${DEFAULT_PTY_BUFFER_BYTES}`,
    )
    return DEFAULT_PTY_BUFFER_BYTES
  }
  return n
}

function readGraceMsEnv(): number {
  const raw = process.env.RALPH_MONITOR_PTY_GRACE_MS
  if (raw === undefined) return DEFAULT_PTY_GRACE_MS
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PTY_GRACE_MS
  return n
}

export class ProjectNotFoundError extends Error {
  override readonly name = 'ProjectNotFoundError'
}

export class CwdResolutionError extends Error {
  override readonly name = 'CwdResolutionError'
}

export class SessionNotFoundError extends Error {
  override readonly name = 'SessionNotFoundError'
}
export class SessionAlreadyLiveError extends Error {
  override readonly name = 'SessionAlreadyLiveError'
}
export class SessionInGraceWindowError extends Error {
  override readonly name = 'SessionInGraceWindowError'
}
export class JsonlMissingError extends Error {
  override readonly name = 'JsonlMissingError'
}

export interface PrepareSpawnInput {
  project_id: string
  mode: 'interactive' | 'autonomous'
  working_dir?: string
  title?: string
}

export interface PrepareSpawnResult {
  uuid: string
  jsonlPath: string
  resolvedCwd: string
  projectRootDir: string
  projectName: string
}

export async function prepareSpawn(
  input: PrepareSpawnInput,
): Promise<PrepareSpawnResult> {
  return withProjectLock(input.project_id, () => prepareSpawnInner(input))
}

async function prepareSpawnInner(
  input: PrepareSpawnInput,
): Promise<PrepareSpawnResult> {
  const db = getDb()

  const project = getProjectById(db, input.project_id)
  if (!project) {
    throw new ProjectNotFoundError(`project not found: ${input.project_id}`)
  }

  const candidate = input.working_dir ?? project.root_dir

  let resolvedCwd: string
  try {
    resolvedCwd = realpathSync.native(candidate)
  } catch (err) {
    throw new CwdResolutionError(
      `cannot resolve working_dir ${candidate}: ${(err as Error).message}`,
    )
  }
  if (resolvedCwd.length > 1 && resolvedCwd.endsWith('/')) {
    resolvedCwd = resolvedCwd.slice(0, -1)
  }

  const uuid = crypto.randomUUID()
  const encoded = encodeClaudeProjectDir(resolvedCwd)
  const home = process.env.HOME ?? homedir()
  const jsonlPath = path.join(home, '.claude', 'projects', encoded, `${uuid}.jsonl`)

  createSession(db, {
    id: uuid,
    project_id: input.project_id,
    mode: input.mode,
    jsonl_path: jsonlPath,
    working_dir: input.working_dir ?? null,
    title: input.title ?? null,
    process_pid: null,
    process_started_at: null,
  })

  return {
    uuid,
    jsonlPath,
    resolvedCwd,
    projectRootDir: project.root_dir,
    projectName: project.name,
  }
}

// ---------------------------------------------------------------------------
// spawnSession
// ---------------------------------------------------------------------------

export interface SpawnerChild {
  readonly pid: number
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: IExitEvent) => void): { dispose(): void }
  write(data: string): void
  resize(columns: number, rows: number): void
  kill(signal?: string): void
}

export type PtySpawner = (
  file: string,
  args: string[],
  options: IPtyForkOptions,
) => SpawnerChild

export const defaultSpawner: PtySpawner = (file, args, options) =>
  pty.spawn(file, args, options) as IPty as SpawnerChild

let testSpawner: PtySpawner | null = null
export function setTestSpawner(s: PtySpawner | null): void {
  testSpawner = s
}
export function getSpawner(): PtySpawner {
  return testSpawner ?? defaultSpawner
}

export interface SpawnSessionInput {
  project_id: string
  mode: 'interactive' | 'autonomous'
  working_dir?: string
  initial_prompt?: string
  title?: string
}

export interface SpawnSessionOptions {
  spawner?: PtySpawner
}

export interface SpawnSessionResult {
  id: string
  jsonlPath: string
  pid: number
}

export function buildClaudeArgv(args: {
  uuid: string
  projectName: string
  resolvedCwd: string
  projectRootDir: string
}): string[] {
  const argv: string[] = [
    'claude',
    '--session-id',
    args.uuid,
    '--dangerously-skip-permissions',
    '--name',
    `${args.projectName.trim()}:${args.uuid.slice(0, 8)}`,
  ]
  if (args.resolvedCwd !== args.projectRootDir) {
    argv.push('--add-dir', args.projectRootDir)
  }
  return argv
}

const SIGNAL_NAME_TO_NUMBER: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5,
  SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10,
  SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
}
function normalizeExitSignal(sig: number | string | undefined): number | undefined {
  if (typeof sig === 'number') return sig
  if (typeof sig === 'string') return SIGNAL_NAME_TO_NUMBER[sig]
  return undefined
}

function signalToString(sig: NodeJS.Signals | number | undefined): string | undefined {
  if (sig === undefined) return undefined
  if (typeof sig === 'string') return sig
  for (const [name, num] of Object.entries(SIGNAL_NAME_TO_NUMBER)) {
    if (num === sig) return name
  }
  return undefined
}

function buildPtyHandle(args: {
  child: SpawnerChild
  sessionId: string
  projectId: string
  buffer: RingBuffer
}): PtyHandle {
  const { child, sessionId, projectId, buffer } = args
  const dataSubscribers = new Set<(chunk: Uint8Array) => void>()
  const exitSubscribers = new Set<(exit: { exitCode: number; signal?: number }) => void>()

  child.onData((data: string) => {
    const bytes = Buffer.from(data, 'utf8')
    buffer.append(bytes)
    for (const cb of [...dataSubscribers]) {
      try { cb(bytes) } catch {}
    }
  })

  child.onExit((ev: IExitEvent) => {
    const normalized = { exitCode: ev.exitCode, signal: normalizeExitSignal(ev.signal) }
    handle.exited = true
    handle.lastExit = normalized
    for (const cb of [...exitSubscribers]) {
      try { cb(normalized) } catch {}
    }
  })

  const handle: PtyHandle = {
    sessionId,
    projectId,
    pid: child.pid,
    buffer,
    exited: false,
    lastExit: null,
    write(data) {
      const s = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
      child.write(s)
    },
    resize(cols, rows) { child.resize(cols, rows) },
    onData(cb) {
      dataSubscribers.add(cb)
      return () => { dataSubscribers.delete(cb) }
    },
    onExit(cb) {
      exitSubscribers.add(cb)
      return () => { exitSubscribers.delete(cb) }
    },
    kill(signal) { child.kill(signalToString(signal)) },
  }
  return handle
}

export async function spawnSession(
  input: SpawnSessionInput,
  options: SpawnSessionOptions = {},
): Promise<SpawnSessionResult> {
  const spawner = options.spawner ?? defaultSpawner

  const prep = await prepareSpawn({
    project_id: input.project_id,
    mode: input.mode,
    working_dir: input.working_dir,
    title: input.title,
  })

  const db = getDb()

  const argv = buildClaudeArgv({
    uuid: prep.uuid,
    projectName: prep.projectName,
    resolvedCwd: prep.resolvedCwd,
    projectRootDir: prep.projectRootDir,
  })
  const file = argv[0]!
  const args = argv.slice(1)

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    RALPH_MONITOR_SESSION: prep.uuid,
  }
  if (!env.TERM) env.TERM = 'xterm-256color'

  try {
    mkdirSync(path.dirname(prep.jsonlPath), { recursive: true, mode: 0o700 })
  } catch (err) {
    hardDeleteSession(db, prep.uuid)
    throw err
  }

  let child: SpawnerChild
  try {
    child = spawner(file, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: prep.resolvedCwd,
      env,
    })
  } catch (err) {
    hardDeleteSession(db, prep.uuid)
    throw err
  }

  const buffer = new RingBuffer(readBufferBytesEnv())
  const handle = buildPtyHandle({
    child,
    sessionId: prep.uuid,
    projectId: input.project_id,
    buffer,
  })

  try {
    register(handle)
  } catch (err) {
    try { child.kill('SIGTERM') } catch {}
    try {
      const result = await Promise.race<'exited' | 'timeout'>([
        new Promise<'exited'>((resolve) => {
          const sub = child.onExit(() => {
            try { sub.dispose() } catch {}
            resolve('exited')
          })
        }),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000)),
      ])
      if (result === 'timeout') {
        try { child.kill('SIGKILL') } catch {}
      }
    } catch {}
    hardDeleteSession(db, prep.uuid)
    throw err
  }

  const startedAt = Date.now()
  try {
    updateSession(db, prep.uuid, {
      process_pid: child.pid,
      process_started_at: startedAt,
    })
  } catch (err) {
    unregister(prep.uuid)
    try { child.kill('SIGTERM') } catch {}
    hardDeleteSession(db, prep.uuid)
    throw err
  }

  handle.onExit((exit) => {
    try {
      updateSession(db, prep.uuid, {
        process_pid: null,
        process_started_at: null,
        last_activity_at: Date.now(),
      })
    } catch {}
    store.recordEvent({
      type: 'session.exited',
      ts: Date.now(),
      id: prep.uuid,
      exit_code: exit.exitCode,
    })
    const graceMs = readGraceMsEnv()
    if (graceMs <= 0) {
      handle.buffer.clear()
      unregister(prep.uuid)
      return
    }
    const t = setTimeout(() => {
      handle.buffer.clear()
      unregister(prep.uuid)
    }, graceMs)
    if (typeof t.unref === 'function') t.unref()
  })

  const session = getSessionById(db, prep.uuid)
  if (session) {
    store.recordEvent({ type: 'session.created', ts: Date.now(), session })
  }

  if (
    typeof input.initial_prompt === 'string' &&
    input.initial_prompt.length > 0
  ) {
    handle.write(input.initial_prompt + '\r')
  }

  return {
    id: prep.uuid,
    jsonlPath: prep.jsonlPath,
    pid: child.pid,
  }
}

// ---------------------------------------------------------------------------
// resumeSession
// ---------------------------------------------------------------------------
//
// Re-opens an existing dormant session. If the JSONL exists on disk we use
// `claude --resume <uuid>`; otherwise we fall back to `--session-id` for a
// fresh spawn under the same uuid. Failures DO NOT hard-delete the row — the
// JSONL is the user's chat history.

export interface ResumeSessionInput {
  session_id: string
}

export interface ResumeSessionOptions {
  spawner?: PtySpawner
}

export interface ResumeSessionResult {
  id: string
  jsonlPath: string
  pid: number
}

export async function resumeSession(
  input: ResumeSessionInput,
  opts: ResumeSessionOptions = {},
): Promise<ResumeSessionResult> {
  const spawner = opts.spawner ?? defaultSpawner
  const db = getDb()

  const session = getSessionById(db, input.session_id)
  if (!session) {
    throw new SessionNotFoundError(`session not found: ${input.session_id}`)
  }

  const status = computeSessionStatus(session)
  if (status === 'live-attached' || status === 'live-orphaned') {
    throw new SessionAlreadyLiveError(
      `session ${session.id} is already live (${status})`,
    )
  }
  if (status === 'exited') {
    throw new SessionInGraceWindowError(
      `session ${session.id} is in the post-exit grace window; wait or kill explicitly`,
    )
  }

  const hasJsonl = existsSync(session.jsonl_path)

  const project = getProjectById(db, session.project_id)
  if (!project) {
    throw new SessionNotFoundError(
      `project ${session.project_id} for session ${session.id} not found`,
    )
  }
  const candidate = session.working_dir ?? project.root_dir
  let resolvedCwd: string
  try {
    resolvedCwd = realpathSync.native(candidate)
  } catch (err) {
    throw new CwdResolutionError(
      `cannot resolve working_dir ${candidate}: ${(err as Error).message}`,
    )
  }
  if (resolvedCwd.length > 1 && resolvedCwd.endsWith('/')) {
    resolvedCwd = resolvedCwd.slice(0, -1)
  }
  let projectRootDir = project.root_dir
  if (projectRootDir.length > 1 && projectRootDir.endsWith('/')) {
    projectRootDir = projectRootDir.slice(0, -1)
  }

  return withProjectLock(session.project_id, () =>
    resumeSessionInner({
      spawner,
      session,
      projectName: project.name,
      resolvedCwd,
      projectRootDir,
      hasJsonl,
    }),
  )
}

async function resumeSessionInner(args: {
  spawner: PtySpawner
  session: { id: string; project_id: string; jsonl_path: string }
  projectName: string
  resolvedCwd: string
  projectRootDir: string
  hasJsonl: boolean
}): Promise<ResumeSessionResult> {
  const { spawner, session, projectName, resolvedCwd, projectRootDir, hasJsonl } = args
  const db = getDb()

  const argv: string[] = hasJsonl
    ? ['claude', '--resume', session.id, '--dangerously-skip-permissions']
    : [
        'claude',
        '--session-id',
        session.id,
        '--dangerously-skip-permissions',
        '--name',
        `${projectName}:${session.id.slice(0, 8)}`,
      ]
  if (resolvedCwd !== projectRootDir) {
    argv.push('--add-dir', projectRootDir)
  }
  const file = argv[0]!
  const spawnArgs = argv.slice(1)

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    RALPH_MONITOR_SESSION: session.id,
  }
  if (!env.TERM) env.TERM = 'xterm-256color'

  let child: SpawnerChild
  try {
    child = spawner(file, spawnArgs, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: resolvedCwd,
      env,
    })
  } catch (err) {
    throw err
  }

  const buffer = new RingBuffer(readBufferBytesEnv())
  const handle = buildPtyHandle({
    child,
    sessionId: session.id,
    projectId: session.project_id,
    buffer,
  })

  try {
    register(handle)
  } catch (err) {
    try { child.kill('SIGTERM') } catch {}
    try {
      const result = await Promise.race<'exited' | 'timeout'>([
        new Promise<'exited'>((resolve) => {
          const sub = child.onExit(() => {
            try { sub.dispose() } catch {}
            resolve('exited')
          })
        }),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000)),
      ])
      if (result === 'timeout') {
        try { child.kill('SIGKILL') } catch {}
      }
    } catch {}
    throw err
  }

  const startedAt = Date.now()
  try {
    updateSession(db, session.id, {
      process_pid: child.pid,
      process_started_at: startedAt,
      last_activity_at: startedAt,
    })
  } catch (err) {
    unregister(session.id)
    try { child.kill('SIGTERM') } catch {}
    throw err
  }

  handle.onExit((exit) => {
    try {
      updateSession(db, session.id, {
        process_pid: null,
        process_started_at: null,
        last_activity_at: Date.now(),
      })
    } catch {}
    store.recordEvent({
      type: 'session.exited',
      ts: Date.now(),
      id: session.id,
      exit_code: exit.exitCode,
    })
    const graceMs = readGraceMsEnv()
    if (graceMs <= 0) {
      handle.buffer.clear()
      unregister(session.id)
      return
    }
    const t = setTimeout(() => {
      handle.buffer.clear()
      unregister(session.id)
    }, graceMs)
    if (typeof t.unref === 'function') t.unref()
  })

  const updated = getSessionById(db, session.id)
  if (updated) {
    store.recordEvent({ type: 'session.updated', ts: Date.now(), session: updated })
  }

  return {
    id: session.id,
    jsonlPath: session.jsonl_path,
    pid: child.pid,
  }
}
