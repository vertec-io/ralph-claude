// resumeSession tests — DB-backed, with a mock PTY spawner.
//
// Mirrors spawnSession.test.ts's harness: temp DB selected via
// $RALPH_MONITOR_DB before any DB-touching import, fake child + recording
// spawner, registry cleared in beforeEach.
//
// resumeSession differs from spawnSession in three load-bearing ways the
// suite exercises:
//   - The session row pre-exists (no prepareSpawn). We `createSession()`
//     directly with process_pid=null and a JSONL path that we touch on disk.
//   - Argv is `--resume <uuid> --dangerously-skip-permissions` (no
//     --session-id, no --name).
//   - Failures (already-live, missing jsonl, registration collision) do NOT
//     hard-delete the row — the row preserves user history.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_DB_DIR = mkdtempSync(join(tmpdir(), 'ralph-monitor-resumeSession-'))
const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db')
process.env.RALPH_MONITOR_DB = TEST_DB_PATH

const {
  getDb,
  closeDb,
  createProject,
  createEffort,
  createSession,
  getSessionById,
} = await import('../db')
const {
  resumeSession,
  SessionNotFoundError,
  SessionAlreadyLiveError,
  SessionInGraceWindowError,
  JsonlMissingError,
  OneLiveSessionPerEffortPrepError,
} = await import('./spawn')
import type { SpawnerChild, PtySpawner } from './spawn'
const { __test__: R, register, get: regGet } = await import('./registry')
const { RingBuffer } = await import('./ringBuffer')
const { store } = await import('../store')
import type { LifecycleAppEvent } from '../types'

const tempDirs: string[] = []
const tempJsonls: string[] = []

function tmpProjectDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ralph-monitor-resumeSession-proj-'))
  tempDirs.push(d)
  return d
}

function tmpJsonl(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ralph-monitor-resumeSession-jsonl-'))
  tempDirs.push(dir)
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, '{"hello":"world"}\n')
  tempJsonls.push(file)
  return file
}

afterAll(() => {
  try { closeDb() } catch {}
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
  try { rmSync(TEST_DB_DIR, { recursive: true, force: true }) } catch {}
})

beforeAll(() => {
  getDb()
})

beforeEach(() => {
  R.clear()
})

// -- Helpers ----------------------------------------------------------------

interface FakeChild extends SpawnerChild {
  triggerExit(event: { exitCode: number; signal?: number | string }): void
  triggerData(data: string): void
  killCalls: string[]
  writes: string[]
}

function fakeChild(pid = 12345): FakeChild {
  const dataListeners = new Set<(d: string) => void>()
  const exitListeners = new Set<(e: { exitCode: number; signal?: number | string }) => void>()
  const child: FakeChild = {
    pid,
    killCalls: [],
    writes: [],
    onData(listener) {
      dataListeners.add(listener)
      return { dispose: () => { dataListeners.delete(listener) } }
    },
    onExit(listener) {
      exitListeners.add(listener)
      return { dispose: () => { exitListeners.delete(listener) } }
    },
    write(data) { child.writes.push(data) },
    resize() {},
    kill(signal) { child.killCalls.push(signal ?? '<default>') },
    triggerExit(event) { for (const l of [...exitListeners]) l(event) },
    triggerData(data) { for (const l of [...dataListeners]) l(data) },
  }
  return child
}

interface RecordingSpawner {
  spawner: PtySpawner
  child: FakeChild
  calls: { file: string; args: string[]; cwd?: string; env?: Record<string, string> }[]
}

function recordingSpawner(child: FakeChild = fakeChild()): RecordingSpawner {
  const rec: RecordingSpawner = {
    child,
    calls: [],
    spawner: (file, args, options) => {
      rec.calls.push({ file, args: [...args], cwd: options.cwd, env: options.env })
      return child
    },
  }
  return rec
}

function captureEvents(): { events: LifecycleAppEvent[]; dispose: () => void } {
  const events: LifecycleAppEvent[] = []
  const id = store.subscribe(async (chunk: string) => {
    const m = chunk.match(/\ndata: (.+)\n\n$/)
    if (!m) return
    try {
      const evt = JSON.parse(m[1]!)
      events.push(evt as LifecycleAppEvent)
    } catch {}
  })
  return { events, dispose: () => store.unsubscribe(id) }
}

