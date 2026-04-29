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
  status: 'dormant' | 'live-attached' | 'live-orphaned' | 'exited'
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

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"Fira Code", monospace',
      fontSize: 13,
      theme: { background: '#0f1419' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()

    termRef.current = term
    fitRef.current = fit

    // Window resize -> fit + send resize to PTY.
    const onResize = () => {
      try {
        fit.fit()
        const cols = term.cols
        const rows = term.rows
        wsRef.current?.send(JSON.stringify({ type: 'resize', cols, rows }))
      } catch {
        // best-effort; resize before WS open is harmless to drop
      }
    }
    window.addEventListener('resize', onResize)

    // Open WebSocket.
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${window.location.host}/ws/sessions/${sessionId}`
    const ws = authWebSocket(url)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    let expectingReplayBinary = false

    ws.onopen = () => {
      // Send initial resize so the PTY's cols/rows match the terminal we
      // just laid out. The server is free to ignore if it has its own
      // policy; we still want to ask.
      try {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      } catch {
        // ignore
      }
    }

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        // Control frame: replay envelope, exit, error.
        let parsed: unknown
        try {
          parsed = JSON.parse(ev.data)
        } catch {
          return
        }
        if (parsed && typeof parsed === 'object') {
          const obj = parsed as Record<string, unknown>
          if (obj.type === 'replay' && typeof obj.size === 'number') {
            expectingReplayBinary = true
            return
          }
          if (obj.type === 'exit') {
            term.write(`\r\n[PTY exited with code ${String(obj.code ?? '?')}]\r\n`)
            return
          }
          if (obj.type === 'error') {
            term.write(`\r\n[Error: ${String(obj.error ?? 'unknown')}]\r\n`)
            return
          }
        }
        return
      }
      // Binary frame.
      const data = ev.data
      let buf: Uint8Array
      if (data instanceof ArrayBuffer) {
        buf = new Uint8Array(data)
      } else {
        // We forced `arraybuffer` above; this branch is defensive only.
        // Ignore unrecognized frame shapes rather than crashing the term.
        return
      }
      if (expectingReplayBinary) {
        // First binary frame after a replay envelope IS the replay buffer.
        // We write it to the terminal exactly like a live frame so the
        // session is "redrawn" before live data appends.
        expectingReplayBinary = false
      }
      term.write(buf)
    }

    ws.onclose = () => {
      term.write('\r\n[Connection closed]\r\n')
    }

    // Term input -> WS.
    const inputDispose = term.onData((data: string) => {
      try {
        ws.send(JSON.stringify({ type: 'input', data }))
      } catch {
        // ignore — most likely the socket closed mid-keystroke
      }
    })

    return () => {
      window.removeEventListener('resize', onResize)
      try {
        ws.close()
      } catch {
        // ignore
      }
      inputDispose.dispose()
      term.dispose()
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
