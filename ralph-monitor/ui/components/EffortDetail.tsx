// EffortDetail — shown when an effort is selected but no session is selected.
//
// Layout:
//   - Header: breadcrumb (project / effort), effort name, working_dir
//   - Toolbar: "+ New session" button
//   - List of sessions with id short form, status badge, last_activity_at
//   - Empty state if no sessions
//   - For prd-kind efforts: PRD snapshot panels (stories, agents, commits, etc.)

import { useState, useEffect } from 'react'
import { authFetch, authEventSource } from '../auth'
import type { Project } from '../../server/db/projects'
import type { Effort } from '../../server/db/efforts'
import type { Session } from '../../server/db/sessions'
import type { PRDRecord, LifecycleAppEvent } from '../../server/types'
import { PrdSnapshotPanels } from './PrdSnapshotPanels'

export interface EffortDetailProps {
  project: Project | null
  effort: Effort
  sessions: Session[]
  onSelectSession: (id: string) => void
  onNewSession: () => void
}

type SessionStatus = 'dormant' | 'live-attached' | 'live-orphaned' | 'exited'

function computeStatus(session: Session): SessionStatus {
  if (session.process_pid != null) return 'live-orphaned'
  return 'dormant'
}

const STATUS_LABELS: Record<SessionStatus, string> = {
  dormant: 'dormant',
  'live-attached': 'live',
  'live-orphaned': 'orphaned',
  exited: 'exited',
}

const STATUS_COLORS: Record<SessionStatus, string> = {
  dormant: 'bg-zinc-800 text-zinc-500',
  'live-attached': 'bg-emerald-900/60 text-emerald-300',
  'live-orphaned': 'bg-amber-900/60 text-amber-300',
  exited: 'bg-zinc-800 text-zinc-600',
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 0) return 'in future'
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function EffortDetail({ project, effort, sessions, onSelectSession, onNewSession }: EffortDetailProps) {
  const [showArchived, setShowArchived] = useState(false)
  const [prdSnapshot, setPrdSnapshot] = useState<PRDRecord | null>(null)

  // For prd-kind efforts: fetch the snapshot on mount and whenever effort id changes.
  useEffect(() => {
    if (effort.kind !== 'prd') return
    let cancelled = false

    const fetchSnapshot = () => {
      authFetch(`/api/efforts/${effort.id}/snapshot`)
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (!cancelled && data && data.status !== 'pending') {
            setPrdSnapshot(data as PRDRecord)
          }
        })
        .catch(() => {})
    }

    fetchSnapshot()

    // Subscribe to SSE: re-fetch on effort.snapshot.updated (or effort.updated) for this effort.
    let es: EventSource
    try {
      es = authEventSource('/events')
    } catch {
      return () => { cancelled = true }
    }
    es.addEventListener('update', (ev) => {
      try {
        const evt = JSON.parse((ev as MessageEvent).data) as LifecycleAppEvent
        if (
          (evt.type === 'effort.snapshot.updated' && evt.effort_id === effort.id) ||
          (evt.type === 'effort.updated' && evt.effort.id === effort.id)
        ) {
          fetchSnapshot()
        }
      } catch {}
    })

    return () => {
      cancelled = true
      es.close()
    }
  }, [effort.id, effort.kind])

  const archivedCount = sessions.filter((s) => s.archived).length
  const visibleSessions = showArchived ? sessions : sessions.filter((s) => !s.archived)

  return (
    <div className="flex flex-col h-full bg-zinc-950">
      {/* Header */}
      <header className="px-6 py-4 border-b border-zinc-800 shrink-0">
        {project && (
          <div className="text-[11px] text-zinc-500 mb-1 truncate">
            {project.name}
          </div>
        )}
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-base font-semibold text-zinc-100 truncate flex-1">{effort.name}</h2>
          {effort.kind === 'prd' && effort.prd_path && (
            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-violet-900/60 text-violet-300 font-medium">
              PRD
            </span>
          )}
        </div>
        {effort.working_dir && (
          <div className="mt-0.5 text-[11px] text-zinc-500 font-mono truncate">{effort.working_dir}</div>
        )}
        {effort.kind === 'prd' && effort.prd_path && (
          <div className="mt-0.5 text-[11px] text-zinc-600 font-mono truncate">{effort.prd_path}</div>
        )}
      </header>

      {/* Toolbar */}
      <div className="px-6 py-3 border-b border-zinc-800 shrink-0 flex items-center gap-3">
        <button
          type="button"
          onClick={onNewSession}
          disabled={effort.status === 'archived'}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-600 transition disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed"
        >
          + New session
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {visibleSessions.length === 0 && archivedCount === 0 ? (
          <div className="px-6 py-10 text-sm text-zinc-500 text-center">
            No sessions yet. Click{' '}
            <span className="text-zinc-300 font-medium">+ New session</span> to spawn a claude
            conversation here.
          </div>
        ) : (
          <>
            <ul className="divide-y divide-zinc-800/60">
              {visibleSessions.map((session) => {
                const status = computeStatus(session)
                const lastActivity = session.last_activity_at ? timeAgo(session.last_activity_at) : '—'
                const title = session.title ?? session.id.slice(0, 8)
                return (
                  <li key={session.id} className={session.archived ? 'opacity-60' : undefined}>
                    <button
                      type="button"
                      onClick={() => onSelectSession(session.id)}
                      className="w-full text-left px-6 py-3 hover:bg-zinc-900/60 transition group"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm text-zinc-200 truncate flex-1 group-hover:text-zinc-100">
                          {title}
                        </span>
                        {session.archived && (
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium bg-zinc-800 text-zinc-600">
                            archived
                          </span>
                        )}
                        <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium ${STATUS_COLORS[status]}`}>
                          {STATUS_LABELS[status]}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-zinc-600 tabular-nums">{lastActivity}</div>
                    </button>
                  </li>
                )
              })}
            </ul>
            {archivedCount > 0 && (
              <div className="px-6 py-2">
                <button
                  type="button"
                  onClick={() => setShowArchived((v) => !v)}
                  className="text-[11px] text-zinc-600 hover:text-zinc-400 transition italic"
                >
                  {showArchived
                    ? `Hide ${archivedCount} archived`
                    : `Show ${archivedCount} archived`}
                </button>
              </div>
            )}
          </>
        )}

        {/* PRD snapshot panels — only for prd-kind efforts */}
        {effort.kind === 'prd' && prdSnapshot && (
          <div className="border-t border-zinc-800 mt-2">
            <PrdSnapshotPanels snapshot={prdSnapshot} />
          </div>
        )}
      </div>
    </div>
  )
}
