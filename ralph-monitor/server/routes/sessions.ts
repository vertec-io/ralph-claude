// REST endpoints for the `sessions` table.
//
//   GET    /api/efforts/:id/sessions
//   PATCH  /api/sessions/:id
//   DELETE /api/sessions/:id?purge_jsonl=true|false
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
  getSessionById,
  listSessionsByEffort,
  updateSession,
  hardDeleteSession,
  type Session,
} from '../db'
import { store } from '../store'

export const sessionsRouter = new Hono()

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
