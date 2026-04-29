// ConfirmDeleteSessionDialog — US-017b
//
// Single-button confirmation dialog for hard-deleting a session.
// Sessions are leaf nodes — no cascade needed.
//
// AC:
//   - No typed-name required — single Confirm button.
//   - purge_jsonl checkbox (default unchecked) — when checked, appends
//     purge_jsonl=true to the DELETE request.
//   - Calls onClose on Cancel/X; calls onDeleted on successful delete.

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { authFetch } from '../auth'

export interface ConfirmDeleteSessionDialogProps {
  session: { id: string; title?: string | null }
  onClose: () => void
  onDeleted: () => void
}

export function ConfirmDeleteSessionDialog({
  session,
  onClose,
  onDeleted,
}: ConfirmDeleteSessionDialogProps) {
  const [purge, setPurge] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const title = session.title ?? session.id.slice(0, 8)

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
      const res = await authFetch(`/api/sessions/${session.id}?purge_jsonl=${purge}`, {
        method: 'DELETE',
      })
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
          <h2 className="text-base font-semibold text-zinc-100">Delete session?</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 transition"
            aria-label="close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-sm text-zinc-400 mb-4">
          Session <span className="font-mono text-zinc-200">{title}</span> will be
          permanently deleted.
        </p>

        {/* Purge JSONL checkbox */}
        <label className="flex items-center gap-2 mb-5 cursor-pointer">
          <input
            type="checkbox"
            checked={purge}
            onChange={(e) => setPurge(e.target.checked)}
            className="accent-rose-500"
          />
          <span className="text-sm text-zinc-300">Also delete JSONL transcript from disk</span>
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
            {submitting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
