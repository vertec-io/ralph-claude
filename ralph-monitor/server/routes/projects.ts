// REST endpoints for the `projects` table.
//
// Mounted at the app root; this file owns:
//   GET    /api/projects
//   POST   /api/projects
//   PATCH  /api/projects/:id
//   DELETE /api/projects/:id?confirm_name=<typed>
//
// Mutation endpoints emit a scoped AppEvent via store.recordEvent so that all
// SSE-connected clients see the change without needing to re-fetch.
//
// Errors are returned as JSON `{ error, details? }` with kebab-case codes; the
// HTTP status follows REST conventions (400 bad input, 404 not-found, 409
// constraint, 422 validation, 500 unexpected).

import { Hono } from 'hono'
import { SQLiteError } from 'bun:sqlite'
import { unlink, readdir, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir as nodeHomedir } from 'node:os'
import {
  getDb,
  createProject,
  getProjectById,
  getProjectByRootDir,
  listProjects,
  listEffortsByProject,
  listSessionsByEffort,
  createSession,
  getEffortById,
  updateProject,
  updateEffort,
  hardDeleteProject,
  type Project,
  type ListProjectsFilter,
} from '../db'
import { store } from '../store'
import { evictWorktreeCacheForProject, checkIsWorktreeOfProject, listWorktrees } from '../git/worktrees'
import * as registry from '../sessions/registry'
import { encodeClaudeProjectDir } from '../jsonl/paths'

// Test seam — allows unit tests to override the live-session check without
// importing the real PTY registry (which has no live handles in a test
// environment). Production path always uses the real registry.
let _liveCheckOverride: ((effortId: string) => number) | null = null

export const __test__ = {
  setLiveCheckOverride(fn: ((effortId: string) => number) | null) {
    _liveCheckOverride = fn
  },
}

function countLiveSessions(effortId: string): string[] {
  if (_liveCheckOverride !== null) {
    const count = _liveCheckOverride(effortId)
    // Return fake ids for the count
    return count > 0 ? Array.from({ length: count }, (_, i) => `fake-session-${i}`) : []
  }
  return registry.listLiveByEffort(effortId).map((h) => h.sessionId)
}

const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export const projectsRouter = new Hono()

// GET /api/projects?status=active|recent|archived&pinned=true|false
//
// `status` semantics:
//   'active'   -> not archived (any last_opened_at)
//   'archived' -> archived
//   'recent'   -> not archived AND last_opened_at within 30 days
//   missing    -> all rows
//
// `pinned` filter is independent and stacks with `status`.
projectsRouter.get('/api/projects', (c) => {
  const status = c.req.query('status')
  const pinnedRaw = c.req.query('pinned')

  const filter: ListProjectsFilter = {}
  if (pinnedRaw === 'true') filter.pinned = true
  else if (pinnedRaw === 'false') filter.pinned = false

  if (status === 'active') {
    filter.archived = false
  } else if (status === 'archived') {
    filter.archived = true
  } else if (status === 'recent') {
    filter.archived = false
  } else if (status !== undefined && status !== '') {
    return c.json({ error: 'invalid-status', details: { status } }, 400)
  }

  const db = getDb()
  let projects = listProjects(db, filter)

  if (status === 'recent') {
    const cutoff = Date.now() - RECENT_WINDOW_MS
    projects = projects.filter(
      (p) => p.last_opened_at !== null && p.last_opened_at >= cutoff,
    )
  }

  return c.json({ projects })
})

