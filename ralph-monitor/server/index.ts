import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { readFile, writeFile, stat, mkdir, rename } from 'node:fs/promises'
import { resolve, isAbsolute, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { store } from './store'
import { startWatchers } from './watchers'
import { agents } from './agents'
import { getDb } from './db'
import { projectsRouter } from './routes/projects'
import { effortsRouter } from './routes/efforts'
import { sessionsRouter } from './routes/sessions'
import { buildLifecycleSnapshot } from './routes/lifecycle'
import { bearerMiddleware, getOrCreateToken, validateWebSocketSubprotocol } from './auth'
import {
  attachWsToSession,
  detachWsFromSession,
  handleWsMessage,
  type WsBridgeData,
} from './sessions/wsBridge'
import type { AppEvent } from './types'
import type { Server, ServerWebSocket } from 'bun'

// US-004: refuse to bind to anything except 127.0.0.1. ralph-monitor's
// security model assumes loopback-only — exposing the API on a routable
// interface would let any host on the LAN reach the same endpoints with
// nothing but the bearer token (which lives in a 0o600 file in the user's
// HOME). We surface the refusal in two places: stderr (so the launching shell
// sees it) and ~/.config/ralph-monitor/last-error.txt (so a service launcher
// like systemd can show the same message after the process exits).
//
// MUST run before any DB/server bring-up so a misconfigured launch fails
// before touching any state.
const RALPH_MONITOR_BIND = process.env.RALPH_MONITOR_BIND ?? '127.0.0.1'
if (RALPH_MONITOR_BIND !== '127.0.0.1') {
  const msg =
    'ralph-monitor refuses to bind to non-loopback address. ' +
    'Set RALPH_MONITOR_BIND=127.0.0.1 or unset it. Network exposure is not supported in v1.'
  const errPath = join(homedir(), '.config', 'ralph-monitor', 'last-error.txt')
  try {
    await mkdir(dirname(errPath), { recursive: true, mode: 0o700 })
    const tmp = errPath + '.tmp'
    await writeFile(tmp, msg + '\n', { encoding: 'utf8' })
    await rename(tmp, errPath)
  } catch {
    // Even if we can't write the file, stderr + non-zero exit still happens.
  }
  console.error(msg)
  process.exit(1)
}

// Initialize sqlite + apply migrations on startup. Lazy inside getDb(), but we
// invoke once eagerly so any schema problem fails loudly at boot rather than
// at the first request that touches the DB.
getDb()

// Materialize the auth token early. Generates and writes to disk on first
// boot; subsequent boots reuse the existing file. Doing this eagerly means
// the dev-token endpoint has nothing async to do at request time.
getOrCreateToken()

const app = new Hono()

app.use('/*', cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }))

// Dev-token endpoint MUST be registered before bearerMiddleware mounts on
// /api/* — the whole point is that the UI can fetch the token without
// already having one. The endpoint additionally guards itself: it only
// returns the token when the request's Host header is loopback, so even if
// some future change accidentally exposes the API to a routable interface
// the token still doesn't leak.
app.get('/api/dev-token', (c) => {
  const host = c.req.header('host') ?? ''
  // Match 127.0.0.1[:port] or localhost[:port]. We're deliberately strict —
  // 0.0.0.0, ::1, and other loopback aliases are not accepted because we
  // refuse to bind to them in the first place.
  const isLoopback = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)
  if (!isLoopback) return c.json({ error: 'not_found' }, 404)
  return c.json({ token: getOrCreateToken() })
})

// Bearer auth on all API and event-stream routes. Static assets (the
// vite-built UI) and the /event hook receiver are NOT under /api/* and so
// stay unauthenticated by virtue of path scoping. The /event hook is invoked
// by Claude Code hooks running on the same machine — we trust the loopback
// boundary there too.
const auth = bearerMiddleware()
app.use('/api/*', auth)
app.use('/events', auth)
app.use('/events/*', auth)

// Project hierarchy REST endpoints (US-003).
app.route('/', projectsRouter)
app.route('/', effortsRouter)
app.route('/', sessionsRouter)

app.get('/api/state', (c) => c.json(store.snapshot()))

