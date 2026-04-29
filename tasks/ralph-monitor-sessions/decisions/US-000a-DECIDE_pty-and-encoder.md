# Decision: PTY library and encoder regex

**Story:** US-000a
**Status:** APPLIED
**Date:** 2026-04-29

This decision document is the authoritative answer for two questions that
downstream stories (US-005a-1, US-005a-2, US-006) reference by name:

1. Which PTY library does ralph-monitor use under Bun?
2. What regex encodes an absolute path into a `~/.claude/projects/<dir>` name?

It is auto-applied (no user-acknowledgement gate) — Ralph proceeds to US-001
once this file exists.

---

## 1. PTY library

**Chosen:** `bun-pty`
**Version:** `^0.4.8` (`bun-pty@0.4.8` resolved into `ralph-monitor/node_modules/`)
**Why not `node-pty`:** the `bun add node-pty` install attempted a native
rebuild via `node-gyp`, which is not on this developer machine. The exact
error from `bun add node-pty`:

```
Resolved, downloaded and extracted [520]
> Checking prebuilds...
> Rebuilding because directory /home/apino/dev/ralph-monitor-sessions/ralph-monitor/node_modules/node-pty/prebuilds/linux-x64 does not exist
/usr/bin/bash: line 1: node-gyp: command not found
error: install script from "node-pty" exited with 127
```

Per the spike's rules, we did **not** sudo-install build tools; we tried the
documented fallback `bun-pty` (which uses Bun's built-in FFI to call a Rust
shared library — no `node-gyp` step) and it installed in 256 ms with zero
prebuild errors.

**Why no `pty.js` fallback:** `pty.js` is unmaintained (last release 2015).
Per the story's explicit guidance, we do not autoproceed to a non-viable
shim. Since `bun-pty` worked, this is moot.

### `/proc/<pid>/comm` — answer to AC4

The PTY *parent* (the Bun process that owns the PTY) reports
`/proc/<pid>/comm = bun`. The PTY *child* (the program running inside the
pseudo-terminal — `bash -c "echo hi; sleep 0.5"` in the spike) reports
`/proc/<pid>/comm = bash`.

US-006's reconciliation logic (which scans `/proc/<pid>/comm` of every
process to find ralph-monitor's PTY parents after a restart) must match
on **`bun`** — that is the authoritative comm value for any
ralph-monitor-owned PTY parent on this platform.

### Spike evidence

A throwaway script `ralph-monitor/scripts/pty-spike.ts` was created, run, and
deleted as part of this story. The script:

- imported `* as pty from "bun-pty"`
- spawned `bash -c "echo hi; sleep 0.5"` via `pty.spawn`
- listened on `onData` and accumulated stdout
- called `term.write("\n")` (proves WS->PTY direction; did not throw)
- called `term.resize(120, 30)` after 50 ms (proves resize control)
- waited for `onExit`, printed exit code + captured bytes + comm values

Captured run output (verbatim):

```
=== US-000a PTY spike ===
spike script pid    = 3295298
/proc/3295298/comm = bun
bun-pty module keys = Terminal,spawn
pty child pid       = 3295310
/proc/3295310/comm = bash
resize(120, 30) ok
=== exit ===
exitCode = 0
signal   = <none>
captured stdout (6 bytes):
"\r\nhi\r\n"
=== verdict ===
PTY-PARENT-COMM=bun
PTY-CHILD-COMM=bash
STDOUT-CONTAINS-HI=yes
```

Bidirectional bytes confirmed: `write()` succeeded synchronously, stdout
delivered `\r\nhi\r\n` via `onData`, and `pty.resize(120, 30)` did not throw.

### Public API surface used (locked-in for US-005a-2 / US-005b)

```ts
import * as pty from "bun-pty";
import type { IPty, IPtyForkOptions, IExitEvent, IDisposable } from "bun-pty";

const term: IPty = pty.spawn(file, args, options);
term.pid;                        // number — child pid
term.onData((data: string) => {});
term.onExit((ev: IExitEvent) => {});  // ev.exitCode, ev.signal
term.write(data: string);
term.resize(cols: number, rows: number);
term.kill(signal?: string);
```

Note: `bun-pty.spawn`'s third argument (`IPtyForkOptions`) requires `name`
(non-optional) and accepts `cols`, `rows`, `cwd`, `env`. This differs from
`node-pty`'s shape only in detail — drop-in callable, same core surface.

---

## 2. Encoder regex

**Confirmed:** **per-character** (`/[^A-Za-z0-9]/g`) — **NOT** `+` collapse.

This **differs from the value spec'd before US-000a ran**. The original PRD
asserted `replace(/[^A-Za-z0-9]+/g, '-')` (collapse) based on observing zero
`--` directories in `~/.claude/projects/`. That observation was correct but
misled the audit: real project paths (`/home/user/dev/foo`) don't *contain*
consecutive non-alnums in the first place, so the absence of `--` proves
nothing about Claude's encoder.

The empirical test below uses a deliberately pathological input — a path
with `..` — to disambiguate.

### Empirical test command (verbatim)

```bash
mkdir -p '/tmp/ralph-encoder-test..foo'
UUID=$(cat /proc/sys/kernel/random/uuid)
(cd '/tmp/ralph-encoder-test..foo' && \
  claude --session-id "$UUID" --dangerously-skip-permissions --print 'hi' </dev/null)
ls ~/.claude/projects/ | grep -i ralph-encoder-test
```

