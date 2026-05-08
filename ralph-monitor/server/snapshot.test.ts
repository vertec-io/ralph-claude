// Tests for US-012a: snapshot.ts wider path-keyed entry point.
//
// Strategy: create isolated temp dirs with controlled fixture files, then call
// getSnapshotForPath and refreshSnapshot directly (no mocking, no process
// spawning assertions).  We intentionally do NOT assert on agents.processes
// since that walks /proc and is environment-dependent; we only assert that
// the field is present and is an array.
//
// HEDGES:
//   • recentCommits is [] in fixture dirs (not real git repos) because git log
//     exits non-zero; readGitLog resolves [] on child error, so no flakiness.
//   • computeStatus for a fixture PRDRecord with no heartbeat, no jsonl, and
//     no running claude procs will return 'crashed'. Tests assert that status
//     is NOT 'pending' (which is only the ENOENT sentinel) rather than a
//     specific terminal value, because environment /proc state can affect the
//     result.
//   • The 'pending' status is returned ONLY for ENOENT on prdPath — not for
//     JSON parse failures (those set prd: undefined and continue to fill the
//     full record).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PRDRecord, PRDJson } from './types'
import { getSnapshotForPath, refreshSnapshot } from './snapshot'

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = []
function tmp(prefix = 'rmrm-snapshot-test-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(d)
  return d
}

