// Spawn-primitive: prepareSpawn + spawnSession.
//
// `prepareSpawn` (US-005a-1) does the pre-flight bookkeeping — validate the
// effort, resolve the cwd, allocate the UUID + JSONL path, refuse if a live
// session already exists for this effort, and INSERT the row with a NULL pid.
//
// `spawnSession` (US-005a-2) builds on top: it calls `prepareSpawn`, then
// spawns the real claude PTY child via bun-pty, registers the handle in the
// in-memory PtyHandle registry, updates the row with the live pid, and emits
// `session.created`. The "synchronous registration invariant" — `register()`
// must be called immediately after `pty.spawn()` returns and before any
// `await` — guarantees an external observer never sees a "live row, no
// handle" half-state. If registration throws (collision, etc.), spawnSession
// SIGTERMs the child (waiting up to 5s before SIGKILL) and hard-deletes the
// row, so failures roll back fully rather than persisting a zombie row.
//
// What follows is `prepareSpawn`'s pre-flight bookkeeping that a real spawner
// needs:
//
//   1. Validate the effort exists (and reach the parent project so we can
//      fall back to project.root_dir if the effort/session don't override).
//   2. Resolve a working directory through the chain
//        session.working_dir ?? effort.working_dir ?? project.root_dir
//      and realpath it (typed error on failure — eg. ENOENT).
//   3. Pre-allocate a UUID for the session id (also the JSONL filename).
//   4. Compute the JSONL path under ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
//      using the per-character encoder confirmed in US-000a.
//   5. Refuse to insert if the effort already has a live session — JS-level
//      pre-check (the partial unique index in sqlite is on rows where
//      process_pid IS NOT NULL, so a row inserted here with NULL pid would
//      slip past it; the explicit pre-check enforces the invariant).
//   6. INSERT the row with process_pid = NULL.
//   7. Return the metadata (uuid, jsonlPath, resolvedCwd, projectRootDir)
//      that US-005a-2's actual spawner needs to call pty.spawn() and update
//      the row with the real pid.
//
// The whole thing runs under withEffortLock(effort_id) so two concurrent
// callers for the same effort serialize: the second one sees the first's
// inserted row in the JS-level pre-check and is rejected with the typed
// "already live" error.
//
// AC interpretation note (re: the prd.json line "If the partial-unique-index
// check fires (effort already has a live session), surfaces a 409 typed error
// and rolls back"): the partial unique index in sqlite is on
// `(effort_id) WHERE process_pid IS NOT NULL`, so it does NOT fire for a row
// inserted here with `process_pid = NULL`. We honor the *intent* of the AC
// (one prepareSpawn at a time per effort, refused if a live session exists)
// via the JS-level pre-check + the per-effort mutex. The mutex closes the
// otherwise-open TOCTOU window between the pre-check and the INSERT. We also
// keep the SQLite-level catch in place as a defense-in-depth — if a future
// schema change widens the partial index, or if a live row materializes via
// some other path between pre-check and insert (it shouldn't, but if), the
// catch surfaces it as the same typed error.

import { mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import * as pty from 'bun-pty'
import type { IPty, IPtyForkOptions, IExitEvent } from 'bun-pty'

import { getDb } from '../db'
import { getEffortById } from '../db/efforts'
import { getProjectById } from '../db/projects'
import {
  createSession,
  getSessionById,
  hardDeleteSession,
  listSessionsByEffort,
  updateSession,
  OneLiveSessionPerEffortError,
} from '../db/sessions'
import { encodeClaudeProjectDir } from '../jsonl/paths'
import { store } from '../store'
import { register, unregister, type PtyHandle } from './registry'
import { RingBuffer } from './ringBuffer'
import { withEffortLock } from './spawnMutex'

// Default ring-buffer capacity (bytes) for PTY output replay. 256 KiB is
// enough to capture a few screens of dense terminal output; configurable via
// RALPH_MONITOR_PTY_BUFFER_BYTES. Exported only so tests can reference the
// same default rather than duplicating the magic number.
export const DEFAULT_PTY_BUFFER_BYTES = 262144

// Default grace period (ms) to keep a handle in the registry AFTER the PTY
// exits, so a client that attaches in the gap between exit and unregister
// still sees the final output via replay. Configurable via
// RALPH_MONITOR_PTY_GRACE_MS.
export const DEFAULT_PTY_GRACE_MS = 60000

function readBufferBytesEnv(): number {
  const raw = process.env.RALPH_MONITOR_PTY_BUFFER_BYTES
  if (raw === undefined) return DEFAULT_PTY_BUFFER_BYTES
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) {
    // eslint-disable-next-line no-console
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
  // Negative or NaN -> default; 0 is permitted (immediate cleanup, useful
  // in tests that don't want a setTimeout dangling).
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PTY_GRACE_MS
  return n
}

export class EffortNotFoundError extends Error {
  override readonly name = 'EffortNotFoundError'
}

export class CwdResolutionError extends Error {
  override readonly name = 'CwdResolutionError'
}

// Mirror of db-layer OneLiveSessionPerEffortError, surfaced at the prep
// boundary. Distinct class so callers can `instanceof` and translate to a
// 409 in the route layer without conflating it with the lower-level SQLite
// constraint error.
export class OneLiveSessionPerEffortPrepError extends Error {
  override readonly name = 'OneLiveSessionPerEffortPrepError'
}

export interface PrepareSpawnInput {
  effort_id: string
  mode: 'interactive' | 'autonomous'
  working_dir?: string
  title?: string
}

export interface PrepareSpawnResult {
  uuid: string
  jsonlPath: string
  resolvedCwd: string
  projectRootDir: string
}

export async function prepareSpawn(
  input: PrepareSpawnInput,
): Promise<PrepareSpawnResult> {
  return withEffortLock(input.effort_id, () => prepareSpawnInner(input))
}

async function prepareSpawnInner(
  input: PrepareSpawnInput,
): Promise<PrepareSpawnResult> {
  const db = getDb()

  const effort = getEffortById(db, input.effort_id)
  if (!effort) {
    throw new EffortNotFoundError(`effort not found: ${input.effort_id}`)
  }

  const project = getProjectById(db, effort.project_id)
  if (!project) {
    // Schema-wise this should never happen (FK on efforts.project_id), but
    // a corrupted DB or partial cascade is theoretically possible. Surface
    // the same EffortNotFound class — from the caller's perspective the
    // effort is unusable for spawning either way.
    throw new EffortNotFoundError(
      `project ${effort.project_id} for effort ${input.effort_id} not found`,
    )
  }

  // Working-dir resolution chain. Per the AC: session input wins, else
  // effort.working_dir, else project.root_dir. project.root_dir is already
  // realpath'd at insert (per US-001), so for that branch the realpath call
  // below is a no-op modulo edge cases like a deleted-since-creation dir.
  const candidate =
    input.working_dir ?? effort.working_dir ?? project.root_dir

  let resolvedCwd: string
  try {
    resolvedCwd = realpathSync.native(candidate)
  } catch (err) {
    throw new CwdResolutionError(
      `cannot resolve working_dir ${candidate}: ${(err as Error).message}`,
    )
  }
  // Defensive: realpathSync.native typically drops a trailing slash for
  // non-root paths, but we strip it here so the encoder doesn't get a
  // trailing `-` (and so the same inputs produce the same encoded output
  // regardless of the libc behavior).
  if (resolvedCwd.length > 1 && resolvedCwd.endsWith('/')) {
    resolvedCwd = resolvedCwd.slice(0, -1)
  }

  // JS-level pre-check for one-live-session-per-effort. The partial unique
  // index in sqlite is on `(effort_id) WHERE process_pid IS NOT NULL`, so a
  // row with NULL pid (which is what prepareSpawn inserts) does NOT trip
  // it. The lock above guarantees we're the only caller for this effort,
  // so the read+write is atomic in effect even though sqlite isn't enforcing
  // it.
  const existing = listSessionsByEffort(db, input.effort_id)
  const live = existing.find((s) => s.process_pid !== null)
  if (live) {
    throw new OneLiveSessionPerEffortPrepError(
      `effort ${input.effort_id} already has a live session: ${live.id}`,
    )
  }

  const uuid = crypto.randomUUID()
  const encoded = encodeClaudeProjectDir(resolvedCwd)
  // ~/.claude/projects/<encoded>/<uuid>.jsonl
  const home = process.env.HOME ?? homedir()
  const jsonlPath = path.join(home, '.claude', 'projects', encoded, `${uuid}.jsonl`)

  try {
    createSession(db, {
      id: uuid,
      effort_id: input.effort_id,
      mode: input.mode,
      jsonl_path: jsonlPath,
      working_dir: input.working_dir ?? null,
      title: input.title ?? null,
      process_pid: null,
      process_started_at: null,
    })
  } catch (err) {
    // Defense-in-depth: if a row with process_pid != null somehow trips the
    // partial unique index in between our pre-check and this INSERT (e.g.
    // a future schema widening or an out-of-band insert), surface it as
    // the same typed error so route handlers can translate uniformly.
    if (err instanceof OneLiveSessionPerEffortError) {
      throw new OneLiveSessionPerEffortPrepError(
        `effort ${input.effort_id} already has a live session (sqlite)`,
      )
    }
    throw err
  }

  return {
    uuid,
    jsonlPath,
    resolvedCwd,
    projectRootDir: project.root_dir,
  }
}

// ---------------------------------------------------------------------------
// spawnSession — US-005a-2
// ---------------------------------------------------------------------------

// Minimal contract that mirrors bun-pty's `IPty` surface — we accept this
// instead of `IPty` directly so tests can pass a mock spawner that returns a
// fake child without dragging the bun-pty native bindings into unit tests.
// Production code goes through `defaultSpawner` which is `pty.spawn`.
export interface SpawnerChild {
  readonly pid: number
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: IExitEvent) => void): { dispose(): void }
  write(data: string): void
  resize(columns: number, rows: number): void
  kill(signal?: string): void
}

