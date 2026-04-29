// useEffortSnapshot — fetches and keeps fresh the PRDRecord snapshot for a
// single kind='prd' effort via GET /api/efforts/:id/snapshot.
//
// The hook performs an initial fetch on mount / effortId change and
// re-fetches whenever the server broadcasts an `effort.snapshot.updated`
// event whose `effort_id` matches.  This is wired via the /events SSE channel
// using `authEventSource` — the same pattern as useServerStream in sse.ts.
//
// If the endpoint returns a non-2xx response (e.g. 404 for a non-prd effort)
// the snapshot is set to null.  { status: 'pending' } is returned as-is when
// the underlying prd.json file doesn't exist yet on disk.

import { useState, useEffect } from 'react'
import type { PRDRecord } from '../../server/types'
import { authFetch, authEventSource, getToken } from '../auth'

export function useEffortSnapshot(effortId: string | null): PRDRecord | null {
  const [snapshot, setSnapshot] = useState<PRDRecord | null>(null)

  useEffect(() => {
    if (!effortId) {
      setSnapshot(null)
      return
    }

    let cancelled = false

    const fetchOnce = async (): Promise<void> => {
      try {
        const res = await authFetch(`/api/efforts/${effortId}/snapshot`)
        if (!res.ok) {
          if (!cancelled) setSnapshot(null)
          return
        }
        const data = (await res.json()) as PRDRecord
        if (!cancelled) setSnapshot(data)
      } catch {
        if (!cancelled) setSnapshot(null)
      }
    }

    // Initial fetch + SSE subscription.
    // We block on getToken() first (same pattern as useServerStream) so the
    // EventSource sub-protocol has a warm token by the time it opens.
    let es: EventSource | null = null

    getToken()
      .then(() => {
        if (cancelled) return
        fetchOnce()

        // Subscribe to the /events SSE channel and re-fetch when the server
        // signals that this effort's snapshot has changed.
        es = authEventSource('/events')

        es.addEventListener('update', (e) => {
          try {
            const evt = JSON.parse((e as MessageEvent).data) as {
              type: string
              effort_id?: string
            }
            if (
              evt.type === 'effort.snapshot.updated' &&
              evt.effort_id === effortId &&
              !cancelled
            ) {
              fetchOnce()
            }
          } catch {
            // ignore malformed events
          }
        })
      })
      .catch(() => {
        // If token fetch fails, snapshot stays null — caller sees nothing.
      })

    return () => {
      cancelled = true
      if (es) es.close()
    }
  }, [effortId])

  return snapshot
}
