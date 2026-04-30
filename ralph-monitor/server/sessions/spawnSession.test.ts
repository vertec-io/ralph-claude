// spawnSession tests — DB-backed, with a mock PTY spawner.
//
// We DO NOT run the real `claude` binary here. Tests inject a mock
// `spawner` that returns a fake `SpawnerChild` matching bun-pty's surface.
// One temp DB per file (mirrors spawn.test.ts).
//
// Coverage:
//   - Happy path: argv shape, registry registration, DB pid stamp, event.
//   - --add-dir branch: project root_dir != effort.working_dir.
//   - No --add-dir branch: working_dir resolves to project.root_dir.
//   - Registration failure: pre-populated registry forces collision; verify
//     SIGTERM was sent, DB row hard-deleted, error propagated, registry
//     unchanged from the pre-populated state.
//   - Spawn failure: synchronous throw from spawner -> row hard-deleted,
//     error propagated.
//   - PTY exit auto-cleanup: trigger the fake child's onExit -> registry
//     drops the handle, DB row clears process_pid, session.exited emitted.
//   - One-live-session-per-effort blocking: second spawnSession for the
//     same effort surfaces OneLiveSessionPerEffortPrepError.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_DB_DIR = mkdtempSync(join(tmpdir(), 'ralph-monitor-spawnSession-'))
const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db')
process.env.RALPH_MONITOR_DB = TEST_DB_PATH

const {
  getDb,
  closeDb,
  createProject,
  createEffort,
  getSessionById,
  hardDeleteSession,
} = await import('../db')
const {
  spawnSession,
  buildClaudeArgv,
} = await import('./spawn')
import type { SpawnerChild, PtySpawner } from './spawn'
const { __test__: R, register, get: regGet } = await import('./registry')
const { RingBuffer } = await import('./ringBuffer')
const { store } = await import('../store')
import type { LifecycleAppEvent } from '../types'

const tempDirs: string[] = []
function tmpProjectDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ralph-monitor-spawnSession-proj-'))
  tempDirs.push(d)
  return d
}

afterAll(() => {
  try { closeDb() } catch {}
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
  try { rmSync(TEST_DB_DIR, { recursive: true, force: true }) } catch {}
})

beforeAll(() => {
  // Force schema migration before any test.
  getDb()
})

beforeEach(() => {
  // Each test starts with an empty registry. Two tests share the same
  // process-wide singleton so we MUST reset between them.
  R.clear()
})

// -- Helpers ----------------------------------------------------------------

interface FakeChild extends SpawnerChild {
  triggerExit(event: { exitCode: number; signal?: number | string }): void
  triggerData(data: string): void
  killCalls: string[]
  writes: string[]
  resizes: { cols: number; rows: number }[]
  disposed: { data: number; exit: number }
}

