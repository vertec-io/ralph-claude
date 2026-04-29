// Encoder unit tests for ~/.claude/projects/<dir> name generation.
//
// The cases here are pinned to the empirical run captured in
// `tasks/ralph-monitor-sessions/decisions/US-000a-DECIDE_pty-and-encoder.md`.
// In particular: the `..` -> `--` test is the one that disambiguates the
// per-character regex from a `+`-collapsed regex.

import { describe, expect, test } from 'bun:test'
import { encodeClaudeProjectDir, InvalidPathError } from './paths'

describe('encodeClaudeProjectDir', () => {
  test("'/' -> '-'", () => {
    expect(encodeClaudeProjectDir('/')).toBe('-')
  })

  test("'/foo' -> '-foo'", () => {
    expect(encodeClaudeProjectDir('/foo')).toBe('-foo')
  })

  test("'/foo/bar' -> '-foo-bar'", () => {
    expect(encodeClaudeProjectDir('/foo/bar')).toBe('-foo-bar')
  })

  test("'/foo..bar' -> '-foo--bar' (per-char, NOT collapsed)", () => {
    // This case is the one that makes per-character vs `+`-collapse
    // distinguishable. Per US-000a: empirical output was -tmp-...test--foo.
    expect(encodeClaudeProjectDir('/foo..bar')).toBe('-foo--bar')
  })

  test("'/foo_bar-baz' -> '-foo-bar-baz'", () => {
    // `_` and `-` are both non-alnum under `[^A-Za-z0-9]`; each becomes one
    // `-` (the existing `-` is replaced too, vacuously).
    expect(encodeClaudeProjectDir('/foo_bar-baz')).toBe('-foo-bar-baz')
  })

  test("'/foo/' (trailing slash) -> '-foo-' (caller MUST strip)", () => {
    // If a caller passes the trailing slash through, they get a trailing `-`.
    // The contract is that prepareSpawn realpaths + strips the trailing slash
    // BEFORE calling encodeClaudeProjectDir; this test pins the un-stripped
    // behavior so any caller bypassing realpath knows what to expect.
    expect(encodeClaudeProjectDir('/foo/')).toBe('-foo-')
  })

  test("'/héllo' -> 'h' '-' 'llo' (Unicode é is one UTF-16 code unit, one '-')", () => {
    // The `é` character is U+00E9, a single UTF-16 code unit. `[^A-Za-z0-9]`
    // operates on code units, so it becomes one `-`. Documented as a known
    // limitation: if Claude differs (e.g. NFC normalization or UTF-8 byte
    // counting), file an issue and patch the regex.
    expect(encodeClaudeProjectDir('/héllo')).toBe('-h-llo')
  })

  test("'' -> throws InvalidPathError", () => {
    expect(() => encodeClaudeProjectDir('')).toThrow(InvalidPathError)
  })

  test("'foo' (relative) -> throws InvalidPathError", () => {
    expect(() => encodeClaudeProjectDir('foo')).toThrow(InvalidPathError)
  })

  test("'./foo' (relative with dot) -> throws InvalidPathError", () => {
    expect(() => encodeClaudeProjectDir('./foo')).toThrow(InvalidPathError)
  })
})
