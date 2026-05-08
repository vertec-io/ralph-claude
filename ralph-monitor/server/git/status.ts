// Lightweight git-status snapshot for a directory.
//
// Used by the project-detail footer to surface "what branch am I on, am I
// ahead/behind upstream, and is there uncommitted work?". Synchronous spawns
// are fine — we cache results per dir for 5 seconds, and the UI polls at most
// every few seconds anyway.

import { spawnSync } from 'node:child_process'

export interface GitStatus {
  is_repo: boolean
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  dirty_count: number
}

const cache = new Map<string, { ts: number; status: GitStatus }>()
const CACHE_TTL_MS = 5_000

function gitOut(rootDir: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', rootDir, ...args], {
    encoding: 'utf8',
    timeout: 1500,
  })
  if (r.status !== 0) return null
  return (r.stdout ?? '').trim()
}

export function getGitStatus(rootDir: string, force = false): GitStatus {
  if (!force) {
    const c = cache.get(rootDir)
    if (c && Date.now() - c.ts < CACHE_TTL_MS) return c.status
  }

  const inside = gitOut(rootDir, ['rev-parse', '--is-inside-work-tree'])
  if (inside !== 'true') {
    const status: GitStatus = {
      is_repo: false,
      branch: null,
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      dirty_count: 0,
    }
    cache.set(rootDir, { ts: Date.now(), status })
    return status
  }

  // Branch name. `--abbrev-ref HEAD` returns 'HEAD' for detached state.
  const headRef = gitOut(rootDir, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? null
  const detached = headRef === 'HEAD'
  const branch = detached
    ? gitOut(rootDir, ['rev-parse', '--short', 'HEAD'])
    : headRef

  // Upstream — explicit configured upstream first, fall back to origin/main
  // for the ahead/behind count when none is set.
  let upstream = gitOut(rootDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (!upstream || upstream.length === 0) upstream = null

  let ahead = 0
  let behind = 0
  if (upstream || !detached) {
    const target = upstream ?? 'origin/main'
    const out = gitOut(rootDir, ['rev-list', '--left-right', '--count', `HEAD...${target}`])
    if (out) {
      const parts = out.split(/\s+/).map((n) => parseInt(n, 10))
      if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
        ahead = parts[0]!
        behind = parts[1]!
      }
    }
  }

  // Working-tree dirtiness — a single line per change.
  const dirtyOut = gitOut(rootDir, ['status', '--porcelain'])
  const dirty_count = dirtyOut ? dirtyOut.split('\n').filter((l) => l.length > 0).length : 0

  const status: GitStatus = {
    is_repo: true,
    branch: branch ?? null,
    detached,
    upstream,
    ahead,
    behind,
    dirty_count,
  }
  cache.set(rootDir, { ts: Date.now(), status })
  return status
}

export function invalidateGitStatusCache(rootDir?: string): void {
  if (rootDir) cache.delete(rootDir)
  else cache.clear()
}
