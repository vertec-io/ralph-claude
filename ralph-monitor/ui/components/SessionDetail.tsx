// Session detail shell (US-016a).
//
// Renders the full detail view for a selected session: header with
// effort/project breadcrumb + status badge + view-mode toggle; main pane
// that switches between the Chat transcript (US-009) and the raw PTY stream
// (US-011); and a footer chat-input box wired to the WebSocket when the
// session is live-attached.
//
// WebSocket gating:
//   The WS connection is opened ONLY when session.status === 'live-attached'.
//   On status transitions (e.g. session goes dormant mid-view) the effect
//   cleanup closes the socket and wsRef is nulled. Re-mounting (new sessionId)
//   tears down the previous socket via the same cleanup. If the session
//   transitions back to live-attached (e.g. after Resume in US-016b), the
//   effect re-runs and opens a fresh socket — this story does not poll for
//   status updates; US-016b will add the live-status SSE subscription.
//
// Resume:
//   A basic resume button is rendered in the footer for non-live sessions so
//   the detail is functional without US-016b. US-016b will expand this with a
//   live-status subscription and richer UX.
//
// Kill button:
//   Not wired here — US-016c handles it.
//
// Typecheck notes:
//   Session from server/db carries `working_dir: string | null`. The GET
//   /api/sessions/:id response also adds `status`, `live`, `attached`; we
//   model those as an intersection type local to this component.

import { useState, useEffect, useRef } from 'react'
import { authFetch, authEventSource, authWebSocket } from '../auth'
import { SessionTranscript } from './SessionTranscript'
import { SessionStream } from './SessionStream'
import { ViewModeToggle, type ViewMode } from './ViewModeToggle'
import type { Session, Project, Effort } from '../../server/db/index'
import type { Turn } from '../../server/jsonl/parser'

// The GET /api/sessions/:id response extends the DB row with computed fields.
type SessionWithStatus = Session & {
  status: 'dormant' | 'live-attached' | 'live-orphaned' | 'exited'
  live: boolean
  attached: boolean
}

export interface SessionDetailProps {
  sessionId: string
  // Provided by parent (App.tsx) for breadcrumb context.
  project: Project | null
  effort: Effort | null
}

