// NewEffortDialog — US-015c
//
// Modal for creating a new effort under an existing project.
//
// Fields:
//   - name           (required)
//   - kind           ('prd' | 'task' | 'general')
//   - prd_path       (required when kind='prd'; optional path picker via
//                     DirectoryPicker that opens over the dialog)
//   - working_dir    (optional)
//
// Submits POST /api/projects/:id/efforts.
//
// On kind='prd': prd_path must be non-empty (enforced client-side AND server
// returns 422 prd_path_required_for_prd_kind if somehow bypassed). Server also
// validates that prd_path lies inside project.root_dir or a known worktree;
// we surface that 422 as an inline error.
//
// The DirectoryPicker sub-component is reused from DirectoryPicker.tsx.
//
// No new deps — only lucide-react (already in deps), React, authFetch.

import { useEffect, useState } from 'react'
import { File, FolderOpen, X } from 'lucide-react'
import { authFetch } from '../auth'
import { DirectoryPicker } from './DirectoryPicker'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NewEffortDialogProps {
  open: boolean
  projectId: string
  projectRootDir: string  // for path validation hint and picker start
  onClose: () => void
  onCreated: (effort: { id: string; name: string }) => void
  /** Pre-fill prd_path (e.g. from "Add as effort" flow in NewProjectDialog). */
  initialPickedPath?: string
}

type EffortKind = 'prd' | 'task' | 'general'

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------

