// Server-side tests for session archive (Ask 2).
//
// Covers:
//   1. PATCH /api/sessions/:id with archived=true archives the session (200 + SSE event)
//   2. PATCH /api/sessions/:id with archived=false unarchives the session
//   3. GET /api/efforts/:id/sessions excludes archived by default
//   4. GET /api/efforts/:id/sessions?include_archived=true returns all sessions

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_DB_DIR = mkdtempSync(join(tmpdir(), 'ralph-monitor-session-archive-'))
const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db')
process.env.RALPH_MONITOR_DB = TEST_DB_PATH

// Imports AFTER env var is set.
const { Hono } = await import('hono')
const { projectsRouter } = await import('./projects')
const { effortsRouter } = await import('./efforts')
const { sessionsRouter } = await import('./sessions')
const { getDb, closeDb, createProject, createSession } = await import('../db')
const { store } = await import('../store')

const app = new Hono()
app.route('/', projectsRouter)
app.route('/', effortsRouter)
app.route('/', sessionsRouter)

const tempDirs: string[] = []
function tmpProjectDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ralph-monitor-session-archive-proj-'))
  tempDirs.push(d)
  return d
}

beforeAll(() => {
  getDb()
})

afterAll(() => {
  try { closeDb() } catch {}
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
  try { rmSync(TEST_DB_DIR, { recursive: true, force: true }) } catch {}
})

function captureEvents(): { events: unknown[]; stop: () => void } {
  const events: unknown[] = []
  const id = store.subscribe((chunk) => {
    const m = chunk.match(/data: (.+)\n/)
    if (m) {
      try { events.push(JSON.parse(m[1])) } catch {}
    }
  })
  return { events, stop: () => store.unsubscribe(id) }
}

describe('session archive — PATCH archived=true', () => {
  test('archives the session and emits session.updated SSE event', async () => {
    const db = getDb()
    const dir = tmpProjectDir()
    const { effortId } = createProject(db, { name: 'Test', root_dir: dir })
    const session = createSession(db, {
      id: crypto.randomUUID(),
      effort_id: effortId,
      mode: 'interactive',
      jsonl_path: '/tmp/s1.jsonl',
    })
    expect(session.archived).toBe(false)

    const cap = captureEvents()
    const res = await app.fetch(
      new Request(`http://test/api/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      }),
    )
    cap.stop()

    expect(res.status).toBe(200)
    const body = await res.json() as { archived: boolean }
    expect(body.archived).toBe(true)

    // SSE event emitted.
    const updated = cap.events.find(
      (e: unknown) => (e as { type?: string })?.type === 'session.updated',
    ) as { type: string; session: { id: string; archived: boolean } } | undefined
    expect(updated).toBeDefined()
    expect(updated!.session.id).toBe(session.id)
    expect(updated!.session.archived).toBe(true)
  })

  test('unarchives the session via archived=false', async () => {
    const db = getDb()
    const dir = tmpProjectDir()
    const { effortId } = createProject(db, { name: 'Test2', root_dir: dir })
    const session = createSession(db, {
      id: crypto.randomUUID(),
      effort_id: effortId,
      mode: 'interactive',
      jsonl_path: '/tmp/s2.jsonl',
    })

    // Archive first.
    await app.fetch(
      new Request(`http://test/api/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      }),
    )

    // Now unarchive.
    const res = await app.fetch(
      new Request(`http://test/api/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived: false }),
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { archived: boolean }
    expect(body.archived).toBe(false)
  })
})

describe('GET /api/efforts/:id/sessions — include_archived filter', () => {
  test('default (no param) excludes archived sessions', async () => {
    const db = getDb()
    const dir = tmpProjectDir()
    const { effortId } = createProject(db, { name: 'Filter', root_dir: dir })

    createSession(db, {
      id: crypto.randomUUID(),
      effort_id: effortId,
      mode: 'interactive',
      jsonl_path: '/tmp/active.jsonl',
    })
    const archived = createSession(db, {
      id: crypto.randomUUID(),
      effort_id: effortId,
      mode: 'interactive',
      jsonl_path: '/tmp/archived.jsonl',
    })

    // Archive one session directly via PATCH.
    await app.fetch(
      new Request(`http://test/api/sessions/${archived.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      }),
    )

    const res = await app.fetch(
      new Request(`http://test/api/efforts/${effortId}/sessions`),
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { sessions: { id: string; archived: boolean }[] }
    expect(body.sessions.every((s) => !s.archived)).toBe(true)
    expect(body.sessions.find((s) => s.id === archived.id)).toBeUndefined()
  })

  test('?include_archived=true returns all sessions including archived', async () => {
    const db = getDb()
    const dir = tmpProjectDir()
    const { effortId } = createProject(db, { name: 'FilterAll', root_dir: dir })

    createSession(db, {
      id: crypto.randomUUID(),
      effort_id: effortId,
      mode: 'interactive',
      jsonl_path: '/tmp/all-active.jsonl',
    })
    const archived = createSession(db, {
      id: crypto.randomUUID(),
      effort_id: effortId,
      mode: 'interactive',
      jsonl_path: '/tmp/all-archived.jsonl',
    })

    await app.fetch(
      new Request(`http://test/api/sessions/${archived.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      }),
    )

    const res = await app.fetch(
      new Request(`http://test/api/efforts/${effortId}/sessions?include_archived=true`),
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { sessions: { id: string; archived: boolean }[] }
    const archivedInRes = body.sessions.find((s) => s.id === archived.id)
    expect(archivedInRes).toBeDefined()
    expect(archivedInRes!.archived).toBe(true)
  })
})
