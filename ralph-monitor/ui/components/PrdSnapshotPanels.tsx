// PrdSnapshotPanels — extracted decisions / agents / tasks / docs / commits panels.
//
// Takes only a `snapshot` prop typed as PRDRecord (which is the canonical
// SnapshotData shape post-US-012a). Renders identically to the inline
// sections that previously lived in PRDDetail inside App.tsx.
//
// The component does NOT manage its own open-story / open-file state; those
// callbacks are passed in from the parent (PRDDetail) so the modals continue
// to live at the PRDDetail level.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { PRDRecord, ClaudeProcess, AgentTask, UserStory, CommitRow } from '../../server/types'

// ---------------------------------------------------------------------------
// Re-exported pure helper (tested in PrdSnapshotPanels.test.tsx)
// ---------------------------------------------------------------------------

export function buildProcessTree(procs: ClaudeProcess[]): {
  roots: ClaudeProcess[]
  childrenByPpid: Map<number, ClaudeProcess[]>
} {
  const pidSet = new Set(procs.map(p => p.pid))
  const childrenByPpid = new Map<number, ClaudeProcess[]>()
  for (const p of procs) {
    if (pidSet.has(p.ppid)) {
      const arr = childrenByPpid.get(p.ppid) ?? []
      arr.push(p)
      childrenByPpid.set(p.ppid, arr)
    }
  }
  // Roots: processes whose parent isn't another claude in our set.
  // Sort the confirmed orchestrator first; everything else is just a "claude
  // root" that we can't positively attribute to this PRD's orchestrator.
  const roots = procs
    .filter(p => !pidSet.has(p.ppid))
    .sort((a, b) => Number(b.isOrchestrator === true) - Number(a.isOrchestrator === true))
  return { roots, childrenByPpid }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ProcessNode({ proc, childrenByPpid, depth }: {
  proc: ClaudeProcess
  childrenByPpid: Map<number, ClaudeProcess[]>
  depth: number
}) {
  const children = childrenByPpid.get(proc.pid) ?? []
  const orch = proc.isOrchestrator === true
  const isChild = depth > 0
  const label = orch ? 'orchestrator' : isChild ? 'subagent' : 'claude'
  const labelColor = orch ? 'text-emerald-300' : isChild ? 'text-sky-300' : 'text-zinc-400'
  const dotColor = orch ? 'bg-emerald-500 live-dot' : isChild ? 'bg-sky-500' : 'bg-zinc-500'

  return (
    <div>
      <div className="flex items-center gap-2" style={{ paddingLeft: depth * 16 }}>
        {isChild && <span className="text-zinc-700">└</span>}
        <span className={`size-1.5 rounded-full ${dotColor}`} />
        <span className={labelColor}>{label}</span>
        <span className="text-zinc-500">pid {proc.pid}</span>
        {isChild && <span className="text-zinc-700 text-xs">(parent {proc.ppid})</span>}
      </div>
      {children.map(c => (
        <ProcessNode key={c.pid} proc={c} childrenByPpid={childrenByPpid} depth={depth + 1} />
      ))}
    </div>
  )
}

function TaskRow({ task, onStoryClick }: { task: AgentTask; onStoryClick: (id: string) => void }) {
  const isRunning = task.status === 'running'
  const duration = task.endedAt
    ? `${Math.round((task.endedAt - task.startedAt) / 1000)}s`
    : `${Math.round((Date.now() - task.startedAt) / 1000)}s`

  return (
    <li className="flex items-start gap-2 text-sm">
      <span className={`mt-1.5 size-1.5 rounded-full shrink-0 ${
        isRunning ? 'bg-emerald-500 live-dot' : 'bg-zinc-600'
      }`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          {task.storyIds.length > 0 ? (
            task.storyIds.map(id => (
              <button
                key={id}
                onClick={() => onStoryClick(id)}
                className="font-mono text-xs text-emerald-300 hover:text-emerald-100 hover:underline underline-offset-2"
              >
                {id}
              </button>
            ))
          ) : (
            <span className="font-mono text-xs text-zinc-500">(no story id)</span>
          )}
          {task.subagentType && (
            <span className="text-[10px] uppercase px-1 rounded bg-zinc-800 text-zinc-400">
              {task.subagentType}
            </span>
          )}
          {task.model && (
            <span className="text-[10px] uppercase px-1 rounded bg-zinc-800 text-zinc-400">
              {task.model}
            </span>
          )}
          <span className="text-[11px] text-zinc-500 tabular-nums">
            {isRunning ? `running ${duration}` : `${duration} · ${timeAgo(task.endedAt!)}`}
          </span>
        </div>
        {task.description && (
          <div className="text-xs text-zinc-400 truncate">{task.description}</div>
        )}
      </div>
    </li>
  )
}

function AgentsPanel({ agents, onStoryClick }: {
  agents?: PRDRecord['agents']
  onStoryClick: (id: string) => void
}) {
  if (!agents) return null
  const tree = useMemo(() => buildProcessTree(agents.processes ?? []), [agents.processes])
  const processes = agents.processes ?? []
  const tasks = agents.tasks ?? []
  const running = tasks.filter(t => t.status === 'running')
  const completed = tasks.filter(t => t.status === 'completed').slice(0, 10)

  if (processes.length === 0 && tasks.length === 0) return null

  return (
    <section className="px-6 py-4 border-b border-zinc-900">
      <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-3 flex items-center gap-2">
        agents
        <span className="text-zinc-700 normal-case">
          · {processes.length} process{processes.length === 1 ? '' : 'es'}
          {running.length > 0 && ` · ${running.length} running`}
        </span>
      </h3>

      {tree.roots.length > 0 ? (
        <div className="text-sm font-mono space-y-0.5 mb-3">
          {tree.roots.map(root => (
            <ProcessNode
              key={root.pid}
              proc={root}
              childrenByPpid={tree.childrenByPpid}
              depth={0}
            />
          ))}
        </div>
      ) : (
        <div className="text-sm text-zinc-600 italic mb-3">no live claude processes detected</div>
      )}

      {running.length > 0 && (
        <div className="mb-3">
          <h4 className="text-[11px] uppercase tracking-wide text-emerald-400 mb-1.5 flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-emerald-500 live-dot" />
            in-flight tasks ({running.length})
          </h4>
          <ul className="space-y-1">
            {running.map(t => <TaskRow key={t.id} task={t} onStoryClick={onStoryClick} />)}
          </ul>
        </div>
      )}

      {completed.length > 0 && (
        <details className="group">
          <summary className="text-[11px] uppercase tracking-wide text-zinc-600 hover:text-zinc-400 cursor-pointer mb-1.5 list-none flex items-center gap-2">
            <span className="group-open:rotate-90 transition-transform inline-block">▸</span>
            recent completed ({completed.length})
          </summary>
          <ul className="space-y-1">
            {completed.map(t => <TaskRow key={t.id} task={t} onStoryClick={onStoryClick} />)}
          </ul>
        </details>
      )}

      {tasks.length === 0 && processes.length > 0 && (
        <div className="text-[11px] text-zinc-600">
          {processes.length > 1 && (
            <div className="mb-1">
              multiple claude processes share this worktree — orchestrator
              identification is best-effort (cmdline match for <code>--resume</code>
              invocations, racy fd check for live writes). install hooks for
              reliable per-task attribution.
            </div>
          )}
          (run <code>hooks/install.sh</code> to see Task dispatches with story attribution)
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// timeAgo (local copy — avoids pulling from App.tsx which isn't exported)
// ---------------------------------------------------------------------------

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 0) return 'in future'
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// ---------------------------------------------------------------------------
// Main exported component
// ---------------------------------------------------------------------------

export interface PrdSnapshotPanelsProps {
  snapshot: PRDRecord
  onStoryClick: (id: string) => void
  onFileClick: (path: string) => void
}

export function PrdSnapshotPanels({ snapshot, onStoryClick, onFileClick }: PrdSnapshotPanelsProps) {
  const [showCompleted, setShowCompleted] = useState(false)

  const stories = snapshot.prd?.userStories ?? []
  const activeIds = snapshot.activeStoryIds ?? []
  const pendingDecisions = (snapshot.decisionFiles ?? []).filter(d => d.pending)

  // Bucket stories into active / pending / blocked / completed
  const buckets = useMemo(() => bucketStories(stories, activeIds), [stories, activeIds])

  return (
    <>
      {/* Pending decisions banner */}
      {pendingDecisions.length > 0 && (
        <section className="px-6 py-3 bg-amber-950/30 border-b border-amber-900/40">
          <h3 className="text-xs uppercase tracking-wide text-amber-400 mb-2">
            pending decisions ({pendingDecisions.length})
          </h3>
          <ul className="text-sm space-y-1">
            {pendingDecisions.map(d => (
              <li key={d.path}>
                <button
                  onClick={() => onFileClick(d.path)}
                  className="font-mono text-amber-200 hover:text-amber-100 underline-offset-2 hover:underline truncate text-left w-full"
                >
                  {d.path.replace(snapshot.taskDir + '/', '')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Active-now banner */}
      {buckets.active.length > 0 && (
        <section className="px-6 py-3 bg-emerald-950/20 border-b border-emerald-900/40">
          <h3 className="text-xs uppercase tracking-wide text-emerald-400 mb-2 flex items-center gap-2">
            <span className="size-2 rounded-full bg-emerald-500 live-dot" />
            active now ({buckets.active.length})
          </h3>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {buckets.active.map(s => (
              <li key={s.id}
                onClick={() => onStoryClick(s.id)}
                className="flex items-center gap-1.5 text-emerald-200 cursor-pointer hover:text-emerald-100"
              >
                <span className="font-mono">{s.id}</span>
                <span className="text-emerald-500/70">·</span>
                <span className="text-emerald-400/80">{s.lastActivityAt ? timeAgo(s.lastActivityAt) : 'now'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Agents panel */}
      <AgentsPanel agents={snapshot.agents} onStoryClick={onStoryClick} />

      {/* User stories */}
      <section className="px-6 py-4 space-y-5">
        {buckets.active.length > 0 && (
          <StoryGroup label="active" count={buckets.active.length} color="emerald"
            stories={buckets.active} bucket="active" onSelect={onStoryClick} />
        )}
        {buckets.pending.length > 0 && (
          <StoryGroup label="pending" count={buckets.pending.length} color="zinc"
            stories={buckets.pending} bucket="pending" onSelect={onStoryClick} />
        )}
        {buckets.blocked.length > 0 && (
          <StoryGroup label="blocked" count={buckets.blocked.length} color="violet"
            stories={buckets.blocked} bucket="blocked" onSelect={onStoryClick} />
        )}
        {buckets.completed.length > 0 && (
          <div>
            <button
              onClick={() => setShowCompleted(s => !s)}
              className="w-full text-left flex items-center gap-2 text-[11px] uppercase tracking-wide text-zinc-600 hover:text-zinc-400 mb-2"
            >
              <span>{showCompleted ? '▾' : '▸'}</span>
              <span>completed</span>
              <span className="text-zinc-700 normal-case">({buckets.completed.length})</span>
            </button>
            {showCompleted && (
              <ul className="space-y-0.5 ml-4 border-l border-zinc-900 pl-3">
                {buckets.completed.map(s => (
                  <li key={s.id}
                    onClick={() => onStoryClick(s.id)}
                    className="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer"
                  >
                    <span className="text-emerald-700">✓</span>
                    <span className="font-mono">{s.id}</span>
                    <span className="truncate line-through">{s.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {stories.length === 0 && <div className="text-sm text-zinc-500">no prd.json found</div>}
      </section>

      {/* Documents */}
      <section className="px-6 py-4 border-t border-zinc-900">
        <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2">documents</h3>
        <ul className="text-sm space-y-0.5">
          {(snapshot.docFiles ?? []).map(d => {
            const decision = (snapshot.decisionFiles ?? []).find(df => df.path === d.path)
            const isDecisionsDir = d.name.startsWith('decisions/')
            return (
              <li key={d.path}>
                <button
                  onClick={() => onFileClick(d.path)}
                  className={`font-mono text-left hover:text-sky-400 hover:underline underline-offset-2 ${
                    isDecisionsDir ? 'text-zinc-400' : 'text-zinc-300'
                  }`}
                >
                  {decision?.pending && <span className="text-amber-400 mr-1">⏳</span>}
                  {decision && !decision.pending && <span className="text-emerald-500 mr-1">✓</span>}
                  {d.name}
                  <span className="ml-2 text-[11px] text-zinc-600 font-sans">
                    {(d.size / 1024).toFixed(1)} kB · {timeAgo(d.mtime)}
                  </span>
                  {decision?.selected && (
                    <span className="ml-2 text-[11px] text-zinc-500">→ {decision.selected}</span>
                  )}
                </button>
              </li>
            )
          })}
          {(snapshot.docFiles ?? []).length === 0 && (
            <li className="text-zinc-600 italic">no documents found</li>
          )}
        </ul>
      </section>

      {/* Recent commits */}
      <section className="px-6 py-4 border-t border-zinc-900">
        <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2">recent commits</h3>
        <ul className="text-sm font-mono space-y-0.5">
          {(snapshot.recentCommits ?? []).map(c => (
            <li key={c.sha} className="flex gap-3 text-zinc-300">
              <span className="text-emerald-500">{c.short}</span>
              <span className="text-zinc-500">{timeAgo(c.ts * 1000)}</span>
              <span className="truncate">{c.subject}</span>
            </li>
          ))}
          {(snapshot.recentCommits ?? []).length === 0 && <li className="text-zinc-600 italic">no commits yet</li>}
        </ul>
      </section>

      {/* Watchdog log tail */}
      <section className="px-6 py-4 border-t border-zinc-900">
        <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2">watchdog log tail</h3>
        <pre className="text-xs font-mono text-zinc-400 whitespace-pre-wrap break-words leading-relaxed">
          {(snapshot.watchdogLogTail ?? []).length === 0 ? '(no entries)' : snapshot.watchdogLogTail.join('\n')}
        </pre>
      </section>
    </>
  )
}

// ---------------------------------------------------------------------------
// Story-related helpers (kept local; referenced only by PrdSnapshotPanels)
// ---------------------------------------------------------------------------

type StoryBucket = 'active' | 'pending' | 'blocked' | 'completed'

function bucketStories(
  stories: UserStory[],
  activeIds: string[],
): { active: UserStory[]; pending: UserStory[]; blocked: UserStory[]; completed: UserStory[] } {
  const activeSet = new Set(activeIds)
  const passingIds = new Set(stories.filter(s => s.passes).map(s => s.id))

  const active: UserStory[] = []
  const pending: UserStory[] = []
  const blocked: UserStory[] = []
  const completed: UserStory[] = []

  for (const s of stories) {
    if (s.passes) {
      completed.push(s)
      continue
    }
    if (activeSet.has(s.id)) {
      active.push(s)
      continue
    }
    const isBlocked = (s.blockedBy ?? []).some(id => !passingIds.has(id))
    if (isBlocked) blocked.push(s)
    else pending.push(s)
  }

  active.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
  const byPriority = (a: UserStory, b: UserStory) =>
    (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER)
  pending.sort(byPriority)
  blocked.sort(byPriority)
  completed.sort((a, b) => a.id.localeCompare(b.id))

  return { active, pending, blocked, completed }
}

function useFlashOnChange(value: number | undefined): string {
  const prev = useRef<number | undefined>(value)
  const [flashing, setFlashing] = useState(false)
  useEffect(() => {
    if (value !== undefined && prev.current !== undefined && value > prev.current) {
      setFlashing(true)
      const t = setTimeout(() => setFlashing(false), 1500)
      prev.current = value
      return () => clearTimeout(t)
    }
    prev.current = value
  }, [value])
  return flashing ? 'flash-row' : ''
}

function StoryGroup({ label, count, color, stories, bucket, onSelect }: {
  label: string
  count: number
  color: 'emerald' | 'zinc' | 'violet'
  stories: UserStory[]
  bucket: StoryBucket
  onSelect: (id: string) => void
}) {
  const colorClass = { emerald: 'text-emerald-400', zinc: 'text-zinc-500', violet: 'text-violet-400' }[color]
  return (
    <div>
      <h4 className={`text-[11px] uppercase tracking-wide ${colorClass} mb-2`}>
        {label} <span className="text-zinc-600">({count})</span>
      </h4>
      <ul className="space-y-1">
        {stories.map(s => <StoryRow key={s.id} story={s} bucket={bucket} onSelect={onSelect} />)}
      </ul>
    </div>
  )
}

function StoryRow({ story, bucket, onSelect }: {
  story: UserStory
  bucket: StoryBucket
  onSelect: (id: string) => void
}) {
  const crit = (story.acceptanceCriteria ?? []).map(c =>
    typeof c === 'string' ? { description: c, passes: story.passes } : c
  )
  const passing = crit.filter(c => c.passes).length
  const isActive = bucket === 'active'
  const isBlocked = bucket === 'blocked'
  const blockedBy = story.blockedBy?.filter(Boolean) ?? []

  const rowBg = isActive ? 'bg-emerald-950/20 border border-emerald-900/30 rounded-md p-2'
    : isBlocked ? 'opacity-60'
    : ''

  const flash = useFlashOnChange(story.lastActivityAt)

  return (
    <li
      onClick={() => onSelect(story.id)}
      className={`flex items-start gap-2 text-sm cursor-pointer hover:bg-zinc-900/50 transition-colors rounded-md ${rowBg} ${flash}`}
    >
      <span
        className={`mt-1 size-2 rounded-full shrink-0 ${
          isActive ? 'bg-emerald-500 live-dot' :
          story.passes ? 'bg-emerald-500' :
          isBlocked ? 'bg-violet-700' :
          'bg-zinc-700'
        }`}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs text-zinc-500">{story.id}</span>
          <span className={`truncate ${story.passes ? 'text-zinc-500 line-through' : 'text-zinc-200'}`}>
            {story.title}
          </span>
          {story.modelHint && (
            <span className="text-[10px] uppercase px-1 rounded bg-zinc-800 text-zinc-400">
              {story.modelHint}
            </span>
          )}
          {isActive && story.lastActivityAt && (
            <span className="text-[10px] uppercase px-1 rounded bg-emerald-900/60 text-emerald-300">
              {timeAgo(story.lastActivityAt)}
            </span>
          )}
          <span className="ml-auto text-[11px] tabular-nums text-zinc-500">
            {passing}/{crit.length || '—'}
          </span>
        </div>
        {isBlocked && blockedBy.length > 0 && (
          <div className="mt-0.5 text-[11px] text-violet-400/80">
            blocked by <span className="font-mono">{blockedBy.join(', ')}</span>
          </div>
        )}
        {crit.length > 0 && !story.passes && (isActive || crit.some(c => c.passes)) && (
          <ul className="mt-1 ml-1 space-y-0.5">
            {crit.map((c, i) => (
              <li key={i} className="flex items-center gap-1.5 text-xs">
                <span className={`size-1.5 rounded-full ${c.passes ? 'bg-emerald-600' : 'bg-zinc-800'}`} />
                <span className={c.passes ? 'text-zinc-500 line-through' : 'text-zinc-400'}>
                  {c.description}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  )
}