function fakeChild(pid = 12345): FakeChild {
  const dataListeners = new Set<(d: string) => void>()
  const exitListeners = new Set<(e: { exitCode: number; signal?: number | string }) => void>()
  const child: FakeChild = {
    pid,
    killCalls: [],
    writes: [],
    resizes: [],
    disposed: { data: 0, exit: 0 },
    onData(listener) {
      dataListeners.add(listener)
      return {
        dispose: () => {
          dataListeners.delete(listener)
          child.disposed.data++
        },
      }
    },
    onExit(listener) {
      exitListeners.add(listener)
      return {
        dispose: () => {
          exitListeners.delete(listener)
          child.disposed.exit++
        },
      }
    },
    write(data) {
      child.writes.push(data)
    },
    resize(cols, rows) {
      child.resizes.push({ cols, rows })
    },
    kill(signal) {
      child.killCalls.push(signal ?? '<default>')
    },
    triggerExit(event) {
      // Snapshot the listeners so disposal during dispatch doesn't perturb
      // iteration.
      for (const l of [...exitListeners]) l(event)
    },
    triggerData(data) {
      for (const l of [...dataListeners]) l(data)
    },
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

// Subscribe to store events for assertion. Returns a list that's appended
// to as new events arrive, plus a disposer.
function captureEvents(): { events: LifecycleAppEvent[]; dispose: () => void } {
  const events: LifecycleAppEvent[] = []
  const id = store.subscribe(async (chunk: string) => {
    // chunk is SSE-formatted: `event: update\ndata: <json>\n\n`. Pull the
    // JSON line out.
    const m = chunk.match(/\ndata: (.+)\n\n$/)
    if (!m) return
    try {
      const evt = JSON.parse(m[1]!)
      events.push(evt as LifecycleAppEvent)
    } catch {}
  })
  return { events, dispose: () => store.unsubscribe(id) }
}

// -- Tests ------------------------------------------------------------------

describe('spawnSession — happy path', () => {
  test('returns id/jsonlPath/pid; registers handle; stamps DB; emits session.created', async () => {
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), { name: 'P-happy', root_dir: dir })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-happy',
      kind: 'task',
    })

    const rec = recordingSpawner(fakeChild(54321))
    const cap = captureEvents()

    const result = await spawnSession(
      { effort_id: effort.id, mode: 'autonomous' },
      { spawner: rec.spawner },
    )

    expect(result.pid).toBe(54321)
    expect(typeof result.id).toBe('string')
    expect(result.jsonlPath.endsWith(`${result.id}.jsonl`)).toBe(true)

    // Registry has the handle.
    const handle = regGet(result.id)
    expect(handle).not.toBeNull()
    expect(handle!.pid).toBe(54321)
    expect(handle!.effortId).toBe(effort.id)

    // DB row stamped.
    const row = getSessionById(getDb(), result.id)
    expect(row).not.toBeNull()
    expect(row!.process_pid).toBe(54321)
    expect(row!.process_started_at).not.toBeNull()

    // session.created event emitted.
    const created = cap.events.find((e) => e.type === 'session.created')
    expect(created).toBeDefined()
    expect((created as { type: 'session.created'; session: { id: string } }).session.id).toBe(result.id)

    cap.dispose()
  })

  test('argv: includes --session-id, --dangerously-skip-permissions, --name <effort-name>:<uuid-prefix>', async () => {
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), { name: 'P-argv', root_dir: dir })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'my-effort-name',
      kind: 'task',
    })

    const rec = recordingSpawner()
    const result = await spawnSession(
      { effort_id: effort.id, mode: 'autonomous' },
      { spawner: rec.spawner },
    )

    expect(rec.calls.length).toBe(1)
    const call = rec.calls[0]!
    expect(call.file).toBe('claude')
    // args array does NOT include the leading 'claude'.
    expect(call.args).toEqual([
      '--session-id',
      result.id,
      '--dangerously-skip-permissions',
      '--name',
      `my-effort-name:${result.id.slice(0, 8)}`,
    ])
    // cwd was the project root (no --add-dir branch here).
    expect(call.cwd).toBe(dir)
    // RALPH_MONITOR_SESSION env was set.
    expect(call.env?.RALPH_MONITOR_SESSION).toBe(result.id)
  })
})

describe('spawnSession — --add-dir branch', () => {
  test('cwd != projectRootDir -> argv includes --add-dir <projectRootDir>', async () => {
    const projDir = tmpProjectDir()
    const effortDir = tmpProjectDir()
    const { projectId } = createProject(getDb(), {
      name: 'P-adddir',
      root_dir: projDir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-adddir',
      kind: 'task',
      working_dir: effortDir,
    })

    const rec = recordingSpawner()
    const result = await spawnSession(
      { effort_id: effort.id, mode: 'autonomous' },
      { spawner: rec.spawner },
    )

    const args = rec.calls[0]!.args
    expect(args).toEqual([
      '--session-id',
      result.id,
      '--dangerously-skip-permissions',
      '--name',
      `effort-adddir:${result.id.slice(0, 8)}`,
      '--add-dir',
      projDir,
    ])
    expect(rec.calls[0]!.cwd).toBe(effortDir)
  })

  test('cwd == projectRootDir -> argv does NOT include --add-dir', async () => {
    const projDir = tmpProjectDir()
    const { projectId } = createProject(getDb(), {
      name: 'P-no-adddir',
      root_dir: projDir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-bare',
      kind: 'task',
    })

    const rec = recordingSpawner()
    await spawnSession(
      { effort_id: effort.id, mode: 'autonomous' },
      { spawner: rec.spawner },
    )

    expect(rec.calls[0]!.args).not.toContain('--add-dir')
  })
})

