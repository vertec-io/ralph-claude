// REST endpoints for the `efforts` table.
//
//   GET    /api/projects/:id/efforts
//   POST   /api/projects/:id/efforts
//   PATCH  /api/efforts/:id
//   DELETE /api/efforts/:id
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
  return c.body(null, 204)
})
