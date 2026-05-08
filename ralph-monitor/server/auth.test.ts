// Auth tests for US-004.
//
// Strategy: redirect $HOME to a temp dir BEFORE importing ./auth, so
// getOrCreateToken() reads/writes inside the test sandbox instead of the real
// ~/.config/ralph-monitor. We also reset the in-process cache between tests
// that need a fresh token state.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'ralph-monitor-auth-'))
const ORIGINAL_HOME = process.env.HOME
process.env.HOME = TEST_HOME

// Imports below resolve homedir() through the env we just set.
const {
  getOrCreateToken,
  verifyToken,
  validateWebSocketSubprotocol,
  bearerMiddleware,
  resolveTokenPath,
  _resetTokenCacheForTests,
} = await import('./auth')
const { Hono } = await import('hono')

afterAll(() => {
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME
  else delete process.env.HOME
  try { rmSync(TEST_HOME, { recursive: true, force: true }) } catch {}
})

describe('getOrCreateToken', () => {
  test('creates a 64-char hex token with mode 0o600 on first call', () => {
    _resetTokenCacheForTests()
    // Wipe any pre-existing token from previous test.
    try { rmSync(resolveTokenPath()) } catch {}

    const token = getOrCreateToken()
    expect(token).toMatch(/^[a-f0-9]{64}$/)

    const st = statSync(resolveTokenPath())
    // Mask out file-type bits, only inspect permission bits.
    const mode = st.mode & 0o777
    expect(mode).toBe(0o600)

    // File contents match (with optional trailing newline).
    const onDisk = readFileSync(resolveTokenPath(), 'utf8').trim()
    expect(onDisk).toBe(token)
  })

  test('subsequent calls return the same token (cache + on-disk reuse)', () => {
    const a = getOrCreateToken()
    _resetTokenCacheForTests() // force re-read from disk
    const b = getOrCreateToken()
    expect(b).toBe(a)
  })
})

describe('verifyToken', () => {
  test('returns true for the correct token', () => {
    const t = getOrCreateToken()
    expect(verifyToken(t)).toBe(true)
  })
  test('returns false for an obviously wrong string', () => {
    expect(verifyToken('not-the-token')).toBe(false)
  })
  test('returns false for a same-length-but-wrong hex string', () => {
    const wrong = 'a'.repeat(64)
    const correct = getOrCreateToken()
    // Sanity: the wrong string must actually be the same length as the real
    // token, otherwise this just exercises the length-mismatch short-circuit.
    expect(wrong.length).toBe(correct.length)
    // (Avoid a false-positive if randomBytes happened to give us all-a's.)
    if (wrong !== correct) {
      expect(verifyToken(wrong)).toBe(false)
    }
  })
  test('returns false for empty / non-string input', () => {
    expect(verifyToken('')).toBe(false)
    // @ts-expect-error -- runtime hardening check
    expect(verifyToken(undefined)).toBe(false)
    // @ts-expect-error -- runtime hardening check
    expect(verifyToken(null)).toBe(false)
  })
})

describe('validateWebSocketSubprotocol', () => {
  test('null header → null', () => {
    expect(validateWebSocketSubprotocol(null)).toBe(null)
  })
  test('header with only the matching bearer.<token> → returns the literal', () => {
    const t = getOrCreateToken()
    const offered = `bearer.${t}`
    expect(validateWebSocketSubprotocol(offered)).toBe(offered)
  })
  test('header with bearer.<wrong-token> → null', () => {
    const offered = 'bearer.' + 'a'.repeat(64)
    // Skip if all-a's collides with the real token (vanishingly unlikely).
    if (offered.slice('bearer.'.length) === getOrCreateToken()) return
    expect(validateWebSocketSubprotocol(offered)).toBe(null)
  })
  test('header with non-bearer entries only → null', () => {
    expect(validateWebSocketSubprotocol('foo, bar')).toBe(null)
  })
  test('mixed list: returns the matched bearer.<correct> literal', () => {
    const t = getOrCreateToken()
    const offered = `mqtt, bearer.${t}, json.api`
    expect(validateWebSocketSubprotocol(offered)).toBe(`bearer.${t}`)
  })
  test('whitespace tolerance around commas', () => {
    const t = getOrCreateToken()
    const offered = `  mqtt ,   bearer.${t}  `
    expect(validateWebSocketSubprotocol(offered)).toBe(`bearer.${t}`)
  })
})

