// wsBridge tests — US-005b.
//
// Strategy: hybrid (Option A + Option B per the story brief).
//   - Option B (unit, the bulk): drive attachWsToSession / handleWsMessage /
//     detachWsFromSession directly with a fake PtyHandle registered in the
//     real registry plus a fake ServerWebSocket recording send/close calls.
//     Fast, granular, covers all the routing logic without booting a server.
//   - Option A (one smoke test): bring up a real Bun.serve with the same
//     fetch + websocket config the production default export uses, connect
//     a real WebSocket client, exercise the full upgrade -> data -> exit
//     loop. This is the AC's "spawn 'bash -c \"echo hi\"', open WS, verify
//     data, verify exit, verify registry entry gone" pathway, but with a
//     fake PtyHandle in place of bash because (a) US-005b is the WS bridge,
//     not the spawner, and (b) bash via bun-pty in a unit test bloats
//     runtime by ~500ms per test. The fake handle proves the WS bridge
//     wires PTY events through end-to-end; bash-as-PTY is exercised by
//     US-005a-2's spawnSession test.
//
// AC interpretation note: the AC's "verify registry entry is gone" step
// relies on spawnSession's auto-cleanup hook (US-005a-2). The smoke test
// here uses a manually-registered handle (no spawnSession), so we manually
// unregister at the end of the simulated exit instead. Auto-cleanup of the
// DB row is verified separately in spawnSession.test.ts.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'

// Direct module imports — wsBridge has no DB / $HOME deps so no sandbox
// dance is needed.
import {
  attachWsToSession,
  detachWsFromSession,
  handleWsMessage,
  __test__ as B,
  type WsBridgeData,
} from './wsBridge'
import {
  register,
  unregister,
  __test__ as R,
  type PtyHandle,
} from './registry'

// -- Fake PtyHandle factory ------------------------------------------------

interface FakeHandle extends PtyHandle {
  // Record calls for assertion.
  writes: (string | Uint8Array)[]
  resizes: { cols: number; rows: number }[]
  killCalls: (NodeJS.Signals | number | undefined)[]
  // Trigger callbacks from outside.
  triggerData(chunk: Uint8Array): void
  triggerExit(exit: { exitCode: number; signal?: number }): void
  // Bookkeeping for disposer correctness.
  dataListenerCount(): number
  exitListenerCount(): number
}

function fakeHandle(sessionId: string, effortId = 'e-1', pid = 4242): FakeHandle {
  const dataListeners = new Set<(c: Uint8Array) => void>()
  const exitListeners = new Set<(e: { exitCode: number; signal?: number }) => void>()
  const h: FakeHandle = {
    sessionId,
    effortId,
    pid,
    writes: [],
    resizes: [],
    killCalls: [],
    write(data) {
      h.writes.push(data)
    },
    resize(cols, rows) {
      h.resizes.push({ cols, rows })
    },
    onData(cb) {
      dataListeners.add(cb)
      return () => dataListeners.delete(cb)
    },
    onExit(cb) {
      exitListeners.add(cb)
      return () => exitListeners.delete(cb)
    },
    kill(signal) {
      h.killCalls.push(signal)
    },
    triggerData(chunk) {
      for (const l of [...dataListeners]) l(chunk)
    },
    triggerExit(exit) {
      for (const l of [...exitListeners]) l(exit)
    },
    dataListenerCount: () => dataListeners.size,
    exitListenerCount: () => exitListeners.size,
  }
  return h
}

// -- Fake ServerWebSocket --------------------------------------------------
//
// We only exercise the methods wsBridge calls on `ws`: send + close. We also
// expose `data` (set at construction) and a list of recorded outbound
// frames + close calls for assertion. The shape matches Bun's
// ServerWebSocket<WsBridgeData> well enough for the wsBridge code paths;
// type assertion bridges the rest.

interface FakeWs {
  data: WsBridgeData
  // Inbound (server -> client). We capture the payload AND a type tag so
  // tests can assert binary vs text without parsing UTF-8.
  sent: Array<{ kind: 'binary' | 'text'; payload: string | Uint8Array }>
  closed: { code: number; reason: string } | null
  // Methods called by wsBridge.
  send(data: string | BufferSource): number
  close(code?: number, reason?: string): void
}

