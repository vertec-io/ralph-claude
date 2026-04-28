import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { PRDRecord } from './types'

const SYSTEMD_DIR = join(homedir(), '.config/systemd/user')
const UNIT_PREFIX = 'ralph-pilot-native-'

// Walk the systemd user dir for ralph-pilot-native units, parse their ExecStart
// to extract task-dir / worktree-dir / session-id, and return one PRDRecord skeleton
// per unit. Watchers and the snapshot loop fill in prd.json / heartbeat / commits.
export async function discoverFromSystemd(): Promise<PRDRecord[]> {
  let entries: string[]
  try {
    entries = await readdir(SYSTEMD_DIR)
  } catch {
    return []
  }

  const services = entries.filter(f => f.startsWith(UNIT_PREFIX) && f.endsWith('.service'))
  const records: PRDRecord[] = []

  for (const svc of services) {
    const unitName = svc.replace(/\.service$/, '')
    let content: string
    try {
      content = await readFile(join(SYSTEMD_DIR, svc), 'utf-8')
    } catch { continue }

    // ExecStart=/bin/bash <script> <task-dir> <worktree-dir> <session-id>
    const m = content.match(/^ExecStart=\/bin\/bash\s+\S+\s+(\S+)\s+(\S+)\s+(\S+)\s*$/m)
    if (!m) continue

    const [, taskDir, worktreeDir, sessionId] = m

    // Skip ghost units whose task dir no longer exists
    try {
      const s = await stat(taskDir)
      if (!s.isDirectory()) continue
    } catch { continue }

    records.push({
      unitName,
      taskDir,
      worktreeDir,
      sessionId,
      recentCommits: [],
      watchdogLogTail: [],
      decisionFiles: [],
      docFiles: [],
      status: 'idle',
      lastUpdated: Date.now(),
    })
  }

  return records
}
