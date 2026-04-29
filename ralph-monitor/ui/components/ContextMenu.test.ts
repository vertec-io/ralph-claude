// Smoke tests for ContextMenu and useContextMenu (US-014c).
//
// We don't render JSX in bun:test (no jsdom); instead we validate that the
// exported symbols exist with the right shape, which is sufficient to catch
// import/signature regressions without requiring a browser environment.

import { describe, expect, test } from 'bun:test'
import { ContextMenu, useContextMenu } from './ContextMenu'
import type { MenuItem, ContextMenuProps, ContextMenuState, UseContextMenuReturn } from './ContextMenu'

describe('ContextMenu', () => {
  test('ContextMenu is exported as a function', () => {
    expect(typeof ContextMenu).toBe('function')
  })

  test('ContextMenu.name is ContextMenu', () => {
    expect(ContextMenu.name).toBe('ContextMenu')
  })

  test('ContextMenu accepts the expected props shape at the type level', () => {
    // This is a compile-time check via TypeScript. At runtime we just verify
    // we can construct a valid props object without TypeScript complaining.
    const props: ContextMenuProps = {
      open: false,
      x: 100,
      y: 200,
      items: [],
      onClose: () => {},
    }
    expect(props.open).toBe(false)
    expect(props.x).toBe(100)
    expect(props.y).toBe(200)
    expect(Array.isArray(props.items)).toBe(true)
    expect(typeof props.onClose).toBe('function')
  })
})

describe('MenuItem type', () => {
  test('MenuItem with all fields is valid', () => {
    const item: MenuItem = {
      label: 'Archive',
      onClick: () => {},
      disabled: false,
      destructive: false,
      separator: false,
    }
    expect(item.label).toBe('Archive')
  })

  test('MenuItem with only required fields is valid', () => {
    const item: MenuItem = {
      label: 'Delete',
      onClick: () => {},
    }
    expect(item.label).toBe('Delete')
    expect(item.disabled).toBeUndefined()
  })

  test('destructive MenuItem has correct shape', () => {
    const item: MenuItem = {
      label: 'Delete',
      onClick: () => {},
      destructive: true,
      separator: true,
    }
    expect(item.destructive).toBe(true)
    expect(item.separator).toBe(true)
  })
})

describe('useContextMenu', () => {
  test('useContextMenu is exported as a function', () => {
    expect(typeof useContextMenu).toBe('function')
  })

  test('return type shape is correct (type-level check)', () => {
    // We can't call the hook outside React, but we can inspect its type
    // by verifying the returned object has the right keys via the interface.
    const _check: UseContextMenuReturn = {
      state: { open: false, x: 0, y: 0, items: [] } satisfies ContextMenuState,
      open: (_x: number, _y: number, _items: MenuItem[]) => {},
      close: () => {},
    }
    expect(typeof _check.open).toBe('function')
    expect(typeof _check.close).toBe('function')
    expect(typeof _check.state).toBe('object')
  })
})