// POST /api/projects { name, root_dir }
//
// `createProject` realpath-normalizes root_dir internally; we intercept its two
// failure modes here:
//   - root_dir doesn't exist on disk -> realpath ENOENT -> 422
//   - root_dir already taken (UNIQUE) -> 409 with the existing project id
projectsRouter.post('/api/projects', async (c) => {
  let body: { name?: unknown; root_dir?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid-json' }, 400)
  }

  const name = typeof body.name === 'string' ? body.name : null
  const rootDir = typeof body.root_dir === 'string' ? body.root_dir : null
  if (!name || !rootDir) {
    return c.json(
      { error: 'invalid-input', details: { required: ['name', 'root_dir'] } },
      400,
    )
  }

  const db = getDb()
  let result: { projectId: string; effortId: string; rootDir: string }
  try {
    result = createProject(db, { name, root_dir: rootDir })
  } catch (err: unknown) {
    // realpath() throws ENOENT for non-existent paths; surface as 422.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return c.json(
        { error: 'root_dir_does_not_exist', details: { root_dir: rootDir } },
        422,
      )
    }
    // UNIQUE violation on root_dir -> 409 with existing id (best-effort lookup).
    if (err instanceof SQLiteError && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const existing = getProjectByRootDir(db, rootDir)
      return c.json(
        {
          error: 'project_root_dir_taken',
          details: { existing_id: existing?.id ?? null },
        },
        409,
      )
    }
    return c.json(
      { error: 'internal-error', details: { message: (err as Error)?.message } },
      500,
    )
  }

  const project = getProjectById(db, result.projectId)
  if (!project) {
    // Shouldn't happen — createProject just succeeded — but the type narrowing
    // demands it.
    return c.json({ error: 'project-not-found-after-insert' }, 500)
  }

  store.recordEvent({ type: 'project.created', ts: Date.now(), project })

  return c.json(project, 201)
})

// PATCH /api/projects/:id { name?, archived?, pinned? }
//
// When archived=true is requested:
//   1. Checks all efforts for live sessions — returns 409 with details if any found.
//   2. Cascades archive to all non-archived efforts for the project.
//   3. Emits effort.updated events for each cascaded effort.
//
// When archived=false (unarchive) is requested, effort statuses are NOT touched.
projectsRouter.patch('/api/projects/:id', async (c) => {
  const id = c.req.param('id')
  let body: { name?: unknown; archived?: unknown; pinned?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid-json' }, 400)
  }

  const db = getDb()
  const existing = getProjectById(db, id)
  if (!existing) {
    return c.json({ error: 'project-not-found', details: { id } }, 404)
  }

  const patch: { name?: string; archived?: boolean; pinned?: boolean } = {}
  if (typeof body.name === 'string') patch.name = body.name
  if (typeof body.archived === 'boolean') patch.archived = body.archived
  if (typeof body.pinned === 'boolean') patch.pinned = body.pinned

  // Archive cascade: when archiving a project, first check all its efforts for
  // live sessions. If any effort has a live session, return 409 before any DB
  // write. After the project update, cascade archive to all non-archived efforts
  // and emit effort.updated events.
  if (patch.archived === true) {
    const allEfforts = listEffortsByProject(db, id)

    // Check for live sessions across all efforts BEFORE any DB write.
    const offendingEfforts: Array<{ effort_id: string; live_session_ids: string[] }> = []
    for (const effort of allEfforts) {
      const liveIds = countLiveSessions(effort.id)
      if (liveIds.length > 0) {
        offendingEfforts.push({ effort_id: effort.id, live_session_ids: liveIds })
      }
    }

    if (offendingEfforts.length > 0) {
      return c.json(
        {
          error: 'project_has_live_sessions',
          details: { offending_efforts: offendingEfforts },
        },
        409,
      )
    }

    // No live sessions — safe to write. Cascade archive to non-archived efforts.
    updateProject(db, id, patch)
    const updated = getProjectById(db, id) as Project
    store.recordEvent({ type: 'project.updated', ts: Date.now(), project: updated })

    const now = Date.now()
    for (const effort of allEfforts) {
      if (effort.status !== 'archived') {
        updateEffort(db, effort.id, { status: 'archived' })
        const updatedEffort = { ...effort, status: 'archived' as const }
        store.recordEvent({ type: 'effort.updated', ts: now, effort: updatedEffort })
      }
    }

    return c.json(updated)
  }

  // Non-archive patch (name, pinned, or unarchive) — no cascade.
  updateProject(db, id, patch)
  const updated = getProjectById(db, id) as Project

  store.recordEvent({ type: 'project.updated', ts: Date.now(), project: updated })

  return c.json(updated)
})

