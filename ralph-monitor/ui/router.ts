// Hash-based URL router.
//
// Selection is encoded in window.location.hash as:
//   #/p/:projectId
//   #/p/:projectId/c/:conversationId
//   #/p/:projectId/prd/:prdSpecId
//
// `c` and `prd` are mutually exclusive — at most one is set at a time.

import { useEffect, useState } from 'react'

export interface Selection {
  projectId: string | null
  conversationId: string | null
  prdSpecId: string | null
}

const EMPTY: Selection = { projectId: null, conversationId: null, prdSpecId: null }

const HASH_RE = /^#?\/p\/([^/]+)(?:\/(c|prd)\/([^/]+))?\/?$/

export function parseSelection(hash: string): Selection {
  const m = hash.match(HASH_RE)
  if (!m) return { ...EMPTY }
  const projectId = m[1] ?? null
  const kind = m[2] // 'c' | 'prd' | undefined
  const id = m[3] ?? null
  return {
    projectId,
    conversationId: kind === 'c' ? id : null,
    prdSpecId: kind === 'prd' ? id : null,
  }
}

export function buildSelectionUrl(s: Selection): string {
  if (!s.projectId) return '#/'
  let path = `#/p/${s.projectId}`
  if (s.conversationId) path += `/c/${s.conversationId}`
  else if (s.prdSpecId) path += `/prd/${s.prdSpecId}`
  return path
}

function readCurrentSelection(): Selection {
  const hash = window.location.hash
  if (hash && hash !== '#' && hash !== '#/') return parseSelection(hash)
  const path = window.location.pathname
  if (path.startsWith('/p/')) return parseSelection('#' + path)
  return { ...EMPTY }
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
    history.pushState(null, '', url)
    setSelectionState(s)
  }

  return [selection, setSelection]
}
