// REST endpoints for the `sessions` table.
//
//   POST   /api/projects/:pid/sessions
//   GET    /api/projects/:pid/sessions
//   GET    /api/sessions/:id
//   GET    /api/sessions/:id/transcript/stream
//   POST   /api/sessions/:id/resume
//   POST   /api/sessions/:id/kill
//   PATCH  /api/sessions/:id
//   DELETE /api/sessions/:id?purge_jsonl=true|false
//
// PATCH carries title / working_dir / archived / pinned / prd_spec_ids. The
// `prd_spec_ids` field uses replace-set semantics — passing the array replaces
// the conversation's PRD associations with exactly that set.

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { unlink } from 'node:fs/promises'
import {
  getDb,
  getProjectById,
  getSessionById,
  listSessionsByProject,
  updateSession,
  hardDeleteSession,
  setSessionPrds,
  getPrdSpecById,
  type Session,
} from '../db'
import { store } from '../store'
import {
  spawnSession,
  resumeSession,
  getSpawner,
  ProjectNotFoundError,
  CwdResolutionError,
  SessionNotFoundError,
  SessionAlreadyLiveError,
  SessionInGraceWindowError,
  JsonlMissingError,
} from '../sessions/spawn'
import { computeSessionStatus, enrichSessionStatus } from '../sessions/status'
import { get as registryGet, unregister as registryUnregister } from '../sessions/registry'
import { findSessionOwner, invalidateJsonlOwnerCache } from '../sessions/jsonlOwner'
import { isPathInProjectOrWorktree } from '../git/worktrees'
import { attachTailer } from '../jsonl/tailer'

export const sessionsRouter = new Hono()

