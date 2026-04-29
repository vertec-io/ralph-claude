// NewSessionDialog — US-015d
//
// Modal for creating a new session under an existing effort.
//
// Fields:
//   - mode            ('interactive' default | 'autonomous' opt-in)
//   - working_dir     (optional override; placeholder shows effort.working_dir)
//   - initial_prompt  (optional textarea; only meaningful for autonomous mode)
//
// Submits POST /api/sessions { effort_id, mode, working_dir?, initial_prompt? }.
//
// On 201: calls onCreated with { id, ws_url } so the parent can navigate to the
// session detail view.
//
// Error surfacing:
//   - 409 one_live_session_per_effort → clear inline message with remediation hint
//   - 422 working_dir_outside_project_or_worktree → inline error
//   - 422 cwd_resolution_failed → inline error
//   - everything else → generic inline error with error code

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { authFetch } from '../auth'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NewSessionDialogProps {
  open: boolean
  effortId: string
  effortName: string
  /** Shown as placeholder in the working_dir field. Null when the effort has no
   *  override (falls back to project root_dir at spawn time). */
  effortWorkingDir: string | null
  onClose: () => void
  onCreated: (session: { id: string; ws_url: string }) => void
}

type SessionMode = 'interactive' | 'autonomous'

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------

export function NewSessionDialog({
  open,
  effortId,
  effortName,
  effortWorkingDir,
  onClose,
  onCreated,
}: NewSessionDialogProps) {
  const [mode, setMode] = useState<SessionMode>('interactive')
  const [workingDir, setWorkingDir] = useState('')
  const [initialPrompt, setInitialPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset state when dialog opens.
  useEffect(() => {
    if (open) {
      setMode('interactive')
      setWorkingDir('')
      setInitialPrompt('')
      setError(null)
    }
  }, [open])

  // ESC closes the dialog.
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])

  const handleSubmit = async () => {
    setError(null)
    setSubmitting(true)
    try {
      const body: Record<string, string | undefined> = {
        effort_id: effortId,
        mode,
      }
      if (workingDir.trim()) {
        body.working_dir = workingDir.trim()
      }
      if (initialPrompt.trim()) {
        body.initial_prompt = initialPrompt.trim()
      }

      const res = await authFetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const resBody = await res.json().catch(() => ({})) as {
          error?: string
          details?: Record<string, unknown>
        }
        const errCode = resBody?.error ?? ''

        if (errCode === 'one_live_session_per_effort') {
          setError(
            'This effort already has a live session. Resume or kill it first.',
          )
        } else if (errCode === 'working_dir_outside_project_or_worktree') {
          setError(
            `The working directory must be inside the project's root directory or a known worktree.`,
          )
        } else if (errCode === 'cwd_resolution_failed') {
          const msg = (resBody.details as { message?: string } | undefined)?.message
          setError(`Working directory could not be resolved: ${msg ?? 'path does not exist'}`)
        } else {
          setError(errCode || `Error ${res.status}`)
        }
        return
      }

      const created = await res.json() as { id: string; ws_url: string }
      onCreated(created)
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  const workingDirPlaceholder = effortWorkingDir
    ? `Defaults to: ${effortWorkingDir}`
    : 'Defaults to project root'

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl max-w-lg w-full flex flex-col"
        style={{ maxHeight: '80vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between shrink-0">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">New Session</h2>
            <p className="text-[11px] text-zinc-500 truncate mt-0.5">{effortName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 transition ml-4 shrink-0"
            aria-label="close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <div className="px-6 py-5 space-y-4 overflow-y-auto">

          {/* Mode */}
          <div className="space-y-1">
            <span className="text-[11px] uppercase tracking-wide text-zinc-500">Mode</span>
            <div className="flex gap-2">
              {(['interactive', 'autonomous'] as SessionMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`flex-1 py-1.5 rounded border text-xs transition ${
                    mode === m
                      ? 'border-zinc-500 bg-zinc-800 text-zinc-100'
                      : 'border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
                  }`}
                >
                  {m === 'interactive' ? 'Interactive' : 'Autonomous'}
                </button>
              ))}
            </div>
            {mode === 'autonomous' && (
              <p className="text-[11px] text-amber-400/80 mt-1">
                Autonomous mode runs without user interaction.
              </p>
            )}
          </div>

          {/* working_dir (optional) */}
          <div className="space-y-1">
            <label
              htmlFor="new-session-working-dir"
              className="text-[11px] uppercase tracking-wide text-zinc-500"
            >
              Working directory <span className="normal-case text-zinc-600">(optional)</span>
            </label>
            <input
              id="new-session-working-dir"
              type="text"
              value={workingDir}
              onChange={(e) => setWorkingDir(e.target.value)}
              placeholder={workingDirPlaceholder}
              className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-zinc-500 transition font-mono"
            />
          </div>

          {/* initial_prompt (optional) */}
          <div className="space-y-1">
            <label
              htmlFor="new-session-initial-prompt"
              className="text-[11px] uppercase tracking-wide text-zinc-500"
            >
              Initial prompt <span className="normal-case text-zinc-600">(optional)</span>
            </label>
            <textarea
              id="new-session-initial-prompt"
              value={initialPrompt}
              onChange={(e) => setInitialPrompt(e.target.value)}
              rows={3}
              placeholder={
                mode === 'autonomous'
                  ? 'Instruction to run autonomously…'
                  : 'Optional opening message…'
              }
              className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-zinc-500 transition resize-none"
            />
          </div>

          {/* Error */}
          {error && (
            <div className="text-xs text-rose-400 bg-rose-950/30 border border-rose-900/40 rounded px-3 py-2">
              {error}
            </div>
          )}

          {/* Footer */}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitting}
              className="px-4 py-2 text-xs rounded bg-emerald-700 text-white hover:bg-emerald-600 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed transition"
            >
              {submitting ? 'Starting…' : 'Start session'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
