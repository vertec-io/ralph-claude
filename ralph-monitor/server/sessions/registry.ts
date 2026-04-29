// Live PTY handle registry — keyed by session UUID.
//
// Single source of truth for live PTY handles. Downstream stories attach to
// this:
//   - US-005a-2 spawn step:  register() right after pty.spawn() returns,
//                            inside the same lock turn that allocated the
//                            session row, so an external observer never sees
//                            "row alive but no handle" or vice versa.
//   - US-005b WebSocket:    get(sessionId) to attach onData / write.
//   - US-005c ring buffer:  get(sessionId) to wire output capture.
//   - US-016 status badge:  listLiveSessionIds() for the header live-count.
//
// The registry intentionally holds opaque handles. The `PtyHandle` interface
// below is the contract US-005a-2 must implement when it instantiates the
// handle around `bun-pty`'s `IPty` — it covers exactly the surface downstream
// stories need (write/resize/onData/onExit/kill) and nothing more, so the
// indirection lets us swap `bun-pty` for `node-pty` later without rippling
// through every consumer.

export interface PtyHandle {
  readonly sessionId: string
  readonly effortId: string
  readonly pid: number

  // Write a chunk of bytes (or a UTF-8 string) into the PTY's stdin. Throws
  // synchronously if the PTY has already exited; callers must guard against
  // that or be prepared to swallow the error.
  write(data: string | Uint8Array): void

  // Tell the PTY about a new terminal size. Resize events are delivered to
  // the child via SIGWINCH inside the kernel.
  resize(cols: number, rows: number): void

  // Subscribe to output bytes. Returns a disposer; calling it removes the
  // listener. Multiple subscribers are allowed (broadcast); the disposer is
  // idempotent.
  onData(cb: (chunk: Uint8Array) => void): () => void

  // Subscribe to the single exit event. The disposer pattern matches onData
  // for symmetry; callers can ignore the disposer for a one-shot wait.
  onExit(cb: (exit: { exitCode: number; signal?: number }) => void): () => void

  // Send a signal to the PTY child. `signal` accepts either a Node signal
  // string ("SIGTERM") or a numeric POSIX signal. Default is implementation-
  // defined (typically SIGHUP).
  kill(signal?: NodeJS.Signals | number): void
}

// Typed error: thrown by `register()` when a handle for the given sessionId
// already exists. The "synchronous registration invariant" US-005a-2 relies
// on means a duplicate registration is a programming bug, not a contention
// situation — we surface it loud so the caller fixes it rather than masking
// it with a silent overwrite.
export class RegistryCollisionError extends Error {
  override readonly name = 'RegistryCollisionError'
  constructor(sessionId: string) {
    super(`a PTY handle for session ${sessionId} is already registered`)
  }
}

// Module-private map. Keyed by sessionId (UUID). We don't expose this
// directly; all access goes through the typed register/unregister/get
// surface so future bookkeeping (eg. per-effort secondary index, metrics)
// can be added in one place.
const handles = new Map<string, PtyHandle>()

// Register a freshly-spawned PTY handle. MUST be called synchronously after
// pty.spawn() returns and before any await — that's what guarantees a
// concurrent observer either sees "no row + no handle" or "row + handle",
// never the in-between.
export function register(handle: PtyHandle): void {
  if (handles.has(handle.sessionId)) {
    throw new RegistryCollisionError(handle.sessionId)
  }
  handles.set(handle.sessionId, handle)
}

// Remove a handle. Idempotent: removing an already-gone session is a no-op,
// because exit-cleanup paths can race with explicit kill flows and we'd
// rather both succeed than have one of them throw.
export function unregister(sessionId: string): void {
  handles.delete(sessionId)
}

export function get(sessionId: string): PtyHandle | null {
  return handles.get(sessionId) ?? null
}

// Snapshot of every live session id at this instant. Returned as a fresh
// array so callers can mutate it without affecting the registry.
export function listLiveSessionIds(): string[] {
  return [...handles.keys()]
}

// Filter by effortId. Linear scan; the live-handle count is bounded by the
// per-effort mutex (max one per effort) so the worst case is the number of
// active efforts — small enough that an index would be premature.
export function listLiveByEffort(effortId: string): PtyHandle[] {
  const out: PtyHandle[] = []
  for (const h of handles.values()) {
    if (h.effortId === effortId) out.push(h)
  }
  return out
}

// Test-only escape hatch — exposes the internal map size so test suites can
// assert clean shutdown without depending on `listLiveSessionIds().length`
// (which is a subset of the same information but communicates intent
// clearly when used under a `__test__` namespace).
export const __test__ = {
  size: () => handles.size,
  clear: () => handles.clear(),
}