// POST /api/projects/:pid/sessions
//   { mode?, working_dir?, initial_prompt?, title?, prd_spec_ids? }
sessionsRouter.post('/api/projects/:pid/sessions', async (c) => {
  const pid = c.req.param('pid')
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  const b = (body ?? {}) as {
    mode?: unknown
    working_dir?: unknown
    initial_prompt?: unknown
    title?: unknown
    prd_spec_ids?: unknown
  }

  const modeRaw = b.mode
  const mode: 'interactive' | 'autonomous' =
    modeRaw === 'interactive' || modeRaw === 'autonomous' ? modeRaw : 'interactive'
  if (b.working_dir !== undefined && typeof b.working_dir !== 'string') {
    return c.json({ error: 'working_dir_invalid' }, 400)
  }
  if (b.initial_prompt !== undefined && typeof b.initial_prompt !== 'string') {
    return c.json({ error: 'initial_prompt_invalid' }, 400)
  }
  if (b.title !== undefined && typeof b.title !== 'string') {
    return c.json({ error: 'title_invalid' }, 400)
  }
  if (
    b.prd_spec_ids !== undefined &&
    (!Array.isArray(b.prd_spec_ids) ||
      !b.prd_spec_ids.every((x) => typeof x === 'string'))
  ) {
    return c.json({ error: 'prd_spec_ids_invalid' }, 400)
  }

  const working_dir = b.working_dir as string | undefined
  const initial_prompt = b.initial_prompt as string | undefined
  const title = b.title as string | undefined
  const prd_spec_ids = (b.prd_spec_ids as string[] | undefined) ?? []

  const db = getDb()
  const project = getProjectById(db, pid)
  if (!project) {
    return c.json({ error: 'project_not_found', details: { id: pid } }, 404)
  }

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

  // Validate prd_spec_ids belong to this project before spawning.
  for (const psid of prd_spec_ids) {
    const ps = getPrdSpecById(db, psid)
    if (!ps || ps.project_id !== pid) {
      return c.json(
        { error: 'prd_spec_not_found_for_project', details: { prd_spec_id: psid } },
        404,
      )
    }
  }

  try {
    const result = await spawnSession(
      { project_id: pid, mode, working_dir, initial_prompt, title },
      { spawner: getSpawner() },
    )
    if (prd_spec_ids.length > 0) {
      setSessionPrds(db, result.id, prd_spec_ids)
      store.recordEvent({
        type: 'session.prds.updated',
        ts: Date.now(),
        session_id: result.id,
        prd_spec_ids,
      })
    }
    return c.json(
      {
        id: result.id,
        jsonl_path: result.jsonlPath,
        ws_url: `/ws/sessions/${result.id}`,
      },
      201,
    )
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return c.json({ error: 'project_not_found', details: { id: pid } }, 404)
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

// GET /api/projects/:pid/sessions?include_archived=true&pinned=true&limit=N
sessionsRouter.get('/api/projects/:pid/sessions', (c) => {
  const pid = c.req.param('pid')
  const db = getDb()
  const project = getProjectById(db, pid)
  if (!project) {
    return c.json({ error: 'project_not_found', details: { id: pid } }, 404)
  }
  const includeArchived = c.req.query('include_archived') === 'true'
  const pinnedOnly = c.req.query('pinned') === 'true'
  const limitRaw = c.req.query('limit')
  const limit = limitRaw ? Math.max(1, Math.min(500, parseInt(limitRaw, 10) || 0)) : undefined
  const sessions = listSessionsByProject(db, pid, {
    includeArchived,
    pinnedOnly,
    limit,
  })
  return c.json({ sessions })
})

// GET /api/sessions/:id
//
// Returns the row plus a computed status. When sync status is `dormant` we
// also probe /proc to see if another claude process holds the JSONL open —
// if so we surface `external-owned` with `external_owner_pid` so the UI can
// render the read-only watch + Take-over affordance.
sessionsRouter.get('/api/sessions/:id', async (c) => {
  const id = c.req.param('id')
  const session = getSessionById(getDb(), id)
  if (!session) {
    return c.json({ error: 'session_not_found', details: { id } }, 404)
  }
  const enriched = await enrichSessionStatus(session)
  const status = enriched.status
  return c.json({
    ...session,
    status,
    live: status === 'live-attached' || status === 'live-orphaned',
    attached: status === 'live-attached',
    external_owner_pid: enriched.external_owner?.pid ?? null,
    external_owner_comm: enriched.external_owner?.comm ?? null,
  })
})

// GET /api/sessions/:id/transcript/stream
sessionsRouter.get('/api/sessions/:id/transcript/stream', async (c) => {
  const id = c.req.param('id')
  const session = getSessionById(getDb(), id)
  if (!session) {
    return c.json({ error: 'session_not_found', details: { id } }, 404)
  }
  const jsonlPath = session.jsonl_path
  if (!jsonlPath) {
    return c.json({ error: 'jsonl_missing', details: { id } }, 404)
  }

  return streamSSE(c, async (stream) => {
    let detach: (() => void) | null = null
    let goneClosed = false

    detach = await attachTailer(jsonlPath, id, async (event) => {
      if (stream.aborted) return
      try {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      } catch {}
      if (event.type === 'turn') {
        store.recordEvent({ type: 'session.activity', ts: Date.now(), id })
      }
      if (event.type === 'gone' && !goneClosed) {
        goneClosed = true
        try { await stream.close() } catch {}
      }
    })

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        if (detach) {
          detach()
          detach = null
        }
        resolve()
      })
    })
  })
})

