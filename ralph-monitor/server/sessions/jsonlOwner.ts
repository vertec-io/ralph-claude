// Detect which process (if any) outside ralph-monitor holds a session live.
//
// Empirical observation (2026-04-29): claude-code does NOT keep the
// conversation JSONL open continuously — it appends and closes per turn. But
// it DOES hold these fds open for the lifetime of the process:
//
//   ~/.claude/tasks/<session-id>/        (directory)
//   ~/.claude/tasks/<session-id>/.lock   (lockfile)
//
// The lockfile is the strongest signal: it exists only while a claude process
// is actively servicing this session id. We walk /proc/<pid>/fd/* looking for
// symlinks pointing at that lockfile (or, as a backup, the parent directory).
//
// As a last-resort fallback, we also scan /proc/<pid>/cmdline for arguments
// containing the session id verbatim — this catches `claude --resume <id>` /
// `claude --session-id <id>` even if the lockfile probe somehow misses.
//
// Linux only — on other platforms we'd need lsof. Returns null off-Linux so
// downstream treats the session as dormant.

import { readdir, readlink, readFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

export interface JsonlOwner {
  pid: number
  comm: string | null
}

const CACHE_TTL_MS = 1500
const cache = new Map<string, { ts: number; owner: JsonlOwner | null }>()

async function readComm(pid: number): Promise<string | null> {
  try {
    return (await readFile(`/proc/${pid}/comm`, 'utf8')).trim()
  } catch {
    return null
  }
}

async function readCmdline(pid: number): Promise<string | null> {
  try {
    // /proc/<pid>/cmdline is null-byte separated; concat with spaces for substring search.
    const buf = await readFile(`/proc/${pid}/cmdline`)
    return buf.toString('utf8').replace(/\0/g, ' ')
  } catch {
    return null
  }
}

// Find any process (other than ourselves) that is "live-owning" this session.
// Returns null if nothing matches.
//
// Detection order:
//   1. fd → ~/.claude/tasks/<id>/.lock      (cheapest + most precise)
//   2. fd → ~/.claude/tasks/<id>            (directory fd, same lifetime as 1)
//   3. cmdline contains the session id      (fallback for unusual launches)
export async function findSessionOwner(sessionId: string): Promise<JsonlOwner | null> {
  if (platform() !== 'linux') return null

  const cached = cache.get(sessionId)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.owner
  }

  const myPid = process.pid
  const tasksDir = join(homedir(), '.claude', 'tasks', sessionId)
  const lockPath = join(tasksDir, '.lock')

  let entries: string[]
  try {
    entries = await readdir('/proc')
  } catch {
    cache.set(sessionId, { ts: Date.now(), owner: null })
    return null
  }

  // Pass 1: fd-based detection (precise + cheap because we exit on first hit).
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = parseInt(entry, 10)
    if (pid === myPid) continue
    let fds: string[]
    try {
      fds = await readdir(`/proc/${pid}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      try {
        const target = await readlink(`/proc/${pid}/fd/${fd}`)
        if (target === lockPath || target === tasksDir) {
          const comm = await readComm(pid)
          const owner: JsonlOwner = { pid, comm }
          cache.set(sessionId, { ts: Date.now(), owner })
          return owner
        }
      } catch {
        // fd race or permission denied — skip
      }
    }
  }

  // Pass 2: cmdline scan. Claude --resume / --session-id put the uuid in argv.
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = parseInt(entry, 10)
    if (pid === myPid) continue
    const cmd = await readCmdline(pid)
    if (cmd && cmd.includes(sessionId)) {
      const comm = await readComm(pid)
      // Filter out non-claude binaries that happen to mention the uuid (e.g.,
      // an editor with the file path in argv). Heuristic: comm == 'claude'
      // OR cmdline starts with a path ending in /claude.
      if (comm === 'claude' || /\/claude(\s|$)/.test(cmd) || /\bclaude\s/.test(cmd)) {
        const owner: JsonlOwner = { pid, comm }
        cache.set(sessionId, { ts: Date.now(), owner })
        return owner
      }
    }
  }

  cache.set(sessionId, { ts: Date.now(), owner: null })
  return null
}

// Backwards-compat alias for callers that still pass jsonl paths. Extracts
// the basename's uuid and forwards to findSessionOwner. Path-shaped arg →
// uuid extraction → session lookup. New callers should use findSessionOwner.
export async function findJsonlOwner(jsonlPath: string): Promise<JsonlOwner | null> {
  const m = jsonlPath.match(/([0-9a-f-]{36})\.jsonl$/)
  if (!m) return null
  return findSessionOwner(m[1]!)
}

export function invalidateJsonlOwnerCache(jsonlPathOrId?: string): void {
  if (!jsonlPathOrId) {
    cache.clear()
    return
  }
  // Accept either a session id directly or a JSONL path.
  const m = jsonlPathOrId.match(/([0-9a-f-]{36})(?:\.jsonl)?$/)
  if (m) cache.delete(m[1]!)
  else cache.delete(jsonlPathOrId)
}
