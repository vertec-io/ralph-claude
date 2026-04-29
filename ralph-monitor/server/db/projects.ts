// Typed CRUD operations for the `projects` table.
//
// Conventions:
//   - All write paths use prepared statements; nothing is interpolated into SQL.
//   - INTEGER 0/1 columns (`archived`, `pinned`) are mapped to booleans at the
//     row boundary via `!!row.archived` so callers never see the raw 0/1.
//   - `updateProject` only emits SET clauses for keys that are actually present
//     in the patch object (we treat `undefined` as "not provided", NOT as
//     "clear to null"). This keeps the partial-update contract unambiguous.
//   - `getProjectByRootDir` does NOT throw on a missing path — realpath is
//     wrapped so callers can pass arbitrary user-supplied input.
//
// Soft delete is implemented via the `archived` flag (acceptance criterion).
// `hardDeleteProject` is the explicit escape hatch and cascades through FKs to
// efforts + sessions.
//
// Auto-'general' effort: `createProject` mirrors the contract from US-001's
// `createProjectWithGeneralEffort` — every project gets exactly one auto-named
// 'General' effort inserted in the same transaction, so callers always have a
// valid parent for session creation.

import type { Database } from 'bun:sqlite'
import { realpathSync } from 'node:fs'

export interface Project {
  id: string
  name: string
  root_dir: string
  created_at: number
  last_opened_at: number | null
  archived: boolean
  pinned: boolean
}

// Internal row shape as returned by sqlite — INTEGER columns surface as numbers
// rather than booleans. Kept private; callers consume the parsed `Project`.
interface ProjectRow {
  id: string
  name: string
  root_dir: string
  created_at: number
  last_opened_at: number | null
  archived: number
  pinned: number
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    root_dir: row.root_dir,
    created_at: row.created_at,
    last_opened_at: row.last_opened_at,
    archived: !!row.archived,
    pinned: !!row.pinned,
  }
}

// Normalize a project root_dir: realpath it (resolves symlinks, canonicalizes
// case where the FS preserves it) and strip any trailing slash. Used at write
// time so the on-disk row is always canonical.
export function normalizeRootDir(rootDir: string): string {
  const real = realpathSync.native(rootDir)
  if (real.length > 1 && real.endsWith('/')) return real.slice(0, -1)
  return real
}

// Lookup-time normalization: same shape as `normalizeRootDir`, but tolerates a
// missing path by returning `null`. realpath() throws ENOENT for paths that
// don't exist; we trap that so callers passing user-supplied input get a clean
// "no match" rather than a crash.
function normalizeForLookup(rootDir: string): string | null {
  try {
    const real = realpathSync.native(rootDir)
    if (real.length > 1 && real.endsWith('/')) return real.slice(0, -1)
    return real
  } catch {
    return null
  }
}

export interface CreateProjectInput {
  id?: string
  name: string
  root_dir: string
}

export interface CreateProjectResult {
  projectId: string
  effortId: string
  rootDir: string
}

// Insert a project + auto-'general' effort transactionally. The schema
// invariant (every project has at least one effort at insertion time) is what
// lets the rest of the system assume there is always a valid parent for a new
// session — so this is the ONLY blessed way to create a project.
export function createProject(db: Database, input: CreateProjectInput): CreateProjectResult {
  const projectId = input.id ?? crypto.randomUUID()
  const effortId = crypto.randomUUID()
  const rootDir = normalizeRootDir(input.root_dir)
  const now = Date.now()

  const insertProject = db.prepare(
    'INSERT INTO projects (id, name, root_dir, created_at) VALUES (?, ?, ?, ?)',
  )
  const insertEffort = db.prepare(
    `INSERT INTO efforts (id, project_id, name, kind, status, created_at)
     VALUES (?, ?, 'General', 'general', 'active', ?)`,
  )

  db.transaction(() => {
    insertProject.run(projectId, input.name, rootDir, now)
    insertEffort.run(effortId, projectId, now)
  })()

  return { projectId, effortId, rootDir }
}

export function getProjectById(db: Database, id: string): Project | null {
  const row = db
    .prepare('SELECT * FROM projects WHERE id = ?')
    .get(id) as ProjectRow | null
  return row ? rowToProject(row) : null
}

// realpath the input, then exact-match `root_dir`. Returns `null` when the
// path doesn't exist on disk (callers don't need to pre-check) OR when there
// is simply no matching row.
export function getProjectByRootDir(db: Database, path: string): Project | null {
  const normalized = normalizeForLookup(path)
  if (normalized === null) return null
  const row = db
    .prepare('SELECT * FROM projects WHERE root_dir = ?')
    .get(normalized) as ProjectRow | null
  return row ? rowToProject(row) : null
}

export interface ListProjectsFilter {
  archived?: boolean
  pinned?: boolean
}

// Filter semantics: `true` keeps only matching rows, `false` keeps only
// non-matching rows, omitted means "don't filter on this column". We build the
// WHERE clause dynamically but every value goes through a parameter binding —
// the only string concatenation is the column name + comparator, which is
// drawn from a fixed set.
export function listProjects(db: Database, filter: ListProjectsFilter = {}): Project[] {
  const where: string[] = []
  const params: (number)[] = []
  if (filter.archived !== undefined) {
    where.push('archived = ?')
    params.push(filter.archived ? 1 : 0)
  }
  if (filter.pinned !== undefined) {
    where.push('pinned = ?')
    params.push(filter.pinned ? 1 : 0)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  // Pinned projects float to the top; within a pin-bucket, most-recently
  // opened first. NULLS LAST keeps never-opened projects out of the way.
  const sql = `SELECT * FROM projects ${whereSql}
               ORDER BY pinned DESC, last_opened_at DESC NULLS LAST, created_at DESC`
  const rows = db.prepare(sql).all(...params) as ProjectRow[]
  return rows.map(rowToProject)
}

export interface UpdateProjectPatch {
  name?: string
  archived?: boolean
  pinned?: boolean
  last_opened_at?: number | null
}

// Typed partial update. Only fields actually present in the patch object are
// emitted as SET clauses. `undefined` is treated as "not provided"; if a
// caller wants to clear `last_opened_at`, they pass `null` explicitly.
export function updateProject(db: Database, id: string, patch: UpdateProjectPatch): void {
  const sets: string[] = []
  const params: (string | number | null)[] = []

  if ('name' in patch && patch.name !== undefined) {
    sets.push('name = ?')
    params.push(patch.name)
  }
  if ('archived' in patch && patch.archived !== undefined) {
    sets.push('archived = ?')
    params.push(patch.archived ? 1 : 0)
  }
  if ('pinned' in patch && patch.pinned !== undefined) {
    sets.push('pinned = ?')
    params.push(patch.pinned ? 1 : 0)
  }
  if ('last_opened_at' in patch) {
    sets.push('last_opened_at = ?')
    params.push(patch.last_opened_at ?? null)
  }

  if (sets.length === 0) return

  params.push(id)
  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...params)
}

export function archiveProject(db: Database, id: string): void {
  updateProject(db, id, { archived: true })
}

export function unarchiveProject(db: Database, id: string): void {
  updateProject(db, id, { archived: false })
}

// Hard delete — cascades through FKs to efforts and sessions per schema.
// Soft delete (archived flag) is the default; this is the explicit escape
// hatch when a project must be permanently removed.
export function hardDeleteProject(db: Database, id: string): void {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id)
}
