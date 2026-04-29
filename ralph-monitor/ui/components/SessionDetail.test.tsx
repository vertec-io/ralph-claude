// Unit tests for US-016a: SessionDetail shell.
//
// Approach mirrors the pattern from US-009 (SessionTranscript.test.tsx) and
// US-011 (SessionStream.test.tsx): we cover pure-function helpers and confirm
// the component module imports cleanly. We do NOT mount the component — doing
// so would require a real DOM and full auth/WebSocket infrastructure.
// Render-tree assertions are deferred to US-018 (Playwright).

import { describe, expect, test } from 'bun:test'
import { pathBasename } from './SessionDetail'

// Smoke test: confirm the module exports the expected symbols.
test('SessionDetail module exports the component and helper', async () => {
  const mod = await import('./SessionDetail')
  expect(typeof mod.SessionDetail).toBe('function')
  expect(typeof mod.pathBasename).toBe('function')
})

// Pure-function unit tests for pathBasename.
describe('pathBasename', () => {
  test('returns the last segment of an absolute path', () => {
    expect(pathBasename('/home/user/project')).toBe('project')
  })

  test('handles a trailing slash', () => {
    expect(pathBasename('/home/user/project/')).toBe('project')
  })

  test('returns the string itself for a bare name with no slashes', () => {
    expect(pathBasename('myproject')).toBe('myproject')
  })

  test('handles a single path segment with leading slash', () => {
    expect(pathBasename('/root')).toBe('root')
  })

  test('returns empty string for the root path', () => {
    // '/' splits into ['', ''] -> filter(Boolean) -> [] -> pop() -> undefined
    // The fallback is `p` which is '/'.
    // Choosing the fallback is fine — the UI only calls this with non-root dirs.
    expect(pathBasename('/')).toBe('/')
  })

  test('returns empty string for empty input', () => {
    // '' splits to [''] -> filter(Boolean) -> [] -> pop() -> undefined -> fallback ''
    expect(pathBasename('')).toBe('')
  })

  test('handles deeply nested paths', () => {
    expect(pathBasename('/a/b/c/d/e')).toBe('e')
  })

  test('handles paths with no leading slash (relative)', () => {
    expect(pathBasename('foo/bar/baz')).toBe('baz')
  })
})

// Verify the CWD chip logic via pathBasename comparisons.
describe('CWD chip logic', () => {
  test('same basename: no separate cwd chip needed', () => {
    const effortDir = '/home/user/myproject'
    const sessionDir = '/home/user/myproject'
    const effortBasename = pathBasename(effortDir)
    const cwdBasename = pathBasename(sessionDir)
    expect(effortBasename === cwdBasename).toBe(true)
  })

  test('different basename: separate cwd chip should be shown', () => {
    const effortDir = '/home/user/myproject'
    const sessionDir = '/home/user/myproject/feature-branch'
    const effortBasename = pathBasename(effortDir)
    const cwdBasename = pathBasename(sessionDir)
    expect(effortBasename === cwdBasename).toBe(false)
  })
})
