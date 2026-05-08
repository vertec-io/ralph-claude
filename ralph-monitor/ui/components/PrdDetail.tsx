// PrdDetail — full PRD spec view.
//
// Shows the rendered prd.json (via PrdSnapshotPanels: stories, criteria,
// status counts) plus a list of conversations associated with this PRD.
// Clicking a conversation row navigates to it.
//
// Reachable via #/p/:pid/prd/:prdSpecId or by clicking a PRD row in
// ProjectDetail.

import { useEffect, useState } from 'react'
import { FileText, RefreshCw, MessageSquare } from 'lucide-react'
import type { Project } from '../../server/db/projects'
import type { PrdSpec } from '../../server/db/prdSpecs'
import type { Session } from '../../server/db/sessions'
import type { PRDJson } from '../../server/types'
import { authFetch } from '../auth'
import { PrdSnapshotPanels } from './PrdSnapshotPanels'

export interface PrdDetailProps {
  project: Project
  prdSpecId: string
  onSelectConversation: (cid: string) => void
}

export function PrdDetail({ project, prdSpecId, onSelectConversation }: PrdDetailProps) {
  const [prd, setPrd] = useState<PrdSpec | null>(null)
  const [linkedSessions, setLinkedSessions] = useState<Session[]>([])
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    setError(null)
    try {
      const [prdRes, sessRes] = await Promise.all([
        authFetch(`/api/prd-specs/${prdSpecId}`),
        authFetch(`/api/prd-specs/${prdSpecId}/sessions`),
      ])
      if (!prdRes.ok) {
        setError(`Failed to load PRD (${prdRes.status})`)
        return
      }
      const prdBody = (await prdRes.json()) as PrdSpec
      setPrd(prdBody)

      if (sessRes.ok) {
        const sBody = (await sessRes.json()) as { session_ids: string[] }
        // Hydrate sessions individually.
        const sessions: Session[] = []
        await Promise.all(
          sBody.session_ids.map(async (sid) => {
            try {
              const r = await authFetch(`/api/sessions/${sid}`)
              if (r.ok) sessions.push((await r.json()) as Session)
            } catch {}
          }),
        )
        sessions.sort(
          (a, b) =>
            (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0) ||
            b.created_at - a.created_at,
        )
        setLinkedSessions(sessions)
      }
    } catch (err) {
      setError(String((err as Error).message ?? err))
    }
  }

  useEffect(() => {
    void refresh()
  }, [prdSpecId])

  const handleRescan = async () => {
    setScanning(true)
    try {
      await authFetch(`/api/prd-specs/${prdSpecId}/scan`, { method: 'POST' })
      await refresh()
    } finally {
      setScanning(false)
    }
  }

  if (error) {
    return <div className="p-6 text-sm text-rose-400">{error}</div>
  }
  if (!prd) {
    return <div className="p-6 text-sm text-zinc-500">Loading PRD…</div>
  }

  let parsed: PRDJson | null = null
  if (prd.prd_json) {
    try { parsed = JSON.parse(prd.prd_json) as PRDJson } catch {}
  }

  // PrdSnapshotPanels expects an effort-snapshot-shaped object; provide the
  // smallest compatible structure.
  const snapshot = parsed
    ? {
        prd: parsed,
        decisionFiles: [],
        docFiles: [],
        recentCommits: [],
        activeStoryIds: [],
        agents: { processes: [], tasks: [] },
      }
    : null

  const stories = parsed?.userStories ?? []
  const passedStories = stories.filter((s) => s.passes).length
  const totalStories = stories.length

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <header className="border-b border-zinc-800 px-6 py-5 shrink-0">
        <div className="text-xs text-zinc-500 truncate">{project.name}</div>
        <div className="flex items-center gap-2 mt-1">
          <FileText className="w-4 h-4 text-zinc-400 shrink-0" />
          <h1 className="text-xl font-semibold text-zinc-100 truncate">
            {parsed?.title ?? prd.slug}
          </h1>
        </div>
        <div className="text-[11px] text-zinc-600 font-mono mt-1 truncate">
          {prd.prd_path}
        </div>

        <div className="mt-3 flex items-center gap-3 text-xs text-zinc-400">
          <span>
            <span className="text-zinc-200 font-semibold">{passedStories}</span>
            <span className="text-zinc-600"> / {totalStories} stories complete</span>
          </span>
          {parsed?.branchName && (
            <span className="text-zinc-500">
              branch <code className="font-mono text-zinc-300">{parsed.branchName}</code>
            </span>
          )}
          {parsed?.type && (
            <span className="px-1.5 py-0.5 bg-zinc-800 rounded text-[11px]">
              {parsed.type}
            </span>
          )}
          <button
            type="button"
            onClick={() => void handleRescan()}
            disabled={scanning}
            className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-900 disabled:opacity-50 transition"
          >
            <RefreshCw className={`w-3 h-3 ${scanning ? 'animate-spin' : ''}`} />
            {scanning ? 'Rescanning…' : 'Rescan prd.json'}
          </button>
        </div>
      </header>

      <section className="px-6 py-5 border-b border-zinc-800/60">
        <h2 className="text-[11px] uppercase tracking-wide text-zinc-500 mb-3">
          Linked conversations <span className="text-zinc-600">({linkedSessions.length})</span>
        </h2>
        {linkedSessions.length === 0 ? (
          <div className="text-xs text-zinc-600 italic">
            No conversations are associated with this PRD yet. Open a conversation and use
            its <em>PRD</em> tab to link it, or pick this PRD when starting a new session.
          </div>
        ) : (
          <ul className="space-y-0.5">
            {linkedSessions.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-3 px-3 py-2 rounded hover:bg-zinc-900 cursor-pointer transition"
                onClick={() => onSelectConversation(s.id)}
              >
                <MessageSquare className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-zinc-200 truncate">
                    {s.title ?? s.id.slice(0, 8)}
                  </div>
                  <div className="text-[11px] text-zinc-600">
                    {s.last_activity_at
                      ? new Date(s.last_activity_at).toLocaleString()
                      : 'no activity'}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="px-6 py-5">
        {snapshot ? (
          <PrdSnapshotPanels snapshot={snapshot as any} />
        ) : (
          <div className="text-xs text-rose-400">
            prd.json could not be parsed.
          </div>
        )}
      </section>
    </div>
  )
}