// `pty.spawn`'s actual signature is `(file, args, options: IPtyForkOptions)`
// where `IPtyForkOptions.name` is REQUIRED. We mirror that here so the types
// match what production passes in.
export type PtySpawner = (
  file: string,
  args: string[],
  options: IPtyForkOptions,
) => SpawnerChild

// Default spawner used in production. The cast to `SpawnerChild` is safe
// because `IPty`'s onData/onExit return `IDisposable` (which has the same
// `.dispose()` method we declared) and write/resize/kill match.
export const defaultSpawner: PtySpawner = (file, args, options) =>
  pty.spawn(file, args, options) as IPty as SpawnerChild

export interface SpawnSessionInput {
  effort_id: string
  mode: 'interactive' | 'autonomous'
  working_dir?: string
  // First prompt to type into the PTY after spawn. Honored only when
  // mode === 'autonomous' AND the string is non-empty; ignored otherwise
  // (interactive sessions take their first input from the user via WS).
  // US-005a-3 wires the actual write.
  initial_prompt?: string
  title?: string
}

export interface SpawnSessionOptions {
  // Injectable spawner for tests. Defaults to `defaultSpawner` (pty.spawn).
  spawner?: PtySpawner
}

export interface SpawnSessionResult {
  id: string
  jsonlPath: string
  pid: number
}

