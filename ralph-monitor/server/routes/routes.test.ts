// Route-handler tests for US-003. We exercise the Hono routers via
// `app.fetch(new Request(...))` against a temp-file sqlite DB selected by
// $RALPH_MONITOR_DB. The DB module's `getDb()` resolves that env var lazily on
// first call — so we set the env var, then import everything that touches the
// DB.
//
// The `getDb()` cache is process-global; we therefore use ONE temp DB for the
// whole file and isolate tests by working through fresh projects/efforts on
// disk. This mirrors how real callers use the API and avoids reaching past
// the public surface to swap singletons.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_DB_DIR = mkdtempSync(join(tmpdir(), 'ralph-monitor-routes-'))
const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db')
process.env.RALPH_MONITOR_DB = TEST_DB_PATH

// IMPORTANT: imports below run AFTER env var is set, so getDb() resolves to
// our temp file. Importing earlier would cache the wrong path.
const { Hono } = await import('hono')
const { projectsRouter } = await import('./projects')
const { effortsRouter } = await import('./efforts')
const { sessionsRouter } = await import('./sessions')
const { buildLifecycleSnapshot } = await import('./lifecycle')
const { getDb, closeDb, getProjectById, listEffortsByProject, getSessionById, createSession } =
  await import('../db')
const { store } = await import('../store')
const { setTestSpawner } = await import('../sessions/spawn')
const { __test__: registryTest } = await import('../sessions/registry')
const { clearWorktreeCacheForTests } = await import('../git/worktrees')
const { watchEffortPrd: _watchEffortPrd, unwatchEffortPrd: _unwatchEffortPrd } =
  await import('../effortWatchers')
import type { SpawnerChild, PtySpawner } from '../sessions/spawn'

const app = new Hono()
app.route('/', projectsRouter)
app.route('/', effortsRouter)
app.route('/', sessionsRouter)

const tempDirs: string[] = []
function tmpProjectDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ralph-monitor-routes-proj-'))
  tempDirs.push(d)
  return d
}

afterAll(() => {
  // Close the DB singleton before removing the file so neighboring test
  // files (which run in the same Bun test process) don't inherit a handle
  // pointing at a now-deleted file (manifests as SQLITE_READONLY_DBMOVED).
  try { closeDb() } catch {}
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
  try { rmSync(TEST_DB_DIR, { recursive: true, force: true }) } catch {}
})

// Capture broadcast events by subscribing to the store. Each chunk is the
// pre-formatted SSE string `event: update\ndata: <json>\n\n`. We extract the
// JSON payload so tests can assert on `type` and contents.
function captureEvents(): { events: any[]; stop: () => void } {
  const events: any[] = []
  const id = store.subscribe((chunk) => {
    const m = chunk.match(/data: (.+)\n/)
    if (m) {
      try { events.push(JSON.parse(m[1])) } catch {}
    }
  })
  return { events, stop: () => store.unsubscribe(id) }
}

beforeAll(() => {
  // Force schema migration before any test runs.
  getDb()
})

