// Disk discovery + ./tasks scan for projects.
//
// Runs at three points:
//   1. On project create (background, non-blocking — see routes/projects.ts).
//   2. On server boot for every existing project (best-effort).
//   3. On manual rescan trigger via POST /api/projects/:id/scan.
//
// And per-project chokidar watchers keep both surfaces live afterwards.
//
// What gets discovered:
//
//   Sessions:  ~/.claude/projects/<encoded(project.root_dir)>/*.jsonl  AND
//              ~/.claude/projects/<encoded(worktree.path)>/*.jsonl for every
//              worktree of the project's root.
//              JSONL filename (uuid) becomes the session row's id.
//
//   PRDs:      <project.root_dir>/tasks/*/prd.json
//              Slug = the directory name. The full prd.json is stored as text
//              in the prd_json column for snapshot rendering.

import { readdir, stat, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { watch as chokidarWatch, type FSWatcher } from 'chokidar'

import {
  getDb,
  getSessionByJsonlPath,
  createSession,
  updateSession,
  hardDeleteSession,
  listSessionsByProject,
  upsertPrdSpec,
  hardDeletePrdSpec,
  listPrdSpecsByProject,
  type Project,
  type Session,
  type PrdSpec,
} from './db'
import { encodeClaudeProjectDir } from './jsonl/paths'
import { store } from './store'

// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------

export interface DiscoverSessionsResult {
  scanned_dirs: string[]
  upserted: number
  pruned: number
  errors: string[]
}

async function peekJsonlTitle(jsonlPath: string): Promise<string | null> {
  try {
    const text = await Bun.file(jsonlPath).text()
    const lines = text.split('\n')
    let count = 0
    let summary: string | null = null
    let firstUser: string | null = null
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue
      if (count >= 50) break
      count++
      let rec: unknown
      try { rec = JSON.parse(line) } catch { continue }
      if (typeof rec !== 'object' || rec === null) continue
      const r = rec as Record<string, unknown>
      if (r.type === 'summary' && typeof r.summary === 'string' && !summary) {
        summary = r.summary
      }
      if (r.type === 'user' && !firstUser) {
        const msg = r.message as Record<string, unknown> | undefined
        if (msg && Array.isArray(msg.content)) {
          for (const item of msg.content as unknown[]) {
            if (
              typeof item === 'object' &&
              item !== null &&
              (item as Record<string, unknown>).type === 'text' &&
              typeof (item as Record<string, unknown>).text === 'string'
            ) {
              const txt = ((item as Record<string, unknown>).text as string).slice(0, 120)
              firstUser = txt || null
              break
            }
          }
        }
      }
      if (summary && firstUser) break
    }
    return summary ?? firstUser
  } catch {
    return null
  }
}

// A project's conversation scope is exactly its root_dir. Git worktrees of the
// same repo are NOT auto-included — open them as separate projects if you want
// their conversations. Otherwise opening a worktree pulls in every sibling
// worktree's conversations (one early dogfooding session showed 750+
// conversations when opening a single worktree of a large monorepo).
function projectScanDirs(project: Project): string[] {
  return [project.root_dir]
}

function claudeProjectsDirFor(dir: string): string {
  return join(homedir(), '.claude', 'projects', encodeClaudeProjectDir(dir))
}

async function listJsonlsIn(claudeDir: string): Promise<string[]> {
  try {
    const files = await readdir(claudeDir)
    return files.filter((f) => f.endsWith('.jsonl')).map((f) => join(claudeDir, f))
  } catch {
    return []
  }
}