// GET /api/projects/:id/cascade-stats — returns { effort_count, session_count }
// Used by the delete-project UI to show "This will delete N efforts and M sessions."
projectsRouter.get('/api/projects/:id/cascade-stats', (c) => {
  const id = c.req.param('id')
  const db = getDb()
  const existing = getProjectById(db, id)
  if (!existing) {
    return c.json({ error: 'project-not-found', details: { id } }, 404)
  }
  const allEfforts = listEffortsByProject(db, id)
  let sessionCount = 0
  for (const effort of allEfforts) {
    sessionCount += listSessionsByEffort(db, effort.id, true).length
  }
  return c.json({ effort_count: allEfforts.length, session_count: sessionCount })
})

// GET /api/projects/check-worktree?path=<picked-path>
//
// Returns { matched: true, projectId, branch } if the given path resolves (via
// realpathSync) to either the root_dir or a known git worktree of an existing
// project. Returns { matched: false } otherwise.
//
// Used by the New Project dialog (US-015b) to detect when the user picks a
// path that already belongs to an existing project and offer them the choice
// of adding an effort under that project instead of creating a duplicate.
projectsRouter.get('/api/projects/check-worktree', (c) => {
  const pickedPath = c.req.query('path')
  if (!pickedPath || typeof pickedPath !== 'string') {
    return c.json({ error: 'path_required' }, 400)
  }
  const allProjects = listProjects(getDb(), {})
  const result = checkIsWorktreeOfProject(
    pickedPath,
    allProjects.map((p) => ({ id: p.id, root_dir: p.root_dir })),
  )
  return c.json(result)
})

// ---------------------------------------------------------------------------
// Disk conversation discovery (Ask 3)
// ---------------------------------------------------------------------------

interface DiskConversation {
  jsonl_path: string
  cwd: string
  size_bytes: number
  mtime: number
  native_name: string | null
  preview: string | null
}

// Peek at the first ~50 non-empty lines of a JSONL file to extract:
//   - native_name: from `{"type":"summary","summary":"<text>",...}`
//   - preview: from the first `{"type":"user","message":{"content":[{"type":"text","text":"<...>"}]},...}`
async function peekJsonl(
  jsonlPath: string,
): Promise<{ native_name: string | null; preview: string | null }> {
  let native_name: string | null = null
  let preview: string | null = null
  try {
    const text = await Bun.file(jsonlPath).text()
    const lines = text.split('\n')
    let count = 0
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue
      if (count >= 50) break
      count++
      let rec: unknown
      try { rec = JSON.parse(line) } catch { continue }
      if (typeof rec !== 'object' || rec === null) continue
      const r = rec as Record<string, unknown>

      if (r.type === 'summary' && typeof r.summary === 'string' && !native_name) {
        native_name = r.summary
      }
      if (r.type === 'user' && !preview) {
        const msg = r.message as Record<string, unknown> | undefined
        if (msg && Array.isArray(msg.content)) {
          for (const item of msg.content as unknown[]) {
            if (
              typeof item === 'object' &&
              item !== null &&
              (item as Record<string, unknown>).type === 'text' &&
              typeof (item as Record<string, unknown>).text === 'string'
            ) {
              const txt = ((item as Record<string, unknown>).text as string).slice(0, 200)
              preview = txt || null
              break
            }
          }
        }
      }

      if (native_name && preview) break
    }
  } catch {
    // File may be unreadable — leave both null.
  }
  return { native_name, preview }
}

