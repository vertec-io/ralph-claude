// Live PTY handle registry — keyed by session UUID.
//
// Single source of truth for live PTY handles. Used by the spawn step to
// register handles, by the WebSocket bridge to attach onData / write, by the
// ring buffer to capture replay bytes, and by status surfaces (header
// live-count, sidebar live-pulse) for "what's running right now".

import type { RingBuffer } from './ringBuffer'

export interface PtyHandle {
  readonly sessionId: string
  readonly projectId: string
  readonly pid: number

  readonly buffer: RingBuffer

  exited: boolean
  lastExit: { exitCode: number; signal?: number } | null

  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  onData(cb: (chunk: Uint8Array) => void): () => void
  onExit(cb: (exit: { exitCode: number; signal?: number }) => void): () => void
  kill(signal?: NodeJS.Signals | number): void
}

export class RegistryCollisionError extends Error {
  override readonly name = 'RegistryCollisionError'
  constructor(sessionId: string) {
    super(`a PTY handle for session ${sessionId} is already registered`)
  }
}

const handles = new Map<string, PtyHandle>()

export function register(handle: PtyHandle): void {
  if (handles.has(handle.sessionId)) {
    throw new RegistryCollisionError(handle.sessionId)
  }
  handles.set(handle.sessionId, handle)
}

export function unregister(sessionId: string): void {
  handles.delete(sessionId)
}

export function get(sessionId: string): PtyHandle | null {
  return handles.get(sessionId) ?? null
}

export function listLiveSessionIds(): string[] {
  return [...handles.keys()]
}

export function listLiveByProject(projectId: string): PtyHandle[] {
  const out: PtyHandle[] = []
  for (const h of handles.values()) {
    if (h.projectId === projectId) out.push(h)
  }
  return out
}

export const __test__ = {
  size: () => handles.size,
  clear: () => handles.clear(),
}
