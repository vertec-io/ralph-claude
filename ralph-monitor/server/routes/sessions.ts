// REST endpoints for the `sessions` table.
//
//   POST   /api/sessions
//   GET    /api/efforts/:id/sessions
//   PATCH  /api/sessions/:id
//   DELETE /api/sessions/:id?purge_jsonl=true|false
//
// POST wraps `spawnSession` (US-005d). It validates the body, checks that
// `working_dir` (when provided) resolves to either project.root_dir or a known
// git worktree of it, then calls `spawnSession` and returns 201 with
// { id, jsonl_path, ws_url }. Typed errors from the spawn layer are mapped to
// HTTP statuses: EffortNotFound -> 404, OneLiveSessionPerEffortPrep -> 409,
// CwdResolution -> 422, anything else -> 500.
//
// PATCH does NOT accept process_pid — that's a spawn-internal field, written
// only by the spawn path / liveness watcher (US-005a-2). PATCH carries
// title / working_dir / last_activity_at only.
//
// DELETE with purge_jsonl=true will best-effort unlink the on-disk JSONL after
// removing the row. ENOENT is logged and ignored — the row is gone, that's
// what matters.

import { Hono } from 'hono'
import { unlink } from 'node:fs/promises'
import {
  getDb,
  getEffortById,
  getProjectById,
  getSessionById,
  listSessionsByEffort,
  updateSession,
  hardDeleteSession,
  type Session,
} from '../db'
import { store } from '../store'
import {
  spawnSession,
  getSpawner,
  EffortNotFoundError,
  CwdResolutionError,
  OneLiveSessionPerEffortPrepError,
} from '../sessions/spawn'
import { isPathInProjectOrWorktree } from '../git/worktrees'

export const sessionsRouter = new Hono()

// POST /api/sessions { effort_id, mode, working_dir?, initial_prompt? }
sessionsRouter.post('/api/sessions', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  const b = (body ?? {}) as {
    effort_id?: unknown
    mode?: unknown
    working_dir?: unknown
    initial_prompt?: unknown
  }

  // Field validation — we surface 400 with a stable error code per field so
  // a UI can map them back to form errors without parsing free-text messages.
  if (typeof b.effort_id !== 'string' || b.effort_id.length === 0) {
    return c.json({ error: 'effort_id_required' }, 400)
  }
  if (b.mode !== 'interactive' && b.mode !== 'autonomous') {
    return c.json(
      { error: 'mode_invalid', details: { allowed: ['interactive', 'autonomous'] } },
      400,
    )
  }
  if (b.working_dir !== undefined && typeof b.working_dir !== 'string') {
    return c.json({ error: 'working_dir_invalid' }, 400)
  }
  if (b.initial_prompt !== undefined && typeof b.initial_prompt !== 'string') {
    return c.json({ error: 'initial_prompt_invalid' }, 400)
  }

  const effort_id = b.effort_id
  const mode = b.mode
  const working_dir = b.working_dir as string | undefined
  const initial_prompt = b.initial_prompt as string | undefined

  // Effort + project pre-checks — duplicating prepareSpawn's effort lookup
  // here lets us surface a 404 BEFORE the per-effort lock is taken (and
  // before the working_dir check, which needs project.root_dir).
  const db = getDb()
  const effort = getEffortById(db, effort_id)
  if (!effort) {
    return c.json({ error: 'effort_not_found', details: { id: effort_id } }, 404)
  }
  const project = getProjectById(db, effort.project_id)
  if (!project) {
    // FK should prevent this; if it ever fires we want loud telemetry rather
    // than a confusing 404.
    return c.json({ error: 'project_not_found', details: { id: effort.project_id } }, 500)
  }

  // working_dir validation. Per AC: must resolve (after realpath) to
  // project.root_dir OR one of its known worktrees. Anything else is 422.
  // CwdResolutionError thrown later by spawnSession is a different case
  // (path doesn't exist on disk) — also 422 but with a distinct error code.
  if (working_dir !== undefined) {
    if (!isPathInProjectOrWorktree(project.root_dir, working_dir)) {
      return c.json(
        {
          error: 'working_dir_outside_project_or_worktree',
          details: {
            project_root_dir: project.root_dir,
            working_dir,
          },
        },
        422,
      )
    }
  }

  try {
    const result = await spawnSession(
      { effort_id, mode, working_dir, initial_prompt },
      { spawner: getSpawner() },
    )
    return c.json(
      {
        id: result.id,
        jsonl_path: result.jsonlPath,
        ws_url: `/ws/sessions/${result.id}`,
      },
      201,
    )
  } catch (err) {
    if (err instanceof EffortNotFoundError) {
      return c.json({ error: 'effort_not_found', details: { id: effort_id } }, 404)
    }
    if (err instanceof OneLiveSessionPerEffortPrepError) {
      return c.json(
        { error: 'one_live_session_per_effort', details: { effort_id } },
        409,
      )
    }
    if (err instanceof CwdResolutionError) {
      return c.json(
        { error: 'cwd_resolution_failed', details: { message: err.message } },
        422,
      )
    }
    return c.json(
      { error: 'spawn_failed', details: { message: (err as Error).message } },
      500,
    )
  }
})

