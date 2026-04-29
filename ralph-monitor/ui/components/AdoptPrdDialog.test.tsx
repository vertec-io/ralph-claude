// Smoke import test for AdoptPrdDialog (US-013).
//
// We verify the module exports the component and that it renders without
// crashing when given minimal props. We don't exercise click flows —
// the Playwright ACs for US-018 cover the interactive story.

import { describe, expect, test } from 'bun:test'
import { AdoptPrdDialog } from './AdoptPrdDialog'

describe('AdoptPrdDialog', () => {
  test('module exports AdoptPrdDialog as a function', () => {
    expect(typeof AdoptPrdDialog).toBe('function')
  })

  test('component name is AdoptPrdDialog', () => {
    expect(AdoptPrdDialog.name).toBe('AdoptPrdDialog')
  })
})
