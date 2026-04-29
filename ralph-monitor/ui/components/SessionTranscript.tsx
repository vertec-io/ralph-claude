// Chat-style session transcript renderer (US-009).
//
// Consumes the `Turn[]` discriminated union from `server/jsonl/parser.ts`
// and renders user / assistant / system turns. Tool uses render as
// collapsible blocks; the `Agent` tool gets an explicit affordance with the
// subagent_type called out as a pill.
//
// Design notes / hedges:
//
//   - We render markdown via a minimal in-house code-fence splitter rather
//     than `marked.parse`. The AC explicitly forbids language-aware
//     tokenization ("no Prism / highlight.js"), and `marked`'s full markdown
//     parsing would inject paragraph/list semantics we don't actually want
//     in chat text. The minimal splitter handles the only required case
//     (triple-backtick code fences) and leaves prose as plain text. If we
//     later want full markdown for assistant messages, swap to
//     `marked.parse(text)` with `dangerouslySetInnerHTML`.
//
//   - "Final answer" labelling for the Agent tool's tool_result is computed
//     by walking each turn's segments once to build a `Set<string>` of
//     tool_use ids whose name === 'Agent', then passing that set down to
//     the segment view via React context. This keeps the per-segment view
//     stateless without threading prop drilling through every level. The
//     set is recomputed per render of the parent turn (cheap — O(n_segments)).
//
//   - `dedupeAndFilter` enforces the "is_partial replacement by uuid" rule
//     by walking the turn list left-to-right and inserting into a Map keyed
//     on uuid. Later occurrences overwrite earlier ones; insertion order is
//     preserved by the first occurrence (Map semantics), which is what we
//     want — the partial appears in the right slot, then gets replaced
//     in-place when the final record arrives.
//
//   - Sticky-bottom: `autoScroll` flips off the moment the user scrolls up
//     more than 5px from the bottom and back on when they're back at the
//     bottom. Auto-scroll only fires when `autoScroll` is true.

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AssistantTurn,
  Segment,
  SystemTurn,
  Turn,
  UserTurn,
} from '../../server/jsonl/parser'

export interface SessionTranscriptProps {
  sessionId: string
  turns: Turn[]
}

// React context: the set of tool_use ids whose name === 'Agent'. Used by
// `ToolResultView` to label the result block as "Final answer" instead of
// the generic "Tool result".
const AgentIdContext = createContext<Set<string>>(new Set())

