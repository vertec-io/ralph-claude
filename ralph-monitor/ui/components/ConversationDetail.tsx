// ConversationDetail — the per-conversation view.
//
// Two tabs:
//   Chat   — PTY stream by default; toggle to rendered chat transcript.
//   PRD    — list of PRDs associated with this conversation + multi-select
//            to assign/unassign. Each linked PRD renders via PrdSnapshotPanels.
//
// Chat is the default. Rendered chat is the secondary view (same code as the
// old SessionDetail's chat mode), retained as a toggle.
//
// State machine for the input footer:
//   live-attached → textarea + Send
//   live-orphaned → disabled textarea + Kill & Resume
//   dormant       → disabled textarea + Resume
//   exited        → exit code + Resume

import { useState, useEffect, useRef } from 'react'
import { Pencil, FileText, MessageSquare, Copy, Check } from 'lucide-react'
import { authFetch, authEventSource, authWebSocket } from '../auth'
import { SessionTranscript } from './SessionTranscript'
import { SessionStream } from './SessionStream'
import { ViewModeToggle, type ViewMode } from './ViewModeToggle'
import { PrdSnapshotPanels } from './PrdSnapshotPanels'
import type { Session, Project, PrdSpec } from '../../server/db/index'
import type { Turn } from '../../server/jsonl/parser'
import type { LifecycleAppEvent, PRDJson } from '../../server/types'

type SessionStatus = 'dormant' | 'live-attached' | 'live-orphaned' | 'exited' | 'external-owned'

type SessionWithStatus = Session & {
  status: SessionStatus
  live: boolean
  attached: boolean
  external_owner_pid: number | null
  external_owner_comm: string | null
}

export interface ConversationDetailProps {
  conversationId: string
  project: Project | null
}

type Tab = 'chat' | 'prd'