describe('POST /api/projects', () => {
  test('happy path: 201 + project + general effort + project.created event', async () => {
    const dir = tmpProjectDir()
    const cap = captureEvents()
    try {
      const res = await app.fetch(
        new Request('http://test/api/projects', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Happy', root_dir: dir }),
        }),
      )
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.name).toBe('Happy')
      expect(typeof body.id).toBe('string')

      // DB-side: project exists, general effort exists.
      const proj = getProjectById(getDb(), body.id)
      expect(proj).not.toBeNull()
      const efforts = listEffortsByProject(getDb(), body.id)
      expect(efforts.length).toBe(1)
      expect(efforts[0].kind).toBe('general')

      // Event was broadcast.
      const evt = cap.events.find((e) => e.type === 'project.created' && e.project?.id === body.id)
      expect(evt).toBeDefined()
      expect(evt.project.name).toBe('Happy')
    } finally {
      cap.stop()
    }
  })

  test('non-existent root_dir -> 422 root_dir_does_not_exist', async () => {
    const res = await app.fetch(
      new Request('http://test/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Nope',
          root_dir: '/tmp/this-does-not-exist-ralph-monitor-test/abc/def',
        }),
      }),
    )
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe('root_dir_does_not_exist')
  })

  test('already-taken root_dir -> 409 with existing_id', async () => {
    const dir = tmpProjectDir()
    const r1 = await app.fetch(
      new Request('http://test/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'First', root_dir: dir }),
      }),
    )
    expect(r1.status).toBe(201)
    const first = await r1.json()

    const r2 = await app.fetch(
      new Request('http://test/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Second', root_dir: dir }),
      }),
    )
    expect(r2.status).toBe(409)
    const body = await r2.json()
    expect(body.error).toBe('project_root_dir_taken')
    expect(body.details?.existing_id).toBe(first.id)
  })

  test('missing required fields -> 400', async () => {
    const res = await app.fetch(
      new Request('http://test/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'no-root-dir' }),
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe('GET /api/projects', () => {
  test('status=active excludes archived', async () => {
    const dirActive = tmpProjectDir()
    const dirArchived = tmpProjectDir()
    const r1 = await app.fetch(
      new Request('http://test/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Active-A', root_dir: dirActive }),
      }),
    )
    const active = await r1.json()
    const r2 = await app.fetch(
      new Request('http://test/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Archived-A', root_dir: dirArchived }),
      }),
    )
    const arch = await r2.json()

    // Archive one via PATCH.
    await app.fetch(
      new Request(`http://test/api/projects/${arch.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      }),
    )

    const list = await app.fetch(new Request('http://test/api/projects?status=active'))
    expect(list.status).toBe(200)
    const body = await list.json()
    const ids = body.projects.map((p: any) => p.id)
    expect(ids).toContain(active.id)
    expect(ids).not.toContain(arch.id)
  })
})

describe('DELETE /api/projects/:id', () => {
  test('without confirm_name -> 422; with mismatched -> 422; with correct -> 204 and cascades', async () => {
    const dir = tmpProjectDir()
    const r = await app.fetch(
      new Request('http://test/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'ToDelete', root_dir: dir }),
      }),
    )
    const proj = await r.json()
    const efforts = listEffortsByProject(getDb(), proj.id)
    expect(efforts.length).toBe(1)
    const generalEffort = efforts[0]

    // Add a session under the general effort to verify cascade.
    const sessId = crypto.randomUUID()
    createSession(getDb(), {
      id: sessId,
      effort_id: generalEffort.id,
      mode: 'autonomous',
      jsonl_path: '/tmp/cascade.jsonl',
    })
    expect(getSessionById(getDb(), sessId)).not.toBeNull()

    // No confirm_name -> 422
    const noConfirm = await app.fetch(
      new Request(`http://test/api/projects/${proj.id}`, { method: 'DELETE' }),
    )
    expect(noConfirm.status).toBe(422)

    // Mismatched confirm_name -> 422
    const wrong = await app.fetch(
      new Request(`http://test/api/projects/${proj.id}?confirm_name=NotTheName`, {
        method: 'DELETE',
      }),
    )
    expect(wrong.status).toBe(422)

    // Correct confirm_name -> 204
    const ok = await app.fetch(
      new Request(`http://test/api/projects/${proj.id}?confirm_name=ToDelete`, {
        method: 'DELETE',
      }),
    )
    expect(ok.status).toBe(204)

    // Cascade: project + effort + session all gone.
    expect(getProjectById(getDb(), proj.id)).toBeNull()
    expect(listEffortsByProject(getDb(), proj.id).length).toBe(0)
    expect(getSessionById(getDb(), sessId)).toBeNull()
  })

  test('non-existent id -> 404', async () => {
    const res = await app.fetch(
      new Request('http://test/api/projects/no-such-id?confirm_name=whatever', {
        method: 'DELETE',
      }),
    )
    expect(res.status).toBe(404)
  })
})

describe('POST /api/projects/:id/efforts', () => {
  test("kind='prd' with empty prd_path -> 422", async () => {
    const dir = tmpProjectDir()
    const r = await app.fetch(
      new Request('http://test/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'PRDHost', root_dir: dir }),
      }),
    )
    const proj = await r.json()

    const bad = await app.fetch(
      new Request(`http://test/api/projects/${proj.id}/efforts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'X', kind: 'prd', prd_path: '' }),
      }),
    )
    expect(bad.status).toBe(422)
    const body = await bad.json()
    expect(body.error).toBe('prd_path_required_for_prd_kind')
  })

  test('happy path 201 + effort.created event', async () => {
    const dir = tmpProjectDir()
    const r = await app.fetch(
      new Request('http://test/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'TaskHost', root_dir: dir }),
      }),
    )
    const proj = await r.json()

    const cap = captureEvents()
    try {
      const create = await app.fetch(
        new Request(`http://test/api/projects/${proj.id}/efforts`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'My Task', kind: 'task' }),
        }),
      )
      expect(create.status).toBe(201)
      const effort = await create.json()
      expect(effort.kind).toBe('task')
      const evt = cap.events.find((e) => e.type === 'effort.created' && e.effort?.id === effort.id)
      expect(evt).toBeDefined()
    } finally {
      cap.stop()
    }
  })
})

