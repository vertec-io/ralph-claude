// UI-side auth — fetches the dev token on app boot and threads it through
// every request that needs it.
//
// This is unapologetically dev-only. For a packaged build we'd want a real
// login flow; today the server is loopback-only and /api/dev-token only
// returns the token to a loopback request, so "open the page" is the auth.
//
// All callers go through these wrappers; raw fetch / new EventSource against
// /api or /events will get 401s.

let _token: string | null = null
let _tokenPromise: Promise<string> | null = null

async function fetchDevToken(): Promise<string> {
  // /api/dev-token is the one endpoint that doesn't require auth — that's
  // the bootstrap. The server gates it on the Host header being loopback.
  const r = await fetch('/api/dev-token')
  if (!r.ok) {
    throw new Error(`/api/dev-token returned ${r.status} — is the server running on 127.0.0.1?`)
  }
  const body = (await r.json()) as { token?: string }
  if (typeof body.token !== 'string' || body.token.length === 0) {
    throw new Error('/api/dev-token returned no token')
  }
  return body.token
}

/**
 * Resolves the auth token. Cached after the first successful fetch; concurrent
 * callers all wait on the same in-flight promise.
 */
export async function getToken(): Promise<string> {
  if (_token !== null) return _token
  if (_tokenPromise !== null) return _tokenPromise
  _tokenPromise = fetchDevToken()
    .then((t) => {
      _token = t
      return t
    })
    .finally(() => {
      _tokenPromise = null
    })
  return _tokenPromise
}

/**
 * Synchronous accessor — only safe AFTER `await getToken()` has resolved at
 * least once. Used by code paths (EventSource, WebSocket) that can't easily
 * fold an `await` into their setup.
 */
export function getTokenSync(): string {
  if (_token === null) {
    throw new Error('getTokenSync called before token was loaded; call getToken() first')
  }
  return _token
}

/**
 * Drop-in fetch wrapper that adds `Authorization: Bearer <token>`. Existing
 * Headers / RequestInit are preserved; if the caller already supplied an
 * Authorization header we don't override it (lets tests force a specific
 * value without going through the cache).
 */
export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = await getToken()
  const headers = new Headers(init?.headers ?? {})
  if (!headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  return fetch(input, { ...init, headers })
}

/**
 * EventSource doesn't support custom headers, so we fall back to the
 * server's `?token=` query-param escape hatch on /events. The server logs a
 * warning each time this is used; for the local dev UI that's acceptable.
 *
 * Caller is responsible for `.close()`-ing the returned source.
 */
export function authEventSource(url: string): EventSource {
  const token = getTokenSync()
  const sep = url.includes('?') ? '&' : '?'
  return new EventSource(`${url}${sep}token=${encodeURIComponent(token)}`)
}

/**
 * WebSocket auth via Sec-WebSocket-Protocol: `bearer.<token>`. The browser's
 * WebSocket constructor accepts a protocols array as its second arg and sends
 * it verbatim in the upgrade request. The server validates the token in the
 * subprotocol list and echoes the matched item back.
 */
export function authWebSocket(url: string): WebSocket {
  const token = getTokenSync()
  return new WebSocket(url, [`bearer.${token}`])
}