export function ConversationDetail({ conversationId, project }: ConversationDetailProps) {
  const [session, setSession] = useState<SessionWithStatus | null>(null)
  const [exitCode, setExitCode] = useState<number | undefined>(undefined)
  const [turns, setTurns] = useState<Turn[]>([])
  const [tab, setTab] = useState<Tab>('chat')
  const [chatMode, setChatMode] = useState<ViewMode>('stream')
  const defaultedRef = useRef(false)
  const [input, setInput] = useState('')
  const [resuming, setResuming] = useState(false)
  const [resumeError, setResumeError] = useState<string | null>(null)
  const [killing, setKilling] = useState(false)
  const [killPhase, setKillPhase] = useState<'idle' | 'killing' | 'resuming'>('idle')
  const [takingOver, setTakingOver] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const [renamingTitle, setRenamingTitle] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const [copiedKind, setCopiedKind] = useState<'id' | 'cmd' | null>(null)

  // PRD tab state.
  const [linkedPrds, setLinkedPrds] = useState<PrdSpec[]>([])
  const [projectPrds, setProjectPrds] = useState<PrdSpec[]>([])

  useEffect(() => {
    if (renamingTitle && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingTitle])

  // Reset on conversation change.
  useEffect(() => {
    defaultedRef.current = false
    setChatMode('stream')
    setTab('chat')
  }, [conversationId])

  useEffect(() => {
    let cancelled = false
    setSession(null)
    setExitCode(undefined)
    setResumeError(null)
    ;(async () => {
      try {
        const res = await authFetch(`/api/sessions/${conversationId}`)
        if (!res.ok) {
          if (!cancelled) setSession(null)
          return
        }
        const data = (await res.json()) as SessionWithStatus
        if (!cancelled) setSession(data)
      } catch {}
    })()
    return () => { cancelled = true }
  }, [conversationId])

  // Once status is known, default chatMode.
  useEffect(() => {
    if (!session || defaultedRef.current) return
    defaultedRef.current = true
    if (session.status !== 'live-attached') {
      setChatMode('chat')
    }
  }, [session?.status])

  // Transcript SSE — always subscribed.
  useEffect(() => {
    if (!conversationId) return
    let es: EventSource
    try {
      es = authEventSource(`/api/sessions/${conversationId}/transcript/stream`)
    } catch {
      return
    }
    es.addEventListener('snapshot', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { turns?: Turn[] }
        setTurns(data.turns ?? [])
      } catch {}
    })
    es.addEventListener('turn', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { turn: Turn }
        setTurns((prev) => [...prev, data.turn])
      } catch {}
    })
    es.addEventListener('gone', () => setTurns([]))
    return () => es.close()
  }, [conversationId])

  // Lifecycle SSE — listen for status updates.
  useEffect(() => {
    if (!conversationId) return
    let es: EventSource
    try {
      es = authEventSource('/events')
    } catch {
      return
    }
    es.addEventListener('update', (ev) => {
      try {
        const evt = JSON.parse((ev as MessageEvent).data) as LifecycleAppEvent
        if (evt.type === 'session.updated' && evt.session.id === conversationId) {
          authFetch(`/api/sessions/${conversationId}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => { if (data) setSession(data as SessionWithStatus) })
            .catch(() => {})
        } else if (evt.type === 'session.exited' && evt.id === conversationId) {
          setSession((prev) =>
            prev ? { ...prev, status: 'exited', live: false, attached: false } : null,
          )
          setExitCode(evt.exit_code)
        } else if (evt.type === 'session.prds.updated' && evt.session_id === conversationId) {
          void refreshLinkedPrds()
        }
      } catch {}
    })
    return () => es.close()
  }, [conversationId])

  // External-owner polling: when the JSONL is held open by another claude
  // process, poll GET /api/sessions/:id every 3s. As soon as the external
  // process exits the next response flips to dormant and the user can hit
  // Resume normally — no manual refresh needed.
  useEffect(() => {
    if (!session || session.status !== 'external-owned') return
    const t = setInterval(async () => {
      try {
        const res = await authFetch(`/api/sessions/${conversationId}`)
        if (res.ok) setSession((await res.json()) as SessionWithStatus)
      } catch {}
    }, 3000)
    return () => clearInterval(t)
  }, [conversationId, session?.status])

  // WebSocket only when live-attached.
  useEffect(() => {
    if (!session || session.status !== 'live-attached') {
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      return
    }
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${window.location.host}/ws/sessions/${conversationId}`
    let ws: WebSocket
    try {
      ws = authWebSocket(url)
    } catch {
      return
    }
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws
    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [conversationId, session?.status])

  // Fetch PRDs for this project + this session.
  const refreshLinkedPrds = async () => {
    try {
      const res = await authFetch(`/api/sessions/${conversationId}/prds`)
      if (res.ok) {
        const body = (await res.json()) as { prds: PrdSpec[] }
        setLinkedPrds(body.prds)
      }
    } catch {}
  }

  useEffect(() => { void refreshLinkedPrds() }, [conversationId])
  useEffect(() => {
    if (!project) return
    ;(async () => {
      try {
        const res = await authFetch(`/api/projects/${project.id}/prds`)
        if (res.ok) {
          const body = (await res.json()) as { prds: PrdSpec[] }
          setProjectPrds(body.prds)
        }
      } catch {}
    })()
  }, [project?.id])

  function sendInput() {
    const text = input.trim()
    if (!text) return
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'input', data: text + '\r' }))
    setInput('')
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendInput()
    }
  }

  async function handleResume() {
    if (resuming) return
    setResuming(true)
    setResumeError(null)
    try {
      const res = await authFetch(`/api/sessions/${conversationId}/resume`, { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setResumeError(body.error ?? `resume failed (${res.status})`)
        return
      }
      const updated = await authFetch(`/api/sessions/${conversationId}`)
      if (updated.ok) setSession((await updated.json()) as SessionWithStatus)
    } catch (err) {
      setResumeError(String((err as Error)?.message ?? err))
    } finally {
      setResuming(false)
    }
  }

  async function handleRenameTitle(newTitle: string) {
    setRenamingTitle(false)
    if (!newTitle.trim()) return
    try {
      const res = await authFetch(`/api/sessions/${conversationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle.trim() }),
      })
      if (res.ok) setSession((await res.json()) as SessionWithStatus)
    } catch {}
  }

  async function handleTakeover() {
    if (takingOver) return
    setTakingOver(true)
    setResumeError(null)
    try {
      const res = await authFetch(`/api/sessions/${conversationId}/takeover`, { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; details?: { external_owner_pid?: number } }
        setResumeError(body.error ?? `takeover failed (${res.status})`)
        return
      }
      const updated = await authFetch(`/api/sessions/${conversationId}`)
      if (updated.ok) setSession((await updated.json()) as SessionWithStatus)
    } catch (err) {
      setResumeError(String((err as Error)?.message ?? err))
    } finally {
      setTakingOver(false)
    }
  }

  async function handleKillAndResume() {
    if (killing || resuming) return
    setKilling(true)
    setKillPhase('killing')
    setResumeError(null)
    try {
      const killRes = await authFetch(`/api/sessions/${conversationId}/kill`, { method: 'POST' })
      if (!killRes.ok && killRes.status !== 404 && killRes.status !== 409) {
        const body = (await killRes.json().catch(() => ({}))) as { error?: string }
        setResumeError(body.error ?? `kill failed (${killRes.status})`)
        return
      }
      setKillPhase('resuming')
      const resumeRes = await authFetch(`/api/sessions/${conversationId}/resume`, { method: 'POST' })
      if (!resumeRes.ok) {
        const body = (await resumeRes.json().catch(() => ({}))) as { error?: string }
        setResumeError(body.error ?? `resume failed (${resumeRes.status})`)
        return
      }
      const updated = await authFetch(`/api/sessions/${conversationId}`)
      if (updated.ok) setSession((await updated.json()) as SessionWithStatus)
    } catch (err) {
      setResumeError(String((err as Error)?.message ?? err))
    } finally {
      setKilling(false)
      setKillPhase('idle')
    }
  }

  async function handleSetLinkedPrds(ids: string[]) {
    try {
      await authFetch(`/api/sessions/${conversationId}/prds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prd_spec_ids: ids }),
      })
      await refreshLinkedPrds()
    } catch {}
  }

  if (!session) {
    return <div className="p-4 text-sm text-zinc-500">Loading conversation…</div>
  }

  const projectName = project?.name ?? '(no project)'
  const sessionTitle = session.title ?? conversationId.slice(0, 8)
  const streamDisabled = session.status !== 'live-attached'
  const streamDisabledTooltip =
    session.status === 'dormant'
      ? 'Resume to enable Stream'
      : session.status === 'live-orphaned'
        ? 'PTY unreachable; kill & resume to regain control'
        : session.status === 'exited'
          ? 'Session exited; resume to enable Stream'
          : session.status === 'external-owned'
            ? 'Another claude process owns this conversation; take over or close that process'
            : 'Stream unavailable'
  const effectiveChatMode: ViewMode =
    streamDisabled && chatMode === 'stream' ? 'chat' : chatMode

  return (
    <div className="flex flex-col h-full">
      <header className="border-b border-zinc-700/40 p-3 shrink-0">
        <div className="text-xs text-zinc-500 truncate">
          {projectName}
        </div>

        <div className="flex items-center gap-2 mt-1">
          {renamingTitle ? (
            <input
              ref={renameInputRef}
              defaultValue={session.title ?? ''}
              placeholder={conversationId.slice(0, 8)}
              className="font-semibold bg-zinc-800 border border-zinc-600 rounded px-1 py-0.5 text-zinc-100 outline-none text-sm flex-1 min-w-0"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleRenameTitle((e.target as HTMLInputElement).value)
                else if (e.key === 'Escape') setRenamingTitle(false)
              }}
              onBlur={(e) => void handleRenameTitle(e.target.value)}
            />
          ) : (
            <div className="flex items-center gap-1 min-w-0 flex-1">
              <h2 className="font-semibold truncate">{sessionTitle}</h2>
              <button
                type="button"
                onClick={() => setRenamingTitle(true)}
                title="Rename"
                className="shrink-0 text-zinc-600 hover:text-zinc-300 transition"
              >
                <Pencil className="w-3 h-3" />
              </button>
            </div>
          )}
          <StatusBadge status={session.status} />
        </div>

        {/* UUID + copy. Click the id to copy, click the terminal-icon to copy
            a ready-to-paste `claude --resume <id>` command. */}
        <div className="flex items-center gap-2 mt-1 text-[11px] text-zinc-600">
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(conversationId).then(() => {
                setCopiedKind('id')
                setTimeout(() => setCopiedKind((k) => (k === 'id' ? null : k)), 1200)
              })
            }}
            title="Copy session id"
            className="font-mono hover:text-zinc-300 transition inline-flex items-center gap-1 group"
          >
            {conversationId}
            {copiedKind === 'id' ? (
              <Check className="w-3 h-3 text-emerald-400" />
            ) : (
              <Copy className="w-3 h-3 opacity-0 group-hover:opacity-100 transition" />
            )}
          </button>
          <span className="text-zinc-700">·</span>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(`claude --resume ${conversationId}`).then(() => {
                setCopiedKind('cmd')
                setTimeout(() => setCopiedKind((k) => (k === 'cmd' ? null : k)), 1200)
              })
            }}
            title="Copy `claude --resume <id>` command"
            className="hover:text-zinc-300 transition inline-flex items-center gap-1"
          >
            {copiedKind === 'cmd' ? (
              <>
                <Check className="w-3 h-3 text-emerald-400" />
                copied
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                copy resume cmd
              </>
            )}
          </button>
        </div>

        <nav className="mt-3 flex gap-2">
          <TabBtn active={tab === 'chat'} onClick={() => setTab('chat')} icon={<MessageSquare className="w-3.5 h-3.5" />}>
            Chat
          </TabBtn>
          <TabBtn active={tab === 'prd'} onClick={() => setTab('prd')} icon={<FileText className="w-3.5 h-3.5" />}>
            PRD <span className="text-zinc-600">({linkedPrds.length})</span>
          </TabBtn>
          {tab === 'chat' && (
            <div className="ml-auto">
              <ViewModeToggle
                mode={effectiveChatMode}
                onChange={setChatMode}
                streamDisabled={streamDisabled}
                streamDisabledTooltip={streamDisabledTooltip}
              />
            </div>
          )}
        </nav>
      </header>

      <main className="flex-1 overflow-hidden">
        {tab === 'chat' ? (
          effectiveChatMode === 'chat' ? (
            <SessionTranscript sessionId={conversationId} turns={turns} />
          ) : (
            <SessionStream
              sessionId={conversationId}
              status={session.status}
              authWebSocket={authWebSocket}
            />
          )
        ) : (
          <PrdTabPanel
            linkedPrds={linkedPrds}
            projectPrds={projectPrds}
            onSetLinkedPrds={(ids) => void handleSetLinkedPrds(ids)}
          />
        )}
      </main>

      {tab === 'chat' && effectiveChatMode !== 'stream' && (
        <footer className="border-t border-zinc-700/40 p-2 shrink-0">
          {resumeError && (
            <div className="mb-2 text-xs text-rose-400 px-1">
              Resume failed: {resumeError}
            </div>
          )}
          <InputArea
            status={session.status}
            exitCode={exitCode}
            externalOwnerPid={session.external_owner_pid}
            externalOwnerComm={session.external_owner_comm}
            input={input}
            setInput={setInput}
            onKeyDown={onKeyDown}
            onSend={sendInput}
            onResume={handleResume}
            resuming={resuming}
            onKillAndResume={handleKillAndResume}
            killing={killing}
            killPhase={killPhase}
            onTakeover={handleTakeover}
            takingOver={takingOver}
          />
        </footer>
      )}
    </div>
  )
}

