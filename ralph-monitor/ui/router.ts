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
export function useSelection(): [Selection, (s: Selection) => void] {
  const [selection, setSelectionState] = useState<Selection>(() =>
    parseSelection(window.location.hash),
  )

  useEffect(() => {
    const handler = () => {
      setSelectionState(parseSelection(window.location.hash))
    }
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [])

  const setSelection = (s: Selection) => {
    const url = buildSelectionUrl(s)
    // Use history.pushState so the user can go Back; this does NOT fire
    // hashchange (browsers only fire hashchange for user-initiated navigation or
    // calls to window.location.hash = '…'), so we update React state manually.
    const hashPart = url.startsWith('#') ? url.slice(1) : url
    history.pushState(null, '', hashPart || '/')
    setSelectionState(s)
  }

  return [selection, setSelection]
}
