// JSONL parser for Claude transcript files (`~/.claude/projects/<dir>/<uuid>.jsonl`).
//
// Reads a transcript file, splits on newlines, JSON.parses each non-empty line,
// and maps each record to a `Turn` discriminated union. The shape here is the
// contract that US-009 (chat renderer) and US-010 (live tail) consume.
//
// Design notes:
//
//   - Streaming/offset semantics (resume from a byte offset, partial last line,
//     `is_partial`) are intentionally out of scope here — US-008b extends this
//     same module with that machinery. The `isPartial?: boolean` field on
//     UserTurn/AssistantTurn is reserved for that follow-up.
//
//   - Top-level record types observed in real Claude transcripts:
//       user, assistant, system,
//       summary, queue-operation, attachment, ai-title, last-prompt,
//       file-history-snapshot, permission-mode
//     Anything in META_TYPES collapses to `{ kind: 'meta', type, raw }`.
//     `summary` was not in the AC list but is extremely common in real
//     transcripts (one per file, leafUuid pointer); treating it as a meta type
//     is consistent with the AC's "non-renderable types map to meta" rule.
//
//   - Unknown top-level types are preserved as `{ kind: 'raw', type, content }`
//     and warned ONCE per unique type at WARN level so a new Claude record
//     type shows up loudly in logs without spamming.
//
//   - Within a `tool_use` segment, `input` is whatever Claude passed to the
//     tool (e.g. `{ file_path: '...' }` for Read, or the whole Agent payload).
//     We keep it as `Record<string, unknown>` — we do NOT validate per-tool
//     shapes, the renderer does that.
//
//   - Within tool_use content arrays, segment items whose `type` we don't
//     recognise (or that fail the type guards) are silently dropped. This
//     mirrors how the renderer would behave anyway and avoids polluting the
//     log on every transcript with rare segment shapes.
//
//   - Records without a `uuid` (some meta records lack one) get a synthesized
//     placeholder via `crypto.randomUUID()`. Callers MUST NOT use uuid as a
//     stable identity key for meta turns — only user/assistant turns reliably
//     have a Claude-assigned uuid. The synthesized id is only there so the
//     `BaseTurn` shape is uniform.

import { readFile } from 'node:fs/promises'

export type Turn =
  | UserTurn
  | AssistantTurn
  | SystemTurn
  | MetaTurn
  | RawTurn

export interface BaseTurn {
  uuid: string
  timestamp: number  // ms since epoch (parsed from ISO 8601)
  raw: unknown       // original JSON record (stringifiable for debugging)
}

export interface UserTurn extends BaseTurn {
  kind: 'user'
  parentUuid: string | null
  isSidechain: boolean
  cwd: string | null
  gitBranch: string | null
  sessionId: string
  requestId?: string
  segments: Segment[]
  isPartial?: boolean
}

export interface AssistantTurn extends BaseTurn {
  kind: 'assistant'
  parentUuid: string | null
  isSidechain: boolean
  cwd: string | null
  gitBranch: string | null
  sessionId: string
  requestId?: string
  segments: Segment[]
  isPartial?: boolean
}

export interface SystemTurn extends BaseTurn {
  kind: 'system'
  content: string
  level?: string
}

export interface MetaTurn extends BaseTurn {
  kind: 'meta'
  type: string
}

export interface RawTurn extends BaseTurn {
  kind: 'raw'
  type: string
  content: unknown
}

export type Segment =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: unknown }

// Top-level record types we recognise as "meta" (non-renderable). Anything not
// in this set AND not user/assistant/system falls through to `raw`.
const META_TYPES = new Set([
  'summary',
  'queue-operation',
  'attachment',
  'ai-title',
  'last-prompt',
  'file-history-snapshot',
  'permission-mode',
])

// Module-level set of unknown record types we've already warned about. Reset
// for tests via `__resetWarnings()`.
const warnedUnknownTypes = new Set<string>()

