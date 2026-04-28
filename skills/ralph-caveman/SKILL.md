---
name: ralph-caveman
description: "Enable or disable cavemanMode on a Ralph PRD. When enabled, Ralph compresses progress files via caveman-compress (reducing input tokens on every iteration), runs a one-time compression pass on AGENTS.md/CLAUDE.md during /ralph-worktree setup, and uses caveman-style terse chat output when running headless. Commits, decision files, and AGENTS.md additions during a run always stay in full prose. Use when the user says 'run this with /ralph-caveman', 'enable caveman', 'turn on compression', 'disable caveman', or when /ralph-pilot is recommending compression separately from model delegation. Triggers on: /ralph-caveman, ralph-caveman, enable caveman, disable caveman, turn on compression, turn off compression."
version: "1.0"
---

# /ralph-caveman

Small focused skill that toggles `cavemanMode` on a Ralph PRD's prd.json. Gets explicit user confirmation before flipping the flag.

This is **one of two** independent mode flags (`modelHintMode` is the other — see `/ralph-modelhint`). They are orthogonal and can be enabled independently.

Caveman is an output/input-compression style based on [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman): "why use many token when few do trick." It drops articles, filler words, and hedging from prose while preserving code, file paths, commands, and all technical substance.

---

## What cavemanMode does

When `cavemanMode: true` on prd.json, three things change:

1. **Compressed progress history.** `ralph.sh` runs `caveman` on rotated `progress-N.txt` files after each rotation. Future iterations that read prior progress consume fewer input tokens. If `caveman` is not installed on PATH, this is a silent no-op — no failure.

2. **Compressed context files at worktree setup.** `/ralph-worktree` runs a one-time `caveman` pass on every `AGENTS.md` and `CLAUDE.md` file in the worktree (excluding node_modules / .git). These files load on every session start, so compression here is high-leverage.

3. **Terse chat output when headless.** When the run is **not** attached to ralph-tui (i.e., `RALPH_TUI != 1`), `ralph.sh` sets `RALPH_HEADLESS=1` and writes it into the prompt preamble. Ralph (see `prompt.md`) then adopts caveman-style terse output for its streaming chat: drop articles, filler, hedging; fragments OK; code/paths/commands/numbers unchanged. When attached to ralph-tui, output stays in prose so a watching human can read along comfortably.

**Always stays in full prose regardless of this flag:**
- Commit messages (must be legible in `git log` forever)
- Decision-gate files in `decisions/*.md` (the user reads these to make a decision)
- AGENTS.md additions made during a run (future developers read these — existing content may be compressed by the setup pass, but new additions go in verbose)
- The Codebase Patterns section of progress.txt (future Ralph iterations read this)

When `cavemanMode: false` (the default), nothing is compressed and chat output is always prose.

---

## When the user should enable this

Good candidates:
- Long-running PRDs where progress.txt grows large and gets rotated multiple times
- Worktrees with substantial AGENTS.md / CLAUDE.md files that load every iteration
- Any PRD where speed and token cost matter more than iteration-log readability
- Running headless via `/ralph-runner` or background — nobody watching live, so terse output is pure savings

Bad candidates:
- PRDs with many decision gates (the decision files themselves are safe, but compressed surrounding context makes pilot monitoring harder)
- New workflows where you want pristine iteration logs for debugging
- When `caveman` is not installed and the user doesn't want to install it — the compression steps become no-ops, so the only effect is terse output, which may not be worth it alone

### Prerequisite — caveman installation

Caveman-compress is a Python CLI. If `command -v caveman` returns nothing, the compression steps silently no-op. The terse output still works because it's driven by prompt.md reading the preamble flag, not by the CLI.