### Empirical test output

```
UUID=bead2fc9-6238-487f-b70b-296e94cf3dae
Hi! What would you like to work on?

$ ls ~/.claude/projects/ | grep -i ralph-encoder-test
-tmp-ralph-encoder-test--foo
```

The resulting `~/.claude/projects/` directory name is
**`-tmp-ralph-encoder-test--foo`** — note the **two consecutive dashes**
where the source path had `..`. Per-character mapping is the only rule
consistent with this output:

| input chunk | encoded |
| --- | --- |
| `/` | `-` |
| `tmp` | `tmp` |
| `/` | `-` |
| `ralph-encoder-test` | `ralph-encoder-test` (`-` is non-alnum, but each `-` already maps to one `-`, vacuously) |
| `..` | `--` (each `.` is one non-alnum → one `-`) |
| `foo` | `foo` |

If the regex were `/[^A-Za-z0-9]+/g` (collapse), the output would have been
`-tmp-ralph-encoder-test-foo` (single dash). It was not.

### Cleanup

```bash
rm -rf '/tmp/ralph-encoder-test..foo'
rm -rf ~/.claude/projects/-tmp-ralph-encoder-test--foo
```

Both removals confirmed (`ls` returned `No such file or directory`
afterwards). No other `~/.claude/projects/` directories were touched.

### Authoritative regex

```ts
function encodeClaudeProjectDir(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, "-");
}
```

This is the implementation that US-005a-1 must produce (the regex literal in
its acceptance criteria has been updated to match — see "Downstream impact"
below).

---

## Downstream impact

- **US-005a-1 encoder spec:** **UPDATED**.
  - `prd.json` US-005a-1 acceptance criteria #3 and #4 changed: regex
    literal is now `/[^A-Za-z0-9]/g` (no `+`); the `/foo..bar` test-case
    expected output is now `-foo--bar` (was `-foo-bar`).
  - `prd.md` (the human-readable mirror) updated identically in the
    "US-005a-1: Spawn primitive — registry, mutex, encoder, DB row" section.
- **FR-6 (PRD §Functional Requirements):** **UPDATED**.
  - `prd.md` FR-6 line changed to reference `replace(/[^A-Za-z0-9]/g, '-')`
    with empirical evidence pinned to this decision document.
- **PRD "Empirical findings" section (`prd.md` line 14):** **UPDATED**.
  - The bullet that previously claimed `+` collapse now states per-character
    and explains why the prior observation was insufficient.
- **PRD "Encoder helper" detail line (`prd.md` line 537):** **UPDATED**.
  - Mirrored regex change.
- **US-005a-2 (`prd.md` and `prd.json`):** unchanged. It only references
  US-005a-1's encoder by name, so the regex correction propagates
  transparently.
- **US-006 reconciler:** unchanged in scope, but now has a concrete value
  to match against — `comm == "bun"` — recorded in §1 above. The story's
  acceptance criteria already say "PTY-parent comm from US-000a", so no
  edit is needed; the value is now pinned here.

---

## Platform constraints

- **Linux-only is preserved.** `bun-pty` works on Linux x64 (verified
  here on `Linux 6.19.11-arch1-1` / `glibc 2.43`). The library claims
  cross-platform support (it ships Rust prebuilds for macOS as well), but
  ralph-monitor's reconciler in US-006 reads `/proc/<pid>/environ`, which
  is Linux-specific — so the PTY library itself is not the
  cross-platform-blocker; the reconciler is.
- **Bun version:** verified on `bun 1.3.13`. `bun-pty` documents Bun
  >= 1.0; the `~0.4.8` floor is conservative.
- **No native build step required.** `bun-pty` ships its Rust shared
  library prebuilt and uses `bun:ffi` to call it — no `node-gyp`, no
  `python3`, no `make`. This is the operative reason it succeeded where
  `node-pty` failed on this machine.
- **`/proc/<pid>/comm` value `bun`** is the static input for US-006's
  reconciliation match; it does not change between Bun versions
  (Bun's executable name has been stable). If a future Bun release renames
  the binary or sets a custom comm via `prctl(PR_SET_NAME)`, US-006 will
  need to re-run this check.

## Hedges / known unknowns

- The spike spawned **`bash`**, not `claude`. The PTY-parent comm value
  is determined by the *Bun process running ralph-monitor*, not by what
  it spawns inside the PTY, so `comm == "bun"` is correct regardless of
  whether the child is `bash` or `claude`. Still, no full
  ralph-monitor-spawning-claude integration test was performed in this
  spike — that's US-005a-2's job.
- The encoder test ran `claude --print 'hi'` (one-shot), not an
  interactive session. The directory was created and the JSONL was
  written, which is sufficient evidence for the encoding rule. No
  long-running session was necessary.
- Unicode-in-path was not tested empirically. The regex
  `/[^A-Za-z0-9]/g` operates on JavaScript code units, which means a
  multi-byte Unicode character will become **multiple** `-`s in the
  encoder output. If real-world Claude does something different
  (e.g., NFC normalization, UTF-8 byte counting), US-005a-1 will
  surface a bug. Recorded as a known limitation in the
  US-005a-1 unit-test acceptance criterion (already present).
- `bun-pty`'s `IPtyForkOptions.name` is required (non-optional). When
  US-005a-2 wires the real spawn, it must pass `name: "xterm-256color"`
  (or similar) — easy to miss, so flagging here.