// Build the argv for `claude --session-id <uuid> --dangerously-skip-permissions
// --name <effort-name>:<uuid-prefix> [--add-dir <projectRootDir>]`. The first
// element is `'claude'`, but bun-pty takes the file as a separate first arg,
// so callers will pass `argv.slice(1)` to the spawner.
//
// Exported for test assertions; US-005d's route layer also reuses this shape.
export function buildClaudeArgv(args: {
  uuid: string
  effortName: string
  resolvedCwd: string
  projectRootDir: string
}): string[] {
  const argv: string[] = [
    'claude',
    '--session-id',
    args.uuid,
    '--dangerously-skip-permissions',
    '--name',
    `${args.effortName.trim()}:${args.uuid.slice(0, 8)}`,
  ]
  if (args.resolvedCwd !== args.projectRootDir) {
    argv.push('--add-dir', args.projectRootDir)
  }
  return argv
}

// Coerce IExitEvent.signal (number | string | undefined) to the
// PtyHandle.onExit-callback contract (number | undefined). The Linux signal
// table is well-known but we deliberately don't translate string -> number
// here — we just drop unknown strings as undefined so callers don't need to
// invent fake numeric codes. The exit_code in `session.exited` is what
// downstream cares about anyway.
const SIGNAL_NAME_TO_NUMBER: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
}
function normalizeExitSignal(sig: number | string | undefined): number | undefined {
  if (typeof sig === 'number') return sig
  if (typeof sig === 'string') return SIGNAL_NAME_TO_NUMBER[sig]
  return undefined
}

// Coerce kill-signal arg from PtyHandle's accepted shape (NodeJS.Signals
// string | number) to bun-pty's accepted shape (string only). Numbers are
// reverse-mapped via the table; unknown numbers fall through to undefined
// which causes bun-pty to use its own default ('SIGTERM').
function signalToString(sig: NodeJS.Signals | number | undefined): string | undefined {
  if (sig === undefined) return undefined
  if (typeof sig === 'string') return sig
  for (const [name, num] of Object.entries(SIGNAL_NAME_TO_NUMBER)) {
    if (num === sig) return name
  }
  return undefined
}

// Build the PtyHandle adapter around a spawner's child. Exported only so
// future stories (and the test for the auto-cleanup branch) can inspect it
// in isolation; production callers go through `spawnSession`.
//
// Fan-out adapter pattern (US-005c): a SINGLE underlying child.onData/onExit
// subscription multiplexes to N PtyHandle subscribers + the ring buffer.
// This is required for the buffer to capture every byte regardless of
// whether anyone has called handle.onData yet — the underlying child
// callback fires once per PTY chunk, the adapter buffers AND broadcasts.
//
// Subscriber-set semantics: we iterate a SNAPSHOT of the set per dispatch
// (`[...dataSubscribers]`) so a callback that adds/removes a subscriber
// during fanout doesn't perturb the in-flight iteration. New subscribers
// added during fanout will see the NEXT chunk, not the current one;
// subscribers removed during fanout that have already been called will
// still complete their current invocation. Standard pub-sub semantics.
function buildPtyHandle(args: {
  child: SpawnerChild
  sessionId: string
  effortId: string
  buffer: RingBuffer
}): PtyHandle {
  const { child, sessionId, effortId, buffer } = args
  const dataSubscribers = new Set<(chunk: Uint8Array) => void>()
  const exitSubscribers = new Set<(exit: { exitCode: number; signal?: number }) => void>()

  // Single underlying onData -> ring buffer + fanout. The disposer is held
  // by the closure below (we don't expose it); it lives for the life of the
  // child, which is the life of the handle.
  child.onData((data: string) => {
    const bytes = Buffer.from(data, 'utf8')
    buffer.append(bytes)
    for (const cb of [...dataSubscribers]) {
      try {
        cb(bytes)
      } catch {
        // Subscriber failures must not poison sibling subscribers or the
        // buffer-append we already did. Swallow; the WS bridge wraps its
        // own send() in try/catch already, this is defense-in-depth.
      }
    }
  })

  // Single underlying onExit -> set exited/lastExit BEFORE fanning out, so
  // a subscriber that re-reads handle.exited (or a fresh attach racing the
  // exit) sees the post-exit state consistently.
  child.onExit((ev: IExitEvent) => {
    const normalized = { exitCode: ev.exitCode, signal: normalizeExitSignal(ev.signal) }
    handle.exited = true
    handle.lastExit = normalized
    for (const cb of [...exitSubscribers]) {
      try {
        cb(normalized)
      } catch {}
    }
  })

  const handle: PtyHandle = {
    sessionId,
    effortId,
    pid: child.pid,
    buffer,
    exited: false,
    lastExit: null,
    write(data) {
      const s = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
      child.write(s)
    },
    resize(cols, rows) {
      child.resize(cols, rows)
    },
    onData(cb) {
      dataSubscribers.add(cb)
      return () => {
        dataSubscribers.delete(cb)
      }
    },
    onExit(cb) {
      exitSubscribers.add(cb)
      return () => {
        exitSubscribers.delete(cb)
      }
    },
    kill(signal) {
      child.kill(signalToString(signal))
    },
  }
  return handle
}

