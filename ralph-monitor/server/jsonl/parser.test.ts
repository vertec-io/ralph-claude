// Unit tests for the JSONL transcript parser.
//
// Each test crafts a temp .jsonl file with a few hand-written records and
// asserts the resulting Turn[] shape. We use the OS temp dir + crypto.randomUUID
// for filename uniqueness (no collisions across parallel test files).

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __resetWarnings,
  parseStream,
  parseTranscript,
  type AssistantTurn,
  type MetaTurn,
  type RawTurn,
  type StreamYield,
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

// ---------------------------------------------------------------------------
// parseStream — streaming variant with offset tracking and partial-record safety
// ---------------------------------------------------------------------------

async function collectStream(
  path: string,
  fromOffset: number,
): Promise<StreamYield[]> {
  const out: StreamYield[] = []
  for await (const item of parseStream(path, fromOffset)) out.push(item)
  return out
}

// Helper: write JSONL `lines` with a trailing newline after the last line.
// (Real Claude transcripts end with `\n`. Tests that need a missing-trailing-
// newline file write the bytes directly via `writeFile`.)
async function writeJsonlWithTrailingNewline(
  name: string,
  lines: unknown[],
): Promise<string> {
  const path = join(tmpDir, name)
  const body = lines
    .map((l) => (typeof l === 'string' ? l : JSON.stringify(l)))
    .join('\n') + '\n'
  await writeFile(path, body)
  return path
}