Installation options (only needed if the user wants the compression benefit):
- `npx skills add JuliusBrussee/caveman/caveman-compress` (cross-agent)
- `claude plugin marketplace add JuliusBrussee/caveman && claude plugin install caveman@caveman` (installs the plugin globally, with the side effect of auto-activating caveman in every Claude Code session — **don't use this if you want per-PRD scoping**, the prd.json flag approach is cleaner)
- From the local clone at `d:/caveman/caveman-compress/`: `cd d:/caveman/caveman-compress && pip install -e .`

Check before promising the user compression will happen.

---

## How to run this skill

### Step 1 — Identify the PRD

If the user named a task directory ("run console-v2 with /ralph-caveman"), use `tasks/{name}/prd.json`. If ambiguous or unnamed, list task dirs with a prd.json and ask.

### Step 2 — Read current state

```bash
jq '{modelHintMode, cavemanMode, stories: (.userStories | length)}' tasks/{effort-name}/prd.json
command -v caveman >/dev/null 2>&1 && echo "caveman: installed" || echo "caveman: NOT installed"
```

Report current flag values and whether caveman is installed. If the user asked to enable and it's already enabled, say so and stop. Same for disable.

### Step 3 — Assess fit (when enabling)

Quickly check:
- How many decision-gate stories are in the PRD? (>3 → note that monitoring will be harder)
- Is ralph-tui likely to be used for this run, or headless? (tui = terse output doesn't apply; headless = full benefit)
- Is there an existing progress.txt that's already large? (immediate compression win on rotation)

### Step 4 — Get explicit confirmation

Ask the user in this shape:

```
This PRD has {N} stories. cavemanMode does three things:

- Compresses rotated progress-N.txt files (if caveman is installed: {yes|no})
- Compresses AGENTS.md / CLAUDE.md once during /ralph-worktree setup 
  (if caveman is installed: {yes|no})
- Uses terse caveman-style chat output when Ralph runs headless (ralph-tui 
  attached → still prose)

Always-prose carve-outs: commits, decisions/*.md, AGENTS.md additions during 
runs, and the Codebase Patterns section of progress.txt.

{If caveman NOT installed: "Note — caveman isn't on PATH, so only the terse 
headless-output behavior will actually take effect unless you install it 
(npx skills add JuliusBrussee/caveman/caveman-compress)."}

{If >3 decision gates: "Note — this PRD has {D} decision gates. Terse iteration 
output can make mid-run monitoring harder; the decision files themselves stay in 
prose."}

Confirm enable, or reply "no" / "cancel" to leave it off.
```

Proceed only on explicit yes.

### Step 5 — Flip the flag

```bash
# Enable
jq '.cavemanMode = true' tasks/{effort-name}/prd.json > /tmp/prd.tmp && \
  mv /tmp/prd.tmp tasks/{effort-name}/prd.json

# Disable
jq '.cavemanMode = false' tasks/{effort-name}/prd.json > /tmp/prd.tmp && \
  mv /tmp/prd.tmp tasks/{effort-name}/prd.json
```

### Step 6 — Optional: one-time compression pass now

If the user just enabled cavemanMode AND the worktree already exists AND caveman is installed, offer to run the one-time AGENTS.md / CLAUDE.md compression now (rather than waiting for it to happen the next time `/ralph-worktree` runs):

```
Want me to run the one-time caveman pass on AGENTS.md / CLAUDE.md files in the 
worktree right now? It'll save input tokens starting with the next iteration. 
(Originals are preserved as *.original.md.) Reply yes or no.
```

If yes:
```bash
cd {worktree-path}
find . -name 'AGENTS.md' -not -path '*/node_modules/*' -not -path '*/.git/*' -print0 | \
  xargs -0 -I {} caveman "{}" 2>&1
[ -f CLAUDE.md ] && caveman CLAUDE.md 2>&1
```

Report the total tokens saved (caveman prints this per file).

### Step 7 — Report

```
cavemanMode: {true|false} for tasks/{effort-name}/prd.json.
{If true and compression ran: Compressed {N} files, saved ~{T} tokens.}
{If true and Ralph not yet launched: Next run will also compress progress files 
after rotation and use terse output when headless.}
{If Ralph is currently running: the flag takes effect on the NEXT iteration; 
the in-flight iteration runs with the previous setting.}
```

---

## Interaction with `/ralph-modelhint`

`modelHintMode` is a completely separate flag that controls delegation and parallelism. This skill does NOT touch it. If the user asks for both ("enable /ralph-modelhint and /ralph-caveman"), run both skills in sequence — each asks its own confirmation.

`/ralph-pilot` §11 handles the combined recommendation flow when both are being considered together.

---

## Anti-patterns

- **Flipping the flag without confirmation.** Always ask.
- **Promising compression without checking that caveman is installed.** If it's not, say so — the terse-output behavior still works, but the compression benefit requires the CLI.
- **Compressing anything on the don't-compress list.** Never run caveman on `decisions/*.md`, active prd.md, prd.json, or git-tracked commit message drafts. If unsure, don't.
- **Installing the caveman plugin globally to "make this work".** The plugin's SessionStart hook activates caveman for **every** Claude Code session on this machine, not just Ralph. Per-PRD scoping via this flag is cleaner; install `caveman-compress` as a standalone CLI instead if the user wants the compression benefit.
- **Flipping while Ralph is mid-iteration.** Safe in principle (takes effect next iteration), but note it to the user.
