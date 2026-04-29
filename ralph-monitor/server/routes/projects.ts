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
  updateProject,
  hardDeleteProject,
  type Project,
  type ListProjectsFilter,
} from '../db'
import { store } from '../store'

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

  updateProject(db, id, patch)
  const updated = getProjectById(db, id) as Project

  store.recordEvent({ type: 'project.updated', ts: Date.now(), project: updated })

  return c.json(updated)
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
  store.recordEvent({ type: 'project.deleted', ts: Date.now(), id })

  return c.body(null, 204)
})
