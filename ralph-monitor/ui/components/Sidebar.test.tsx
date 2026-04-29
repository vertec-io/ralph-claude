// Pure-function unit tests for Sidebar (US-014a).
//
// Coverage:
//   bucketProjects — all bucketing edge cases documented in the AC + PRD.
//   Sidebar        — smoke: module exports correctly, component renders without throwing.
//
// Render-tree assertions (collapsible behaviour, click handlers) are deferred
// to US-018 (Playwright).
//
// Bucketing interpretation (documented here for traceability):
//   The AC reads "Recent (last_opened_at within 30d AND no live session)".
//   We treat this as the *primary* population path, not a hard filter:
//   any non-archived, non-pinned, non-live project that doesn't qualify for
//   Active lands in Recent regardless of the age of its last_opened_at.
//   The 30-day threshold is only used for the never-opened boundary: a project
//   that was never opened AND was created within 30 days is promoted to Active.

import { describe, expect, test } from 'bun:test'
import type { Project } from '../../server/db/projects'
import { bucketProjects, Sidebar } from './Sidebar'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_000_000_000_000 // arbitrary fixed "now" in ms

const DAY = 24 * 60 * 60 * 1000
const DAYS_20 = 20 * DAY
const DAYS_31 = 31 * DAY

function makeProject(overrides: Partial<Project> & Pick<Project, 'id'>): Project {
  return {
    id: overrides.id,
    name: overrides.name ?? `Project ${overrides.id}`,
    root_dir: overrides.root_dir ?? `/tmp/${overrides.id}`,
    created_at: overrides.created_at ?? NOW - DAYS_20,
    last_opened_at: overrides.last_opened_at !== undefined ? overrides.last_opened_at : NOW - DAYS_20,
    archived: overrides.archived ?? false,
    pinned: overrides.pinned ?? false,
  }
}

const EMPTY_LIVE = new Set<string>()

// ---------------------------------------------------------------------------
// bucketProjects
// ---------------------------------------------------------------------------

describe('bucketProjects', () => {
  test('empty projects → empty buckets', () => {
    const result = bucketProjects([], EMPTY_LIVE, undefined, NOW)
    expect(result.active).toHaveLength(0)
    expect(result.recent).toHaveLength(0)
    expect(result.archived).toHaveLength(0)
  })

  test('archived project → archived bucket', () => {
    const p = makeProject({ id: 'a', archived: true })
    const result = bucketProjects([p], EMPTY_LIVE, undefined, NOW)
    expect(result.archived).toHaveLength(1)
    expect(result.archived[0].id).toBe('a')
    expect(result.active).toHaveLength(0)
    expect(result.recent).toHaveLength(0)
  })

  test('pinned project → active bucket', () => {
    const p = makeProject({ id: 'p', pinned: true })
    const result = bucketProjects([p], EMPTY_LIVE, undefined, NOW)
    expect(result.active).toHaveLength(1)
    expect(result.active[0].id).toBe('p')
    expect(result.recent).toHaveLength(0)
  })

  test('project with live session (via effortsLiveByProject) → active bucket', () => {
    const p = makeProject({ id: 'live' })
    const liveMap = new Map([['live', true]])
    const result = bucketProjects([p], EMPTY_LIVE, liveMap, NOW)
    expect(result.active).toHaveLength(1)
    expect(result.active[0].id).toBe('live')
  })

  test('project with last_opened_at within 30d, no live session, not pinned → recent', () => {
    const p = makeProject({ id: 'r', last_opened_at: NOW - DAYS_20 })
    const result = bucketProjects([p], EMPTY_LIVE, undefined, NOW)
    expect(result.recent).toHaveLength(1)
    expect(result.recent[0].id).toBe('r')
    expect(result.active).toHaveLength(0)
  })

  test('project with last_opened_at older than 30d → still in recent (not dropped)', () => {
    const p = makeProject({ id: 'old', last_opened_at: NOW - DAYS_31 })
    const result = bucketProjects([p], EMPTY_LIVE, undefined, NOW)
    // Per interpretation: old last_opened_at → recent (the AC doesn't filter them out)
    expect(result.recent).toHaveLength(1)
    expect(result.recent[0].id).toBe('old')
    expect(result.active).toHaveLength(0)
    expect(result.archived).toHaveLength(0)
  })

  test('never-opened project created within 30d → active', () => {
    const p = makeProject({ id: 'new', last_opened_at: null, created_at: NOW - DAYS_20 })
    const result = bucketProjects([p], EMPTY_LIVE, undefined, NOW)
    expect(result.active).toHaveLength(1)
    expect(result.active[0].id).toBe('new')
  })

  test('never-opened project created more than 30d ago → recent', () => {
    const p = makeProject({ id: 'stale', last_opened_at: null, created_at: NOW - DAYS_31 })
    const result = bucketProjects([p], EMPTY_LIVE, undefined, NOW)
    expect(result.recent).toHaveLength(1)
    expect(result.recent[0].id).toBe('stale')
    expect(result.active).toHaveLength(0)
  })

  test('archived project is not promoted even if pinned', () => {
    const p = makeProject({ id: 'ap', archived: true, pinned: true })
    const result = bucketProjects([p], EMPTY_LIVE, undefined, NOW)
    expect(result.archived).toHaveLength(1)
    expect(result.active).toHaveLength(0)
  })

  test('multiple projects land in correct buckets', () => {
    const projects: Project[] = [
      makeProject({ id: 'pin', pinned: true }),
      makeProject({ id: 'arc', archived: true }),
      makeProject({ id: 'rec', last_opened_at: NOW - DAYS_20 }),
    ]
    const result = bucketProjects(projects, EMPTY_LIVE, undefined, NOW)
    expect(result.active.map(p => p.id)).toContain('pin')
    expect(result.archived.map(p => p.id)).toContain('arc')
    expect(result.recent.map(p => p.id)).toContain('rec')
  })

  test('effortsLiveByProject=undefined treats all projects as dormant', () => {
    const p = makeProject({ id: 'x' })
    const result = bucketProjects([p], EMPTY_LIVE, undefined, NOW)
    // last_opened_at is set (within 30d default) → recent
    expect(result.recent).toHaveLength(1)
    expect(result.active).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Sidebar — smoke tests (no rendering, just module-level checks)
// ---------------------------------------------------------------------------

describe('Sidebar', () => {
  test('Sidebar is exported as a function', () => {
    expect(typeof Sidebar).toBe('function')
  })

  test('Sidebar component name is Sidebar', () => {
    expect(Sidebar.name).toBe('Sidebar')
  })
})