function fakeWs(sessionId: string): FakeWs {
  const ws: FakeWs = {
    data: { sessionId },
    sent: [],
    closed: null,
    send(data) {
      if (typeof data === 'string') {
        ws.sent.push({ kind: 'text', payload: data })
      } else {
        // Normalize ArrayBuffer/TypedArray to Uint8Array for stable assertions.
        const u8 =
          data instanceof Uint8Array
            ? data
            : data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : new Uint8Array(
                  data.buffer,
                  data.byteOffset,
                  data.byteLength,
                )
        ws.sent.push({ kind: 'binary', payload: u8 })
      }
      return 0
    },
    close(code = 1000, reason = '') {
      // First close wins — match real WS semantics where re-close is a no-op.
      if (ws.closed === null) ws.closed = { code, reason }
    },
  }
  return ws
}

// Cast helper: wsBridge expects ServerWebSocket<WsBridgeData>; FakeWs has
// just enough surface. Centralized so the type assertion sits in one place.
function asWs(w: FakeWs): ServerWebSocket<WsBridgeData> {
  return w as unknown as ServerWebSocket<WsBridgeData>
}

// -- Cleanup ---------------------------------------------------------------

afterEach(() => {
  R.clear()
  B.clear()
})

// -- Unit tests (Option B) --------------------------------------------------

describe('attachWsToSession', () => {
  test('valid sessionId: subscribes to PTY data + exit, registers attached client', () => {
    const h = fakeHandle('s-1')
    register(h)
    const ws = fakeWs('s-1')

    attachWsToSession(asWs(ws))

    expect(h.dataListenerCount()).toBe(1)
    expect(h.exitListenerCount()).toBe(1)
    expect(B.attachedCount('s-1')).toBe(1)
    // No frames sent yet — we're idle until the PTY produces output.
    expect(ws.sent).toEqual([])
    expect(ws.closed).toBeNull()
  })

  test('unknown sessionId: sends error JSON + closes 4404', () => {
    // Registry intentionally empty.
    const ws = fakeWs('does-not-exist')
    attachWsToSession(asWs(ws))

    expect(ws.sent).toHaveLength(1)
    expect(ws.sent[0]!.kind).toBe('text')
    expect(JSON.parse(ws.sent[0]!.payload as string)).toEqual({
      type: 'error',
      error: 'session_not_found',
    })
    expect(ws.closed).toEqual({ code: 4404, reason: 'session_not_found' })
    expect(B.attachedCount('does-not-exist')).toBe(0)
  })

  test('PTY data forwards to ws.send as a binary frame', () => {
    const h = fakeHandle('s-2')
    register(h)
    const ws = fakeWs('s-2')
    attachWsToSession(asWs(ws))

    const chunk = new Uint8Array([72, 101, 108, 108, 111]) // "Hello"
    h.triggerData(chunk)

    expect(ws.sent).toHaveLength(1)
    expect(ws.sent[0]!.kind).toBe('binary')
    expect(Array.from(ws.sent[0]!.payload as Uint8Array)).toEqual([72, 101, 108, 108, 111])
  })

  test('PTY exit forwards JSON {type:exit,code} as a text frame and closes 1000', () => {
    const h = fakeHandle('s-3')
    register(h)
    const ws = fakeWs('s-3')
    attachWsToSession(asWs(ws))

    h.triggerExit({ exitCode: 0 })

    // Frame sequence: exit JSON text frame, then close(1000, 'pty_exit').
    expect(ws.sent).toHaveLength(1)
    expect(ws.sent[0]!.kind).toBe('text')
    expect(JSON.parse(ws.sent[0]!.payload as string)).toEqual({ type: 'exit', code: 0 })
    expect(ws.closed).toEqual({ code: 1000, reason: 'pty_exit' })
  })

  test('PTY exit with non-zero code is preserved', () => {
    const h = fakeHandle('s-3b')
    register(h)
    const ws = fakeWs('s-3b')
    attachWsToSession(asWs(ws))

    h.triggerExit({ exitCode: 137, signal: 9 })

    expect(JSON.parse(ws.sent[0]!.payload as string)).toEqual({ type: 'exit', code: 137 })
  })

  test('multiple WS clients on the same session both receive data + exit', () => {
    const h = fakeHandle('s-multi')
    register(h)
    const ws1 = fakeWs('s-multi')
    const ws2 = fakeWs('s-multi')
    attachWsToSession(asWs(ws1))
    attachWsToSession(asWs(ws2))

    expect(B.attachedCount('s-multi')).toBe(2)
    expect(h.dataListenerCount()).toBe(2)
    expect(h.exitListenerCount()).toBe(2)

    h.triggerData(new Uint8Array([97]))
    expect(ws1.sent).toHaveLength(1)
    expect(ws2.sent).toHaveLength(1)
    expect(ws1.sent[0]!.kind).toBe('binary')
    expect(ws2.sent[0]!.kind).toBe('binary')

    h.triggerExit({ exitCode: 0 })
    // Each ws sees the exit frame + close.
    expect(ws1.sent).toHaveLength(2)
    expect(ws2.sent).toHaveLength(2)
    expect(ws1.closed).not.toBeNull()
    expect(ws2.closed).not.toBeNull()
  })
})

