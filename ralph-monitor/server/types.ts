// Shared types between server and ui

import type { Project, Session, PrdSpec } from './db'

export type PRDStatus = 'active' | 'idle' | 'crashed' | 'complete' | 'blocked' | 'pending'

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
  decisionConfig?: {
    inputFile?: string
    status?: string
    userSelection?: string
    userNotes?: string
  }
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
  ts: number
}

export interface DecisionFile {
  path: string
  storyId?: string
  selected?: string
  pending: boolean
}

export interface ClaudeProcess {
  pid: number
  ppid: number
  isOrchestrator?: boolean
}

export interface AgentTask {
  id: string
  startedAt: number
  endedAt?: number
  status: 'running' | 'completed'
  description?: string
  storyIds: string[]
  subagentType?: string
  model?: string
}

export interface AgentSnapshot {
  processes: ClaudeProcess[]
  tasks: AgentTask[]
}

export interface DocFile {
  path: string
  name: string
  size: number
  mtime: number
}

export interface PRDRecord {
  unitName: string
  taskDir: string
  worktreeDir: string
  sessionId: string
  prd?: PRDJson
  heartbeatMtime?: number
  jsonlMtime?: number
  recentCommits: CommitRow[]
  watchdogLogTail: string[]
  decisionFiles: DecisionFile[]
  docFiles: DocFile[]
  status: PRDStatus
  lastUpdated: number
  activeStoryIds?: string[]
  agents?: AgentSnapshot
}

export interface PRDAppEvent {
  ts: number
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

// Project / session / prd-spec lifecycle events.
export type LifecycleAppEvent =
  | { type: 'project.created'; ts: number; project: Project }
  | { type: 'project.updated'; ts: number; project: Project }
  | { type: 'project.deleted'; ts: number; id: string }
  | { type: 'session.created'; ts: number; session: Session }
  | { type: 'session.updated'; ts: number; session: Session }
  | { type: 'session.deleted'; ts: number; id: string }
  | { type: 'session.exited'; ts: number; id: string; exit_code?: number }
  | { type: 'session.activity'; ts: number; id: string }
  | { type: 'prd_spec.created'; ts: number; prd_spec: PrdSpec }
  | { type: 'prd_spec.updated'; ts: number; prd_spec: PrdSpec }
  | { type: 'prd_spec.deleted'; ts: number; id: string }
  | { type: 'session.prds.updated'; ts: number; session_id: string; prd_spec_ids: string[] }
  | {
      type: 'lifecycle.snapshot'
      ts: number
      projects: Project[]
      live_session_ids: string[]
    }

export type AppEvent = PRDAppEvent | LifecycleAppEvent

export interface ServerSnapshot {
  prds: PRDRecord[]
  events: AppEvent[]
}
