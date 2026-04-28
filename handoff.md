# ralph-claude — Session Handoff

## What This Project Is

`d:/ralph-claude` is the **Ralph framework repo itself** — not a project-being-built-with-Ralph. It contains the Ralph autonomous-agent loop (`ralph.sh`, `ralph-tui`), the prompt Ralph loads each iteration (`prompt.md`), and the Claude Code skills that orchestrate Ralph (`/prd`, `/ralph`, `/ralph-audit`, `/ralph-pilot`, `/ralph-worktree`, `/ralph-runner`, `/ralph-handoff`, `/research-prd`, and as of this session `/ralph-caveman` and `/ralph-modelhint`).

Changes made here affect how Ralph behaves everywhere downstream — any repo the user runs Ralph against picks up the installed versions from `~/.claude/skills/` and `~/.config/ralph/prompt.md`.

### Critical Rule

**This repo has no `tasks/` PRDs of its own.** Work is done directly on `main` (or short-lived branches) and shipped via install script. Don't look for PRD-driven workflows here — that's the pattern this framework *enables* elsewhere, not the pattern it uses on itself.

## Repository Map

| Path | Purpose |
|---|---|
| `prompt.md` | The prompt Ralph loads every iteration. ralph.sh prepends per-iteration context and feeds to `claude --print`. |
| `ralph.sh` | The iteration loop. Reads prd.json, runs claude, handles progress.txt rotation, API-error backoff. |
| `ralph-i.sh` | Interactive (tmux) wrapper around ralph.sh. |
| `ralph-tui/` | Rust TUI (built separately via installer). |
| `skills/*/SKILL.md` | The skill definitions copied to `~/.claude/skills/` by install.sh. |
| `prd.json.example` | Reference example consumed by `/ralph` skill as the schema contract. |
| `install.sh` / `install.ps1` / `install.cmd` | Copies skills → `~/.claude/skills/`, prompt.md → `~/.config/ralph/prompt.md`, and **builds ralph-tui binary** — the binary build is the slow step; skip if you only need skill updates. |
| `hooks/` | Hooks for ralph-tui (stop-iteration.sh, settings.json). |

## Current State (as of 2026-04-14)

On `main`, working tree has uncommitted changes from this session. **Nothing has been committed yet.** The work is both on-disk in the repo AND manually installed to the user's global `~/.claude/skills/` and `~/.config/ralph/prompt.md` (see "Uncommitted Work" below).

### Uncommitted Work (This Session)

The session added two independent mode flags (`modelHintMode` and `cavemanMode`) to prd.json, plus two companion skills to toggle them with user confirmation. These replaced an earlier single-flag design (`executionMode: "standard"|"efficiency"`) that existed briefly within the same session — the independent-flags design is the final one.

| File | Change | Version |
|---|---|---|
| `skills/ralph/SKILL.md` | schema 2.2→2.4; replaced `executionMode` with `modelHintMode` + `cavemanMode` booleans; added §Optional Mode Flags w/ modelHint heuristics table | 2.4→2.6 |
| `skills/prd/SKILL.md` | modelHint guidance references `modelHintMode`; optional per-story hint field documented | 1.4→1.5 |
| `skills/ralph-pilot/SKILL.md` | Phase 1 step 8 (assess flags), Phase 2 step 6 (surface flags in launch summary), §11 rewritten with two independent scoring worksheets + three confirmation shapes + per-flag downgrade protocols | 1.1.0→1.3.0 |
| `skills/ralph-audit/SKILL.md` | Angle 6 (conditional) now evaluates each flag independently; 4 sub-checks; separate deliverable categories per flag | 1.0→1.2 |
| `skills/ralph-worktree/SKILL.md` | Step 4.6 runs caveman-compress on AGENTS.md/CLAUDE.md when `cavemanMode: true` (silent no-op if `caveman` not on PATH) | 1.0→1.2 |
| `skills/ralph-caveman/SKILL.md` | **NEW.** Toggles `cavemanMode`. Checks caveman CLI install, asks confirmation, offers one-time compression pass. | 1.0 |
| `skills/ralph-modelhint/SKILL.md` | **NEW.** Toggles `modelHintMode`. Asks confirmation, offers to populate modelHint fields via heuristics. | 1.0 |
| `prompt.md` | Two independent gated sections (modelHintMode delegation + parallel sub-agents; cavemanMode terse output via `RALPH_HEADLESS: 1` preamble line) | 2.5→2.7 |
| `ralph.sh` | Reads `.modelHintMode` + `.cavemanMode` from prd.json; exports `RALPH_HEADLESS=1` when `cavemanMode=true` AND `RALPH_TUI!=1`; compresses rotated `progress-N.txt` when `cavemanMode=true`; writes both flag values into the prompt preamble | (no version header) |
| `prd.json.example` | schema 2.4, `modelHintMode: false`, `cavemanMode: false`, sample `modelHint: "haiku"` on US-001 | — |

