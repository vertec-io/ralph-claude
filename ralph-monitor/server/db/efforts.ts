// Typed CRUD operations for the `efforts` table.
//
// Soft delete: `status = 'archived'`. The convenience wrappers
// `archiveEffort` / `unarchiveEffort` flip the status field.
//
// The schema CHECK constraint forbids `kind = 'prd'` with a NULL or empty
// `prd_path`. Both `createEffort` and `updateEffort` may surface that as a
// `EffortPrdPathRequiredError` so callers can distinguish a contract violation
// from any other sqlite error.

import { SQLiteError, type Database } from 'bun:sqlite'

export type EffortKind = 'prd' | 'task' | 'general'
export type EffortStatus = 'active' | 'done' | 'archived'

export interface Effort {
  id: string
  project_id: string
  name: string
  kind: EffortKind
  prd_path: string | null
  working_dir: string | null
  status: EffortStatus
  created_at: number
  completed_at: number | null
}

interface EffortRow {
  id: string
  project_id: string
  name: string
  kind: EffortKind
  prd_path: string | null
  working_dir: string | null
  status: EffortStatus
  created_at: number
  completed_at: number | null
}

function rowToEffort(row: EffortRow): Effort {
  // No INTEGER->boolean coercion needed for efforts — every column here is
  // already in its final shape. We keep the row mapper for symmetry with the
  // other modules, so callers always import `Effort`, never `EffortRow`.
  return { ...row }
}

// Typed error: surfaced when the kind='prd' CHECK constraint trips. Discriminated
// via `name` so consumers can use either instanceof or string compare.
export class EffortPrdPathRequiredError extends Error {
  override readonly name = 'EffortPrdPathRequiredError'
  constructor(message = "kind='prd' efforts require a non-empty prd_path") {
    super(message)
  }
}

// Heuristic for surfacing the CHECK constraint violation as our typed error.
// bun:sqlite's SQLiteError.code on a CHECK violation is SQLITE_CONSTRAINT_CHECK
// — but the only CHECK relevant to efforts mutations (after the kind/status
// IN-list checks, which we shouldn't be tripping with our typed inputs) is the
// kind='prd' prd_path constraint, so this is unambiguous.
function isPrdPathCheckError(err: unknown): boolean {
  if (!(err instanceof SQLiteError)) return false
  return err.code === 'SQLITE_CONSTRAINT_CHECK'
}

export interface CreateEffortInput {
  id?: string
  project_id: string
  name: string
  kind: EffortKind
  prd_path?: string | null
  working_dir?: string | null
  status?: EffortStatus
}

export function createEffort(db: Database, input: CreateEffortInput): Effort {
  const id = input.id ?? crypto.randomUUID()
  const status: EffortStatus = input.status ?? 'active'
  const now = Date.now()

  const stmt = db.prepare(
    `INSERT INTO efforts (id, project_id, name, kind, prd_path, working_dir, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  try {
    stmt.run(
      id,
      input.project_id,
      input.name,
      input.kind,
      input.prd_path ?? null,
      input.working_dir ?? null,
      status,
      now,
    )
  } catch (err) {
    if (isPrdPathCheckError(err)) throw new EffortPrdPathRequiredError()
    throw err
  }

  return {
    id,
    project_id: input.project_id,
    name: input.name,
    kind: input.kind,
    prd_path: input.prd_path ?? null,
    working_dir: input.working_dir ?? null,
    status,
    created_at: now,
    completed_at: null,
  }
}

export function getEffortById(db: Database, id: string): Effort | null {
  const row = db
    .prepare('SELECT * FROM efforts WHERE id = ?')
    .get(id) as EffortRow | null
  return row ? rowToEffort(row) : null
}

export interface ListEffortsFilter {
  status?: EffortStatus
  // Shorthand: `true` keeps only `status = 'archived'`, `false` keeps only
  // `status != 'archived'`. Omitting both `archived` and `status` returns all.
  // If both are provided, `status` wins (more specific).
  archived?: boolean
}

export function listEffortsByProject(
  db: Database,
  project_id: string,
  filter: ListEffortsFilter = {},
): Effort[] {
  const where: string[] = ['project_id = ?']
  const params: (string)[] = [project_id]

  if (filter.status !== undefined) {
    where.push('status = ?')
    params.push(filter.status)
  } else if (filter.archived !== undefined) {
    if (filter.archived) {
      where.push("status = 'archived'")
    } else {
      where.push("status != 'archived'")
    }
  }

  const sql = `SELECT * FROM efforts WHERE ${where.join(' AND ')}
               ORDER BY created_at DESC`
  const rows = db.prepare(sql).all(...params) as EffortRow[]
  return rows.map(rowToEffort)
}

export interface UpdateEffortPatch {
  name?: string
  status?: EffortStatus
  prd_path?: string | null
  working_dir?: string | null
  completed_at?: number | null
}

export function updateEffort(db: Database, id: string, patch: UpdateEffortPatch): void {
  const sets: string[] = []
  const params: (string | number | null)[] = []

  if ('name' in patch && patch.name !== undefined) {
    sets.push('name = ?')
    params.push(patch.name)
  }
  if ('status' in patch && patch.status !== undefined) {
    sets.push('status = ?')
    params.push(patch.status)
  }
  if ('prd_path' in patch) {
    sets.push('prd_path = ?')
    params.push(patch.prd_path ?? null)
  }
  if ('working_dir' in patch) {
    sets.push('working_dir = ?')
    params.push(patch.working_dir ?? null)
  }
  if ('completed_at' in patch) {
    sets.push('completed_at = ?')
    params.push(patch.completed_at ?? null)
  }

  if (sets.length === 0) return

  params.push(id)
  try {
    db.prepare(`UPDATE efforts SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  } catch (err) {
    // The kind='prd' CHECK constraint can fire on UPDATE too — e.g. clearing
    // prd_path on a prd-kind effort. Surface as the typed error so callers
    // get a stable contract.
    if (isPrdPathCheckError(err)) throw new EffortPrdPathRequiredError()
    throw err
  }
}

export function archiveEffort(db: Database, id: string): void {
  updateEffort(db, id, { status: 'archived' })
}

// Unarchive flips back to 'active'. We can't recover the prior status without
// bookkeeping that doesn't exist in the schema — 'active' is the sensible
// default and matches how new efforts come into existence.
export function unarchiveEffort(db: Database, id: string): void {
  updateEffort(db, id, { status: 'active' })
}

// Hard delete — cascades to sessions per FK.
export function hardDeleteEffort(db: Database, id: string): void {
  db.prepare('DELETE FROM efforts WHERE id = ?').run(id)
}

// All efforts across all projects, newest first. Used by the lifecycle
// snapshot emitted on /events SSE connect; clients reconcile the full effort
// list against per-project event streams.
export function listAllEfforts(db: Database): Effort[] {
  const rows = db
    .prepare('SELECT * FROM efforts ORDER BY created_at DESC')
    .all() as EffortRow[]
  return rows.map(rowToEffort)
}
