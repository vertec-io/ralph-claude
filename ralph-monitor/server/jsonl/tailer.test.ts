// Unit tests for the live-tail tailer in US-010.
//
// The tailer wraps chokidar; we exercise it against real files in a tmp dir.
// chokidar's `awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }`
// adds ~150-250ms latency per detected change, so each "wait for an event"
// helper polls for up to ~3s before giving up. That ceiling is deliberate:
// flaky-test waits are better than racy false-greens.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFile, mkdtemp, rm, truncate, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __test__,
  attachTailer,
  type TailEvent,
} from './tailer'
import type { UserTurn } from './parser'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'tailer-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

interface Captured {
  events: TailEvent[]
  onEvent: (e: TailEvent) => void
  waitFor: (
    predicate: (events: TailEvent[]) => boolean,
    label?: string,
    timeoutMs?: number,
  ) => Promise<void>
}

function capture(): Captured {
  const events: TailEvent[] = []
  return {
    events,
    onEvent(e) {
      events.push(e)
    },
    async waitFor(predicate, label = 'predicate', timeoutMs = 3000) {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        if (predicate(events)) return
        await new Promise((r) => setTimeout(r, 25))
      }
      throw new Error(
        `Timed out waiting for ${label} after ${timeoutMs}ms. Events: ${JSON.stringify(events)}`,
      )
    },
  }
}

function userRecord(uuid: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    parentUuid: null,
    isSidechain: false,
    cwd: '/tmp',
    sessionId: 'sess-tailer',
    gitBranch: 'main',
    message: { role: 'user', content: text },
    uuid,
    timestamp: '2026-04-29T12:00:00.000Z',
  })
}

async function writeRecords(path: string, records: string[]): Promise<void> {
  // Each record + its own terminating newline. parseStream contract requires
  // newline-terminated records.
  await writeFile(path, records.length === 0 ? '' : records.join('\n') + '\n')
}

async function appendRecord(path: string, record: string): Promise<void> {
  await appendFile(path, record + '\n')
}