describe('DELETE /api/sessions/:id?purge_jsonl=true', () => {
  test('removes JSONL file from disk', async () => {
    const dir = tmpProjectDir()
    const r = await app.fetch(
      new Request('http://test/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'PurgeHost', root_dir: dir }),
      }),
    )
    const proj = await r.json()
    const efforts = listEffortsByProject(getDb(), proj.id)
    const effort = efforts[0]

    // Create a real on-disk JSONL we can verify gets removed.
    const jsonlDir = mkdtempSync(join(tmpdir(), 'ralph-monitor-jsonl-'))
    tempDirs.push(jsonlDir)
    const jsonlPath = join(jsonlDir, 'session.jsonl')
    writeFileSync(jsonlPath, '{"hello":"world"}\n')
    expect(existsSync(jsonlPath)).toBe(true)

    const sessId = crypto.randomUUID()
    createSession(getDb(), {
      id: sessId,
      effort_id: effort.id,
      mode: 'autonomous',
      jsonl_path: jsonlPath,
    })

    const cap = captureEvents()
    try {
      const del = await app.fetch(
        new Request(`http://test/api/sessions/${sessId}?purge_jsonl=true`, {
          method: 'DELETE',
        }),
      )
      expect(del.status).toBe(204)
      expect(getSessionById(getDb(), sessId)).toBeNull()
      expect(existsSync(jsonlPath)).toBe(false)

      const evt = cap.events.find((e) => e.type === 'session.deleted' && e.id === sessId)
      expect(evt).toBeDefined()
    } finally {
      cap.stop()
    }
  })

  test('purge_jsonl=true with already-missing file -> 204 (best effort)', async () => {
    const dir = tmpProjectDir()
    const r = await app.fetch(
      new Request('http://test/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'PurgeMissingHost', root_dir: dir }),
      }),
    )
    const proj = await r.json()
    const effort = listEffortsByProject(getDb(), proj.id)[0]

    const sessId = crypto.randomUUID()
    createSession(getDb(), {
      id: sessId,
      effort_id: effort.id,
      mode: 'autonomous',
      jsonl_path: '/tmp/definitely-not-there-ralph-monitor.jsonl',
    })

    const del = await app.fetch(
      new Request(`http://test/api/sessions/${sessId}?purge_jsonl=true`, {
        method: 'DELETE',
      }),
    )
    expect(del.status).toBe(204)
    expect(getSessionById(getDb(), sessId)).toBeNull()
  })
})

describe('buildLifecycleSnapshot', () => {
  test('emits projects, efforts arrays + live_session_ids', () => {
    const snap = buildLifecycleSnapshot(getDb(), [])
    expect(snap.type).toBe('lifecycle.snapshot')
    expect(typeof snap.ts).toBe('number')
    expect(Array.isArray(snap.projects)).toBe(true)
    expect(Array.isArray(snap.efforts)).toBe(true)
    expect(snap.live_session_ids).toEqual([])
    // efforts list should be at least as large as projects (one auto-General each).
    expect(snap.efforts.length).toBeGreaterThanOrEqual(snap.projects.length)
  })

  test('passes through live_session_ids verbatim when override is provided', () => {
    const ids = ['a', 'b', 'c']
    const snap = buildLifecycleSnapshot(getDb(), ids)
    expect(snap.live_session_ids).toEqual(ids)
  })

  test('reads from the live PTY handle registry when no override is passed', async () => {
    // US-005a-1: with no liveSessionIds argument, buildLifecycleSnapshot pulls
    // from the global registry. Seed it with a fake handle, snapshot, then clean
    // up so neighboring tests don't see a polluted registry.
    const { register, unregister } = await import('../sessions/registry')
    const { RingBuffer } = await import('../sessions/ringBuffer')
    const fakeId = 'live-session-from-registry-test'
    register({
      sessionId: fakeId,
      effortId: 'irrelevant',
      pid: 1,
      buffer: new RingBuffer(8192),
      exited: false,
      lastExit: null,
      write: () => {},
      resize: () => {},
      onData: () => () => {},
      onExit: () => () => {},
      kill: () => {},
    })
    try {
      const snap = buildLifecycleSnapshot(getDb())
      expect(snap.live_session_ids).toContain(fakeId)
    } finally {
      unregister(fakeId)
    }
  })
})

