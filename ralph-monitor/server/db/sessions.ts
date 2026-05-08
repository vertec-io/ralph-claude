// Typed CRUD for the `sessions` table.
//
// Sessions belong directly to a project (no effort tier). A session points at
// a JSONL transcript on disk; `id` doubles as the JSONL filename, so it is
// caller-allocated. Two sources populate this table:
//
//   1. Conversations spawned by ralph-monitor — the row is inserted at spawn
//      time with a generated UUID.
//   2. Conversations discovered on disk under ~/.claude/projects/<encoded>/ —
//      the row is upserted by the discovery service using the JSONL filename
//      (claude-code's session uuid) as `id`.
//
// `(project_id, jsonl_path)` is unique so the same JSONL is never tracked
// twice. `pinned` is per-project (sidebar pinning).

import { SQLiteError, type Database } from 'bun:sqlite'

export type SessionMode = 'interactive' | 'autonomous'

export interface Session {
  id: string
  project_id: string
  working_dir: string | null
  jsonl_path: string
  title: string | null
  mode: SessionMode
  process_pid: number | null
  process_started_at: number | null
  last_activity_at: number | null
  created_at: number
  archived: boolean
  pinned: boolean
}

interface SessionRow {
  id: string
  project_id: string
  working_dir: string | null
  jsonl_path: string
  title: string | null
  mode: SessionMode
  process_pid: number | null
  process_started_at: number | null
  last_activity_at: number | null
  created_at: number
  archived: number
  pinned: number
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    project_id: row.project_id,
    working_dir: row.working_dir,
    jsonl_path: row.jsonl_path,
    title: row.title,
    mode: row.mode,
    process_pid: row.process_pid,
    process_started_at: row.process_started_at,
    last_activity_at: row.last_activity_at,
    created_at: row.created_at,
    archived: !!row.archived,
    pinned: !!row.pinned,
  }
}

export class SessionIdCollisionError extends Error {
  override readonly name = 'SessionIdCollisionError'
  constructor(message = 'a session with this id already exists') {
    super(message)
  }
}

export class JsonlPathCollisionError extends Error {
  override readonly name = 'JsonlPathCollisionError'
  constructor(message = 'a session with this jsonl_path already exists') {
    super(message)
  }
}

function classifyUniqueError(err: unknown): Error | null {
  if (!(err instanceof SQLiteError)) return null
  if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE' && err.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    return null
  }
  const msg = err.message
  if (msg.includes('idx_sessions_jsonl') || msg.includes('sessions.jsonl_path')) {
    return new JsonlPathCollisionError()
  }
  if (msg.includes('sessions.id')) {
    return new SessionIdCollisionError()
  }
  return null
}

export interface CreateSessionInput {
  id: string
  project_id: string
  mode: SessionMode
  jsonl_path: string
  working_dir?: string | null
  title?: string | null
  process_pid?: number | null
  process_started_at?: number | null
  last_activity_at?: number | null
  created_at?: number
}

export function createSession(db: Database, input: CreateSessionInput): Session {
  if (input.id === undefined || input.id === null || input.id === '') {
    throw new TypeError('createSession requires a caller-allocated id')
  }
  const created_at = input.created_at ?? Date.now()

  const stmt = db.prepare(
    `INSERT INTO sessions
       (id, project_id, working_dir, jsonl_path, title, mode,
        process_pid, process_started_at, last_activity_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  try {
    stmt.run(
      input.id,
      input.project_id,
      input.working_dir ?? null,
      input.jsonl_path,
      input.title ?? null,
      input.mode,
      input.process_pid ?? null,
      input.process_started_at ?? null,
      input.last_activity_at ?? null,
      created_at,
    )
  } catch (err) {
    const typed = classifyUniqueError(err)
    if (typed) throw typed
    throw err
  }

  return {
    id: input.id,
    project_id: input.project_id,
    working_dir: input.working_dir ?? null,
    jsonl_path: input.jsonl_path,
    title: input.title ?? null,
    mode: input.mode,
    process_pid: input.process_pid ?? null,
    process_started_at: input.process_started_at ?? null,
    last_activity_at: input.last_activity_at ?? null,
    created_at,
    archived: false,
    pinned: false,
  }
}

export function getSessionById(db: Database, id: string): Session | null {
  const row = db
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(id) as SessionRow | null
  return row ? rowToSession(row) : null
}

export function getSessionByJsonlPath(db: Database, jsonlPath: string): Session | null {
  const row = db
    .prepare('SELECT * FROM sessions WHERE jsonl_path = ?')
    .get(jsonlPath) as SessionRow | null
  return row ? rowToSession(row) : null
}

export interface ListSessionsFilter {
  includeArchived?: boolean
  pinnedOnly?: boolean
  limit?: number
}

export function listSessionsByProject(
  db: Database,
  project_id: string,
  filter: ListSessionsFilter = {},
): Session[] {
  const where: string[] = ['project_id = ?']
  const params: (string | number)[] = [project_id]
  if (!filter.includeArchived) where.push('archived = 0')
  if (filter.pinnedOnly) where.push('pinned = 1')
  let sql = `SELECT * FROM sessions WHERE ${where.join(' AND ')}
             ORDER BY pinned DESC, last_activity_at DESC NULLS LAST, created_at DESC`
  if (filter.limit && filter.limit > 0) {
    sql += ' LIMIT ?'
    params.push(filter.limit)
  }
  const rows = db.prepare(sql).all(...params) as SessionRow[]
  return rows.map(rowToSession)
}

// All sessions whose `process_pid` is non-null. Used by the startup reconciler
// to enumerate rows that claim to track a live process.
export function listSessionsWithPid(db: Database): Session[] {
  const rows = db
    .prepare(
      'SELECT * FROM sessions WHERE process_pid IS NOT NULL ORDER BY created_at DESC',
    )
    .all() as SessionRow[]
  return rows.map(rowToSession)
}

export interface UpdateSessionPatch {
  title?: string | null
  working_dir?: string | null
  process_pid?: number | null
  process_started_at?: number | null
  last_activity_at?: number | null
  archived?: boolean
  pinned?: boolean
}

export function updateSession(db: Database, id: string, patch: UpdateSessionPatch): void {
  const sets: string[] = []
  const params: (string | number | null)[] = []

  if ('title' in patch) {
    sets.push('title = ?')
    params.push(patch.title ?? null)
  }
  if ('working_dir' in patch) {
    sets.push('working_dir = ?')
    params.push(patch.working_dir ?? null)
  }
  if ('process_pid' in patch) {
    sets.push('process_pid = ?')
    params.push(patch.process_pid ?? null)
  }
  if ('process_started_at' in patch) {
    sets.push('process_started_at = ?')
    params.push(patch.process_started_at ?? null)
  }
  if ('last_activity_at' in patch) {
    sets.push('last_activity_at = ?')
    params.push(patch.last_activity_at ?? null)
  }
  if ('archived' in patch && patch.archived !== undefined) {
    sets.push('archived = ?')
    params.push(patch.archived ? 1 : 0)
  }
  if ('pinned' in patch && patch.pinned !== undefined) {
    sets.push('pinned = ?')
    params.push(patch.pinned ? 1 : 0)
  }

  if (sets.length === 0) return

  params.push(id)
  try {
    db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  } catch (err) {
    const typed = classifyUniqueError(err)
    if (typed) throw typed
    throw err
  }
}

export function hardDeleteSession(db: Database, id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
}