describe('handleWsMessage', () => {
  test('{type:input, data:"foo"} writes to PTY', () => {
    const h = fakeHandle('s-input')
    register(h)
    const ws = fakeWs('s-input')
    attachWsToSession(asWs(ws))

    handleWsMessage(asWs(ws), JSON.stringify({ type: 'input', data: 'foo' }))

    expect(h.writes).toEqual(['foo'])
  })

  test('{type:resize, cols, rows} resizes PTY (cols, rows order)', () => {
    const h = fakeHandle('s-resize')
    register(h)
    const ws = fakeWs('s-resize')
    attachWsToSession(asWs(ws))

    handleWsMessage(asWs(ws), JSON.stringify({ type: 'resize', cols: 120, rows: 30 }))

    expect(h.resizes).toEqual([{ cols: 120, rows: 30 }])
  })

  test('malformed JSON is silently ignored (no throw, no PTY interaction)', () => {
    const h = fakeHandle('s-bad-json')
    register(h)
    const ws = fakeWs('s-bad-json')
    attachWsToSession(asWs(ws))

    expect(() => handleWsMessage(asWs(ws), '{not valid json')).not.toThrow()
    expect(h.writes).toEqual([])
    expect(h.resizes).toEqual([])
  })

  test('binary inbound frames are silently ignored', () => {
    const h = fakeHandle('s-bin-in')
    register(h)
    const ws = fakeWs('s-bin-in')
    attachWsToSession(asWs(ws))

    const buf = Buffer.from([1, 2, 3])
    expect(() => handleWsMessage(asWs(ws), buf)).not.toThrow()
    expect(h.writes).toEqual([])
  })

  test('unknown control type is ignored', () => {
    const h = fakeHandle('s-unknown')
    register(h)
    const ws = fakeWs('s-unknown')
    attachWsToSession(asWs(ws))

    handleWsMessage(asWs(ws), JSON.stringify({ type: 'unsupported', foo: 'bar' }))
    expect(h.writes).toEqual([])
    expect(h.resizes).toEqual([])
  })

  test('input with non-string data is dropped (no write)', () => {
    const h = fakeHandle('s-bad-input')
    register(h)
    const ws = fakeWs('s-bad-input')
    attachWsToSession(asWs(ws))

    handleWsMessage(asWs(ws), JSON.stringify({ type: 'input', data: 123 }))
    expect(h.writes).toEqual([])
  })

  test('resize with non-numeric cols/rows is dropped', () => {
    const h = fakeHandle('s-bad-resize')
    register(h)
    const ws = fakeWs('s-bad-resize')
    attachWsToSession(asWs(ws))

    handleWsMessage(asWs(ws), JSON.stringify({ type: 'resize', cols: '120', rows: '30' }))
    expect(h.resizes).toEqual([])
  })

  test('message after PTY exit (no handle in registry) is dropped', () => {
    // No registration: handle is gone. handleWsMessage MUST not throw.
    const ws = fakeWs('s-gone')
    expect(() =>
      handleWsMessage(asWs(ws), JSON.stringify({ type: 'input', data: 'hi' })),
    ).not.toThrow()
  })
})