### Global Install State (Manual, Already Done)

The user ran a manual copy (installer would have rebuilt ralph-tui binary which they didn't want right now). Installed globally:

| Skill | Installed Version |
|---|---|
| prd | 1.5 |
| ralph | 2.6 |
| ralph-audit | 1.2 |
| ralph-pilot | 1.3.0 |
| ralph-worktree | 1.2 |
| ralph-caveman | 1.0 |
| ralph-modelhint | 1.0 |
| prompt.md (`~/.config/ralph/prompt.md`) | 2.7 |

Backup of prior prompt.md: `~/.config/ralph/prompt.md.backup-20260414-122003`. `ralph.sh` was NOT globally copied — it lives in this repo and is invoked from here or from worktrees.

## The Two Mode Flags (Design Reference)

Both flags default to `false` on new prd.json (classic Ralph: full Opus, serial, prose). They are **orthogonal** — enable either, both, or neither.

| Flag | On | Off |
|---|---|---|
| `modelHintMode` | Stories tagged `modelHint: "sonnet"\|"haiku"` delegate to Agent sub-tasks on those models; Opus reviews returned patch, re-runs validation, commits. Independent unblocked non-opus stories run in parallel (cap 3). Decision gates / `canSpawnStories: true` / US-999 always stay on Opus. | `modelHint` fields ignored; all stories run serially on Opus main thread. |
| `cavemanMode` | `ralph.sh` compresses rotated `progress-N.txt` via `caveman` CLI. `/ralph-worktree` compresses AGENTS.md/CLAUDE.md once at setup. Headless runs (`RALPH_TUI != 1`) get terse caveman-style chat output. Commits / `decisions/*.md` / AGENTS.md additions / Codebase Patterns section of progress.txt ALWAYS stay in prose. | No compression, full prose always. |

Combinations:
- `false, false` — default / classic Ralph
- `true, false` — delegation + parallelism, full prose output
- `false, true` — Opus everywhere serial, but compressed context + terse headless output
- `true, true` — maximum efficiency (this was the "efficiency mode" in an earlier draft)

## Next Session — Suggested First Actions

1. **Decide the commit story for this session's work.** Options:
   - One big feature commit: `feat: add modelHintMode + cavemanMode independent flags (/ralph-modelhint /ralph-caveman skills)`
   - Split into two: one for the schema+infra changes, one for the two new skills
   - Split by concern: modelHint stack as one, caveman stack as another
   
   Recommendation: a single feature commit is fine — the two flags ship together as one coherent design, and splitting just adds rebase risk.

2. **Decide whether to install ralph-tui.** If the Rust TUI is behind HEAD, run `./install.sh --force` (will rebuild binary — slow) or stay on the old TUI if it still works with the new prd.json schema. The TUI reads `.schemaVersion`, `.userStories[].passes`, `.description` — it does NOT read `modelHintMode`/`cavemanMode`/`modelHint`, so the old binary should work fine. Worth a spot test.

3. **Verify nothing was missed.** Greps against stale references already ran clean in-session:
   - Only two remaining `executionMode`/`efficiency` references exist and are intentional backward-compat hints (see `skills/ralph/SKILL.md:294` and `skills/ralph-pilot/SKILL.md:576`).
   - `bash -n ralph.sh` passes.
   - `jq` validates prd.json.example against the 2.4 schema.

4. **No tests exist in this repo for skill files or prompt.md.** Validation is manual (the skill files are read by Claude Code, not executed).

## Key Findings from This Session

1. **`/advisor` is a built-in Claude Code CLI feature, not a loadable skill.** It's a model-routing harness command, not available at runtime for invocation by Ralph. An earlier idea that Ralph should call `/advisor` per story was scrapped — in its place, `modelHint` (authored at PRD-creation time, zero runtime overhead) does the routing.

2. **Caveman-compress only compresses OUTPUT tokens from Claude's speaking.** The bigger cost driver for Ralph is INPUT tokens (progress.txt + AGENTS.md + file reads loaded every iteration). The `caveman-compress` CLI (not the plugin) rewrites those input files in place and is the higher-leverage integration. This is why `cavemanMode` touches progress.txt + AGENTS.md compression, not just chat output style.

3. **DO NOT install the Caveman plugin via `claude plugin install caveman@caveman`.** That installs a SessionStart hook that activates caveman for **every** Claude Code session on the machine, not just Ralph. Per-PRD scoping via the `cavemanMode` flag + prompt.md is cleaner. If the compression benefit is desired, install just the `caveman-compress` standalone CLI via `npx skills add` or from the local clone at `d:/caveman/caveman-compress/`.

4. **Parallel Agent sub-agents must strictly serialize the apply+commit step.** Two concurrent `git commit`s in the same worktree stomp each other. prompt.md's modelHintMode section enforces: sub-agents produce *patches as text*; Opus main thread applies and commits one at a time. Cap is 3 concurrent sub-agents (any more and review quality degrades).

5. **Safety carve-outs are mandatory for modelHintMode.** Decision-gate stories, `canSpawnStories: true` discovery stories, and the final US-999 validation story always run on Opus regardless of their `modelHint`. This is enforced in prompt.md. Set `modelHint: "opus"` on them anyway for PRD self-documentation.

6. **`RALPH_HEADLESS` is passed to the model via prompt preamble, not env var.** The Claude CLI subprocess inherits the env var from `ralph.sh`, but the model itself doesn't read env vars — it reads the prompt. So ralph.sh writes `RALPH_HEADLESS: 1|0` into the prompt text. prompt.md keys off the preamble line, not an env var check.

7. **`install.sh` builds the ralph-tui Rust binary.** If all you want is skill/prompt.md updates, do a manual copy instead (as done at end of this session). See the "Global Install State" table for the exact copy operations.

8. **There were TWO design iterations in this session.** First pass bundled both behaviors under a single `executionMode: "standard"|"efficiency"` flag. User pushed back — they wanted independent toggles. Final design (what's now in the repo and installed) uses two orthogonal booleans. If you see any lingering `executionMode` text anywhere, it's leftover from the first iteration and should be removed — except the two intentional backward-compat hints at `skills/ralph/SKILL.md:294` and `skills/ralph-pilot/SKILL.md:576`.

## Deferred Verifications (next agent: please complete)

Context was tight at handoff time (user couldn't /compact). The following were NOT run:

### [ ] Manual smoke test of prompt.md mode-flag handling
- **What:** Create a throwaway `tasks/test-flags/` with a two-story prd.json, one story with `modelHint: "haiku"`, set `modelHintMode: true`, run `./ralph.sh tasks/test-flags` for one iteration, verify Ralph spawns an Agent sub-task on Haiku instead of implementing directly.
- **Also:** verify `RALPH_HEADLESS: 1` appears in the prompt preamble when `cavemanMode: true` and `RALPH_TUI` is unset.
- **Why deferred:** live integration test requires a live Claude CLI call; didn't want to spend the tokens within this session's budget.

### [ ] Decide whether to install caveman-compress CLI
- **What:** Run `command -v caveman` — if nothing, install via `cd d:/caveman/caveman-compress && pip install -e .` (or npx). Without it, `cavemanMode: true` runs but the compression steps silent-no-op; only the terse-output behavior actually takes effect.
- **Why deferred:** user hasn't decided whether they want the plugin vs the standalone CLI vs just the terse-output behavior.

### [ ] Verify old ralph-tui binary handles schema 2.4 prd.json
- **What:** Open a worktree with a new-schema prd.json in the currently-installed ralph-tui; verify task selection, story counts, and pass/fail rendering still work.
- **Why deferred:** requires a GUI smoke test; wasn't done this session.

## Evidence & Documents

This session produced no evidence files (no PRD workflow, no test runs captured). Changes are the code diffs themselves — reviewable via `git diff`.

---

*Handoff written 2026-04-14 at end of session under tight context. User instructed to move to next session; no /compact available on standard-context billing. Proceed cautiously — the three deferred verifications above are the highest-value next-session work.*