async function upsertSessionFromJsonl(
  project: Project,
  jsonlPath: string,
  cwd: string,
): Promise<{ created: boolean; updated: boolean } | null> {
  const db = getDb()
  let st: Awaited<ReturnType<typeof stat>>
  try {
    st = await stat(jsonlPath)
  } catch {
    return null
  }
  const id = basename(jsonlPath, '.jsonl')
  const existing = getSessionByJsonlPath(db, jsonlPath)
  const title = await peekJsonlTitle(jsonlPath)

  if (existing) {
    const newLastActivity = Math.max(existing.last_activity_at ?? 0, st.mtimeMs)
    if (newLastActivity !== existing.last_activity_at) {
      updateSession(db, existing.id, { last_activity_at: newLastActivity })
      const refreshed = { ...existing, last_activity_at: newLastActivity }
      store.recordEvent({ type: 'session.updated', ts: Date.now(), session: refreshed })
    }
    return { created: false, updated: newLastActivity !== existing.last_activity_at }
  }

  let session: Session
  try {
    session = createSession(db, {
      id,
      project_id: project.id,
      mode: 'interactive',
      jsonl_path: jsonlPath,
      working_dir: cwd === project.root_dir ? null : cwd,
      title,
      process_pid: null,
      process_started_at: null,
      last_activity_at: st.mtimeMs,
      created_at: st.birthtimeMs || st.ctimeMs || Date.now(),
    })
  } catch (err) {
    if ((err as Error)?.name === 'SessionIdCollisionError') return null
    if ((err as Error)?.name === 'JsonlPathCollisionError') return null
    throw err
  }
  store.recordEvent({ type: 'session.created', ts: Date.now(), session })
  return { created: true, updated: false }
}

