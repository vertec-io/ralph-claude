import { readFile, readdir, readlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { PRDRecord, PRDStatus, ClaudeProcess } from './types'

const HEARTBEAT_THRESHOLD_MS = 1200_000  // 20 min
const JSONL_THRESHOLD_MS = 1800_000      // 30 min

// Returns a PRD's status by combining heartbeat, process-presence, and JSONL signals.
// Mirrors run-watchdog.sh's multi-signal logic.
export async function computeStatus(prd: PRDRecord): Promise<PRDStatus> {
  // Complete: every story passes
  if (prd.prd && prd.prd.userStories.length > 0 && prd.prd.userStories.every(s => s.passes)) {
    return 'complete'
  }

  // Blocked: at least one decision file is pending and no other progress signal
  const blockedOnDecision = prd.decisionFiles.some(d => d.pending)

  const now = Date.now()
  const hbAge = prd.heartbeatMtime ? now - prd.heartbeatMtime : Infinity
  if (hbAge < HEARTBEAT_THRESHOLD_MS) return 'active'

  if (await hasClaudeProcessForCwd(prd.worktreeDir)) return 'active'

  const jlAge = prd.jsonlMtime ? now - prd.jsonlMtime : Infinity
  if (jlAge < JSONL_THRESHOLD_MS) return 'idle'

  if (blockedOnDecision) return 'blocked'

  return 'crashed'
}

export async function hasClaudeProcessForCwd(cwd: string): Promise<boolean> {
  try {
    const procs = await readdir('/proc')
    for (const entry of procs) {
      if (!/^\d+$/.test(entry)) continue
      let comm: string
      try {
        comm = (await readFile(`/proc/${entry}/comm`, 'utf-8')).trim()
      } catch { continue }
      if (comm !== 'claude') continue
      try {
        const procCwd = await readlink(`/proc/${entry}/cwd`)
        if (procCwd === cwd) return true
      } catch { /* race: process exited */ }
    }
  } catch { /* /proc not readable, treat as no signal */ }
  return false
}

export async function jsonlMtime(worktreeDir: string, sessionId: string): Promise<number | undefined> {
  const encoded = worktreeDir.replaceAll('/', '-')
  const path = join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`)
  try {
    const s = await stat(path)
    return s.mtimeMs
  } catch { return undefined }
}

// Enumerate every claude-named process whose cwd is the worktree.
// Returns pid + ppid + a confidence-flagged isOrchestrator marker.
//
// Orchestrator detection is best-effort:
//   1. cmdline contains the session id  → reliable for --resume invocations
//      (watchdog resurrections), miss for bootstrap interactive sessions
//   2. fd holds the session jsonl open  → racy; claude only opens the file
//      briefly during writes, so we'll catch it intermittently across the
//      15s safety-refresh ticks but not always
//
// When neither signal fires, we leave isOrchestrator undefined and the UI
// renders the process as a generic "claude pid X" without a misleading label.
export async function findClaudeProcessesInCwd(
  cwd: string,
  sessionId?: string,
  sessionJsonlPath?: string,
): Promise<ClaudeProcess[]> {
  const out: ClaudeProcess[] = []
  let entries: string[]
  try { entries = await readdir('/proc') } catch { return out }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue
    const pid = Number(e)
    try {
      const comm = (await readFile(`/proc/${pid}/comm`, 'utf-8')).trim()
      if (comm !== 'claude') continue
      const procCwd = await readlink(`/proc/${pid}/cwd`)
      if (procCwd !== cwd) continue
      const statStr = await readFile(`/proc/${pid}/stat`, 'utf-8')
      const close = statStr.lastIndexOf(')')
      const fields = statStr.slice(close + 2).split(' ')
      const ppid = Number(fields[1])
      if (!Number.isFinite(ppid)) continue

      let isOrchestrator: boolean | undefined
      // Signal 1: --resume <sessionId> in cmdline
      if (sessionId) {
        try {
          const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf-8')
          if (cmdline.includes(sessionId)) isOrchestrator = true
        } catch {}
      }
      // Signal 2: fd holds the jsonl (racy; only catches mid-write)
      if (!isOrchestrator && sessionJsonlPath) {
        if (await processHoldsFile(pid, sessionJsonlPath)) isOrchestrator = true
      }

      out.push({ pid, ppid, ...(isOrchestrator ? { isOrchestrator: true } : {}) })
    } catch { /* race: process exited mid-walk */ }
  }
  return out
}

async function processHoldsFile(pid: number, targetPath: string): Promise<boolean> {
  let fds: string[]
  try { fds = await readdir(`/proc/${pid}/fd`) } catch { return false }
  for (const fd of fds) {
    try {
      const target = await readlink(`/proc/${pid}/fd/${fd}`)
      if (target === targetPath) return true
    } catch {}
  }
  return false
}
