// Migration runner + schema invariants — exercised against a fresh in-memory
// DB on every test so each case is fully isolated. We deliberately don't
// touch ./index.ts here because that resolves a real on-disk path; the
// migration runner is the contract under test.

import { describe, expect, test } from 'bun:test'
import { Database, SQLiteError } from 'bun:sqlite'
import { runMigrations } from './migrate'

function freshDb(): Database {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db)
  return db
}

describe('runMigrations', () => {
  test('creates projects, efforts, and sessions tables', () => {
    const db = freshDb()
    const rows = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all() as { name: string }[]
    const names = new Set(rows.map(r => r.name))
    expect(names.has('projects')).toBe(true)
    expect(names.has('efforts')).toBe(true)
    expect(names.has('sessions')).toBe(true)
  })

  test('sets PRAGMA user_version to the latest migration version on first run', () => {
    const db = freshDb()
    const v = db.query('PRAGMA user_version').get() as { user_version: number }
    // Version 3 is the current latest migration (migration 3 drops the one-live-per-effort index).
    expect(v.user_version).toBe(3)
  })

  test('is a no-op when run twice', () => {
    const db = freshDb()
    // Second run must not throw and must not bump user_version past the latest.
    expect(() => runMigrations(db)).not.toThrow()
    const v = db.query('PRAGMA user_version').get() as { user_version: number }
    expect(v.user_version).toBe(3)
  })
})

describe('schema invariants', () => {
  test('multiple live sessions per effort are now allowed (constraint lifted by migration 3)', () => {
    // Migration 3 drops idx_sessions_one_live_per_effort so multiple sessions
    // with a non-null process_pid can coexist under the same effort.
    const db = freshDb()
    const now = Date.now()
    db.run(
      'INSERT INTO projects (id, name, root_dir, created_at) VALUES (?, ?, ?, ?)',
      ['p1', 'P', '/tmp/p1', now],
    )
    db.run(
      `INSERT INTO efforts (id, project_id, name, kind, created_at)
       VALUES (?, ?, ?, 'general', ?)`,
      ['e1', 'p1', 'General', now],
    )
    // First live session: pid set.
    db.run(
      `INSERT INTO sessions (id, effort_id, jsonl_path, mode, process_pid, created_at)
       VALUES (?, ?, ?, 'autonomous', ?, ?)`,
      ['s1', 'e1', '/tmp/s1.jsonl', 1234, now],
    )
    // Second live session for the same effort must now SUCCEED.
    expect(() =>
      db.run(
        `INSERT INTO sessions (id, effort_id, jsonl_path, mode, process_pid, created_at)
         VALUES (?, ?, ?, 'autonomous', ?, ?)`,
        ['s2', 'e1', '/tmp/s2.jsonl', 5678, now],
      ),
    ).not.toThrow()

    // Terminated session (process_pid IS NULL) is also fine.
    expect(() =>
      db.run(
        `INSERT INTO sessions (id, effort_id, jsonl_path, mode, created_at)
         VALUES (?, ?, ?, 'autonomous', ?)`,
        ['s3', 'e1', '/tmp/s3.jsonl', now],
      ),
    ).not.toThrow()

    // Verify all three rows exist.
    const count = db.query('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    expect(count.n).toBe(3)
  })

  test('FK cascade deletes efforts and sessions when project is removed', () => {
    const db = freshDb()
    const now = Date.now()
    db.run(
      'INSERT INTO projects (id, name, root_dir, created_at) VALUES (?, ?, ?, ?)',
      ['p1', 'P', '/tmp/p1', now],
    )
    db.run(
      `INSERT INTO efforts (id, project_id, name, kind, created_at)
       VALUES (?, ?, ?, 'general', ?)`,
      ['e1', 'p1', 'General', now],
    )
    db.run(
      `INSERT INTO sessions (id, effort_id, jsonl_path, mode, created_at)
       VALUES (?, ?, ?, 'autonomous', ?)`,
      ['s1', 'e1', '/tmp/s1.jsonl', now],
    )

    db.run('DELETE FROM projects WHERE id = ?', ['p1'])

    const efforts = db.query('SELECT COUNT(*) AS n FROM efforts').get() as { n: number }
    const sessions = db.query('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    expect(efforts.n).toBe(0)
    expect(sessions.n).toBe(0)
  })

  test("kind='prd' requires a non-null, non-empty prd_path", () => {
    const db = freshDb()
    const now = Date.now()
    db.run(
      'INSERT INTO projects (id, name, root_dir, created_at) VALUES (?, ?, ?, ?)',
      ['p1', 'P', '/tmp/p1', now],
    )

    // NULL prd_path with kind='prd' must fail.
    let nullErr: unknown
    try {
      db.run(
        `INSERT INTO efforts (id, project_id, name, kind, prd_path, created_at)
         VALUES (?, ?, ?, 'prd', NULL, ?)`,
        ['e_null', 'p1', 'Nullish', now],
      )
    } catch (e) { nullErr = e }
    expect(nullErr).toBeInstanceOf(SQLiteError)
    expect(String((nullErr as Error).message)).toMatch(/CHECK/i)

    // Empty-string prd_path with kind='prd' must also fail.
    let emptyErr: unknown
    try {
      db.run(
        `INSERT INTO efforts (id, project_id, name, kind, prd_path, created_at)
         VALUES (?, ?, ?, 'prd', '', ?)`,
        ['e_empty', 'p1', 'Emptyish', now],
      )
    } catch (e) { emptyErr = e }
    expect(emptyErr).toBeInstanceOf(SQLiteError)
    expect(String((emptyErr as Error).message)).toMatch(/CHECK/i)

    // Sanity: a valid prd_path is accepted.
    expect(() =>
      db.run(
        `INSERT INTO efforts (id, project_id, name, kind, prd_path, created_at)
         VALUES (?, ?, ?, 'prd', '/tmp/prd.json', ?)`,
        ['e_ok', 'p1', 'OK', now],
      ),
    ).not.toThrow()
  })
})
