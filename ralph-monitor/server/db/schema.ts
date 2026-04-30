// Sqlite schema for ralph-monitor's session-aware persistence layer.
//
// Migrations are applied in order by `runMigrations` in ./migrate.ts. Each entry
// must be idempotent across runs in the sense that the migration runner reads
// PRAGMA user_version and only applies versions strictly greater than it.
//
// Adding a new migration:
//   1. Append a new entry with the next integer version.
//   2. Do NOT edit prior migrations once they have shipped — the runner relies
//      on user_version monotonicity, and altering history would silently skip
//      databases that already advanced past the prior version.

export interface Migration {
  version: number
  sql: string
}

// Migration 1: initial schema — projects, efforts, sessions + indexes.
//
// Design notes:
//   - All FKs are NOT NULL and ON DELETE CASCADE (see AC: "no nullable FK columns").
//   - sessions.working_dir IS nullable; spawn-time resolution falls back to
//     effort.working_dir, then project.root_dir.
//   - The kind='prd' CHECK enforces a non-empty prd_path on PRD-kind efforts;
//     length() > 0 rejects empty strings as well as NULL.
//   - The partial unique index `idx_sessions_one_live_per_effort` is what
//     enforces "at most one live session per effort" — process_pid IS NULL
//     rows (terminated sessions) are exempt and accumulate freely as history.
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

CREATE TABLE efforts (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('prd','task','general')),
  prd_path     TEXT,
  working_dir  TEXT,
  status       TEXT NOT NULL CHECK (status IN ('active','done','archived')) DEFAULT 'active',
  created_at   INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (kind != 'prd' OR (prd_path IS NOT NULL AND length(prd_path) > 0))
);

CREATE TABLE sessions (
  id                  TEXT PRIMARY KEY,
  effort_id           TEXT NOT NULL REFERENCES efforts(id) ON DELETE CASCADE,
  working_dir         TEXT,
  jsonl_path          TEXT NOT NULL,
  title               TEXT,
  mode                TEXT NOT NULL CHECK (mode IN ('interactive','autonomous')),
  process_pid         INTEGER,
  process_started_at  INTEGER,
  last_activity_at    INTEGER,
  created_at          INTEGER NOT NULL
);

CREATE INDEX idx_projects_archived       ON projects(archived);
CREATE INDEX idx_efforts_project         ON efforts(project_id);
CREATE INDEX idx_efforts_status          ON efforts(status);
CREATE INDEX idx_sessions_effort         ON sessions(effort_id);
CREATE INDEX idx_sessions_last_activity  ON sessions(last_activity_at);
CREATE INDEX idx_sessions_live           ON sessions(process_pid)
  WHERE process_pid IS NOT NULL;
CREATE UNIQUE INDEX idx_sessions_one_live_per_effort ON sessions(effort_id)
  WHERE process_pid IS NOT NULL;
`

// Migration 2: add archived column to sessions + index.
//
// Uses ALTER TABLE so existing data (sessions already in the DB) receives the
// new column with its DEFAULT value (0 = not archived). SQLite evaluates
// ALTER TABLE ... ADD COLUMN only when user_version < 2, so running the
// migration runner a second time is a safe no-op.
const MIGRATION_2 = `
ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(archived);
`

export const MIGRATIONS: Migration[] = [
  { version: 1, sql: MIGRATION_1 },
  { version: 2, sql: MIGRATION_2 },
]
