// Typed CRUD operations for the `sessions` table.
//
// Two acceptance-criteria-driven contracts that differ from the other modules:
//
//   1. `id` is REQUIRED on createSession and is caller-allocated. The DB layer
//      does NOT auto-generate UUIDs here — sessions.id is also used as the
//      filename of the on-disk JSONL transcript, and pre-allocation by the
//      caller is what lets the watcher discover a session before the row
//      lands in sqlite. Passing `undefined` is a programming error and we
//      throw a TypeError.
//
//   2. There is no archive / soft-delete for sessions. Sessions are
//      transcript-anchored history; they're either alive (process_pid set) or
//      terminated (process_pid NULL). The only delete path is the explicit
//      `hardDeleteSession`.
//
// Two unique-index violations can happen on insert/update:
//
//   - PRIMARY KEY collision on `id` -> `SessionIdCollisionError`.
//   - Partial unique index `idx_sessions_one_live_per_effort` on
//     `(effort_id) WHERE process_pid IS NOT NULL` -> `OneLiveSessionPerEffortError`.
//
// Both surface as `SQLiteError.code === 'SQLITE_CONSTRAINT_UNIQUE'` from
// bun:sqlite, so we differentiate on the message text. The sqlite error
// messages are stable: PRIMARY KEY violations include "sessions.id" and
// partial-index violations include the index name.

import { SQLiteError, type Database } from 'bun:sqlite'

export type SessionMode = 'interactive' | 'autonomous'

export interface Session {
  id: string
  effort_id: string
  working_dir: string | null
  jsonl_path: string
  title: string | null
  mode: SessionMode
  process_pid: number | null
  process_started_at: number | null
  last_activity_at: number | null
  created_at: number
}

interface SessionRow {
  id: string
  effort_id: string
  working_dir: string | null
  jsonl_path: string
  title: string | null
  mode: SessionMode
  process_pid: number | null
  process_started_at: number | null
  last_activity_at: number | null
  created_at: number
}

function rowToSession(row: SessionRow): Session {
  return { ...row }
}

// Typed errors. Both extend Error and set a discriminating `name`. Callers
// can use `instanceof` (cross-module if they import the class) or
// `err.name === 'OneLiveSessionPerEffortError'` (string compare, no import).
export class SessionIdCollisionError extends Error {
  override readonly name = 'SessionIdCollisionError'
  constructor(message = 'a session with this id already exists') {
    super(message)
  }
}

export class OneLiveSessionPerEffortError extends Error {
  override readonly name = 'OneLiveSessionPerEffortError'
  constructor(message = 'another live session already exists for this effort') {
    super(message)
  }
}

// Translate a SQLiteError UNIQUE constraint violation into one of our typed
// errors based on which column/index the message names. Returns `null` if
// this isn't a recognized unique-violation; the caller should rethrow.
//
// bun:sqlite (libsqlite3) formats a partial-unique-index violation using the
// indexed column rather than the index name — e.g.
// "UNIQUE constraint failed: sessions.effort_id" — so we differentiate on
// "sessions.id" (PRIMARY KEY) vs "sessions.effort_id" (one-live-per-effort
// partial index). The index name is also accepted as a fallback in case a
// future sqlite formats it that way.
function classifyUniqueError(err: unknown): Error | null {
  if (!(err instanceof SQLiteError)) return null
  if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE' && err.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    return null
  }
  const msg = err.message
  if (msg.includes('idx_sessions_one_live_per_effort') || msg.includes('sessions.effort_id')) {
    return new OneLiveSessionPerEffortError()
  }
  if (msg.includes('sessions.id')) {
    return new SessionIdCollisionError()
  }
  return null
}

export interface CreateSessionInput {
  // REQUIRED. Caller-allocated UUID — the DB layer never generates this.
  id: string
  effort_id: string
  mode: SessionMode
  jsonl_path: string
  working_dir?: string | null
  title?: string | null
  process_pid?: number | null
  process_started_at?: number | null
}

export function createSession(db: Database, input: CreateSessionInput): Session {
  // Defensive runtime guard. TypeScript marks `id` required, but a JS caller
  // (or a caller assembling input dynamically) can still send undefined; we'd
  // rather throw a clear error here than let sqlite bind NULL and produce an
  // opaque NOT NULL violation downstream.
  if (input.id === undefined || input.id === null || input.id === '') {
    throw new TypeError('createSession requires a caller-allocated id')
  }
  const now = Date.now()

  const stmt = db.prepare(
    `INSERT INTO sessions
       (id, effort_id, working_dir, jsonl_path, title, mode, process_pid, process_started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  try {
    stmt.run(
      input.id,
      input.effort_id,
      input.working_dir ?? null,
      input.jsonl_path,
      input.title ?? null,
      input.mode,
      input.process_pid ?? null,
      input.process_started_at ?? null,
      now,
    )
  } catch (err) {
    const typed = classifyUniqueError(err)
    if (typed) throw typed
    throw err
  }

  return {
    id: input.id,
    effort_id: input.effort_id,
    working_dir: input.working_dir ?? null,
    jsonl_path: input.jsonl_path,
    title: input.title ?? null,
    mode: input.mode,
    process_pid: input.process_pid ?? null,
    process_started_at: input.process_started_at ?? null,
    last_activity_at: null,
    created_at: now,
  }
}

export function getSessionById(db: Database, id: string): Session | null {
  const row = db
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(id) as SessionRow | null
  return row ? rowToSession(row) : null
}

// Most-recently-active first. NULLS LAST keeps never-active sessions out of
// the way; secondary sort on `created_at DESC` keeps insertion order stable
// within a no-activity bucket.
export function listSessionsByEffort(db: Database, effort_id: string): Session[] {
  const rows = db
    .prepare(
      `SELECT * FROM sessions WHERE effort_id = ?
       ORDER BY last_activity_at DESC NULLS LAST, created_at DESC`,
    )
    .all(effort_id) as SessionRow[]
  return rows.map(rowToSession)
}

export interface UpdateSessionPatch {
  title?: string | null
  working_dir?: string | null
  process_pid?: number | null
  process_started_at?: number | null
  last_activity_at?: number | null
}

// Typed partial. Setting `process_pid` to a different non-null value while
// another live session exists for the same effort trips the partial unique
// index — surfaced as `OneLiveSessionPerEffortError` so callers can distinguish
// a contention error from any other failure.
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
