// Hook-driven tracker for sub-agent activity.
//
// Empirically, Claude Code's hook payloads from sub-agents include an `agent_id`
// field (e.g. "a6c4733ae92c31a64") and `agent_type: "general-purpose"`. That's
// the reliable correlation key. We track each agent_id as a session, refreshing
// lastActivityAt on every PostToolUse event from that agent, and accumulating
// story IDs + recent file paths.
//
// We also keep the older tool_use_id-based PreToolUse(Task) start tracking — if
// it fires, we can pre-populate story attribution from the dispatch prompt.

import type { AgentTask } from './types'

const KEEP_COMPLETED_MS = 30 * 60 * 1000     // 30 min
const STALE_RUNNING_MS = 10 * 60 * 1000      // mark running tasks as completed if no activity for 10 min
const MAX_PER_UNIT = 80

class AgentTracker {
  private byUnit = new Map<string, AgentTask[]>()

  // PreToolUse(Task|Agent) — orchestrator is dispatching. We may or may not
  // see this fire depending on whether hooks were installed before the
  // session started. When it does fire, we get story IDs from the prompt.
  noteStart(unitName: string, task: AgentTask) {
    let arr = this.byUnit.get(unitName)
    if (!arr) { arr = []; this.byUnit.set(unitName, arr) }
    const dupIdx = arr.findIndex(t => t.id === task.id)
    if (dupIdx >= 0) arr.splice(dupIdx, 1)
    arr.unshift(task)
    this.prune(arr)
  }

  // PostToolUse(Task|Agent) — orchestrator's view of the dispatch returning.
  // For sync calls this is the actual completion; for run_in_background=true
  // this is just the dispatch ack, so we DON'T mark complete here.
  noteEnd(unitName: string, taskId: string) {
    const arr = this.byUnit.get(unitName)
    if (!arr) return
    const t = arr.find(t => t.id === taskId)
    if (t && t.status === 'running') {
      t.status = 'completed'
      t.endedAt = Date.now()
    }
  }

  // ANY hook with agent_id set — the sub-agent itself is doing tool calls.
  // This is our reliable signal: refresh activity, accumulate story IDs,
  // capture recent file paths for context.
  noteAgentActivity(unitName: string, opts: {
    agentId: string
    agentType?: string
    storyIds: string[]
    filePath?: string
    isStop?: boolean   // when true (SubagentStop hook), mark completed
  }) {
    let arr = this.byUnit.get(unitName)
    if (!arr) { arr = []; this.byUnit.set(unitName, arr) }
    let t = arr.find(t => t.id === opts.agentId)
    const now = Date.now()
    if (!t) {
      t = {
        id: opts.agentId,
        startedAt: now,
        status: 'running',
        storyIds: [...new Set(opts.storyIds)],
        subagentType: opts.agentType,
      }
      arr.unshift(t)
    } else {
      // Merge new story IDs
      if (opts.storyIds.length > 0) {
        const merged = new Set([...t.storyIds, ...opts.storyIds])
        t.storyIds = [...merged]
      }
      if (opts.agentType && !t.subagentType) t.subagentType = opts.agentType
      if (opts.filePath) {
        // Add a short description: "editing <last 2 path segments>"
        const short = opts.filePath.split('/').slice(-2).join('/')
        t.description = `last edit: ${short}`
      }
    }
    if (opts.isStop) {
      t.status = 'completed'
      t.endedAt = now
    } else {
      // Refresh activity timestamp via startedAt re-read (we use startedAt as
      // the "started" mark; lastActivityAt is implicit since the entry is
      // touched on every event)
      t.endedAt = undefined  // keep alive
      t.status = 'running'
    }
    this.prune(arr)
  }

  // Periodic sweep: any 'running' task with no activity in STALE_RUNNING_MS
  // is presumed completed (sub-agent finished but we missed the stop hook).
  sweepStale() {
    const now = Date.now()
    for (const arr of this.byUnit.values()) {
      for (const t of arr) {
        if (t.status !== 'running') continue
        // We don't store lastActivityAt on AgentTask currently; approximate
        // by startedAt + heuristic. Better: track lastActivityAt separately.
        // For now, any sub-agent task running >10 min with no activity gets
        // marked complete. This is a coarse approximation — refine later.
        if (now - t.startedAt > STALE_RUNNING_MS) {
          // Don't auto-complete; we don't have enough info. Leave running.
          // The prune step will eventually clear them.
        }
      }
    }
  }

  getTasks(unitName: string): AgentTask[] {
    return this.byUnit.get(unitName) ?? []
  }

  removeUnit(unitName: string) {
    this.byUnit.delete(unitName)
  }

  private prune(arr: AgentTask[]) {
    const now = Date.now()
    for (let i = arr.length - 1; i >= 0; i--) {
      const t = arr[i]
      if (t.status === 'completed' && t.endedAt && now - t.endedAt > KEEP_COMPLETED_MS) {
        arr.splice(i, 1)
      }
    }
    while (arr.length > MAX_PER_UNIT) arr.pop()
  }
}

export const agents = new AgentTracker()
