// Startup process reconciliation (US-006).
//
// On boot, ralph-monitor needs to figure out which DB-tracked sessions still
// have live processes and which are truly gone. We consult /proc directly
// rather than relying on the in-memory PtyHandle registry — at startup, the
// registry is empty by definition (no PTYs have been spawned yet), so every
// row with a non-null process_pid is either:
//
//   1. live-orphaned: the process exists, but ralph-monitor's PTY parent died
//      (so we cannot reattach via the registry). DB row keeps its pid; the
//      computed status surface returns 'live-orphaned'.
//   2. dormant: no process matches. We clear process_pid + process_started_at
//      so subsequent session-spawn calls don't trip the partial-unique-index
//      "one live session per effort" guard.
//
// Match contract (logical AND, not OR — protects against PID reuse):
//   /proc/<pid>/comm     == 'bun'                            (PTY parent comm
//                                                             pinned by US-000a)
//   /proc/<pid>/environ  contains 'RALPH_MONITOR_SESSION=<uuid>'
//                                                            (env tag set by
//                                                             spawnSession in
//                                                             US-005a-2)
//
// v1 reachability note: live-orphaned is logically reachable but practically
// zero in v1, because owned processes die with ralph-monitor (no setsid). The
// code path is kept live so v2 setsid work doesn't need a rewrite.
//
// Linux-only: macOS/other don't expose /proc/<pid>/{comm,environ} the same
// way, so on non-Linux we log a warning and mark every PID-bearing row as
// dormant. v1 deployment targets Linux (systemd unit), so this is not a
// regression — it's an honest "we don't know what's alive" rather than a
// false positive.
//
// Test seam: the procReader option lets tests inject a deterministic file
// reader without touching /proc on the host running the test. Default reads
// /proc via fs.readFile and returns null on ENOENT/EPERM/ESRCH (the three
// race-with-process-exit codes we expect to hit mid-walk). Tests pass a
// platform override too so we can exercise the non-Linux branch on Linux.

import { readFile } from 'node:fs/promises'
import { platform } from 'node:os'
import type { Database } from 'bun:sqlite'

import { getDb, updateSession } from '../db'
import { listSessionsWithPid } from '../db/sessions'

// Pinned by US-000a empirical confirmation: bun-pty spawns the PTY child via
// the bun runtime, and /proc/<pid>/comm reports 'bun' for the parent.
// DO NOT make this configurable — pinning the constant is the whole point of
// US-000a. A future change here is a new decision document, not a config flag.
export const PTY_PARENT_COMM = 'bun'

export type ReconcileStatus = 'live-orphaned' | 'dormant' | 'platform-unsupported'

export interface ReconcileResultEntry {
  sessionId: string
  pid: number
  status: ReconcileStatus
  reason: string
}

export interface ReconcileResult {
  entries: ReconcileResultEntry[]
  liveOrphanedCount: number
  dormantCount: number
}

// Test-seam: read a /proc file. Returns null on ENOENT/EPERM/ESRCH (process
// exited mid-read, or we lack permission), otherwise returns the file body
// as a UTF-8 string (or raw bytes for environ — we still decode UTF-8 here
// because the env keys/values are ASCII and the null-byte separator survives
// the round-trip cleanly).
export type ProcReader = (path: string) => Promise<string | null>

const defaultProcReader: ProcReader = async (path) => {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    // ENOENT: pid is gone. EPERM/EACCES: not our process (shouldn't happen
    // for our own children, but hedge). ESRCH: process exited mid-read.
    if (code === 'ENOENT' || code === 'EPERM' || code === 'EACCES' || code === 'ESRCH') {
      return null
    }
    throw err
  }
}

export interface ReconcileOptions {
  // Override for tests. Default reads /proc/<pid>/{comm,environ} via fs.
  procReader?: ProcReader
  // Override for tests. Default is os.platform().
  platformOverride?: NodeJS.Platform
  // Override for tests. Default is getDb() from the singleton.
  db?: Database
}

export async function reconcileSessionsOnStartup(
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const procReader = options.procReader ?? defaultProcReader
  const plat = options.platformOverride ?? platform()
  const db = options.db ?? getDb()

  const sessions = listSessionsWithPid(db)
  const entries: ReconcileResultEntry[] = []
  let liveOrphanedCount = 0
  let dormantCount = 0

  if (plat !== 'linux') {
    // Non-Linux: we have no portable way to inspect another process's
    // environ. Mark every PID-bearing row as dormant so the next spawn isn't
    // blocked by a stale "live" pid.
    console.warn(
      `[reconcile] platform=${plat} not supported; marking ${sessions.length} PID-bearing session(s) as dormant`,
    )
    for (const session of sessions) {
      const pid = session.process_pid as number  // listSessionsWithPid filters
      updateSession(db, session.id, {
        process_pid: null,
        process_started_at: null,
      })
      entries.push({
        sessionId: session.id,
        pid,
        status: 'platform-unsupported',
        reason: `platform=${plat}; /proc/<pid>/environ not portable`,
      })
      dormantCount++
    }
    return { entries, liveOrphanedCount, dormantCount }
  }

  for (const session of sessions) {
    const pid = session.process_pid as number  // listSessionsWithPid filters
    const comm = await procReader(`/proc/${pid}/comm`)
    const environRaw = await procReader(`/proc/${pid}/environ`)

    // /proc/<pid>/comm has a trailing newline; trim it before compare.
    const commTrimmed = comm?.trim() ?? null
    const commMatches = commTrimmed === PTY_PARENT_COMM

    // /proc/<pid>/environ is a sequence of KEY=VALUE entries separated by
    // null bytes, with a trailing null byte. split('\0') yields one empty
    // string at the end — that's fine because our exact-match against
    // 'RALPH_MONITOR_SESSION=<uuid>' won't match an empty string anyway.
    // Embedded spaces/newlines in values are preserved by the split (we
    // never split on whitespace).
    const sessionTagMatches =
      environRaw !== null &&
      environRaw.split('\0').some((line) => line === `RALPH_MONITOR_SESSION=${session.id}`)

    if (commMatches && sessionTagMatches) {
      // Live-orphaned: process is alive and tagged, but our registry has
      // no handle (we just booted). Keep the DB pid so the API status
      // surface can return 'live-orphaned' for this session.
      entries.push({
        sessionId: session.id,
        pid,
        status: 'live-orphaned',
        reason: `comm=${commTrimmed} + RALPH_MONITOR_SESSION tag matches`,
      })
      liveOrphanedCount++
    } else {
      // Dormant: clear the live-pid columns so a fresh spawn for this
      // effort isn't blocked by the partial-unique-index guard.
      updateSession(db, session.id, {
        process_pid: null,
        process_started_at: null,
      })
      entries.push({
        sessionId: session.id,
        pid,
        status: 'dormant',
        reason: `comm=${commTrimmed ?? 'null'} | tag match=${sessionTagMatches ? 'yes' : 'no'}`,
      })
      dormantCount++
    }
  }

  return { entries, liveOrphanedCount, dormantCount }
}
