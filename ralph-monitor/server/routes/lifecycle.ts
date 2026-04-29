// Lifecycle snapshot builder, used by the /events SSE handler at connect time
// AND directly testable as a pure function over a Database handle.
//
// AC (US-003): every new SSE client receives a `lifecycle.snapshot` event
// BEFORE any subsequent lifecycle events. The snapshot is the union of the
// REST hierarchy (projects + efforts) plus the list of session ids that are
// currently considered "live" — pulled directly from the live PTY handle
// registry (US-005a-1). US-005a-2 keeps the registry in sync with actual PTY
// lifetimes; this builder is a read-only consumer.
//
// `liveSessionIds` is still accepted as an optional override so tests can
// pin a specific list without seeding the global registry. In production
// (server/index.ts), the override is omitted and the registry is the
// source of truth.

import type { Database } from 'bun:sqlite'
import { listAllEfforts, listProjects, type Effort, type Project } from '../db'
import { listLiveSessionIds } from '../sessions/registry'

export interface LifecycleSnapshotPayload {
  type: 'lifecycle.snapshot'
  ts: number
  projects: Project[]
  efforts: Effort[]
  live_session_ids: string[]
}

export function buildLifecycleSnapshot(
  db: Database,
  liveSessionIds?: string[],
): LifecycleSnapshotPayload {
  return {
    type: 'lifecycle.snapshot',
    ts: Date.now(),
    projects: listProjects(db, {}),
    efforts: listAllEfforts(db),
    live_session_ids: liveSessionIds ?? listLiveSessionIds(),
  }
}
