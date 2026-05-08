// REST endpoints for the `projects` table.
//
//   GET    /api/projects
//   POST   /api/projects                  { name, root_dir }
//   PATCH  /api/projects/:id              { name?, archived?, pinned? }
//   DELETE /api/projects/:id?confirm_name=<typed>&purge_jsonls=true|false
//   GET    /api/projects/:id/cascade-stats
//   GET    /api/projects/check-worktree?path=...
//   POST   /api/projects/:id/scan         (manual rescan of disk + tasks)
//
// On project create AND on first GET (via lazy hook in server bootstrap), the
// disk-discovery service walks ~/.claude/projects/<encoded> for the project's
// root_dir + worktrees and upserts session rows. The tasks-scan service walks
// <root_dir>/tasks/*/prd.json and upserts prd_spec rows. Watchers keep both
// live.
//
// All effort logic has been removed in the post-redesign world. There is no
// kind, no /api/efforts, no auto-effort-on-create.

import { Hono } from 'hono'
import { SQLiteError } from 'bun:sqlite'
import { unlink } from 'node:fs/promises'
import {
  getDb,
  createProject,
  getProjectById,
  getProjectByRootDir,
  listProjects,
  listSessionsByProject,
  listPrdSpecsByProject,
  updateProject,
  hardDeleteProject,
  type Project,
  type ListProjectsFilter,
} from '../db'
import { store } from '../store'
import { evictWorktreeCacheForProject, checkIsWorktreeOfProject } from '../git/worktrees'
import { getGitStatus } from '../git/status'
import * as registry from '../sessions/registry'
import { discoverProjectSessions, scanProjectTasks } from '../projectDiscovery'

// Test seam — overrides the live-session check. Keyed by project_id.
let _liveCheckOverride: ((projectId: string) => number) | null = null

export const __test__ = {
  setLiveCheckOverride(fn: ((projectId: string) => number) | null) {
    _liveCheckOverride = fn
  },
}

function liveSessionIdsForProject(projectId: string): string[] {
  if (_liveCheckOverride !== null) {
    const count = _liveCheckOverride(projectId)
    return count > 0 ? Array.from({ length: count }, (_, i) => `fake-session-${i}`) : []
  }
  return registry.listLiveByProject(projectId).map((h) => h.sessionId)
}

const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export const projectsRouter = new Hono()

