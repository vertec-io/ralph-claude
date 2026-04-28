import { useEffect, useRef, useState } from 'react'
import type { ServerSnapshot, AppEvent } from '../server/types'

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

    async function bootstrap() {
      try {
        const r = await fetch('/api/state')
        if (!r.ok) return
        const initial = (await r.json()) as ServerSnapshot
        if (!cancelled) setSnapshot(initial)
      } catch { /* server not up yet */ }
    }

    bootstrap()

    const es = new EventSource('/events')
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
      fetch('/api/state')
        .then(r => r.json())
        .then(s => { if (!cancelled) setSnapshot(s) })
        .catch(() => {})
    })

    return () => {
      cancelled = true
      es.close()
    }
  }, [])

  return { snapshot, connected }
}
