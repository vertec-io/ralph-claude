// Typed CRUD for `prd_specs` and the `conversation_prds` join.
//
// A prd_spec is one row per discovered `<project-root>/tasks/<slug>/prd.json`.
// The discovery service (see ./tasksScan) upserts on first project-open and on
// FS changes. `slug` is the directory name and is unique within a project.
//
// `conversation_prds` is the M:N join — a single conversation can be
// associated with multiple PRDs (e.g. /ralph-runner steering several PRDs from
// one Claude session). `setSessionPrds` provides replace-set semantics so
// callers can express "this session owns exactly these PRDs" in one call.

import type { Database } from 'bun:sqlite'

export interface PrdSpec {
  id: string
  project_id: string
  slug: string
  prd_path: string
  prd_json: string | null
  mtime: number | null
  created_at: number
}

interface PrdSpecRow {
  id: string
  project_id: string
  slug: string
  prd_path: string
  prd_json: string | null
  mtime: number | null
  created_at: number
}

function rowToPrdSpec(row: PrdSpecRow): PrdSpec {
  return {
    id: row.id,
    project_id: row.project_id,
    slug: row.slug,
    prd_path: row.prd_path,
    prd_json: row.prd_json,
    mtime: row.mtime,
    created_at: row.created_at,
  }
}

export interface UpsertPrdSpecInput {
  project_id: string
  slug: string
  prd_path: string
  prd_json?: string | null
  mtime?: number | null
}

// Upsert keyed on (project_id, slug). Returns the resulting row's id.
export function upsertPrdSpec(db: Database, input: UpsertPrdSpecInput): string {
  const existing = db
    .prepare('SELECT id FROM prd_specs WHERE project_id = ? AND slug = ?')
    .get(input.project_id, input.slug) as { id: string } | null

  if (existing) {
    db.prepare(
      `UPDATE prd_specs
         SET prd_path = ?, prd_json = ?, mtime = ?
         WHERE id = ?`,
    ).run(
      input.prd_path,
      input.prd_json ?? null,
      input.mtime ?? null,
      existing.id,
    )
    return existing.id
  }

  const id = crypto.randomUUID()
  db.prepare(
    `INSERT INTO prd_specs
       (id, project_id, slug, prd_path, prd_json, mtime, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.project_id,
    input.slug,
    input.prd_path,
    input.prd_json ?? null,
    input.mtime ?? null,
    Date.now(),
  )
  return id
}

export function getPrdSpecById(db: Database, id: string): PrdSpec | null {
  const row = db
    .prepare('SELECT * FROM prd_specs WHERE id = ?')
    .get(id) as PrdSpecRow | null
  return row ? rowToPrdSpec(row) : null
}

export function listPrdSpecsByProject(db: Database, project_id: string): PrdSpec[] {
  const rows = db
    .prepare(
      `SELECT * FROM prd_specs WHERE project_id = ?
       ORDER BY mtime DESC NULLS LAST, slug ASC`,
    )
    .all(project_id) as PrdSpecRow[]
  return rows.map(rowToPrdSpec)
}

export function listPrdSpecsBySession(db: Database, session_id: string): PrdSpec[] {
  const rows = db
    .prepare(
      `SELECT s.* FROM prd_specs s
       JOIN conversation_prds cp ON cp.prd_spec_id = s.id
       WHERE cp.session_id = ?
       ORDER BY s.slug ASC`,
    )
    .all(session_id) as PrdSpecRow[]
  return rows.map(rowToPrdSpec)
}

export function listSessionsByPrdSpec(db: Database, prd_spec_id: string): string[] {
  const rows = db
    .prepare(
      `SELECT session_id FROM conversation_prds
       WHERE prd_spec_id = ? ORDER BY created_at DESC`,
    )
    .all(prd_spec_id) as { session_id: string }[]
  return rows.map((r) => r.session_id)
}

export function hardDeletePrdSpec(db: Database, id: string): void {
  db.prepare('DELETE FROM prd_specs WHERE id = ?').run(id)
}

// Replace-set semantics: after the call, the session is associated with
// exactly the given prd_spec_ids. Inserts use INSERT OR IGNORE so duplicate
// requests are idempotent within the new set.
export function setSessionPrds(
  db: Database,
  session_id: string,
  prd_spec_ids: string[],
): void {
  const now = Date.now()
  const trx = db.transaction(() => {
    db.prepare('DELETE FROM conversation_prds WHERE session_id = ?').run(session_id)
    if (prd_spec_ids.length === 0) return
    const insert = db.prepare(
      `INSERT OR IGNORE INTO conversation_prds (session_id, prd_spec_id, created_at)
       VALUES (?, ?, ?)`,
    )
    for (const pid of prd_spec_ids) {
      insert.run(session_id, pid, now)
    }
  })
  trx()
}

export function addSessionPrd(db: Database, session_id: string, prd_spec_id: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO conversation_prds (session_id, prd_spec_id, created_at)
     VALUES (?, ?, ?)`,
  ).run(session_id, prd_spec_id, Date.now())
}

export function removeSessionPrd(db: Database, session_id: string, prd_spec_id: string): void {
  db.prepare(
    'DELETE FROM conversation_prds WHERE session_id = ? AND prd_spec_id = ?',
  ).run(session_id, prd_spec_id)
}
