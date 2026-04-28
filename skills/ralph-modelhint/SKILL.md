---
name: ralph-modelhint
description: "Enable or disable modelHintMode on a Ralph PRD. When enabled, Ralph delegates stories tagged with modelHint sonnet/haiku to Agent sub-tasks on those cheaper models (Opus reviews the patch and commits), and independent unblocked stories may run in parallel. Use when the user says 'run this with /ralph-modelhint', 'enable model hints', 'turn on delegation', 'disable model hints', or when /ralph-pilot is recommending delegation separately from caveman mode. Triggers on: /ralph-modelhint, ralph-modelhint, enable model hints, disable model hints, turn on delegation, turn off delegation."
version: "1.0"
---

# /ralph-modelhint

Small focused skill that toggles `modelHintMode` on a Ralph PRD's prd.json. Gets explicit user confirmation before flipping the flag.

This is **one of two** independent mode flags (`cavemanMode` is the other — see `/ralph-caveman`). They are orthogonal and can be enabled independently.

---

## What modelHintMode does

When `modelHintMode: true` on prd.json, Ralph's iteration loop (see `prompt.md`) behaves differently:

1. **Delegation:** For each story you pick whose `modelHint` is `"sonnet"` or `"haiku"` (not `"opus"` and not absent), Ralph spawns an `Agent` sub-task on that model. The sub-agent reads the story, produces a patch, runs the validation gate locally, and returns the patch as text. Opus (the main loop) reviews the patch, applies it with Edit/Write, re-runs the validation gate, updates prd.json, and commits. One commit per story as usual.

2. **Parallelism:** When 2+ unblocked stories have non-opus hints and touch disjoint file sets, Ralph launches the Agent sub-tasks in a single message with multiple parallel tool calls. Apply + commit remains strictly serialized. Cap is 3 concurrent sub-agents.

3. **Safety carve-outs:** These stories always run on Opus regardless of their `modelHint`:
   - `type: "decision-gate"` stories
   - Stories with `canSpawnStories: true`
   - The final validation story (highest priority, usually US-999)

When `modelHintMode: false` (the default), `modelHint` fields are **ignored**. All stories run serially on Opus. Safe to add hints proactively on any PRD — they're inert until the flag flips.

---

## When the user should enable this

Good candidates:
- PRD has 15+ stories with ≥50% mechanical work (CRUD, view XML from a spec, callsite migrations, test scaffolds, straight-from-spec UI)
- The user has flagged token cost or wall-clock time as a constraint
- The user is running the same pattern repeatedly across many files and wants Haiku to handle the typing while Opus reviews

Bad candidates:
- Research / investigation PRDs (decision quality dominates)
- PRDs with >3 decision gates (the safety carve-outs leave little to delegate)
- First PRD in an unfamiliar codebase (you don't yet know what's "mechanical" here)
- PRDs where >50% of stories would carry `modelHint: "opus"` anyway (delegation overhead defeats the point)

---

## How to run this skill

### Step 1 — Identify the PRD

If the user named a task directory ("run console-v2 with /ralph-modelhint"), use `tasks/{name}/prd.json`. If ambiguous or unnamed, list task dirs with a prd.json and ask.

### Step 2 — Read current state

```bash
jq '{modelHintMode, cavemanMode, stories: (.userStories | length)}' tasks/{effort-name}/prd.json
```

Report the current flag values to the user. If the user asked to enable and it's already enabled, say so and stop. Same for disable.

### Step 3 — Assess fit (when enabling)

Quickly classify the stories. Count how many are MECHANICAL (CRUD, migration + column, view XML, callsite rename, test scaffolds) vs THINKING (design, business logic, refactors touching multiple concerns) vs DECISION/RESEARCH (decision-gate, canSpawnStories, final validation).

Form a recommendation:
- ≥50% MECHANICAL → recommend enabling
- 30–49% MECHANICAL → marginal; note that savings may be modest
- <30% MECHANICAL → recommend NOT enabling; explain why

### Step 4 — Get explicit confirmation

Ask the user in this shape:

```
This PRD has {N} stories: {M} mechanical, {T} thinking, {D} decision/research.

Enabling modelHintMode will:
- Delegate mechanical stories to Haiku (Opus reviews the patch and commits)
- Delegate mid-complexity stories to Sonnet if tagged that way
- Run independent unblocked stories in parallel (up to 3 at once)
- Keep decision gates, discovery, and US-999 on Opus regardless

Tradeoff: if a "mechanical" classification is wrong, the sub-agent's patch needs 
rework on Opus. Opus also reviews every delegated patch, so quality floor is 
maintained — but review itself has a cost.

Confirm enable, or reply "no" / "cancel" to leave it off.
```

Proceed only on explicit yes.

### Step 5 — Flip the flag and (optionally) populate hints

```bash
# Enable
jq '.modelHintMode = true' tasks/{effort-name}/prd.json > /tmp/prd.tmp && \
  mv /tmp/prd.tmp tasks/{effort-name}/prd.json
```

If the user is enabling and no stories have `modelHint` set yet, offer to populate them using the heuristics in `skills/ralph/SKILL.md` §Optional Mode Flags → modelHint guidance. Ask:

```
Want me to populate modelHint on each story now? I'll classify each:
- opus for architecture, design, decision gates, discovery, US-999
- sonnet for non-trivial business logic and multi-module refactors
- haiku for CRUD, view XML, callsite renames, test scaffolds

Reply "yes, populate" — or "no, I'll do it" if you want to set them manually.
```

If yes, walk through each story, assign a tier, and write them back. Show the user a summary table (`{id} | {title} | {hint}`) and ask for any corrections before saving.

### Step 6 — Disable path

```bash
jq '.modelHintMode = false' tasks/{effort-name}/prd.json > /tmp/prd.tmp && \
  mv /tmp/prd.tmp tasks/{effort-name}/prd.json
```

Don't strip the `modelHint` fields — they're inert when the flag is off, and keeping them means re-enabling later doesn't require re-classifying.

### Step 7 — Report

```
modelHintMode: {true|false} for tasks/{effort-name}/prd.json.
{If true and hints populated: {N} stories tagged — {a} opus, {b} sonnet, {c} haiku.}

{If Ralph is currently running: note that the flag only takes effect on the NEXT 
iteration; in-flight iteration runs with the previous setting.}
```

---

## Interaction with `/ralph-caveman`

`cavemanMode` is a completely separate flag that controls output compression and terse chat output. This skill does NOT touch it. If the user asks for both ("enable /ralph-modelhint and /ralph-caveman"), run both skills in sequence — each asks its own confirmation.

`/ralph-pilot` §11 handles the combined recommendation flow when both are being considered together.

---

## Anti-patterns

- **Flipping the flag without confirmation.** Always ask. "I think you'd benefit from modelHintMode" isn't confirmation.
- **Flipping while Ralph is mid-iteration.** Safe in principle (takes effect next iteration), but note it to the user so they're not confused when the next iteration behaves differently.
- **Populating hints without understanding the stories.** If you're unsure, default to `opus`. A wrongly-hinted opus story costs a tiny bit of extra Opus tokens; a wrongly-hinted haiku story produces a bad patch that needs rework.
- **Stripping modelHint fields when disabling.** They're inert when the flag is off; keeping them preserves optionality.