describe('spawnSession — registration failure rollback', () => {
  test('register() throws → kill SIGTERM, DB row deleted, registry unchanged, error propagated', async () => {
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), {
      name: 'P-regfail',
      root_dir: dir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-regfail',
      kind: 'task',
    })

    // Pre-populate the registry with the SAME UUID the spawner is about to
    // get back. We accomplish this by intercepting crypto.randomUUID for the
    // first call (used by prepareSpawn's UUID allocation), forcing it to a
    // value we already inserted.
    const FORCED = '00000000-0000-4000-8000-000000000001'
    const realUuid = crypto.randomUUID
    let firstCallConsumed = false
    ;(crypto as unknown as { randomUUID: () => string }).randomUUID = () => {
      if (!firstCallConsumed) {
        firstCallConsumed = true
        return FORCED
      }
      return realUuid.call(crypto)
    }

    // Pre-register a sentinel handle for that UUID so register() throws.
    const sentinel = {
      sessionId: FORCED,
      effortId: 'sentinel-effort',
      pid: 999999,
      buffer: new RingBuffer(8192),
      exited: false,
      lastExit: null,
      write: () => {},
      resize: () => {},
      onData: () => () => {},
      onExit: () => () => {},
      kill: () => {},
    }
    register(sentinel)

    // Build a fake child whose onExit fires synchronously when kill() is
    // called — that's what guarantees the SIGTERM-then-rollback path
    // actually waits for an exit (rather than racing the 5s timeout). The
    // production path is the same: SIGTERM -> kernel delivers -> child
    // exits -> our onExit listener fires -> Promise.race resolves 'exited'.
    const child = fakeChild(11111)
    const origKill = child.kill
    child.kill = (signal) => {
      origKill.call(child, signal)
      // Simulate the kernel delivering the signal and the child exiting.
      // setImmediate so the kill() call returns before the listener fires.
      setImmediate(() => child.triggerExit({ exitCode: 0, signal: 'SIGTERM' }))
    }
    const rec = recordingSpawner(child)

    let err: unknown = null
    try {
      await spawnSession(
        { effort_id: effort.id, mode: 'autonomous' },
        { spawner: rec.spawner },
      )
    } catch (e) {
      err = e
    } finally {
      // Restore crypto.randomUUID no matter what.
      ;(crypto as unknown as { randomUUID: () => string }).randomUUID = realUuid
    }

    expect(err).not.toBeNull()
    expect((err as Error).name).toBe('RegistryCollisionError')

    // SIGTERM was sent (this is the assertion the AC cares about).
    expect(child.killCalls).toContain('SIGTERM')
    // SIGKILL was NOT sent (because the fake exited promptly within 5s).
    expect(child.killCalls).not.toContain('SIGKILL')

    // DB row was hard-deleted.
    expect(getSessionById(getDb(), FORCED)).toBeNull()

    // Registry still holds the sentinel — register() rejected the new
    // handle, so the sentinel is what's there.
    expect(regGet(FORCED)).toBe(sentinel)

    // Cleanup: drop the sentinel so beforeEach's clear() starts empty.
    R.clear()
  })
})

describe('spawnSession — synchronous spawn failure', () => {
  test('spawner throws → DB row hard-deleted, error propagated', async () => {
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), {
      name: 'P-spawnfail',
      root_dir: dir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-spawnfail',
      kind: 'task',
    })

    const rec: RecordingSpawner = {
      child: fakeChild(),
      calls: [],
      spawner: (file, args, options) => {
        rec.calls.push({ file, args: [...args], cwd: options.cwd, env: options.env })
        throw new Error('binary not found: claude')
      },
    }

    let err: unknown = null
    try {
      await spawnSession(
        { effort_id: effort.id, mode: 'autonomous' },
        { spawner: rec.spawner },
      )
    } catch (e) {
      err = e
    }

    expect((err as Error).message).toBe('binary not found: claude')
    expect(rec.calls.length).toBe(1)

    // No row should remain for any session under this effort.
    const rows = getDb()
      .prepare('SELECT id FROM sessions WHERE effort_id = ?')
      .all(effort.id) as { id: string }[]
    expect(rows.length).toBe(0)
  })
})