// Collect candidate JSONL paths for a given working directory:
// ~/.claude/projects/<encoded-dir>/*.jsonl
async function candidatesForDir(dir: string): Promise<{ jsonl_path: string; cwd: string }[]> {
  const encoded = encodeClaudeProjectDir(dir)
  const claudeDir = join(nodeHomedir(), '.claude', 'projects', encoded)
  let files: string[]
  try {
    files = await readdir(claudeDir)
  } catch {
    return []
  }
  return files
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ jsonl_path: join(claudeDir, f), cwd: dir }))
}

// GET /api/projects/:id/disk-conversations
// Returns JSONL files on disk that are NOT already tracked in the DB.
projectsRouter.get('/api/projects/:id/disk-conversations', async (c) => {
  const id = c.req.param('id')
  const db = getDb()
  const project = getProjectById(db, id)
  if (!project) {
    return c.json({ error: 'project-not-found', details: { id } }, 404)
  }

  // Collect candidate dirs: project root + all worktrees.
  const dirs = new Set<string>([project.root_dir])
  for (const wt of listWorktrees(project.root_dir)) {
    if (wt.path) dirs.add(wt.path)
  }

  // Gather all candidate JSONL paths across dirs.
  const allCandidates: { jsonl_path: string; cwd: string }[] = []
  for (const dir of dirs) {
    const candidates = await candidatesForDir(dir)
    allCandidates.push(...candidates)
  }

  if (allCandidates.length === 0) {
    return c.json({ conversations: [] })
  }

  // Filter out paths already tracked in DB for ANY effort of this project.
  const allEfforts = listEffortsByProject(db, id)
  const trackedPaths = new Set<string>()
  for (const effort of allEfforts) {
    // Use include_archived=true so adopted sessions aren't shown as candidates again.
    const sessions = listSessionsByEffort(db, effort.id, true)
    for (const s of sessions) {
      if (s.jsonl_path) trackedPaths.add(s.jsonl_path)
    }
  }

  const untracked = allCandidates.filter((c) => !trackedPaths.has(c.jsonl_path))

  // Stat each file and peek for native_name/preview.
  const results: DiskConversation[] = []
  for (const { jsonl_path, cwd } of untracked) {
    let size_bytes = 0
    let mtime = 0
    try {
      const s = await stat(jsonl_path)
      size_bytes = s.size
      mtime = s.mtimeMs
    } catch {
      continue // file disappeared between readdir and stat — skip
    }
    const { native_name, preview } = await peekJsonl(jsonl_path)
    results.push({ jsonl_path, cwd, size_bytes, mtime, native_name, preview })
  }

  // Sort newest mtime first.
  results.sort((a, b) => b.mtime - a.mtime)

  return c.json({ conversations: results })
})

// POST /api/projects/:id/disk-conversations/adopt
// body: { jsonl_path: string, effort_id: string, title?: string }
projectsRouter.post('/api/projects/:id/disk-conversations/adopt', async (c) => {
  const projectId = c.req.param('id')
  const db = getDb()
  const project = getProjectById(db, projectId)
  if (!project) {
    return c.json({ error: 'project-not-found', details: { id: projectId } }, 404)
  }

  let body: { jsonl_path?: unknown; effort_id?: unknown; title?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid-json' }, 400)
  }

  if (typeof body.jsonl_path !== 'string' || !body.jsonl_path) {
    return c.json({ error: 'jsonl_path_required' }, 400)
  }
  if (typeof body.effort_id !== 'string' || !body.effort_id) {
    return c.json({ error: 'effort_id_required' }, 400)
  }
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null

  // Validate effort belongs to this project.
  const effort = getEffortById(db, body.effort_id)
  if (!effort || effort.project_id !== projectId) {
    return c.json({ error: 'effort_not_found_for_project' }, 404)
  }

  // Validate jsonl_path is an actual candidate (re-run discovery to prevent
  // arbitrary file binding).
  const dirs = new Set<string>([project.root_dir])
  for (const wt of listWorktrees(project.root_dir)) {
    if (wt.path) dirs.add(wt.path)
  }
  const validPaths = new Set<string>()
  for (const dir of dirs) {
    const candidates = await candidatesForDir(dir)
    for (const { jsonl_path } of candidates) validPaths.add(jsonl_path)
  }

  if (!validPaths.has(body.jsonl_path)) {
    return c.json({ error: 'jsonl_path_not_a_candidate' }, 422)
  }

  // Derive session ID from the JSONL filename (UUID without extension).
  const sessionId = basename(body.jsonl_path, '.jsonl')

  try {
    const session = createSession(db, {
      id: sessionId,
      effort_id: body.effort_id,
      mode: 'interactive',
      jsonl_path: body.jsonl_path,
      working_dir: null,
      title,
      process_pid: null,
      process_started_at: null,
    })
    store.recordEvent({ type: 'session.created', ts: Date.now(), session })
    return c.json(session, 201)
  } catch (err) {
    if ((err as Error)?.name === 'SessionIdCollisionError') {
      return c.json({ error: 'session_id_collision' }, 409)
    }
    throw err
  }
})

