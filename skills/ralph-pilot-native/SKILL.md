---
name: ralph-pilot-native
version: "0.2"
description: Native-subagent alternative to /ralph-pilot. Orchestrates a PRD execution end-to-end as a single Claude Code session that preserves its context across the whole PRD by delegating EVERY implementation story to a sub-agent via the Agent tool — defaulting to opus, downgrading to sonnet/haiku only with explicit reasoning when the work is mechanical. The orchestrator's main thread is reserved for orchestration (review, apply, validate, commit) plus safety-carve-outs (decision gates, discovery stories, final validation). Backed by a systemd-user-timer watchdog that resurrects the orchestrator via `claude --resume` if it dies. Triggers on "run this PRD natively", "ralph-pilot-native", "native ralph", "skip the ralph loop", "execute this PRD with subagents".
---

# Ralph-Pilot-Native

You are the operator of native PRD execution. Where `/ralph-pilot` orchestrates `ralph.sh` (a bash loop that respawns Claude per iteration), `/ralph-pilot-native` orchestrates a **single Claude Code session** that holds the entire PRD context and uses the `Agent` tool to fan out story execution.

A `systemd --user` timer watchdog provides crash resilience: if your session dies, a heartbeat-driven trigger relaunches you via `claude --resume <session-id> --dangerously-skip-permissions -p "$(cat watchdog-prompt.md)"`.

This skill is the native counterpart of `/ralph-pilot`. Phases 1 (Authoring) and 4 (Post-execution) are identical to `/ralph-pilot` — read that skill for those. Phases 2 (Setup) and 3 (Execution) diverge and are documented here.

---

## When to use this skill vs /ralph-pilot

| Use `/ralph-pilot-native` when | Use `/ralph-pilot` (loop-based) when |
|---|---|
| You want strict orchestrator/sub-agent separation | You're fine with single-agent loop iterations |
| User is actively engaged (steering, reviewing) | Truly unattended overnight runs |
| Decision gates already resolved | Many emerging decision gates expected |
| Stories cluster into parallel-friendly batches | Stories must run strictly serially |
| Single PRD | Multi-PRD parallelism (use `/ralph-runner`) |
| 1M context for the orchestrator can hold whole PRD | PRD is so large it would blow context anyway |

If unsure, default to `/ralph-pilot` (loop-based). The loop is more battle-tested. This skill is for cases where the loop's iteration overhead is buying you nothing.

---

## Phase 2 — Execution Setup (the divergence point)

Phase 1 (Authoring) and `/ralph` (prd.md → prd.json conversion) and `/ralph-worktree` are identical to `/ralph-pilot`. Do those first.

Once you have `tasks/<prd>/prd.json` in an isolated worktree:

### 2.1 Find your own session ID

```bash
# Sessions live at ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
# The encoding is the absolute path with / replaced by -.
SESSION_ID=$(ls -t ~/.claude/projects/$(pwd | sed 's|/|-|g')/*.jsonl 2>/dev/null \
  | head -1 | xargs -I{} basename {} .jsonl)
echo "$SESSION_ID"
```

If empty, the session hasn't been persisted to JSONL yet — run any tool call (e.g., `ls`) and retry.

### 2.2 Bootstrap the watchdog

```bash
TASK_DIR="$(pwd)/tasks/<prd-slug>"
WORKTREE_DIR="$(pwd)"
SKILL_DIR="$HOME/.claude/skills/ralph-pilot-native"

bash "$SKILL_DIR/templates/install-watchdog.sh" \
  "$TASK_DIR" "$WORKTREE_DIR" "$SESSION_ID"
```

What `install-watchdog.sh` does:
- Renders `~/.config/systemd/user/ralph-pilot-native-<task-slug>.{service,timer}` from templates
- Copies `run-watchdog.sh` into `<task-dir>/.watchdog/`
- Copies `watchdog-prompt.md` into `<task-dir>/`
- Runs `systemctl --user daemon-reload` and `systemctl --user enable --now <unit>.timer`
- Timer fires every 25 min; staleness threshold is 20 min on `.heartbeat`

### 2.3 Stage the orchestrator prompt and initial heartbeat

```bash
cp "$SKILL_DIR/templates/orchestrator-prompt.md" "$TASK_DIR/"
touch "$TASK_DIR/.heartbeat"
```

Then **read `<task-dir>/orchestrator-prompt.md` yourself** — it is your operating instructions for Phase 3. The `Skill` tool only loaded `SKILL.md`; the orchestrator prompt is the working manual.

---