// POST /api/sessions/:id/resume
sessionsRouter.post('/api/sessions/:id/resume', async (c) => {
  const id = c.req.param('id')

  // Refuse if another claude process owns this JSONL — the user has to either
  // close that process (we'll surface dormant on next poll) or invoke
  // /takeover (which kills the external process and then resumes).
  const session = getSessionById(getDb(), id)
  if (session) {
    const owner = await findSessionOwner(session.id)
    if (owner) {
      return c.json(
        {
          error: 'external_owned',
          details: { id, external_owner_pid: owner.pid, external_owner_comm: owner.comm },
        },
        409,
      )
    }
  }

  try {
    const result = await resumeSession({ session_id: id }, { spawner: getSpawner() })
    return c.json(
      {
        id: result.id,
        jsonl_path: result.jsonlPath,
        ws_url: `/ws/sessions/${result.id}`,
      },
      200,
    )
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return c.json({ error: 'session_not_found', details: { id } }, 404)
    }
    if (err instanceof JsonlMissingError) {
      return c.json({ error: 'jsonl_missing', details: { id } }, 404)
    }
    if (err instanceof SessionAlreadyLiveError) {
      return c.json({ error: 'session_already_live', details: { id } }, 409)
    }
    if (err instanceof SessionInGraceWindowError) {
      return c.json({ error: 'session_in_grace_window', details: { id } }, 409)
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

// POST /api/sessions/:id/takeover
//
// If another (non-ralph-monitor) claude process holds this session's JSONL
// open, SIGTERM it (escalating to SIGKILL after 5 s) and then resume the
// session here. Returns the same shape as /resume on success.
sessionsRouter.post('/api/sessions/:id/takeover', async (c) => {
  const id = c.req.param('id')
  const session = getSessionById(getDb(), id)
  if (!session) {
    return c.json({ error: 'session_not_found', details: { id } }, 404)
  }

  const owner = await findSessionOwner(session.id)
  if (!owner) {
    // Nothing to take over from; treat as a regular resume request.
    return c.json(
      { error: 'no_external_owner', details: { id } },
      409,
    )
  }

  // SIGTERM, poll for exit up to 5 s, escalate to SIGKILL.
  try { process.kill(owner.pid, 'SIGTERM') } catch {}
  const deadline = Date.now() + 5000
  let gone = false
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 250))
    try { process.kill(owner.pid, 0) } catch { gone = true; break }
  }
  if (!gone) {
    try { process.kill(owner.pid, 'SIGKILL') } catch {}
    // Brief grace for the OS to clean up the fd before we try to resume.
    await new Promise<void>((r) => setTimeout(r, 250))
  }
  invalidateJsonlOwnerCache(session.id)

  // Now resume normally. If a stale fd is still detected on rapid retry,
  // surface external_owned again rather than racing the spawn.
  const stillOwned = await findSessionOwner(session.id)
  if (stillOwned) {
    return c.json(
      {
        error: 'external_owned',
        details: {
          id,
          external_owner_pid: stillOwned.pid,
          external_owner_comm: stillOwned.comm,
          message: 'process did not exit after SIGKILL',
        },
      },
      409,
    )
  }

  try {
    const result = await resumeSession({ session_id: id }, { spawner: getSpawner() })
    return c.json(
      {
        id: result.id,
        jsonl_path: result.jsonlPath,
        ws_url: `/ws/sessions/${result.id}`,
      },
      200,
    )
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return c.json({ error: 'session_not_found', details: { id } }, 404)
    }
    if (err instanceof JsonlMissingError) {
      return c.json({ error: 'jsonl_missing', details: { id } }, 404)
    }
    if (err instanceof SessionAlreadyLiveError) {
      return c.json({ error: 'session_already_live', details: { id } }, 409)
    }
    if (err instanceof SessionInGraceWindowError) {
      return c.json({ error: 'session_in_grace_window', details: { id } }, 409)
    }
    if (err instanceof CwdResolutionError) {
      return c.json(
        { error: 'cwd_resolution_failed', details: { message: err.message } },
        422,
      )
    }
    return c.json(
      { error: 'takeover_resume_failed', details: { message: (err as Error).message } },
      500,
    )
  }
})