// ---------------------------------------------------------------------------
// POST /api/sessions  (US-005d)
// ---------------------------------------------------------------------------
//
// Why we test the route here rather than in spawnSession.test.ts:
//   - This file exercises the full Hono pipeline: JSON parsing, body
//     validation, DB lookups for effort+project, working_dir validation
//     against worktrees.ts, and the typed-error -> HTTP-status mapping.
//   - The route reads its spawner via getSpawner() (US-005d Option C), which
//     returns a process-wide override slot we set via setTestSpawner. Tests
//     install a recording spawner in beforeEach and clear it in afterEach so
//     parallel describe blocks can't leak the override into each other.
//   - We DO NOT spawn the real `claude` binary. The recording spawner returns
//     a fake child that satisfies SpawnerChild's surface and ignores all
//     write/resize calls.
//
// All POST tests share the helpers below to (a) seed a project + effort
// against the test DB, and (b) install a fresh recording spawner that lets
// us assert the argv that spawnSession would have invoked.

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

// Create a project + reuse its auto-General effort. Returns IDs the route
// callers need.
async function makeProjectAndEffort(name: string): Promise<{
  projectId: string
  effortId: string
  rootDir: string
}> {
  const dir = tmpProjectDir()
  const r = await app.fetch(
    new Request('http://test/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, root_dir: dir }),
    }),
  )
  expect(r.status).toBe(201)
  const proj = await r.json()
  const effort = listEffortsByProject(getDb(), proj.id)[0]
  return { projectId: proj.id, effortId: effort.id, rootDir: proj.root_dir }
}

