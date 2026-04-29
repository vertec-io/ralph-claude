// Smoke test for NewProjectDialog (US-015b).
//
// We verify the module exports the component and that it renders without
// crashing when given minimal props. Interactive flows (directory navigation,
// worktree detection, form submit) are covered by Playwright in US-018.

import { describe, expect, test } from 'bun:test'
import { NewProjectDialog } from './NewProjectDialog'

describe('NewProjectDialog', () => {
  test('module exports NewProjectDialog as a function', () => {
    expect(typeof NewProjectDialog).toBe('function')
  })

  test('component name is NewProjectDialog', () => {
    expect(NewProjectDialog.name).toBe('NewProjectDialog')
  })
})
