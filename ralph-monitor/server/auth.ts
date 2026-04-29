// Auth — bearer token + WebSocket subprotocol validation (US-004).
//
// ralph-monitor is loopback-only by design. Auth is belt-and-suspenders against
// browser-driven CSRF / accidental exposure rather than a hardened public-net
// boundary; the actual security perimeter is "the loopback interface and a
// 0o600 token file in the user's HOME". Treat this module accordingly.
//
// Token storage:
//   ~/.config/ralph-monitor/token (mode 0o600)
//   On first call we generate 32 bytes of crypto entropy and write atomically
//   (tmpfile + rename + explicit chmod). The result is cached in-process.
//
// Bearer middleware:
//   /api/* and /events require Authorization: Bearer <token>.
//   /events ALSO accepts ?token=<t> as a fallback for native EventSource
//   (which can't set headers). We log a rate-limited warning when that
//   fallback is used because the token will appear in access logs.
//
// WebSocket auth (used by US-005b):
//   The browser sends Sec-WebSocket-Protocol: bearer.<token>.
//   The server validates and echoes back the matched protocol on upgrade
//   (RFC 6455 §4.1: server MUST select one of the offered subprotocols and
//   echo it in the handshake response).

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, statSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { MiddlewareHandler } from 'hono'

let _cachedToken: string | null = null

export function resolveTokenPath(): string {
  return join(homedir(), '.config', 'ralph-monitor', 'token')
}

/**
 * Reads the on-disk token, creating it (32 random bytes hex-encoded) on first
 * call. Mode is 0o600 — readable only by the owning user. The first call is
 * authoritative: we cache the result so subsequent calls don't re-stat or
 * re-read.
 *
 * Atomic write: writeFile to <path>.tmp, chmod 0o600, then rename. The rename
 * is the atomic step on POSIX (same-filesystem source/dest). chmod-after-write
 * is needed because Node's writeFile mode arg is best-effort and umask can
 * subtract bits on some filesystems.
 */
export function getOrCreateToken(): string {
  if (_cachedToken !== null) return _cachedToken
  const tokenPath = resolveTokenPath()
  const parent = dirname(tokenPath)
  mkdirSync(parent, { recursive: true, mode: 0o700 })

  // If file exists, read it. Otherwise generate and atomically write.
  let token: string
  try {
    statSync(tokenPath)
    token = readFileSync(tokenPath, 'utf8').trim()
    if (!/^[a-f0-9]{64}$/i.test(token)) {
      // File exists but is corrupt — regenerate. We don't try to be clever
      // here; the failure mode is "you lost your token, log in again".
      token = generateAndWriteToken(tokenPath)
    }
  } catch {
    token = generateAndWriteToken(tokenPath)
  }

  _cachedToken = token
  return token
}

function generateAndWriteToken(tokenPath: string): string {
  const token = randomBytes(32).toString('hex')
  const tmp = tokenPath + '.tmp'
  writeFileSync(tmp, token + '\n', { encoding: 'utf8', mode: 0o600 })
  // Explicit chmod — see comment on getOrCreateToken about why.
  chmodSync(tmp, 0o600)
  renameSync(tmp, tokenPath)
  return token
}

/**
 * Constant-time-ish comparison of a candidate token against the stored token.
 *
 * `timingSafeEqual` requires equal-length buffers, so we have to length-check
 * up front. For ralph-monitor (loopback-only) the timing-attack vector is
 * mostly theatrical — a co-located attacker has bigger problems — but we use
 * the constant-time path anyway as a matter of hygiene. A length mismatch is
 * the practical short-circuit.
 */
export function verifyToken(candidate: string): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false
  const correct = getOrCreateToken()
  if (candidate.length !== correct.length) return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(correct)
  return timingSafeEqual(a, b)
}

// Rate-limiter for the "?token= in query string" warning. Per-token-prefix so
// repeated polling from a single misconfigured client doesn't spam the log,
// but distinct clients still each get their first warning.
const _warnedTokens = new Map<string, number>()
const WARN_INTERVAL_MS = 60_000

function maybeWarnQueryToken(token: string): void {
  const prefix = token.slice(0, 8)
  const now = Date.now()
  const last = _warnedTokens.get(prefix) ?? 0
  if (now - last < WARN_INTERVAL_MS) return
  _warnedTokens.set(prefix, now)
  console.warn(
    `[auth] token in query string (prefix ${prefix}…) — visible in access logs; prefer Authorization header`,
  )
}

/**
 * Returns a Hono middleware that requires `Authorization: Bearer <token>`.
 *
 * Exception: if the request path starts with `/events`, we ALSO accept
 * `?token=<t>` because the browser EventSource API can't set headers. The
 * fallback emits a rate-limited warning (token leaks into access logs).
 *
 * Header takes precedence over query.
 */
export function bearerMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const authHeader = c.req.header('authorization') ?? c.req.header('Authorization')
    let token: string | null = null

    if (authHeader && /^bearer /i.test(authHeader)) {
      token = authHeader.slice(7).trim()
    }

    if (!token) {
      const path = new URL(c.req.url).pathname
      const isEvents = path === '/events' || path.startsWith('/events/')
      if (isEvents) {
        const q = c.req.query('token')
        if (q && q.length > 0) {
          maybeWarnQueryToken(q)
          token = q
        }
      }
    }

    if (!token || !verifyToken(token)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
  }
}

/**
 * Validates a `Sec-WebSocket-Protocol` header value (which is the
 * comma-separated list the browser/client sent) against the stored token.
 *
 * The browser sends: `Sec-WebSocket-Protocol: bearer.<token>` (possibly with
 * other protocols ahead of or behind it).
 *
 * Returns the matched literal (e.g. `bearer.abc123…`) so the server can echo
 * it back in the upgrade response per RFC 6455 §4.2.2 — failing to echo a
 * subprotocol the browser offered will cause the browser to abort the
 * connection. Returns null if no offered protocol matched.
 *
 * NOTE: the comparison goes through verifyToken (constant-time), but parsing
 * the header is plain string ops — we don't try to defend timing leaks across
 * the parser surface.
 */
export function validateWebSocketSubprotocol(
  secWebSocketProtocol: string | null,
): string | null {
  if (!secWebSocketProtocol) return null
  const offered = secWebSocketProtocol.split(',').map((s) => s.trim()).filter(Boolean)
  for (const p of offered) {
    if (!p.startsWith('bearer.')) continue
    const candidate = p.slice('bearer.'.length)
    if (verifyToken(candidate)) return p
  }
  return null
}

/**
 * Test-only hook to reset the in-process token cache. Real callers should
 * never need this; tests use it to force re-read from a fresh $HOME.
 */
export function _resetTokenCacheForTests(): void {
  _cachedToken = null
  _warnedTokens.clear()
}