export function __resetWarnings(): void {
  warnedUnknownTypes.clear()
}

export async function parseTranscript(path: string): Promise<Turn[]> {
  let data: string
  try {
    data = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  const turns: Turn[] = []
  for (const line of data.split('\n')) {
    if (!line.trim()) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      // Malformed lines are skipped silently — partial last-line writes are
      // expected in a live-tailed transcript and US-008b handles them more
      // carefully via byte-offset resume.
      continue
    }
    if (typeof record !== 'object' || record === null) continue
    const turn = parseRecord(record as Record<string, unknown>)
    if (turn) turns.push(turn)
  }
  return turns
}

function parseRecord(record: Record<string, unknown>): Turn | null {
  const ts = parseTimestamp(record.timestamp)
  const uuid = typeof record.uuid === 'string' && record.uuid.length > 0
    ? record.uuid
    : generateMissingUuid()

  switch (record.type) {
    case 'user':
    case 'assistant': {
      const message = isObject(record.message) ? record.message : null
      const content = message ? message.content : undefined
      return {
        kind: record.type,
        uuid,
        timestamp: ts,
        raw: record,
        parentUuid: typeof record.parentUuid === 'string' ? record.parentUuid : null,
        isSidechain: record.isSidechain === true,
        cwd: typeof record.cwd === 'string' ? record.cwd : null,
        gitBranch: typeof record.gitBranch === 'string' ? record.gitBranch : null,
        sessionId: typeof record.sessionId === 'string' ? record.sessionId : '',
        requestId: typeof record.requestId === 'string' ? record.requestId : undefined,
        segments: parseContent(content),
        isPartial: record.is_partial === true ? true : undefined,
      }
    }
    case 'system':
      return {
        kind: 'system',
        uuid,
        timestamp: ts,
        raw: record,
        content: typeof record.content === 'string'
          ? record.content
          : JSON.stringify(record.content ?? ''),
        level: typeof record.level === 'string' ? record.level : undefined,
      }
    default: {
      const t = record.type
      if (typeof t === 'string' && META_TYPES.has(t)) {
        return { kind: 'meta', uuid, timestamp: ts, raw: record, type: t }
      }
      const typeStr = typeof t === 'string' ? t : 'unknown'
      if (typeof t === 'string' && !warnedUnknownTypes.has(t)) {
        warnedUnknownTypes.add(t)
        console.warn(`[parser] unknown JSONL record type: ${t}`)
      }
      return {
        kind: 'raw',
        uuid,
        timestamp: ts,
        raw: record,
        type: typeStr,
        content: record,
      }
    }
  }
}

function parseContent(content: unknown): Segment[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  const out: Segment[] = []
  for (const item of content) {
    if (!isObject(item)) continue
    if (item.type === 'text' && typeof item.text === 'string') {
      out.push({ type: 'text', text: item.text })
    } else if (
      item.type === 'tool_use' &&
      typeof item.id === 'string' &&
      typeof item.name === 'string'
    ) {
      out.push({
        type: 'tool_use',
        id: item.id,
        name: item.name,
        input: isObject(item.input) ? (item.input as Record<string, unknown>) : {},
      })
    } else if (item.type === 'tool_result' && typeof item.tool_use_id === 'string') {
      out.push({
        type: 'tool_result',
        tool_use_id: item.tool_use_id,
        content: item.content,
      })
    }
    // Unknown segment types: silently drop. Renderer handles missing pieces.
  }
  return out
}

function parseTimestamp(ts: unknown): number {
  if (typeof ts === 'string') {
    const d = Date.parse(ts)
    return Number.isFinite(d) ? d : 0
  }
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts
  return 0
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function generateMissingUuid(): string {
  // Records without a uuid (some meta types) get a synthesized placeholder.
  // Callers must NOT rely on uuid as a stable identity for meta turns.
  return crypto.randomUUID()
}
