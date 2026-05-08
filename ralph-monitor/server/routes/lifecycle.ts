// Lifecycle snapshot builder, used by the /events SSE handler at connect time
// AND directly testable as a pure function over a Database handle.
//
// Sent once per SSE client at connect time so the client has a complete view
// of projects + currently-live session ids before any incremental events
// arrive.

import type { Database } from 'bun:sqlite'
import { listProjects, type Project } from '../db'
import { listLiveSessionIds } from '../sessions/registry'

export interface LifecycleSnapshotPayload {
  type: 'lifecycle.snapshot'
  ts: number
  projects: Project[]
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
    live_session_ids: liveSessionIds ?? listLiveSessionIds(),
  }
}
