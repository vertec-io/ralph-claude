// Tests for computeSessionStatus (US-006).
//
// computeSessionStatus is pure-derived from (a) registry presence + (b) the
// DB row's process_pid. We construct minimal Session objects in-memory and
// flip the registry state via register/unregister; no DB or PTY needed.

import { afterEach, describe, expect, test } from 'bun:test'
import { register, unregister, __test__ as registryTest } from './registry'
import { RingBuffer } from './ringBuffer'
import { computeSessionStatus } from './status'
import type { Session } from '../db/sessions'
import type { PtyHandle } from './registry'

afterEach(() => {
  // Always end with a clean registry — these tests share the process-global
  // singleton with any concurrent test files run in the same Bun test run.
  registryTest.clear()
})

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: crypto.randomUUID(),
    effort_id: 'effort-1',
    working_dir: null,
    jsonl_path: '/tmp/fake.jsonl',
    title: null,
    mode: 'autonomous',
    process_pid: null,
    process_started_at: null,
    last_activity_at: null,
    created_at: Date.now(),
    archived: false,
    ...overrides,
  }
}

function fakeHandle(sessionId: string, opts: { exited?: boolean } = {}): PtyHandle {
  return {
    sessionId,
    effortId: 'effort-1',
    pid: 999,
    buffer: new RingBuffer(1024),
    exited: opts.exited ?? false,
    lastExit: opts.exited ? { exitCode: 0 } : null,
    write: () => {},
    resize: () => {},
    onData: () => () => {},
    onExit: () => () => {},
    kill: () => {},
  }
}

describe('computeSessionStatus', () => {
  test('registry has live entry, exited=false -> live-attached', () => {
    const session = fakeSession({ process_pid: 12345 })
    register(fakeHandle(session.id, { exited: false }))
    try {
      expect(computeSessionStatus(session)).toBe('live-attached')
    } finally {
      unregister(session.id)
    }
  })

  test('registry has entry, exited=true -> exited (post-PTY-exit grace window)', () => {
    const session = fakeSession({ process_pid: null })
    register(fakeHandle(session.id, { exited: true }))
    try {
      expect(computeSessionStatus(session)).toBe('exited')
    } finally {
      unregister(session.id)
    }
  })

  test('no registry entry, process_pid=null -> dormant', () => {
    const session = fakeSession({ process_pid: null })
    expect(computeSessionStatus(session)).toBe('dormant')
  })

  test('no registry entry, process_pid=12345 -> live-orphaned', () => {
    const session = fakeSession({ process_pid: 12345 })
    expect(computeSessionStatus(session)).toBe('live-orphaned')
  })

  test('registry takes precedence over process_pid (registry+pid both present -> live-attached)', () => {
    // Sanity: if the DB row has a pid AND the registry has a handle, status
    // is live-attached, not live-orphaned. Registry presence wins.
    const session = fakeSession({ process_pid: 12345 })
    register(fakeHandle(session.id, { exited: false }))
    try {
      expect(computeSessionStatus(session)).toBe('live-attached')
    } finally {
      unregister(session.id)
    }
  })
})
