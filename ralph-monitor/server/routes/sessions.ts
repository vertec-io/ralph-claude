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
import { streamSSE } from 'hono/streaming'
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
  resumeSession,
  getSpawner,
  EffortNotFoundError,
  CwdResolutionError,
  OneLiveSessionPerEffortPrepError,
  SessionNotFoundError,
  SessionAlreadyLiveError,
  SessionInGraceWindowError,
  JsonlMissingError,
} from '../sessions/spawn'
import { computeSessionStatus } from '../sessions/status'
import { get as registryGet, unregister as registryUnregister } from '../sessions/registry'
import { isPathInProjectOrWorktree } from '../git/worktrees'
import { attachTailer } from '../jsonl/tailer'

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

// GET /api/sessions/:id (US-006)
//
// Returns the session row plus a computed status field so callers can tell
// at a glance whether the session is dormant, live and attached to our PTY,
// live but orphaned (process still running but no PTY parent), or in the
// post-exit replay-grace window. `live` and `attached` are derived from
// `status` for convenience: AC requires live-orphaned to expose
// `{ status: 'live-orphaned', live: true, attached: false }`, and we expose
// the same shape on every status for consistency.
sessionsRouter.get('/api/sessions/:id', (c) => {
  const id = c.req.param('id')
  const session = getSessionById(getDb(), id)
  if (!session) {
    return c.json({ error: 'session_not_found', details: { id } }, 404)
  }
  const status = computeSessionStatus(session)
  return c.json({
    ...session,
    status,
    live: status === 'live-attached' || status === 'live-orphaned',
    attached: status === 'live-attached',
  })
})

// GET /api/sessions/:id/transcript/stream — US-010
//
// Per-session SSE channel for live JSONL tail. Distinct from /events (which
// is the app-wide lifecycle/PRD broadcast). On connect we emit a `snapshot`
// with the current turns; subsequent `turn` events arrive as Claude flushes
// new records to the .jsonl. On JSONL deletion we emit `gone` and close; on
// truncation we emit a fresh `snapshot`.
//
// One chokidar watcher per session id is shared across SSE clients (see
// server/jsonl/tailer.ts). Each client has its own per-subscriber byte-offset
// so two clients on the same session see the same `change` event but each
// resumes from the boundary it observed at attach.
sessionsRouter.get('/api/sessions/:id/transcript/stream', async (c) => {
  const id = c.req.param('id')
  const session = getSessionById(getDb(), id)
  if (!session) {
    return c.json({ error: 'session_not_found', details: { id } }, 404)
  }
  const jsonlPath = session.jsonl_path
  if (!jsonlPath) {
    // Session row exists but has no on-disk path — nothing to tail.
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
      } catch {
        // Client likely went away mid-write; the abort handler will clean up.
      }
      if (event.type === 'gone' && !goneClosed) {
        goneClosed = true
        try {
          await stream.close()
        } catch {}
      }
    })

    // Hold the handler open until the client disconnects (or the file goes
    // away). Hono's streamSSE closes the response when this callback returns.
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        if (detach) {
          detach()
          detach = null
        }
        resolve()
      })
      // If we already emitted `gone` and closed, abort fires synchronously
      // after this awaits — handled by the onAbort listener above. No extra
      // wiring needed.
    })
  })
})

// POST /api/sessions/:id/resume — US-007
//
// Re-spawn `claude --resume <id>` for a dormant session. The row already
// exists; resumeSession reuses the same uuid (which is also the on-disk
// JSONL filename). Failures here NEVER hard-delete the row, because the
// row is the user's chat history and they may want to retry.
sessionsRouter.post('/api/sessions/:id/resume', async (c) => {
  const id = c.req.param('id')
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
    if (err instanceof OneLiveSessionPerEffortPrepError) {
      return c.json(
        { error: 'one_live_session_per_effort', details: { id } },
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

// POST /api/sessions/:id/kill — US-016c
//
// Sends SIGTERM to the session's process, waits up to 5 s for exit, then
// escalates to SIGKILL. Behaviour differs between attached and orphaned:
//
//   live-attached:  registry holds a PtyHandle → call handle.kill(). The PTY's
//                   existing onExit listener (in spawn.ts) will fire naturally
//                   and clear process_pid / process_started_at in the DB plus
//                   emit session.exited. We do NOT duplicate that cleanup here.
//
//   live-orphaned:  no registry entry (PTY parent died). We signal the OS PID
//                   directly via process.kill(). Since there is no onExit
//                   listener, this handler MUST clear the DB fields and emit
//                   session.exited itself. exit_code is -1 (sentinel meaning
//                   "killed by operator with no observed exit code — the PTY was
//                   already orphaned so the natural exit path never fired").
//
//   dormant/exited: 409 — nothing to kill. Idempotent contract: caller can
//                   retry without surprise but won't get a 204 after the first.
//
// The JSONL file is intentionally NOT deleted — kill is a process action, not
// a data action. The transcript is preserved for inspection and future resume.
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
    // Attached path: delegate to the PTY handle. The existing onExit listener
    // wired up in spawn.ts will clear DB fields and emit session.exited —
    // we must NOT do it here or we'd double-emit.
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
    // Orphaned path: registry has no handle (PTY parent died). Signal the OS
    // PID directly. Poll kill(pid, 0) every 250 ms for up to 5 s to detect
    // exit (ESRCH = process is gone). Because no onExit listener exists, we
    // are responsible for clearing DB fields and emitting the event.
    const pid = session.process_pid as number

    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }

    // Wait up to 5 s for the process to exit.
    const deadline = Date.now() + 5000
    let gone = false
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 250))
      try {
        process.kill(pid, 0) // throws ESRCH when process is gone
      } catch {
        gone = true
        break
      }
    }

    if (!gone) {
      // Escalate to SIGKILL after timeout.
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }

    // Clear DB fields — the natural exit path won't fire for orphaned sessions.
    updateSession(db, id, { process_pid: null, process_started_at: null })
    // Defensively unregister in case a stale entry somehow exists.
    registryUnregister(id)
    // Emit session.exited. exit_code -1 = operator-killed orphan (no PTY exit
    // code observable; chosen as a sentinel that distinguishes "we killed it"
    // from a natural 0/non-zero exit).
    store.recordEvent({ type: 'session.exited', ts: Date.now(), id, exit_code: -1 })
  }

  return c.body(null, 204)
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
