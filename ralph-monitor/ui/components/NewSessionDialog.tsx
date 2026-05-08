// NewSessionDialog — start a new claude conversation under a project.
//
// Fields:
//   - working_dir   (optional override; placeholder shows project.root_dir)
//   - initial_prompt (optional; sent to claude on spawn)
//   - PRD multi-select (optional; associates the new conversation with PRDs)
//
// Submits POST /api/projects/:pid/sessions { working_dir?, initial_prompt?, prd_spec_ids?, title? }.

import { useEffect, useState } from 'react'
import { X, FolderOpen, FileText } from 'lucide-react'
import { authFetch } from '../auth'
import { DirectoryPicker } from './DirectoryPicker'
import type { Project } from '../../server/db/projects'
import type { PrdSpec } from '../../server/db/prdSpecs'

export interface NewSessionDialogProps {
  open: boolean
  project: Project
  onClose: () => void
  onCreated: (session: { id: string; ws_url: string }) => void
}

export function NewSessionDialog({ open, project, onClose, onCreated }: NewSessionDialogProps) {
  const [workingDir, setWorkingDir] = useState('')
  const [initialPrompt, setInitialPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [prdSpecs, setPrdSpecs] = useState<PrdSpec[]>([])
  const [selectedPrdIds, setSelectedPrdIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (open) {
      setWorkingDir('')
      setInitialPrompt('')
      setError(null)
      setPickerOpen(false)
      setSelectedPrdIds(new Set())
      // Fetch PRDs for the optional multi-select.
      void (async () => {
        try {
          const res = await authFetch(`/api/projects/${project.id}/prds`)
          if (res.ok) {
            const body = (await res.json()) as { prds: PrdSpec[] }
            setPrdSpecs(body.prds)
          }
        } catch {}
      })()
    }
  }, [open, project.id])

  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])

  const togglePrd = (id: string) => {
    setSelectedPrdIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSubmit = async () => {
    setError(null)
    setSubmitting(true)
    try {
      const body: Record<string, unknown> = {}
      if (workingDir.trim()) body.working_dir = workingDir.trim()
      if (initialPrompt.trim()) body.initial_prompt = initialPrompt.trim()
      if (selectedPrdIds.size > 0) body.prd_spec_ids = [...selectedPrdIds]

      const res = await authFetch(`/api/projects/${project.id}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const resBody = (await res.json().catch(() => ({}))) as {
          error?: string
          details?: Record<string, unknown>
        }
        const errCode = resBody?.error ?? ''
        if (errCode === 'working_dir_outside_project_or_worktree') {
          setError(`Working directory must be inside the project's root or a known worktree.`)
        } else if (errCode === 'cwd_resolution_failed') {
          const msg = (resBody.details as { message?: string } | undefined)?.message
          setError(`Working directory could not be resolved: ${msg ?? 'path does not exist'}`)
        } else {
          setError(errCode || `Error ${res.status}`)
        }
        return
      }

      const created = (await res.json()) as { id: string; ws_url: string }
      onCreated(created)
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  if (pickerOpen) {
    return (
      <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6">
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl max-w-2xl w-full flex flex-col" style={{ maxHeight: '80vh' }}>
          <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between shrink-0">
            <h2 className="text-sm font-semibold text-zinc-100">Pick a working directory</h2>
            <button
              type="button"
              onClick={() => setPickerOpen(false)}
              className="text-zinc-500 hover:text-zinc-200 transition"
              aria-label="close picker"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="px-6 py-5 overflow-y-auto">
            <DirectoryPicker
              initialPath={project.root_dir}
              onPick={(p) => { setWorkingDir(p); setPickerOpen(false) }}
              onCancel={() => setPickerOpen(false)}
            />
          </div>
        </div>
      </div>
    )
  }

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
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between shrink-0">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">New Session</h2>
            <p className="text-[11px] text-zinc-500 truncate mt-0.5">{project.name}</p>
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

        <div className="px-6 py-5 space-y-4 overflow-y-auto">
          <div className="space-y-1">
            <label
              htmlFor="new-session-working-dir"
              className="text-[11px] uppercase tracking-wide text-zinc-500"
            >
              Working directory <span className="normal-case text-zinc-600">(optional)</span>
            </label>
            <div className="flex gap-2">
              <input
                id="new-session-working-dir"
                type="text"
                value={workingDir}
                onChange={(e) => setWorkingDir(e.target.value)}
                placeholder={`Defaults to: ${project.root_dir}`}
                className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-zinc-500 transition font-mono"
              />
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="shrink-0 inline-flex items-center gap-1 px-3 py-2 text-xs rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition"
                title="Browse"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                Browse
              </button>
            </div>
          </div>

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
              placeholder="Opening message sent to claude on spawn…"
              className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-zinc-500 transition resize-none"
            />
          </div>

          {prdSpecs.length > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">
                Associate with PRDs <span className="normal-case text-zinc-600">(optional)</span>
              </div>
              <div className="border border-zinc-800 rounded divide-y divide-zinc-800/60 max-h-44 overflow-y-auto">
                {prdSpecs.map((p) => (
                  <label
                    key={p.id}
                    className="flex items-center gap-3 px-3 py-2 hover:bg-zinc-900 cursor-pointer transition"
                  >
                    <input
                      type="checkbox"
                      checked={selectedPrdIds.has(p.id)}
                      onChange={() => togglePrd(p.id)}
                      className="accent-emerald-600"
                    />
                    <FileText className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                    <span className="text-sm text-zinc-200 truncate">{p.slug}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="text-xs text-rose-400 bg-rose-950/30 border border-rose-900/40 rounded px-3 py-2">
              {error}
            </div>
          )}

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
