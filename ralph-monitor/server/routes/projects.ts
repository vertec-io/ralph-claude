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
import {
  getDb,
  createProject,
  getProjectById,
  getProjectByRootDir,
  listProjects,
  listEffortsByProject,
  updateProject,
  updateEffort,
  hardDeleteProject,
  type Project,
  type ListProjectsFilter,
} from '../db'
import { store } from '../store'
import { evictWorktreeCacheForProject, checkIsWorktreeOfProject } from '../git/worktrees'
import * as registry from '../sessions/registry'

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

// DELETE /api/projects/:id?confirm_name=<typed>
//
// Cascades through FKs to efforts + sessions. The cascaded child events are
// NOT individually emitted — clients reconcile via the lifecycle snapshot or
// by tree-walking after the project.deleted fires.
projectsRouter.delete('/api/projects/:id', (c) => {
  const id = c.req.param('id')
  const confirmName = c.req.query('confirm_name')

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

  hardDeleteProject(db, id)
  evictWorktreeCacheForProject(existing.root_dir)
  store.recordEvent({ type: 'project.deleted', ts: Date.now(), id })

  return c.body(null, 204)
})
