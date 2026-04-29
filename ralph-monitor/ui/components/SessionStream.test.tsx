// Smoke test for US-011 components.
//
// We deliberately do NOT mount the components — xterm requires a real DOM,
// and `bun:test` doesn't ship one. The value of this test is confirming that:
//
//   1. Both modules import cleanly (so xterm + xterm-addon-fit + the
//      `xterm/css/xterm.css` import all resolve under Vite/Bun).
//   2. The exported symbols are functions (i.e., the React components).
//
// Hedge: xterm 5.x dereferences `document` at module-load (during a
// `__decorate` call on AccessibilityManager). To make the import succeed
// under `bun:test` (which has no DOM), we stub `globalThis.document` /
// `globalThis.window` with empty objects BEFORE importing. We do not
// instantiate `Terminal`, so these stubs are never actually used; they only
// have to satisfy the `typeof document !== 'undefined'` checks that fire
// during module evaluation. A real DOM (and real xterm rendering) is
// covered by US-018 Playwright.
//
// Render-tree assertions are deferred to US-018 (Playwright).

import { test, expect } from 'bun:test'

// Stub the minimal DOM globals xterm reads at module load. Must come BEFORE
// the SessionStream import. xterm 5.x's static initializer creates a probe
// `<canvas>` to feature-detect — we hand it a no-op canvas-shaped object.
if (typeof (globalThis as any).document === 'undefined') {
  const fakeCanvas = {
    getContext: () => null,
    width: 0,
    height: 0,
  }
  ;(globalThis as any).document = {
    createElement: (_tag: string) => fakeCanvas,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
}
if (typeof (globalThis as any).window === 'undefined') {
  ;(globalThis as any).window = globalThis
}

const { SessionStream } = await import('./SessionStream')
const { ViewModeToggle } = await import('./ViewModeToggle')

test('SessionStream component exists', () => {
  expect(typeof SessionStream).toBe('function')
})

test('ViewModeToggle component exists', () => {
  expect(typeof ViewModeToggle).toBe('function')
})
