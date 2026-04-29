// Hash-based URL router for US-014c selection persistence.
//
// Selection is encoded in window.location.hash as:
//   #/p/:projectId
//   #/p/:projectId/e/:effortId
//   #/p/:projectId/e/:effortId/s/:sessionId
//
// Hash routing is used (rather than pathname-based) to avoid needing a
// server-side history fallback. The Vite dev server and the production server
// both serve the SPA on `/`; hash-based routes never hit the server.

import { useEffect, useState } from 'react'

export interface Selection {
  projectId: string | null
  effortId: string | null
  sessionId: string | null
}

const EMPTY: Selection = { projectId: null, effortId: null, sessionId: null }

// Regex that matches:
//   #/p/<pid>
//   #/p/<pid>/e/<eid>
//   #/p/<pid>/e/<eid>/s/<sid>
// Each segment may contain any char except '/'.
const HASH_RE = /^#?\/p\/([^/]+)(?:\/e\/([^/]+)(?:\/s\/([^/]+))?)?\/?$/

/**
 * Parse a hash string into a Selection. Returns all-null for unrecognised hashes.
 *
 * Accepts with or without the leading '#'.
 */
export function parseSelection(hash: string): Selection {
  const m = hash.match(HASH_RE)
  if (!m) return { ...EMPTY }
  return {
    projectId: m[1] ?? null,
    effortId: m[2] ?? null,
    sessionId: m[3] ?? null,
  }
}

/**
 * Serialise a Selection back into a hash string.
 *
 * Returns '#/' for an empty/null selection so window.location.hash can be set
 * without leaving a stale deep-link.
 */
export function buildSelectionUrl(s: Selection): string {
  if (!s.projectId) return '#/'
  let path = `#/p/${s.projectId}`
  if (s.effortId) {
    path += `/e/${s.effortId}`
    // sessionId is only valid when effortId is present (URL hierarchy requires it).
    if (s.sessionId) path += `/s/${s.sessionId}`
  }
  return path
}

/**
 * React hook that reads the current selection from window.location.hash and
 * keeps it in sync with the browser history via the `hashchange` event.
 *
 * `setSelection` updates window.location.hash via pushState so the user can
 * press Back to undo navigation.
 */
// Read a Selection from the current location, accepting either the
// canonical hash form (#/p/.../e/.../s/...) or a pathname form
// (/p/.../e/.../s/...) for back-compat with URLs that were written before
// the router was hash-corrected.
function readCurrentSelection(): Selection {
  const hash = window.location.hash
  if (hash && hash !== '#' && hash !== '#/') return parseSelection(hash)
  // Fall back to pathname so deep links pasted directly work.
  const path = window.location.pathname
  if (path.startsWith('/p/')) return parseSelection('#' + path)
  return { projectId: null, effortId: null, sessionId: null }
}

export function useSelection(): [Selection, (s: Selection) => void] {
  const [selection, setSelectionState] = useState<Selection>(() =>
    readCurrentSelection(),
  )

  useEffect(() => {
    const handler = () => setSelectionState(readCurrentSelection())
    window.addEventListener('hashchange', handler)
    window.addEventListener('popstate', handler)
    return () => {
      window.removeEventListener('hashchange', handler)
      window.removeEventListener('popstate', handler)
    }
  }, [])

  const setSelection = (s: Selection) => {
    const url = buildSelectionUrl(s)
    // Push the hash-form URL (keeps the leading '#') so subsequent reads of
    // window.location.hash work and refreshing the page preserves selection.
    history.pushState(null, '', url)
    setSelectionState(s)
  }

  return [selection, setSelection]
}
