// Pure-function unit tests for SessionTranscript helpers.
//
// Approach A from US-009: we cover `dedupeAndFilter` and `summarizeInput` —
// the two non-trivial pure helpers — and defer render-tree assertions to
// US-018 Playwright. We don't pull in @testing-library/react since it's not
// in the repo's deps and the AC explicitly defers Playwright work.

import { describe, expect, test } from 'bun:test'
import type {
  AssistantTurn,
  MetaTurn,
  RawTurn,
  SystemTurn,
  Turn,
  UserTurn,
} from '../../server/jsonl/parser'
import { dedupeAndFilter, summarizeInput } from './SessionTranscript'

function makeUser(overrides: Partial<UserTurn> = {}): UserTurn {
  return {
    kind: 'user',
    uuid: overrides.uuid ?? crypto.randomUUID(),
    timestamp: 0,
    raw: {},
    parentUuid: null,
    isSidechain: false,
    cwd: null,
    gitBranch: null,
    sessionId: 's',
    segments: [],
    ...overrides,
  }
}

function makeAssistant(overrides: Partial<AssistantTurn> = {}): AssistantTurn {
  return {
    kind: 'assistant',
    uuid: overrides.uuid ?? crypto.randomUUID(),
    timestamp: 0,
    raw: {},
    parentUuid: null,
    isSidechain: false,
    cwd: null,
    gitBranch: null,
    sessionId: 's',
    segments: [],
    ...overrides,
  }
}

function makeSystem(overrides: Partial<SystemTurn> = {}): SystemTurn {
  return {
    kind: 'system',
    uuid: overrides.uuid ?? crypto.randomUUID(),
    timestamp: 0,
    raw: {},
    content: 'sys',
    ...overrides,
  }
}

function makeMeta(overrides: Partial<MetaTurn> = {}): MetaTurn {
  return {
    kind: 'meta',
    uuid: overrides.uuid ?? crypto.randomUUID(),
    timestamp: 0,
    raw: {},
    type: 'summary',
    ...overrides,
  }
}

function makeRaw(overrides: Partial<RawTurn> = {}): RawTurn {
  return {
    kind: 'raw',
    uuid: overrides.uuid ?? crypto.randomUUID(),
    timestamp: 0,
    raw: {},
    type: 'unknown',
    content: {},
    ...overrides,
  }
}

describe('dedupeAndFilter', () => {
  test('drops sidechain user turns', () => {
    const turns: Turn[] = [
      makeUser({ isSidechain: true }),
      makeUser({ isSidechain: false }),
    ]
    const out = dedupeAndFilter(turns)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('user')
    expect((out[0] as UserTurn).isSidechain).toBe(false)
  })

  test('drops sidechain assistant turns', () => {
    const turns: Turn[] = [
      makeAssistant({ isSidechain: true }),
      makeAssistant({ isSidechain: false }),
    ]
    const out = dedupeAndFilter(turns)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('assistant')
  })

  test('drops meta turns', () => {
    const turns: Turn[] = [makeMeta(), makeUser(), makeMeta()]
    const out = dedupeAndFilter(turns)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('user')
  })

  test('drops raw turns', () => {
    const turns: Turn[] = [makeRaw(), makeUser(), makeRaw()]
    const out = dedupeAndFilter(turns)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('user')
  })

  test('keeps system turns', () => {
    const turns: Turn[] = [makeSystem(), makeUser(), makeSystem()]
    const out = dedupeAndFilter(turns)
    expect(out).toHaveLength(3)
    expect(out.map(t => t.kind)).toEqual(['system', 'user', 'system'])
  })

  test('replaces a partial turn with a later turn sharing the same uuid', () => {
    const u = 'turn-uuid-123'
    const partial = makeAssistant({
      uuid: u,
      isPartial: true,
      segments: [{ type: 'text', text: 'partial…' }],
    })
    const final = makeAssistant({
      uuid: u,
      isPartial: undefined,
      segments: [{ type: 'text', text: 'final answer' }],
    })
    const out = dedupeAndFilter([partial, final])
    expect(out).toHaveLength(1)
    const seg = (out[0] as AssistantTurn).segments[0]
    expect(seg.type === 'text' && seg.text).toBe('final answer')
    expect((out[0] as AssistantTurn).isPartial).toBeUndefined()
  })

  test('preserves insertion order across multiple turns', () => {
    const a = makeUser({ uuid: 'a' })
    const b = makeAssistant({ uuid: 'b' })
    const c = makeUser({ uuid: 'c' })
    const out = dedupeAndFilter([a, b, c])
    expect(out.map(t => t.uuid)).toEqual(['a', 'b', 'c'])
  })

  test('returns empty for an empty input', () => {
    expect(dedupeAndFilter([])).toEqual([])
  })

  test('returns empty when every turn is filtered', () => {
    const turns: Turn[] = [
      makeMeta(),
      makeRaw(),
      makeUser({ isSidechain: true }),
      makeAssistant({ isSidechain: true }),
    ]
    expect(dedupeAndFilter(turns)).toEqual([])
  })
})

describe('summarizeInput', () => {
  test('empty object returns empty string', () => {
    expect(summarizeInput({})).toBe('')
  })

  test('single string field renders as quoted key: value', () => {
    expect(summarizeInput({ file_path: '/foo' })).toBe('file_path: "/foo"')
  })

  test('truncates long string values to ~40 chars + ellipsis', () => {
    const long = 'x'.repeat(100)
    const out = summarizeInput({ longvalue: long })
    // Format: longvalue: "<40 x's>…"
    expect(out.startsWith('longvalue: "')).toBe(true)
    expect(out.endsWith('…"')).toBe(true)
    // 40 truncated + 2 quotes + 1 ellipsis ≤ rendered value length 44
    expect(out.length).toBeLessThan(60)
  })

  test('renders numbers and booleans without quotes', () => {
    expect(summarizeInput({ limit: 100 })).toBe('limit: 100')
    expect(summarizeInput({ enabled: true })).toBe('enabled: true')
    expect(summarizeInput({ nullable: null })).toBe('nullable: null')
  })

  test('renders only the first 2 keys', () => {
    const out = summarizeInput({ a: 1, b: 2, c: 3, d: 4 })
    expect(out).toBe('a: 1, b: 2')
  })

  test('renders objects as JSON, truncated', () => {
    const out = summarizeInput({ nested: { x: 1, y: 2 } })
    expect(out.startsWith('nested: ')).toBe(true)
    expect(out).toContain('{"x":1')
  })

  test('joins two fields with comma', () => {
    expect(summarizeInput({ file_path: '/foo/bar.ts', limit: 100 })).toBe(
      'file_path: "/foo/bar.ts", limit: 100',
    )
  })
})