export async function discoverProjectSessions(
  project: Project,
): Promise<DiscoverSessionsResult> {
  const result: DiscoverSessionsResult = { scanned_dirs: [], upserted: 0, pruned: 0, errors: [] }
  const dirs = projectScanDirs(project)
  const claudeDirs: string[] = []
  for (const dir of dirs) {
    const claudeDir = claudeProjectsDirFor(dir)
    claudeDirs.push(claudeDir)
    result.scanned_dirs.push(claudeDir)
    const jsonls = await listJsonlsIn(claudeDir)
    for (const j of jsonls) {
      try {
        const r = await upsertSessionFromJsonl(project, j, dir)
        if (r?.created) result.upserted++
      } catch (err) {
        result.errors.push(`${j}: ${(err as Error).message}`)
      }
    }
  }

  // Prune sessions whose jsonl_path is no longer in this project's scope.
  // Catches two cases: (1) historical data from when worktrees were auto-
  // included; (2) JSONLs that were deleted on disk. Skip live and pinned
  // sessions to avoid surprises during cleanup.
  const db = getDb()
  const tracked = listSessionsByProject(db, project.id, { includeArchived: true })
  for (const s of tracked) {
    if (s.process_pid != null) continue
    if (s.pinned) continue
    const inScope = claudeDirs.some((d) => s.jsonl_path.startsWith(d + '/'))
    if (!inScope) {
      hardDeleteSession(db, s.id)
      result.pruned++
      store.recordEvent({ type: 'session.deleted', ts: Date.now(), id: s.id })
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// PRD ./tasks scan
// ---------------------------------------------------------------------------

export interface ScanTasksResult {
  upserted: number
  removed: number
  errors: string[]
}

async function readPrdJson(prdPath: string): Promise<{ json: string; mtime: number } | null> {
  try {
    const [text, st] = await Promise.all([
      readFile(prdPath, 'utf8'),
      stat(prdPath),
    ])
    try { JSON.parse(text) } catch { return null }
    return { json: text, mtime: st.mtimeMs }
  } catch {
    return null
  }
}

export async function scanProjectTasks(project: Project): Promise<ScanTasksResult> {
  const result: ScanTasksResult = { upserted: 0, removed: 0, errors: [] }
  const tasksDir = join(project.root_dir, 'tasks')
  if (!existsSync(tasksDir)) return result

  let entries: string[] = []
  try {
    entries = await readdir(tasksDir)
  } catch (err) {
    result.errors.push(`readdir(${tasksDir}): ${(err as Error).message}`)
    return result
  }

  const db = getDb()
  const found = new Set<string>()

  for (const entry of entries) {
    const prdPath = join(tasksDir, entry, 'prd.json')
    if (!existsSync(prdPath)) continue
    const data = await readPrdJson(prdPath)
    if (!data) continue
    found.add(entry)
    const id = upsertPrdSpec(db, {
      project_id: project.id,
      slug: entry,
      prd_path: prdPath,
      prd_json: data.json,
      mtime: data.mtime,
    })
    result.upserted++
    const ps: PrdSpec = {
      id,
      project_id: project.id,
      slug: entry,
      prd_path: prdPath,
      prd_json: data.json,
      mtime: data.mtime,
      created_at: Date.now(),
    }
    store.recordEvent({ type: 'prd_spec.updated', ts: Date.now(), prd_spec: ps })
  }

  const tracked = listPrdSpecsByProject(db, project.id)
  for (const ps of tracked) {
    if (!found.has(ps.slug)) {
      hardDeletePrdSpec(db, ps.id)
      result.removed++
      store.recordEvent({ type: 'prd_spec.deleted', ts: Date.now(), id: ps.id })
    }
  }

  return result
}

export async function rescanPrdSpec(ps: PrdSpec): Promise<PrdSpec | null> {
  const data = await readPrdJson(ps.prd_path)
  if (!data) return null
  const db = getDb()
  upsertPrdSpec(db, {
    project_id: ps.project_id,
    slug: ps.slug,
    prd_path: ps.prd_path,
    prd_json: data.json,
    mtime: data.mtime,
  })
  const updated: PrdSpec = { ...ps, prd_json: data.json, mtime: data.mtime }
  store.recordEvent({ type: 'prd_spec.updated', ts: Date.now(), prd_spec: updated })
  return updated
}

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

interface ProjectWatchers {
  jsonlWatcher: FSWatcher
  tasksWatcher: FSWatcher
}

const watchers = new Map<string, ProjectWatchers>()

function watchOptions() {
  return {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
  }
}

export function startProjectWatchers(project: Project): void {
  if (watchers.has(project.id)) return

  const dirs = projectScanDirs(project)
  const claudeDirs: string[] = dirs.map(claudeProjectsDirFor)
  const tasksDir = join(project.root_dir, 'tasks')

  const jsonlWatcher = chokidarWatch(
    claudeDirs.map((d) => join(d, '*.jsonl')),
    watchOptions(),
  )
  jsonlWatcher.on('add', (jsonlPath: string) => {
    const parent = claudeDirs.find((d) => jsonlPath.startsWith(d + '/'))
    if (!parent) return
    const idx = claudeDirs.indexOf(parent)
    const cwd = dirs[idx]!
    void upsertSessionFromJsonl(project, jsonlPath, cwd).catch((err) => {
      console.warn(`[discovery] upsert ${jsonlPath} failed:`, err)
    })
  })
  jsonlWatcher.on('change', (jsonlPath: string) => {
    const parent = claudeDirs.find((d) => jsonlPath.startsWith(d + '/'))
    if (!parent) return
    const idx = claudeDirs.indexOf(parent)
    const cwd = dirs[idx]!
    void upsertSessionFromJsonl(project, jsonlPath, cwd).catch(() => {})
  })

  const tasksWatcher = chokidarWatch(join(tasksDir, '*', 'prd.json'), watchOptions())
  const onTasksChange = () => {
    void scanProjectTasks(project).catch((err) => {
      console.warn(`[discovery] tasks scan for ${project.id} failed:`, err)
    })
  }
  tasksWatcher.on('add', onTasksChange)
  tasksWatcher.on('change', onTasksChange)
  tasksWatcher.on('unlink', onTasksChange)

  watchers.set(project.id, { jsonlWatcher, tasksWatcher })
}

export function stopProjectWatchers(project_id: string): void {
  const w = watchers.get(project_id)
  if (!w) return
  void w.jsonlWatcher.close()
  void w.tasksWatcher.close()
  watchers.delete(project_id)
}

export async function stopAllProjectWatchers(): Promise<void> {
  for (const [, w] of watchers) {
    await w.jsonlWatcher.close()
    await w.tasksWatcher.close()
  }
  watchers.clear()
}

export const __test__ = {
  watcherCount: () => watchers.size,
}
