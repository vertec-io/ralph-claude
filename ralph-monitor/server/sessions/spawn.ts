// Spawn-primitive: prepareSpawn.
//
// US-005a-1 deliberately does NOT spawn the actual claude PTY child — that's
// US-005a-2's job. This file exposes a `prepareSpawn` function that does the
// pre-flight bookkeeping a real spawner needs:
//
//   1. Validate the effort exists (and reach the parent project so we can
//      fall back to project.root_dir if the effort/session don't override).
//   2. Resolve a working directory through the chain
//        session.working_dir ?? effort.working_dir ?? project.root_dir
//      and realpath it (typed error on failure — eg. ENOENT).
//   3. Pre-allocate a UUID for the session id (also the JSONL filename).
//   4. Compute the JSONL path under ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
//      using the per-character encoder confirmed in US-000a.
//   5. Refuse to insert if the effort already has a live session — JS-level
//      pre-check (the partial unique index in sqlite is on rows where
//      process_pid IS NOT NULL, so a row inserted here with NULL pid would
//      slip past it; the explicit pre-check enforces the invariant).
//   6. INSERT the row with process_pid = NULL.
//   7. Return the metadata (uuid, jsonlPath, resolvedCwd, projectRootDir)
//      that US-005a-2's actual spawner needs to call pty.spawn() and update
//      the row with the real pid.
//
// The whole thing runs under withEffortLock(effort_id) so two concurrent
// callers for the same effort serialize: the second one sees the first's
// inserted row in the JS-level pre-check and is rejected with the typed
// "already live" error.
//
// AC interpretation note (re: the prd.json line "If the partial-unique-index
// check fires (effort already has a live session), surfaces a 409 typed error
// and rolls back"): the partial unique index in sqlite is on
// `(effort_id) WHERE process_pid IS NOT NULL`, so it does NOT fire for a row
// inserted here with `process_pid = NULL`. We honor the *intent* of the AC
// (one prepareSpawn at a time per effort, refused if a live session exists)
// via the JS-level pre-check + the per-effort mutex. The mutex closes the
// otherwise-open TOCTOU window between the pre-check and the INSERT. We also
// keep the SQLite-level catch in place as a defense-in-depth — if a future
// schema change widens the partial index, or if a live row materializes via
// some other path between pre-check and insert (it shouldn't, but if), the
// catch surfaces it as the same typed error.

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { getDb } from '../db'
import { getEffortById } from '../db/efforts'
import { getProjectById } from '../db/projects'
import {
  createSession,
  listSessionsByEffort,
  OneLiveSessionPerEffortError,
} from '../db/sessions'
import { encodeClaudeProjectDir } from '../jsonl/paths'
import { withEffortLock } from './spawnMutex'

export class EffortNotFoundError extends Error {
  override readonly name = 'EffortNotFoundError'
}

export class CwdResolutionError extends Error {
  override readonly name = 'CwdResolutionError'
}

// Mirror of db-layer OneLiveSessionPerEffortError, surfaced at the prep
// boundary. Distinct class so callers can `instanceof` and translate to a
// 409 in the route layer without conflating it with the lower-level SQLite
// constraint error.
export class OneLiveSessionPerEffortPrepError extends Error {
  override readonly name = 'OneLiveSessionPerEffortPrepError'
}

export interface PrepareSpawnInput {
  effort_id: string
  mode: 'interactive' | 'autonomous'
  working_dir?: string
  title?: string
}

export interface PrepareSpawnResult {
  uuid: string
  jsonlPath: string
  resolvedCwd: string
  projectRootDir: string
}

export async function prepareSpawn(
  input: PrepareSpawnInput,
): Promise<PrepareSpawnResult> {
  return withEffortLock(input.effort_id, () => prepareSpawnInner(input))
}

async function prepareSpawnInner(
  input: PrepareSpawnInput,
): Promise<PrepareSpawnResult> {
  const db = getDb()

  const effort = getEffortById(db, input.effort_id)
  if (!effort) {
    throw new EffortNotFoundError(`effort not found: ${input.effort_id}`)
  }

  const project = getProjectById(db, effort.project_id)
  if (!project) {
    // Schema-wise this should never happen (FK on efforts.project_id), but
    // a corrupted DB or partial cascade is theoretically possible. Surface
    // the same EffortNotFound class — from the caller's perspective the
    // effort is unusable for spawning either way.
    throw new EffortNotFoundError(
      `project ${effort.project_id} for effort ${input.effort_id} not found`,
    )
  }

  // Working-dir resolution chain. Per the AC: session input wins, else
  // effort.working_dir, else project.root_dir. project.root_dir is already
  // realpath'd at insert (per US-001), so for that branch the realpath call
  // below is a no-op modulo edge cases like a deleted-since-creation dir.
  const candidate =
    input.working_dir ?? effort.working_dir ?? project.root_dir

  let resolvedCwd: string
  try {
    resolvedCwd = realpathSync.native(candidate)
  } catch (err) {
    throw new CwdResolutionError(
      `cannot resolve working_dir ${candidate}: ${(err as Error).message}`,
    )
  }
  // Defensive: realpathSync.native typically drops a trailing slash for
  // non-root paths, but we strip it here so the encoder doesn't get a
  // trailing `-` (and so the same inputs produce the same encoded output
  // regardless of the libc behavior).
  if (resolvedCwd.length > 1 && resolvedCwd.endsWith('/')) {
    resolvedCwd = resolvedCwd.slice(0, -1)
  }

  // JS-level pre-check for one-live-session-per-effort. The partial unique
  // index in sqlite is on `(effort_id) WHERE process_pid IS NOT NULL`, so a
  // row with NULL pid (which is what prepareSpawn inserts) does NOT trip
  // it. The lock above guarantees we're the only caller for this effort,
  // so the read+write is atomic in effect even though sqlite isn't enforcing
  // it.
  const existing = listSessionsByEffort(db, input.effort_id)
  const live = existing.find((s) => s.process_pid !== null)
  if (live) {
    throw new OneLiveSessionPerEffortPrepError(
      `effort ${input.effort_id} already has a live session: ${live.id}`,
    )
  }

  const uuid = crypto.randomUUID()
  const encoded = encodeClaudeProjectDir(resolvedCwd)
  // ~/.claude/projects/<encoded>/<uuid>.jsonl
  const home = process.env.HOME ?? homedir()
  const jsonlPath = path.join(home, '.claude', 'projects', encoded, `${uuid}.jsonl`)

  try {
    createSession(db, {
      id: uuid,
      effort_id: input.effort_id,
      mode: input.mode,
      jsonl_path: jsonlPath,
      working_dir: input.working_dir ?? null,
      title: input.title ?? null,
      process_pid: null,
      process_started_at: null,
    })
  } catch (err) {
    // Defense-in-depth: if a row with process_pid != null somehow trips the
    // partial unique index in between our pre-check and this INSERT (e.g.
    // a future schema widening or an out-of-band insert), surface it as
    // the same typed error so route handlers can translate uniformly.
    if (err instanceof OneLiveSessionPerEffortError) {
      throw new OneLiveSessionPerEffortPrepError(
        `effort ${input.effort_id} already has a live session (sqlite)`,
      )
    }
    throw err
  }

  return {
    uuid,
    jsonlPath,
    resolvedCwd,
    projectRootDir: project.root_dir,
  }
}
