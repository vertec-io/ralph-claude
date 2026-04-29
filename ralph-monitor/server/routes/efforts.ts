// REST endpoints for the `efforts` table.
//
//   GET    /api/projects/:id/efforts
//   POST   /api/projects/:id/efforts
//   PATCH  /api/efforts/:id
//   DELETE /api/efforts/:id
//   GET    /api/efforts/:id/snapshot
//
// The kind='prd' CHECK constraint surfaces from the db layer as
// `EffortPrdPathRequiredError`; we map that to 422.
//
// Effort delete (unlike project delete) does NOT require a typed-name confirm.
// Cascaded session deletes do not emit individual events.

import { Hono } from 'hono'
import {
  getDb,
  getProjectById,
  createEffort,
  getEffortById,
  listEffortsByProject,
  updateEffort,
  hardDeleteEffort,
  EffortPrdPathRequiredError,
  type Effort,
  type EffortKind,
  type EffortStatus,
} from '../db'
import { store } from '../store'
import { getSnapshotForPath } from '../snapshot'
import { watchEffortPrd, unwatchEffortPrd, rewatchEffortPrd } from '../effortWatchers'
import { isPathInsideProjectOrWorktree } from '../git/worktrees'

export const effortsRouter = new Hono()

// GET /api/projects/:id/efforts
effortsRouter.get('/api/projects/:id/efforts', (c) => {
  const projectId = c.req.param('id')
  const db = getDb()
  const project = getProjectById(db, projectId)
  if (!project) {
    return c.json({ error: 'project-not-found', details: { id: projectId } }, 404)
  }
  const efforts = listEffortsByProject(db, projectId)
  return c.json({ efforts })
})

// POST /api/projects/:id/efforts { name, kind, prd_path?, working_dir? }
effortsRouter.post('/api/projects/:id/efforts', async (c) => {
  const projectId = c.req.param('id')
  let body: {
    name?: unknown
    kind?: unknown
    prd_path?: unknown
    working_dir?: unknown
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid-json' }, 400)
  }

  const db = getDb()
  const project = getProjectById(db, projectId)
  if (!project) {
    return c.json({ error: 'project-not-found', details: { id: projectId } }, 404)
  }

  const name = typeof body.name === 'string' ? body.name : null
  const kindRaw = typeof body.kind === 'string' ? body.kind : null
  if (!name || !kindRaw) {
    return c.json(
      { error: 'invalid-input', details: { required: ['name', 'kind'] } },
      400,
    )
  }
  if (kindRaw !== 'prd' && kindRaw !== 'task' && kindRaw !== 'general') {
    return c.json(
      { error: 'invalid-kind', details: { kind: kindRaw } },
      400,
    )
  }
  const kind = kindRaw as EffortKind

  const prd_path =
    typeof body.prd_path === 'string'
      ? body.prd_path
      : body.prd_path === null
        ? null
        : undefined
  const working_dir =
    typeof body.working_dir === 'string'
      ? body.working_dir
      : body.working_dir === null
        ? null
        : undefined

  // Validate prd_path is inside project root or a known worktree.
  // Non-empty prd_path (for kind='prd') must resolve to a path that starts
  // with project.root_dir or one of its git worktrees — guards against
  // path-traversal-style issues and keeps efforts anchored to their project.
  if (kind === 'prd' && typeof prd_path === 'string' && prd_path.trim().length > 0) {
    if (!isPathInsideProjectOrWorktree(project.root_dir, prd_path)) {
      return c.json(
        { error: 'prd_path_outside_project_or_worktree', details: { prd_path } },
        422,
      )
    }
  }

  let effort: Effort
  try {
    effort = createEffort(db, {
      project_id: projectId,
      name,
      kind,
      prd_path,
      working_dir,
    })
  } catch (err: unknown) {
    if (err instanceof EffortPrdPathRequiredError) {
      return c.json(
        { error: 'prd_path_required_for_prd_kind' },
        422,
      )
    }
    return c.json(
      { error: 'internal-error', details: { message: (err as Error)?.message } },
      500,
    )
  }

  store.recordEvent({ type: 'effort.created', ts: Date.now(), effort })

  // Start watching prd.json for changes so SSE clients can re-fetch the snapshot.
  if (effort.kind === 'prd' && effort.prd_path) {
    watchEffortPrd(effort.id, effort.prd_path)
  }

  return c.json(effort, 201)
})

