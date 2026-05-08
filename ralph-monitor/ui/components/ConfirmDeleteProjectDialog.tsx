// ConfirmDeleteProjectDialog — US-017b
//
// Typed-name confirmation dialog for hard-deleting a project. Fetches
// /api/projects/:id/cascade-stats on open to render the cascade warning.
//
// AC:
//   - Typed-name input must match project.name exactly (case-sensitive) before
//     the Delete button is enabled.
//   - "Purge JSONL files" checkbox (default unchecked) — when checked, appends
//     purge_jsonls=true to the DELETE request.
//   - On 409 (live sessions), shows an inline error.
//   - Calls onClose on Cancel/X; calls onDeleted on successful delete.

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { authFetch } from '../auth'

export interface ConfirmDeleteProjectDialogProps {
  project: { id: string; name: string }
  onClose: () => void
  onDeleted: () => void
}

interface CascadeStats {
  effort_count: number
  session_count: number
}

export function ConfirmDeleteProjectDialog({
  project,
  onClose,
  onDeleted,
}: ConfirmDeleteProjectDialogProps) {
  const [stats, setStats] = useState<CascadeStats | null>(null)
  const [typedName, setTypedName] = useState('')
  const [purge, setPurge] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fetch cascade stats on mount.
  useEffect(() => {
    let cancelled = false
    authFetch(`/api/projects/${project.id}/cascade-stats`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setStats(data as CascadeStats)
      })
      .catch(() => {
        if (!cancelled) setStats({ effort_count: 0, session_count: 0 })
      })
    return () => { cancelled = true }
  }, [project.id])

  // ESC cancels.
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const canSubmit = typedName === project.name && !submitting

  const handleConfirm = async () => {
    if (!canSubmit) return
    setError(null)
    setSubmitting(true)
    try {
      const params = new URLSearchParams({ confirm_name: project.name })
      if (purge) params.set('purge_jsonls', 'true')
      const res = await authFetch(`/api/projects/${project.id}?${params.toString()}`, {
        method: 'DELETE',
      })
      if (res.status === 409) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setError(
          body.error === 'project_has_live_sessions'
            ? 'Cannot delete: one or more sessions in this project are currently live. Stop them first.'
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

  const effortCount = stats?.effort_count ?? '…'
  const sessionCount = stats?.session_count ?? '…'

  return (
    <div
      className="fixed inset-0 z-[10000] bg-black/60 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl p-6 max-w-md w-full"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-zinc-100">Delete project?</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 transition"
            aria-label="close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Cascade warning */}
        <div className="rounded border border-rose-800/50 bg-rose-950/20 px-4 py-3 mb-4 text-sm text-rose-300">
          This will permanently delete{' '}
          <strong className="text-rose-200">{effortCount} effort{effortCount === 1 ? '' : 's'}</strong>
          {' '}and{' '}
          <strong className="text-rose-200">{sessionCount} session{sessionCount === 1 ? '' : 's'}</strong>
          . JSONL files are <em>not</em> deleted unless you also tick &ldquo;Purge JSONLs&rdquo;.
        </div>

        {/* Typed-name confirmation */}
        <div className="space-y-1 mb-4">
          <label
            htmlFor="confirm-project-name"
            className="text-[11px] uppercase tracking-wide text-zinc-500"
          >
            Type <span className="font-mono text-zinc-300">{project.name}</span> to confirm
          </label>
          <input
            id="confirm-project-name"
            type="text"
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) void handleConfirm() }}
            autoFocus
            placeholder={project.name}
            className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-zinc-500 transition"
          />
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
            disabled={!canSubmit}
            className="px-4 py-1.5 rounded text-sm bg-rose-700 text-white hover:bg-rose-600 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed transition"
          >
            {submitting ? 'Deleting…' : 'Delete project'}
          </button>
        </div>
      </div>
    </div>
  )
}
