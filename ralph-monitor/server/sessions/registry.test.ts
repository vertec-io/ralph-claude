// Registry tests for the live PTY handle map.

import { afterEach, describe, expect, test } from 'bun:test'
import {
  register,
  unregister,
  get,
  listLiveSessionIds,
  listLiveByEffort,
  RegistryCollisionError,
  __test__ as R,
  type PtyHandle,
} from './registry'
import { RingBuffer } from './ringBuffer'

afterEach(() => R.clear())

function fakeHandle(sessionId: string, effortId: string, pid = 42): PtyHandle {
  return {
    sessionId,
    effortId,
    pid,
    buffer: new RingBuffer(8192),
    exited: false,
    lastExit: null,
    write: () => {},
    resize: () => {},
    onData: () => () => {},
    onExit: () => () => {},
    kill: () => {},
  }
}

describe('registry', () => {
  test('register / get / unregister round-trip', () => {
    const h = fakeHandle('s1', 'e1')
    register(h)
    expect(get('s1')).toBe(h)
    unregister('s1')
    expect(get('s1')).toBeNull()
  })

  test('register throws RegistryCollisionError on duplicate sessionId', () => {
    const h1 = fakeHandle('s-dup', 'e1')
    const h2 = fakeHandle('s-dup', 'e2')
    register(h1)
    expect(() => register(h2)).toThrow(RegistryCollisionError)
    // First handle is still the one in place — register is NOT a silent overwrite.
    expect(get('s-dup')).toBe(h1)
  })

  test('unregister is idempotent', () => {
    expect(() => unregister('never-registered')).not.toThrow()
    register(fakeHandle('s2', 'e1'))
    unregister('s2')
    expect(() => unregister('s2')).not.toThrow()
  })

  test('listLiveSessionIds returns a fresh array snapshot', () => {
    register(fakeHandle('s3', 'e1'))
    register(fakeHandle('s4', 'e2'))
    const a = listLiveSessionIds().sort()
    expect(a).toEqual(['s3', 's4'])
    // Mutating the returned array does not affect the registry.
    a.push('mutation')
    expect(listLiveSessionIds().sort()).toEqual(['s3', 's4'])
  })

  test('listLiveByEffort filters by effortId', () => {
    const h1 = fakeHandle('s5', 'e-A')
    const h2 = fakeHandle('s6', 'e-A')
    const h3 = fakeHandle('s7', 'e-B')
    register(h1)
    register(h2)
    register(h3)
    const a = listLiveByEffort('e-A').map((h) => h.sessionId).sort()
    expect(a).toEqual(['s5', 's6'])
    const b = listLiveByEffort('e-B').map((h) => h.sessionId)
    expect(b).toEqual(['s7'])
    const none = listLiveByEffort('e-Z')
    expect(none).toEqual([])
  })

  test('get returns null for unknown sessionId', () => {
    expect(get('does-not-exist')).toBeNull()
  })
})
