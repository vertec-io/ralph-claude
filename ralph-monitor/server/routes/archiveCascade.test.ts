// Archive cascade + live-session block tests for US-017a.
//
// Covers:
//   - PATCH project archived=true with no live sessions: cascades to efforts
//   - PATCH project archived=true with a live session in some effort: returns 409, NO efforts archived
//   - PATCH effort status=archived with a live session: returns 409
//   - PATCH project archived=false: does NOT cascade-unarchive efforts

import { afterAll, beforeAll, describe, expect, test, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_DB_DIR = mkdtempSync(join(tmpdir(), 'ralph-monitor-archive-cascade-'))
const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db')
process.env.RALPH_MONITOR_DB = TEST_DB_PATH

// Imports AFTER env var is set so getDb() resolves to our temp file.
const { Hono } = await import('hono')
const { projectsRouter, __test__: projectsTest } = await import('./projects')
const { effortsRouter, __test__: effortsTest } = await import('./efforts')
const { getDb, closeDb, listEffortsByProject, getEffortById } = await import('../db')

const app = new Hono()
app.route('/', projectsRouter)
app.route('/', effortsRouter)

const tempDirs: string[] = []
function tmpProjectDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ralph-monitor-archive-cascade-proj-'))
  tempDirs.push(d)
  return d
}

beforeAll(() => {
  // Force schema migration before any test runs.
  getDb()
})

afterAll(() => {
  try { closeDb() } catch {}
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
  try { rmSync(TEST_DB_DIR, { recursive: true, force: true }) } catch {}
})

afterEach(() => {
  // Always reset the live-check override after each test to avoid cross-test
  // contamination.
  projectsTest.setLiveCheckOverride(null)
  effortsTest.setLiveCheckOverride(null)
})

// ---------------------------------------------------------------------------
// Helper — create a project via the API and return its id + initial effort id.
// ---------------------------------------------------------------------------
async function createProject(name: string): Promise<{ projectId: string; effortId: string }> {
  const dir = tmpProjectDir()
  const res = await app.fetch(
    new Request('http://test/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, root_dir: dir }),
    }),
  )
  expect(res.status).toBe(201)
  const proj = await res.json()
  const efforts = listEffortsByProject(getDb(), proj.id)
  return { projectId: proj.id, effortId: efforts[0].id }
}

