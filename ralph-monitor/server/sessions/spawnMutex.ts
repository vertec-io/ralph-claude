// Per-effort async mutex.
//
// Why: prepareSpawn (and downstream the actual spawn) reads "is there
// already a live session for this effort?" and then writes a new row. Two
// concurrent prepareSpawn calls for the same effort would both see "no" and
// both insert, defeating the one-live-session-per-effort invariant. A
// per-effort lock serializes the read+write so the second caller sees the
// row the first inserted.
//
// Why per-effort and not global: spawning is naturally concurrent across
// efforts; a global mutex would let an unrelated slow spawn block every
// other one. The map of effort-id -> chain promise is the cheapest local
// version of "one mutex per key".
//
// Cleanup invariant: the map MUST drain when no contention exists. If we
// kept the entry around forever, a long-running ralph-monitor would
// monotonically leak memory in proportion to the number of distinct efforts
// spawned. The cleanup branch in `withEffortLock` compares the chain
// promise it WAS attached to (`next`) against the map's current entry —
// if a newer caller has chained on top, the entry has been replaced and we
// leave it; if it hasn't, we delete.
//
// Error semantics: the lock chains on BOTH success and failure (the
// `.then(fn, fn)` trick). If the first caller's fn throws, the rejection
// propagates out of THAT call's withEffortLock invocation, but the chain
// itself doesn't poison the next caller — the next .then will still see fn
// run (with the rejection's value as input, ignored).

const locks = new Map<string, Promise<unknown>>()

export async function withEffortLock<T>(
  effortId: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Take the existing chain (or a resolved sentinel if this is the first
  // caller for this effort) and chain `fn` on both branches so a thrown fn
  // from a prior caller doesn't abort the chain.
  const prev = locks.get(effortId) ?? Promise.resolve()
  const next: Promise<T> = prev.then(fn, fn) as Promise<T>

  // Store a swallowed version on the map so the NEXT caller's `.then(fn, fn)`
  // doesn't re-trigger handlers chained off `next`. The original `next`
  // promise (which preserves rejection) is what we return to THIS caller.
  const swallowed: Promise<unknown> = next.catch(() => undefined)
  locks.set(effortId, swallowed)

  // Cleanup. We capture `swallowed` in a closure so the comparison below is
  // identity-stable — if a later caller replaces the map entry with their
  // own chain, `locks.get(effortId)` will not equal our `swallowed` and we
  // skip the delete. (Without the closure capture, a re-fetched value would
  // already be the downstream chain and the equality check would always
  // fail.)
  swallowed.finally(() => {
    if (locks.get(effortId) === swallowed) {
      locks.delete(effortId)
    }
  })

  return next
}

// Test-only: surface the live map for assertion. Tests verify (a) that
// distinct efforts don't share a slot, (b) that the map drains to zero
// after all chains settle.
export const __test__ = {
  size: () => locks.size,
  has: (effortId: string) => locks.has(effortId),
}
