// Smoke + pure-function tests for PrdSnapshotPanels (US-012b).
//
// Approach mirrors the pattern from SessionStream.test.tsx:
//   1. Confirm the component and helpers export cleanly.
//   2. Exercise the pure `buildProcessTree` helper with unit assertions.
//
// Render-tree assertions are deferred to US-018 (Playwright).

import { describe, expect, test } from 'bun:test'
import type { ClaudeProcess } from '../../server/types'

const { PrdSnapshotPanels, buildProcessTree } = await import('./PrdSnapshotPanels')

// ---------------------------------------------------------------------------
// Module-level smoke tests
// ---------------------------------------------------------------------------

test('PrdSnapshotPanels component exists', () => {
  expect(typeof PrdSnapshotPanels).toBe('function')
})

test('buildProcessTree is exported as a function', () => {
  expect(typeof buildProcessTree).toBe('function')
})

// ---------------------------------------------------------------------------
// buildProcessTree — pure helper unit tests
// ---------------------------------------------------------------------------

function makeProc(pid: number, ppid: number, isOrchestrator?: boolean): ClaudeProcess {
  return { pid, ppid, ...(isOrchestrator !== undefined ? { isOrchestrator } : {}) }
}

describe('buildProcessTree', () => {
  test('empty input returns empty roots and empty map', () => {
    const { roots, childrenByPpid } = buildProcessTree([])
    expect(roots).toHaveLength(0)
    expect(childrenByPpid.size).toBe(0)
  })

  test('single process with external parent is a root', () => {
    const { roots } = buildProcessTree([makeProc(100, 1)])
    expect(roots).toHaveLength(1)
    expect(roots[0].pid).toBe(100)
  })

  test('child process is NOT a root', () => {
    const procs = [makeProc(100, 1), makeProc(200, 100)]
    const { roots, childrenByPpid } = buildProcessTree(procs)
    expect(roots).toHaveLength(1)
    expect(roots[0].pid).toBe(100)
    expect(childrenByPpid.get(100)).toHaveLength(1)
    expect(childrenByPpid.get(100)![0].pid).toBe(200)
  })

  test('confirmed orchestrator sorts first among roots', () => {
    const procs = [
      makeProc(100, 1),             // plain root
      makeProc(200, 2, true),       // orchestrator root
      makeProc(300, 3),             // another plain root
    ]
    const { roots } = buildProcessTree(procs)
    expect(roots[0].pid).toBe(200)
    expect(roots[0].isOrchestrator).toBe(true)
  })

  test('deep tree: grandchild appears only under its direct parent', () => {
    const procs = [makeProc(1, 0), makeProc(2, 1), makeProc(3, 2)]
    const { roots, childrenByPpid } = buildProcessTree(procs)
    expect(roots).toHaveLength(1)
    expect(roots[0].pid).toBe(1)
    expect(childrenByPpid.get(1)![0].pid).toBe(2)
    expect(childrenByPpid.get(2)![0].pid).toBe(3)
    expect(childrenByPpid.has(3)).toBe(false)
  })

  test('multiple independent trees each produce their own root', () => {
    const procs = [makeProc(10, 1), makeProc(20, 2)]
    const { roots } = buildProcessTree(procs)
    expect(roots).toHaveLength(2)
    const pids = roots.map(r => r.pid).sort()
    expect(pids).toEqual([10, 20])
  })
})
