// Tests for `server/git/worktrees.ts`.
//
// `parseWorktreeList` is the pure layer — we feed it canonical porcelain
// blobs and assert the parsed shape. We deliberately do NOT spawn real git
// here; the parser test alone is enough to cover the porcelain shapes this
// codebase has to handle.
//
// `listWorktrees`'s caching is straightforward (TTL + Map) and exercising
// it would require mocking spawnSync, which Bun's test runner doesn't
// directly support without a module-level seam we'd otherwise have to add
// just for tests. We rely on parseWorktreeList coverage + manual review of
// the cache wrapper. See HEDGES at the top of the route tests for how the
// production `listWorktrees` is exercised end-to-end via the route layer.
//
// `isPathInProjectOrWorktree` IS hit here for the "non-git directory →
// only the project root matches" branch, which is the path the route uses
// in the working_dir-outside-project test.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseWorktreeList,
  isPathInProjectOrWorktree,
  isPathInsideProjectOrWorktree,
  clearWorktreeCacheForTests,
} from './worktrees'

const tempDirs: string[] = []
function tmp(prefix = 'rmrm-worktrees-test-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(d)
  return d
}

afterAll(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
  clearWorktreeCacheForTests()
})

describe('parseWorktreeList', () => {
  test('empty input returns []', () => {
    expect(parseWorktreeList('')).toEqual([])
    expect(parseWorktreeList('\n\n')).toEqual([])
  })

  test('single block (just main) parses path + branch', () => {
    const blob = [
      'worktree /home/me/proj',
      'HEAD 1234abcd',
      'branch refs/heads/main',
      '',
    ].join('\n')
    expect(parseWorktreeList(blob)).toEqual([
      { path: '/home/me/proj', branch: 'main' },
    ])
  })

  test('multi-block (main + 2 worktrees)', () => {
    const blob = [
      'worktree /home/me/proj',
      'HEAD aaaa',
      'branch refs/heads/main',
      '',
      'worktree /home/me/proj-feature',
      'HEAD bbbb',
      'branch refs/heads/feature',
      '',
      'worktree /home/me/proj-hotfix',
      'HEAD cccc',
      'branch refs/heads/hotfix',
      '',
    ].join('\n')
    const out = parseWorktreeList(blob)
    expect(out.length).toBe(3)
    expect(out[0]).toEqual({ path: '/home/me/proj', branch: 'main' })
    expect(out[1]).toEqual({ path: '/home/me/proj-feature', branch: 'feature' })
    expect(out[2]).toEqual({ path: '/home/me/proj-hotfix', branch: 'hotfix' })
  })

  test('detached HEAD block has branch = null', () => {
    const blob = [
      'worktree /home/me/proj',
      'HEAD aaaa',
      'branch refs/heads/main',
      '',
      'worktree /home/me/proj-detached',
      'HEAD bbbb',
      'detached',
      '',
    ].join('\n')
    const out = parseWorktreeList(blob)
    expect(out.length).toBe(2)
    expect(out[1]).toEqual({ path: '/home/me/proj-detached', branch: null })
  })

  test('bare flag is preserved', () => {
    const blob = [
      'worktree /home/me/proj.git',
      'bare',
      '',
    ].join('\n')
    const out = parseWorktreeList(blob)
    expect(out.length).toBe(1)
    expect(out[0]).toEqual({ path: '/home/me/proj.git', branch: null, bare: true })
  })

  test('ignores unknown attribute lines (forward-compat)', () => {
    const blob = [
      'worktree /home/me/proj',
      'HEAD aaaa',
      'branch refs/heads/main',
      'locked',
      'prunable',
      '',
    ].join('\n')
    const out = parseWorktreeList(blob)
    expect(out.length).toBe(1)
    expect(out[0]).toEqual({ path: '/home/me/proj', branch: 'main' })
  })

  test('skips blocks with no `worktree` line (defensive)', () => {
    const blob = [
      'HEAD aaaa',
      'branch refs/heads/orphan',
      '',
      'worktree /home/me/real',
      'branch refs/heads/main',
      '',
    ].join('\n')
    const out = parseWorktreeList(blob)
    expect(out.length).toBe(1)
    expect(out[0]).toEqual({ path: '/home/me/real', branch: 'main' })
  })
})