describe('spawnSession — PTY exit auto-cleanup', () => {
  test('triggering onExit drops the registry entry, clears DB pid, emits session.exited (grace=0)', async () => {
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), {
      name: 'P-exit',
      root_dir: dir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-exit',
      kind: 'task',
    })

    const child = fakeChild(77777)
    const rec = recordingSpawner(child)
    const cap = captureEvents()

    // Force grace=0 so unregister is synchronous within triggerExit. This
    // keeps the original assertion shape (regGet -> null right after exit)
    // while the grace-period behavior is exercised in its own describe
    // block below.
    process.env.RALPH_MONITOR_PTY_GRACE_MS = '0'
    let result: { id: string }
    try {
      result = await spawnSession(
        { effort_id: effort.id, mode: 'autonomous' },
        { spawner: rec.spawner },
      )

      expect(regGet(result.id)).not.toBeNull()
      expect(getSessionById(getDb(), result.id)?.process_pid).toBe(77777)

      child.triggerExit({ exitCode: 0 })

      expect(regGet(result.id)).toBeNull()
    } finally {
      delete process.env.RALPH_MONITOR_PTY_GRACE_MS
    }
    const row = getSessionById(getDb(), result.id)
    expect(row).not.toBeNull()
    expect(row!.process_pid).toBeNull()
    expect(row!.process_started_at).toBeNull()
    expect(row!.last_activity_at).not.toBeNull()

    const exited = cap.events.find(
      (e) => e.type === 'session.exited' && e.id === result.id,
    )
    expect(exited).toBeDefined()
    expect((exited as { exit_code?: number }).exit_code).toBe(0)

    cap.dispose()
  })

  test('exit handler tolerates a hard-deleted row (does not throw)', async () => {
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), {
      name: 'P-exit-deleted',
      root_dir: dir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-exit-deleted',
      kind: 'task',
    })

    const child = fakeChild(88888)
    const rec = recordingSpawner(child)

    process.env.RALPH_MONITOR_PTY_GRACE_MS = '0'
    try {
      const result = await spawnSession(
        { effort_id: effort.id, mode: 'autonomous' },
        { spawner: rec.spawner },
      )

      // External hard-delete (race condition simulation).
      hardDeleteSession(getDb(), result.id)

      // Trigger exit — must not throw even though the row is gone.
      expect(() => child.triggerExit({ exitCode: 1 })).not.toThrow()
    } finally {
      delete process.env.RALPH_MONITOR_PTY_GRACE_MS
    }
  })
})