export function NewEffortDialog({
  open,
  projectId,
  projectRootDir,
  onClose,
  onCreated,
  initialPickedPath,
}: NewEffortDialogProps) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<EffortKind>('task')
  const [prdPath, setPrdPath] = useState(initialPickedPath ?? '')
  const [workingDir, setWorkingDir] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // When true, show the DirectoryPicker for prd_path instead of main form.
  const [pickingPrdPath, setPickingPrdPath] = useState(false)

  // Reset state when dialog opens/closes.
  useEffect(() => {
    if (open) {
      setName('')
      setKind('task')
      setPrdPath(initialPickedPath ?? '')
      setWorkingDir('')
      setError(null)
      setPickingPrdPath(false)
    }
  }, [open, initialPickedPath])

  // ESC closes the dialog (or cancels the picker sub-view).
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (pickingPrdPath) {
          setPickingPrdPath(false)
        } else {
          onClose()
        }
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose, pickingPrdPath])

  const prdPathMissing = kind === 'prd' && !prdPath.trim()

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError('Name is required')
      return
    }
    if (prdPathMissing) {
      setError('prd_path is required for PRD efforts')
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      const body: Record<string, string | null | undefined> = {
        name: name.trim(),
        kind,
      }
      if (kind === 'prd') {
        body.prd_path = prdPath.trim()
      }
      if (workingDir.trim()) {
        body.working_dir = workingDir.trim()
      }

      const res = await authFetch(`/api/projects/${projectId}/efforts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const resBody = await res.json().catch(() => ({})) as { error?: string }
        const errCode = resBody?.error ?? ''
        if (errCode === 'prd_path_required_for_prd_kind') {
          setError('A prd_path is required for PRD efforts.')
        } else if (errCode === 'prd_path_outside_project_or_worktree') {
          setError(
            `The prd_path must be inside the project's root directory or a known worktree.`,
          )
        } else {
          setError(errCode || `Error ${res.status}`)
        }
        return
      }
      const effort = await res.json() as { id: string; name: string }
      onCreated(effort)
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  // ---------------------------------------------------------------------------
  // Sub-view: DirectoryPicker for prd_path
  // ---------------------------------------------------------------------------

  if (pickingPrdPath) {
    return (
      <div
        className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
        onClick={() => setPickingPrdPath(false)}
      >
        <div
          className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl max-w-lg w-full flex flex-col"
          style={{ maxHeight: '80vh' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between shrink-0">
            <h2 className="text-sm font-semibold text-zinc-100">
              Pick PRD path
            </h2>
            <button
              type="button"
              onClick={() => setPickingPrdPath(false)}
              className="text-zinc-500 hover:text-zinc-200 transition"
              aria-label="close picker"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <DirectoryPicker
            initialPath={projectRootDir}
            onPick={(p) => {
              setPrdPath(p)
              setPickingPrdPath(false)
            }}
            onCancel={() => setPickingPrdPath(false)}
          />
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Main form
  // ---------------------------------------------------------------------------

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
          <h2 className="text-sm font-semibold text-zinc-100">New Effort</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 transition"
            aria-label="close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <div className="px-6 py-5 space-y-4 overflow-y-auto">

          {/* Project root hint */}
          <div className="flex items-center gap-2 text-xs text-zinc-500 bg-zinc-950 rounded px-3 py-2 font-mono">
            <FolderOpen className="w-3.5 h-3.5 text-amber-400/70 shrink-0" />
            <span className="truncate" title={projectRootDir}>{projectRootDir}</span>
          </div>

          {/* Name */}
          <div className="space-y-1">
            <label
              htmlFor="new-effort-name"
              className="text-[11px] uppercase tracking-wide text-zinc-500"
            >
              Name
            </label>
            <input
              id="new-effort-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !submitting && !prdPathMissing) {
                  void handleSubmit()
                }
              }}
              autoFocus
              placeholder="Effort name"
              className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-zinc-500 transition"
            />
          </div>

          {/* Kind */}
          <div className="space-y-1">
            <span className="text-[11px] uppercase tracking-wide text-zinc-500">Kind</span>
            <div className="flex gap-2">
              {(['task', 'general', 'prd'] as EffortKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`flex-1 py-1.5 rounded border text-xs transition ${
                    kind === k
                      ? 'border-zinc-500 bg-zinc-800 text-zinc-100'
                      : 'border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
                  }`}
                >
                  {k.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* prd_path — only shown when kind='prd' */}
          {kind === 'prd' && (
            <div className="space-y-1">
              <label
                htmlFor="new-effort-prd-path"
                className="text-[11px] uppercase tracking-wide text-zinc-500"
              >
                PRD path <span className="normal-case text-rose-400">*</span>
              </label>
              <div className="flex gap-2">
                <input
                  id="new-effort-prd-path"
                  type="text"
                  value={prdPath}
                  onChange={(e) => setPrdPath(e.target.value)}
                  placeholder="/path/to/prd.json"
                  className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-zinc-500 transition font-mono"
                />
                <button
                  type="button"
                  onClick={() => setPickingPrdPath(true)}
                  title="Browse for PRD directory"
                  className="px-3 py-2 text-xs rounded border border-zinc-700 text-zinc-400 hover:text-zinc-100 hover:border-zinc-500 transition flex items-center gap-1"
                >
                  <File className="w-3.5 h-3.5" />
                  Browse
                </button>
              </div>
              {prdPathMissing && (
                <p className="text-[11px] text-rose-400 mt-1">
                  prd_path is required for PRD efforts
                </p>
              )}
            </div>
          )}

          {/* working_dir (optional) */}
          <div className="space-y-1">
            <label
              htmlFor="new-effort-working-dir"
              className="text-[11px] uppercase tracking-wide text-zinc-500"
            >
              Working directory <span className="normal-case text-zinc-600">(optional)</span>
            </label>
            <input
              id="new-effort-working-dir"
              type="text"
              value={workingDir}
              onChange={(e) => setWorkingDir(e.target.value)}
              placeholder="defaults to project root"
              className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-zinc-500 transition font-mono"
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
              disabled={submitting || !name.trim() || prdPathMissing}
              className="px-4 py-2 text-xs rounded bg-emerald-700 text-white hover:bg-emerald-600 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed transition"
            >
              {submitting ? 'Creating…' : 'Create effort'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
