// Lifecycle snapshot builder, used by the /events SSE handler at connect time
// AND directly testable as a pure function over a Database handle.
//
// AC (US-003): every new SSE client receives a `lifecycle.snapshot` event
// BEFORE any subsequent lifecycle events. The snapshot is the union of the
// REST hierarchy (projects + efforts) plus a list of session ids that are
// currently considered "live". The live-session-ids set is populated by the
// liveness registry in US-005a-2 / US-006; until that lands we emit `[]` here.

import type { Database } from 'bun:sqlite'
import { listAllEfforts, listProjects, type Effort, type Project } from '../db'

export interface LifecycleSnapshotPayload {
  type: 'lifecycle.snapshot'
  ts: number
  projects: Project[]
  efforts: Effort[]
  live_session_ids: string[]
}

export function buildLifecycleSnapshot(
  db: Database,
  liveSessionIds: string[] = [],
): LifecycleSnapshotPayload {
  return {
    type: 'lifecycle.snapshot',
    ts: Date.now(),
    projects: listProjects(db, {}),
    efforts: listAllEfforts(db),
    live_session_ids: liveSessionIds,
  }
}