describe('isPathInProjectOrWorktree (non-git dir)', () => {
  // The route's working_dir-outside-project test path: a tmp dir that is
  // NOT a git repo. listWorktrees() returns [] gracefully (git exits
  // non-zero), so only `projectRootDir` itself matches.

  test('exact project root matches', () => {
    clearWorktreeCacheForTests()
    const proj = tmp()
    expect(isPathInProjectOrWorktree(proj, proj)).toBe(true)
  })

  test('different tmp dir does NOT match', () => {
    clearWorktreeCacheForTests()
    const proj = tmp()
    const other = tmp()
    expect(isPathInProjectOrWorktree(proj, other)).toBe(false)
  })

  test('subdir of project does NOT match (only exact-match semantics)', () => {
    // The AC says working_dir must resolve to project.root_dir OR a known
    // worktree. A subdirectory is NOT a worktree, so it's rejected. (The
    // happy path for "session under a subdir" is via effort.working_dir,
    // which prepareSpawn handles separately — this validator only sees the
    // session-level working_dir, which the route doc says should be a
    // project root or worktree root.)
    clearWorktreeCacheForTests()
    const proj = tmp()
    const sub = join(proj, 'sub')
    mkdirSync(sub)
    expect(isPathInProjectOrWorktree(proj, sub)).toBe(false)
  })

  test('symlink to project root matches (realpath both sides)', () => {
    clearWorktreeCacheForTests()
    const proj = tmp()
    const linkParent = tmp()
    const link = join(linkParent, 'link-to-proj')
    symlinkSync(proj, link)
    expect(isPathInProjectOrWorktree(proj, link)).toBe(true)
  })

  test('non-existent path returns false (realpath fails gracefully)', () => {
    clearWorktreeCacheForTests()
    const proj = tmp()
    expect(
      isPathInProjectOrWorktree(proj, '/tmp/does-not-exist-rmrm-worktrees-test/abc'),
    ).toBe(false)
  })
})

describe('isPathInsideProjectOrWorktree (non-git dir)', () => {
  // Unlike isPathInProjectOrWorktree (exact match), this helper accepts any
  // path nested under the project root or a worktree root.

  test('exact project root matches', () => {
    clearWorktreeCacheForTests()
    const proj = tmp()
    expect(isPathInsideProjectOrWorktree(proj, proj)).toBe(true)
  })

  test('subdir of project root matches', () => {
    clearWorktreeCacheForTests()
    const proj = tmp()
    const sub = join(proj, 'subdir')
    mkdirSync(sub)
    expect(isPathInsideProjectOrWorktree(proj, sub)).toBe(true)
  })

  test('deeply nested path inside project root matches', () => {
    clearWorktreeCacheForTests()
    const proj = tmp()
    const nested = join(proj, 'a', 'b', 'c')
    mkdirSync(nested, { recursive: true })
    expect(isPathInsideProjectOrWorktree(proj, nested)).toBe(true)
  })

  test('different tmp dir does NOT match', () => {
    clearWorktreeCacheForTests()
    const proj = tmp()
    const other = tmp()
    expect(isPathInsideProjectOrWorktree(proj, other)).toBe(false)
  })

  test('non-existent path OUTSIDE project returns false', () => {
    clearWorktreeCacheForTests()
    const proj = tmp()
    // Completely different path — not under proj at all.
    expect(
      isPathInsideProjectOrWorktree(proj, '/tmp/does-not-exist-rmrm-worktrees-test-inside/prd.json'),
    ).toBe(false)
  })

  test('non-existent path with prefix matching project root returns true (future prd.json)', () => {
    clearWorktreeCacheForTests()
    const proj = tmp()
    // path.resolve produces the lexical path even if the file doesn't exist yet.
    const futurePrd = join(proj, 'tasks', 'future-story', 'prd.json')
    // The file doesn't exist — but its prefix is proj.
    expect(isPathInsideProjectOrWorktree(proj, futurePrd)).toBe(true)
  })

  test('symlink to file inside project matches', () => {
    clearWorktreeCacheForTests()
    const proj = tmp()
    const sub = join(proj, 'tasks')
    mkdirSync(sub)
    // Create a real file inside the project to symlink to.
    const realFile = join(sub, 'prd.json')
    require('node:fs').writeFileSync(realFile, '{}')
    const linkParent = tmp()
    const link = join(linkParent, 'prd-link.json')
    symlinkSync(realFile, link)
    expect(isPathInsideProjectOrWorktree(proj, link)).toBe(true)
  })
})
