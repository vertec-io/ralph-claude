import { readFile, readdir, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import type { PRDRecord, PRDJson, CommitRow, DecisionFile, DocFile } from './types'
import { computeStatus, jsonlMtime, findClaudeProcessesInCwd } from './liveness'
import { agents } from './agents'

function sessionJsonlPathFor(worktreeDir: string, sessionId: string): string {
  const encoded = worktreeDir.replaceAll('/', '-')
  return join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`)
}

// Refresh all derived fields on a PRDRecord by reading from disk.
// Idempotent and safe to call repeatedly.
export async function refreshSnapshot(prd: PRDRecord): Promise<PRDRecord> {
  const updated: PRDRecord = { ...prd, lastUpdated: Date.now() }

  // prd.json
  try {
    const text = await readFile(join(prd.taskDir, 'prd.json'), 'utf-8')
    updated.prd = JSON.parse(text) as PRDJson
  } catch {
    updated.prd = undefined
  }

  // heartbeat mtime
  try {
    const s = await stat(join(prd.taskDir, '.heartbeat'))
    updated.heartbeatMtime = s.mtimeMs
  } catch { updated.heartbeatMtime = undefined }

  // session jsonl mtime
  updated.jsonlMtime = await jsonlMtime(prd.worktreeDir, prd.sessionId)

  // git log (last 10 commits)
  updated.recentCommits = await readGitLog(prd.worktreeDir, 10)

  // watchdog log tail
  updated.watchdogLogTail = await readLastLines(join(prd.taskDir, '.watchdog/watchdog.log'), 20)

  // decisions/*.md — pass prd.json so we can cross-reference story.passes
  // and decisionConfig.status to avoid false-positive "pending" labels.
  updated.decisionFiles = await readDecisions(
    join(prd.taskDir, 'decisions'),
    updated.prd,
  )

  // top-level *.md and *.txt docs (prd.md, HANDOFF*.md, progress.txt, etc.)
  updated.docFiles = await readDocFiles(prd.taskDir)

  // Live agent picture: claude processes in the worktree (best-effort orchestrator
  // identification via cmdline+fd checks) + hook-tracked Task dispatches.
  const sessionJsonlPath = sessionJsonlPathFor(prd.worktreeDir, prd.sessionId)
  updated.agents = {
    processes: await findClaudeProcessesInCwd(prd.worktreeDir, prd.sessionId, sessionJsonlPath),
    tasks: agents.getTasks(prd.unitName),
  }

  updated.status = await computeStatus(updated)
  return updated
}

async function readDocFiles(dir: string): Promise<DocFile[]> {
  const docs: DocFile[] = []
  await collectMdTxt(dir, '', docs)
  // Also walk decisions/ subdirectory so users can browse every decision file
  // (including resolved gates and operator one-shots that aren't real gates).
  await collectMdTxt(join(dir, 'decisions'), 'decisions/', docs)

  // Sort: prd.md first, HANDOFF* next, progress.txt next, then top-level
  // alphabetic, then decisions/* alphabetic at the bottom.
  docs.sort((a, b) => {
    const rank = (n: string) =>
      n === 'prd.md' ? 0 :
      n.startsWith('HANDOFF') ? 1 :
      n === 'progress.txt' ? 2 :
      n.startsWith('decisions/') ? 4 :
      3
    const r = rank(a.name) - rank(b.name)
    return r !== 0 ? r : a.name.localeCompare(b.name)
  })
  return docs
}

async function collectMdTxt(dir: string, namePrefix: string, out: DocFile[]) {
  let files: string[]
  try {
    files = await readdir(dir)
  } catch { return }
  for (const f of files) {
    if (!/\.(md|txt)$/i.test(f)) continue
    if (f.startsWith('.')) continue
    const path = join(dir, f)
    try {
      const s = await stat(path)
      if (!s.isFile()) continue
      out.push({ path, name: namePrefix + f, size: s.size, mtime: s.mtimeMs })
    } catch {}
  }
}

async function readGitLog(cwd: string, n: number): Promise<CommitRow[]> {
  return new Promise((resolve) => {
    const fmt = '%H%x09%h%x09%ct%x09%s'
    const child = spawn('git', ['log', `-n${n}`, `--pretty=format:${fmt}`], { cwd })
    let out = ''
    child.stdout.on('data', d => { out += d.toString() })
    child.on('error', () => resolve([]))
    child.on('close', () => {
      const rows: CommitRow[] = out
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [sha, short, ts, ...rest] = line.split('\t')
          return { sha, short, ts: Number(ts), subject: rest.join('\t') }
        })
      resolve(rows)
    })
  })
}

async function readLastLines(path: string, n: number): Promise<string[]> {
  try {
    const text = await readFile(path, 'utf-8')
    return text.split('\n').filter(Boolean).slice(-n)
  } catch {
    return []
  }
}

async function readDecisions(dir: string, prd?: PRDJson): Promise<DecisionFile[]> {
  let files: string[]
  try {
    files = (await readdir(dir)).filter(f => f.endsWith('.md'))
  } catch {
    return []
  }

  // Lookup table for cross-referencing
  const storiesById = new Map<string, PRDJson['userStories'][number]>()
  if (prd?.userStories) {
    for (const s of prd.userStories) storiesById.set(s.id, s)
  }

  const out: DecisionFile[] = []
  for (const f of files) {
    const path = join(dir, f)
    let body: string
    try { body = await readFile(path, 'utf-8') } catch { continue }

    // Step 1: classify — is this even a decision-gate file? Operator notes,
    // brain-dump scratch files, and other non-gates often live in decisions/.
    // Require >=2 structural markers from the decision template.
    const hasMarker = {
      status:  /\*\*Status:\*\*/i.test(body),
      options: /^##\s+Options/im.test(body),
      yourDec: /^##\s+Your\s+Decision/im.test(body),
      selOpt:  /Selected Option:/i.test(body),
      idPrefix: /^(US-[A-Za-z0-9-]+|D-\d+)/.test(f),
    }
    const markerCount = Object.values(hasMarker).filter(Boolean).length
    if (markerCount < 2) continue   // not a real decision file; skip

    // Step 2: extract story ID (filename prefix preferred, body fallback)
    const filenameMatch = f.match(/^(US-[A-Za-z0-9-]+|D-\d+)/)
    const bodyStoryMatch = body.match(/^\s*\*?\*?Story:\*?\*?\s*(\S+)/im)
    const storyId = filenameMatch?.[1] ?? bodyStoryMatch?.[1]?.trim()

    // Step 3: determine applied vs pending using multiple signals
    let applied = false
    let selected: string | undefined

    // Signal A: explicit Status APPLIED/RESOLVED in body
    if (/\*\*Status:\*\*[^\n]*\b(APPLIED|RESOLVED|DONE|COMPLETE)\b/i.test(body)) {
      applied = true
    }

    // Signal B: cross-reference with prd.json — story passing or decisionConfig applied
    if (storyId) {
      const story = storiesById.get(storyId)
      if (story?.passes) applied = true
      if (story?.decisionConfig?.status === 'applied') applied = true
    }

    // Signal C: Selected Option line with non-placeholder value
    const selectedMatch = body.match(/Selected Option:\s*\*?\*?\s*([A-Za-z0-9][A-Za-z0-9_-]*)/i)
    const selectedRaw = selectedMatch?.[1]?.trim()
    if (selectedRaw && selectedRaw.length > 0 && !selectedRaw.startsWith('<')) {
      selected = selectedRaw
      applied = true
    }

    // Override: explicit Status PENDING/AWAITING wins over weaker signals
    if (/\*\*Status:\*\*[^\n]*\b(PENDING|AWAITING|OPEN|TODO)\b/i.test(body)) {
      applied = false
    }

    out.push({
      path,
      storyId,
      selected: applied ? selected : undefined,
      pending: !applied,
    })
  }
  return out
}

export function prdSlug(taskDir: string): string {
  return basename(taskDir)
}
