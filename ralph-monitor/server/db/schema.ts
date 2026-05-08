// Sqlite schema for ralph-monitor.
//
// New world (post-redesign): no efforts tier. Projects map directly to
// directories on disk; sessions belong to a project, not an effort. PRDs are a
// first-class entity discovered from `<root>/tasks/*/prd.json` and joined to
// sessions via `conversation_prds` (M:N — a single conversation can drive
// multiple PRDs, e.g. /ralph-runner).
//
// Migrations are applied in order by `runMigrations` in ./migrate.ts. The
// runner reads PRAGMA user_version and applies versions strictly greater than
// it. Adding a new migration:
//   1. Append a new entry with the next integer version.
//   2. Do NOT edit prior migrations once they have shipped.

export interface Migration {
  version: number
  sql: string
}

// Migration 1: clean-room schema.
//
//   projects          — directory-anchored, no kind/effort tier.
//   sessions          — claude conversations. Owned directly by a project.
//                       `pinned` is per-project (a session is pinned within
//                       its owning project's sidebar).
//   prd_specs         — discovered PRDs under <root>/tasks/<slug>/prd.json.
//                       `slug` is the directory name.
//   conversation_prds — M:N join. A session can be associated with 0..N PRDs.
//
// All FKs are NOT NULL ON DELETE CASCADE so a project drop cleans up its
// sessions, prd_specs, and the join rows referencing them.
const MIGRATION_1 = `
CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  root_dir        TEXT NOT NULL UNIQUE,
  created_at      INTEGER NOT NULL,
  last_opened_at  INTEGER,
  archived        INTEGER NOT NULL DEFAULT 0,
  pinned          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  working_dir         TEXT,
  jsonl_path          TEXT NOT NULL,
  title               TEXT,
  mode                TEXT NOT NULL CHECK (mode IN ('interactive','autonomous')),
  process_pid         INTEGER,
  process_started_at  INTEGER,
  last_activity_at    INTEGER,
  created_at          INTEGER NOT NULL,
  archived            INTEGER NOT NULL DEFAULT 0,
  pinned              INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE prd_specs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug         TEXT NOT NULL,
  prd_path     TEXT NOT NULL,
  prd_json     TEXT,
  mtime        INTEGER,
  created_at   INTEGER NOT NULL,
  UNIQUE (project_id, slug)
);

CREATE TABLE conversation_prds (
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prd_spec_id  TEXT NOT NULL REFERENCES prd_specs(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, prd_spec_id)
);

CREATE INDEX idx_projects_archived       ON projects(archived);
CREATE INDEX idx_sessions_project        ON sessions(project_id);
CREATE INDEX idx_sessions_last_activity  ON sessions(last_activity_at);
CREATE INDEX idx_sessions_archived       ON sessions(archived);
CREATE INDEX idx_sessions_pinned         ON sessions(pinned);
CREATE INDEX idx_sessions_live           ON sessions(process_pid)
  WHERE process_pid IS NOT NULL;
CREATE UNIQUE INDEX idx_sessions_jsonl   ON sessions(jsonl_path);
CREATE INDEX idx_prd_specs_project       ON prd_specs(project_id);
CREATE INDEX idx_conv_prds_prd           ON conversation_prds(prd_spec_id);
`

export const MIGRATIONS: Migration[] = [
  { version: 1, sql: MIGRATION_1 },
]