export function SessionDetail({ sessionId, project, effort }: SessionDetailProps) {
  const [session, setSession] = useState<SessionWithStatus | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [mode, setMode] = useState<ViewMode>('chat')
  const [input, setInput] = useState('')
  const [resuming, setResuming] = useState(false)
  const [resumeError, setResumeError] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  // Fetch the session row + computed status on mount (or sessionId change).
  useEffect(() => {
    let cancelled = false
    setSession(null)
    setResumeError(null)
    ;(async () => {
      try {
        const res = await authFetch(`/api/sessions/${sessionId}`)
        if (!res.ok) {
          if (!cancelled) setSession(null)
          return
        }
        const data = await res.json() as SessionWithStatus
        if (!cancelled) setSession(data)
      } catch {
        // Network error — leave session as null (loading indicator stays).
      }
    })()
    return () => { cancelled = true }
  }, [sessionId])

  // Subscribe to transcript SSE for live turn updates (US-010).
  // Always subscribed — the server emits a `snapshot` on connect and
  // subsequent `turn` events as Claude writes new records. A `gone` event
  // means the JSONL was deleted (session purged from disk).
  useEffect(() => {
    if (!sessionId) return

    // authEventSource requires the token to have been loaded (getTokenSync).
    // authFetch (called by the session-fetch above) ensures that. If for some
    // reason this fires before the token is ready, it throws synchronously and
    // we let it bubble — the user will see an uncaught error rather than a
    // silent blank pane.
    let es: EventSource
    try {
      es = authEventSource(`/api/sessions/${sessionId}/transcript/stream`)
    } catch {
      // Token not yet loaded — skip SSE subscription for now. The session
      // fetch useEffect will eventually load the token; a re-render can retry.
      return
    }

    es.addEventListener('snapshot', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { turns?: Turn[] }
        setTurns(data.turns ?? [])
      } catch {
        // Malformed JSON — ignore; keep existing turns.
      }
    })

    es.addEventListener('turn', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { turn: Turn }
        setTurns(prev => [...prev, data.turn])
      } catch {
        // Ignore malformed event.
      }
    })

    es.addEventListener('gone', () => {
      setTurns([])
    })

    return () => es.close()
  }, [sessionId])

  // WebSocket for live input — only when session is live-attached.
  // Opened fresh each time the sessionId or status changes.
  useEffect(() => {
    if (!session || session.status !== 'live-attached') {
      // Close any stale socket from a prior status.
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      return
    }

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${window.location.host}/ws/sessions/${sessionId}`
    let ws: WebSocket
    try {
      ws = authWebSocket(url)
    } catch {
      // Token not loaded yet — skip. Will retry when status changes again.
      return
    }
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [sessionId, session?.status])

  function sendInput() {
    const text = input.trim()
    if (!text) return
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('[SessionDetail] WebSocket not open; cannot send input')
      return
    }
    ws.send(JSON.stringify({ type: 'input', data: text + '\r' }))
    setInput('')
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendInput()
    }
    // Shift+Enter: browser default inserts a newline — no extra handling.
  }

  async function handleResume() {
    if (resuming) return
    setResuming(true)
    setResumeError(null)
    try {
      const res = await authFetch(`/api/sessions/${sessionId}/resume`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setResumeError(body.error ?? `resume failed (${res.status})`)
        return
      }
      // Re-fetch session to pick up new status; US-016b will do this via SSE.
      const updated = await authFetch(`/api/sessions/${sessionId}`)
      if (updated.ok) {
        setSession(await updated.json() as SessionWithStatus)
      }
    } catch (err) {
      setResumeError(String((err as Error)?.message ?? err))
    } finally {
      setResuming(false)
    }
  }

  if (!session) {
    return <div className="p-4 text-sm text-zinc-500">Loading session…</div>
  }

  // Header data.
  const projectName = project?.name ?? '(no project)'
  const effortName = effort?.name ?? '(no effort)'
  const sessionTitle = session.title ?? sessionId.slice(0, 8)

  // CWD chips: show a "Working on: <effort-basename>" chip always (when
  // effort.working_dir is set); show a separate "cwd: <basename>" chip ONLY
  // when the session's resolved working_dir differs from the effort's.
  const cwdBasename = session.working_dir ? pathBasename(session.working_dir) : null
  const effortBasename = effort?.working_dir ? pathBasename(effort.working_dir) : null
  const showSeparateCwdChip =
    cwdBasename !== null &&
    effortBasename !== null &&
    cwdBasename !== effortBasename

  // Stream mode is only meaningful when the session is live-attached.
  const streamDisabled = session.status !== 'live-attached'
  const streamDisabledTooltip =
    session.status === 'dormant'
      ? 'Resume to enable Stream'
      : session.status === 'live-orphaned'
        ? 'PTY unreachable; kill & resume to regain control'
        : session.status === 'exited'
          ? 'Session exited; resume to enable Stream'
          : 'Stream unavailable'

  // When stream mode becomes disabled, fall back to chat to avoid showing a
  // broken/stale stream pane.
  const effectiveMode: ViewMode = streamDisabled && mode === 'stream' ? 'chat' : mode

  const isLive = session.status === 'live-attached'

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="border-b border-zinc-700/40 p-3 shrink-0">
        {/* Breadcrumb */}
        <div className="text-xs text-zinc-500 truncate" data-testid="session-breadcrumb">
          {projectName} / {effortName}
        </div>

        {/* Title row */}
        <div className="flex items-center gap-2 mt-1">
          <h2 className="font-semibold truncate" data-testid="session-title">
            {sessionTitle}
          </h2>
          <StatusBadge status={session.status} />
          <div className="ml-auto shrink-0">
            <ViewModeToggle
              mode={effectiveMode}
              onChange={setMode}
              streamDisabled={streamDisabled}
              streamDisabledTooltip={streamDisabledTooltip}
            />
          </div>
        </div>

        {/* CWD chips */}
        {(effortBasename || showSeparateCwdChip) && (
          <div className="flex gap-2 mt-1.5 flex-wrap">
            {effortBasename && (
              <Chip data-testid="chip-effort-cwd">Working on: {effortBasename}</Chip>
            )}
            {showSeparateCwdChip && cwdBasename && (
              <Chip data-testid="chip-session-cwd">cwd: {cwdBasename}</Chip>
            )}
          </div>
        )}
      </header>

      {/* Main pane */}
      <main className="flex-1 overflow-hidden">
        {effectiveMode === 'chat' ? (
          <SessionTranscript sessionId={sessionId} turns={turns} />
        ) : (
          <SessionStream
            sessionId={sessionId}
            status={session.status}
            authWebSocket={authWebSocket}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-700/40 p-2 shrink-0">
        {resumeError && (
          <div className="mb-2 text-xs text-rose-400 px-1">
            Resume failed: {resumeError}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <textarea
            data-testid="session-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              isLive
                ? 'Type a message — Enter to send, Shift+Enter for newline'
                : 'Resume to send'
            }
            disabled={!isLive}
            className="flex-1 min-h-[2.5rem] max-h-32 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm font-mono resize-none disabled:opacity-50 disabled:cursor-not-allowed"
            rows={1}
          />
          <button
            onClick={sendInput}
            disabled={!isLive || !input.trim()}
            data-testid="session-send"
            className="px-3 py-1 bg-blue-600 disabled:bg-zinc-700 rounded text-sm self-end h-[2.5rem]"
          >
            Send
          </button>
          {!isLive && (
            <button
              onClick={handleResume}
              disabled={resuming}
              data-testid="session-resume"
              className="px-3 py-1 bg-emerald-700 disabled:opacity-50 rounded text-sm self-end h-[2.5rem] whitespace-nowrap"
            >
              {resuming ? 'Resuming…' : 'Resume'}
            </button>
          )}
        </div>
      </footer>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'live-attached'
      ? 'bg-green-700 text-green-100'
      : status === 'live-orphaned'
        ? 'bg-yellow-700 text-yellow-100'
        : status === 'exited'
          ? 'bg-zinc-700 text-zinc-300'
          : /* dormant and unknown */ 'bg-zinc-600 text-zinc-200'
  return (
    <span
      className={`px-2 py-0.5 text-xs rounded shrink-0 ${cls}`}
      data-testid="status-badge"
    >
      {status}
    </span>
  )
}

function Chip({
  children,
  'data-testid': testId,
}: {
  children: React.ReactNode
  'data-testid'?: string
}) {
  return (
    <span
      className="px-2 py-0.5 bg-zinc-800 rounded text-xs text-zinc-300"
      data-testid={testId}
    >
      {children}
    </span>
  )
}

/**
 * Returns the last non-empty path segment of a POSIX or platform path.
 * Exported for unit tests.
 *
 * Examples:
 *   pathBasename('/home/user/project')  => 'project'
 *   pathBasename('/home/user/project/') => 'project'
 *   pathBasename('project')             => 'project'
 *   pathBasename('')                    => ''
 */
export function pathBasename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}