app.get('/events', (c) => {
  return streamSSE(c, async (stream) => {
    let id: number | undefined
    stream.onAbort(() => { if (id !== undefined) store.unsubscribe(id) })

    // Lifecycle snapshot (US-003). MUST go out before subscribing this client
    // to the broadcast channel — if we subscribed first, an in-flight event
    // could interleave between this snapshot and the client receiving it,
    // creating the very fetch-then-subscribe race window the snapshot exists
    // to close.
    //
    // live_session_ids comes from the in-memory PTY handle registry
    // (server/sessions/registry.ts, US-005a-1). The builder reads it
    // directly when no override is passed.
    const snapshot = buildLifecycleSnapshot(getDb())
    await stream.writeSSE({
      event: 'lifecycle.snapshot',
      data: JSON.stringify(snapshot),
    })

    // Initial state snapshot for the existing PRD-tracking surface. Kept after
    // lifecycle.snapshot so older clients that consume both still parse the
    // PRD/state event the same way they always did.
    await stream.writeSSE({
      event: 'state',
      data: JSON.stringify(store.snapshot()),
    })

    // Subscribe to fan-out
    id = store.subscribe(async (chunk) => {
      // chunk is a pre-formatted "event: X\ndata: Y\n\n" string.
      // Hono's streamSSE escapes via writeSSE — we need raw write.
      await stream.write(chunk)
    })

    // Keep open until client disconnects. Hono's streamSSE auto-pings via writeSSE,
    // but we hold here using a sleep loop just to keep the function alive.
    while (!stream.aborted) {
      await stream.sleep(15_000)
      await stream.writeSSE({ event: 'ping', data: String(Date.now()) })
    }
  })
})

