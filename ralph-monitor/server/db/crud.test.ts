// CRUD operations for projects/efforts/sessions, exercised against fresh
// in-memory DBs so each case is fully isolated. We use a real path on disk
// (the test runner's cwd) for `getProjectByRootDir` since realpath() is
// libc-backed and won't resolve a fictional path.
//
// The migrate runner is exercised in migrate.test.ts; we just call it here
// to bring schema up before each test.

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrations } from './migrate'
import {
  createProject,
  getProjectById,
  getProjectByRootDir,
  listProjects,
  updateProject,
  archiveProject,
  unarchiveProject,
  hardDeleteProject,
} from './projects'
import {
  createEffort,
  listEffortsByProject,
  updateEffort,
  EffortPrdPathRequiredError,
} from './efforts'
import {
  createSession,
  getSessionById,
  listSessionsByEffort,
  hardDeleteSession,
  SessionIdCollisionError,
  OneLiveSessionPerEffortError,
} from './sessions'

function freshDb(): Database {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db)
  return db
}

// Make a real on-disk directory we can pass to createProject. realpath() is
// libc-backed and would throw on a fictional path.
function tmpProjectDir(): string {
  return mkdtempSync(join(tmpdir(), 'ralph-monitor-crud-'))
}

describe('createProject', () => {
  test('inserts the project row + the auto-General effort transactionally', () => {
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { projectId, effortId, rootDir } = createProject(db, { name: 'My App', root_dir: dir })

      const proj = getProjectById(db, projectId)
      expect(proj).not.toBeNull()
      expect(proj!.name).toBe('My App')
      expect(proj!.root_dir).toBe(rootDir)
      expect(proj!.archived).toBe(false)
      expect(proj!.pinned).toBe(false)

      const efforts = listEffortsByProject(db, projectId)
      expect(efforts.length).toBe(1)
      expect(efforts[0].id).toBe(effortId)
      expect(efforts[0].kind).toBe('general')
      expect(efforts[0].name).toBe('General')
      expect(efforts[0].status).toBe('active')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('honors an explicit id when supplied', () => {
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { projectId } = createProject(db, { id: 'fixed-id-1', name: 'X', root_dir: dir })
      expect(projectId).toBe('fixed-id-1')
      expect(getProjectById(db, 'fixed-id-1')).not.toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('listProjects filtering and ordering', () => {
  test('archived/pinned filters return only matching rows; omitted returns all', () => {
    const db = freshDb()
    const dirs = [tmpProjectDir(), tmpProjectDir(), tmpProjectDir()]
    try {
      const a = createProject(db, { name: 'A', root_dir: dirs[0] }).projectId
      const b = createProject(db, { name: 'B', root_dir: dirs[1] }).projectId
      const c = createProject(db, { name: 'C', root_dir: dirs[2] }).projectId

      // a archived; b pinned; c untouched.
      archiveProject(db, a)
      updateProject(db, b, { pinned: true })

      const archivedOnly = listProjects(db, { archived: true })
      expect(archivedOnly.map(p => p.id).sort()).toEqual([a].sort())

      const nonArchived = listProjects(db, { archived: false })
      expect(nonArchived.map(p => p.id).sort()).toEqual([b, c].sort())

      const pinnedOnly = listProjects(db, { pinned: true })
      expect(pinnedOnly.map(p => p.id)).toEqual([b])

      const all = listProjects(db)
      expect(all.length).toBe(3)
      // Pinned floats first regardless of recency.
      expect(all[0].id).toBe(b)
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true })
    }
  })
})

describe('archive / unarchive project', () => {
  test('archive removes from non-archived list; unarchive restores', () => {
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { projectId } = createProject(db, { name: 'A', root_dir: dir })

      archiveProject(db, projectId)
      expect(listProjects(db, { archived: false }).map(p => p.id)).not.toContain(projectId)
      expect(listProjects(db, { archived: true }).map(p => p.id)).toContain(projectId)

      unarchiveProject(db, projectId)
      expect(listProjects(db, { archived: false }).map(p => p.id)).toContain(projectId)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('getProjectByRootDir', () => {
  test('matches the stored row when called with a trailing-slash path', () => {
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { projectId, rootDir } = createProject(db, { name: 'A', root_dir: dir })

      // Append a trailing slash to the same path; lookup must still hit.
      const found = getProjectByRootDir(db, `${rootDir}/`)
      expect(found).not.toBeNull()
      expect(found!.id).toBe(projectId)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns null for a path that does not exist on disk', () => {
    const db = freshDb()
    expect(getProjectByRootDir(db, '/this/path/does/not/exist/abcdef')).toBeNull()
  })

  test('matches via symlink resolution', () => {
    const db = freshDb()
    const real = tmpProjectDir()
    const linkRoot = mkdtempSync(join(tmpdir(), 'ralph-monitor-crud-link-'))
    const link = join(linkRoot, 'alias')
    symlinkSync(real, link)
    try {
      const { projectId } = createProject(db, { name: 'L', root_dir: real })
      const found = getProjectByRootDir(db, link)
      expect(found).not.toBeNull()
      expect(found!.id).toBe(projectId)
    } finally {
      rmSync(linkRoot, { recursive: true, force: true })
      rmSync(real, { recursive: true, force: true })
    }
  })
})

describe('hardDeleteProject cascades', () => {
  test('removes efforts and sessions for the project', () => {
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { projectId, effortId } = createProject(db, { name: 'A', root_dir: dir })
      createSession(db, {
        id: crypto.randomUUID(),
        effort_id: effortId,
        mode: 'autonomous',
        jsonl_path: '/tmp/s1.jsonl',
      })

      hardDeleteProject(db, projectId)

      expect(getProjectById(db, projectId)).toBeNull()
      expect(listEffortsByProject(db, projectId).length).toBe(0)
      expect(listSessionsByEffort(db, effortId).length).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('createSession id contract', () => {
  test('rejects undefined id at runtime with a clear error', () => {
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { effortId } = createProject(db, { name: 'A', root_dir: dir })
      // Cast through any to bypass the TS check; runtime guard must still fire.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bad: any = { effort_id: effortId, mode: 'autonomous', jsonl_path: '/tmp/x.jsonl' }
      expect(() => createSession(db, bad)).toThrow(/caller-allocated id/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rejects a duplicate id with SessionIdCollisionError', () => {
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { effortId } = createProject(db, { name: 'A', root_dir: dir })
      const id = crypto.randomUUID()
      createSession(db, {
        id,
        effort_id: effortId,
        mode: 'autonomous',
        jsonl_path: '/tmp/s1.jsonl',
      })
      expect(() => createSession(db, {
        id,
        effort_id: effortId,
        mode: 'autonomous',
        jsonl_path: '/tmp/s2.jsonl',
      })).toThrow(SessionIdCollisionError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('one-live-session-per-effort partial unique index', () => {
  test('second live session for same effort throws OneLiveSessionPerEffortError', () => {
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { effortId } = createProject(db, { name: 'A', root_dir: dir })

      const first = createSession(db, {
        id: crypto.randomUUID(),
        effort_id: effortId,
        mode: 'autonomous',
        jsonl_path: '/tmp/s1.jsonl',
        process_pid: 1234,
        process_started_at: Date.now(),
      })
      expect(first.process_pid).toBe(1234)

      // Second live session must fail with our typed error.
      expect(() => createSession(db, {
        id: crypto.randomUUID(),
        effort_id: effortId,
        mode: 'autonomous',
        jsonl_path: '/tmp/s2.jsonl',
        process_pid: 5678,
        process_started_at: Date.now(),
      })).toThrow(OneLiveSessionPerEffortError)

      // Third session with NULL pid is exempt — partial index doesn't apply.
      const terminated = createSession(db, {
        id: crypto.randomUUID(),
        effort_id: effortId,
        mode: 'autonomous',
        jsonl_path: '/tmp/s3.jsonl',
      })
      expect(terminated.process_pid).toBeNull()

      const live = listSessionsByEffort(db, effortId)
      expect(live.length).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('hardDeleteSession on the live row clears the partial-index slot', () => {
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { effortId } = createProject(db, { name: 'A', root_dir: dir })
      const live1 = createSession(db, {
        id: crypto.randomUUID(),
        effort_id: effortId,
        mode: 'autonomous',
        jsonl_path: '/tmp/s1.jsonl',
        process_pid: 1234,
      })
      hardDeleteSession(db, live1.id)
      expect(getSessionById(db, live1.id)).toBeNull()

      // After deleting, a new live session is allowed.
      expect(() => createSession(db, {
        id: crypto.randomUUID(),
        effort_id: effortId,
        mode: 'autonomous',
        jsonl_path: '/tmp/s2.jsonl',
        process_pid: 5678,
      })).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('createEffort prd_path CHECK', () => {
  test("kind='prd' with empty prd_path throws EffortPrdPathRequiredError", () => {
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { projectId } = createProject(db, { name: 'A', root_dir: dir })
      expect(() => createEffort(db, {
        project_id: projectId,
        name: 'My PRD',
        kind: 'prd',
        prd_path: '',
      })).toThrow(EffortPrdPathRequiredError)
      expect(() => createEffort(db, {
        project_id: projectId,
        name: 'My PRD',
        kind: 'prd',
        prd_path: null,
      })).toThrow(EffortPrdPathRequiredError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('valid prd_path is accepted', () => {
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { projectId } = createProject(db, { name: 'A', root_dir: dir })
      const e = createEffort(db, {
        project_id: projectId,
        name: 'My PRD',
        kind: 'prd',
        prd_path: '/tmp/prd.json',
      })
      expect(e.kind).toBe('prd')
      expect(e.prd_path).toBe('/tmp/prd.json')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('updateEffort partial semantics', () => {
  test('setting only name does not clear other fields', () => {
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { projectId } = createProject(db, { name: 'A', root_dir: dir })
      const e = createEffort(db, {
        project_id: projectId,
        name: 'Original',
        kind: 'task',
        working_dir: '/tmp/wd',
      })

      updateEffort(db, e.id, { name: 'Renamed' })

      const fresh = listEffortsByProject(db, projectId).find(x => x.id === e.id)!
      expect(fresh.name).toBe('Renamed')
      expect(fresh.working_dir).toBe('/tmp/wd')
      expect(fresh.status).toBe('active')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("clearing prd_path on a kind='prd' effort throws EffortPrdPathRequiredError", () => {
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { projectId } = createProject(db, { name: 'A', root_dir: dir })
      const e = createEffort(db, {
        project_id: projectId,
        name: 'P',
        kind: 'prd',
        prd_path: '/tmp/prd.json',
      })
      expect(() => updateEffort(db, e.id, { prd_path: '' })).toThrow(EffortPrdPathRequiredError)
      expect(() => updateEffort(db, e.id, { prd_path: null })).toThrow(EffortPrdPathRequiredError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('listEffortsByProject filtering', () => {
  test('filters by exact status', () => {
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { projectId } = createProject(db, { name: 'A', root_dir: dir })
      // The auto-General is already active. Add two more.
      const t1 = createEffort(db, { project_id: projectId, name: 'T1', kind: 'task' })
      const t2 = createEffort(db, { project_id: projectId, name: 'T2', kind: 'task' })

      updateEffort(db, t1.id, { status: 'done' })
      updateEffort(db, t2.id, { status: 'archived' })

      const active = listEffortsByProject(db, projectId, { status: 'active' })
      expect(active.length).toBe(1) // just the auto-General

      const done = listEffortsByProject(db, projectId, { status: 'done' })
      expect(done.map(e => e.id)).toEqual([t1.id])

      const archived = listEffortsByProject(db, projectId, { archived: true })
      expect(archived.map(e => e.id)).toEqual([t2.id])

      const nonArchived = listEffortsByProject(db, projectId, { archived: false })
      expect(nonArchived.map(e => e.id).sort()).toEqual([t1.id].concat(
        listEffortsByProject(db, projectId).filter(e => e.kind === 'general').map(e => e.id),
      ).sort())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
