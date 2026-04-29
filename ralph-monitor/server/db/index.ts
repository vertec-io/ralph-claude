// DB singleton + path resolution for ralph-monitor.
//
// Path resolution:
//   $RALPH_MONITOR_DB if set, else ~/.config/ralph-monitor/ralph-monitor.db
// The parent directory is created with mode 0o700 if missing.
//
// Every connection enables `PRAGMA foreign_keys = ON` (sqlite default is OFF
// per-connection, so this matters even though we only open once).
//
// Migrations run lazily on first getDb() call.
//
// Per-table CRUD lives in ./projects.ts, ./efforts.ts, ./sessions.ts. We
// re-export the row types and the helpers that callers reach for most often
// so `import { ... } from './db'` keeps working as a one-stop entry point.

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { runMigrations } from './migrate'

let _db: Database | null = null

export function resolveDbPath(): string {
  const fromEnv = process.env.RALPH_MONITOR_DB
  if (fromEnv && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.config', 'ralph-monitor', 'ralph-monitor.db')
}

export function getDb(): Database {
  if (_db) return _db
  const dbPath = resolveDbPath()
  const parent = dirname(dbPath)
  // mode 0o700 — owner-only. mkdirSync with recursive:true won't throw if it
  // exists. The mode arg only applies to dirs that get created.
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const db = new Database(dbPath, { create: true })
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db)
  _db = db
  return db
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}

// Re-exports from the per-table modules so consumers can import everything
// they need from `./db`. The modules themselves remain the source of truth —
// nothing here re-implements behavior.
export {
  createProject,
  getProjectById,
  getProjectByRootDir,
  listProjects,
  updateProject,
  archiveProject,
  unarchiveProject,
  hardDeleteProject,
  normalizeRootDir,
} from './projects'
export type {
  Project,
  CreateProjectInput,
  CreateProjectResult,
  ListProjectsFilter,
  UpdateProjectPatch,
} from './projects'

export {
  createEffort,
  getEffortById,
  listEffortsByProject,
  updateEffort,
  archiveEffort,
  unarchiveEffort,
  hardDeleteEffort,
  EffortPrdPathRequiredError,
} from './efforts'
export type {
  Effort,
  EffortKind,
  EffortStatus,
  CreateEffortInput,
  ListEffortsFilter,
  UpdateEffortPatch,
} from './efforts'

export {
  createSession,
  getSessionById,
  listSessionsByEffort,
  updateSession,
  hardDeleteSession,
  SessionIdCollisionError,
  OneLiveSessionPerEffortError,
} from './sessions'
export type {
  Session,
  SessionMode,
  CreateSessionInput,
  UpdateSessionPatch,
} from './sessions'