describe('spawnSession — US-005c ring buffer + grace period', () => {
  test('PTY data flows into the handle ring buffer (fanout adapter captures even with no subscribers)', async () => {
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), {
      name: 'P-ring-data',
      root_dir: dir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-ring-data',
      kind: 'task',
    })

    const child = fakeChild(101)
    const rec = recordingSpawner(child)
    const result = await spawnSession(
      { effort_id: effort.id, mode: 'autonomous' },
      { spawner: rec.spawner },
    )

    const handle = regGet(result.id)!
    expect(handle).not.toBeNull()

    // No onData subscriber yet — fire data through the underlying child.
    // The fanout adapter must still append to the ring buffer.
    child.triggerData('abc')
    child.triggerData('def')

    const snap = handle.buffer.snapshot()
    expect(new TextDecoder().decode(snap)).toBe('abcdef')
  })

  test('handle.exited + handle.lastExit are set BEFORE onExit subscribers fire', async () => {
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), {
      name: 'P-ring-exit-state',
      root_dir: dir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-ring-exit-state',
      kind: 'task',
    })

    const child = fakeChild(202)
    const rec = recordingSpawner(child)

    process.env.RALPH_MONITOR_PTY_GRACE_MS = '0'
    const observed: {
      exited: boolean
      lastExit: { exitCode: number; signal?: number } | null
    } = { exited: false, lastExit: null }
    try {
      const result = await spawnSession(
        { effort_id: effort.id, mode: 'autonomous' },
        { spawner: rec.spawner },
      )
      const handle = regGet(result.id)!
      handle.onExit(() => {
        observed.exited = handle.exited
        observed.lastExit = handle.lastExit
      })
      child.triggerExit({ exitCode: 7 })
    } finally {
      delete process.env.RALPH_MONITOR_PTY_GRACE_MS
    }
    expect(observed.exited).toBe(true)
    expect(observed.lastExit).toEqual({ exitCode: 7, signal: undefined })
  })

  test('grace period: registry entry persists for graceMs after exit, then unregisters and clears buffer', async () => {
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), {
      name: 'P-grace',
      root_dir: dir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-grace',
      kind: 'task',
    })

    const child = fakeChild(303)
    const rec = recordingSpawner(child)

    process.env.RALPH_MONITOR_PTY_GRACE_MS = '100'
    try {
      const result = await spawnSession(
        { effort_id: effort.id, mode: 'autonomous' },
        { spawner: rec.spawner },
      )
      const handle = regGet(result.id)!

      // Buffer some bytes pre-exit.
      child.triggerData('final-output')
      expect(new TextDecoder().decode(handle.buffer.snapshot())).toBe('final-output')

      // Exit. Within grace, registry still has the handle.
      child.triggerExit({ exitCode: 0 })
      expect(regGet(result.id)).not.toBeNull()
      expect(handle.exited).toBe(true)
      // Bytes still replayable in the grace window.
      expect(new TextDecoder().decode(handle.buffer.snapshot())).toBe('final-output')

      // Wait past the 100ms grace.
      await new Promise((r) => setTimeout(r, 200))

      expect(regGet(result.id)).toBeNull()
      expect(handle.buffer.byteLength()).toBe(0)
    } finally {
      delete process.env.RALPH_MONITOR_PTY_GRACE_MS
    }
  })

  test('RALPH_MONITOR_PTY_BUFFER_BYTES env tunes capacity', async () => {
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), {
      name: 'P-buf-cap',
      root_dir: dir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-buf-cap',
      kind: 'task',
    })

    const child = fakeChild(404)
    const rec = recordingSpawner(child)

    process.env.RALPH_MONITOR_PTY_BUFFER_BYTES = '8'
    process.env.RALPH_MONITOR_PTY_GRACE_MS = '0'
    try {
      const result = await spawnSession(
        { effort_id: effort.id, mode: 'autonomous' },
        { spawner: rec.spawner },
      )
      const handle = regGet(result.id)!
      expect(handle.buffer.capacity).toBe(8)

      child.triggerData('abcdefghij') // 10 bytes -> buffer keeps last 8
      expect(new TextDecoder().decode(handle.buffer.snapshot())).toBe('cdefghij')
    } finally {
      delete process.env.RALPH_MONITOR_PTY_BUFFER_BYTES
      delete process.env.RALPH_MONITOR_PTY_GRACE_MS
    }
  })
})

describe('spawnSession — parallel live sessions (constraint lifted)', () => {
  test('second spawnSession for the same effort now succeeds (constraint lifted)', async () => {
    // Migration 3 dropped idx_sessions_one_live_per_effort.
    // Multiple parallel spawns under the same effort are now allowed.
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), {
      name: 'P-onelive',
      root_dir: dir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-onelive',
      kind: 'task',
    })

    const rec1 = recordingSpawner(fakeChild(11))
    const r1 = await spawnSession(
      { effort_id: effort.id, mode: 'autonomous' },
      { spawner: rec1.spawner },
    )
    expect(getSessionById(getDb(), r1.id)?.process_pid).toBe(11)

    // Second spawn must SUCCEED now.
    const rec2 = recordingSpawner(fakeChild(22))
    let err: unknown = null
    let r2: Awaited<ReturnType<typeof spawnSession>> | null = null
    try {
      r2 = await spawnSession(
        { effort_id: effort.id, mode: 'autonomous' },
        { spawner: rec2.spawner },
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeNull()
    expect(r2).not.toBeNull()
    expect(r2?.id).not.toBe(r1.id)
    // Both sessions should be live (process_pid set).
    expect(getSessionById(getDb(), r1.id)?.process_pid).toBe(11)
    expect(getSessionById(getDb(), r2!.id)?.process_pid).toBe(22)
  })
})