describe('GET /api/sessions/:id', () => {
  test('happy path: dormant session -> 200 with status=dormant, live=false, attached=false', async () => {
    const dir = tmpProjectDir()
    const r = await app.fetch(
      new Request('http://test/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'GetSession-Dormant', root_dir: dir }),
      }),
    )
    const proj = await r.json()
    const effort = listEffortsByProject(getDb(), proj.id)[0]

    const sessId = crypto.randomUUID()
    createSession(getDb(), {
      id: sessId,
      effort_id: effort.id,
      mode: 'autonomous',
      jsonl_path: '/tmp/dormant.jsonl',
      // No pid — this is the dormant case.
    })

    const res = await app.fetch(new Request(`http://test/api/sessions/${sessId}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(sessId)
    expect(body.status).toBe('dormant')
    expect(body.live).toBe(false)
    expect(body.attached).toBe(false)
    expect(body.process_pid).toBeNull()
  })

  test('live-orphaned: row has pid but no registry entry -> live=true, attached=false', async () => {
    const dir = tmpProjectDir()
    const r = await app.fetch(
      new Request('http://test/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'GetSession-Orphan', root_dir: dir }),
      }),
    )
    const proj = await r.json()
    const effort = listEffortsByProject(getDb(), proj.id)[0]

    // Make sure registry is empty for this id (it is by default; explicit
    // for clarity).
    registryTest.clear()

    const sessId = crypto.randomUUID()
    createSession(getDb(), {
      id: sessId,
      effort_id: effort.id,
      mode: 'autonomous',
      jsonl_path: '/tmp/orphan.jsonl',
      process_pid: 99999,
      process_started_at: Date.now(),
    })

    const res = await app.fetch(new Request(`http://test/api/sessions/${sessId}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('live-orphaned')
    expect(body.live).toBe(true)
    expect(body.attached).toBe(false)
  })

  test('not found -> 404 session_not_found', async () => {
    const res = await app.fetch(
      new Request('http://test/api/sessions/00000000-0000-4000-8000-000000000000'),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('session_not_found')
  })
})

describe('POST /api/sessions', () => {
  let rec: RecordingSpawner

  beforeEach(() => {
    // Each test starts with an empty registry + worktree cache so prior
    // tests' state can't leak in.
    registryTest.clear()
    clearWorktreeCacheForTests()
    rec = recordingSpawner()
    setTestSpawner(rec.spawner)
    // Force grace=0 so the auto-cleanup-on-exit timer doesn't dangle past
    // the end of the test (mirrors spawnSession.test.ts).
    process.env.RALPH_MONITOR_PTY_GRACE_MS = '0'
  })

  afterEach(() => {
    setTestSpawner(null)
    registryTest.clear()
    delete process.env.RALPH_MONITOR_PTY_GRACE_MS
  })

  test('happy path: 201 + { id, jsonl_path, ws_url }', async () => {
    const { effortId } = await makeProjectAndEffort('Spawn-Happy')
    const cap = captureEvents()
    try {
      const res = await app.fetch(
        new Request('http://test/api/sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ effort_id: effortId, mode: 'interactive' }),
        }),
      )
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(typeof body.id).toBe('string')
      expect(body.id.length).toBeGreaterThan(0)
      expect(typeof body.jsonl_path).toBe('string')
      expect(body.jsonl_path.endsWith(`${body.id}.jsonl`)).toBe(true)
      expect(body.ws_url).toBe(`/ws/sessions/${body.id}`)

      // Recording spawner saw exactly one invocation with the right argv.
      expect(rec.calls.length).toBe(1)
      expect(rec.calls[0]!.file).toBe('claude')
      expect(rec.calls[0]!.args).toContain('--session-id')
      expect(rec.calls[0]!.args).toContain(body.id)

      // session.created event fired.
      const evt = cap.events.find(
        (e: any) => e.type === 'session.created' && e.session?.id === body.id,
      )
      expect(evt).toBeDefined()
    } finally {
      cap.stop()
    }
  })

  test('missing effort_id -> 400 effort_id_required', async () => {
    const res = await app.fetch(
      new Request('http://test/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'autonomous' }),
      }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('effort_id_required')
  })

  test('invalid mode -> 400 mode_invalid', async () => {
    const { effortId } = await makeProjectAndEffort('Spawn-BadMode')
    const res = await app.fetch(
      new Request('http://test/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort_id: effortId, mode: 'wrong' }),
      }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('mode_invalid')
  })

  test('non-string working_dir -> 400 working_dir_invalid', async () => {
    const { effortId } = await makeProjectAndEffort('Spawn-BadWD')
    const res = await app.fetch(
      new Request('http://test/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort_id: effortId, mode: 'autonomous', working_dir: 42 }),
      }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('working_dir_invalid')
  })

  test('invalid JSON body -> 400 invalid_json', async () => {
    const res = await app.fetch(
      new Request('http://test/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_json')
  })

  test('non-existent effort_id -> 404 effort_not_found', async () => {
    const res = await app.fetch(
      new Request('http://test/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          effort_id: '00000000-0000-4000-8000-000000000000',
          mode: 'autonomous',
        }),
      }),
    )
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('effort_not_found')
  })

  test('working_dir outside project -> 422 working_dir_outside_project_or_worktree', async () => {
    const { effortId } = await makeProjectAndEffort('Spawn-OutOfProject')
    const otherDir = tmpProjectDir() // sibling tmp, not a worktree of project
    const res = await app.fetch(
      new Request('http://test/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          effort_id: effortId,
          mode: 'autonomous',
          working_dir: otherDir,
        }),
      }),
    )
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe('working_dir_outside_project_or_worktree')
    expect(body.details?.working_dir).toBe(otherDir)
  })

  test('one-live-session-per-effort -> 409 on second POST', async () => {
    const { effortId } = await makeProjectAndEffort('Spawn-OneLive')

    const r1 = await app.fetch(
      new Request('http://test/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort_id: effortId, mode: 'autonomous' }),
      }),
    )
    expect(r1.status).toBe(201)

    const r2 = await app.fetch(
      new Request('http://test/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort_id: effortId, mode: 'autonomous' }),
      }),
    )
    expect(r2.status).toBe(409)
    expect((await r2.json()).error).toBe('one_live_session_per_effort')
  })

  test('argv assertion: when resolved cwd != project.root_dir, includes --add-dir <project.root_dir>', async () => {
    // Create project, then mark effort.working_dir to a subdir of root_dir.
    // POST with no session-level working_dir -> prepareSpawn falls back to
    // effort.working_dir, which differs from project.root_dir, which means
    // buildClaudeArgv emits the --add-dir branch.
    const dir = tmpProjectDir()
    const sub = join(dir, 'sub')
    mkdirSync(sub)

    const r = await app.fetch(
      new Request('http://test/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Spawn-AddDir', root_dir: dir }),
      }),
    )
    const proj = await r.json()

    // Create an effort under this project whose working_dir = the subdir.
    // Reuse the efforts route so we don't reach past the public surface.
    const er = await app.fetch(
      new Request(`http://test/api/projects/${proj.id}/efforts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'sub-effort', kind: 'task', working_dir: sub }),
      }),
    )
    expect(er.status).toBe(201)
    const effort = await er.json()

    const sres = await app.fetch(
      new Request('http://test/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort_id: effort.id, mode: 'autonomous' }),
      }),
    )
    expect(sres.status).toBe(201)

    // Recording spawner saw the --add-dir branch.
    expect(rec.calls.length).toBe(1)
    const args = rec.calls[0]!.args
    const addDirIdx = args.indexOf('--add-dir')
    expect(addDirIdx).toBeGreaterThanOrEqual(0)
    // realpathSync may resolve symlinks (e.g. /tmp -> /private/tmp on macOS),
    // so we compare the realpath'd version of dir rather than dir literally.
    const realDir = require('node:fs').realpathSync.native(dir)
    expect(args[addDirIdx + 1]).toBe(realDir)
    // cwd was the subdir.
    expect(rec.calls[0]!.cwd).toBe(require('node:fs').realpathSync.native(sub))
  })
})

// ---------------------------------------------------------------------------
// POST /api/sessions/:id/resume  (US-007)
// ---------------------------------------------------------------------------

describe('POST /api/sessions/:id/resume', () => {
  let rec: RecordingSpawner

  beforeEach(() => {
    registryTest.clear()
    clearWorktreeCacheForTests()
    rec = recordingSpawner()
    setTestSpawner(rec.spawner)
    process.env.RALPH_MONITOR_PTY_GRACE_MS = '0'
  })

  afterEach(() => {
    setTestSpawner(null)
    registryTest.clear()
    delete process.env.RALPH_MONITOR_PTY_GRACE_MS
  })

  // Helper: project + effort + dormant session row + on-disk JSONL.
  async function seedDormantViaApi(name: string): Promise<{
    sessionId: string
    jsonlPath: string
  }> {
    const { effortId } = await makeProjectAndEffort(name)
    const sessionId = crypto.randomUUID()
    const jsonlDir = mkdtempSync(join(tmpdir(), 'ralph-monitor-resume-jsonl-'))
    tempDirs.push(jsonlDir)
    const jsonlPath = join(jsonlDir, 'session.jsonl')
    writeFileSync(jsonlPath, '{"a":1}\n')
    createSession(getDb(), {
      id: sessionId,
      effort_id: effortId,
      mode: 'autonomous',
      jsonl_path: jsonlPath,
    })
    return { sessionId, jsonlPath }
  }

  test('happy path: 200 + { id, jsonl_path, ws_url }; argv has --resume <id>', async () => {
    const seed = await seedDormantViaApi('Resume-Happy')
    const cap = captureEvents()
    try {
      const res = await app.fetch(
        new Request(`http://test/api/sessions/${seed.sessionId}/resume`, {
          method: 'POST',
        }),
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.id).toBe(seed.sessionId)
      expect(body.jsonl_path).toBe(seed.jsonlPath)
      expect(body.ws_url).toBe(`/ws/sessions/${seed.sessionId}`)

      // Spawner was invoked with --resume <id> --dangerously-skip-permissions.
      expect(rec.calls.length).toBe(1)
      expect(rec.calls[0]!.file).toBe('claude')
      expect(rec.calls[0]!.args[0]).toBe('--resume')
      expect(rec.calls[0]!.args[1]).toBe(seed.sessionId)
      expect(rec.calls[0]!.args[2]).toBe('--dangerously-skip-permissions')
      // No --session-id, no --name.
      expect(rec.calls[0]!.args).not.toContain('--session-id')
      expect(rec.calls[0]!.args).not.toContain('--name')

      // session.updated event recorded.
      const evt = cap.events.find(
        (e: any) => e.type === 'session.updated' && e.session?.id === seed.sessionId,
      )
      expect(evt).toBeDefined()
    } finally {
      cap.stop()
    }
  })

  test('non-existent session -> 404 session_not_found', async () => {
    const res = await app.fetch(
      new Request('http://test/api/sessions/00000000-0000-4000-8000-000000000000/resume', {
        method: 'POST',
      }),
    )
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('session_not_found')
  })

  test('jsonl missing on disk -> 404 jsonl_missing', async () => {
    const { effortId } = await makeProjectAndEffort('Resume-JsonlMissing')
    const sessionId = crypto.randomUUID()
    createSession(getDb(), {
      id: sessionId,
      effort_id: effortId,
      mode: 'autonomous',
      jsonl_path: '/tmp/definitely-not-there-resume-route.jsonl',
    })

    const res = await app.fetch(
      new Request(`http://test/api/sessions/${sessionId}/resume`, {
        method: 'POST',
      }),
    )
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('jsonl_missing')

    // Row preserved.
    expect(getSessionById(getDb(), sessionId)).not.toBeNull()
  })

  test('already-live (live-orphaned via row pid) -> 409 session_already_live', async () => {
    const { effortId } = await makeProjectAndEffort('Resume-AlreadyLive')
    const sessionId = crypto.randomUUID()
    const jsonlDir = mkdtempSync(join(tmpdir(), 'ralph-monitor-resume-jsonl-'))
    tempDirs.push(jsonlDir)
    const jsonlPath = join(jsonlDir, 'session.jsonl')
    writeFileSync(jsonlPath, '{}\n')
    createSession(getDb(), {
      id: sessionId,
      effort_id: effortId,
      mode: 'autonomous',
      jsonl_path: jsonlPath,
      process_pid: 99999,
      process_started_at: Date.now(),
    })

    const res = await app.fetch(
      new Request(`http://test/api/sessions/${sessionId}/resume`, {
        method: 'POST',
      }),
    )
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('session_already_live')
  })
})