// PATCH /api/efforts/:id { name?, status?, prd_path?, working_dir?, completed_at? }
effortsRouter.patch('/api/efforts/:id', async (c) => {
  const id = c.req.param('id')
  let body: {
    name?: unknown
    status?: unknown
    prd_path?: unknown
    working_dir?: unknown
    completed_at?: unknown
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid-json' }, 400)
  }

  const db = getDb()
  const existing = getEffortById(db, id)
  if (!existing) {
    return c.json({ error: 'effort-not-found', details: { id } }, 404)
  }

  const patch: {
    name?: string
    status?: EffortStatus
    prd_path?: string | null
    working_dir?: string | null
    completed_at?: number | null
  } = {}
  if (typeof body.name === 'string') patch.name = body.name
  if (typeof body.status === 'string') {
    if (
      body.status !== 'active' &&
      body.status !== 'done' &&
      body.status !== 'archived'
    ) {
      return c.json(
        { error: 'invalid-status', details: { status: body.status } },
        400,
      )
    }
    patch.status = body.status as EffortStatus
  }
  if ('prd_path' in body) {
    if (typeof body.prd_path === 'string' || body.prd_path === null) {
      patch.prd_path = body.prd_path
    }
  }
  if ('working_dir' in body) {
    if (typeof body.working_dir === 'string' || body.working_dir === null) {
      patch.working_dir = body.working_dir
    }
  }
  if ('completed_at' in body) {
    if (typeof body.completed_at === 'number' || body.completed_at === null) {
      patch.completed_at = body.completed_at
    }
  }

  try {
    updateEffort(db, id, patch)
  } catch (err: unknown) {
    if (err instanceof EffortPrdPathRequiredError) {
      return c.json({ error: 'prd_path_required_for_prd_kind' }, 422)
    }
    return c.json(
      { error: 'internal-error', details: { message: (err as Error)?.message } },
      500,
    )
  }

  const updated = getEffortById(db, id) as Effort
  store.recordEvent({ type: 'effort.updated', ts: Date.now(), effort: updated })

  // Re-establish the file watcher if prd_path was part of this patch.
  // `rewatchEffortPrd` is idempotent when nothing changed and handles null.
  if ('prd_path' in patch && updated.kind === 'prd') {
    rewatchEffortPrd(updated.id, updated.prd_path)
  }

  return c.json(updated)
})

// DELETE /api/efforts/:id — no typed-name requirement.
effortsRouter.delete('/api/efforts/:id', (c) => {
  const id = c.req.param('id')
  const db = getDb()
  const existing = getEffortById(db, id)
  if (!existing) {
    return c.json({ error: 'effort-not-found', details: { id } }, 404)
  }
  hardDeleteEffort(db, id)
  store.recordEvent({ type: 'effort.deleted', ts: Date.now(), id })
  // Stop watching the prd.json file for this effort (no-op if not a prd-kind).
  unwatchEffortPrd(id)
  return c.body(null, 204)
})

// GET /api/efforts/:id/snapshot — returns the PRDRecord snapshot for a
// kind='prd' effort.  Returns { status: 'pending' } when prd_path doesn't
// exist on disk yet.  Returns 404 for non-prd efforts or missing efforts.
effortsRouter.get('/api/efforts/:id/snapshot', async (c) => {
  const id = c.req.param('id')
  const db = getDb()
  const effort = getEffortById(db, id)
  if (!effort) return c.json({ error: 'effort_not_found' }, 404)
  if (effort.kind !== 'prd') return c.json({ error: 'effort_not_prd_kind' }, 404)
  if (!effort.prd_path) return c.json({ error: 'effort_missing_prd_path' }, 422)

  const project = getProjectById(db, effort.project_id)
  const workingDir = effort.working_dir ?? project?.root_dir ?? ''
  if (!workingDir) return c.json({ error: 'no_working_dir' }, 500)

  const snapshot = await getSnapshotForPath({
    prdPath: effort.prd_path,
    workingDir,
    // sessionId/unitName intentionally undefined → graceful empty agents
  })

  return c.json(snapshot)
})
