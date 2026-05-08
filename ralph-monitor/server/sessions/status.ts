// Computed session status.
//
// Status layers (in priority order):
//
//   live-attached   registry has an entry, handle.exited === false. We are
//                   driving the PTY; clients can WS-attach.
//   exited          registry has an entry, handle.exited === true. PTY child
//                   exited but we're inside the replay grace window.
//   live-orphaned   registry has NO entry but DB row's process_pid is non-null.
//                   Post-restart "found the process but lost the PTY parent".
//   external-owned  registry has NO entry, DB row's process_pid is null, BUT
//                   another process on the host has the JSONL fd open. This
//                   is the "claude --resume <id> running outside ralph-monitor"
//                   state. Surfaced async via enrichSessionStatus.
//   dormant         everything else — no process, no PTY, nobody holds the file.
//
// computeSessionStatus is sync and never sees external-owned (it's a fs probe).
// enrichSessionStatus runs the async owner check on top.

import type { Session } from '../db/sessions'
import { get as registryGet } from './registry'
import { findSessionOwner, type JsonlOwner } from './jsonlOwner'

export type ComputedSessionStatus =
  | 'dormant'
  | 'live-attached'
  | 'live-orphaned'
  | 'exited'
  | 'external-owned'

export function computeSessionStatus(session: Session): Exclude<ComputedSessionStatus, 'external-owned'> {
  const handle = registryGet(session.id)
  if (handle) {
    return handle.exited ? 'exited' : 'live-attached'
  }
  if (session.process_pid != null) return 'live-orphaned'
  return 'dormant'
}

export interface EnrichedStatus {
  status: ComputedSessionStatus
  external_owner: JsonlOwner | null
}

// Async enricher: call findJsonlOwner only if the sync status is 'dormant'.
// For all other states, an external owner is irrelevant (we already have a
// stronger signal).
export async function enrichSessionStatus(session: Session): Promise<EnrichedStatus> {
  const base = computeSessionStatus(session)
  if (base !== 'dormant') return { status: base, external_owner: null }
  const owner = await findSessionOwner(session.id)
  if (owner) return { status: 'external-owned', external_owner: owner }
  return { status: 'dormant', external_owner: null }
}