// Hook receiver — Claude Code hooks POST a JSON body here.
// Body shape (per Claude Code hook spec):
//   { hook_event_name, session_id, cwd, transcript_path, tool_name?, tool_input?, ... }
app.post('/event', async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ ok: false }, 400) }

  // DEBUG: log every hook payload's high-level shape so we can see what
  // Claude Code is actually sending. Especially: which hook_event_name,
  // which tool_name, whether tool_use_id is present.
  if (process.env.RALPH_MONITOR_DEBUG_HOOKS !== 'false') {
    const summary = {
      hook: body?.hook_event_name,
      tool: body?.tool_name,
      tool_use_id: body?.tool_use_id?.slice?.(0, 12),
      cwd: body?.cwd?.split('/').slice(-2).join('/'),
      tool_input_keys: body?.tool_input ? Object.keys(body.tool_input) : undefined,
    }
    console.log('[hook]', JSON.stringify(summary))
    // Also dump full body to a debug file so we can grep history
    try {
      const { appendFile } = await import('node:fs/promises')
      await appendFile(
        '/tmp/ralph-monitor-hooks.log',
        new Date().toISOString() + ' ' + JSON.stringify(body) + '\n',
      )
    } catch {}
  }

  const toolName: string | undefined = body?.tool_name
  const evt: AppEvent = {
    ts: Date.now(),
    type:
      body?.hook_event_name === 'Stop' ? 'hook.stop' :
      body?.hook_event_name === 'UserPromptSubmit' ? 'hook.user_prompt' :
      'hook.tool_use',
    detail: toolName ? `${toolName}` : undefined,
  }

  // Match the event to a registered PRD. Try cwd first (orchestrator's
  // cwd is the worktree), then fall back to tool_input.file_path (sub-agents
  // may run with a different cwd but they still touch files inside the
  // worktree). This is what attributes sub-agent Edit/Write events correctly.
  const prds = store.snapshot().prds
  const cwd = typeof body?.cwd === 'string' ? body.cwd : undefined
  const filePath = typeof body?.tool_input?.file_path === 'string' ? body.tool_input.file_path : undefined
  const match = prds.find(p => {
    if (cwd && (cwd === p.worktreeDir || cwd.startsWith(p.worktreeDir + '/'))) return true
    if (filePath && (filePath === p.worktreeDir || filePath.startsWith(p.worktreeDir + '/'))) return true
    return false
  })
  if (match) evt.unitName = match.unitName

  // Story-ID extraction runs for ANY tool call, not just Task/Agent.
  // Edit/Write's tool_input (file_path, new_string, content) routinely contains
  // story IDs — e.g. editing prd.json, writing decisions/US-XXX.md, appending
  // to progress.txt. Without this we'd miss most main-thread orchestrator work.
  if (match) {
    const ti = body?.tool_input ?? {}
    const text = stringifyToolInput(ti)
    const ids = extractStoryIds(text)
    for (const id of ids) store.markStoryActivity(match.unitName, id)

    // Useful detail in event feed: tool name + file/story summary
    const filePath = typeof ti.file_path === 'string' ? ti.file_path : undefined
    const detailParts: string[] = []
    if (toolName) detailParts.push(toolName)
    if (filePath) detailParts.push(filePath.split('/').slice(-2).join('/'))
    if (ids.length > 0) detailParts.push(`→ ${ids.slice(0, 3).join(', ')}`)
    if (detailParts.length > 0) evt.detail = detailParts.join(' ')

    // Task-specific lifecycle tracking via tool_use_id (PreToolUse → PostToolUse).
    // Only fires if the orchestrator's session was started after hooks were
    // installed. Pre-existing sessions miss this entirely.
    if (toolName === 'Task' || toolName === 'Agent') {
      const toolUseId = body?.tool_use_id
      if (toolUseId && body?.hook_event_name === 'PreToolUse') {
        agents.noteStart(match.unitName, {
          id: toolUseId,
          startedAt: Date.now(),
          status: 'running',
          description: typeof ti.description === 'string' ? ti.description : undefined,
          storyIds: ids,
          subagentType: typeof ti.subagent_type === 'string' ? ti.subagent_type : undefined,
          model: typeof ti.model === 'string' ? ti.model : undefined,
        })
      } else if (toolUseId && body?.hook_event_name === 'PostToolUse') {
        agents.noteEnd(match.unitName, toolUseId)
      }
    }

    // Agent-id-based session tracking — works regardless of when hooks were
    // installed, because every sub-agent hook event includes an agent_id.
    // This is the reliable surface for "what sub-agents are running right now".
    const agentId = typeof body?.agent_id === 'string' ? body.agent_id : undefined
    if (agentId) {
      const isStop = body?.hook_event_name === 'SubagentStop'
      agents.noteAgentActivity(match.unitName, {
        agentId,
        agentType: typeof body?.agent_type === 'string' ? body.agent_type : undefined,
        storyIds: ids,
        filePath,
        isStop,
      })
    }
  }

  store.recordEvent(evt)
  return c.json({ ok: true })
})

function stringifyToolInput(input: unknown): string {
  if (typeof input === 'string') return input
  try { return JSON.stringify(input ?? '') } catch { return '' }
}

// Match story IDs like US-101a, US-100-K-A, US-DG-EDITOR-SCOPE.
// Permissive: word boundary, US-, then alphanumerics + hyphens.
const STORY_ID_RE = /\bUS-[A-Za-z0-9][A-Za-z0-9-]*/g
function extractStoryIds(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(STORY_ID_RE)) out.add(m[0])
  return [...out]
}

// File read/write — restricted to paths inside registered PRD task/worktree dirs.

function isPathAllowed(path: string): boolean {
  if (!isAbsolute(path)) return false
  const resolved = resolve(path)
  const prds = store.snapshot().prds
  for (const p of prds) {
    const taskDir = resolve(p.taskDir)
    const worktreeDir = resolve(p.worktreeDir)
    if (resolved === taskDir || resolved.startsWith(taskDir + '/')) return true
    if (resolved === worktreeDir || resolved.startsWith(worktreeDir + '/')) return true
  }
  return false
}

app.get('/api/file', async (c) => {
  const path = c.req.query('path')
  if (!path) return c.json({ error: 'path required' }, 400)
  if (!isPathAllowed(path)) return c.json({ error: 'path not in any registered PRD' }, 403)
  try {
    const [content, st] = await Promise.all([readFile(path, 'utf-8'), stat(path)])
    return c.json({ content, mtime: st.mtimeMs, size: st.size })
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 404)
  }
})

