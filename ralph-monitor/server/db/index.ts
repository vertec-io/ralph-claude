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

import { Database } from 'bun:sqlite'
import { mkdirSync, realpathSync } from 'node:fs'
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

// Normalize a project root_dir: realpath it (resolves symlinks, canonicalizes
// case where the FS preserves it) and strip any trailing slash. Case is NOT
// lowercased — preserving the on-disk case keeps macOS HFS+ / case-insensitive
// FSes correct, and Linux is case-sensitive so the realpath result is already
// canonical.
export function normalizeRootDir(rootDir: string): string {
  // realpathSync.native is the libc-backed realpath() — faster than the JS
  // fallback and matches platform behavior exactly.
  const real = realpathSync.native(rootDir)
  // Strip trailing slash unless this would make the path empty (root /).
  if (real.length > 1 && real.endsWith('/')) return real.slice(0, -1)
  return real
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

// Insert a project + auto-generated 'general' effort in a single transaction.
// AC10 invariant: every project has at least one effort at insertion time so
// session creation has a valid parent immediately. US-002 will move this into
// db/projects.ts; for US-001 we expose it here so the schema invariant has a
// callable surface.
export function createProjectWithGeneralEffort(
  db: Database,
  input: CreateProjectInput,
): CreateProjectResult {
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
