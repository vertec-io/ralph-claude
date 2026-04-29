// Mutex tests for the per-effort spawn lock.
//
// Coverage:
//   - same-effort serialization (timing-based: 50ms gap)
//   - cross-effort concurrency (timing-based: ~10ms gap)
//   - thrown-fn does not poison the lock for the next caller
//   - map drains to zero after all chains settle

import { describe, expect, test } from 'bun:test'
import { withEffortLock, __test__ as M } from './spawnMutex'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('withEffortLock', () => {
  test('serializes two concurrent calls for the same effort', async () => {
    M.size() // touch to satisfy lint; not asserted yet
    const e = `effort-serialize-${crypto.randomUUID()}`
    const stamps: number[] = []

    const a = withEffortLock(e, async () => {
      const start = Date.now()
      await sleep(50)
      stamps.push(start)
      stamps.push(Date.now())
      return 'a'
    })
    const b = withEffortLock(e, async () => {
      const start = Date.now()
      await sleep(20)
      stamps.push(start)
      stamps.push(Date.now())
      return 'b'
    })

    const results = await Promise.all([a, b])
    expect(results).toEqual(['a', 'b'])

    // a-start, a-end, b-start, b-end (in order). Critical assertion: b-start
    // must be at-or-after a-end (i.e., b waited for a to complete).
    const [aStart, aEnd, bStart, bEnd] = stamps
    expect(aEnd - aStart).toBeGreaterThanOrEqual(40) // >= ~50ms allowing jitter
    expect(bStart).toBeGreaterThanOrEqual(aEnd - 1) // strictly serialized (-1 for clock skew)
    expect(bEnd).toBeGreaterThanOrEqual(bStart + 15)
  })

  test('does NOT serialize calls for different effort ids', async () => {
    const e1 = `effort-parallel-1-${crypto.randomUUID()}`
    const e2 = `effort-parallel-2-${crypto.randomUUID()}`

    const t0 = Date.now()
    const a = withEffortLock(e1, async () => {
      await sleep(50)
      return Date.now()
    })
    const b = withEffortLock(e2, async () => {
      await sleep(50)
      return Date.now()
    })
    const [aEnd, bEnd] = await Promise.all([a, b])
    // Both finish near t0+50; the gap between them should be <20ms (allowing
    // for scheduler jitter on a loaded test runner). If they were serialized
    // the gap would be >=50ms.
    expect(Math.abs(aEnd - bEnd)).toBeLessThan(20)
    expect(aEnd - t0).toBeLessThan(80)
    expect(bEnd - t0).toBeLessThan(80)
  })

  test('a thrown fn propagates out but does not poison the chain', async () => {
    const e = `effort-throw-${crypto.randomUUID()}`

    const a = withEffortLock(e, async () => {
      await sleep(10)
      throw new Error('boom')
    })
    const b = withEffortLock(e, async () => {
      await sleep(10)
      return 'survived'
    })

    await expect(a).rejects.toThrow('boom')
    await expect(b).resolves.toBe('survived')
  })

  test('map drains to zero after chains settle', async () => {
    // Sample several distinct efforts, run a short fn under each, wait for
    // them all to settle, then check the map. Allow a microtask tick for
    // the .finally cleanup callback to run.
    const efforts = Array.from({ length: 5 }, (_, i) => `effort-drain-${i}-${crypto.randomUUID()}`)

    const sizeDuring = await Promise.all(
      efforts.map((e) =>
        withEffortLock(e, async () => {
          // Non-zero size while running.
          return M.size()
        }),
      ),
    )
    // While the chains were running, the map had to hold an entry for at
    // least the running effort; size should be >=1 for each.
    for (const s of sizeDuring) expect(s).toBeGreaterThanOrEqual(1)

    // Drain. The .finally cleanup is async, so wait one microtask + a sleep
    // to ensure it has all run.
    await sleep(10)
    expect(M.size()).toBe(0)
  })

  test('a chain that has more work queued is NOT prematurely deleted', async () => {
    const e = `effort-no-premature-delete-${crypto.randomUUID()}`

    let aDone = false
    const a = withEffortLock(e, async () => {
      await sleep(30)
      aDone = true
      return 'a'
    })
    // Queue b WHILE a is still running. The map entry must still reference
    // b's chain (or the swallowed wrapper) when a finishes — if the cleanup
    // wrongly compared against a re-fetched value it could delete b's slot.
    const b = withEffortLock(e, async () => {
      expect(aDone).toBe(true) // serialized after a
      await sleep(10)
      return 'b'
    })

    const r = await Promise.all([a, b])
    expect(r).toEqual(['a', 'b'])

    await sleep(10)
    expect(M.size()).toBe(0)
  })
})
