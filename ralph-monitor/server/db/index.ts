// DB singleton + path resolution for ralph-monitor.
//
// Path resolution:
//   $RALPH_MONITOR_DB if set, else ~/.config/ralph-monitor/ralph-monitor.db
// The parent directory is created with mode 0o700 if missing.
//
// Every connection enables `PRAGMA foreign_keys = ON`.
// Migrations run lazily on first getDb() call.

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
  createSession,
  getSessionById,
  getSessionByJsonlPath,
  listSessionsByProject,
  listSessionsWithPid,
  updateSession,
  hardDeleteSession,
  SessionIdCollisionError,
  JsonlPathCollisionError,
} from './sessions'
export type {
  Session,
  SessionMode,
  CreateSessionInput,
  ListSessionsFilter,
  UpdateSessionPatch,
} from './sessions'

export {
  upsertPrdSpec,
  getPrdSpecById,
  listPrdSpecsByProject,
  listPrdSpecsBySession,
  listSessionsByPrdSpec,
  hardDeletePrdSpec,
  setSessionPrds,
  addSessionPrd,
  removeSessionPrd,
} from './prdSpecs'
export type {
  PrdSpec,
  UpsertPrdSpecInput,
} from './prdSpecs'
