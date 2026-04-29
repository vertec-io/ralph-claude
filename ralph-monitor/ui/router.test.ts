// Pure-function tests for ui/router.ts (US-014c).
//
// Coverage:
//   parseSelection  — all permutations of hash formats + edge cases
//   buildSelectionUrl — serialisation + round-trips

import { describe, expect, test } from 'bun:test'
import { parseSelection, buildSelectionUrl } from './router'

describe('parseSelection', () => {
  test('empty string → all null', () => {
    const s = parseSelection('')
    expect(s.projectId).toBeNull()
    expect(s.effortId).toBeNull()
    expect(s.sessionId).toBeNull()
  })

  test('bare hash → all null', () => {
    const s = parseSelection('#')
    expect(s.projectId).toBeNull()
    expect(s.effortId).toBeNull()
    expect(s.sessionId).toBeNull()
  })

  test('#/ → all null', () => {
    const s = parseSelection('#/')
    expect(s.projectId).toBeNull()
    expect(s.effortId).toBeNull()
    expect(s.sessionId).toBeNull()
  })

  test('unrecognised hash → all null', () => {
    const s = parseSelection('#/foo/bar')
    expect(s.projectId).toBeNull()
    expect(s.effortId).toBeNull()
    expect(s.sessionId).toBeNull()
  })

  test('#/p/abc → projectId only', () => {
    const s = parseSelection('#/p/abc')
    expect(s.projectId).toBe('abc')
    expect(s.effortId).toBeNull()
    expect(s.sessionId).toBeNull()
  })

  test('/p/abc (no leading #) → projectId only', () => {
    // The function accepts both forms.
    const s = parseSelection('/p/abc')
    expect(s.projectId).toBe('abc')
    expect(s.effortId).toBeNull()
    expect(s.sessionId).toBeNull()
  })

  test('#/p/abc/e/def → projectId + effortId', () => {
    const s = parseSelection('#/p/abc/e/def')
    expect(s.projectId).toBe('abc')
    expect(s.effortId).toBe('def')
    expect(s.sessionId).toBeNull()
  })

  test('#/p/abc/e/def/s/ghi → all three', () => {
    const s = parseSelection('#/p/abc/e/def/s/ghi')
    expect(s.projectId).toBe('abc')
    expect(s.effortId).toBe('def')
    expect(s.sessionId).toBe('ghi')
  })

  test('UUID-shaped ids are parsed correctly', () => {
    const s = parseSelection('#/p/b6d1a3f2-0ee4-4c1b-abc0-1234567890ab/e/eff0ef01/s/sess0001')
    expect(s.projectId).toBe('b6d1a3f2-0ee4-4c1b-abc0-1234567890ab')
    expect(s.effortId).toBe('eff0ef01')
    expect(s.sessionId).toBe('sess0001')
  })

  test('trailing slash is tolerated', () => {
    const s = parseSelection('#/p/abc/')
    expect(s.projectId).toBe('abc')
  })
})

describe('buildSelectionUrl', () => {
  test('null projectId → #/', () => {
    expect(buildSelectionUrl({ projectId: null, effortId: null, sessionId: null })).toBe('#/')
  })

  test('projectId only → #/p/:id', () => {
    expect(buildSelectionUrl({ projectId: 'abc', effortId: null, sessionId: null })).toBe('#/p/abc')
  })

  test('projectId + effortId → #/p/:pid/e/:eid', () => {
    expect(buildSelectionUrl({ projectId: 'abc', effortId: 'def', sessionId: null })).toBe('#/p/abc/e/def')
  })

  test('all three → full path', () => {
    expect(buildSelectionUrl({ projectId: 'abc', effortId: 'def', sessionId: 'ghi' })).toBe('#/p/abc/e/def/s/ghi')
  })

  test('sessionId without effortId → effortId not included', () => {
    // Edge case: if effortId is null but sessionId is set, sessionId is ignored
    // (because the path format requires effortId before sessionId).
    const url = buildSelectionUrl({ projectId: 'abc', effortId: null, sessionId: 'ghi' })
    expect(url).toBe('#/p/abc')
  })
})

describe('round-trips', () => {
  test('project only', () => {
    const original = '#/p/abc'
    expect(buildSelectionUrl(parseSelection(original))).toBe(original)
  })

  test('project + effort', () => {
    const original = '#/p/abc/e/def'
    expect(buildSelectionUrl(parseSelection(original))).toBe(original)
  })

  test('all three', () => {
    const original = '#/p/abc/e/def/s/ghi'
    expect(buildSelectionUrl(parseSelection(original))).toBe(original)
  })

  test('empty → #/', () => {
    expect(buildSelectionUrl(parseSelection('#/'))).toBe('#/')
  })
})
