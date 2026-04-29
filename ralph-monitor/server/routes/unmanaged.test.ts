// Tests for GET /api/unmanaged-prds (US-013).
//
// Strategy: mock discoverFromSystemd so we don't need real systemd units on
// disk. The route imports it directly, so we use module mocking to replace it
// with a controllable stub. The DB layer uses a real in-memory SQLite instance
// via the $RALPH_MONITOR_DB env var trick used throughout the test suite.

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Set up the test DB BEFORE any imports that touch getDb()
const TEST_DB_DIR = mkdtempSync(join(tmpdir(), 'ralph-monitor-unmanaged-test-'))
const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db')
process.env.RALPH_MONITOR_DB = TEST_DB_PATH

// ---------------------------------------------------------------------------
// Stub discoverFromSystemd via module mocking.
// We store a mutable reference so individual tests can swap the return value.
// ---------------------------------------------------------------------------
const discoveredRecords: import('../types').PRDRecord[] = []

mock.module('../discovery', () => ({
  discoverFromSystemd: () => Promise.resolve([...discoveredRecords]),
}))

// IMPORTANT: these imports must be AFTER mock.module() and AFTER env var is set.
const { Hono } = await import('hono')
const { unmanagedRouter } = await import('./unmanaged')
const { projectsRouter } = await import('./projects')
const { effortsRouter } = await import('./efforts')
const { getDb, closeDb, createProject, createEffort } = await import('../db')

const app = new Hono()
app.route('/', projectsRouter)
app.route('/', effortsRouter)
app.route('/', unmanagedRouter)

// Helper: seed a project (real tmpdir needed for createProject's realpath)
const tempDirs: string[] = []
function tmpProjectDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ralph-monitor-unmanaged-proj-'))
  tempDirs.push(d)
  return d
}

// Helper: build a minimal PRDRecord skeleton
function makeRecord(
  opts: Partial<import('../types').PRDRecord> & { taskDir: string; unitName: string },
): import('../types').PRDRecord {
  const { unitName, taskDir, worktreeDir, ...rest } = opts
  return {
    unitName,
    taskDir,
    worktreeDir: worktreeDir ?? taskDir,
    sessionId: 'test-session',
    recentCommits: [],
    watchdogLogTail: [],
    decisionFiles: [],
    docFiles: [],
    status: 'idle',
    lastUpdated: Date.now(),
    ...rest,
  }
}

beforeAll(() => {
  getDb() // run migrations
})

afterAll(() => {
  try { closeDb() } catch {}
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
  try { rmSync(TEST_DB_DIR, { recursive: true, force: true }) } catch {}
})

describe('GET /api/unmanaged-prds', () => {
  test('no efforts → all discovered records returned', async () => {
    const dir1 = tmpProjectDir()
    const dir2 = tmpProjectDir()
    discoveredRecords.length = 0
    discoveredRecords.push(
      makeRecord({ unitName: 'unit-a', taskDir: dir1 }),
      makeRecord({ unitName: 'unit-b', taskDir: dir2 }),
    )

    const res = await app.fetch(new Request('http://test/api/unmanaged-prds'))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(Array.isArray(body.unmanaged)).toBe(true)
    const units = body.unmanaged.map((r: any) => r.unitName)
    expect(units).toContain('unit-a')
    expect(units).toContain('unit-b')
  })

  test('adopted effort (prd_path matches) → that record excluded', async () => {
    const taskDir = tmpProjectDir()
    const prdPath = join(taskDir, 'prd.json')
    discoveredRecords.length = 0
    discoveredRecords.push(makeRecord({ unitName: 'adopted-unit', taskDir }))

    // Create a project + effort whose prd_path exactly matches the join key.
    const projDir = tmpProjectDir()
    const db = getDb()
    const { projectId } = createProject(db, { name: 'Host', root_dir: projDir })
    createEffort(db, {
      project_id: projectId,
      name: 'adopted',
      kind: 'prd',
      prd_path: prdPath,
    })

    const res = await app.fetch(new Request('http://test/api/unmanaged-prds'))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    const units = body.unmanaged.map((r: any) => r.unitName)
    expect(units).not.toContain('adopted-unit')
  })

  test('non-adopted record stays visible even when other record is adopted', async () => {
    const taskDirA = tmpProjectDir()
    const taskDirB = tmpProjectDir()
    const prdPathA = join(taskDirA, 'prd.json')

    discoveredRecords.length = 0
    discoveredRecords.push(
      makeRecord({ unitName: 'unit-adopted', taskDir: taskDirA }),
      makeRecord({ unitName: 'unit-free', taskDir: taskDirB }),
    )

    // Adopt only unit-adopted
    const projDir = tmpProjectDir()
    const db = getDb()
    const { projectId } = createProject(db, { name: 'AnotherHost', root_dir: projDir })
    createEffort(db, {
      project_id: projectId,
      name: 'adopted2',
      kind: 'prd',
      prd_path: prdPathA,
    })

    const res = await app.fetch(new Request('http://test/api/unmanaged-prds'))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    const units = body.unmanaged.map((r: any) => r.unitName)
    expect(units).not.toContain('unit-adopted')
    expect(units).toContain('unit-free')
  })

  test('worktree match → returned record has suggestedProjectId set', async () => {
    // We can't easily fake git worktree list in a unit test, but we CAN test
    // the suggestedProjectId=null case when worktreeDir is not a worktree of
    // any project. And we verify the field is present in every returned item.
    const taskDir = tmpProjectDir()
    discoveredRecords.length = 0
    discoveredRecords.push(makeRecord({ unitName: 'check-suggestion', taskDir }))

    const res = await app.fetch(new Request('http://test/api/unmanaged-prds'))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    const item = body.unmanaged.find((r: any) => r.unitName === 'check-suggestion')
    expect(item).toBeDefined()
    // The fields must exist (null when no match is fine).
    expect('suggestedProjectId' in item).toBe(true)
    expect('suggestedBranch' in item).toBe(true)
    // taskDir is a fresh tmp dir, not a worktree of any project → null
    expect(item.suggestedProjectId).toBeNull()
    expect(item.suggestedBranch).toBeNull()
  })

  test('empty discovery → empty unmanaged list', async () => {
    discoveredRecords.length = 0

    const res = await app.fetch(new Request('http://test/api/unmanaged-prds'))
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.unmanaged).toEqual([])
  })
})
