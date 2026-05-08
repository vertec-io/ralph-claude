// Lightweight context menu component for US-014c.
//
// Usage:
//   const { state, open, close } = useContextMenu()
//   ...
//   <button onContextMenu={(e) => { e.preventDefault(); open(e.clientX, e.clientY, items) }}>
//     ...
//   </button>
//   <ContextMenu {...state} onClose={close} />

import { useEffect, useRef } from 'react'

export interface MenuItem {
  label: string
  onClick: () => void
  disabled?: boolean
  destructive?: boolean
  /** Render a horizontal rule before this item (the item itself is still shown). */
  separator?: boolean
}

export interface ContextMenuProps {
  open: boolean
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

// How far to nudge the menu away from the viewport edge (px).
const EDGE_MARGIN = 8

export function ContextMenu({ open, x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  // Close on click-outside.
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    // Use capture so we intercept clicks on any part of the document.
    document.addEventListener('mousedown', handler, true)
    return () => document.removeEventListener('mousedown', handler, true)
  }, [open, onClose])

  // Close on ESC.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  // Clamp to viewport so the menu doesn't overflow.
  const vw = window.innerWidth
  const vh = window.innerHeight
  // Rough estimates — the menu is rendered at fixed size so we clamp after
  // mount. For initial positioning we use the raw cursor coords and let the
  // browser overflow if necessary (acceptable for a context menu).
  const left = Math.min(x, vw - 160 - EDGE_MARGIN)
  const top = Math.min(y, vh - items.length * 32 - EDGE_MARGIN)

  return (
    <div
      ref={ref}
      role="menu"
      data-testid="context-menu"
      style={{ position: 'fixed', left, top, zIndex: 9999 }}
      className="min-w-[160px] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl py-1 text-sm"
      // Prevent the row's own click from bubbling up and triggering a selection.
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => (
        <div key={i}>
          {item.separator && i > 0 && (
            <div className="my-1 border-t border-zinc-700/60" role="separator" />
          )}
          <button
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return
              onClose()
              item.onClick()
            }}
            className={[
              'w-full text-left px-3 py-1.5 transition',
              item.disabled
                ? 'text-zinc-600 cursor-not-allowed'
                : item.destructive
                  ? 'text-rose-400 hover:bg-rose-950/40 hover:text-rose-300 cursor-pointer'
                  : 'text-zinc-200 hover:bg-zinc-800 cursor-pointer',
            ].join(' ')}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// useContextMenu hook
// ---------------------------------------------------------------------------

export interface ContextMenuState {
  open: boolean
  x: number
  y: number
  items: MenuItem[]
}

export interface UseContextMenuReturn {
  state: ContextMenuState
  open: (x: number, y: number, items: MenuItem[]) => void
  close: () => void
}

// Shared hook that manages a single context menu's open/close state and
// position. Wire it once per Sidebar (or per component tree that needs a
// menu), then call `open` from any row's `onContextMenu` handler.
//
// Pattern:
//   const menu = useContextMenu()
//   ...
//   <SomeRow onContextMenu={(e) => { e.preventDefault(); menu.open(e.clientX, e.clientY, items) }} />
//   <ContextMenu {...menu.state} onClose={menu.close} />
import { useState } from 'react'

export function useContextMenu(): UseContextMenuReturn {
  const [state, setState] = useState<ContextMenuState>({
    open: false,
    x: 0,
    y: 0,
    items: [],
  })

  const open = (x: number, y: number, items: MenuItem[]) => {
    setState({ open: true, x, y, items })
  }

  const close = () => {
    setState((s) => ({ ...s, open: false }))
  }

  return { state, open, close }
}