app.put('/api/file', async (c) => {
  let body: { path?: string; content?: string; expectedMtime?: number }
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  if (!body.path || typeof body.content !== 'string') {
    return c.json({ error: 'path and content required' }, 400)
  }
  if (!isPathAllowed(body.path)) return c.json({ error: 'path not in any registered PRD' }, 403)
  try {
    // Optimistic concurrency: if expectedMtime provided, ensure file hasn't changed since then.
    if (typeof body.expectedMtime === 'number') {
      try {
        const cur = await stat(body.path)
        if (Math.abs(cur.mtimeMs - body.expectedMtime) > 1) {
          return c.json({
            error: 'file modified externally since open',
            currentMtime: cur.mtimeMs,
          }, 409)
        }
      } catch { /* file might not exist yet — that's fine */ }
    }
    await writeFile(body.path, body.content, 'utf-8')
    const st = await stat(body.path)
    return c.json({ ok: true, mtime: st.mtimeMs, size: st.size })
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
})

// Health
app.get('/api/health', (c) => c.json({ ok: true, prds: store.snapshot().prds.length }))

await startWatchers()

const port = Number(process.env.RALPH_MONITOR_PORT ?? 7777)
console.log(`ralph-monitor server listening on http://127.0.0.1:${port}`)
console.log(`UI dev: bun run dev:ui (then open http://localhost:5173)`)

// WebSocket upgrade handling for /ws/sessions/:id (US-005b).
//
// Hono's upgradeWebSocket helper does NOT expose Sec-WebSocket-Protocol
// negotiation, so we go straight at Bun.serve's primitives:
//   1. fetch detects WS-upgrade requests on /ws/sessions/:id BEFORE Hono.
//   2. We validate the bearer subprotocol via validateWebSocketSubprotocol.
//   3. We call server.upgrade with `headers: { 'Sec-WebSocket-Protocol': matched }`
//      so Bun emits the matched subprotocol in its handshake response.
//      RFC 6455 §4.2.2 requires the server echo a subprotocol the client
//      offered, otherwise the browser aborts the connection.
//   4. The matched session id is stashed in `data` so the websocket handler
//      can read it via `ws.data.sessionId`.
//
// Non-/ws/sessions/ requests fall through to Hono's app.fetch unchanged so
// the existing API + /events SSE keep working without any reshape.
async function fetch(
  this: Server<WsBridgeData>,
  req: Request,
  server: Server<WsBridgeData>,
): Promise<Response | undefined> {
  const url = new URL(req.url)
  if (url.pathname.startsWith('/ws/sessions/')) {
    const sessionId = url.pathname.slice('/ws/sessions/'.length)
    if (!sessionId || sessionId.includes('/')) {
      return new Response('missing_session_id', { status: 400 })
    }
    const subprotocol = validateWebSocketSubprotocol(
      req.headers.get('sec-websocket-protocol'),
    )
    if (subprotocol === null) {
      return new Response('unauthorized', { status: 401 })
    }
    const upgraded = server.upgrade(req, {
      headers: { 'Sec-WebSocket-Protocol': subprotocol },
      data: { sessionId },
    })
    if (upgraded) return undefined
    return new Response('upgrade_failed', { status: 500 })
  }
  // Hono's app.fetch is `(req, env?, executionCtx?) => Response | Promise<Response>`
  // — its second arg shape is for Cloudflare Workers, not Bun. Pass req only.
  return app.fetch(req)
}

const websocket = {
  open(ws: ServerWebSocket<WsBridgeData>): void {
    attachWsToSession(ws)
  },
  message(ws: ServerWebSocket<WsBridgeData>, data: string | Buffer): void {
    handleWsMessage(ws, data)
  },
  close(ws: ServerWebSocket<WsBridgeData>, _code: number, _reason: string): void {
    detachWsFromSession(ws)
  },
}

export default {
  port,
  // Hard-coded loopback. The startup guard above already refuses to run if
  // RALPH_MONITOR_BIND was set to anything else, so we don't even read the
  // env var here — what comes in via that var is only allowed to be the
  // value we'd hard-code anyway.
  hostname: '127.0.0.1',
  fetch,
  websocket,
  idleTimeout: 0,  // SSE connections are long-lived
}