// Seed a project + effort + dormant session row + on-disk JSONL.
function seedDormant(opts: {
  projectName: string
  effortName: string
  effortWorkingDir?: string
}): { projectId: string; effortId: string; sessionId: string; jsonlPath: string; rootDir: string } {
  const dir = tmpProjectDir()
  const { projectId } = createProject(getDb(), { name: opts.projectName, root_dir: dir })
  const effort = createEffort(getDb(), {
    project_id: projectId,
    name: opts.effortName,
    kind: 'task',
    working_dir: opts.effortWorkingDir,
  })
  const sessionId = crypto.randomUUID()
  const jsonlPath = tmpJsonl()
  createSession(getDb(), {
    id: sessionId,
    effort_id: effort.id,
    mode: 'autonomous',
    jsonl_path: jsonlPath,
  })
  return { projectId, effortId: effort.id, sessionId, jsonlPath, rootDir: dir }
}

// -- Tests ------------------------------------------------------------------

describe('resumeSession — happy path', () => {
  test('argv shape, registry registration, DB pid stamp, session.updated event', async () => {
    const seed = seedDormant({
      projectName: 'P-resume-happy',
      effortName: 'effort-resume-happy',
    })

    const rec = recordingSpawner(fakeChild(54321))
    const cap = captureEvents()

    process.env.RALPH_MONITOR_PTY_GRACE_MS = '0'
    try {
      const result = await resumeSession(
        { session_id: seed.sessionId },
        { spawner: rec.spawner },
      )

      expect(result.id).toBe(seed.sessionId)
      expect(result.jsonlPath).toBe(seed.jsonlPath)
      expect(result.pid).toBe(54321)

      // Argv: --resume <uuid> --dangerously-skip-permissions, NO --session-id,
      // NO --name. resolvedCwd == projectRootDir so NO --add-dir.
      expect(rec.calls.length).toBe(1)
      const call = rec.calls[0]!
      expect(call.file).toBe('claude')
      expect(call.args).toEqual([
        '--resume',
        seed.sessionId,
        '--dangerously-skip-permissions',
      ])
      expect(call.env?.RALPH_MONITOR_SESSION).toBe(seed.sessionId)

      // Registry has the new handle with a fresh ring buffer.
      const handle = regGet(seed.sessionId)
      expect(handle).not.toBeNull()
      expect(handle!.pid).toBe(54321)
      expect(handle!.effortId).toBe(seed.effortId)
      expect(handle!.buffer.byteLength()).toBe(0)

      // DB stamped.
      const row = getSessionById(getDb(), seed.sessionId)
      expect(row).not.toBeNull()
      expect(row!.process_pid).toBe(54321)
      expect(row!.process_started_at).not.toBeNull()
      expect(row!.last_activity_at).not.toBeNull()

      // session.updated event recorded with the new pid.
      const updated = cap.events.find(
        (e) => e.type === 'session.updated' &&
          (e as { type: 'session.updated'; session: { id: string } }).session.id === seed.sessionId,
      )
      expect(updated).toBeDefined()
      expect(
        (updated as { type: 'session.updated'; session: { process_pid: number | null } }).session.process_pid,
      ).toBe(54321)
    } finally {
      delete process.env.RALPH_MONITOR_PTY_GRACE_MS
      cap.dispose()
    }
  })
})

