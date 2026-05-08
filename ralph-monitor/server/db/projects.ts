// Typed CRUD for the `projects` table.
//
// A project is a pointer to a directory on disk. Creating a project is just
// "opening a directory". There is no kind, no effort tier, and no auto-created
// child rows — sessions and prd_specs are populated by discovery (see
// disk-discovery service and tasks-scan).
//
// Conventions:
//   - All write paths use prepared statements; nothing is interpolated into SQL.
//   - INTEGER 0/1 columns (`archived`, `pinned`) are mapped to booleans at the
//     row boundary so callers never see the raw 0/1.
//   - `updateProject` only emits SET clauses for keys present in the patch
//     object (`undefined` means "not provided", NOT "clear to null").

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

// Normalize a project root_dir: realpath it (resolves symlinks) and strip any
// trailing slash. Used at write time so the on-disk row is canonical.
export function normalizeRootDir(rootDir: string): string {
  const real = realpathSync.native(rootDir)
  if (real.length > 1 && real.endsWith('/')) return real.slice(0, -1)
  return real
}

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
  rootDir: string
}

export function createProject(db: Database, input: CreateProjectInput): CreateProjectResult {
  const projectId = input.id ?? crypto.randomUUID()
  const rootDir = normalizeRootDir(input.root_dir)
  const now = Date.now()

  db.prepare(
    'INSERT INTO projects (id, name, root_dir, created_at) VALUES (?, ?, ?, ?)',
  ).run(projectId, input.name, rootDir, now)

  return { projectId, rootDir }
}

export function getProjectById(db: Database, id: string): Project | null {
  const row = db
    .prepare('SELECT * FROM projects WHERE id = ?')
    .get(id) as ProjectRow | null
  return row ? rowToProject(row) : null
}

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

export function listProjects(db: Database, filter: ListProjectsFilter = {}): Project[] {
  const where: string[] = []
  const params: number[] = []
  if (filter.archived !== undefined) {
    where.push('archived = ?')
    params.push(filter.archived ? 1 : 0)
  }
  if (filter.pinned !== undefined) {
    where.push('pinned = ?')
    params.push(filter.pinned ? 1 : 0)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
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

export function hardDeleteProject(db: Database, id: string): void {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id)
}