describe('parseStream', () => {
  test('missing file (ENOENT) yields nothing', async () => {
    const items = await collectStream(join(tmpDir, 'nope.jsonl'), 0)
    expect(items).toEqual([])
  })

  test('empty file yields nothing', async () => {
    const p = join(tmpDir, 'empty.jsonl')
    await writeFile(p, '')
    expect(await collectStream(p, 0)).toEqual([])
  })

  test('fromOffset >= file size yields nothing', async () => {
    const p = await writeJsonlWithTrailingNewline('one.jsonl', [
      {
        type: 'user',
        message: { role: 'user', content: 'a' },
        uuid: 'u-1',
        timestamp: '2026-04-29T00:00:00Z',
        sessionId: 's',
      },
    ])
    const size = (await stat(p)).size
    expect(await collectStream(p, size)).toEqual([])
    expect(await collectStream(p, size + 100)).toEqual([])
  })

  test('three complete records: yields all three with advancing byteOffset, final == file size', async () => {
    const records = [
      { type: 'user', message: { role: 'user', content: 'a' }, uuid: 'u-1', timestamp: '2026-04-29T00:00:00Z', sessionId: 's' },
      { type: 'user', message: { role: 'user', content: 'b' }, uuid: 'u-2', timestamp: '2026-04-29T00:00:01Z', sessionId: 's' },
      { type: 'user', message: { role: 'user', content: 'c' }, uuid: 'u-3', timestamp: '2026-04-29T00:00:02Z', sessionId: 's' },
    ]
    const p = await writeJsonlWithTrailingNewline('three.jsonl', records)
    const size = (await stat(p)).size

    const items = await collectStream(p, 0)
    expect(items).toHaveLength(3)
    expect((items[0]!.turn as UserTurn).uuid).toBe('u-1')
    expect((items[1]!.turn as UserTurn).uuid).toBe('u-2')
    expect((items[2]!.turn as UserTurn).uuid).toBe('u-3')

    // Strictly advancing offsets, final == file size.
    expect(items[0]!.byteOffset).toBeGreaterThan(0)
    expect(items[1]!.byteOffset).toBeGreaterThan(items[0]!.byteOffset)
    expect(items[2]!.byteOffset).toBeGreaterThan(items[1]!.byteOffset)
    expect(items[2]!.byteOffset).toBe(size)

    // The byteOffset of record N equals the cumulative byte length of lines
    // 0..N (each plus its '\n').
    const lineByteLens = records.map(
      (r) => Buffer.byteLength(JSON.stringify(r), 'utf8') + 1,  // +1 for '\n'
    )
    expect(items[0]!.byteOffset).toBe(lineByteLens[0]!)
    expect(items[1]!.byteOffset).toBe(lineByteLens[0]! + lineByteLens[1]!)
    expect(items[2]!.byteOffset).toBe(lineByteLens[0]! + lineByteLens[1]! + lineByteLens[2]!)
  })

  test('resuming from byteOffset of first record skips it and yields the rest', async () => {
    const records = [
      { type: 'user', message: { role: 'user', content: 'a' }, uuid: 'u-1', timestamp: '2026-04-29T00:00:00Z', sessionId: 's' },
      { type: 'user', message: { role: 'user', content: 'b' }, uuid: 'u-2', timestamp: '2026-04-29T00:00:01Z', sessionId: 's' },
      { type: 'user', message: { role: 'user', content: 'c' }, uuid: 'u-3', timestamp: '2026-04-29T00:00:02Z', sessionId: 's' },
    ]
    const p = await writeJsonlWithTrailingNewline('resume.jsonl', records)

    const all = await collectStream(p, 0)
    const after1 = await collectStream(p, all[0]!.byteOffset)
    expect(after1).toHaveLength(2)
    expect((after1[0]!.turn as UserTurn).uuid).toBe('u-2')
    expect((after1[1]!.turn as UserTurn).uuid).toBe('u-3')

    const after2 = await collectStream(p, all[1]!.byteOffset)
    expect(after2).toHaveLength(1)
    expect((after2[0]!.turn as UserTurn).uuid).toBe('u-3')

    const after3 = await collectStream(p, all[2]!.byteOffset)
    expect(after3).toEqual([])
  })

  test('partial trailing record (no newline at EOF) is buffered, not emitted', async () => {
    const r1 = JSON.stringify({ type: 'user', message: { role: 'user', content: 'a' }, uuid: 'u-1', timestamp: '2026-04-29T00:00:00Z', sessionId: 's' })
    const r2 = JSON.stringify({ type: 'user', message: { role: 'user', content: 'b' }, uuid: 'u-2', timestamp: '2026-04-29T00:00:01Z', sessionId: 's' })
    const partial = '{"type":"user","message":{"role":"user","content":"c"},"uuid":"u-3"'  // no closing brace, no '\n'
    const p = join(tmpDir, 'partial.jsonl')
    await writeFile(p, r1 + '\n' + r2 + '\n' + partial)
    const size = (await stat(p)).size

    const items = await collectStream(p, 0)
    expect(items).toHaveLength(2)
    expect((items[0]!.turn as UserTurn).uuid).toBe('u-1')
    expect((items[1]!.turn as UserTurn).uuid).toBe('u-2')

    // Last byteOffset is the end-of-newline of record 2, NOT EOF.
    const expectedAfterR2 = Buffer.byteLength(r1, 'utf8') + 1 + Buffer.byteLength(r2, 'utf8') + 1
    expect(items[1]!.byteOffset).toBe(expectedAfterR2)
    expect(items[1]!.byteOffset).toBeLessThan(size)
  })

  test('resuming after partial → full picks up the third record once the writer flushes', async () => {
    const r1 = JSON.stringify({ type: 'user', message: { role: 'user', content: 'a' }, uuid: 'u-1', timestamp: '2026-04-29T00:00:00Z', sessionId: 's' })
    const r2 = JSON.stringify({ type: 'user', message: { role: 'user', content: 'b' }, uuid: 'u-2', timestamp: '2026-04-29T00:00:01Z', sessionId: 's' })
    const r3Head = '{"type":"user","message":{"role":"user","content":"c"},"uuid":"u-3"'
    const r3Tail = ',"timestamp":"2026-04-29T00:00:02Z","sessionId":"s"}'

    const p = join(tmpDir, 'partial-then-full.jsonl')
    await writeFile(p, r1 + '\n' + r2 + '\n' + r3Head)

    const first = await collectStream(p, 0)
    expect(first).toHaveLength(2)
    const lastOffset = first[1]!.byteOffset

    // Writer flushes the rest of the line and the trailing newline.
    await appendFile(p, r3Tail + '\n')

    const second = await collectStream(p, lastOffset)
    expect(second).toHaveLength(1)
    expect((second[0]!.turn as UserTurn).uuid).toBe('u-3')

    // Final byteOffset equals new file size.
    const size = (await stat(p)).size
    expect(second[0]!.byteOffset).toBe(size)
  })

  test('is_partial: true yields with isPartial=true; replacement record yields with isPartial undefined', async () => {
    // A partial assistant streaming-turn followed by its final non-partial replacement.
    // Same uuid — the renderer in US-009 will use the flag to replace-in-place.
    const partial = {
      type: 'assistant',
      parentUuid: 'u-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial...' }] },
      uuid: 'a-1',
      timestamp: '2026-04-29T00:00:00Z',
      sessionId: 's',
      is_partial: true,
    }
    const final = {
      type: 'assistant',
      parentUuid: 'u-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial then final' }] },
      uuid: 'a-1',
      timestamp: '2026-04-29T00:00:01Z',
      sessionId: 's',
    }
    const p = await writeJsonlWithTrailingNewline('partial-flag.jsonl', [partial, final])

    const items = await collectStream(p, 0)
    expect(items).toHaveLength(2)

    const first = items[0]!.turn as AssistantTurn
    const second = items[1]!.turn as AssistantTurn
    expect(first.uuid).toBe('a-1')
    expect(first.isPartial).toBe(true)
    expect(second.uuid).toBe('a-1')
    expect(second.isPartial).toBeUndefined()

    // byteOffset advances between the two.
    expect(items[1]!.byteOffset).toBeGreaterThan(items[0]!.byteOffset)
  })

  test('isSidechain: true round-trips through parseStream', async () => {
    const p = await writeJsonlWithTrailingNewline('sidechain-stream.jsonl', [
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
    const items = await collectStream(p, 0)
    expect(items).toHaveLength(1)
    expect((items[0]!.turn as UserTurn).isSidechain).toBe(true)
  })

  test('UTF-8 multi-byte content: byteOffset reflects byte length, not character count', async () => {
    // 'café 🎉' has multi-byte codepoints. Record body's UTF-8 length
    // exceeds its character count.
    const record = {
      type: 'user',
      message: { role: 'user', content: 'café 🎉 — héllo wörld' },
      uuid: 'u-utf',
      timestamp: '2026-04-29T00:00:00Z',
      sessionId: 's',
    }
    const line = JSON.stringify(record)
    expect(Buffer.byteLength(line, 'utf8')).toBeGreaterThan(line.length)

    const p = join(tmpDir, 'utf8.jsonl')
    await writeFile(p, line + '\n')
    const size = (await stat(p)).size

    const items = await collectStream(p, 0)
    expect(items).toHaveLength(1)
    expect((items[0]!.turn as UserTurn).segments).toEqual([
      { type: 'text', text: 'café 🎉 — héllo wörld' },
    ])
    // byteOffset uses bytes (not chars) and lands at end-of-file (past the '\n').
    expect(items[0]!.byteOffset).toBe(size)
    expect(items[0]!.byteOffset).toBe(Buffer.byteLength(line, 'utf8') + 1)
  })

  test('UTF-8 codepoint straddling a 64KB chunk boundary decodes correctly', async () => {
    // Forge a file where a 4-byte emoji ('🎉' = F0 9F 8E 89) sits exactly across
    // the 64KB chunk boundary so that a naive string-decode of each chunk
    // would corrupt it.
    const CHUNK = 64 * 1024
    // Pad with 'a' to push the emoji's first byte to position CHUNK-1 of the
    // first chunk read, leaving its remaining 3 bytes in the second chunk.
    // We embed the emoji inside a JSON record; pad the `pad` field of the
    // record so the emoji lands at the boundary byte position.
    const emoji = '🎉'
    const recHead = '{"type":"user","message":{"role":"user","content":"'
    // Tail must close the string, the message obj, then add other required
    // fields and close the record.
    const recTail = '"},"uuid":"u-utf-boundary","timestamp":"2026-04-29T00:00:00Z","sessionId":"s"}'
    const recHeadBytes = Buffer.byteLength(recHead, 'utf8')
    // We want the first byte of the emoji to land at file byte offset CHUNK-1.
    // So pad bytes count = (CHUNK - 1) - recHeadBytes.
    const padCount = (CHUNK - 1) - recHeadBytes
    expect(padCount).toBeGreaterThan(0)
    const pad = 'a'.repeat(padCount)
    const line = recHead + pad + emoji + recTail
    // Sanity: the first byte of the emoji is at offset CHUNK-1 in the line.
    expect(Buffer.byteLength(recHead + pad, 'utf8')).toBe(CHUNK - 1)

    const p = join(tmpDir, 'utf8-boundary.jsonl')
    await writeFile(p, line + '\n')
    const size = (await stat(p)).size

    const items = await collectStream(p, 0)
    expect(items).toHaveLength(1)
    const t = items[0]!.turn as UserTurn
    expect(t.uuid).toBe('u-utf-boundary')
    expect(t.segments).toEqual([{ type: 'text', text: pad + emoji }])
    expect(items[0]!.byteOffset).toBe(size)
  })

  test('blank lines between records advance through silently and do not break offsets', async () => {
    const r1 = JSON.stringify({ type: 'user', message: { role: 'user', content: 'a' }, uuid: 'u-1', timestamp: '2026-04-29T00:00:00Z', sessionId: 's' })
    const r2 = JSON.stringify({ type: 'user', message: { role: 'user', content: 'b' }, uuid: 'u-2', timestamp: '2026-04-29T00:00:01Z', sessionId: 's' })
    const p = join(tmpDir, 'blanks.jsonl')
    await writeFile(p, r1 + '\n\n' + r2 + '\n')
    const size = (await stat(p)).size

    const items = await collectStream(p, 0)
    expect(items).toHaveLength(2)
    expect((items[0]!.turn as UserTurn).uuid).toBe('u-1')
    expect((items[1]!.turn as UserTurn).uuid).toBe('u-2')
    expect(items[1]!.byteOffset).toBe(size)
  })

  test('malformed JSON line is skipped, surrounding records still emitted', async () => {
    const r1 = JSON.stringify({ type: 'user', message: { role: 'user', content: 'a' }, uuid: 'u-1', timestamp: '2026-04-29T00:00:00Z', sessionId: 's' })
    const broken = '{not valid json'
    const r3 = JSON.stringify({ type: 'user', message: { role: 'user', content: 'c' }, uuid: 'u-3', timestamp: '2026-04-29T00:00:02Z', sessionId: 's' })
    const p = join(tmpDir, 'malformed-stream.jsonl')
    await writeFile(p, r1 + '\n' + broken + '\n' + r3 + '\n')

    const items = await collectStream(p, 0)
    expect(items).toHaveLength(2)
    expect((items[0]!.turn as UserTurn).uuid).toBe('u-1')
    expect((items[1]!.turn as UserTurn).uuid).toBe('u-3')
  })
})