describe('resumeSession — failure modes', () => {
  test('SessionNotFoundError when row does not exist', async () => {
    const rec = recordingSpawner()
    let err: unknown = null
    try {
      await resumeSession(
        { session_id: '00000000-0000-4000-8000-000000000000' },
        { spawner: rec.spawner },
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(SessionNotFoundError)
    // Spawner never invoked.
    expect(rec.calls.length).toBe(0)
  })

  test('falls back to fresh spawn (--session-id) when jsonl_path missing on disk', async () => {
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), { name: 'P-jsonl-missing', root_dir: dir })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-jsonl-missing',
      kind: 'task',
    })
    const sessionId = crypto.randomUUID()
    createSession(getDb(), {
      id: sessionId,
      effort_id: effort.id,
      mode: 'autonomous',
      jsonl_path: '/tmp/definitely-not-there-ralph-monitor-resume.jsonl',
    })

    const rec = recordingSpawner()
    await resumeSession({ session_id: sessionId }, { spawner: rec.spawner })

    // Spawner WAS invoked, with --session-id (fresh spawn argv) instead of
    // --resume. Same uuid is passed so the session row continues to map.
    expect(rec.calls.length).toBe(1)
    const argv = rec.calls[0]!.args
    expect(argv).toContain('--session-id')
    expect(argv).toContain(sessionId)
    expect(argv).not.toContain('--resume')

    // Row preserved (still mapped to the same id).
    expect(getSessionById(getDb(), sessionId)).not.toBeNull()
  })

  test('SessionAlreadyLiveError when registry has a non-exited handle', async () => {
    const seed = seedDormant({
      projectName: 'P-already-live-registry',
      effortName: 'effort-already-live-registry',
    })

    register({
      sessionId: seed.sessionId,
      effortId: seed.effortId,
      pid: 7777,
      buffer: new RingBuffer(8192),
      exited: false,
      lastExit: null,
      write: () => {},
      resize: () => {},
      onData: () => () => {},
      onExit: () => () => {},
      kill: () => {},
    })

    const rec = recordingSpawner()
    let err: unknown = null
    try {
      await resumeSession({ session_id: seed.sessionId }, { spawner: rec.spawner })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(SessionAlreadyLiveError)
    expect(rec.calls.length).toBe(0)
  })

  test('SessionAlreadyLiveError when row has process_pid (live-orphaned)', async () => {
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), { name: 'P-orphan-live', root_dir: dir })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-orphan-live',
      kind: 'task',
    })
    const sessionId = crypto.randomUUID()
    const jsonlPath = tmpJsonl()
    createSession(getDb(), {
      id: sessionId,
      effort_id: effort.id,
      mode: 'autonomous',
      jsonl_path: jsonlPath,
      process_pid: 99999, // orphan: pid set but no registry entry
      process_started_at: Date.now(),
    })

    const rec = recordingSpawner()
    let err: unknown = null
    try {
      await resumeSession({ session_id: sessionId }, { spawner: rec.spawner })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(SessionAlreadyLiveError)
    expect(rec.calls.length).toBe(0)
  })

  test('SessionInGraceWindowError when registry has an exited handle (in grace)', async () => {
    const seed = seedDormant({
      projectName: 'P-grace',
      effortName: 'effort-grace',
    })

    register({
      sessionId: seed.sessionId,
      effortId: seed.effortId,
      pid: 8888,
      buffer: new RingBuffer(8192),
      exited: true, // grace window
      lastExit: { exitCode: 0 },
      write: () => {},
      resize: () => {},
      onData: () => () => {},
      onExit: () => () => {},
      kill: () => {},
    })

    const rec = recordingSpawner()
    let err: unknown = null
    try {
      await resumeSession({ session_id: seed.sessionId }, { spawner: rec.spawner })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(SessionInGraceWindowError)
    expect(rec.calls.length).toBe(0)
  })

  test('OneLiveSessionPerEffortPrepError when a different session in the same effort is live', async () => {
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), {
      name: 'P-one-per-effort',
      root_dir: dir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-one-per-effort',
      kind: 'task',
    })

    // Sibling: live (process_pid set).
    const liveId = crypto.randomUUID()
    const liveJsonl = tmpJsonl()
    createSession(getDb(), {
      id: liveId,
      effort_id: effort.id,
      mode: 'autonomous',
      jsonl_path: liveJsonl,
      process_pid: 11111,
      process_started_at: Date.now(),
    })

    // Target: dormant.
    const dormantId = crypto.randomUUID()
    const dormantJsonl = tmpJsonl()
    createSession(getDb(), {
      id: dormantId,
      effort_id: effort.id,
      mode: 'autonomous',
      jsonl_path: dormantJsonl,
    })

    const rec = recordingSpawner()
    let err: unknown = null
    try {
      await resumeSession({ session_id: dormantId }, { spawner: rec.spawner })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(OneLiveSessionPerEffortPrepError)
    expect(rec.calls.length).toBe(0)

    // Both rows preserved.
    expect(getSessionById(getDb(), liveId)).not.toBeNull()
    expect(getSessionById(getDb(), dormantId)).not.toBeNull()
  })
})

describe('resumeSession — --add-dir branch', () => {
  test('resolvedCwd != projectRootDir → argv contains --add-dir <projectRootDir>', async () => {
    const projDir = tmpProjectDir()
    const sub = join(projDir, 'sub')
    mkdirSync(sub)

    const { projectId } = createProject(getDb(), {
      name: 'P-resume-adddir',
      root_dir: projDir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-resume-adddir',
      kind: 'task',
      working_dir: sub,
    })
    const sessionId = crypto.randomUUID()
    const jsonlPath = tmpJsonl()
    createSession(getDb(), {
      id: sessionId,
      effort_id: effort.id,
      mode: 'autonomous',
      jsonl_path: jsonlPath,
    })

    const rec = recordingSpawner(fakeChild(33333))

    process.env.RALPH_MONITOR_PTY_GRACE_MS = '0'
    try {
      await resumeSession({ session_id: sessionId }, { spawner: rec.spawner })

      const args = rec.calls[0]!.args
      expect(args).toEqual([
        '--resume',
        sessionId,
        '--dangerously-skip-permissions',
        '--add-dir',
        projDir,
      ])
      // cwd was the subdir.
      expect(rec.calls[0]!.cwd).toBe(sub)
    } finally {
      delete process.env.RALPH_MONITOR_PTY_GRACE_MS
    }
  })
})
