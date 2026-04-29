// Bounded byte ring buffer — US-005c.
//
// Stores up to `capacity` bytes of PTY output so a WS client that attaches
// AFTER the PTY has been streaming sees the recent history on connect (the
// "replay" frame). Implementation is a list of Uint8Array chunks plus a
// running byte count; on append we evict from the head until total bytes
// fit. No allocation per byte — appends amortize O(chunk_size).
//
// The buffer is bounded by BYTES, not by chunk count. A single chunk LARGER
// than `capacity` is partially-dropped (we keep its tail) so the invariant
// "snapshot has at most `capacity` bytes" always holds.
//
// `snapshot()` allocates a fresh Uint8Array; the caller may mutate it
// without affecting the ring (no aliasing into the internal chunks).

export class RingBuffer {
  private chunks: Uint8Array[] = []
  private size = 0

  constructor(public readonly capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(`RingBuffer capacity must be positive (got ${capacity})`)
    }
  }

  // Append a chunk. Empty chunks are no-ops. Drops oldest bytes (possibly
  // splitting the head chunk) to keep total <= capacity. Time: O(k) where k
  // is the number of head chunks evicted (typically 0 or 1).
  append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return
    this.chunks.push(chunk)
    this.size += chunk.byteLength

    while (this.size > this.capacity && this.chunks.length > 0) {
      const head = this.chunks[0]!
      if (this.size - head.byteLength >= this.capacity) {
        // Dropping the entire head still leaves us at >= capacity, so drop
        // it whole and loop. (Includes the boundary case where dropping
        // exactly equals capacity — fine, while-loop terminates next iter.)
        this.size -= head.byteLength
        this.chunks.shift()
      } else {
        // Partial drop within the head chunk. We compute the overshoot and
        // slice the head into a tail subarray. `subarray` shares the
        // underlying ArrayBuffer (no copy); the original head chunk is no
        // longer referenced from `chunks` so it's eligible for GC modulo
        // the shared buffer being kept alive by the subarray view. That's
        // fine for steady-state — old buffers stay alive only as long as
        // their tails sit in the ring.
        const overshoot = this.size - this.capacity
        this.chunks[0] = head.subarray(overshoot)
        this.size -= overshoot
      }
    }
  }

  // Return a freshly-allocated Uint8Array with all current bytes. The
  // caller may mutate it without affecting the ring.
  snapshot(): Uint8Array {
    if (this.size === 0) return new Uint8Array(0)
    const out = new Uint8Array(this.size)
    let offset = 0
    for (const c of this.chunks) {
      out.set(c, offset)
      offset += c.byteLength
    }
    return out
  }

  // Drop all buffered bytes. Used by spawnSession's grace-period timeout to
  // GC the buffer proactively before unregistering the handle.
  clear(): void {
    this.chunks = []
    this.size = 0
  }

  // Current number of buffered bytes (0..capacity).
  byteLength(): number {
    return this.size
  }
}