// ---------------------------------------------------------------------------
// Add an extra effort to a project
// ---------------------------------------------------------------------------
async function addEffort(projectId: string, effortName: string): Promise<string> {
  const res = await app.fetch(
    new Request(`http://test/api/projects/${projectId}/efforts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: effortName, kind: 'general' }),
    }),
  )
  expect(res.status).toBe(201)
  const effort = await res.json()
  return effort.id
}

// ---------------------------------------------------------------------------
// PATCH /api/projects/:id — archive cascade tests
// ---------------------------------------------------------------------------

describe('PATCH /api/projects/:id — archive cascade (US-017a)', () => {
  test('archived=true with no live sessions: cascades to all non-archived efforts', async () => {
    const { projectId, effortId: effortId1 } = await createProject('CascadeNoLive')
    const effortId2 = await addEffort(projectId, 'Second effort')

    // No live sessions — override returns 0.
    projectsTest.setLiveCheckOverride(() => 0)

    const res = await app.fetch(
      new Request(`http://test/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      }),
    )
    expect(res.status).toBe(200)
    const project = await res.json()
    expect(project.archived).toBe(true)

    // Both efforts should now be archived.
    const e1 = getEffortById(getDb(), effortId1)
    const e2 = getEffortById(getDb(), effortId2)
    expect(e1?.status).toBe('archived')
    expect(e2?.status).toBe('archived')
  })

  test('archived=true with already-archived effort: skips that effort (no double-event)', async () => {
    const { projectId, effortId: effortId1 } = await createProject('CascadePartiallyArchived')
    const effortId2 = await addEffort(projectId, 'Pre-archived effort')

    // Pre-archive effortId2 before the project archive.
    projectsTest.setLiveCheckOverride(() => 0)
    const pre = await app.fetch(
      new Request(`http://test/api/efforts/${effortId2}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'archived' }),
      }),
    )
    expect(pre.status).toBe(200)

    // Now archive the project — should cascade to effortId1 but not fail.
    const res = await app.fetch(
      new Request(`http://test/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      }),
    )
    expect(res.status).toBe(200)

    const e1 = getEffortById(getDb(), effortId1)
    const e2 = getEffortById(getDb(), effortId2)
    expect(e1?.status).toBe('archived')
    expect(e2?.status).toBe('archived')
  })

  test('archived=true with a live session in an effort: returns 409, NO efforts archived', async () => {
    const { projectId, effortId } = await createProject('CascadeLiveBlock')
    const effortId2 = await addEffort(projectId, 'Non-live effort')

    // Simulate: effortId has 1 live session, effortId2 has none.
    projectsTest.setLiveCheckOverride((id) => (id === effortId ? 1 : 0))

    const res = await app.fetch(
      new Request(`http://test/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      }),
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('project_has_live_sessions')
    expect(Array.isArray(body.details?.offending_efforts)).toBe(true)
    expect(body.details.offending_efforts.length).toBeGreaterThan(0)
    expect(body.details.offending_efforts[0].effort_id).toBe(effortId)

    // TRANSACTIONAL: neither effort should be archived.
    const e1 = getEffortById(getDb(), effortId)
    const e2 = getEffortById(getDb(), effortId2)
    expect(e1?.status).toBe('active')
    expect(e2?.status).toBe('active')

    // Project itself should NOT be archived either.
    const projRes = await app.fetch(new Request(`http://test/api/projects/${projectId}`))
    // Project doesn't have a GET-by-id endpoint, verify via list.
    const listRes = await app.fetch(new Request('http://test/api/projects?status=active'))
    const listBody = await listRes.json()
    const ids = listBody.projects.map((p: { id: string }) => p.id)
    expect(ids).toContain(projectId)
  })

  test('archived=false (unarchive): does NOT cascade-unarchive efforts', async () => {
    const { projectId, effortId } = await createProject('UnarchiveNoTouch')

    // First, archive the project (no live sessions).
    projectsTest.setLiveCheckOverride(() => 0)
    const archRes = await app.fetch(
      new Request(`http://test/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      }),
    )
    expect(archRes.status).toBe(200)

    // Verify effort was cascaded to archived.
    const beforeUnarchive = getEffortById(getDb(), effortId)
    expect(beforeUnarchive?.status).toBe('archived')

    // Reset override (no live sessions check needed for unarchive).
    projectsTest.setLiveCheckOverride(null)

    // Now unarchive the project.
    const unarchRes = await app.fetch(
      new Request(`http://test/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived: false }),
      }),
    )
    expect(unarchRes.status).toBe(200)
    const proj = await unarchRes.json()
    expect(proj.archived).toBe(false)

    // Effort should still be archived (no cascade for unarchive).
    const afterUnarchive = getEffortById(getDb(), effortId)
    expect(afterUnarchive?.status).toBe('archived')
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/efforts/:id — live-session archive block
// ---------------------------------------------------------------------------

describe('PATCH /api/efforts/:id — live-session archive block (US-017a)', () => {
  test('status=archived with a live session: returns 409', async () => {
    const { effortId } = await createProject('EffortLiveBlock')

    // Simulate 1 live session on this effort.
    effortsTest.setLiveCheckOverride((id) => (id === effortId ? 1 : 0))

    const res = await app.fetch(
      new Request(`http://test/api/efforts/${effortId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'archived' }),
      }),
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('effort_has_live_sessions')
    expect(body.details?.effort_id).toBe(effortId)
    expect(Array.isArray(body.details?.live_session_ids)).toBe(true)
    expect(body.details.live_session_ids.length).toBeGreaterThan(0)

    // Effort should NOT be archived.
    const effort = getEffortById(getDb(), effortId)
    expect(effort?.status).toBe('active')
  })

  test('status=archived with no live sessions: succeeds', async () => {
    const { effortId } = await createProject('EffortNoLiveArchive')

    effortsTest.setLiveCheckOverride(() => 0)

    const res = await app.fetch(
      new Request(`http://test/api/efforts/${effortId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'archived' }),
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('archived')

    const effort = getEffortById(getDb(), effortId)
    expect(effort?.status).toBe('archived')
  })

  test('status=active (unarchive): never blocked regardless of live sessions', async () => {
    const { effortId } = await createProject('EffortUnarchiveAlwaysOk')

    // Archive first (no live sessions).
    effortsTest.setLiveCheckOverride(() => 0)
    const archRes = await app.fetch(
      new Request(`http://test/api/efforts/${effortId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'archived' }),
      }),
    )
    expect(archRes.status).toBe(200)

    // Now simulate live sessions (shouldn't block unarchive).
    effortsTest.setLiveCheckOverride(() => 1)

    const unarchRes = await app.fetch(
      new Request(`http://test/api/efforts/${effortId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      }),
    )
    expect(unarchRes.status).toBe(200)
    const effort = getEffortById(getDb(), effortId)
    expect(effort?.status).toBe('active')
  })
})
