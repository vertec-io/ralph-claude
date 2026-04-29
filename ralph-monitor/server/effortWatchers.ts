// Per-effort prd.json file watchers for US-012c.
//
// Each kind='prd' effort gets its own chokidar watcher scoped to the directory
// containing effort.prd_path (depth:0). When the prd.json file changes the
// watcher emits an `effort.snapshot.updated` lifecycle event so SSE clients
// can re-fetch /api/efforts/:id/snapshot.
//
// Watcher lifecycle:
//   - watchEffortPrd()   called from POST /api/projects/:id/efforts (prd kind)
//                        and from server boot reconciliation in server/index.ts
//   - unwatchEffortPrd() called from DELETE /api/efforts/:id
//   - rewatchEffortPrd() called from PATCH /api/efforts/:id when prd_path changes
//
// The Map<string, FSWatcher> is module-level so it survives across requests
// without touching global state or the store beyond recordEvent().

import chokidar, { type FSWatcher } from 'chokidar'
import { resolve, dirname } from 'node:path'
import { store } from './store'

const effortWatchers = new Map<string, FSWatcher>()

/**
 * Start watching the directory that contains `prdPath`.  If the effort is
 * already being watched this is a no-op (idempotent — safe to call on boot
 * for every pre-existing effort).
 */
export function watchEffortPrd(effortId: string, prdPath: string): void {
  if (effortWatchers.has(effortId)) return

  const dir = dirname(prdPath)
  const resolvedPrdPath = resolve(prdPath)

  const watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    persistent: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  })

  watcher.on('change', (changedPath: string) => {
    if (resolve(changedPath) === resolvedPrdPath) {
      store.recordEvent({
        type: 'effort.snapshot.updated',
        ts: Date.now(),
        effort_id: effortId,
      })
    }
  })

  watcher.on('error', (err: unknown) => {
    console.error(`[effortWatcher] error watching effort ${effortId}:`, err)
  })

  effortWatchers.set(effortId, watcher)
}

/**
 * Stop watching and remove the watcher for `effortId`.  No-op when the effort
 * is not currently being watched.
 */
export function unwatchEffortPrd(effortId: string): void {
  const w = effortWatchers.get(effortId)
  if (!w) return
  w.close().catch(() => {})
  effortWatchers.delete(effortId)
}

/**
 * Unwatch the old path then re-watch `newPrdPath`.  Called when PATCH changes
 * prd_path on an existing prd-kind effort.  If `newPrdPath` is null/empty the
 * effort is only unwatched (the DB constraint prevents this in practice, but
 * the helper is defensive so callers don't need to guard).
 */
export function rewatchEffortPrd(effortId: string, newPrdPath: string | null): void {
  unwatchEffortPrd(effortId)
  if (newPrdPath) {
    watchEffortPrd(effortId, newPrdPath)
  }
}
