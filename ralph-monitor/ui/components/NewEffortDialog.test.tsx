// Smoke test for NewEffortDialog (US-015c).
//
// We verify the module exports the component correctly. Interactive flows
// (form submit, directory picker, server error surfacing) are covered by
// Playwright in US-018.

import { describe, expect, test } from 'bun:test'
import { NewEffortDialog } from './NewEffortDialog'

describe('NewEffortDialog', () => {
  test('module exports NewEffortDialog as a function', () => {
    expect(typeof NewEffortDialog).toBe('function')
  })

  test('component name is NewEffortDialog', () => {
    expect(NewEffortDialog.name).toBe('NewEffortDialog')
  })
})
