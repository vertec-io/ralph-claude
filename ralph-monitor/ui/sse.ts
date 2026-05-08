import { useEffect, useRef, useState } from 'react'
import type { ServerSnapshot, AppEvent } from '../server/types'
import { authFetch, authEventSource, getToken } from './auth'

export interface StreamState {
  snapshot: ServerSnapshot | null
  connected: boolean
}

export function useServerStream(): StreamState {
  const [snapshot, setSnapshot] = useState<ServerSnapshot | null>(null)
  const [connected, setConnected] = useState(false)
  const evtSrc = useRef<EventSource | null>(null)

  useEffect(() => {
    let cancelled = false
    let es: EventSource | null = null

    // Block on token fetch first — the SSE connection below uses the
    // synchronous token accessor, which requires the cache to be warm. If the
    // server isn't up yet we just bail; the user will see the "connecting…"
    // placeholder and a refresh will retry.
    async function bootstrap(): Promise<boolean> {
      try {
        await getToken()
        if (cancelled) return false
        const r = await authFetch('/api/state')
        if (!r.ok) return true // token loaded; just couldn't fetch state. Continue to SSE.
        const initial = (await r.json()) as ServerSnapshot
        if (!cancelled) setSnapshot(initial)
        return true
      } catch {
        return false
      }
    }

    bootstrap().then((ok) => {
      if (cancelled || !ok) return
      es = authEventSource('/events')
      evtSrc.current = es

      es.onopen = () => setConnected(true)
      es.onerror = () => setConnected(false)

      es.addEventListener('state', (e) => {
        try { setSnapshot(JSON.parse((e as MessageEvent).data) as ServerSnapshot) } catch {}
      })

      es.addEventListener('update', (e) => {
        // Any update → re-fetch full state (cheap; ≤10 PRDs locally).
        // Also push the event into the live feed immediately.
        try {
          const evt = JSON.parse((e as MessageEvent).data) as AppEvent
          setSnapshot(prev => prev ? { ...prev, events: [evt, ...prev.events].slice(0, 100) } : prev)
        } catch {}
        authFetch('/api/state')
          .then(r => r.json())
          .then(s => { if (!cancelled) setSnapshot(s) })
          .catch(() => {})
      })
    })

    return () => {
      cancelled = true
      if (es) es.close()
    }
  }, [])

  return { snapshot, connected }
}
