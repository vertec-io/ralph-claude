// Footer git-status bar. Polls /api/projects/:id/git-status every 5s and
// renders a compact "branch · ahead/behind upstream · N changes" line. Hidden
// when the project root_dir isn't a git repo.

import { useEffect, useState } from 'react'
import { GitBranch, ArrowUp, ArrowDown, FileEdit } from 'lucide-react'
import { authFetch } from '../auth'

interface GitStatus {
  is_repo: boolean
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  dirty_count: number
}

export interface GitStatusBarProps {
  projectId: string
}

export function GitStatusBar({ projectId }: GitStatusBarProps) {
  const [status, setStatus] = useState<GitStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null

    const fetchStatus = async () => {
      try {
        const res = await authFetch(`/api/projects/${projectId}/git-status`)
        if (!res.ok || cancelled) return
        const body = (await res.json()) as GitStatus
        if (!cancelled) setStatus(body)
      } catch {}
    }

    void fetchStatus()
    timer = setInterval(fetchStatus, 5000)

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [projectId])

  if (!status || !status.is_repo) return null

  const branchLabel = status.detached
    ? `(detached @ ${status.branch ?? '???'})`
    : status.branch ?? '?'
  const upstreamLabel = status.upstream ?? 'origin/main'

  return (
    <footer className="border-t border-zinc-800 bg-zinc-950 px-4 py-1.5 text-[11px] text-zinc-500 flex items-center gap-3 font-mono shrink-0">
      <span className="inline-flex items-center gap-1 text-zinc-300">
        <GitBranch className="w-3 h-3" />
        {branchLabel}
      </span>
      <span className="text-zinc-600">vs {upstreamLabel}</span>
      {(status.ahead > 0 || status.behind > 0) && (
        <span className="inline-flex items-center gap-2">
          {status.ahead > 0 && (
            <span className="inline-flex items-center gap-0.5 text-emerald-400">
              <ArrowUp className="w-3 h-3" />
              {status.ahead}
            </span>
          )}
          {status.behind > 0 && (
            <span className="inline-flex items-center gap-0.5 text-amber-400">
              <ArrowDown className="w-3 h-3" />
              {status.behind}
            </span>
          )}
        </span>
      )}
      {status.dirty_count > 0 ? (
        <span className="inline-flex items-center gap-0.5 text-rose-400">
          <FileEdit className="w-3 h-3" />
          {status.dirty_count} changed
        </span>
      ) : (
        <span className="text-zinc-600">clean</span>
      )}
    </footer>
  )
}
