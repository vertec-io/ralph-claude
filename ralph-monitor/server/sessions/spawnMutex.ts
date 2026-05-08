// Per-project async mutex.
//
// Serializes spawn/resume calls within the same project so concurrent callers
// don't race on the row insert. Across distinct projects, calls run in
// parallel (no global blocking).
//
// Cleanup invariant: the map drains when no contention exists. The cleanup
// branch in `withProjectLock` compares the chain promise it WAS attached to
// against the map's current entry — if a newer caller has chained on top, the
// entry has been replaced and we leave it; if it hasn't, we delete.

const locks = new Map<string, Promise<unknown>>()

export async function withProjectLock<T>(
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(projectId) ?? Promise.resolve()
  const next: Promise<T> = prev.then(fn, fn) as Promise<T>

  const swallowed: Promise<unknown> = next.catch(() => undefined)
  locks.set(projectId, swallowed)

  swallowed.finally(() => {
    if (locks.get(projectId) === swallowed) {
      locks.delete(projectId)
    }
  })

  return next
}

export const __test__ = {
  size: () => locks.size,
  has: (projectId: string) => locks.has(projectId),
}
