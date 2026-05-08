// DirectoryPicker — extracted from NewProjectDialog (US-015b) for reuse.
//
// Browsable directory picker that calls /api/fs/list and lets the user
// navigate down a directory tree. Fires onPick(path) when the user confirms
// the current folder and onCancel() when they close without picking.
//
// No new deps — only lucide-react (already in deps), React, authFetch.

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, Folder, FolderOpen } from 'lucide-react'
import { authFetch } from '../auth'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FsEntry {
  name: string
  isDir: boolean
  isSymlink: boolean
}

interface FsListResult {
  entries: FsEntry[]
  normalizedPath: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Portable dirname — returns parent of p; falls back to p itself at root. */
function parentDir(p: string): string {
  const trimmed = p.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  if (idx <= 0) return '/' // already at root or one level below
  return trimmed.slice(0, idx)
}

/** Split path into breadcrumb segments for display. */
function breadcrumbs(p: string): { label: string; path: string }[] {
  const parts = p.replace(/\/+$/, '').split('/').filter(Boolean)
  const segs: { label: string; path: string }[] = [{ label: '/', path: '/' }]
  let acc = ''
  for (const part of parts) {
    acc += '/' + part
    segs.push({ label: part, path: acc })
  }
  return segs
}

// ---------------------------------------------------------------------------
// DirectoryPicker component
// ---------------------------------------------------------------------------

export interface DirectoryPickerProps {
  onPick: (path: string) => void
  onCancel: () => void
  /** Optional initial path to start from (overrides the heuristic probe). */
  initialPath?: string
}

export function DirectoryPicker({ onPick, onCancel, initialPath }: DirectoryPickerProps) {
  // Start from the first allowed root — we discover it by fetching
  // /api/fs/list?path=<HOME> (using the browser's location to derive HOME is
  // unreliable; instead we attempt a sequence of heuristic paths and fall back
  // gracefully). The server will 403 if we're outside the allowlist and 404 if
  // the path doesn't exist — both cases we handle by backing off to '/'.
  //
  // Hedge: if RALPH_MONITOR_PROJECT_ROOTS is set to a path that doesn't contain
  // HOME, the initial fetch may 403 or 404. In that case we fall back to '/'
  // and let the user navigate from there; they'll hit another 403 when they
  // try to enter a directory outside the allowlist.
  const [currentPath, setCurrentPath] = useState<string>('')
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const initialized = useRef(false)

  const fetchDir = useCallback(async (path: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await authFetch(`/api/fs/list?path=${encodeURIComponent(path)}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string; normalizedPath?: string }
        if (res.status === 404) {
          setError(`Path not found: ${path}`)
        } else if (res.status === 403) {
          setError(`Access denied: ${path} is outside the allowed roots.`)
        } else {
          setError(body?.error ?? `Error fetching directory (${res.status})`)
        }
        return
      }
      const data = await res.json() as FsListResult
      setCurrentPath(data.normalizedPath)
      // Show only directories (and symlinks that point to dirs) in the picker.
      setEntries(data.entries.filter((e) => e.isDir || e.isSymlink))
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setLoading(false)
    }
  }, [])

  // Discover starting path on mount.
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    if (initialPath) {
      void fetchDir(initialPath)
      return
    }

    // Ask the server which directory to start in. Defaults to $HOME unless
    // RALPH_MONITOR_PROJECT_ROOTS overrides it.
    ;(async () => {
      try {
        const res = await authFetch('/api/fs/roots')
        if (res.ok) {
          const body = (await res.json()) as { default?: string; roots?: string[] }
          const start = body.default ?? body.roots?.[0]
          if (start) {
            await fetchDir(start)
            return
          }
        }
      } catch {}
      setError('Could not determine a starting directory. Please navigate manually.')
    })()
  }, [fetchDir, initialPath])

  const handleNavigate = (path: string) => {
    void fetchDir(path)
  }

  const crumbs = currentPath ? breadcrumbs(currentPath) : []

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {/* Breadcrumb */}
      <div className="flex items-center flex-wrap gap-0.5 px-6 pt-3 pb-2 border-b border-zinc-800 min-h-0">
        {crumbs.map((seg, i) => (
          <span key={seg.path} className="flex items-center gap-0.5">
            {i > 0 && <ChevronRight className="w-3 h-3 text-zinc-600 shrink-0" />}
            <button
              type="button"
              onClick={() => handleNavigate(seg.path)}
              className="text-[11px] text-zinc-400 hover:text-zinc-100 transition truncate max-w-[120px]"
              title={seg.path}
            >
              {seg.label}
            </button>
          </span>
        ))}
        {!currentPath && (
          <span className="text-[11px] text-zinc-600 italic">loading…</span>
        )}
      </div>

      {/* Entry list */}
      <div className="flex-1 overflow-y-auto px-2 py-2 min-h-0" style={{ maxHeight: '280px' }}>
        {loading && (
          <div className="text-[11px] text-zinc-600 px-4 py-2 italic">Loading…</div>
        )}
        {error && (
          <div className="text-xs text-rose-400 bg-rose-950/30 border border-rose-900/40 rounded mx-2 my-1 px-3 py-2">
            {error}
          </div>
        )}
        {!loading && !error && currentPath && entries.length === 0 && (
          <div className="text-[11px] text-zinc-600 px-4 py-2 italic">Empty directory</div>
        )}
        {!loading && entries.map((entry) => {
          const entryPath = currentPath
            ? currentPath.replace(/\/+$/, '') + '/' + entry.name
            : '/' + entry.name
          return (
            <button
              key={entry.name}
              type="button"
              onClick={() => handleNavigate(entryPath)}
              className="w-full flex items-center gap-2 px-3 py-1.5 rounded text-left hover:bg-zinc-800/60 transition"
            >
              <Folder className="w-3.5 h-3.5 text-amber-400/70 shrink-0" />
              <span className="text-sm text-zinc-300 truncate">{entry.name}</span>
              {entry.isSymlink && (
                <span className="text-[10px] text-zinc-600 shrink-0">symlink</span>
              )}
            </button>
          )
        })}
      </div>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-zinc-800 flex items-center justify-between gap-3">
        {/* Up navigation */}
        <button
          type="button"
          onClick={() => currentPath && handleNavigate(parentDir(currentPath))}
          disabled={!currentPath || currentPath === '/'}
          className="text-xs text-zinc-400 hover:text-zinc-100 disabled:text-zinc-700 disabled:cursor-not-allowed transition"
        >
          ↑ Up
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 text-xs rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => currentPath && onPick(currentPath)}
            disabled={!currentPath}
            className="px-4 py-1.5 text-xs rounded bg-zinc-700 text-zinc-100 hover:bg-zinc-600 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed transition flex items-center gap-1.5"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            Use this folder
          </button>
        </div>
      </div>
    </div>
  )
}