export function SessionTranscript({ sessionId, turns }: SessionTranscriptProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  // Sticky-bottom: track scroll; if the user scrolls up, disable auto-scroll
  // until they scroll back to within 5px of the bottom.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 5
      setAutoScroll(atBottom)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const renderableTurns = useMemo(() => dedupeAndFilter(turns), [turns])

  // Auto-scroll on new turns (only when autoScroll is enabled).
  useEffect(() => {
    if (!autoScroll) return
    const el = containerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [renderableTurns, autoScroll])

  // Build the agent-tool-use-id set once per render: any tool_use named
  // 'Agent' contributes its id. Used by ToolResultView via context.
  const agentToolUseIds = useMemo(() => {
    const ids = new Set<string>()
    for (const t of renderableTurns) {
      if (t.kind !== 'user' && t.kind !== 'assistant') continue
      for (const s of t.segments) {
        if (s.type === 'tool_use' && s.name === 'Agent') ids.add(s.id)
      }
    }
    return ids
  }, [renderableTurns])

  if (renderableTurns.length === 0) {
    return (
      <div
        data-testid="empty-state"
        className="text-sm text-zinc-500 p-4 italic"
      >
        no conversation yet for session {sessionId.slice(0, 8)}
      </div>
    )
  }

  return (
    <AgentIdContext.Provider value={agentToolUseIds}>
      <div
        ref={containerRef}
        data-testid={`session-transcript-${sessionId}`}
        className="overflow-y-auto h-full p-4 space-y-3"
      >
        {renderableTurns.map(t => <TurnView key={t.uuid} turn={t} />)}
      </div>
    </AgentIdContext.Provider>
  )
}

// Filter sidechain user/assistant turns + meta + raw turns; dedupe by uuid
// (later wins, preserving slot of the first occurrence). Exported for unit
// tests.
export function dedupeAndFilter(turns: Turn[]): Turn[] {
  const map = new Map<string, Turn>()
  for (const t of turns) {
    if (t.kind === 'meta' || t.kind === 'raw') continue
    if ((t.kind === 'user' || t.kind === 'assistant') && t.isSidechain) continue
    map.set(t.uuid, t)
  }
  return [...map.values()]
}

function TurnView({ turn }: { turn: Turn }) {
  if (turn.kind === 'system') return <SystemTurnView turn={turn} />
  if (turn.kind === 'user') return <UserTurnView turn={turn} />
  if (turn.kind === 'assistant') return <AssistantTurnView turn={turn} />
  return null
}

function SystemTurnView({ turn }: { turn: SystemTurn }) {
  return (
    <div
      data-testid="turn-system"
      className="text-xs italic text-zinc-500 px-2"
    >
      {turn.content}
    </div>
  )
}

function UserTurnView({ turn }: { turn: UserTurn }) {
  return (
    <div
      data-testid="turn-user"
      className="bg-sky-950/30 border border-sky-900/40 rounded-md p-3"
    >
      <div className="text-[11px] uppercase tracking-wide text-sky-400 mb-1.5">
        user
      </div>
      <div className="space-y-2">
        {turn.segments.map((s, i) => <SegmentView key={i} segment={s} />)}
      </div>
    </div>
  )
}

function AssistantTurnView({ turn }: { turn: AssistantTurn }) {
  return (
    <div
      data-testid="turn-assistant"
      className="bg-zinc-900/60 border border-zinc-800 rounded-md p-3"
    >
      <div className="text-[11px] uppercase tracking-wide text-emerald-400 mb-1.5">
        assistant
        {turn.isPartial && (
          <span className="ml-2 text-zinc-600 normal-case">(streaming…)</span>
        )}
      </div>
      <div className="space-y-2">
        {turn.segments.map((s, i) => <SegmentView key={i} segment={s} />)}
      </div>
    </div>
  )
}

function SegmentView({ segment }: { segment: Segment }) {
  if (segment.type === 'text') return <TextSegmentView text={segment.text} />
  if (segment.type === 'tool_use') {
    if (segment.name === 'Agent') return <AgentToolView segment={segment} />
    return <ToolUseView segment={segment} />
  }
  if (segment.type === 'tool_result') return <ToolResultView segment={segment} />
  return null
}

// Minimal markdown text rendering: split on triple-backtick fences and
// render code blocks with a single accent background. Everything outside
// fences renders as plain text with `whitespace-pre-wrap` so newlines
// survive without forcing a paragraph parser.
function TextSegmentView({ text }: { text: string }) {
  // The split regex captures: (lang)(code) for each fence. `parts` is then
  // interleaved: [text, lang, code, text, lang, code, ...].
  const parts = text.split(/```(\w*)\n([\s\S]*?)```/g)
  const nodes: React.ReactNode[] = []
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 0) {
      const t = parts[i]
      if (t.length === 0) continue
      nodes.push(
        <div
          key={i}
          className="text-sm text-zinc-200 whitespace-pre-wrap break-words"
        >
          {t}
        </div>,
      )
    } else if (i % 3 === 2) {
      // i % 3 === 1 is the captured language tag; we intentionally ignore
      // it — no language-aware tokenization per AC.
      nodes.push(
        <pre
          key={i}
          className="font-mono text-xs bg-zinc-950 border border-zinc-800 rounded-md p-3 overflow-x-auto"
        >
          <code>{parts[i]}</code>
        </pre>,
      )
    }
  }
  return <>{nodes}</>
}

// Compact summary of the first 1-2 keys of a tool_use input. Truncates each
// value at ~40 chars + ellipsis. Exported for unit tests.
export function summarizeInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input)
  if (keys.length === 0) return ''
  const pairs: string[] = []
  for (const k of keys.slice(0, 2)) {
    const v = input[k]
    let rendered: string
    if (typeof v === 'string') {
      rendered = v.length > 40 ? `"${v.slice(0, 40)}…"` : `"${v}"`
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      rendered = String(v)
    } else {
      const s = JSON.stringify(v)
      rendered = s.length > 40 ? `${s.slice(0, 40)}…` : s
    }
    pairs.push(`${k}: ${rendered}`)
  }
  return pairs.join(', ')
}