// GET /api/efforts/:id/sessions
sessionsRouter.get('/api/efforts/:id/sessions', (c) => {
  const effortId = c.req.param('id')
  const db = getDb()
  const effort = getEffortById(db, effortId)
  if (!effort) {
    return c.json({ error: 'effort-not-found', details: { id: effortId } }, 404)
  }
  const sessions = listSessionsByEffort(db, effortId)
  return c.json({ sessions })
})

// PATCH /api/sessions/:id { title?, working_dir?, last_activity_at? }
sessionsRouter.patch('/api/sessions/:id', async (c) => {
  const id = c.req.param('id')
  let body: {
    title?: unknown
    working_dir?: unknown
    last_activity_at?: unknown
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid-json' }, 400)
  }

  const db = getDb()
  const existing = getSessionById(db, id)
  if (!existing) {
    return c.json({ error: 'session-not-found', details: { id } }, 404)
  }

  const patch: {
    title?: string | null
    working_dir?: string | null
    last_activity_at?: number | null
  } = {}
  if ('title' in body) {
    if (typeof body.title === 'string' || body.title === null) {
      patch.title = body.title
    }
  }
  if ('working_dir' in body) {
    if (typeof body.working_dir === 'string' || body.working_dir === null) {
      patch.working_dir = body.working_dir
    }
  }
  if ('last_activity_at' in body) {
    if (
      typeof body.last_activity_at === 'number' ||
      body.last_activity_at === null
    ) {
      patch.last_activity_at = body.last_activity_at
    }
  }

  updateSession(db, id, patch)
  const updated = getSessionById(db, id) as Session
  store.recordEvent({ type: 'session.updated', ts: Date.now(), session: updated })
  return c.json(updated)
})

// DELETE /api/sessions/:id?purge_jsonl=true|false
sessionsRouter.delete('/api/sessions/:id', async (c) => {
  const id = c.req.param('id')
  const purge = c.req.query('purge_jsonl') === 'true'

  const db = getDb()
  const existing = getSessionById(db, id)
  if (!existing) {
    return c.json({ error: 'session-not-found', details: { id } }, 404)
  }

  hardDeleteSession(db, id)

  if (purge && existing.jsonl_path) {
    try {
      await unlink(existing.jsonl_path)
    } catch (err: unknown) {
      // ENOENT: the file is already gone — that's fine, we wanted it gone.
      // Anything else: log + continue, the DB row is already removed.
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== 'ENOENT') {
        console.warn(
          `[sessions] purge_jsonl unlink failed for ${existing.jsonl_path}:`,
          (err as Error)?.message,
        )
      }
    }
  }

  store.recordEvent({ type: 'session.deleted', ts: Date.now(), id })
  return c.body(null, 204)
})
