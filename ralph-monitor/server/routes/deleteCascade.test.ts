// Delete cascade + live-session block + JSONL purge tests for US-017b.
//
// Covers:
//   - DELETE project with no live sessions: succeeds, all child data removed
//   - DELETE project with purge_jsonls=true: JSONL files unlinked from disk
//   - DELETE project with a live session: 409, nothing deleted
//   - DELETE effort with a live session: 409
//   - DELETE effort with purge_jsonls=true: child sessions' JSONLs unlinked
//   - GET /api/projects/:id/cascade-stats: accurate counts
//   - GET /api/efforts/:id/cascade-stats: accurate counts

import { afterAll, beforeAll, describe, expect, test, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_DB_DIR = mkdtempSync(join(tmpdir(), 'ralph-monitor-delete-cascade-'))
const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db')
process.env.RALPH_MONITOR_DB = TEST_DB_PATH

// Imports AFTER env var is set so getDb() resolves to our temp file.
const { Hono } = await import('hono')
const { projectsRouter, __test__: projectsTest } = await import('./projects')
const { effortsRouter, __test__: effortsTest } = await import('./efforts')
const {
  getDb,
  closeDb,
  listEffortsByProject,
  getEffortById,
  getProjectById,
  getSessionById,
  createSession,
} = await import('../db')

const app = new Hono()
app.route('/', projectsRouter)
app.route('/', effortsRouter)

const tempDirs: string[] = []

function tmpProjectDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ralph-monitor-delete-cascade-proj-'))
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

afterEach(() => {
  projectsTest.setLiveCheckOverride(null)
  effortsTest.setLiveCheckOverride(null)
})

// ---------------------------------------------------------------------------
// Helper: create a project via the API; returns { projectId, effortId }
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
// Helper: add a session row directly (bypasses spawn) with a real JSONL file
// ---------------------------------------------------------------------------
function addSessionWithJsonl(
  effortId: string,
  jsonlDir: string,
): { sessionId: string; jsonlPath: string } {
  const sessionId = crypto.randomUUID()
  const jsonlPath = join(jsonlDir, `${sessionId}.jsonl`)
  writeFileSync(jsonlPath, '{"type":"text","content":"hello"}\n')
  createSession(getDb(), {
    id: sessionId,
    effort_id: effortId,
    mode: 'interactive',
    jsonl_path: jsonlPath,
  })
  return { sessionId, jsonlPath }
}

// ---------------------------------------------------------------------------
// GET /api/projects/:id/cascade-stats
// ---------------------------------------------------------------------------

describe('GET /api/projects/:id/cascade-stats (US-017b)', () => {
  test('returns effort_count and session_count', async () => {
    const { projectId, effortId } = await createProject('CascadeStatsProject')
    const jsonlDir = tmpProjectDir()
    addSessionWithJsonl(effortId, jsonlDir)
    addSessionWithJsonl(effortId, jsonlDir)

    const res = await app.fetch(
      new Request(`http://test/api/projects/${projectId}/cascade-stats`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.effort_count).toBe(1)      // one auto-created General effort
    expect(body.session_count).toBe(2)
  })

  test('returns 404 for unknown project', async () => {
    const res = await app.fetch(
      new Request('http://test/api/projects/nonexistent-id/cascade-stats'),
    )
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// GET /api/efforts/:id/cascade-stats
// ---------------------------------------------------------------------------

describe('GET /api/efforts/:id/cascade-stats (US-017b)', () => {
  test('returns session_count', async () => {
    const { effortId } = await createProject('CascadeStatsEffort')
    const jsonlDir = tmpProjectDir()
    addSessionWithJsonl(effortId, jsonlDir)

    const res = await app.fetch(
      new Request(`http://test/api/efforts/${effortId}/cascade-stats`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.session_count).toBe(1)
  })

  test('returns 0 when effort has no sessions', async () => {
    const { effortId } = await createProject('CascadeStatsEffortEmpty')

    const res = await app.fetch(
      new Request(`http://test/api/efforts/${effortId}/cascade-stats`),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.session_count).toBe(0)
  })

  test('returns 404 for unknown effort', async () => {
    const res = await app.fetch(
      new Request('http://test/api/efforts/nonexistent-effort/cascade-stats'),
    )
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/projects/:id — no live sessions → success
// ---------------------------------------------------------------------------

describe('DELETE /api/projects/:id — success path (US-017b)', () => {
  test('deletes project and cascades to efforts and sessions', async () => {
    const { projectId, effortId } = await createProject('DeleteProjectNoLive')
    const jsonlDir = tmpProjectDir()
    const { sessionId } = addSessionWithJsonl(effortId, jsonlDir)

    projectsTest.setLiveCheckOverride(() => 0)

    const res = await app.fetch(
      new Request(
        `http://test/api/projects/${projectId}?confirm_name=${encodeURIComponent('DeleteProjectNoLive')}`,
        { method: 'DELETE' },
      ),
    )
    expect(res.status).toBe(204)

    // Project, effort, and session should all be gone.
    expect(getProjectById(getDb(), projectId)).toBeNull()
    expect(getEffortById(getDb(), effortId)).toBeNull()
    expect(getSessionById(getDb(), sessionId)).toBeNull()
  })

  test('confirm_name mismatch returns 422', async () => {
    const { projectId } = await createProject('DeleteProjectMismatch')

    const res = await app.fetch(
      new Request(
        `http://test/api/projects/${projectId}?confirm_name=wrongname`,
        { method: 'DELETE' },
      ),
    )
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe('confirm_name_mismatch')
    // Project should still exist.
    expect(getProjectById(getDb(), projectId)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/projects/:id?purge_jsonls=true
// ---------------------------------------------------------------------------

describe('DELETE /api/projects/:id?purge_jsonls=true (US-017b)', () => {
  test('unlinks JSONL files from disk after cascade', async () => {
    const { projectId, effortId } = await createProject('DeleteProjectPurge')
    const jsonlDir = tmpProjectDir()
    const { jsonlPath: path1 } = addSessionWithJsonl(effortId, jsonlDir)
    const { jsonlPath: path2 } = addSessionWithJsonl(effortId, jsonlDir)

    projectsTest.setLiveCheckOverride(() => 0)

    // Verify the files exist before.
    await expect(stat(path1)).resolves.toBeDefined()
    await expect(stat(path2)).resolves.toBeDefined()

    const res = await app.fetch(
      new Request(
        `http://test/api/projects/${projectId}?confirm_name=${encodeURIComponent('DeleteProjectPurge')}&purge_jsonls=true`,
        { method: 'DELETE' },
      ),
    )
    expect(res.status).toBe(204)

    // Files should be gone.
    await expect(stat(path1)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path2)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('does NOT unlink JSONL files when purge_jsonls is omitted (default false)', async () => {
    const { projectId, effortId } = await createProject('DeleteProjectNoPurge')
    const jsonlDir = tmpProjectDir()
    const { jsonlPath } = addSessionWithJsonl(effortId, jsonlDir)

    projectsTest.setLiveCheckOverride(() => 0)

    const res = await app.fetch(
      new Request(
        `http://test/api/projects/${projectId}?confirm_name=${encodeURIComponent('DeleteProjectNoPurge')}`,
        { method: 'DELETE' },
      ),
    )
    expect(res.status).toBe(204)

    // JSONL file should still exist on disk.
    await expect(stat(jsonlPath)).resolves.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/projects/:id — live-session block
// ---------------------------------------------------------------------------

describe('DELETE /api/projects/:id — live-session block (US-017b)', () => {
  test('returns 409 when a child effort has a live session; nothing deleted', async () => {
    const { projectId, effortId } = await createProject('DeleteProjectLiveBlock')
    const jsonlDir = tmpProjectDir()
    const { sessionId } = addSessionWithJsonl(effortId, jsonlDir)

    // Simulate: effortId has 1 live session.
    projectsTest.setLiveCheckOverride((id) => (id === effortId ? 1 : 0))

    const res = await app.fetch(
      new Request(
        `http://test/api/projects/${projectId}?confirm_name=${encodeURIComponent('DeleteProjectLiveBlock')}`,
        { method: 'DELETE' },
      ),
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('project_has_live_sessions')
    expect(Array.isArray(body.details?.offending_efforts)).toBe(true)
    expect(body.details.offending_efforts.length).toBeGreaterThan(0)

    // TRANSACTIONAL: project, effort, and session all still exist.
    expect(getProjectById(getDb(), projectId)).not.toBeNull()
    expect(getEffortById(getDb(), effortId)).not.toBeNull()
    expect(getSessionById(getDb(), sessionId)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/efforts/:id — live-session block
// ---------------------------------------------------------------------------

describe('DELETE /api/efforts/:id — live-session block (US-017b)', () => {
  test('returns 409 when effort has a live session', async () => {
    const { effortId } = await createProject('DeleteEffortLiveBlock')

    effortsTest.setLiveCheckOverride((id) => (id === effortId ? 1 : 0))

    const res = await app.fetch(
      new Request(`http://test/api/efforts/${effortId}`, { method: 'DELETE' }),
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('effort_has_live_sessions')
    expect(body.details?.effort_id).toBe(effortId)
    expect(Array.isArray(body.details?.live_session_ids)).toBe(true)
    expect(body.details.live_session_ids.length).toBeGreaterThan(0)

    // Effort should still exist.
    expect(getEffortById(getDb(), effortId)).not.toBeNull()
  })

  test('returns 204 when no live sessions', async () => {
    const { effortId } = await createProject('DeleteEffortNoLive')

    effortsTest.setLiveCheckOverride(() => 0)

    const res = await app.fetch(
      new Request(`http://test/api/efforts/${effortId}`, { method: 'DELETE' }),
    )
    expect(res.status).toBe(204)
    expect(getEffortById(getDb(), effortId)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/efforts/:id?purge_jsonls=true
// ---------------------------------------------------------------------------

describe('DELETE /api/efforts/:id?purge_jsonls=true (US-017b)', () => {
  test('unlinks child session JSONL files from disk', async () => {
    const { effortId } = await createProject('DeleteEffortPurge')
    const jsonlDir = tmpProjectDir()
    const { jsonlPath: p1 } = addSessionWithJsonl(effortId, jsonlDir)
    const { jsonlPath: p2 } = addSessionWithJsonl(effortId, jsonlDir)

    effortsTest.setLiveCheckOverride(() => 0)

    await expect(stat(p1)).resolves.toBeDefined()
    await expect(stat(p2)).resolves.toBeDefined()

    const res = await app.fetch(
      new Request(`http://test/api/efforts/${effortId}?purge_jsonls=true`, {
        method: 'DELETE',
      }),
    )
    expect(res.status).toBe(204)

    await expect(stat(p1)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(p2)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('does NOT unlink JSONL when purge_jsonls omitted', async () => {
    const { effortId } = await createProject('DeleteEffortNoPurge')
    const jsonlDir = tmpProjectDir()
    const { jsonlPath } = addSessionWithJsonl(effortId, jsonlDir)

    effortsTest.setLiveCheckOverride(() => 0)

    const res = await app.fetch(
      new Request(`http://test/api/efforts/${effortId}`, { method: 'DELETE' }),
    )
    expect(res.status).toBe(204)

    await expect(stat(jsonlPath)).resolves.toBeDefined()
  })
})