function ToolUseView({
  segment,
}: {
  segment: Extract<Segment, { type: 'tool_use' }>
}) {
  const [expanded, setExpanded] = useState(false)
  const shortInput = summarizeInput(segment.input)
  return (
    <div
      data-testid="tool-use"
      className="border-l-2 border-violet-700 pl-2"
    >
      <button
        onClick={() => setExpanded(e => !e)}
        className="text-xs font-mono text-violet-300 hover:text-violet-200 text-left w-full truncate"
      >
        {expanded ? '▼' : '▶'} {segment.name}({shortInput})
      </button>
      {expanded && (
        <pre className="text-[11px] mt-1 bg-zinc-950 border border-zinc-800 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
          {JSON.stringify(segment.input, null, 2)}
        </pre>
      )}
    </div>
  )
}

function AgentToolView({
  segment,
}: {
  segment: Extract<Segment, { type: 'tool_use' }>
}) {
  const [expanded, setExpanded] = useState(false)
  const description =
    typeof segment.input.description === 'string'
      ? segment.input.description
      : '<no description>'
  const subagentType =
    typeof segment.input.subagent_type === 'string'
      ? segment.input.subagent_type
      : 'general-purpose'
  const prompt =
    typeof segment.input.prompt === 'string' ? segment.input.prompt : ''

  return (
    <div
      data-testid="agent-tool"
      className="border-l-2 border-amber-500 pl-2 bg-amber-950/10 rounded"
    >
      <button
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-2 text-sm font-medium text-amber-200 hover:text-amber-100 text-left w-full"
      >
        <span>{expanded ? '▼' : '▶'}</span>
        <span className="truncate">Agent: {description}</span>
        <span
          data-testid="subagent-pill"
          className="ml-auto shrink-0 px-2 py-0.5 text-[10px] uppercase rounded-full bg-amber-900/60 text-amber-200"
        >
          {subagentType}
        </span>
      </button>
      {expanded && (
        <div className="mt-2 space-y-2">
          <div className="text-xs text-zinc-300">
            <span className="font-semibold text-amber-300">subagent_type:</span>{' '}
            <span className="font-mono">{subagentType}</span>
          </div>
          <details>
            <summary className="text-xs cursor-pointer text-zinc-400 hover:text-zinc-200">
              prompt
            </summary>
            <pre className="text-[11px] mt-1 bg-zinc-950 border border-zinc-800 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
              {prompt}
            </pre>
          </details>
        </div>
      )}
      <div className="text-[10px] text-zinc-600 italic mt-1">
        sub-agent trace not surfaced in v1 — see PRD non-goals
      </div>
    </div>
  )
}

function ToolResultView({
  segment,
}: {
  segment: Extract<Segment, { type: 'tool_result' }>
}) {
  const agentIds = useContext(AgentIdContext)
  const isAgentResult = agentIds.has(segment.tool_use_id)
  const contentStr =
    typeof segment.content === 'string'
      ? segment.content
      : JSON.stringify(segment.content, null, 2)
  const lineCount = contentStr.split('\n').length
  // Default-collapse when output > 10 lines (per AC).
  const [collapsed, setCollapsed] = useState(lineCount > 10)
  const label = isAgentResult ? 'Final answer' : 'Tool result'

  return (
    <div data-testid="tool-result" className="ml-2">
      <button
        onClick={() => setCollapsed(c => !c)}
        className="text-[11px] text-zinc-500 hover:text-zinc-300 font-mono"
      >
        {collapsed ? '▶' : '▼'} {label} ({lineCount} line{lineCount === 1 ? '' : 's'})
      </button>
      {!collapsed && (
        <pre className="text-[11px] mt-1 bg-zinc-950 border border-zinc-800 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
          {contentStr}
        </pre>
      )}
    </div>
  )
}