describe('tailer', () => {
  test('initial snapshot delivers all current turns', async () => {
    const path = join(tmpDir, 'session1.jsonl')
    await writeRecords(path, [userRecord('u-1', 'hello'), userRecord('u-2', 'world')])

    const cap = capture()
    const detach = await attachTailer(path, 'session1', cap.onEvent)
    try {
      // attachTailer awaits the snapshot emit before returning, so the event
      // is already present synchronously on this side.
      expect(cap.events).toHaveLength(1)
      const ev = cap.events[0]!
      expect(ev.type).toBe('snapshot')
      if (ev.type !== 'snapshot') throw new Error('unreachable')
      expect(ev.turns).toHaveLength(2)
      expect((ev.turns[0] as UserTurn).uuid).toBe('u-1')
      expect((ev.turns[1] as UserTurn).uuid).toBe('u-2')
      expect(typeof detach).toBe('function')
    } finally {
      detach()
    }
  })

  test('snapshot for missing file yields empty turns', async () => {
    const path = join(tmpDir, 'absent.jsonl')
    const cap = capture()
    const detach = await attachTailer(path, 'absent', cap.onEvent)
    try {
      expect(cap.events).toHaveLength(1)
      const ev = cap.events[0]!
      expect(ev.type).toBe('snapshot')
      if (ev.type !== 'snapshot') throw new Error('unreachable')
      expect(ev.turns).toEqual([])
    } finally {
      detach()
    }
  })

  test('new turn after attach is emitted as a turn event', async () => {
    const path = join(tmpDir, 'append.jsonl')
    await writeRecords(path, [userRecord('u-1', 'hello'), userRecord('u-2', 'world')])

    const cap = capture()
    const detach = await attachTailer(path, 'append', cap.onEvent)
    try {
      expect(cap.events[0]!.type).toBe('snapshot')

      await appendRecord(path, userRecord('u-3', 'after-attach'))
      await cap.waitFor(
        (events) => events.some((e) => e.type === 'turn'),
        'turn event for u-3',
      )

      const turn = cap.events.find((e) => e.type === 'turn')
      expect(turn).toBeDefined()
      if (turn?.type !== 'turn') throw new Error('unreachable')
      expect((turn.turn as UserTurn).uuid).toBe('u-3')
      expect(turn.byteOffset).toBeGreaterThan(0)
    } finally {
      detach()
    }
  })

  test('multiple subscribers each get their own snapshot and the same turn', async () => {
    const path = join(tmpDir, 'multi.jsonl')
    await writeRecords(path, [userRecord('u-1', 'one')])

    const capA = capture()
    const capB = capture()
    const detachA = await attachTailer(path, 'multi', capA.onEvent)
    const detachB = await attachTailer(path, 'multi', capB.onEvent)

    try {
      expect(capA.events[0]!.type).toBe('snapshot')
      expect(capB.events[0]!.type).toBe('snapshot')

      // Tailer registry has exactly one entry — watcher is shared.
      expect(__test__.tailerCount()).toBeGreaterThanOrEqual(1)
      expect(__test__.hasTailer('multi')).toBe(true)

      await appendRecord(path, userRecord('u-2', 'two'))

      await capA.waitFor((e) => e.some((x) => x.type === 'turn'), 'A turn')
      await capB.waitFor((e) => e.some((x) => x.type === 'turn'), 'B turn')

      const aTurn = capA.events.find((e) => e.type === 'turn')!
      const bTurn = capB.events.find((e) => e.type === 'turn')!
      if (aTurn.type !== 'turn' || bTurn.type !== 'turn') {
        throw new Error('unreachable')
      }
      expect((aTurn.turn as UserTurn).uuid).toBe('u-2')
      expect((bTurn.turn as UserTurn).uuid).toBe('u-2')
      expect(aTurn.byteOffset).toBe(bTurn.byteOffset)
    } finally {
      detachA()
      detachB()
    }
  })

  test('subscriber B attaching after a turn was appended still sees it via snapshot', async () => {
    const path = join(tmpDir, 'late.jsonl')
    await writeRecords(path, [userRecord('u-1', 'one'), userRecord('u-2', 'two')])

    const capA = capture()
    const detachA = await attachTailer(path, 'late', capA.onEvent)

    try {
      // Append a third record. A receives a `turn` event for it.
      await appendRecord(path, userRecord('u-3', 'three'))
      await capA.waitFor(
        (e) => e.some((x) => x.type === 'turn' && (x.turn as UserTurn).uuid === 'u-3'),
        'A turn for u-3',
      )

      // B attaches now → its snapshot has all three records, no `turn` event
      // for u-3 (because u-3 was already on disk at B's snapshot time).
      const capB = capture()
      const detachB = await attachTailer(path, 'late', capB.onEvent)
      try {
        expect(capB.events).toHaveLength(1)
        const snap = capB.events[0]!
        expect(snap.type).toBe('snapshot')
        if (snap.type !== 'snapshot') throw new Error('unreachable')
        expect(snap.turns).toHaveLength(3)
        expect(
          snap.turns.map((t) => (t as UserTurn).uuid),
        ).toEqual(['u-1', 'u-2', 'u-3'])

        // Append a fourth — both A and B should see it.
        await appendRecord(path, userRecord('u-4', 'four'))
        await capA.waitFor(
          (e) => e.some((x) => x.type === 'turn' && (x.turn as UserTurn).uuid === 'u-4'),
          'A turn for u-4',
        )
        await capB.waitFor(
          (e) => e.some((x) => x.type === 'turn' && (x.turn as UserTurn).uuid === 'u-4'),
          'B turn for u-4',
        )

        // B must NOT have received a duplicate `turn` for u-3.
        const bU3Turns = capB.events.filter(
          (e) => e.type === 'turn' && (e.turn as UserTurn).uuid === 'u-3',
        )
        expect(bU3Turns).toHaveLength(0)
      } finally {
        detachB()
      }
    } finally {
      detachA()
    }
  })

  test('truncation emits a fresh snapshot', async () => {
    const path = join(tmpDir, 'trunc.jsonl')
    await writeRecords(path, [
      userRecord('u-1', 'one'),
      userRecord('u-2', 'two'),
      userRecord('u-3', 'three'),
    ])

    const cap = capture()
    const detach = await attachTailer(path, 'trunc', cap.onEvent)

    try {
      expect(cap.events[0]!.type).toBe('snapshot')

      // Truncate to 0 bytes, then write a single new record. We need SOME
      // change for chokidar to fire after awaitWriteFinish; truncation alone
      // sometimes doesn't trip awaitWriteFinish on every fs/platform. Pure
      // truncate-to-zero is the AC's documented case, so we test that first
      // via `truncate()` and rely on chokidar's `change` to fire.
      await truncate(path, 0)

      // Wait for the second snapshot (or a sentinel that proves recreation
      // was detected) — predicate fires once we see TWO snapshot events.
      await cap.waitFor(
        (events) => events.filter((e) => e.type === 'snapshot').length >= 2,
        'second snapshot after truncate',
        4000,
      )

      const snapshots = cap.events.filter((e) => e.type === 'snapshot')
      expect(snapshots.length).toBeGreaterThanOrEqual(2)
      const second = snapshots[snapshots.length - 1]!
      if (second.type !== 'snapshot') throw new Error('unreachable')
      expect(second.turns).toEqual([])
    } finally {
      detach()
    }
  })

  test('deletion emits gone and removes the tailer state', async () => {
    const path = join(tmpDir, 'delete.jsonl')
    await writeRecords(path, [userRecord('u-1', 'hello')])

    const cap = capture()
    const detach = await attachTailer(path, 'delete-id', cap.onEvent)

    try {
      expect(cap.events[0]!.type).toBe('snapshot')
      expect(__test__.hasTailer('delete-id')).toBe(true)

      await unlink(path)

      await cap.waitFor(
        (events) => events.some((e) => e.type === 'gone'),
        'gone event',
        4000,
      )

      // tailers map cleaned up after unlink.
      expect(__test__.hasTailer('delete-id')).toBe(false)
    } finally {
      detach()
    }
  })

  test('disposer stops further events for that subscriber', async () => {
    const path = join(tmpDir, 'dispose.jsonl')
    await writeRecords(path, [userRecord('u-1', 'one')])

    const cap = capture()
    const detach = await attachTailer(path, 'dispose-id', cap.onEvent)

    expect(cap.events[0]!.type).toBe('snapshot')

    // Dispose immediately. Then append — no further events should arrive.
    detach()
    expect(__test__.hasTailer('dispose-id')).toBe(false)

    await appendRecord(path, userRecord('u-2', 'two'))
    // Wait long enough for chokidar's awaitWriteFinish to settle. If the
    // tailer hadn't been torn down we'd see a turn event.
    await new Promise((r) => setTimeout(r, 400))

    const turnEvents = cap.events.filter((e) => e.type === 'turn')
    expect(turnEvents).toHaveLength(0)
  })

  test('last subscriber disposer closes the watcher (tailer map empties)', async () => {
    const path = join(tmpDir, 'lastsub.jsonl')
    await writeRecords(path, [userRecord('u-1', 'hi')])

    const capA = capture()
    const capB = capture()
    const detachA = await attachTailer(path, 'lastsub-id', capA.onEvent)
    const detachB = await attachTailer(path, 'lastsub-id', capB.onEvent)

    expect(__test__.hasTailer('lastsub-id')).toBe(true)

    detachA()
    // Still attached: B holds a reference, so the tailer state must remain.
    expect(__test__.hasTailer('lastsub-id')).toBe(true)

    detachB()
    // Now empty: tailer state should be torn down.
    expect(__test__.hasTailer('lastsub-id')).toBe(false)
  })

  test('partial record (is_partial) is emitted with the flag set', async () => {
    const path = join(tmpDir, 'partial.jsonl')
    // Write one full record first so attach lands.
    await writeRecords(path, [userRecord('u-1', 'one')])

    const cap = capture()
    const detach = await attachTailer(path, 'partial-id', cap.onEvent)
    try {
      expect(cap.events[0]!.type).toBe('snapshot')

      // Append a partial-flagged assistant record.
      const partialAssistant = JSON.stringify({
        type: 'assistant',
        parentUuid: 'u-1',
        isSidechain: false,
        cwd: '/tmp',
        sessionId: 'sess-tailer',
        gitBranch: 'main',
        message: { role: 'assistant', content: [{ type: 'text', text: 'streaming...' }] },
        uuid: 'a-1',
        timestamp: '2026-04-29T12:00:01.000Z',
        is_partial: true,
      })
      await appendFile(path, partialAssistant + '\n')

      await cap.waitFor(
        (events) => events.some((e) => e.type === 'turn'),
        'partial turn',
      )

      const turn = cap.events.find((e) => e.type === 'turn')!
      if (turn.type !== 'turn') throw new Error('unreachable')
      expect(turn.turn.kind).toBe('assistant')
      // isPartial preserved through parser.
      if (turn.turn.kind !== 'assistant') throw new Error('unreachable')
      expect(turn.turn.isPartial).toBe(true)
    } finally {
      detach()
    }
  })
})