## Phase 3 — Execution (single session, holding the whole PRD)

The orchestrator's job is to PRESERVE its context budget across the lifetime of the PRD by delegating every implementation story to a sub-agent. The orchestrator reads the PRD once, plans, dispatches, reviews, applies, commits — it does NOT read source files to figure out how to implement a story.

Operate per `<task-dir>/orchestrator-prompt.md`:

- Read prd.md / prd.json / progress.txt / handoff.md once
- Pick highest-priority unblocked story batch
- For each story (unless it's a safety-carve-out): **dispatch via `Agent`**. Default `model: "opus"`. Downgrade to `"sonnet"` or `"haiku"` only with explicit reasoning logged in progress.txt
- Up to 3 concurrent sub-agents when stories touch disjoint files (parallel `Agent` calls in one message, then apply/commit serially as patches return)
- Review returned patches; pull back to main thread only if the patch hedged or the validation gate fails on re-run
- Apply the patch via Edit/Write, re-run the validation gate yourself, update `prd.json` per-criterion passes, append to progress.txt, commit (one commit per story)
- `touch <task-dir>/.heartbeat` at every commit and before each `Agent` call
- Repeat until done or context tightens enough that handoff is wise

**Safety carve-outs (orchestrator implements these on main thread):** decision-gate stories, discovery stories with `canSpawnStories: true`, final validation story (e.g. `US-999`), and surgical clean-up of a sub-agent patch that hedged. Everything else is dispatched.

**Anti-pattern to refuse:** "this story is small/mechanical, I'll just do it on main thread." The orchestrator's context is the scarce resource — every story you implement on the main thread costs context that future story-orchestration needs. If a story is genuinely trivial, dispatch it on haiku (with the reasoning noted) — that's what haiku is for.

Monitoring is self-monitoring. When the user asks "how's it going?", read `prd.json` + `git log` directly — same data as `/ralph-pilot` checkpoints, no bash subprocess to interrogate.

### Heartbeat discipline

The watchdog's only signal is `<task-dir>/.heartbeat` mtime. Touch it:
- At the start of every story commit (mandatory)
- Before every `Agent` tool call (mandatory — sub-agents can run >5 min)
- Before any operation expected to take >5 min

You do not need to spam the heartbeat. The watchdog tolerates 20 min between updates. Naturally update as part of the workflow.

### Watchdog firing semantics

If the timer fires while heartbeat is fresh: silent exit, no resurrection. If stale: `claude --resume <id> -p "$(cat watchdog-prompt.md)"` runs as a one-shot resumed conversation. The resumed session reads handoff.md / prd.json / git log, picks up where it left off, exits.

The `run-watchdog.sh` holds a flock to prevent overlapping resurrections. The `--dangerously-skip-permissions` flag is passed (permissions don't carry through `--resume`).

### Pro-active handoff (preferred over watchdog resurrection)

When you see context utilization climbing past ~70%, the next story would need substantially different context, or the user signals end of session: invoke `/ralph-handoff`, write `handoff.md`, exit cleanly. The watchdog will resurrect on the next tick (heartbeat goes stale), the resumed session reads `handoff.md`, continues with fresh context.

Watchdog resurrection is the **failure-mode safety net**, not the primary continuity mechanism. Pro-active handoff produces cleaner state transitions.

---

## Phase 4 — Post-execution

Identical to `/ralph-pilot` Phase 4, plus one extra step:

**Disable the watchdog** before merging:

```bash
# Option A: Let the watchdog disable itself on next tick
touch "$TASK_DIR/.stop-watchdog"

# Option B: Disable directly
systemctl --user disable --now "ralph-pilot-native-$(basename "$TASK_DIR").timer"
```

Then proceed with cleanup commits, tracker updates, `/ralph-handoff`, merge to main, etc., per `/ralph-pilot` Phase 4.

---

## Templates shipped with this skill

All in `~/.claude/skills/ralph-pilot-native/templates/`:

| File | Purpose |
|---|---|
| `orchestrator-prompt.md` | Phase 3 operating instructions — copied into task dir, you read it |
| `watchdog-prompt.md` | Prompt fed to `claude --resume` on resurrection |
| `install-watchdog.sh` | Bootstrap: renders systemd units, stages files, enables timer |
| `run-watchdog.sh` | Per-tick liveness check + resurrection — copied into `<task-dir>/.watchdog/` |
| `watchdog.service.template` | systemd user service unit |
| `watchdog.timer.template` | systemd user timer unit |

Templates use `@PLACEHOLDER@` markers; `install-watchdog.sh` renders them via `sed`.

---

## Failure modes this skill is designed to prevent

- **Lost work on session crash** — watchdog resurrects via `--resume` with full prior context
- **Context exhaustion mid-PRD** — proactive handoff + watchdog pickup with handoff loaded
- **Wasted iteration latency** — no per-iteration restart cost like `ralph.sh` (2–10 min/iter)
- **Wrong-model overspend** — native `Agent` model selection per `modelHint` (Ralph hardcodes one model)
- **False resurrection** — heartbeat protocol prevents the watchdog from killing a healthy session
- **Concurrent resurrection** — flock in `run-watchdog.sh` serializes ticks
- **Permissions drift** — `--dangerously-skip-permissions` passed on every resurrection (matches bootstrap)

## Known limitations and escape hatches

### `--fork-session` for the concurrent-write race

If the orchestrator stops touching `.heartbeat` for an extended period AND the watchdog's process-presence + JSONL fallback signals also miss (rare), the runner could spawn a `claude --resume <id>` while the original session is still alive — both writing to the same session JSONL concurrently. The multi-signal liveness check in `run-watchdog.sh` is designed to prevent this; the orchestrator-prompt's "use `run_in_background: true` for long Agent calls" guidance further reduces the window.

If you ever observe the race in practice (corrupted session history, duplicate tool-use events in the JSONL, two claude processes writing the same file), enable `--fork-session` in `run-watchdog.sh`:

```bash
"$CLAUDE_BIN" \
    --resume "$SESSION_ID" \
    --fork-session \
    --dangerously-skip-permissions \
    --print \
    "$(cat "$PROMPT_FILE")" </dev/null
```

`--fork-session` creates a new session ID instead of reusing the original. To make subsequent watchdog ticks pick up the latest fork (rather than always re-resuming from the bootstrap baseline), the resumed session must write its new ID to `<task-dir>/.session-id`, and the runner should read that file (falling back to the bootstrap arg if absent). This is a small additional change to `run-watchdog.sh` and the watchdog-prompt.md — it's left out of the default because the race is rare and the complexity is real.

## What this skill does NOT do

- Multi-PRD orchestration — use `/ralph-runner`
- Cross-machine execution — systemd user timer is local to one host
- Sandboxing — full tool access via skip-perms; use only on isolated worktrees you control
- macOS / Windows — systemd is Linux-only. On macOS use `launchd`; on Windows use Task Scheduler. Templates would need reworking.

---

## Quick reference — bootstrap sequence

```bash
# Prereqs: prd.md authored, audited, and worktree created (see /ralph-pilot Phases 1–2)

# 1. Convert PRD to prd.json
/ralph

# 2. Discover your own session ID
SESSION_ID=$(ls -t ~/.claude/projects/$(pwd | sed 's|/|-|g')/*.jsonl 2>/dev/null \
  | head -1 | xargs -I{} basename {} .jsonl)

# 3. Bootstrap watchdog
SKILL=~/.claude/skills/ralph-pilot-native
bash "$SKILL/templates/install-watchdog.sh" \
  "$(pwd)/tasks/<prd-slug>" "$(pwd)" "$SESSION_ID"

# 4. Stage orchestrator prompt + heartbeat
cp "$SKILL/templates/orchestrator-prompt.md" "tasks/<prd-slug>/"
touch "tasks/<prd-slug>/.heartbeat"

# 5. Read the orchestrator prompt and start orchestrating
cat "tasks/<prd-slug>/orchestrator-prompt.md"
```

When complete:

```bash
touch "tasks/<prd-slug>/.stop-watchdog"
# OR
systemctl --user disable --now "ralph-pilot-native-<task-slug>.timer"
```

---

## Relationship to other Ralph skills

| Skill | Role under `/ralph-pilot-native` |
|---|---|
| `/prd`, `/research-prd` | Phase 1 authoring (unchanged) |
| `/ralph-audit` | End-of-Phase-1 quality gate (unchanged) |
| `/ralph` | prd.md → prd.json (unchanged) |
| `/ralph-worktree` | Single-PRD worktree isolation (unchanged) |
| `/ralph-handoff` | Pro-active session transition (unchanged, but used MORE here than in loop mode) |
| `/ralph-runner` | NOT used — this skill is single-PRD only |
| `ralph.sh`, `ralph-tui` | NOT used — this skill replaces them |
| `/ralph-pilot` | Sibling skill; pick one or the other per the table above |

This is the verb; the others are nouns. Same as `/ralph-pilot`.
