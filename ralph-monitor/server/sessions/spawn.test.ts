// prepareSpawn tests — DB-backed end-to-end.
//
// We swap $RALPH_MONITOR_DB to a temp file BEFORE importing anything that
// touches the DB module's singleton, mirroring routes.test.ts's pattern.
// One temp DB per file; each test uses fresh projects/efforts so isolation
// comes from disjoint IDs rather than DB resets.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const TEST_DB_DIR = mkdtempSync(join(tmpdir(), 'ralph-monitor-spawn-'))
const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db')
process.env.RALPH_MONITOR_DB = TEST_DB_PATH

const { getDb, closeDb, createProject, createEffort, updateSession, listSessionsByEffort } =
  await import('../db')
const {
  prepareSpawn,
  EffortNotFoundError,
  CwdResolutionError,
} = await import('./spawn')
const { __test__: M } = await import('./spawnMutex')

const tempDirs: string[] = []
function tmpProjectDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ralph-monitor-spawn-proj-'))
  tempDirs.push(d)
  return d
}

afterAll(() => {
  // See routes.test.ts: close the singleton before unlinking the file.
  try { closeDb() } catch {}
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
  try { rmSync(TEST_DB_DIR, { recursive: true, force: true }) } catch {}
})

beforeAll(() => {
  // Force schema migration before any test.
  getDb()
})

describe('prepareSpawn — basic insertion', () => {
  test('happy path: returns uuid, jsonlPath, resolvedCwd, projectRootDir', async () => {
    const dir = tmpProjectDir()
    const { projectId, effortId, rootDir } = createProject(getDb(), {
      name: 'P-basic',
      root_dir: dir,
    })

    const result = await prepareSpawn({ effort_id: effortId, mode: 'autonomous' })

    expect(typeof result.uuid).toBe('string')
    expect(result.uuid.length).toBeGreaterThan(0)
    expect(result.resolvedCwd).toBe(rootDir)
    expect(result.projectRootDir).toBe(rootDir)

    // jsonlPath shape: ~/.claude/projects/<encoded>/<uuid>.jsonl
    const home = process.env.HOME ?? homedir()
    const expectedPrefix = join(home, '.claude', 'projects')
    expect(result.jsonlPath.startsWith(expectedPrefix + '/')).toBe(true)
    expect(result.jsonlPath.endsWith(`${result.uuid}.jsonl`)).toBe(true)

    // Encoded segment should match per-character encoding of resolvedCwd.
    const segments = result.jsonlPath.slice(expectedPrefix.length + 1).split('/')
    expect(segments.length).toBe(2)
    const expectedEncoded = rootDir.replace(/[^A-Za-z0-9]/g, '-')
    expect(segments[0]).toBe(expectedEncoded)

    // Row was inserted with process_pid = NULL.
    const sessions = listSessionsByEffort(getDb(), effortId)
    const row = sessions.find((s) => s.id === result.uuid)
    expect(row).toBeDefined()
    expect(row!.process_pid).toBeNull()
    expect(row!.mode).toBe('autonomous')
    expect(row!.jsonl_path).toBe(result.jsonlPath)
    void projectId // keep linter happy
  })
})

describe('prepareSpawn — working_dir resolution chain', () => {
  test('session input wins over effort.working_dir wins over project.root_dir', async () => {
    const projDir = tmpProjectDir()
    const effortDir = tmpProjectDir()
    const sessionDir = tmpProjectDir()
    const { projectId } = createProject(getDb(), { name: 'P-chain', root_dir: projDir })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-with-cwd',
      kind: 'task',
      working_dir: effortDir,
    })

    // session input wins
    const r1 = await prepareSpawn({
      effort_id: effort.id,
      mode: 'autonomous',
      working_dir: sessionDir,
    })
    expect(r1.resolvedCwd).toBe(sessionDir)
  })

  test('falls back to effort.working_dir when no session input', async () => {
    const projDir = tmpProjectDir()
    const effortDir = tmpProjectDir()
    const { projectId } = createProject(getDb(), {
      name: 'P-chain-effort',
      root_dir: projDir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-2',
      kind: 'task',
      working_dir: effortDir,
    })
    const r = await prepareSpawn({ effort_id: effort.id, mode: 'autonomous' })
    expect(r.resolvedCwd).toBe(effortDir)
    expect(r.projectRootDir).toBe(projDir)
  })

  test('falls back to project.root_dir when neither effort nor session set working_dir', async () => {
    const projDir = tmpProjectDir()
    const { projectId } = createProject(getDb(), {
      name: 'P-fallback-proj',
      root_dir: projDir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-bare',
      kind: 'task',
    })
    const r = await prepareSpawn({ effort_id: effort.id, mode: 'autonomous' })
    expect(r.resolvedCwd).toBe(projDir)
  })

  test('realpath resolves a symlink to its target', async () => {
    const realDir = tmpProjectDir()
    const linkParent = mkdtempSync(join(tmpdir(), 'ralph-monitor-spawn-link-'))
    tempDirs.push(linkParent)
    const linkPath = join(linkParent, 'link-to-real')
    symlinkSync(realDir, linkPath)

    const { projectId } = createProject(getDb(), {
      name: 'P-symlink',
      root_dir: realDir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-sym',
      kind: 'task',
    })
    const r = await prepareSpawn({
      effort_id: effort.id,
      mode: 'autonomous',
      working_dir: linkPath,
    })
    expect(r.resolvedCwd).toBe(realDir)
  })
})

