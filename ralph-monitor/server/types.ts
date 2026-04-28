// Shared types between server and ui

export type PRDStatus = 'active' | 'idle' | 'crashed' | 'complete' | 'blocked'

export interface AcceptanceCriterion {
  description: string
  passes: boolean
}

export interface UserStory {
  id: string
  title: string
  description?: string
  phase?: number | string
  priority?: number
  modelHint?: 'haiku' | 'sonnet' | 'opus'
  passes: boolean
  blockedBy?: string[]
  acceptanceCriteria?: (AcceptanceCriterion | string)[]
  notes?: string
  type?: string
  // Optional decision-gate config (when type === 'decision-gate')
  decisionConfig?: {
    inputFile?: string
    status?: string         // 'pending' | 'applied'
    userSelection?: string
    userNotes?: string
  }
  // Decorated by the server at snapshot time.
  // Most recent ms-timestamp of any criterion-flip OR matching Agent dispatch.
  lastActivityAt?: number
}

export interface PRDJson {
  title?: string
  description?: string
  branchName?: string
  type?: string
  mergeTarget?: string
  userStories: UserStory[]
}

export interface CommitRow {
  sha: string
  short: string
  subject: string
  ts: number  // unix seconds
}

export interface DecisionFile {
  path: string
  storyId?: string
  selected?: string  // applied option, if any
  pending: boolean
}

export interface ClaudeProcess {
  pid: number
  ppid: number
  // True only when we've confirmed this process holds the session JSONL fd open.
  // Don't infer from "no parent in set" — sub-agents can be spawned through
  // intermediate shells, and unrelated claude sessions may share the same cwd.
  isOrchestrator?: boolean
}

export interface AgentTask {
  id: string                   // tool_use_id from hook
  startedAt: number            // ms
  endedAt?: number             // ms
  status: 'running' | 'completed'
  description?: string         // tool_input.description
  storyIds: string[]           // extracted from prompt
  subagentType?: string        // tool_input.subagent_type
  model?: string               // 'haiku' | 'sonnet' | 'opus'
}

export interface AgentSnapshot {
  processes: ClaudeProcess[]   // live claude procs in this worktree (ppid set so UI can build tree)
  tasks: AgentTask[]           // hook-tracked Task dispatches, newest first, capped
}

export interface DocFile {
  path: string                 // absolute
  name: string                 // basename
  size: number
  mtime: number                // ms
}

export interface PRDRecord {
  unitName: string             // ralph-pilot-native-<slug>
  taskDir: string              // absolute
  worktreeDir: string          // absolute
  sessionId: string
  prd?: PRDJson
  heartbeatMtime?: number      // ms
  jsonlMtime?: number          // ms
  recentCommits: CommitRow[]
  watchdogLogTail: string[]
  decisionFiles: DecisionFile[]
  docFiles: DocFile[]          // *.md and *.txt at task-dir root
  status: PRDStatus
  lastUpdated: number          // ms
  // Decorated by the server: story IDs with activity within the last 5 minutes.
  activeStoryIds?: string[]
  agents?: AgentSnapshot
}

export interface AppEvent {
  ts: number                   // ms
  unitName?: string
  type:
    | 'prd.discovered'
    | 'prd.removed'
    | 'prd.updated'
    | 'story.passed'
    | 'criterion.passed'
    | 'commit.landed'
    | 'heartbeat.touched'
    | 'watchdog.tick'
    | 'watchdog.resurrect'
    | 'decision.created'
    | 'decision.applied'
    | 'hook.tool_use'
    | 'hook.stop'
    | 'hook.user_prompt'
  detail?: string
}

export interface ServerSnapshot {
  prds: PRDRecord[]
  events: AppEvent[]           // newest first, capped
}
