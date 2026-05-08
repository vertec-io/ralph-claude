// ProjectDetail — the project home screen.
//
// Shown when a project is selected but no conversation is. Surfaces:
//   - Project header (name, root_dir, pinned, archived)
//   - Action row: New session, Rescan
//   - PRDs section: list of prd_specs with click-to-view
//   - Recent conversations: top 10, click navigates to the conversation

import { useEffect, useState } from 'react'
import { Pin, Plus, RefreshCw, FileText, MessageSquare } from 'lucide-react'
import type { Project } from '../../server/db/projects'
import type { Session } from '../../server/db/sessions'
import type { PrdSpec } from '../../server/db/prdSpecs'
import { authFetch } from '../auth'

export interface ProjectDetailProps {
  project: Project
  sessions: Session[]
  onSelectConversation: (cid: string) => void
  onSelectPrd: (prdSpecId: string) => void
  onOpenNewSession: () => void
  onRefresh: () => void
}

export function ProjectDetail({
  project,
  sessions,
  onSelectConversation,
  onSelectPrd,
  onOpenNewSession,
  onRefresh,
}: ProjectDetailProps) {
  const [prds, setPrds] = useState<PrdSpec[]>([])
  const [prdSessionCounts, setPrdSessionCounts] = useState<Map<string, number>>(new Map())
  const [scanning, setScanning] = useState(false)

  const refreshPrds = async () => {
    try {
      const res = await authFetch(`/api/projects/${project.id}/prds`)
      if (!res.ok) return
      const body = (await res.json()) as { prds: PrdSpec[] }
      setPrds(body.prds)
      const counts = new Map<string, number>()
      await Promise.all(
        body.prds.map(async (p) => {
          const r = await authFetch(`/api/prd-specs/${p.id}/sessions`)
          if (r.ok) {
            const b = (await r.json()) as { session_ids: string[] }
            counts.set(p.id, b.session_ids.length)
          }
        }),
      )
      setPrdSessionCounts(counts)
    } catch {}
  }

  useEffect(() => {
    void refreshPrds()
  }, [project.id])

  const handleRescan = async () => {
    setScanning(true)
    try {
      await authFetch(`/api/projects/${project.id}/scan`, { method: 'POST' })
      await refreshPrds()
      onRefresh()
    } finally {
      setScanning(false)
    }
  }

  const visibleSessions = sessions
    .filter((s) => !s.archived)
    .sort((a, b) =>
      (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0) ||
      b.created_at - a.created_at,
    )
    .slice(0, 10)

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <header className="border-b border-zinc-800 px-6 py-5 shrink-0">
        <div className="flex items-center gap-2 mb-1">
          {project.pinned && <Pin className="w-4 h-4 text-amber-500" />}
          <h1 className="text-xl font-semibold text-zinc-100">{project.name}</h1>
        </div>
        <div className="text-xs text-zinc-500 font-mono break-all">{project.root_dir}</div>

        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenNewSession}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-emerald-700 text-white hover:bg-emerald-600 transition"
          >
            <Plus className="w-3.5 h-3.5" />
            New session
          </button>
          <button
            type="button"
            onClick={() => void handleRescan()}
            disabled={scanning}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100 disabled:opacity-50 transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
            {scanning ? 'Scanning…' : 'Rescan disk + tasks'}
          </button>
        </div>
      </header>

      <section className="px-6 py-5 border-b border-zinc-800/60">
        <h2 className="text-[11px] uppercase tracking-wide text-zinc-500 mb-3">
          PRDs <span className="text-zinc-600">({prds.length})</span>
        </h2>
        {prds.length === 0 ? (
          <div className="text-xs text-zinc-600 italic">
            No PRDs found under <code className="font-mono">{project.root_dir}/tasks/*/prd.json</code>.
          </div>
        ) : (
          <ul className="space-y-1">
            {prds.map((p) => (
              <li
                key={p.id}
                className="flex items-center gap-3 px-3 py-2 rounded border border-zinc-800 bg-zinc-950 hover:bg-zinc-900 hover:border-zinc-700 cursor-pointer transition"
                onClick={() => onSelectPrd(p.id)}
              >
                <FileText className="w-4 h-4 text-zinc-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-zinc-200 truncate">{p.slug}</div>
                  <div className="text-[11px] text-zinc-600 truncate font-mono">{p.prd_path}</div>
                </div>
                <span className="text-[11px] text-zinc-500 shrink-0 inline-flex items-center gap-1">
                  <MessageSquare className="w-3 h-3" />
                  {prdSessionCounts.get(p.id) ?? 0}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="px-6 py-5">
        <h2 className="text-[11px] uppercase tracking-wide text-zinc-500 mb-3">
          Recent conversations
        </h2>
        {visibleSessions.length === 0 ? (
          <div className="text-xs text-zinc-600 italic">
            No conversations in this project yet. Click <em>New session</em> to start one or run
            <em> claude</em> in this directory and refresh.
          </div>
        ) : (
          <ul className="space-y-0.5">
            {visibleSessions.map((s) => (
              <li
                key={s.id}
                className="px-3 py-2 rounded hover:bg-zinc-900 cursor-pointer transition"
                onClick={() => onSelectConversation(s.id)}
              >
                <div className="text-sm text-zinc-200 truncate">
                  {s.title ?? s.id.slice(0, 8)}
                </div>
                <div className="text-[11px] text-zinc-600">
                  {s.last_activity_at
                    ? new Date(s.last_activity_at).toLocaleString()
                    : 'no activity'}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
