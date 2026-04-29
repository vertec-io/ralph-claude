// WebSocket PTY bridge — US-005b.
//
// Per-session WS attachment manager. The PTY handle registry (US-005a-1) is
// the source of truth for live PTY children; this module is the source of
// truth for "which WebSocket clients are currently attached to which
// session". One PTY can have many WS clients (broadcast); each WS belongs to
// exactly one session.
//
// Framing convention (per US-005b AC):
//   - PTY  -> WS:  raw binary frame for output bytes (`ws.send(chunk)`).
//                  JSON text frame for control messages (exit, error).
//   - WS   -> PTY: JSON text frame ONLY. Two message types accepted:
//                    {type:'input',  data: string}        -> pty.write(data)
//                    {type:'resize', cols: n, rows: n}    -> pty.resize(cols,rows)
//                  Binary frames inbound are reserved for future use and
//                  silently ignored.
//
// Exit handling: when the PTY exits, we broadcast `{type:'exit', code: N}`
// as a text frame to every attached client and close their connections with
// code 1000 ('pty_exit'). DB row clearing, registry.unregister, and the
// session.exited store event are handled by spawnSession's own onExit
// subscriber (wired in US-005a-2) — wsBridge does NOT duplicate that work.
//
// Lifecycle of an attached client:
//   open    -> attachWsToSession(ws): registry.get(sessionId), subscribe to
//              onData/onExit, add to attachedBySession map.
//   message -> handleWsMessage(ws, data): parse JSON, route to write/resize.
//   close   -> detachWsFromSession(ws): dispose data/exit subscriptions,
//              remove from attachedBySession map.
//
// Auth is NOT validated in this module. The caller (server/index.ts fetch
// handler) MUST validate the bearer subprotocol via
// validateWebSocketSubprotocol before calling server.upgrade — this module
// trusts that any ws it sees has already passed auth.

import type { ServerWebSocket } from 'bun'
import * as registry from './registry'

export interface WsBridgeData {
  sessionId: string
}

interface AttachedClient {
  ws: ServerWebSocket<WsBridgeData>
  unsubscribeData: () => void
  unsubscribeExit: () => void
}

// Module-private map: sessionId -> set of clients attached to that session.
// Multi-attach is permitted (multiple browser tabs / panes on the same
// session) so we use a Set rather than a single client. The map entry is
// removed when the last client detaches, which keeps `attachedBySession`
// from growing unboundedly across long-running processes.
const attachedBySession = new Map<string, Set<AttachedClient>>()

export function attachWsToSession(ws: ServerWebSocket<WsBridgeData>): void {
  const { sessionId } = ws.data
  const handle = registry.get(sessionId)
  if (!handle) {
    // Session id valid in the URL path but no live handle in the registry.
    // Could mean: session was killed between auth and open, or the id was
    // bogus. Return a control-channel error so the client can distinguish
    // this from a transport-level failure, then close with a 4xxx code so
    // the browser surfaces it cleanly.
    try {
      ws.send(JSON.stringify({ type: 'error', error: 'session_not_found' }))
    } catch {
      // If even the send fails (already closed), nothing useful to do.
    }
    ws.close(4404, 'session_not_found')
    return
  }

  // PTY -> WS: raw binary frame per chunk. Bun's ws.send dispatches to
  // sendBinary when the argument is a BufferSource (Uint8Array passes), so
  // the receiver sees a binary message. We do NOT JSON-wrap here because
  // the AC mandates a binary frame and round-tripping every byte through
  // JSON would balloon traffic and hide the text/binary opcode the client
  // uses to disambiguate data from control.
  const unsubscribeData = handle.onData((chunk: Uint8Array) => {
    try {
      ws.send(chunk)
    } catch {
      // Send may fail if the socket was closed mid-flight; the close handler
      // will detach us shortly. Swallow so we don't crash the PTY.
    }
  })

  // PTY exit: broadcast JSON {type:'exit', code} and close with 1000.
  // The DB/registry cleanup is handled by spawnSession's own onExit hook
  // (US-005a-2) — see spawn.ts step 9. We subscribe AFTER that one, but
  // the order of subscriber dispatch within bun-pty isn't guaranteed; that
  // doesn't matter here because our work (broadcast + close) is independent
  // of whatever spawnSession's subscriber does.
  const unsubscribeExit = handle.onExit((exit) => {
    try {
      ws.send(JSON.stringify({ type: 'exit', code: exit.exitCode }))
    } catch {
      // see comment in unsubscribeData
    }
    try {
      ws.close(1000, 'pty_exit')
    } catch {
      // already closed; nothing to do
    }
  })

  let set = attachedBySession.get(sessionId)
  if (!set) {
    set = new Set<AttachedClient>()
    attachedBySession.set(sessionId, set)
  }
  set.add({ ws, unsubscribeData, unsubscribeExit })
}

export function detachWsFromSession(ws: ServerWebSocket<WsBridgeData>): void {
  const { sessionId } = ws.data
  const set = attachedBySession.get(sessionId)
  if (!set) return
  for (const client of set) {
    if (client.ws === ws) {
      try { client.unsubscribeData() } catch {}
      try { client.unsubscribeExit() } catch {}
      set.delete(client)
    }
  }
  if (set.size === 0) attachedBySession.delete(sessionId)
}

export function handleWsMessage(
  ws: ServerWebSocket<WsBridgeData>,
  data: string | Buffer,
): void {
  // Binary frames are reserved for a future direction (e.g. the client
  // forwarding a paste containing NULs without UTF-8 round-tripping). For
  // US-005b we only accept JSON text frames as control + input messages.
  if (typeof data !== 'string') return

  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    // Malformed JSON is silently dropped — we don't want a single bad frame
    // to tear down the connection. A future version could send back an
    // error frame; not in scope for US-005b.
    return
  }
  if (!parsed || typeof parsed !== 'object') return
  const msg = parsed as {
    type?: unknown
    data?: unknown
    cols?: unknown
    rows?: unknown
  }

  const handle = registry.get(ws.data.sessionId)
  if (!handle) {
    // The PTY exited between our open and this message. The exit handler
    // will close the WS shortly; until then, drop the message.
    return
  }

  switch (msg.type) {
    case 'input': {
      if (typeof msg.data === 'string') {
        try { handle.write(msg.data) } catch {}
      }
      break
    }
    case 'resize': {
      if (typeof msg.cols === 'number' && typeof msg.rows === 'number') {
        try { handle.resize(msg.cols, msg.rows) } catch {}
      }
      break
    }
    default:
      // Unknown control type — ignore. Don't echo errors; old clients on
      // newer servers (or vice versa) can negotiate by feature detection.
      break
  }
}

// Test-only escape hatch — exposes attachment counts so tests can assert
// clean detach without depending on internals. Mirrors the registry's
// `__test__` namespace.
export const __test__ = {
  attachedCount(sessionId: string): number {
    return attachedBySession.get(sessionId)?.size ?? 0
  },
  totalSessions(): number {
    return attachedBySession.size
  },
  clear(): void {
    attachedBySession.clear()
  },
}