describe('bearerMiddleware (Hono integration)', () => {
  function buildApp(): InstanceType<typeof Hono> {
    const app = new Hono()
    // Mirror the real mount order: dev-token first (no auth), then auth on
    // /api/* and /events.
    app.get('/api/dev-token', (c) => c.json({ token: getOrCreateToken() }))
    const auth = bearerMiddleware()
    app.use('/api/*', auth)
    app.use('/events', auth)
    app.get('/api/projects', (c) => c.json({ projects: [] }))
    app.get('/events', (c) => c.text('ok'))
    return app
  }

  test('GET /api/projects without a header → 401', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://127.0.0.1/api/projects'))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('unauthorized')
  })

  test('GET /api/projects with correct bearer header → 200', async () => {
    const app = buildApp()
    const t = getOrCreateToken()
    const res = await app.fetch(
      new Request('http://127.0.0.1/api/projects', {
        headers: { Authorization: `Bearer ${t}` },
      }),
    )
    expect(res.status).toBe(200)
  })

  test('GET /api/projects with wrong bearer → 401', async () => {
    const app = buildApp()
    const res = await app.fetch(
      new Request('http://127.0.0.1/api/projects', {
        headers: { Authorization: 'Bearer wrong' },
      }),
    )
    expect(res.status).toBe(401)
  })

  test('GET /api/projects?token=<correct> → 401 (header-only on /api)', async () => {
    const app = buildApp()
    const t = getOrCreateToken()
    const res = await app.fetch(
      new Request(`http://127.0.0.1/api/projects?token=${t}`),
    )
    expect(res.status).toBe(401)
  })

  test('GET /events?token=<correct> → 200 (query-param fallback allowed)', async () => {
    const app = buildApp()
    const t = getOrCreateToken()
    const res = await app.fetch(new Request(`http://127.0.0.1/events?token=${t}`))
    expect(res.status).toBe(200)
  })

  test('GET /events with no auth → 401', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://127.0.0.1/events'))
    expect(res.status).toBe(401)
  })

  test('GET /api/dev-token requires no auth (returns 200 with token)', async () => {
    const app = buildApp()
    const res = await app.fetch(new Request('http://127.0.0.1/api/dev-token'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.token).toBe(getOrCreateToken())
  })
})

describe('/api/dev-token loopback Host check', () => {
  // We can't reach into the production server/index.ts handler without
  // booting the whole server, so we duplicate the Host-check logic here in a
  // local handler to verify the contract. The real handler is one-liner and
  // the curl-based manual verification covers the integration.
  function makeLocalDevTokenApp(): InstanceType<typeof Hono> {
    const app = new Hono()
    app.get('/api/dev-token', (c) => {
      const host = c.req.header('host') ?? ''
      const isLoopback = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)
      if (!isLoopback) return c.json({ error: 'not_found' }, 404)
      return c.json({ token: getOrCreateToken() })
    })
    return app
  }

  test('Host: 127.0.0.1:7777 → 200', async () => {
    const app = makeLocalDevTokenApp()
    const res = await app.fetch(
      new Request('http://127.0.0.1:7777/api/dev-token', {
        headers: { Host: '127.0.0.1:7777' },
      }),
    )
    expect(res.status).toBe(200)
  })

  test('Host: localhost:7777 → 200', async () => {
    const app = makeLocalDevTokenApp()
    const res = await app.fetch(
      new Request('http://localhost:7777/api/dev-token', {
        headers: { Host: 'localhost:7777' },
      }),
    )
    expect(res.status).toBe(200)
  })

  test('Host: example.com → 404', async () => {
    const app = makeLocalDevTokenApp()
    const res = await app.fetch(
      new Request('http://example.com/api/dev-token', {
        headers: { Host: 'example.com' },
      }),
    )
    expect(res.status).toBe(404)
  })
})
