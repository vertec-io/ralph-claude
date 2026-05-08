// Raw PTY stream view (US-011).
//
// Mounts an xterm.js terminal on demand and connects it to the session's
// /ws/sessions/:id WebSocket. The WebSocket protocol (US-005b/c) is:
//
//   server -> client:
//     - JSON `{ type: 'replay', size }` envelope, immediately followed by
//       a single binary frame containing the replay buffer.
//     - Binary frames thereafter for live PTY output.
//     - JSON `{ type: 'exit', code }` when the PTY exits.
//     - JSON `{ type: 'error', error }` for transport-level problems.
//
//   client -> server:
//     - JSON `{ type: 'input', data }` for keyboard input.
//     - JSON `{ type: 'resize', cols, rows }` whenever the fit-addon resizes.
//
// Stream mode is disabled whenever the session is not `live-attached`. The
// component renders a neutral placeholder in that case; the parent (US-016a)
// is responsible for the toggle UI that hides the Stream button entirely
// when this disabled state would persist for the rest of the session
// (`exited`).
//
// Hedges:
//
//   - We deliberately skip xterm-addon-attach. The default attach addon
//     piping the entire WebSocket through xterm collides with our control
//     envelope (replay/exit/error JSON). Manual wiring keeps the binary
//     vs. text dispatch in our hands.
//
//   - `expectingReplayBinary` is a tiny FSM bit. The server's contract is
//     that the FIRST binary frame after a replay envelope IS the replay; we
//     write it to xterm the same way as live data, so the user sees the
//     terminal redrawn from the buffer before live data appends. This means
//     we don't actually need to differentiate replay from live writes — we
//     keep the flag for clarity / future hooks (e.g., if we ever want to
//     show a "buffer restored" toast).
//
//   - `term.write` accepts Uint8Array directly (xterm 5.x). We avoid Blob
//     handling by forcing `binaryType = 'arraybuffer'` on the socket. Bun's
//     server-side WebSocket also speaks ArrayBuffer for binary by default,
//     but the BROWSER WebSocket defaults to Blob — so the explicit setting
//     is required.

import { useEffect, useRef } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'

export interface SessionStreamProps {
  sessionId: string
  // Status from US-006 / US-016b — passed in by the parent. Stream is enabled
  // only when status === 'live-attached'.
  status: 'dormant' | 'live-attached' | 'live-orphaned' | 'exited' | 'external-owned'
  // The auth wrapper from US-004. Taking it as a prop keeps the component
  // testable without monkey-patching the auth module.
  authWebSocket: (url: string) => WebSocket
}

export function SessionStream({ sessionId, status, authWebSocket }: SessionStreamProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (status !== 'live-attached') return

    const container = containerRef.current
    if (!container) return

    // Defer xterm creation until the container has real dimensions. xterm
    // 5.x's internal Viewport refresh crashes ("Cannot read 'dimensions' of
    // undefined") if it runs before the render service has measured the
    // canvas, which only happens once the host element is sized and
    // attached. So we wait via ResizeObserver, then create the Terminal.
    let term: Terminal | null = null
    let fit: FitAddon | null = null
    let ws: WebSocket | null = null
    let inputDispose: { dispose: () => void } | null = null
    let onResize: (() => void) | null = null
    let disposed = false

    const init = () => {
      if (disposed || term) return
      const rect = container.getBoundingClientRect()
      if (rect.width < 10 || rect.height < 10) return // wait for real size

      term = new Terminal({
        cursorBlink: true,
        fontFamily: '"Fira Code", monospace',
        fontSize: 13,
        theme: { background: '#0f1419' },
      })
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(container)
      try { fit.fit() } catch {}

      termRef.current = term
      fitRef.current = fit

      // Wire WebSocket now that the terminal exists.
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const url = `${proto}://${window.location.host}/ws/sessions/${sessionId}`
      ws = authWebSocket(url)
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws

      let expectingReplayBinary = false

      ws.onopen = () => {
        try {
          ws?.send(JSON.stringify({ type: 'resize', cols: term!.cols, rows: term!.rows }))
        } catch {}
      }

      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          let parsed: unknown
          try { parsed = JSON.parse(ev.data) } catch { return }
          if (parsed && typeof parsed === 'object') {
            const obj = parsed as Record<string, unknown>
            if (obj.type === 'replay' && typeof obj.size === 'number') {
              expectingReplayBinary = true
              return
            }
            if (obj.type === 'exit') {
              try { term?.write(`\r\n[PTY exited with code ${String(obj.code ?? '?')}]\r\n`) } catch {}
              return
            }
            if (obj.type === 'error') {
              try { term?.write(`\r\n[Error: ${String(obj.error ?? 'unknown')}]\r\n`) } catch {}
              return
            }
          }
          return
        }
        const data = ev.data
        if (!(data instanceof ArrayBuffer)) return
        const buf = new Uint8Array(data)
        if (expectingReplayBinary) expectingReplayBinary = false
        try { term?.write(buf) } catch {}
      }

      ws.onclose = () => { try { term?.write('\r\n[Connection closed]\r\n') } catch {} }

      inputDispose = term.onData((data: string) => {
        try { ws?.send(JSON.stringify({ type: 'input', data })) } catch {}
      })

      onResize = () => {
        try { fit?.fit() } catch {}
        try {
          if (term) ws?.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        } catch {}
      }
      window.addEventListener('resize', onResize)
    }

    // ResizeObserver triggers init when container becomes non-zero, AND
    // refits when size changes after init.
    const ro = new ResizeObserver(() => {
      if (!term) {
        init()
      } else {
        try { fit?.fit() } catch {}
        try {
          ws?.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
        } catch {}
      }
    })
    ro.observe(container)
    // Try once immediately in case the container is already sized.
    init()

    // Intercept Shift+Enter at capture phase, beating xterm's bubble-phase
    // listener. xterm doesn't differentiate Shift+Enter from plain Enter
    // (both → \r); we send \x1b\r (canonical Alt+Enter) which claude-code's
    // TUI treats as a literal newline within the input box.
    const onContainerKeyDown = (e: KeyboardEvent) => {
      const isEnter =
        e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter'
      if (!isEnter || !e.shiftKey) return
      e.preventDefault()
      e.stopPropagation()
      try { wsRef.current?.send(JSON.stringify({ type: 'input', data: '\x1b\r' })) } catch {}
    }
    container.addEventListener('keydown', onContainerKeyDown, { capture: true })

    return () => {
      disposed = true
      ro.disconnect()
      if (onResize) window.removeEventListener('resize', onResize)
      container.removeEventListener('keydown', onContainerKeyDown, { capture: true })
      try { ws?.close() } catch {}
      try { inputDispose?.dispose() } catch {}
      try { term?.dispose() } catch {}
      termRef.current = null
      fitRef.current = null
      wsRef.current = null
    }
  }, [sessionId, status, authWebSocket])

  if (status !== 'live-attached') {
    const reason =
      status === 'dormant'
        ? 'Session is dormant. Resume to enable Stream mode.'
        : status === 'live-orphaned'
          ? 'PTY unreachable. Kill & resume to enable Stream mode.'
          : status === 'exited'
            ? 'Session exited. Resume to enable Stream mode.'
            : 'Stream unavailable.'
    return (
      <div
        data-testid="stream-disabled"
        className="p-4 text-sm text-gray-500"
        title={reason}
      >
        {reason}
      </div>
    )
  }

  return (
    <div
      data-testid="stream-active"
      ref={containerRef}
      className="h-full w-full"
    />
  )
}