describe('prepareSpawn — error paths', () => {
  test('non-existent effort_id -> EffortNotFoundError', async () => {
    await expect(
      prepareSpawn({ effort_id: 'no-such-effort', mode: 'autonomous' }),
    ).rejects.toBeInstanceOf(EffortNotFoundError)
  })

  test('non-existent working_dir -> CwdResolutionError', async () => {
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), { name: 'P-bad-cwd', root_dir: dir })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-bad-cwd',
      kind: 'task',
    })
    await expect(
      prepareSpawn({
        effort_id: effort.id,
        mode: 'autonomous',
        working_dir: '/tmp/this-path-definitely-does-not-exist-ralph-monitor-spawn/abc',
      }),
    ).rejects.toBeInstanceOf(CwdResolutionError)
  })
})

describe('prepareSpawn — parallel spawns (constraint lifted)', () => {
  test('a row with NULL process_pid does NOT block a second prepareSpawn', async () => {
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), {
      name: 'P-null-pid-not-blocking',
      root_dir: dir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-null',
      kind: 'task',
    })
    const r1 = await prepareSpawn({ effort_id: effort.id, mode: 'autonomous' })
    expect(r1.uuid).toBeDefined()
    // r1's row has process_pid = NULL — second call should succeed.
    const r2 = await prepareSpawn({ effort_id: effort.id, mode: 'autonomous' })
    expect(r2.uuid).not.toBe(r1.uuid)
  })

  test('a row with non-NULL process_pid no longer blocks a second prepareSpawn (constraint lifted)', async () => {
    // Migration 3 dropped the partial unique index, so multiple live sessions
    // per effort are now allowed. prepareSpawn no longer throws for this case.
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), {
      name: 'P-blocking',
      root_dir: dir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-block',
      kind: 'task',
    })
    const r1 = await prepareSpawn({ effort_id: effort.id, mode: 'autonomous' })

    // Simulate the actual spawner having set the pid (US-005a-2 will do
    // this; here we bypass and write directly).
    updateSession(getDb(), r1.uuid, { process_pid: 99999, process_started_at: Date.now() })

    // Second prepareSpawn must now SUCCEED.
    const r2 = await prepareSpawn({ effort_id: effort.id, mode: 'autonomous' })
    expect(r2.uuid).not.toBe(r1.uuid)
  })
})

describe('prepareSpawn — mutex serialization', () => {
  test('two concurrent prepareSpawns for the same effort serialize', async () => {
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), {
      name: 'P-mutex',
      root_dir: dir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-mutex',
      kind: 'task',
    })

    // Both succeed because both insert process_pid=NULL rows; the lock
    // ensures the read-then-write is atomic per turn so neither sees the
    // other's NULL row as "live" and rejects.
    const [r1, r2] = await Promise.all([
      prepareSpawn({ effort_id: effort.id, mode: 'autonomous' }),
      prepareSpawn({ effort_id: effort.id, mode: 'autonomous' }),
    ])
    expect(r1.uuid).not.toBe(r2.uuid)

    const sessions = listSessionsByEffort(getDb(), effort.id)
    const ids = sessions.map((s) => s.id).sort()
    expect(ids).toContain(r1.uuid)
    expect(ids).toContain(r2.uuid)
  })

  test('mutex map drains for the effort after settled spawns', async () => {
    const dir = tmpProjectDir()
    const { projectId } = createProject(getDb(), {
      name: 'P-mutex-drain',
      root_dir: dir,
    })
    const effort = createEffort(getDb(), {
      project_id: projectId,
      name: 'effort-mutex-drain',
      kind: 'task',
    })

    await prepareSpawn({ effort_id: effort.id, mode: 'autonomous' })
    // Microtask + small sleep to let the .finally cleanup run.
    await new Promise<void>((r) => setTimeout(r, 10))
    expect(M.has(effort.id)).toBe(false)
  })
})