afterAll(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

function makePrdFixture(taskDir: string, prd: PRDJson) {
  writeFileSync(join(taskDir, 'prd.json'), JSON.stringify(prd))
}

const FIXTURE_PRD: PRDJson = {
  title: 'Test PRD',
  userStories: [
    { id: 'US-001', title: 'Story one', passes: false },
    { id: 'US-002', title: 'Story two', passes: true },
  ],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFixturePRDRecord(taskDir: string, worktreeDir: string): PRDRecord {
  return {
    unitName: 'ralph-pilot-native-test-unit',
    taskDir,
    worktreeDir,
    sessionId: 'test-session-id-abc123',
    recentCommits: [],
    watchdogLogTail: [],
    decisionFiles: [],
    docFiles: [],
    status: 'idle',
    lastUpdated: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getSnapshotForPath', () => {
  describe('missing prd.json → status: pending', () => {
    test('returns { status: "pending" } without throwing when prdPath does not exist', async () => {
      const taskDir = tmp()
      const worktreeDir = tmp()
      const prdPath = join(taskDir, 'prd.json')  // does NOT exist on disk

      const result = await getSnapshotForPath({ prdPath, workingDir: worktreeDir })

      expect(result.status).toBe('pending')
      // Should not throw — we get a valid PRDRecord back
      expect(result).toBeDefined()
      expect(result.recentCommits).toEqual([])
      expect(result.watchdogLogTail).toEqual([])
      expect(result.decisionFiles).toEqual([])
      expect(result.docFiles).toEqual([])
    })
  })

  describe('effort-attached inputs (sessionId and unitName absent)', () => {
    let taskDir: string
    let worktreeDir: string
    let prdPath: string
    let result: PRDRecord

    beforeAll(async () => {
      taskDir = tmp()
      worktreeDir = tmp()
      prdPath = join(taskDir, 'prd.json')
      makePrdFixture(taskDir, FIXTURE_PRD)

      result = await getSnapshotForPath({ prdPath, workingDir: worktreeDir })
    })

    test('returns a PRDRecord (same shape as refreshSnapshot output)', () => {
      // Required fields present
      expect(typeof result.unitName).toBe('string')
      expect(typeof result.taskDir).toBe('string')
      expect(typeof result.worktreeDir).toBe('string')
      expect(typeof result.sessionId).toBe('string')
      expect(typeof result.status).toBe('string')
      expect(typeof result.lastUpdated).toBe('number')
      expect(Array.isArray(result.recentCommits)).toBe(true)
      expect(Array.isArray(result.watchdogLogTail)).toBe(true)
      expect(Array.isArray(result.decisionFiles)).toBe(true)
      expect(Array.isArray(result.docFiles)).toBe(true)
    })

    test('parses prd.json correctly', () => {
      expect(result.prd).toBeDefined()
      expect(result.prd?.title).toBe('Test PRD')
      expect(result.prd?.userStories).toHaveLength(2)
    })

    test('agents.processes is an empty array when sessionId/unitName absent', () => {
      expect(result.agents).toBeDefined()
      expect(result.agents?.processes).toEqual([])
    })

    test('agents.tasks is an empty array when unitName absent', () => {
      expect(result.agents?.tasks).toEqual([])
    })

    test('status is not "pending" (ENOENT sentinel) when file exists', () => {
      expect(result.status).not.toBe('pending')
    })

    test('taskDir is dirname of prdPath', () => {
      expect(result.taskDir).toBe(taskDir)
    })

    test('worktreeDir is the workingDir passed in', () => {
      expect(result.worktreeDir).toBe(worktreeDir)
    })

    test('unitName defaults to empty string when not provided', () => {
      expect(result.unitName).toBe('')
    })

    test('sessionId defaults to empty string when not provided', () => {
      expect(result.sessionId).toBe('')
    })
  })

  describe('systemd-attached inputs (all four fields provided)', () => {
    let taskDir: string
    let worktreeDir: string
    let prdPath: string
    let result: PRDRecord

    beforeAll(async () => {
      taskDir = tmp()
      worktreeDir = tmp()
      prdPath = join(taskDir, 'prd.json')
      makePrdFixture(taskDir, FIXTURE_PRD)

      result = await getSnapshotForPath({
        prdPath,
        workingDir: worktreeDir,
        sessionId: 'test-session-xyz',
        unitName: 'ralph-pilot-native-test',
      })
    })

    test('unitName is set from input', () => {
      expect(result.unitName).toBe('ralph-pilot-native-test')
    })

    test('sessionId is set from input', () => {
      expect(result.sessionId).toBe('test-session-xyz')
    })

    test('agents.processes is an array (may be empty in test env)', () => {
      expect(Array.isArray(result.agents?.processes)).toBe(true)
    })

    test('agents.tasks is an array', () => {
      expect(Array.isArray(result.agents?.tasks)).toBe(true)
    })

    test('prd.json is parsed', () => {
      expect(result.prd?.title).toBe('Test PRD')
    })
  })

  describe('doc files discovery', () => {
    test('discovers .md and .txt files in taskDir', async () => {
      const taskDir = tmp()
      const worktreeDir = tmp()
      writeFileSync(join(taskDir, 'prd.json'), JSON.stringify(FIXTURE_PRD))
      writeFileSync(join(taskDir, 'prd.md'), '# PRD')
      writeFileSync(join(taskDir, 'progress.txt'), 'step 1\nstep 2')
      writeFileSync(join(taskDir, 'HANDOFF.md'), 'handoff notes')

      const result = await getSnapshotForPath({
        prdPath: join(taskDir, 'prd.json'),
        workingDir: worktreeDir,
      })

      const names = result.docFiles.map(d => d.name)
      expect(names).toContain('prd.md')
      expect(names).toContain('progress.txt')
      expect(names).toContain('HANDOFF.md')
    })
  })
})

describe('refreshSnapshot', () => {
  describe('existing systemd-discovered behavior is unchanged', () => {
    let taskDir: string
    let worktreeDir: string
    let prd: PRDRecord
    let result: PRDRecord

    beforeAll(async () => {
      taskDir = tmp()
      worktreeDir = tmp()
      makePrdFixture(taskDir, FIXTURE_PRD)

      prd = makeFixturePRDRecord(taskDir, worktreeDir)
      result = await refreshSnapshot(prd)
    })

    test('returns a PRDRecord with the same required shape', () => {
      expect(typeof result.unitName).toBe('string')
      expect(typeof result.taskDir).toBe('string')
      expect(typeof result.worktreeDir).toBe('string')
      expect(typeof result.sessionId).toBe('string')
      expect(typeof result.status).toBe('string')
      expect(typeof result.lastUpdated).toBe('number')
      expect(Array.isArray(result.recentCommits)).toBe(true)
      expect(Array.isArray(result.watchdogLogTail)).toBe(true)
      expect(Array.isArray(result.decisionFiles)).toBe(true)
      expect(Array.isArray(result.docFiles)).toBe(true)
    })

    test('preserves unitName from the PRDRecord', () => {
      expect(result.unitName).toBe(prd.unitName)
    })

    test('preserves worktreeDir from the PRDRecord', () => {
      expect(result.worktreeDir).toBe(prd.worktreeDir)
    })

    test('preserves sessionId from the PRDRecord', () => {
      expect(result.sessionId).toBe(prd.sessionId)
    })

    test('parses prd.json and populates prd field', () => {
      expect(result.prd).toBeDefined()
      expect(result.prd?.title).toBe('Test PRD')
      expect(result.prd?.userStories).toHaveLength(2)
    })

    test('agents is populated (processes array present)', () => {
      expect(result.agents).toBeDefined()
      expect(Array.isArray(result.agents?.processes)).toBe(true)
      expect(Array.isArray(result.agents?.tasks)).toBe(true)
    })

    test('lastUpdated is a recent timestamp', () => {
      const delta = Date.now() - result.lastUpdated
      expect(delta).toBeGreaterThanOrEqual(0)
      expect(delta).toBeLessThan(5000)
    })

    test('status is not "pending" when prd.json exists', () => {
      expect(result.status).not.toBe('pending')
    })
  })

  describe('refreshSnapshot with missing prd.json returns pending shape', () => {
    test('does not throw when prd.json is absent', async () => {
      const taskDir = tmp()
      const worktreeDir = tmp()
      // NOTE: prd.json intentionally NOT written

      const prd = makeFixturePRDRecord(taskDir, worktreeDir)
      const result = await refreshSnapshot(prd)

      expect(result.status).toBe('pending')
    })
  })

  describe('result shape is identical to getSnapshotForPath with same four fields', () => {
    test('both functions return the same values for equivalent inputs', async () => {
      const taskDir = tmp()
      const worktreeDir = tmp()
      makePrdFixture(taskDir, FIXTURE_PRD)

      const prd = makeFixturePRDRecord(taskDir, worktreeDir)

      // Run concurrently but compare fields (not lastUpdated which is stamped at call time)
      const [fromRefresh, fromPath] = await Promise.all([
        refreshSnapshot(prd),
        getSnapshotForPath({
          prdPath: join(taskDir, 'prd.json'),
          workingDir: worktreeDir,
          sessionId: prd.sessionId,
          unitName: prd.unitName,
        }),
      ])

      expect(fromRefresh.unitName).toBe(fromPath.unitName)
      expect(fromRefresh.taskDir).toBe(fromPath.taskDir)
      expect(fromRefresh.worktreeDir).toBe(fromPath.worktreeDir)
      expect(fromRefresh.sessionId).toBe(fromPath.sessionId)
      expect(fromRefresh.prd?.title).toBe(fromPath.prd?.title)
      expect(fromRefresh.prd?.userStories.length).toBe(fromPath.prd?.userStories.length)
      expect(fromRefresh.decisionFiles).toEqual(fromPath.decisionFiles)
      expect(fromRefresh.docFiles.map(d => d.name)).toEqual(fromPath.docFiles.map(d => d.name))
    })
  })
})