describe('detachWsFromSession', () => {
  test('disposes data + exit listeners and removes from session map', () => {
    const h = fakeHandle('s-detach')
    register(h)
    const ws = fakeWs('s-detach')
    attachWsToSession(asWs(ws))

    expect(h.dataListenerCount()).toBe(1)
    expect(h.exitListenerCount()).toBe(1)
    expect(B.attachedCount('s-detach')).toBe(1)

    detachWsFromSession(asWs(ws))

    expect(h.dataListenerCount()).toBe(0)
    expect(h.exitListenerCount()).toBe(0)
    expect(B.attachedCount('s-detach')).toBe(0)
    expect(B.totalSessions()).toBe(0)
  })

  test('post-detach: PTY data does NOT reach the WS', () => {
    const h = fakeHandle('s-detach-2')
    register(h)
    const ws = fakeWs('s-detach-2')
    attachWsToSession(asWs(ws))

    detachWsFromSession(asWs(ws))
    h.triggerData(new Uint8Array([1, 2, 3]))
    expect(ws.sent).toEqual([])
  })

  test('detach on an unknown ws is a no-op', () => {
    const ws = fakeWs('never-attached')
    expect(() => detachWsFromSession(asWs(ws))).not.toThrow()
  })

  test('detach of one client preserves the other on a multi-attached session', () => {
    const h = fakeHandle('s-multi-detach')
    register(h)
    const ws1 = fakeWs('s-multi-detach')
    const ws2 = fakeWs('s-multi-detach')
    attachWsToSession(asWs(ws1))
    attachWsToSession(asWs(ws2))

    detachWsFromSession(asWs(ws1))

    expect(B.attachedCount('s-multi-detach')).toBe(1)
    expect(h.dataListenerCount()).toBe(1)
    expect(h.exitListenerCount()).toBe(1)

    h.triggerData(new Uint8Array([42]))
    expect(ws1.sent).toEqual([])
    expect(ws2.sent).toHaveLength(1)
  })
})

// -- Smoke test (Option A): real Bun.serve + real WebSocket client ----------

