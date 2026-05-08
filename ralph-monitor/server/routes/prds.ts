// REST endpoints for `prd_specs` and the `conversation_prds` join.
//
//   GET   /api/projects/:pid/prds                — list PRDs in this project
//   GET   /api/prd-specs/:id                     — single PRD spec (full prd_json)
//   GET   /api/prd-specs/:id/sessions            — sessions associated with this PRD
//   POST  /api/prd-specs/:id/scan                — re-read prd.json from disk
//   GET   /api/sessions/:id/prds                 — PRDs associated with this session
//   POST  /api/sessions/:id/prds                 — { prd_spec_ids } replace-set
//
// PRD discovery itself happens in `server/discovery.ts` (initial scan +
// chokidar watcher). These endpoints expose the resulting rows and let the UI
// manage M:N associations between conversations and PRDs.

import { Hono } from 'hono'
import {
  getDb,
  getProjectById,
  getSessionById,
  getPrdSpecById,
  listPrdSpecsByProject,
  listPrdSpecsBySession,
  listSessionsByPrdSpec,
  setSessionPrds,
} from '../db'
import { store } from '../store'
import { rescanPrdSpec } from '../projectDiscovery'

export const prdsRouter = new Hono()

// GET /api/projects/:pid/prds
prdsRouter.get('/api/projects/:pid/prds', (c) => {
  const pid = c.req.param('pid')
  const db = getDb()
  const project = getProjectById(db, pid)
  if (!project) {
    return c.json({ error: 'project_not_found', details: { id: pid } }, 404)
  }
  const prds = listPrdSpecsByProject(db, pid)
  return c.json({ prds })
})

// GET /api/prd-specs/:id
prdsRouter.get('/api/prd-specs/:id', (c) => {
  const id = c.req.param('id')
  const ps = getPrdSpecById(getDb(), id)
  if (!ps) return c.json({ error: 'prd_spec_not_found', details: { id } }, 404)
  return c.json(ps)
})

// GET /api/prd-specs/:id/sessions
prdsRouter.get('/api/prd-specs/:id/sessions', (c) => {
  const id = c.req.param('id')
  const db = getDb()
  const ps = getPrdSpecById(db, id)
  if (!ps) return c.json({ error: 'prd_spec_not_found', details: { id } }, 404)
  const session_ids = listSessionsByPrdSpec(db, id)
  return c.json({ session_ids })
})

// POST /api/prd-specs/:id/scan — re-read the on-disk prd.json into this row.
prdsRouter.post('/api/prd-specs/:id/scan', async (c) => {
  const id = c.req.param('id')
  const db = getDb()
  const ps = getPrdSpecById(db, id)
  if (!ps) return c.json({ error: 'prd_spec_not_found', details: { id } }, 404)
  const updated = await rescanPrdSpec(ps)
  if (!updated) {
    return c.json({ error: 'prd_json_unreadable', details: { path: ps.prd_path } }, 422)
  }
  return c.json(updated)
})

// GET /api/sessions/:id/prds
prdsRouter.get('/api/sessions/:id/prds', (c) => {
  const id = c.req.param('id')
  const db = getDb()
  const session = getSessionById(db, id)
  if (!session) return c.json({ error: 'session_not_found', details: { id } }, 404)
  const prds = listPrdSpecsBySession(db, id)
  return c.json({ prds })
})

// POST /api/sessions/:id/prds { prd_spec_ids } — replace-set semantics.
prdsRouter.post('/api/sessions/:id/prds', async (c) => {
  const id = c.req.param('id')
  let body: { prd_spec_ids?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  if (
    !Array.isArray(body.prd_spec_ids) ||
    !body.prd_spec_ids.every((x) => typeof x === 'string')
  ) {
    return c.json({ error: 'prd_spec_ids_invalid' }, 400)
  }
  const ids = body.prd_spec_ids as string[]

  const db = getDb()
  const session = getSessionById(db, id)
  if (!session) return c.json({ error: 'session_not_found', details: { id } }, 404)

  for (const psid of ids) {
    const ps = getPrdSpecById(db, psid)
    if (!ps || ps.project_id !== session.project_id) {
      return c.json(
        { error: 'prd_spec_not_found_for_project', details: { prd_spec_id: psid } },
        404,
      )
    }
  }

  setSessionPrds(db, id, ids)
  store.recordEvent({
    type: 'session.prds.updated',
    ts: Date.now(),
    session_id: id,
    prd_spec_ids: ids,
  })
  return c.json({ session_id: id, prd_spec_ids: ids })
})
