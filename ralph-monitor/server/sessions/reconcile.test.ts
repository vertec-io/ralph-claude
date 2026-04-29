// Tests for the startup reconciler (US-006).
//
// We exercise the public surface (`reconcileSessionsOnStartup`) against a
// fresh in-memory sqlite DB per case. The reconciler reads /proc — which is
// non-deterministic and platform-specific — so we inject a `procReader` mock
// that maps paths to canned responses. Same trick for `platformOverride` so
// the non-Linux branch can be exercised even when the test runs on Linux.
//
// What we deliberately do NOT test here:
//   - Real /proc walk (covered indirectly by liveness.ts existing tests; we
//     don't want test flakes from PID reuse on the host).
//   - Server-startup wiring in index.ts (covered by integration of the route
//     test for GET /api/sessions/:id, which exercises the same DB shape).

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrations } from '../db/migrate'
import { createProject } from '../db/projects'
import { createEffort } from '../db/efforts'
import { createSession, getSessionById, listSessionsWithPid } from '../db/sessions'
import {
  reconcileSessionsOnStartup,
  PTY_PARENT_COMM,
  type ProcReader,
} from './reconcile'

function freshDb(): Database {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db)
  return db
}

function tmpProjectDir(): string {
  return mkdtempSync(join(tmpdir(), 'ralph-monitor-reconcile-'))
}

// Build a procReader mock from a path -> response map. Unmapped paths
// resolve to null (mirrors a missing /proc entry).
function mockProcReader(map: Record<string, string | null>): ProcReader {
  return async (path) => (path in map ? map[path]! : null)
}

// Build the canonical environ string for a given session uuid plus optional
// extra entries. Trailing null mirrors the kernel's /proc format.
function buildEnviron(extras: string[]): string {
  return extras.join('\0') + '\0'
}

