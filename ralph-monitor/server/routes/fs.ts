// Filesystem listing endpoint for US-015a.
//
// GET /api/fs/list?path=<absolute-path>&show_hidden=<bool>
//
// Security model:
//   1. Calls realpathSync.native(path) first — 404 if the path doesn't exist
//      or can't be resolved (catches traversal attempts AND missing paths in
//      one step; the OS-native realpath collapses all ".." and symlinks).
//   2. Checks that the resolved path is rooted inside one of the
//      RALPH_MONITOR_PROJECT_ROOTS (colon-separated; default $HOME). The
//      comparison uses path.sep so /home/userX never matches /home/user.
//   3. Lists directory entries via readdir with { withFileTypes: true } and
//      returns { entries: [{ name, isDir, isSymlink }], normalizedPath }.
//
// Auth: /api/* is gated by bearerMiddleware in server/index.ts.
// This router is mounted via `app.route('/', fsRouter)` — no auth here.

import { Hono } from 'hono'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import nodeFs from 'node:fs/promises'

const fs = new Hono()

/**
 * Returns the realpath'd list of allowed roots from RALPH_MONITOR_PROJECT_ROOTS.
 * Roots that don't exist on disk are silently dropped. Reads env at call time
 * so tests can manipulate process.env.RALPH_MONITOR_PROJECT_ROOTS per-test.
 */
function getAllowedRoots(): string[] {
  const env = process.env.RALPH_MONITOR_PROJECT_ROOTS
  const raw = env && env.trim() ? env.split(':') : [homedir()]
  return raw
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .map((r) => {
      try {
        return realpathSync.native(r)
      } catch {
        return null
      }
    })
    .filter((r): r is string => r !== null)
}

fs.get('/api/fs/list', async (c) => {
  const requestedPath = c.req.query('path')
  if (!requestedPath || typeof requestedPath !== 'string') {
    return c.json({ error: 'path_required' }, 400)
  }
  const showHidden = c.req.query('show_hidden') === 'true'

  // Realpath first; 404 if it fails (path doesn't exist or unresolvable).
  let normalizedPath: string
  try {
    normalizedPath = realpathSync.native(requestedPath)
  } catch {
    return c.json({ error: 'path_not_found' }, 404)
  }

  // Allowlist check — resolves roots at call time so tests can swap the env var.
  const allowed = getAllowedRoots()
  const isAllowed = allowed.some(
    (root) => normalizedPath === root || normalizedPath.startsWith(root + path.sep),
  )
  if (!isAllowed) {
    return c.json({ error: 'path_outside_allowlist', allowed }, 403)
  }

  // List directory entries.
  let rawEntries: import('node:fs').Dirent<string>[]
  try {
    rawEntries = await nodeFs.readdir(normalizedPath, { withFileTypes: true, encoding: 'utf8' })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOTDIR') return c.json({ error: 'not_a_directory', normalizedPath }, 422)
    if (code === 'EACCES') return c.json({ error: 'permission_denied' }, 403)
    return c.json({ error: 'read_failed', message: (err as Error).message }, 500)
  }

  const entries: { name: string; isDir: boolean; isSymlink: boolean }[] = []
  for (const e of rawEntries) {
    if (!showHidden && e.name.startsWith('.')) continue
    entries.push({ name: e.name, isDir: e.isDirectory(), isSymlink: e.isSymbolicLink() })
  }

  return c.json({ entries, normalizedPath })
})

export { fs as fsRouter }
