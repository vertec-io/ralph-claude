// Shared helper around `git worktree list --porcelain`.
//
// Used by:
//   - US-005d (POST /api/sessions): validate working_dir resolves to either
//     project.root_dir or a known worktree of it.
//   - US-013 (Unmanaged PRDs): map a discovered worktree back to its project.
//   - US-015b (New Project flow): if the user picks a path that's already a
//     worktree of an existing project, surface that to avoid duplicating it.
//
// Two-layer design:
//   1. `parseWorktreeList(porcelain)` — pure function over the porcelain blob.
//      Exported so unit tests can hit the parser without spawning git.
//   2. `listWorktrees(projectRootDir)` — runs `git -C <dir> worktree list
//      --porcelain` synchronously, parses the result, and caches the parsed
//      list per project for 30s. A non-zero git exit (eg. dir is not a git
//      repo) returns [] — graceful, since we want callers to be able to
//      treat the absence of worktrees as a normal case.
//
// Path comparisons all go through `realpathSync.native` because we want
// /a/b/symlink-to-c to match a worktree at /a/b/c. We also strip a trailing
// slash from the realpath output for the same reason as `prepareSpawn` —
// libc's behavior on whether the trailing slash is preserved varies for the
// root path "/" so we normalize defensively.

import { realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

export interface Worktree {
  path: string         // absolute path as reported by git (NOT realpath'd)
  branch: string | null
  bare?: boolean
}

const cache = new Map<string, { entries: Worktree[]; cachedAt: number }>()
const CACHE_TTL_MS = 30_000

// Pure parser. Exported so the tests can pass a fake porcelain blob without
// spawning git. The porcelain format groups attributes per worktree as
// adjacent lines, with blank lines between worktrees:
//
//   worktree /path/to/main
//   HEAD <sha>
//   branch refs/heads/main
//
//   worktree /path/to/wt
//   HEAD <sha>
//   detached
//
//   worktree /path/to/bare
//   bare
//
// We only consume the four attributes we care about (worktree, branch,
// detached, bare) and ignore everything else for forward-compat.
export function parseWorktreeList(porcelainText: string): Worktree[] {
  if (!porcelainText) return []
  const out: Worktree[] = []
  const blocks = porcelainText
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
  for (const block of blocks) {
    const lines = block.split('\n')
    const wt: Partial<Worktree> = {}
    for (const raw of lines) {
      const line = raw.trimEnd()
      if (line.startsWith('worktree ')) {
        wt.path = line.slice('worktree '.length)
      } else if (line.startsWith('branch refs/heads/')) {
        wt.branch = line.slice('branch refs/heads/'.length)
      } else if (line === 'detached') {
        wt.branch = null
      } else if (line === 'bare') {
        wt.bare = true
      }
    }
    if (typeof wt.path === 'string' && wt.path.length > 0) {
      out.push({
        path: wt.path,
        branch: wt.branch ?? null,
        ...(wt.bare ? { bare: true } : {}),
      })
    }
  }
  return out
}

function readWorktrees(projectRootDir: string): Worktree[] {
  const result = spawnSync(
    'git',
    ['-C', projectRootDir, 'worktree', 'list', '--porcelain'],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) return [] // not a git repo, command missing, etc.
  return parseWorktreeList(result.stdout ?? '')
}

export function listWorktrees(projectRootDir: string): Worktree[] {
  const now = Date.now()
  const hit = cache.get(projectRootDir)
  if (hit && now - hit.cachedAt < CACHE_TTL_MS) return hit.entries
  const entries = readWorktrees(projectRootDir)
  cache.set(projectRootDir, { entries, cachedAt: now })
  return entries
}

// Test-only escape hatch. Exported under a regular name (not __test__) because
// the route-handler tests in routes.test.ts need to clear the cache between
// tests that share the process-wide singleton.
export function clearWorktreeCacheForTests(): void {
  cache.clear()
}

// Production cache-eviction hook. Call this when a project is deleted so that
// subsequent worktree lookups for the same root_dir go back to disk rather than
// returning stale (now-meaningless) entries for a project that no longer exists.
export function evictWorktreeCacheForProject(rootDir: string): void {
  cache.delete(rootDir)
  // Also evict any realpath'd variant (callers may have looked up with either
  // the raw or the resolved path).
  try {
    const real = realpathSync.native(rootDir)
    if (real !== rootDir) cache.delete(real)
  } catch {
    // rootDir no longer exists on disk after the delete — that's fine; it
    // won't be in the cache under the resolved path anyway.
  }
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync.native(p)
  } catch {
    return null
  }
}

// Returns true if `pickedPath` resolves to either `projectRootDir` itself or
// one of its `git worktree list` entries. realpath both sides so symlinked
// inputs match. Returns false (rather than throwing) when either side can't
// be realpath'd — the caller's job is to translate that into a 422.
export function isPathInProjectOrWorktree(
  projectRootDir: string,
  pickedPath: string,
): boolean {
  const projN = realpathOrNull(projectRootDir)
  const pickedN = realpathOrNull(pickedPath)
  if (!projN || !pickedN) return false
  if (projN === pickedN) return true
  for (const wt of listWorktrees(projN)) {
    const wtN = realpathOrNull(wt.path)
    if (wtN && wtN === pickedN) return true
  }
  return false
}

// Used by US-015b — returns matched worktree info if pickedPath IS a worktree
// (or the root) of any of the supplied projects.
export function checkIsWorktreeOfProject(
  pickedPath: string,
  projects: { id: string; root_dir: string }[],
):
  | { matched: true; projectId: string; branch: string | null }
  | { matched: false } {
  const pickedN = realpathOrNull(pickedPath)
  if (!pickedN) return { matched: false }
  for (const p of projects) {
    const projN = realpathOrNull(p.root_dir)
    if (!projN) continue
    if (projN === pickedN) return { matched: true, projectId: p.id, branch: null }
    for (const wt of listWorktrees(projN)) {
      const wtN = realpathOrNull(wt.path)
      if (wtN && wtN === pickedN) {
        return { matched: true, projectId: p.id, branch: wt.branch }
      }
    }
  }
  return { matched: false }
}
