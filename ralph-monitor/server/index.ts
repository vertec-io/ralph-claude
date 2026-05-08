import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { readFile, writeFile, stat, mkdir, rename } from 'node:fs/promises'
import { resolve, isAbsolute, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { store } from './store'
import { startWatchers } from './watchers'
import { agents } from './agents'
import { getDb, listProjects } from './db'
import { projectsRouter } from './routes/projects'
import { sessionsRouter } from './routes/sessions'
import { prdsRouter } from './routes/prds'
import { fsRouter } from './routes/fs'
import { buildLifecycleSnapshot } from './routes/lifecycle'
import { reconcileSessionsOnStartup } from './sessions/reconcile'
import {
  discoverProjectSessions,
  scanProjectTasks,
  startProjectWatchers,
} from './projectDiscovery'
import { bearerMiddleware, getOrCreateToken, validateWebSocketSubprotocol } from './auth'
import {
  attachWsToSession,
  detachWsFromSession,
  handleWsMessage,
  type WsBridgeData,
} from './sessions/wsBridge'
import type { AppEvent } from './types'
import type { Server, ServerWebSocket } from 'bun'

// Refuse to bind to anything except 127.0.0.1.
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
  } catch {}
  console.error(msg)
  process.exit(1)
}

getDb()

const reconcileResult = await reconcileSessionsOnStartup()
console.log(
  `reconcile: ${reconcileResult.liveOrphanedCount} live-orphaned, ${reconcileResult.dormantCount} dormant`,
)

// Bring up per-project discovery for every project in the DB at boot.
// Each project gets:
//   - A one-shot initial scan of ~/.claude/projects/<encoded(root)>/*.jsonl
//     (and worktrees) to upsert sessions whose JSONL exists on disk.
//   - A ./tasks/*/prd.json scan to upsert prd_specs.
//   - Chokidar watchers on both so new files appear live.
for (const project of listProjects(getDb(), {})) {
  void discoverProjectSessions(project).catch((err) => {
    console.warn(`[boot] discoverProjectSessions failed for ${project.id}:`, err)
  })
  void scanProjectTasks(project).catch((err) => {
    console.warn(`[boot] scanProjectTasks failed for ${project.id}:`, err)
  })
  startProjectWatchers(project)
}

getOrCreateToken()

const app = new Hono()

app.use('/*', cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }))

app.get('/api/dev-token', (c) => {
  const host = c.req.header('host') ?? ''
  const isLoopback = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)
  if (!isLoopback) return c.json({ error: 'not_found' }, 404)
  return c.json({ token: getOrCreateToken() })
})

const auth = bearerMiddleware()
app.use('/api/*', auth)
app.use('/events', auth)
app.use('/events/*', auth)

app.route('/', projectsRouter)
app.route('/', sessionsRouter)
app.route('/', prdsRouter)
app.route('/', fsRouter)

app.get('/api/state', (c) => c.json(store.snapshot()))

app.get('/events', (c) => {
  return streamSSE(c, async (stream) => {
    let id: number | undefined
    stream.onAbort(() => { if (id !== undefined) store.unsubscribe(id) })

    const snapshot = buildLifecycleSnapshot(getDb())
    await stream.writeSSE({
      event: 'lifecycle.snapshot',
      data: JSON.stringify(snapshot),
    })

    await stream.writeSSE({
      event: 'state',
      data: JSON.stringify(store.snapshot()),
    })

    id = store.subscribe(async (chunk) => {
      await stream.write(chunk)
    })

    while (!stream.aborted) {
      await stream.sleep(15_000)
      await stream.writeSSE({ event: 'ping', data: String(Date.now()) })
    }
  })
})

// Hook receiver — Claude Code hooks POST a JSON body here.
app.post('/event', async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ ok: false }, 400) }

  if (process.env.RALPH_MONITOR_DEBUG_HOOKS !== 'false') {
    const summary = {
      hook: body?.hook_event_name,
      tool: body?.tool_name,
      tool_use_id: body?.tool_use_id?.slice?.(0, 12),
      cwd: body?.cwd?.split('/').slice(-2).join('/'),
      tool_input_keys: body?.tool_input ? Object.keys(body.tool_input) : undefined,
    }
    console.log('[hook]', JSON.stringify(summary))
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

  const prds = store.snapshot().prds
  const cwd = typeof body?.cwd === 'string' ? body.cwd : undefined
  const filePath = typeof body?.tool_input?.file_path === 'string' ? body.tool_input.file_path : undefined
  const match = prds.find(p => {
    if (cwd && (cwd === p.worktreeDir || cwd.startsWith(p.worktreeDir + '/'))) return true
    if (filePath && (filePath === p.worktreeDir || filePath.startsWith(p.worktreeDir + '/'))) return true
    return false
  })
  if (match) evt.unitName = match.unitName

  if (match) {
    const ti = body?.tool_input ?? {}
    const text = stringifyToolInput(ti)
    const ids = extractStoryIds(text)
    for (const id of ids) store.markStoryActivity(match.unitName, id)

    const filePath = typeof ti.file_path === 'string' ? ti.file_path : undefined
    const detailParts: string[] = []
    if (toolName) detailParts.push(toolName)
    if (filePath) detailParts.push(filePath.split('/').slice(-2).join('/'))
    if (ids.length > 0) detailParts.push(`→ ${ids.slice(0, 3).join(', ')}`)
    if (detailParts.length > 0) evt.detail = detailParts.join(' ')

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

const STORY_ID_RE = /\bUS-[A-Za-z0-9][A-Za-z0-9-]*/g
function extractStoryIds(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(STORY_ID_RE)) out.add(m[0])
  return [...out]
}

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
    if (typeof body.expectedMtime === 'number') {
      try {
        const cur = await stat(body.path)
        if (Math.abs(cur.mtimeMs - body.expectedMtime) > 1) {
          return c.json({
            error: 'file modified externally since open',
            currentMtime: cur.mtimeMs,
          }, 409)
        }
      } catch {}
    }
    await writeFile(body.path, body.content, 'utf-8')
    const st = await stat(body.path)
    return c.json({ ok: true, mtime: st.mtimeMs, size: st.size })
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500)
  }
})

app.get('/api/health', (c) => c.json({ ok: true, prds: store.snapshot().prds.length }))

await startWatchers()

const port = Number(process.env.RALPH_MONITOR_PORT ?? 7777)
console.log(`ralph-monitor server listening on http://127.0.0.1:${port}`)
console.log(`UI dev: bun run dev:ui (then open http://localhost:5173)`)

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
  hostname: '127.0.0.1',
  fetch,
  websocket,
  idleTimeout: 0,
}