// ---------------------------------------------------------------------------
// GET /api/efforts/:id/snapshot  (US-012c)
// ---------------------------------------------------------------------------

describe('GET /api/efforts/:id/snapshot', () => {
  // Helper: project + a kind='prd' effort with an optional real prd.json on disk.
  async function makePrdEffort(opts: {
    name: string
    writePrd?: boolean
  }): Promise<{ projectId: string; effortId: string; prdPath: string }> {
    const dir = tmpProjectDir()
    const rp = await app.fetch(
      new Request('http://test/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: opts.name, root_dir: dir }),
      }),
    )
    expect(rp.status).toBe(201)
    const proj = await rp.json()

    // prd.json lives inside its own subdir so path resolution is unambiguous.
    const prdDir = mkdtempSync(join(tmpdir(), 'ralph-monitor-prd-'))
    tempDirs.push(prdDir)
    const prdPath = join(prdDir, 'prd.json')

    if (opts.writePrd) {
      writeFileSync(
        prdPath,
        JSON.stringify({
          title: 'Test PRD',
          userStories: [{ id: 'US-001', title: 'Story 1', passes: false }],
        }),
      )
    }

    const re = await app.fetch(
      new Request(`http://test/api/projects/${proj.id}/efforts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'My PRD', kind: 'prd', prd_path: prdPath }),
      }),
    )
    expect(re.status).toBe(201)
    const effort = await re.json()

    return { projectId: proj.id, effortId: effort.id, prdPath }
  }

  test('happy path: kind=prd with real prd.json -> 200 with prd field populated', async () => {
    const { effortId } = await makePrdEffort({ name: 'Snapshot-Happy', writePrd: true })

    const res = await app.fetch(new Request(`http://test/api/efforts/${effortId}/snapshot`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.prd).toBeDefined()
    expect(body.prd.title).toBe('Test PRD')
    expect(Array.isArray(body.prd.userStories)).toBe(true)
    expect(body.prd.userStories[0].id).toBe('US-001')
  })

  test('kind=prd with prd.json not on disk -> 200 + { status: "pending" }', async () => {
    const { effortId } = await makePrdEffort({ name: 'Snapshot-Pending', writePrd: false })

    const res = await app.fetch(new Request(`http://test/api/efforts/${effortId}/snapshot`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('pending')
  })

  test('kind=general effort -> 404 effort_not_prd_kind', async () => {
    const { effortId } = await makeProjectAndEffort('Snapshot-General')
    // makeProjectAndEffort returns the auto-General effort which is kind='general'

    const res = await app.fetch(new Request(`http://test/api/efforts/${effortId}/snapshot`))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('effort_not_prd_kind')
  })

  test('non-existent effort id -> 404 effort_not_found', async () => {
    const res = await app.fetch(
      new Request('http://test/api/efforts/00000000-0000-4000-8000-000000000099/snapshot'),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('effort_not_found')
  })
})

// ---------------------------------------------------------------------------
// Effort prd watcher: effort.snapshot.updated event (US-012c)
// ---------------------------------------------------------------------------

describe('effort prd watcher', () => {
  test('modifying prd.json emits effort.snapshot.updated within 500ms', async () => {
    const dir = tmpProjectDir()
    const rp = await app.fetch(
      new Request('http://test/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Watcher-Test', root_dir: dir }),
      }),
    )
    const proj = await rp.json()

    // Write an initial prd.json to a temp dir.
    const prdDir = mkdtempSync(join(tmpdir(), 'ralph-monitor-watcher-'))
    tempDirs.push(prdDir)
    const prdPath = join(prdDir, 'prd.json')
    writeFileSync(prdPath, JSON.stringify({ title: 'v1', userStories: [] }))

    const re = await app.fetch(
      new Request(`http://test/api/projects/${proj.id}/efforts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Watcher PRD', kind: 'prd', prd_path: prdPath }),
      }),
    )
    expect(re.status).toBe(201)
    const effort = await re.json()

    // Capture SSE events.
    const cap = captureEvents()
    try {
      // Modify the prd.json to trigger the watcher.
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('watcher timeout')), 500)
        const id = store.subscribe((chunk) => {
          const m = chunk.match(/data: (.+)\n/)
          if (!m) return
          try {
            const evt = JSON.parse(m[1])
            if (
              evt.type === 'effort.snapshot.updated' &&
              evt.effort_id === effort.id
            ) {
              clearTimeout(timeout)
              store.unsubscribe(id)
              resolve()
            }
          } catch {}
        })

        // Write the file change slightly after subscription is established.
        setTimeout(() => {
          writeFileSync(prdPath, JSON.stringify({ title: 'v2', userStories: [] }))
        }, 20)
      })
    } finally {
      cap.stop()
      _unwatchEffortPrd(effort.id)
    }
  })
})

// ---------------------------------------------------------------------------
// GET /api/projects/check-worktree  (US-015b)
// ---------------------------------------------------------------------------
//
// We test:
//   1. Missing path param -> 400 path_required
//   2. Path that is NOT a worktree of any project -> { matched: false }
//   3. Path that exactly equals an existing project root_dir -> { matched: true, projectId }
//
// The positive git-worktree case (where listWorktrees() picks up a real git
// worktree via `git worktree list --porcelain`) requires an actual git repo on
// disk with a registered worktree, which is heavy to set up in a unit test. It
// is covered by the shared checkIsWorktreeOfProject logic in worktrees.test.ts
// and is therefore skipped here.

describe('GET /api/projects/check-worktree', () => {
  test('missing path param -> 400 path_required', async () => {
    const res = await app.fetch(new Request('http://test/api/projects/check-worktree'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('path_required')
  })

  test('path not matching any project -> { matched: false }', async () => {
    // Use a random temp dir that we did NOT register as a project root.
    const orphan = tmpProjectDir()
    const res = await app.fetch(
      new Request(`http://test/api/projects/check-worktree?path=${encodeURIComponent(orphan)}`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.matched).toBe(false)
  })

  test('path equals existing project root_dir -> { matched: true, projectId }', async () => {
    const dir = tmpProjectDir()
    // Create a project whose root_dir IS `dir`.
    const pr = await app.fetch(
      new Request('http://test/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'CheckWT-Match', root_dir: dir }),
      }),
    )
    expect(pr.status).toBe(201)
    const proj = await pr.json()

    // Now check-worktree for that same path.
    const res = await app.fetch(
      new Request(`http://test/api/projects/check-worktree?path=${encodeURIComponent(dir)}`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.matched).toBe(true)
    expect(body.projectId).toBe(proj.id)
    // branch is null for the project root itself (no git repo → no branch data)
    expect(body.branch).toBeNull()
  })
})
