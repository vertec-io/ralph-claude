// ConfirmDeleteEffortDialog — US-017b
//
// Single-button confirmation dialog for hard-deleting an effort. Fetches
// /api/efforts/:id/cascade-stats on open to render the cascade warning.
//
// AC:
//   - No typed-name required — single Confirm button.
//   - "Purge JSONL files" checkbox (default unchecked) — when checked, appends
//     purge_jsonls=true to the DELETE request.
//   - On 409 (live sessions), shows an inline error.
//   - Calls onClose on Cancel/X; calls onDeleted on successful delete.

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { authFetch } from '../auth'

export interface ConfirmDeleteEffortDialogProps {
  effort: { id: string; name: string; project_id: string }
  onClose: () => void
  onDeleted: () => void
}

interface CascadeStats {
  session_count: number
}

export function ConfirmDeleteEffortDialog({
  effort,
  onClose,
  onDeleted,
}: ConfirmDeleteEffortDialogProps) {
  const [stats, setStats] = useState<CascadeStats | null>(null)
  const [purge, setPurge] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fetch cascade stats on mount.
  useEffect(() => {
    let cancelled = false
    authFetch(`/api/efforts/${effort.id}/cascade-stats`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setStats(data as CascadeStats)
      })
      .catch(() => {
        if (!cancelled) setStats({ session_count: 0 })
      })
    return () => { cancelled = true }
  }, [effort.id])

  // ESC cancels.
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const handleConfirm = async () => {
    if (submitting) return
    setError(null)
    setSubmitting(true)
    try {
      const params = new URLSearchParams()
      if (purge) params.set('purge_jsonls', 'true')
      const qs = params.toString() ? `?${params.toString()}` : ''
      const res = await authFetch(`/api/efforts/${effort.id}${qs}`, {
        method: 'DELETE',
      })
      if (res.status === 409) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setError(
          body.error === 'effort_has_live_sessions'
            ? 'Cannot delete: this effort has a live session running. Stop it first.'
            : `Delete blocked: ${body.error ?? `HTTP ${res.status}`}`,
        )
        return
      }
      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setError(`Delete failed: ${body.error ?? `HTTP ${res.status}`}`)
        return
      }
      onDeleted()
    } catch (err) {
      setError(`Delete failed: ${(err as Error)?.message ?? err}`)
    } finally {
      setSubmitting(false)
    }
  }

  const sessionCount = stats?.session_count ?? '…'

  return (
    <div
      className="fixed inset-0 z-[10000] bg-black/60 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl p-6 max-w-sm w-full"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-zinc-100">Delete effort?</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 transition"
            aria-label="close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Description + cascade warning */}
        <p className="text-sm text-zinc-400 mb-3">
          Effort <span className="font-mono text-zinc-200">{effort.name}</span> will be
          permanently deleted.
        </p>
        <div className="rounded border border-rose-800/50 bg-rose-950/20 px-4 py-3 mb-4 text-sm text-rose-300">
          This will also delete{' '}
          <strong className="text-rose-200">{sessionCount} session{sessionCount === 1 ? '' : 's'}</strong>
          . JSONL files are <em>not</em> deleted unless you also tick &ldquo;Purge JSONLs&rdquo;.
        </div>

        {/* Purge JSONL checkbox */}
        <label className="flex items-center gap-2 mb-5 cursor-pointer">
          <input
            type="checkbox"
            checked={purge}
            onChange={(e) => setPurge(e.target.checked)}
            className="accent-rose-500"
          />
          <span className="text-sm text-zinc-300">Purge JSONL files from disk (irreversible)</span>
        </label>

        {/* Inline error */}
        {error && (
          <div className="text-xs text-rose-400 bg-rose-950/30 border border-rose-900/40 rounded px-3 py-2 mb-4">
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded text-sm text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800 transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={submitting}
            autoFocus
            className="px-4 py-1.5 rounded text-sm bg-rose-700 text-white hover:bg-rose-600 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed transition"
          >
            {submitting ? 'Deleting…' : 'Delete effort'}
          </button>
        </div>
      </div>
    </div>
  )
}
