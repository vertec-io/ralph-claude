// AdoptPrdDialog — modal for adopting an unmanaged PRD into a project.
//
// Usage:
//   <AdoptPrdDialog item={unmanagedItem} projects={projects} onClose={...} onAdopted={...} />
//
// Flow:
//  1. User picks an existing project from the autocomplete-by-root_dir list
//     OR selects "Create new project" and fills in name + root_dir.
//  2. On submit: POST /api/projects/:id/efforts with kind='prd',
//     prd_path = join(item.taskDir, 'prd.json'), working_dir = item.worktreeDir.
//  3. On success: onAdopted() callback fires (caller re-fetches unmanaged list).

import { useEffect, useRef, useState } from 'react'
import { join } from 'node:path'
import { authFetch } from '../auth'
import type { UnmanagedPRDItem } from '../../server/routes/unmanaged'
import type { Project } from '../../server/db'

// We inline a minimal path.join-compatible helper so this works in the browser
// bundle without relying on Node's `path` polyfill being in scope.
function pathJoin(...parts: string[]): string {
  return parts
    .join('/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '') || '/'
}

interface Props {
  item: UnmanagedPRDItem
  projects: Project[]
  onClose: () => void
  onAdopted: () => void
}

type Mode = 'existing' | 'new'

export function AdoptPrdDialog({ item, projects, onClose, onAdopted }: Props) {
  const [mode, setMode] = useState<Mode>(
    item.suggestedProjectId ? 'existing' : 'existing',
  )

  // Existing-project picker
  const [query, setQuery] = useState('')
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    item.suggestedProjectId ?? '',
  )
  const [showDropdown, setShowDropdown] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // New-project fields
  const [newName, setNewName] = useState('')
  const [newRootDir, setNewRootDir] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Pre-fill the search box when suggestedProjectId is set
  useEffect(() => {
    if (item.suggestedProjectId) {
      const p = projects.find((p) => p.id === item.suggestedProjectId)
      if (p) setQuery(p.root_dir)
    }
  }, [item.suggestedProjectId, projects])

  // Close on ESC
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const prdPath = pathJoin(item.taskDir, 'prd.json')
  const displayTitle = item.unitName.replace(/^ralph-pilot-native-/, '')

  // Filtered project list for autocomplete
  const filtered = projects.filter((p) => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return (
      p.root_dir.toLowerCase().includes(q) ||
      p.name.toLowerCase().includes(q)
    )
  })

  const selectedProject = projects.find((p) => p.id === selectedProjectId)

  async function createNewProjectAndAdopt(): Promise<void> {
    // 1. Create project
    const pr = await authFetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim(), root_dir: newRootDir.trim() }),
    })
    if (!pr.ok) {
      const body = await pr.json().catch(() => ({}))
      throw new Error((body as any)?.error ?? `create project failed (${pr.status})`)
    }
    const project = (await pr.json()) as Project
    await adoptIntoProject(project.id)
  }

  async function adoptIntoProject(projectId: string): Promise<void> {
    const body: Record<string, string> = {
      name: displayTitle,
      kind: 'prd',
      prd_path: prdPath,
    }
    if (item.worktreeDir) body.working_dir = item.worktreeDir

    const er = await authFetch(`/api/projects/${projectId}/efforts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!er.ok) {
      const b = await er.json().catch(() => ({}))
      throw new Error((b as any)?.error ?? `create effort failed (${er.status})`)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      if (mode === 'new') {
        if (!newName.trim() || !newRootDir.trim()) {
          setError('name and root directory are required')
          return
        }
        await createNewProjectAndAdopt()
      } else {
        if (!selectedProjectId) {
          setError('pick a project or choose "Create new project"')
          return
        }
        await adoptIntoProject(selectedProjectId)
      }
      onAdopted()
    } catch (err: unknown) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl max-w-lg w-full"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Adopt into project</h2>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 text-2xl leading-none px-2"
            aria-label="close"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-5">
          {/* PRD info */}
          <div className="text-xs text-zinc-500 font-mono bg-zinc-950 rounded px-3 py-2 space-y-0.5">
            <div className="text-zinc-300 font-sans text-sm font-medium">{displayTitle}</div>
            <div>prd_path: {prdPath}</div>
            {item.worktreeDir && <div>working_dir: {item.worktreeDir}</div>}
          </div>

          {/* Mode toggle */}
          <div className="flex gap-3 text-sm">
            <button
              type="button"
              onClick={() => setMode('existing')}
              className={`flex-1 py-1.5 rounded border text-xs ${
                mode === 'existing'
                  ? 'border-zinc-500 bg-zinc-800 text-zinc-100'
                  : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Use existing project
            </button>
            <button
              type="button"
              onClick={() => setMode('new')}
              className={`flex-1 py-1.5 rounded border text-xs ${
                mode === 'new'
                  ? 'border-zinc-500 bg-zinc-800 text-zinc-100'
                  : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Create new project
            </button>
          </div>

          {mode === 'existing' && (
            <div className="space-y-1 relative">
              <label className="text-[11px] uppercase tracking-wide text-zinc-500">
                Project (search by root_dir or name)
              </label>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setSelectedProjectId('')
                  setShowDropdown(true)
                }}
                onFocus={() => setShowDropdown(true)}
                onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
                placeholder="type to filter…"
                className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-zinc-500"
              />
              {showDropdown && filtered.length > 0 && (
                <ul className="absolute z-20 w-full bg-zinc-900 border border-zinc-700 rounded mt-1 max-h-48 overflow-y-auto shadow-xl">
                  {filtered.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onMouseDown={() => {
                          setSelectedProjectId(p.id)
                          setQuery(p.root_dir)
                          setShowDropdown(false)
                        }}
                        className={`w-full text-left px-3 py-2 text-xs hover:bg-zinc-800 ${
                          p.id === selectedProjectId ? 'bg-zinc-800' : ''
                        }`}
                      >
                        <div className="text-zinc-200 font-medium">{p.name}</div>
                        <div className="text-zinc-500 font-mono truncate">{p.root_dir}</div>
                        {p.id === item.suggestedProjectId && (
                          <div className="text-emerald-400 text-[10px] mt-0.5">
                            suggested (worktree match
                            {item.suggestedBranch ? ` · ${item.suggestedBranch}` : ''})
                          </div>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {selectedProject && (
                <div className="text-[11px] text-zinc-500 mt-1">
                  selected: <span className="text-zinc-300">{selectedProject.name}</span>
                </div>
              )}
            </div>
          )}

          {mode === 'new' && (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-[11px] uppercase tracking-wide text-zinc-500">
                  Project name
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="My project"
                  className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-zinc-500"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] uppercase tracking-wide text-zinc-500">
                  Root directory
                </label>
                <input
                  type="text"
                  value={newRootDir}
                  onChange={(e) => setNewRootDir(e.target.value)}
                  placeholder="/absolute/path/to/project"
                  className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-zinc-500 font-mono"
                />
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
              className="px-4 py-2 text-xs rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-xs rounded bg-emerald-700 text-white hover:bg-emerald-600 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed"
            >
              {submitting ? 'Adopting…' : 'Adopt'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