describe('wsBridge — real Bun.serve smoke test', () => {
  // Mirror the production server's fetch + websocket config, but mounted on
  // an ephemeral port with a minimal handler that ONLY does the WS upgrade
  // path. Avoids spinning up the whole Hono app + DB.
  let server: import('bun').Server<WsBridgeData> | null = null
  let port = 0
  // Token used by validateWebSocketSubprotocol — reuse the real auth module.
  // We write to a temp $HOME so we don't tamper with the user's real token.
  let token: string
  const ORIGINAL_HOME = process.env.HOME

  beforeAll(async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    process.env.HOME = mkdtempSync(join(tmpdir(), 'ralph-monitor-wsBridge-'))

    const auth = await import('../auth')
    auth._resetTokenCacheForTests()
    token = auth.getOrCreateToken()
    const { validateWebSocketSubprotocol } = auth

    server = Bun.serve<WsBridgeData, never>({
      port: 0, // ephemeral
      hostname: '127.0.0.1',
      fetch(req, server) {
        const url = new URL(req.url)
        if (url.pathname.startsWith('/ws/sessions/')) {
          const sessionId = url.pathname.slice('/ws/sessions/'.length)
          if (!sessionId) return new Response('missing_session_id', { status: 400 })
          const subprotocol = validateWebSocketSubprotocol(
            req.headers.get('sec-websocket-protocol'),
          )
          if (subprotocol === null) return new Response('unauthorized', { status: 401 })
          const upgraded = server.upgrade(req, {
            headers: { 'Sec-WebSocket-Protocol': subprotocol },
            data: { sessionId },
          })
          if (upgraded) return undefined
          return new Response('upgrade_failed', { status: 500 })
        }
        return new Response('not_found', { status: 404 })
      },
      websocket: {
        open(ws) { attachWsToSession(ws) },
        message(ws, data) { handleWsMessage(ws, data) },
        close(ws) { detachWsFromSession(ws) },
      },
    })
    port = server.port ?? 0
  })

  afterAll(() => {
    if (server) server.stop(true)
    if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME
    else delete process.env.HOME
  })

  test('upgrade -> data -> input -> exit round-trip via real WebSocket', async () => {
    // Manually register a fake PTY handle for a known session id. Bypasses
    // spawnSession deliberately — see file-level docstring.
    const SESSION_ID = 'smoke-test-' + crypto.randomUUID()
    const h = fakeHandle(SESSION_ID)
    register(h)

    const url = `ws://127.0.0.1:${port}/ws/sessions/${SESSION_ID}`
    const ws = new WebSocket(url, [`bearer.${token}`])
    // Browsers' WebSocket delivers binary as Blob by default in some
    // implementations; Bun's WebSocket client follows that, so we ask for
    // ArrayBuffer explicitly. (TS knows about this property via lib.dom.d.ts.)
    ws.binaryType = 'arraybuffer'

    // Capture inbound frames, distinguishing binary vs text.
    const received: Array<{ kind: 'text' | 'binary'; data: string | Uint8Array }> = []
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        received.push({ kind: 'text', data: ev.data })
      } else if (ev.data instanceof ArrayBuffer) {
        received.push({ kind: 'binary', data: new Uint8Array(ev.data) })
      }
    })

    let closed: { code: number; reason: string } | null = null
    ws.addEventListener('close', (ev) => {
      closed = { code: ev.code, reason: ev.reason }
    })

    // Wait for open.
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error('ws error')), { once: true })
    })

    // The matched subprotocol MUST be echoed by the server, otherwise the
    // browser would have aborted before reaching 'open'. Reaching this line
    // is itself the assertion; we also explicitly check the negotiated
    // protocol for clarity.
    expect(ws.protocol).toBe(`bearer.${token}`)

    // Client -> server: send {type:'input', data:'hello'} and verify the
    // fake handle's write was called.
    ws.send(JSON.stringify({ type: 'input', data: 'hello' }))
    // Give the message a chance to round-trip through the server's event
    // loop. A short polling wait avoids a flaky fixed sleep.
    await waitFor(() => h.writes.length > 0, 500)
    expect(h.writes).toEqual(['hello'])

    // Server -> client: trigger PTY data; verify the client gets a binary
    // frame.
    h.triggerData(new Uint8Array([0x68, 0x69, 0x0a])) // "hi\n"
    await waitFor(() => received.some((r) => r.kind === 'binary'), 500)
    const binFrame = received.find((r) => r.kind === 'binary')!
    expect(Array.from(binFrame.data as Uint8Array)).toEqual([0x68, 0x69, 0x0a])

    // Server -> client: trigger PTY exit; verify the client gets a JSON
    // exit frame and the connection closes.
    h.triggerExit({ exitCode: 0 })
    await waitFor(() => closed !== null, 500)

    const textFrames = received.filter((r) => r.kind === 'text')
    expect(textFrames.length).toBeGreaterThan(0)
    const exitMsg = textFrames.find((f) => {
      try { return JSON.parse(f.data as string).type === 'exit' } catch { return false }
    })
    expect(exitMsg).toBeDefined()
    expect(JSON.parse(exitMsg!.data as string)).toEqual({ type: 'exit', code: 0 })

    expect(closed).not.toBeNull()
    expect((closed as { code: number } | null)!.code).toBe(1000)

    // Manual cleanup — see file-level docstring on why spawnSession's auto-
    // cleanup did NOT fire here. In production the spawnSession onExit hook
    // unregisters; in this fake-handle test we do it ourselves.
    unregister(SESSION_ID)
  })

  test('upgrade with no subprotocol → 401', async () => {
    // Direct fetch, no WS upgrade — Bun returns the Response we built in
    // the fetch handler.
    const res = await fetch(`http://127.0.0.1:${port}/ws/sessions/anything`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    })
    // Without a Sec-WebSocket-Key etc. Bun won't upgrade; we just want to
    // verify our 401 path. The handler returns 401 because subprotocol is
    // null.
    expect(res.status).toBe(401)
  })

  test('upgrade with wrong bearer subprotocol → 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/ws/sessions/whatever`, {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Protocol': 'bearer.wrong-token',
      },
    })
    expect(res.status).toBe(401)
  })
})

// -- Helpers ---------------------------------------------------------------

async function waitFor(
  pred: () => boolean,
  timeoutMs: number,
  pollMs = 5,
): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, pollMs))
  }
}