// GET /api/projects?status=active|recent|archived&pinned=true|false
projectsRouter.get('/api/projects', (c) => {
  const status = c.req.query('status')
  const pinnedRaw = c.req.query('pinned')

  const filter: ListProjectsFilter = {}
  if (pinnedRaw === 'true') filter.pinned = true
  else if (pinnedRaw === 'false') filter.pinned = false

  if (status === 'active') filter.archived = false
  else if (status === 'archived') filter.archived = true
  else if (status === 'recent') filter.archived = false
  else if (status !== undefined && status !== '') {
    return c.json({ error: 'invalid_status', details: { status } }, 400)
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
projectsRouter.post('/api/projects', async (c) => {
  let body: { name?: unknown; root_dir?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const name = typeof body.name === 'string' ? body.name : null
  const rootDir = typeof body.root_dir === 'string' ? body.root_dir : null
  if (!name || !rootDir) {
    return c.json(
      { error: 'invalid_input', details: { required: ['name', 'root_dir'] } },
      400,
    )
  }

  const db = getDb()
  let result: { projectId: string; rootDir: string }
  try {
    result = createProject(db, { name, root_dir: rootDir })
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return c.json(
        { error: 'root_dir_does_not_exist', details: { root_dir: rootDir } },
        422,
      )
    }
    if (err instanceof SQLiteError && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const existing = getProjectByRootDir(db, rootDir)
      return c.json(
        { error: 'project_root_dir_taken', details: { existing_id: existing?.id ?? null } },
        409,
      )
    }
    return c.json(
      { error: 'internal_error', details: { message: (err as Error)?.message } },
      500,
    )
  }

  const project = getProjectById(db, result.projectId)
  if (!project) {
    return c.json({ error: 'project_not_found_after_insert' }, 500)
  }

  store.recordEvent({ type: 'project.created', ts: Date.now(), project })

  // Kick off discovery + tasks scan in the background. The route returns
  // immediately; SSE consumers will see session.created / prd_spec.created
  // events as the discovery runs.
  void discoverProjectSessions(project).catch((err) => {
    console.warn(`[projects] discoverProjectSessions failed for ${project.id}:`, err)
  })
  void scanProjectTasks(project).catch((err) => {
    console.warn(`[projects] scanProjectTasks failed for ${project.id}:`, err)
  })

  return c.json(project, 201)
})

// PATCH /api/projects/:id { name?, archived?, pinned? }
projectsRouter.patch('/api/projects/:id', async (c) => {
  const id = c.req.param('id')
  let body: { name?: unknown; archived?: unknown; pinned?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const db = getDb()
  const existing = getProjectById(db, id)
  if (!existing) {
    return c.json({ error: 'project_not_found', details: { id } }, 404)
  }

  const patch: { name?: string; archived?: boolean; pinned?: boolean } = {}
  if (typeof body.name === 'string') patch.name = body.name
  if (typeof body.archived === 'boolean') patch.archived = body.archived
  if (typeof body.pinned === 'boolean') patch.pinned = body.pinned

  if (patch.archived === true) {
    const liveIds = liveSessionIdsForProject(id)
    if (liveIds.length > 0) {
      return c.json(
        {
          error: 'project_has_live_sessions',
          details: { live_session_ids: liveIds },
        },
        409,
      )
    }
  }

  updateProject(db, id, patch)
  const updated = getProjectById(db, id) as Project
  store.recordEvent({ type: 'project.updated', ts: Date.now(), project: updated })
  return c.json(updated)
})

// GET /api/projects/:id/cascade-stats
projectsRouter.get('/api/projects/:id/cascade-stats', (c) => {
  const id = c.req.param('id')
  const db = getDb()
  const existing = getProjectById(db, id)
  if (!existing) {
    return c.json({ error: 'project_not_found', details: { id } }, 404)
  }
  const sessionCount = listSessionsByProject(db, id, { includeArchived: true }).length
  const prdCount = listPrdSpecsByProject(db, id).length
  return c.json({ session_count: sessionCount, prd_count: prdCount })
})

// GET /api/projects/check-worktree?path=<picked-path>
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

// GET /api/projects/:id/git-status — branch + ahead/behind + dirty count.
projectsRouter.get('/api/projects/:id/git-status', (c) => {
  const id = c.req.param('id')
  const db = getDb()
  const project = getProjectById(db, id)
  if (!project) {
    return c.json({ error: 'project_not_found', details: { id } }, 404)
  }
  const force = c.req.query('force') === 'true'
  return c.json(getGitStatus(project.root_dir, force))
})

// POST /api/projects/:id/scan — manual rescan trigger.
projectsRouter.post('/api/projects/:id/scan', async (c) => {
  const id = c.req.param('id')
  const db = getDb()
  const project = getProjectById(db, id)
  if (!project) {
    return c.json({ error: 'project_not_found', details: { id } }, 404)
  }
  const [sessionResult, prdResult] = await Promise.all([
    discoverProjectSessions(project),
    scanProjectTasks(project),
  ])
  return c.json({
    sessions: sessionResult,
    prds: prdResult,
  })
})

// DELETE /api/projects/:id?confirm_name=<typed>&purge_jsonls=true|false
projectsRouter.delete('/api/projects/:id', async (c) => {
  const id = c.req.param('id')
  const confirmName = c.req.query('confirm_name')
  const purgeJsonls = c.req.query('purge_jsonls') === 'true'

  const db = getDb()
  const existing = getProjectById(db, id)
  if (!existing) {
    return c.json({ error: 'project_not_found', details: { id } }, 404)
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

  const liveIds = liveSessionIdsForProject(id)
  if (liveIds.length > 0) {
    return c.json(
      {
        error: 'project_has_live_sessions',
        details: { live_session_ids: liveIds },
      },
      409,
    )
  }

  const jsonlPaths: string[] = []
  if (purgeJsonls) {
    for (const s of listSessionsByProject(db, id, { includeArchived: true })) {
      if (s.jsonl_path) jsonlPaths.push(s.jsonl_path)
    }
  }

  hardDeleteProject(db, id)
  evictWorktreeCacheForProject(existing.root_dir)
  store.recordEvent({ type: 'project.deleted', ts: Date.now(), id })

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