// DELETE /api/projects/:id?confirm_name=<typed>&purge_jsonls=true|false
//
// Cascades through FKs to efforts + sessions. The cascaded child events are
// NOT individually emitted — clients reconcile via the lifecycle snapshot or
// by tree-walking after the project.deleted fires.
//
// Live-session block: if any child effort has a live session, returns 409
// and performs no DB writes. Reuses the `_liveCheckOverride` test seam.
//
// purge_jsonls (default false): when true, after the DB cascade, also
// unlinks the on-disk JSONL files for all sessions in all efforts.
projectsRouter.delete('/api/projects/:id', async (c) => {
  const id = c.req.param('id')
  const confirmName = c.req.query('confirm_name')
  const purgeJsonls = c.req.query('purge_jsonls') === 'true'

  const db = getDb()
  const existing = getProjectById(db, id)
  if (!existing) {
    return c.json({ error: 'project-not-found', details: { id } }, 404)
  }

  if (confirmName !== existing.name) {
    return c.json(
      {
        error: 'confirm_name_mismatch',
        details: { expected_name: existing.name },
      },
      422,
    )
  }

  // Live-session block: check all efforts before any DB write.
  const allEfforts = listEffortsByProject(db, id)
  const offendingEfforts: Array<{ effort_id: string; live_session_ids: string[] }> = []
  for (const effort of allEfforts) {
    const liveIds = countLiveSessions(effort.id)
    if (liveIds.length > 0) {
      offendingEfforts.push({ effort_id: effort.id, live_session_ids: liveIds })
    }
  }
  if (offendingEfforts.length > 0) {
    return c.json(
      {
        error: 'project_has_live_sessions',
        details: { offending_efforts: offendingEfforts },
      },
      409,
    )
  }

  // Collect JSONL paths BEFORE the cascade delete (rows gone after).
  // include_archived=true so archived sessions' files are also purged.
  const jsonlPaths: string[] = []
  if (purgeJsonls) {
    for (const effort of allEfforts) {
      const sessions = listSessionsByEffort(db, effort.id, true)
      for (const session of sessions) {
        if (session.jsonl_path) jsonlPaths.push(session.jsonl_path)
      }
    }
  }

  hardDeleteProject(db, id)
  evictWorktreeCacheForProject(existing.root_dir)
  store.recordEvent({ type: 'project.deleted', ts: Date.now(), id })

  // Unlink JSONL files after the DB cascade — best-effort (ENOENT is ignored).
  if (purgeJsonls) {
    for (const p of jsonlPaths) {
      try {
        await unlink(p)
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code !== 'ENOENT') {
          console.warn(`[projects] purge_jsonls unlink failed for ${p}:`, (err as Error)?.message)
        }
      }
    }
  }

  return c.body(null, 204)
})