export async function spawnSession(
  input: SpawnSessionInput,
  options: SpawnSessionOptions = {},
): Promise<SpawnSessionResult> {
  const spawner = options.spawner ?? defaultSpawner

  // 1. Pre-flight bookkeeping (per-effort lock, cwd resolution, row insert).
  const prep = await prepareSpawn({
    effort_id: input.effort_id,
    mode: input.mode,
    working_dir: input.working_dir,
    title: input.title,
  })

  const db = getDb()
  // We need the effort's `name` for the `--name` argv element. prepareSpawn
  // already validated existence, so this re-fetch is paranoia for the case
  // where the effort was deleted in between (FK ON DELETE would have already
  // taken our session row down with it; we'd get back null here).
  const effort = getEffortById(db, input.effort_id)
  if (!effort) {
    // Best-effort cleanup; the FK cascade likely already removed the row.
    hardDeleteSession(db, prep.uuid)
    throw new EffortNotFoundError(
      `effort ${input.effort_id} disappeared between prepareSpawn and spawnSession`,
    )
  }

  // 2. Argv. The spawner's `args` parameter expects argv WITHOUT the leading
  // file element, so slice(1) is what's actually handed to the PTY.
  const argv = buildClaudeArgv({
    uuid: prep.uuid,
    effortName: effort.name,
    resolvedCwd: prep.resolvedCwd,
    projectRootDir: prep.projectRootDir,
  })
  const file = argv[0]!
  const args = argv.slice(1)

  // 3. Env. Pass-through plus our marker. TERM is a courtesy default if the
  // parent doesn't set it (bun-pty's IPtyForkOptions.name controls TERMINFO
  // already, but real claude reads $TERM independently for color output).
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    RALPH_MONITOR_SESSION: prep.uuid,
  }
  if (!env.TERM) env.TERM = 'xterm-256color'

  // 4. Ensure the JSONL parent directory exists. Claude will create the
  // file itself on first message; we just need the directory to be there.
  // mode 0o700 because transcripts can contain user prompts / API output.
  try {
    mkdirSync(path.dirname(prep.jsonlPath), { recursive: true, mode: 0o700 })
  } catch (err) {
    hardDeleteSession(db, prep.uuid)
    throw err
  }

  // 5. Spawn the child. A synchronous throw (binary-not-found, cwd-invalid,
  // EACCES, etc.) is the only failure mode at this point; bun-pty surfaces
  // those eagerly. We hard-delete the row and rethrow so the caller sees the
  // underlying error with its original .name/.message.
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

  // 6. Build the PtyHandle adapter and register it. NO `await` between
  // spawn() and register() — that's the synchronous-registration invariant.
  // The ring buffer (US-005c) is allocated here so it lives as long as the
  // handle does; its capacity comes from RALPH_MONITOR_PTY_BUFFER_BYTES.
  const buffer = new RingBuffer(readBufferBytesEnv())
  const handle = buildPtyHandle({
    child,
    sessionId: prep.uuid,
    effortId: input.effort_id,
    buffer,
  })

  try {
    register(handle)
  } catch (err) {
    // 7. Registration failure → roll back everything: SIGTERM with a 5s
    // grace period, then SIGKILL, then hard-delete the row. We CAN await
    // here because we've already failed registration (no consumer can be
    // looking at the handle — it never made it into the map).
    try {
      child.kill('SIGTERM')
    } catch {
      // child may have already exited synchronously somehow; ignore.
    }
    try {
      const result = await Promise.race<'exited' | 'timeout'>([
        new Promise<'exited'>((resolve) => {
          const sub = child.onExit(() => {
            try { sub.dispose() } catch {}
            resolve('exited')
          })
        }),
        new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), 5000),
        ),
      ])
      if (result === 'timeout') {
        try { child.kill('SIGKILL') } catch {}
      }
    } catch {
      // Best-effort; if the wait/kill machinery breaks we still want to
      // delete the DB row below.
    }
    hardDeleteSession(db, prep.uuid)
    throw err
  }

  // 8. Stamp the live pid + start time on the DB row. If this throws (it
  // really shouldn't — we just inserted the row and we hold the only handle
  // pointing at it) we roll back to keep the registry/DB consistent.
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

  // 9. Wire auto-cleanup on PTY exit. Clear the live-pid columns + emit
  // `session.exited` immediately. The registry entry is kept around for a
  // grace period (US-005c, RALPH_MONITOR_PTY_GRACE_MS, default 60s) so a
  // late-attaching client can replay the final output AND see the recorded
  // exit code via handle.lastExit. After the grace period we drop the
  // buffer's bytes (proactive GC) and unregister.
  handle.onExit((exit) => {
    try {
      updateSession(db, prep.uuid, {
        process_pid: null,
        process_started_at: null,
        last_activity_at: Date.now(),
      })
    } catch {
      // Row might have been hard-deleted by an explicit cleanup path that
      // raced with the exit; ignore so we still record the event.
    }
    store.recordEvent({
      type: 'session.exited',
      ts: Date.now(),
      id: prep.uuid,
      exit_code: exit.exitCode,
    })
    const graceMs = readGraceMsEnv()
    if (graceMs <= 0) {
      // 0 (or invalid->0 fallback) => synchronous cleanup. Useful for
      // tests that don't want a setTimeout dangling past test end.
      handle.buffer.clear()
      unregister(prep.uuid)
      return
    }
    // unref() so a long grace timer doesn't hold the process open if all
    // other work has finished. The buffer/handle pair will still be GC'd
    // on process exit.
    const t = setTimeout(() => {
      handle.buffer.clear()
      unregister(prep.uuid)
    }, graceMs)
    if (typeof t.unref === 'function') t.unref()
  })

  // 10. Emit session.created. We re-fetch the row so the event payload
  // includes the freshly-stamped pid + process_started_at.
  const session = getSessionById(db, prep.uuid)
  if (session) {
    store.recordEvent({
      type: 'session.created',
      ts: Date.now(),
      session,
    })
  }

  // 11. Mode-conditional initial prompt write (US-005a-3). Placed AFTER the
  // `session.created` emit so any UI subscribed to lifecycle events sees the
  // session exist before the first byte arrives (and before output echoed
  // from this write streams out via the upcoming US-005c ring buffer). For
  // 'interactive' mode we never auto-write — the PTY's stdin remains open
  // and the user's first input arrives via WebSocket. For 'autonomous' with
  // no prompt (or an empty string) we also skip — caller's choice. claude
  // expects CR (\r) to submit a line, not LF; bun-pty's write() is
  // fire-and-forget so this is fully synchronous.
  if (
    input.mode === 'autonomous' &&
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
