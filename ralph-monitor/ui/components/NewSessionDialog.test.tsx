// Smoke test for NewSessionDialog (US-015d).
//
// We verify the module exports the component correctly. Interactive flows
// (form submit, 409 surfacing, navigation) are covered by Playwright in US-018.

import { describe, expect, test } from 'bun:test'
import { NewSessionDialog } from './NewSessionDialog'

describe('NewSessionDialog', () => {
  test('module exports NewSessionDialog as a function', () => {
    expect(typeof NewSessionDialog).toBe('function')
  })

  test('component name is NewSessionDialog', () => {
    expect(NewSessionDialog.name).toBe('NewSessionDialog')
  })
})
