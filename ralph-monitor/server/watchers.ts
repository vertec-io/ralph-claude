import chokidar, { type FSWatcher } from 'chokidar'
import { join } from 'node:path'
import { store } from './store'
import { discoverFromSystemd } from './discovery'
import { refreshSnapshot } from './snapshot'
import type { PRDRecord } from './types'
import { homedir } from 'node:os'

const watchers = new Map<string, FSWatcher>()

// Coalesce bursts of fs events per PRD so we don't refresh 5 times in a row
// when a story commit triggers .heartbeat, prd.json, and a git ref update
// nearly simultaneously.
const refreshDebounce = new Map<string, NodeJS.Timeout>()

async function refreshAndStore(prd: PRDRecord) {
  const next = await refreshSnapshot(prd)
  store.setPRD(next)
}

function scheduleRefresh(unitName: string) {
  const prd = store.getPRD(unitName)
  if (!prd) return
  const existing = refreshDebounce.get(unitName)
  if (existing) clearTimeout(existing)
  const t = setTimeout(() => {
    refreshDebounce.delete(unitName)
    refreshAndStore(prd).catch(err => console.error('refresh failed:', err))
  }, 250)
  refreshDebounce.set(unitName, t)
}

function watchPRD(prd: PRDRecord) {
  if (watchers.has(prd.unitName)) return
  const paths = [
    join(prd.taskDir, 'prd.json'),
    join(prd.taskDir, '.heartbeat'),
    join(prd.taskDir, '.watchdog/watchdog.log'),
    join(prd.taskDir, 'decisions'),
    join(prd.worktreeDir, '.git/refs/heads'),
    join(prd.worktreeDir, '.git/HEAD'),
  ]
  const w = chokidar.watch(paths, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  })
  w.on('all', () => scheduleRefresh(prd.unitName))
  w.on('error', err => console.error(`watcher error for ${prd.unitName}:`, err))
  watchers.set(prd.unitName, w)
}

function unwatchPRD(unitName: string) {
  const w = watchers.get(unitName)
  if (w) {
    w.close().catch(() => {})
    watchers.delete(unitName)
  }
  const t = refreshDebounce.get(unitName)
  if (t) clearTimeout(t)
}

// Top-level watcher: detect new/removed systemd units in ~/.config/systemd/user
let systemdWatcher: FSWatcher | undefined
let registryRescanTimer: NodeJS.Timeout | undefined

function scheduleRegistryRescan() {
  if (registryRescanTimer) clearTimeout(registryRescanTimer)
  registryRescanTimer = setTimeout(rescanRegistry, 500)
}

async function rescanRegistry() {
  const live = await discoverFromSystemd()
  const liveNames = new Set(live.map(p => p.unitName))
  // Add new
  for (const prd of live) {
    if (!store.getPRD(prd.unitName)) {
      store.setPRD(prd)
      watchPRD(prd)
      await refreshAndStore(prd)
    }
  }
  // Remove gone
  for (const existing of store.snapshot().prds) {
    if (!liveNames.has(existing.unitName)) {
      unwatchPRD(existing.unitName)
      store.removePRD(existing.unitName)
    }
  }
}

export async function startWatchers() {
  const systemdDir = join(homedir(), '.config/systemd/user')
  systemdWatcher = chokidar.watch(systemdDir, {
    ignoreInitial: true,
    persistent: true,
    depth: 0,
  })
  systemdWatcher.on('add', scheduleRegistryRescan)
  systemdWatcher.on('unlink', scheduleRegistryRescan)

  // Initial scan
  await rescanRegistry()

  // Periodic safety refresh — catches things fs events might miss (proc liveness changes)
  setInterval(() => {
    for (const prd of store.snapshot().prds) {
      refreshAndStore(prd).catch(() => {})
    }
  }, 15_000)
}