describe('reconcileSessionsOnStartup — platform-unsupported branch', () => {
  test('marks every PID-bearing row as dormant + emits a warning', () => {
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { effortId } = createProject(db, { name: 'P', root_dir: dir })
      const sessId = crypto.randomUUID()
      createSession(db, {
        id: sessId,
        effort_id: effortId,
        mode: 'autonomous',
        jsonl_path: '/tmp/s.jsonl',
        process_pid: 99999,
        process_started_at: Date.now(),
      })

      // Capture console.warn calls.
      const warnCalls: unknown[][] = []
      const origWarn = console.warn
      console.warn = (...args: unknown[]) => { warnCalls.push(args) }

      let result
      try {
        // platformOverride=darwin exercises the non-Linux branch deterministically.
        // procReader is a no-op; the branch must not consult it.
        result = reconcileSessionsOnStartup({
          platformOverride: 'darwin',
          procReader: async () => { throw new Error('procReader must not be called on non-Linux') },
          db,
        })
      } finally {
        console.warn = origWarn
      }

      return result.then((r) => {
        expect(r.dormantCount).toBe(1)
        expect(r.liveOrphanedCount).toBe(0)
        expect(r.entries.length).toBe(1)
        expect(r.entries[0]!.status).toBe('platform-unsupported')
        expect(r.entries[0]!.sessionId).toBe(sessId)
        expect(r.entries[0]!.pid).toBe(99999)

        // Side-effect: row's process_pid is now null.
        const row = getSessionById(db, sessId)
        expect(row!.process_pid).toBeNull()
        expect(row!.process_started_at).toBeNull()

        // console.warn was called.
        expect(warnCalls.length).toBe(1)
        expect(String(warnCalls[0]![0])).toContain('platform=darwin')
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('platform-unsupported with no PID-bearing rows returns empty result + no warn output', async () => {
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { effortId } = createProject(db, { name: 'P', root_dir: dir })
      // A session with NULL pid is exempt from the reconciler's walk.
      createSession(db, {
        id: crypto.randomUUID(),
        effort_id: effortId,
        mode: 'autonomous',
        jsonl_path: '/tmp/s.jsonl',
      })

      const warnCalls: unknown[][] = []
      const origWarn = console.warn
      console.warn = (...args: unknown[]) => { warnCalls.push(args) }

      let result
      try {
        result = await reconcileSessionsOnStartup({
          platformOverride: 'darwin',
          db,
        })
      } finally {
        console.warn = origWarn
      }

      expect(result.entries.length).toBe(0)
      expect(result.dormantCount).toBe(0)
      expect(result.liveOrphanedCount).toBe(0)
      // Warn STILL fires (the reconciler reports "0 PID-bearing session(s)"),
      // which is fine — operators want to know reconciliation noticed the
      // platform skew. Assert specifically on the message shape.
      expect(warnCalls.length).toBe(1)
      expect(String(warnCalls[0]![0])).toContain('platform=darwin')
      expect(String(warnCalls[0]![0])).toContain('0 PID-bearing')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('reconcileSessionsOnStartup — Linux match logic', () => {
  test('comm=bun + env tag match -> live-orphaned, DB row keeps its pid', async () => {
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { effortId } = createProject(db, { name: 'P', root_dir: dir })
      const sessId = crypto.randomUUID()
      const pid = 12345
      createSession(db, {
        id: sessId,
        effort_id: effortId,
        mode: 'autonomous',
        jsonl_path: '/tmp/s.jsonl',
        process_pid: pid,
        process_started_at: Date.now(),
      })

      const reader = mockProcReader({
        [`/proc/${pid}/comm`]: `${PTY_PARENT_COMM}\n`,
        [`/proc/${pid}/environ`]: buildEnviron([
          'PATH=/usr/bin',
          `RALPH_MONITOR_SESSION=${sessId}`,
          'TERM=xterm-256color',
        ]),
      })

      const result = await reconcileSessionsOnStartup({
        platformOverride: 'linux',
        procReader: reader,
        db,
      })

      expect(result.liveOrphanedCount).toBe(1)
      expect(result.dormantCount).toBe(0)
      expect(result.entries[0]!.status).toBe('live-orphaned')
      expect(result.entries[0]!.sessionId).toBe(sessId)
      expect(result.entries[0]!.pid).toBe(pid)

      // Row keeps its pid — that's how the API status surface returns
      // 'live-orphaned' on next request.
      const row = getSessionById(db, sessId)
      expect(row!.process_pid).toBe(pid)
      expect(row!.process_started_at).not.toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("wrong comm -> dormant (PID reuse protection)", async () => {
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { effortId } = createProject(db, { name: 'P', root_dir: dir })
      const sessId = crypto.randomUUID()
      const pid = 12345
      createSession(db, {
        id: sessId,
        effort_id: effortId,
        mode: 'autonomous',
        jsonl_path: '/tmp/s.jsonl',
        process_pid: pid,
        process_started_at: Date.now(),
      })

      // Wrong comm but environ HAS the tag — should still be dormant
      // because the AND check rejects it.
      const reader = mockProcReader({
        [`/proc/${pid}/comm`]: 'bash\n',
        [`/proc/${pid}/environ`]: buildEnviron([
          `RALPH_MONITOR_SESSION=${sessId}`,
        ]),
      })

      const result = await reconcileSessionsOnStartup({
        platformOverride: 'linux',
        procReader: reader,
        db,
      })

      expect(result.liveOrphanedCount).toBe(0)
      expect(result.dormantCount).toBe(1)
      expect(result.entries[0]!.status).toBe('dormant')

      const row = getSessionById(db, sessId)
      expect(row!.process_pid).toBeNull()
      expect(row!.process_started_at).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("missing tag -> dormant (PID reuse: a different bun process)", async () => {
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { effortId } = createProject(db, { name: 'P', root_dir: dir })
      const sessId = crypto.randomUUID()
      const pid = 12345
      createSession(db, {
        id: sessId,
        effort_id: effortId,
        mode: 'autonomous',
        jsonl_path: '/tmp/s.jsonl',
        process_pid: pid,
        process_started_at: Date.now(),
      })

      // Right comm, but the environ does NOT contain our session tag —
      // a different bun process happens to have grabbed this pid.
      const reader = mockProcReader({
        [`/proc/${pid}/comm`]: 'bun\n',
        [`/proc/${pid}/environ`]: buildEnviron(['PATH=/usr/bin', 'TERM=xterm']),
      })

      const result = await reconcileSessionsOnStartup({
        platformOverride: 'linux',
        procReader: reader,
        db,
      })

      expect(result.liveOrphanedCount).toBe(0)
      expect(result.dormantCount).toBe(1)
      expect(result.entries[0]!.status).toBe('dormant')

      const row = getSessionById(db, sessId)
      expect(row!.process_pid).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('pid gone (procReader returns null for both) -> dormant', async () => {
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { effortId } = createProject(db, { name: 'P', root_dir: dir })
      const sessId = crypto.randomUUID()
      const pid = 12345
      createSession(db, {
        id: sessId,
        effort_id: effortId,
        mode: 'autonomous',
        jsonl_path: '/tmp/s.jsonl',
        process_pid: pid,
        process_started_at: Date.now(),
      })

      // Empty map: every read returns null (process exited / never existed).
      const reader = mockProcReader({})

      const result = await reconcileSessionsOnStartup({
        platformOverride: 'linux',
        procReader: reader,
        db,
      })

      expect(result.liveOrphanedCount).toBe(0)
      expect(result.dormantCount).toBe(1)
      expect(result.entries[0]!.status).toBe('dormant')
      expect(result.entries[0]!.reason).toContain('comm=null')

      const row = getSessionById(db, sessId)
      expect(row!.process_pid).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('different uuids: env tag for session A on session B is dormant for B', async () => {
    // Tightens the "exact-match against RALPH_MONITOR_SESSION=<uuid>"
    // contract: a process running session A's PTY child must NOT be matched
    // as session B's live-orphaned process.
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { effortId } = createProject(db, { name: 'P', root_dir: dir })
      const sessA = crypto.randomUUID()
      const sessB = crypto.randomUUID()
      const pidB = 12345

      // sessA is a "phantom" — it never enters the DB. The /proc state for
      // pidB carries sessA's uuid in its environ. sessB is what's in the DB
      // and what reconcile walks; the mismatch must produce 'dormant'.
      createSession(db, {
        id: sessB,
        effort_id: effortId,
        mode: 'autonomous',
        jsonl_path: '/tmp/sB.jsonl',
        process_pid: pidB,
        process_started_at: Date.now(),
      })

      const reader = mockProcReader({
        [`/proc/${pidB}/comm`]: 'bun\n',
        [`/proc/${pidB}/environ`]: buildEnviron([`RALPH_MONITOR_SESSION=${sessA}`]),
      })

      const result = await reconcileSessionsOnStartup({
        platformOverride: 'linux',
        procReader: reader,
        db,
      })

      expect(result.liveOrphanedCount).toBe(0)
      expect(result.dormantCount).toBe(1)
      expect(result.entries[0]!.status).toBe('dormant')

      const row = getSessionById(db, sessB)
      expect(row!.process_pid).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('mix: 3 sessions — one match, one wrong comm, one pid gone', async () => {
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { projectId, effortId: autoEffortId } = createProject(db, { name: 'P', root_dir: dir })
      // Three separate efforts so we can have three live PID rows
      // (partial-unique-index allows one live row per effort).
      const efforts: string[] = [autoEffortId]
      for (let i = 0; i < 2; i++) {
        const e = createEffort(db, { project_id: projectId, name: `E${i}`, kind: 'task' })
        efforts.push(e.id)
      }

      const sessMatch = crypto.randomUUID()
      const sessWrongComm = crypto.randomUUID()
      const sessGone = crypto.randomUUID()
      const pidMatch = 1111
      const pidWrong = 2222
      const pidGone = 3333

      createSession(db, {
        id: sessMatch, effort_id: efforts[0]!, mode: 'autonomous',
        jsonl_path: '/tmp/m.jsonl', process_pid: pidMatch, process_started_at: Date.now(),
      })
      createSession(db, {
        id: sessWrongComm, effort_id: efforts[1]!, mode: 'autonomous',
        jsonl_path: '/tmp/w.jsonl', process_pid: pidWrong, process_started_at: Date.now(),
      })
      createSession(db, {
        id: sessGone, effort_id: efforts[2]!, mode: 'autonomous',
        jsonl_path: '/tmp/g.jsonl', process_pid: pidGone, process_started_at: Date.now(),
      })

      const reader = mockProcReader({
        [`/proc/${pidMatch}/comm`]: 'bun\n',
        [`/proc/${pidMatch}/environ`]: buildEnviron([`RALPH_MONITOR_SESSION=${sessMatch}`]),
        [`/proc/${pidWrong}/comm`]: 'python3\n',
        [`/proc/${pidWrong}/environ`]: buildEnviron([`RALPH_MONITOR_SESSION=${sessWrongComm}`]),
        // pidGone is unmapped -> reads null
      })

      const result = await reconcileSessionsOnStartup({
        platformOverride: 'linux',
        procReader: reader,
        db,
      })

      expect(result.liveOrphanedCount).toBe(1)
      expect(result.dormantCount).toBe(2)
      expect(result.entries.length).toBe(3)

      // Assert per-row outcomes by matching on sessionId.
      const byId = new Map(result.entries.map((e) => [e.sessionId, e]))
      expect(byId.get(sessMatch)!.status).toBe('live-orphaned')
      expect(byId.get(sessWrongComm)!.status).toBe('dormant')
      expect(byId.get(sessGone)!.status).toBe('dormant')

      // DB-side: only the matching row keeps its pid.
      expect(getSessionById(db, sessMatch)!.process_pid).toBe(pidMatch)
      expect(getSessionById(db, sessWrongComm)!.process_pid).toBeNull()
      expect(getSessionById(db, sessGone)!.process_pid).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rows with NULL pid are not visited at all', async () => {
    const db = freshDb()
    const dir = tmpProjectDir()
    try {
      const { effortId } = createProject(db, { name: 'P', root_dir: dir })
      // Session with NULL pid — must not show up in entries.
      createSession(db, {
        id: crypto.randomUUID(),
        effort_id: effortId,
        mode: 'autonomous',
        jsonl_path: '/tmp/n.jsonl',
      })

      let calls = 0
      const reader: ProcReader = async () => { calls++; return null }

      const result = await reconcileSessionsOnStartup({
        platformOverride: 'linux',
        procReader: reader,
        db,
      })

      expect(result.entries.length).toBe(0)
      expect(calls).toBe(0)
      // Verify the helper actually filters too.
      expect(listSessionsWithPid(db).length).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