// POST /api/sessions/:id/kill
sessionsRouter.post('/api/sessions/:id/kill', async (c) => {
  const id = c.req.param('id')
  const db = getDb()
  const session = getSessionById(db, id)
  if (!session) {
    return c.json({ error: 'session_not_found', details: { id } }, 404)
  }

  const status = computeSessionStatus(session)

  if (status === 'dormant' || status === 'exited') {
    return c.json(
      { error: 'session_not_killable', details: { id, status } },
      409,
    )
  }

  const handle = registryGet(id)

  if (status === 'live-attached' && handle) {
    try { handle.kill('SIGTERM') } catch {}
    await Promise.race<'exited' | 'timeout'>([
      new Promise<'exited'>((resolve) => {
        const unsub = handle.onExit(() => {
          try { unsub() } catch {}
          resolve('exited')
        })
      }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000)),
    ]).then((result) => {
      if (result === 'timeout') {
        try { handle.kill('SIGKILL') } catch {}
      }
    })
  } else {
    const pid = session.process_pid as number
    try { process.kill(pid, 'SIGTERM') } catch {}
    const deadline = Date.now() + 5000
    let gone = false
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 250))
      try { process.kill(pid, 0) } catch { gone = true; break }
    }
    if (!gone) {
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
    updateSession(db, id, { process_pid: null, process_started_at: null })
    registryUnregister(id)
    store.recordEvent({ type: 'session.exited', ts: Date.now(), id, exit_code: -1 })
  }

  return c.body(null, 204)
})

// PATCH /api/sessions/:id { title?, working_dir?, last_activity_at?, archived?, pinned?, prd_spec_ids? }
sessionsRouter.patch('/api/sessions/:id', async (c) => {
  const id = c.req.param('id')
  let body: {
    title?: unknown
    working_dir?: unknown
    last_activity_at?: unknown
    archived?: unknown
    pinned?: unknown
    prd_spec_ids?: unknown
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const db = getDb()
  const existing = getSessionById(db, id)
  if (!existing) {
    return c.json({ error: 'session_not_found', details: { id } }, 404)
  }

  const patch: {
    title?: string | null
    working_dir?: string | null
    last_activity_at?: number | null
    archived?: boolean
    pinned?: boolean
  } = {}
  if ('title' in body) {
    if (typeof body.title === 'string' || body.title === null) patch.title = body.title
  }
  if ('working_dir' in body) {
    if (typeof body.working_dir === 'string' || body.working_dir === null) patch.working_dir = body.working_dir
  }
  if ('last_activity_at' in body) {
    if (typeof body.last_activity_at === 'number' || body.last_activity_at === null) {
      patch.last_activity_at = body.last_activity_at
    }
  }
  if ('archived' in body && typeof body.archived === 'boolean') patch.archived = body.archived
  if ('pinned' in body && typeof body.pinned === 'boolean') patch.pinned = body.pinned

  let prd_spec_ids: string[] | null = null
  if ('prd_spec_ids' in body) {
    if (!Array.isArray(body.prd_spec_ids) || !body.prd_spec_ids.every((x) => typeof x === 'string')) {
      return c.json({ error: 'prd_spec_ids_invalid' }, 400)
    }
    prd_spec_ids = body.prd_spec_ids as string[]
    for (const psid of prd_spec_ids) {
      const ps = getPrdSpecById(db, psid)
      if (!ps || ps.project_id !== existing.project_id) {
        return c.json(
          { error: 'prd_spec_not_found_for_project', details: { prd_spec_id: psid } },
          404,
        )
      }
    }
  }

  updateSession(db, id, patch)
  if (prd_spec_ids !== null) {
    setSessionPrds(db, id, prd_spec_ids)
    store.recordEvent({
      type: 'session.prds.updated',
      ts: Date.now(),
      session_id: id,
      prd_spec_ids,
    })
  }
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
    return c.json({ error: 'session_not_found', details: { id } }, 404)
  }

  hardDeleteSession(db, id)

  if (purge && existing.jsonl_path) {
    try {
      await unlink(existing.jsonl_path)
    } catch (err: unknown) {
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
