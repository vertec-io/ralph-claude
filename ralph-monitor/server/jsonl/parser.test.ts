// Unit tests for the JSONL transcript parser.
//
// Each test crafts a temp .jsonl file with a few hand-written records and
// asserts the resulting Turn[] shape. We use the OS temp dir + crypto.randomUUID
// for filename uniqueness (no collisions across parallel test files).

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __resetWarnings,
  parseTranscript,
  type AssistantTurn,
  type MetaTurn,
  type RawTurn,
  type SystemTurn,
  type UserTurn,
} from './parser'

let tmpDir: string

beforeEach(async () => {
  __resetWarnings()
  tmpDir = await mkdtemp(join(tmpdir(), 'parser-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function writeJsonl(name: string, lines: unknown[]): Promise<string> {
  const path = join(tmpDir, name)
  const body = lines
    .map((l) => (typeof l === 'string' ? l : JSON.stringify(l)))
    .join('\n')
  await writeFile(path, body)
  return path
}

describe('parseTranscript', () => {
  test('empty file returns []', async () => {
    const p = await writeJsonl('empty.jsonl', [])
    expect(await parseTranscript(p)).toEqual([])
  })

  test('missing file (ENOENT) returns []', async () => {
    expect(await parseTranscript(join(tmpDir, 'does-not-exist.jsonl'))).toEqual([])
  })

  test('single user turn with string content', async () => {
    const p = await writeJsonl('single-user.jsonl', [
      {
        type: 'user',
        parentUuid: null,
        isSidechain: false,
        userType: 'external',
        cwd: '/home/apino/dev/ralph-claude',
        sessionId: 'sess-1',
        version: '1.0',
        gitBranch: 'main',
        message: { role: 'user', content: 'hello' },
        uuid: 'u-1',
        timestamp: '2026-04-29T12:00:00.000Z',
      },
    ])
    const turns = await parseTranscript(p)
    expect(turns).toHaveLength(1)
    const t = turns[0] as UserTurn
    expect(t.kind).toBe('user')
    expect(t.uuid).toBe('u-1')
    expect(t.parentUuid).toBeNull()
    expect(t.isSidechain).toBe(false)
    expect(t.cwd).toBe('/home/apino/dev/ralph-claude')
    expect(t.gitBranch).toBe('main')
    expect(t.sessionId).toBe('sess-1')
    expect(t.timestamp).toBe(Date.parse('2026-04-29T12:00:00.000Z'))
    expect(t.segments).toEqual([{ type: 'text', text: 'hello' }])
    expect(t.isPartial).toBeUndefined()
  })

  test('assistant turn with text + tool_use segments', async () => {
    const p = await writeJsonl('asst.jsonl', [
      {
        type: 'assistant',
        parentUuid: 'u-1',
        isSidechain: false,
        cwd: '/x',
        sessionId: 'sess-1',
        gitBranch: 'main',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Hi' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Read',
              input: { file_path: '/etc/hosts' },
            },
          ],
          stop_reason: 'tool_use',
        },
        requestId: 'req_abc',
        uuid: 'a-1',
        timestamp: '2026-04-29T12:00:01.000Z',
      },
    ])
    const turns = await parseTranscript(p)
    expect(turns).toHaveLength(1)
    const t = turns[0] as AssistantTurn
    expect(t.kind).toBe('assistant')
    expect(t.parentUuid).toBe('u-1')
    expect(t.requestId).toBe('req_abc')
    expect(t.segments).toEqual([
      { type: 'text', text: 'Hi' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/etc/hosts' } },
    ])
  })

  test('tool_use + tool_result roundtrip across two turns', async () => {
    const p = await writeJsonl('roundtrip.jsonl', [
      {
        type: 'assistant',
        parentUuid: 'u-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_42', name: 'Read', input: { file_path: '/a' } },
          ],
        },
        uuid: 'a-1',
        timestamp: '2026-04-29T12:00:00Z',
        sessionId: 's',
      },
      {
        type: 'user',
        parentUuid: 'a-1',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_42', content: 'file contents' },
          ],
        },
        uuid: 'u-2',
        timestamp: '2026-04-29T12:00:01Z',
        sessionId: 's',
      },
    ])
    const turns = await parseTranscript(p)
    expect(turns).toHaveLength(2)
    const a = turns[0] as AssistantTurn
    const u = turns[1] as UserTurn
    expect(a.segments).toEqual([
      { type: 'tool_use', id: 'toolu_42', name: 'Read', input: { file_path: '/a' } },
    ])
    expect(u.segments).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_42', content: 'file contents' },
    ])
  })

  test('all observed meta types map to {kind:meta, type:<original>}', async () => {
    const metas = [
      { type: 'summary', summary: 's', leafUuid: 'l-1', uuid: 'm-summary' },
      { type: 'queue-operation', operationType: 'foo', uuid: 'm-q', timestamp: '2026-04-29T00:00:00Z' },
      { type: 'attachment', attachmentType: 'file', uuid: 'm-a', timestamp: '2026-04-29T00:00:01Z' },
      { type: 'ai-title', title: 't', uuid: 'm-ai', timestamp: '2026-04-29T00:00:02Z' },
      { type: 'last-prompt', prompt: 'p', uuid: 'm-lp', timestamp: '2026-04-29T00:00:03Z' },
      { type: 'file-history-snapshot', files: [], uuid: 'm-fh', timestamp: '2026-04-29T00:00:04Z' },
      { type: 'permission-mode', mode: 'plan', uuid: 'm-pm', timestamp: '2026-04-29T00:00:05Z' },
    ]
    const p = await writeJsonl('meta.jsonl', metas)
    const turns = await parseTranscript(p)
    expect(turns).toHaveLength(metas.length)
    for (let i = 0; i < metas.length; i++) {
      const t = turns[i] as MetaTurn
      expect(t.kind).toBe('meta')
      expect(t.type).toBe(metas[i]!.type)
    }
  })

  test('system record produces SystemTurn with content + level', async () => {
    const p = await writeJsonl('system.jsonl', [
      {
        type: 'system',
        content: 'hello from system',
        level: 'info',
        uuid: 'sys-1',
        timestamp: '2026-04-29T01:00:00Z',
      },
    ])
    const turns = await parseTranscript(p)
    expect(turns).toHaveLength(1)
    const t = turns[0] as SystemTurn
    expect(t.kind).toBe('system')
    expect(t.content).toBe('hello from system')
    expect(t.level).toBe('info')
  })

  test('unknown type warns once and produces RawTurn', async () => {
    const warnSpy = mock(() => {})
    const origWarn = console.warn
    console.warn = warnSpy
    try {
      const p = await writeJsonl('unknown.jsonl', [
        { type: 'unknown-type-xyz', uuid: 'u-x', timestamp: '2026-04-29T00:00:00Z' },
        { type: 'unknown-type-xyz', uuid: 'u-y', timestamp: '2026-04-29T00:00:01Z' },
      ])
      const turns = await parseTranscript(p)
      expect(turns).toHaveLength(2)
      const t0 = turns[0] as RawTurn
      expect(t0.kind).toBe('raw')
      expect(t0.type).toBe('unknown-type-xyz')
      // Warned ONCE for the unique type, even though we had two records.
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      console.warn = origWarn
    }
  })

  test('Agent tool_use captures full input shape', async () => {
    const p = await writeJsonl('agent.jsonl', [
      {
        type: 'assistant',
        parentUuid: 'u-1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_agent_1',
              name: 'Agent',
              input: {
                description: 'foo',
                subagent_type: 'general-purpose',
                prompt: 'do the thing',
              },
            },
          ],
        },
        uuid: 'a-agent',
        timestamp: '2026-04-29T03:00:00Z',
        sessionId: 's',
      },
    ])
    const turns = await parseTranscript(p)
    const a = turns[0] as AssistantTurn
    expect(a.segments).toHaveLength(1)
    const seg = a.segments[0]!
    expect(seg.type).toBe('tool_use')
    if (seg.type === 'tool_use') {
      expect(seg.name).toBe('Agent')
      expect(seg.input).toEqual({
        description: 'foo',
        subagent_type: 'general-purpose',
        prompt: 'do the thing',
      })
    }
  })

  test('malformed lines are skipped, valid lines parse', async () => {
    // We pass raw strings here so we can include a deliberately broken line.
    const p = await writeJsonl('mixed.jsonl', [
      '{not valid json',
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'ok' },
        uuid: 'u-ok',
        timestamp: '2026-04-29T00:00:00Z',
        sessionId: 's',
      }),
      '',  // blank line
      '   ',  // whitespace-only line
    ])
    const turns = await parseTranscript(p)
    expect(turns).toHaveLength(1)
    expect((turns[0] as UserTurn).uuid).toBe('u-ok')
  })

  test('empty content array yields segments: []', async () => {
    const p = await writeJsonl('empty-content.jsonl', [
      {
        type: 'user',
        message: { role: 'user', content: [] },
        uuid: 'u-empty',
        timestamp: '2026-04-29T00:00:00Z',
        sessionId: 's',
      },
    ])
    const turns = await parseTranscript(p)
    expect((turns[0] as UserTurn).segments).toEqual([])
  })

  test('timestamp parsing: ISO -> ms, number -> number, missing -> 0', async () => {
    const p = await writeJsonl('ts.jsonl', [
      { type: 'user', message: { role: 'user', content: 'a' }, uuid: 't1', timestamp: '2026-04-29T00:00:00.000Z', sessionId: 's' },
      { type: 'user', message: { role: 'user', content: 'b' }, uuid: 't2', timestamp: 1234567890, sessionId: 's' },
      { type: 'user', message: { role: 'user', content: 'c' }, uuid: 't3', sessionId: 's' },
    ])
    const turns = await parseTranscript(p)
    expect(turns[0]!.timestamp).toBe(Date.parse('2026-04-29T00:00:00.000Z'))
    expect(turns[1]!.timestamp).toBe(1234567890)
    expect(turns[2]!.timestamp).toBe(0)
  })

  test('isSidechain: true is preserved', async () => {
    const p = await writeJsonl('sidechain.jsonl', [
      {
        type: 'user',
        isSidechain: true,
        parentUuid: 'p',
        message: { role: 'user', content: 'side' },
        uuid: 'u-side',
        timestamp: '2026-04-29T00:00:00Z',
        sessionId: 's',
      },
    ])
    const turns = await parseTranscript(p)
    expect((turns[0] as UserTurn).isSidechain).toBe(true)
  })

  test('unknown segment types within a content array are dropped', async () => {
    const p = await writeJsonl('weird-seg.jsonl', [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'keep me' },
            { type: 'thinking', thinking: 'should be dropped' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x' } },
            // tool_use without `name` -> dropped
            { type: 'tool_use', id: 'toolu_2', input: {} },
            // tool_result without tool_use_id -> dropped
            { type: 'tool_result', content: 'orphan' },
          ],
        },
        uuid: 'a-w',
        timestamp: '2026-04-29T00:00:00Z',
        sessionId: 's',
      },
    ])
    const turns = await parseTranscript(p)
    const a = turns[0] as AssistantTurn
    expect(a.segments).toEqual([
      { type: 'text', text: 'keep me' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x' } },
    ])
  })
})
