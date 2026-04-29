// Encoder for `~/.claude/projects/<dirname>` from an absolute filesystem path.
//
// Per-character non-alphanumeric replacement, NOT collapsed. This was
// empirically confirmed in US-000a against `claude --session-id` against a
// pathological input (`/tmp/ralph-encoder-test..foo`):
//
//   /tmp/ralph-encoder-test..foo  ->  -tmp-ralph-encoder-test--foo
//
// Note the `--` for the source `..` — that's two characters mapped to two
// dashes, not one. A `+` (collapse) regex would have produced one `-` there.
// See `tasks/ralph-monitor-sessions/decisions/US-000a-DECIDE_pty-and-encoder.md`
// for the full empirical run, including cleanup commands.
//
// Caller contract: `absPath` MUST be absolute (start with `/`) and SHOULD be
// realpath'd by the caller before invocation — `prepareSpawn` does this. We
// don't realpath here because (a) realpath is I/O and this function should
// remain pure, and (b) the encoder needs to operate on whatever exact string
// the caller intends to encode, not on whatever realpath resolves it to. The
// trailing-slash-stripping that prevents accidental `-foo-` from `/foo/` is
// also the caller's responsibility (likewise prepareSpawn does that).
//
// Unicode: `[^A-Za-z0-9]` matches per UTF-16 code unit. A character outside
// the BMP (e.g. an emoji on a surrogate pair) becomes TWO `-`s, not one.
// Documented as a known limitation; if real-world Claude differs (e.g. NFC
// normalization, UTF-8 byte counting) the encoder will need a patch and a
// new empirical decision document.

export class InvalidPathError extends Error {
  override readonly name = 'InvalidPathError'
}

const ENCODER_RE = /[^A-Za-z0-9]/g

export function encodeClaudeProjectDir(absPath: string): string {
  if (absPath === '') {
    throw new InvalidPathError('encodeClaudeProjectDir: empty path')
  }
  if (!absPath.startsWith('/')) {
    throw new InvalidPathError(`encodeClaudeProjectDir: not absolute: ${absPath}`)
  }
  return absPath.replace(ENCODER_RE, '-')
}