function TabBtn({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded transition ${
        active
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
      }`}
    >
      {icon}
      {children}
    </button>
  )
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'live-attached'
      ? 'bg-green-700 text-green-100'
      : status === 'live-orphaned'
        ? 'bg-yellow-700 text-yellow-100'
        : status === 'external-owned'
          ? 'bg-sky-700 text-sky-100'
          : status === 'exited'
            ? 'bg-zinc-700 text-zinc-300'
            : 'bg-zinc-600 text-zinc-200'
  return <span className={`px-2 py-0.5 text-xs rounded shrink-0 ${cls}`}>{status}</span>
}

interface InputAreaProps {
  status: SessionStatus
  exitCode: number | undefined
  externalOwnerPid: number | null
  externalOwnerComm: string | null
  input: string
  setInput: (v: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onSend: () => void
  onResume: () => void
  resuming: boolean
  onKillAndResume: () => void
  killing: boolean
  killPhase: 'idle' | 'killing' | 'resuming'
  onTakeover: () => void
  takingOver: boolean
}

function ResumeButton({ onResume, resuming }: { onResume: () => void; resuming: boolean }) {
  return (
    <button
      onClick={onResume}
      disabled={resuming}
      className="px-3 py-1 bg-emerald-700 disabled:opacity-50 rounded text-sm self-end h-[2.5rem] whitespace-nowrap"
    >
      {resuming ? 'Resuming…' : 'Resume'}
    </button>
  )
}

function InputArea({
  status,
  exitCode,
  externalOwnerPid,
  externalOwnerComm,
  input,
  setInput,
  onKeyDown,
  onSend,
  onResume,
  resuming,
  onKillAndResume,
  killing,
  killPhase,
  onTakeover,
  takingOver,
}: InputAreaProps) {
  if (status === 'external-owned') {
    const ownerLabel = externalOwnerComm
      ? `${externalOwnerComm} (PID ${externalOwnerPid ?? '?'})`
      : `PID ${externalOwnerPid ?? '?'}`
    return (
      <div className="flex gap-2 items-end">
        <div
          className="flex-1 min-h-[2.5rem] bg-sky-950/30 border border-sky-900/50 rounded px-3 py-2 text-xs text-sky-200"
          title="Watching read-only — close that process or take over to interact"
        >
          <span className="font-medium">Watching read-only</span>
          <span className="text-sky-400/80"> — owned by {ownerLabel}.</span>
          <div className="text-[11px] text-sky-300/70 mt-0.5">
            Close that process to resume here, or take over to kill it and continue here.
          </div>
        </div>
        <button
          onClick={onTakeover}
          disabled={takingOver}
          className="px-3 py-1 bg-amber-700 disabled:opacity-50 rounded text-sm self-end h-[2.5rem] whitespace-nowrap"
        >
          {takingOver ? 'Taking over…' : 'Take over'}
        </button>
      </div>
    )
  }

  if (status === 'exited') {
    return (
      <div className="flex gap-2 items-center">
        <span className="flex-1 text-sm text-zinc-400 px-1">Exit code: {exitCode ?? 'unknown'}</span>
        <ResumeButton onResume={onResume} resuming={resuming} />
      </div>
    )
  }

  if (status === 'live-orphaned') {
    const killLabel =
      killPhase === 'killing' ? 'Killing…' : killPhase === 'resuming' ? 'Resuming…' : 'Kill & Resume'
    return (
      <div className="flex gap-2 items-end">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Session is orphaned (PID gone). Kill & Resume to regain control."
          disabled={true}
          className="flex-1 min-h-[2.5rem] max-h-32 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm font-mono resize-none disabled:opacity-50 disabled:cursor-not-allowed"
          rows={1}
        />
        <button
          onClick={onKillAndResume}
          disabled={killing}
          className="px-3 py-1 bg-amber-700 disabled:opacity-50 rounded text-sm self-end h-[2.5rem] whitespace-nowrap"
        >
          {killLabel}
        </button>
      </div>
    )
  }

  const isLive = status === 'live-attached'
  const placeholder =
    status === 'dormant'
      ? 'Session is dormant. Click Resume to restart.'
      : 'Type a message — Enter to send, Shift+Enter for newline'

  return (
    <div className="flex gap-2 items-end">
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={!isLive}
        className="flex-1 min-h-[2.5rem] max-h-32 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm font-mono resize-none disabled:opacity-50 disabled:cursor-not-allowed"
        rows={1}
      />
      {isLive ? (
        <button
          onClick={onSend}
          disabled={!input.trim()}
          className="px-3 py-1 bg-blue-600 disabled:bg-zinc-700 rounded text-sm self-end h-[2.5rem]"
        >
          Send
        </button>
      ) : (
        <ResumeButton onResume={onResume} resuming={resuming} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// PRD tab panel
// ---------------------------------------------------------------------------

function PrdTabPanel({
  linkedPrds,
  projectPrds,
  onSetLinkedPrds,
}: {
  linkedPrds: PrdSpec[]
  projectPrds: PrdSpec[]
  onSetLinkedPrds: (ids: string[]) => void
}) {
  const linkedIds = new Set(linkedPrds.map((p) => p.id))

  const toggle = (id: string) => {
    const next = new Set(linkedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onSetLinkedPrds([...next])
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-5 space-y-6">
      <section>
        <h3 className="text-[11px] uppercase tracking-wide text-zinc-500 mb-3">
          Linked PRDs
        </h3>
        {projectPrds.length === 0 && (
          <div className="text-xs text-zinc-600 italic">
            No PRDs in this project. Add a <code className="font-mono">prd.json</code> under
            <code className="font-mono"> ./tasks/&lt;slug&gt;/</code> and rescan.
          </div>
        )}
        {projectPrds.length > 0 && (
          <ul className="space-y-1.5">
            {projectPrds.map((p) => (
              <li
                key={p.id}
                className="flex items-center gap-3 px-3 py-2 rounded border border-zinc-800 bg-zinc-950"
              >
                <input
                  type="checkbox"
                  checked={linkedIds.has(p.id)}
                  onChange={() => toggle(p.id)}
                  className="accent-emerald-600"
                />
                <FileText className="w-4 h-4 text-zinc-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-zinc-200 truncate">{p.slug}</div>
                  <div className="text-[11px] text-zinc-600 truncate font-mono">{p.prd_path}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {linkedPrds.length > 0 && (
        <section>
          <h3 className="text-[11px] uppercase tracking-wide text-zinc-500 mb-3">
            Snapshots
          </h3>
          <div className="space-y-6">
            {linkedPrds.map((p) => (
              <PrdSnapshotForSpec key={p.id} prd={p} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function PrdSnapshotForSpec({ prd }: { prd: PrdSpec }) {
  // Parse prd_json into PRDJson so PrdSnapshotPanels can render. The
  // stored JSON shape is the same prd.json the orchestrator reads.
  let parsed: PRDJson | null = null
  if (prd.prd_json) {
    try { parsed = JSON.parse(prd.prd_json) as PRDJson } catch {}
  }
  if (!parsed) {
    return (
      <div className="text-xs text-zinc-600 italic">
        {prd.slug}: prd.json could not be parsed.
      </div>
    )
  }
  // PrdSnapshotPanels expects an EffortPrdSnapshot-shaped object. Adapt by
  // wrapping the parsed prd.json in the smallest compatible structure.
  const snapshot = {
    prd: parsed,
    decisionFiles: [],
    docFiles: [],
    recentCommits: [],
    activeStoryIds: [],
    agents: { processes: [], tasks: [] },
  }
  return (
    <div className="border border-zinc-800 rounded">
      <div className="px-4 py-2 border-b border-zinc-800 text-xs text-zinc-400 font-mono">
        {prd.slug}
      </div>
      <div className="p-4">
        <PrdSnapshotPanels snapshot={snapshot as any} />
      </div>
    </div>
  )
}
