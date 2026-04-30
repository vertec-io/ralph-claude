// DiskConversations — "Load more from disk" section for ProjectDetail.
//
// Shows JSONL files on disk that are rooted in the project's directory (or
// git worktrees) but NOT yet tracked in the DB. Each result can be "Adopted"
// into a session row via POST /api/projects/:id/disk-conversations/adopt.
//
// Collapsed by default; the user clicks "Load from disk" to trigger discovery.
// After adoption, the parent's onRefresh fires so the SSE-driven session list
// picks up the new row.

import { useState } from 'react'
import { authFetch } from '../auth'
import type { Effort } from '../../server/db/efforts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DiskConversation {
  jsonl_path: string
  cwd: string
  size_bytes: number
  mtime: number
  native_name: string | null
  preview: string | null
}

interface DiskConversationsProps {
  projectId: string
  efforts: Effort[]
  /** Called after a successful adopt so the parent can re-fetch sessions. */
  onAdopted: () => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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

function jsonlBasename(path: string): string {
  const seg = path.split('/').pop() ?? path
  return seg.endsWith('.jsonl') ? seg.slice(0, -6) : seg
}

// ---------------------------------------------------------------------------
// ConversationRow
// ---------------------------------------------------------------------------

interface ConversationRowProps {
  conv: DiskConversation
  efforts: Effort[]
  projectId: string
  onAdopted: () => void
}

function ConversationRow({ conv, efforts, projectId, onAdopted }: ConversationRowProps) {
  const defaultEffort = efforts.find((e) => e.kind === 'general') ?? efforts[0]
  const [selectedEffortId, setSelectedEffortId] = useState(defaultEffort?.id ?? '')
  const [adopting, setAdopting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const label = conv.native_name ?? jsonlBasename(conv.jsonl_path)

  const handleAdopt = async () => {
    if (!selectedEffortId) return
    setAdopting(true)
    setError(null)
    try {
      const res = await authFetch(`/api/projects/${projectId}/disk-conversations/adopt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonl_path: conv.jsonl_path,
          effort_id: selectedEffortId,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        if (body.error === 'session_id_collision') {
          setError('Already adopted (session ID conflict).')
        } else {
          setError(body.error ?? `HTTP ${res.status}`)
        }
        return
      }
      onAdopted()
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setAdopting(false)
    }
  }

  return (
    <div className="px-6 py-3 border-b border-zinc-800/60">
      <div className="flex items-start gap-3 min-w-0">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm text-zinc-200 truncate flex-1">{label}</span>
            <span className="shrink-0 text-[11px] text-zinc-500 tabular-nums">
              {timeAgo(conv.mtime)}
            </span>
            <span className="shrink-0 text-[11px] text-zinc-600">
              {formatBytes(conv.size_bytes)}
            </span>
          </div>
          {conv.preview && (
            <div className="mt-0.5 text-[11px] text-zinc-500 truncate">
              {conv.preview}
            </div>
          )}
          {error && (
            <div className="mt-0.5 text-[11px] text-rose-400">{error}</div>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-1.5">
          {efforts.length > 1 && (
            <select
              value={selectedEffortId}
              onChange={(e) => setSelectedEffortId(e.target.value)}
              className="text-xs bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-zinc-300 outline-none"
            >
              {efforts.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => void handleAdopt()}
            disabled={adopting || !selectedEffortId}
            className="px-2.5 py-1 text-xs rounded bg-zinc-700 text-zinc-200 hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed transition whitespace-nowrap"
          >
            {adopting ? 'Adopting…' : 'Adopt'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DiskConversations
// ---------------------------------------------------------------------------

export function DiskConversations({ projectId, efforts, onAdopted }: DiskConversationsProps) {
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [conversations, setConversations] = useState<DiskConversation[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleLoad = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await authFetch(`/api/projects/${projectId}/disk-conversations`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setError(body.error ?? `HTTP ${res.status}`)
        return
      }
      const data = await res.json() as { conversations: DiskConversation[] }
      setConversations(data.conversations)
      setExpanded(true)
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setLoading(false)
    }
  }

  const handleAdoptedAndRefresh = () => {
    // Re-trigger discovery after adoption so the adopted file disappears.
    void handleLoad()
    onAdopted()
  }

  return (
    <div className="border-t border-zinc-800">
      {/* Section header */}
      <div className="px-6 py-3 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-widest text-zinc-500 font-semibold">
          Other Claude conversations in this directory
        </span>
        <button
          type="button"
          onClick={() => {
            if (!expanded || conversations === null) {
              void handleLoad()
            } else {
              setExpanded((v) => !v)
            }
          }}
          disabled={loading}
          className="text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-50 transition"
        >
          {loading ? 'Loading…' : expanded ? 'Hide' : 'Load from disk'}
        </button>
      </div>

      {error && (
        <div className="px-6 pb-3 text-xs text-rose-400">{error}</div>
      )}

      {expanded && conversations !== null && (
        conversations.length === 0 ? (
          <div className="px-6 py-4 text-sm text-zinc-500 text-center italic">
            No untracked conversations found on disk.
          </div>
        ) : (
          <div>
            {conversations.map((conv) => (
              <ConversationRow
                key={conv.jsonl_path}
                conv={conv}
                efforts={efforts}
                projectId={projectId}
                onAdopted={handleAdoptedAndRefresh}
              />
            ))}
          </div>
        )
      )}
    </div>
  )
}
