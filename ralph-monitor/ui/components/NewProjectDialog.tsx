// NewProjectDialog — open a directory as a project.
//
// Two-step flow:
//   Step 1: Directory picker (browses /api/fs/list).
//   Step 2: Name field (defaulted to basename of the picked path, editable).
//
// Submitting calls POST /api/projects { name, root_dir } and fires onCreated
// with the new project. The server normalizes (realpaths, trims trailing
// slash) before inserting.

import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, X } from 'lucide-react'
import { authFetch } from '../auth'
import { DirectoryPicker } from './DirectoryPicker'

export interface NewProjectDialogProps {
  open: boolean
  onClose: () => void
  onCreated: (project: { id: string; name: string }) => void
}

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

export function NewProjectDialog({ open, onClose, onCreated }: NewProjectDialogProps) {
  type Step = 'pick' | 'name'

  const [step, setStep] = useState<Step>('pick')
  const [pickedPath, setPickedPath] = useState('')
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setStep('pick')
      setPickedPath('')
      setName('')
      setError(null)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])

  const handlePick = useCallback((path: string) => {
    setPickedPath(path)
    setName(basename(path) || path)
    setStep('name')
  }, [])

  const handleCreate = async () => {
    if (!name.trim() || !pickedPath) {
      setError('Name and directory are required')
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      const res = await authFetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), root_dir: pickedPath }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body?.error ?? `Create project failed (${res.status})`)
      }
      const project = (await res.json()) as { id: string; name: string }
      onCreated(project)
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

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
          <h2 className="text-sm font-semibold text-zinc-100">
            {step === 'pick' ? 'Open a folder' : 'New Project'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 transition"
            aria-label="close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {step === 'pick' && (
          <DirectoryPicker onPick={handlePick} onCancel={onClose} />
        )}

        {step === 'name' && (
          <div className="px-6 py-5 space-y-4 overflow-y-auto">
            <div className="flex items-center gap-2 text-xs text-zinc-400 bg-zinc-950 rounded px-3 py-2 font-mono">
              <FolderOpen className="w-3.5 h-3.5 text-amber-400/70 shrink-0" />
              <span className="truncate" title={pickedPath}>{pickedPath}</span>
              <button
                type="button"
                onClick={() => setStep('pick')}
                className="ml-auto text-zinc-500 hover:text-zinc-200 transition shrink-0 text-[11px] font-sans"
              >
                change
              </button>
            </div>

            <div className="space-y-1">
              <label
                htmlFor="new-project-name"
                className="text-[11px] uppercase tracking-wide text-zinc-500"
              >
                Project name
              </label>
              <input
                id="new-project-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !submitting) void handleCreate() }}
                autoFocus
                placeholder="My project"
                className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-zinc-500 transition"
              />
            </div>

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
                onClick={() => void handleCreate()}
                disabled={submitting || !name.trim()}
                className="px-4 py-2 text-xs rounded bg-emerald-700 text-white hover:bg-emerald-600 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed transition"
              >
                {submitting ? 'Creating…' : 'Create project'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