describe('spawnSession — mode-conditional initial prompt (US-005a-3)', () => {
  test('autonomous + initial_prompt → exactly one stdin write of "<prompt>\\r" AFTER register', async () => {
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), {
      name: 'P-init-auto',
      root_dir: dir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-init-auto',
      kind: 'task',
    })

    // Track call ordering across register() and the subsequent write. We
    // wrap child.write to log a 'write' event, and intercept register() via
    // a wrapper spawner that logs 'spawned' immediately after spawn (the
    // production code calls register() synchronously after spawn returns,
    // so any 'write' that lands after the spawner returns is by definition
    // post-register).
    const order: string[] = []
    const child = fakeChild(31415)
    const origWrite = child.write
    child.write = (data) => {
      order.push(`write:${data}`)
      origWrite.call(child, data)
    }
    const rec: RecordingSpawner = {
      child,
      calls: [],
      spawner: (file, args, options) => {
        rec.calls.push({ file, args: [...args], cwd: options.cwd, env: options.env })
        order.push('spawned')
        return child
      },
    }

    const result = await spawnSession(
      {
        effort_id: effort.id,
        mode: 'autonomous',
        initial_prompt: 'hello world',
      },
      { spawner: rec.spawner },
    )

    // Exactly one write of 'hello world\r'.
    expect(child.writes).toEqual(['hello world\r'])

    // Ordering: spawn (and therefore register, which is synchronous in
    // spawnSession with no awaits between them) happened before the write.
    expect(order[0]).toBe('spawned')
    expect(order[1]).toBe('write:hello world\r')

    // Sanity: the registry entry exists at this point.
    expect(regGet(result.id)).not.toBeNull()
  })

  test('autonomous + no initial_prompt → zero stdin writes', async () => {
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), {
      name: 'P-init-auto-none',
      root_dir: dir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-init-auto-none',
      kind: 'task',
    })

    const rec = recordingSpawner(fakeChild(1))
    await spawnSession(
      { effort_id: effort.id, mode: 'autonomous' },
      { spawner: rec.spawner },
    )
    expect(rec.child.writes).toEqual([])
  })

  test('autonomous + empty-string initial_prompt → zero stdin writes', async () => {
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), {
      name: 'P-init-auto-empty',
      root_dir: dir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-init-auto-empty',
      kind: 'task',
    })

    const rec = recordingSpawner(fakeChild(2))
    await spawnSession(
      { effort_id: effort.id, mode: 'autonomous', initial_prompt: '' },
      { spawner: rec.spawner },
    )
    expect(rec.child.writes).toEqual([])
  })

  test('interactive + initial_prompt → one stdin write (mode no longer gates prompt write)', async () => {
    // Since the mode distinction was removed, interactive + initial_prompt now
    // writes the prompt to stdin just like autonomous mode did. The initial_prompt
    // is always written when non-empty, regardless of mode.
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), {
      name: 'P-init-interactive',
      root_dir: dir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-init-interactive',
      kind: 'task',
    })

    const rec = recordingSpawner(fakeChild(3))
    await spawnSession(
      {
        effort_id: effort.id,
        mode: 'interactive',
        initial_prompt: 'should now be sent',
      },
      { spawner: rec.spawner },
    )
    expect(rec.child.writes).toEqual(['should now be sent\r'])
  })
})

describe('buildClaudeArgv — pure helper', () => {
  test('no --add-dir when cwd == projectRootDir', () => {
    expect(
      buildClaudeArgv({
        uuid: '12345678-aaaa-bbbb-cccc-dddddddddddd',
        effortName: 'foo',
        resolvedCwd: '/proj',
        projectRootDir: '/proj',
      }),
    ).toEqual([
      'claude',
      '--session-id',
      '12345678-aaaa-bbbb-cccc-dddddddddddd',
      '--dangerously-skip-permissions',
      '--name',
      'foo:12345678',
    ])
  })

  test('--add-dir when cwd != projectRootDir', () => {
    const argv = buildClaudeArgv({
      uuid: 'abcdef01-0000-0000-0000-000000000000',
      effortName: 'bar',
      resolvedCwd: '/proj/sub',
      projectRootDir: '/proj',
    })
    expect(argv.slice(-2)).toEqual(['--add-dir', '/proj'])
  })

  test('effort name is trimmed', () => {
    const argv = buildClaudeArgv({
      uuid: 'abcdef01-0000-0000-0000-000000000000',
      effortName: '  spaced  ',
      resolvedCwd: '/x',
      projectRootDir: '/x',
    })
    expect(argv[5]).toBe('spaced:abcdef01')
  })
})
