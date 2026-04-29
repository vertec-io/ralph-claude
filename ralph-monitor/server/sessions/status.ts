// Computed session status (US-006).
//
// The DB row's `process_pid` and the in-memory PtyHandle registry together
// determine what a session is doing right now:
//
//   live-attached  registry has an entry AND handle.exited === false. We're
//                  actively driving a PTY for this session; clients can WS-
//                  attach and stream output.
//   exited         registry has an entry AND handle.exited === true. The
//                  PTY's child process has exited but we're still inside the
//                  RALPH_MONITOR_PTY_GRACE_MS replay window — clients that
//                  attach now still see the final output via the ring buffer.
//                  After the grace window the entry is unregistered and the
//                  status drops to 'dormant'.
//   live-orphaned  registry has NO entry AND DB row's process_pid is non-null.
//                  This is the post-restart "we found the process but lost the
//                  PTY parent" state. Reconciliation runs only at startup
//                  (server/sessions/reconcile.ts), so the DB row's process_pid
//                  is whatever reconciliation decided to keep there.
//   dormant        registry has NO entry AND DB row's process_pid is null.
//                  No process, no PTY — the row is history.
//
// The route layer surfaces this via GET /api/sessions/:id along with a
// `live` / `attached` boolean pair — `live` is true for both live-attached
// and live-orphaned (a process is running somewhere), `attached` is true
// only for live-attached (we have a PTY handle).

import type { Session } from '../db/sessions'
import { get as registryGet } from './registry'

export type ComputedSessionStatus =
  | 'dormant'
  | 'live-attached'
  | 'live-orphaned'
  | 'exited'

export function computeSessionStatus(session: Session): ComputedSessionStatus {
  const handle = registryGet(session.id)
  if (handle) {
    return handle.exited ? 'exited' : 'live-attached'
  }
  if (session.process_pid != null) return 'live-orphaned'
  return 'dormant'
}
