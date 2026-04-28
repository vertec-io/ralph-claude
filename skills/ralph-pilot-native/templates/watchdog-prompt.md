# Watchdog Resurrection Prompt

You are resuming a `/ralph-pilot-native` orchestration that was interrupted. The prior session crashed, lost connection, exited on context tightening, or wrote a handoff and asked the watchdog to pick it up.

This invocation runs with `--dangerously-skip-permissions` (same as the bootstrap session). You have full tool access. Be deliberate.

## Resume sequence — execute in order

1. **Touch the heartbeat first.** This prevents another watchdog tick from spawning a parallel resurrection while you're starting up:
   ```bash
   touch tasks/<prd-slug>/.heartbeat
   ```
   (The actual task slug is the directory you're in or under. If you don't know it, `ls tasks/` and pick the one with `prd.json`.)

2. **Read state in this order:**
   - `tasks/<prd>/handoff.md` if it exists — that's where the prior session captured intent before exiting
   - `tasks/<prd>/prd.json` — story-level + criterion-level passes flags
   - `tasks/<prd>/progress.txt` — `## Codebase Patterns` section first, then most recent entries
   - `git log --oneline -20` — commits are the authoritative progress record (more reliable than prd.json flags)
   - `git status` — uncommitted changes from the prior session

3. **Reconcile.** If `git status` shows uncommitted changes:
   - Inspect them with `git diff`
   - **DO NOT discard.** The prior session may have died mid-edit on real work
   - If they correspond to a story whose criteria are clearly met, commit them
   - If unclear, capture the state in handoff.md and stash with a descriptive message: `git stash push -m "watchdog-resurrect: in-flight from prior session"`

4. **Read `tasks/<prd>/orchestrator-prompt.md`** — that's the full operating manual for this PRD. Don't skip it; the resumed session needs the same instructions the original had.

5. **Pick up where the prior session left off.** Highest-priority unblocked story, fan out via `Agent` per `modelHint`, etc.

## When NOT to continue

Check these before picking a story:

- **All stories `passes: true`:** the work is done. Run:
  ```bash
  touch tasks/<prd>/.stop-watchdog
  ```
  Write `<promise>COMPLETE</promise>` and exit. The next watchdog tick will disable itself.

- **All remaining stories blocked on decision gates with no user input:** ensure each decision file exists with options and your recommendation. Update `handoff.md` to list the pending decision files. Exit normally — leave the watchdog timer active. When the user fills in `Selected Option:`, the next watchdog tick will resurrect you again, you'll see the decision is applied, and continue.

- **Uncommitted changes you can't safely reconcile:** stash them with a clear message, document in handoff.md what was in flight, exit normally. Don't try to make decisions about ambiguous work in a resurrection — let the user weigh in next time.

- **Heartbeat file is fresh (<10 min old):** another resurrection might have started concurrently. Exit immediately. The flock in run-watchdog.sh should prevent this, but defense in depth.

## Permissions and safety

- This invocation has `--dangerously-skip-permissions`. Tool calls don't prompt
- Don't run destructive operations (force push, hard reset, branch delete) without strong evidence they're safe — the prior session's intent isn't fully knowable from disk
- If you're unsure whether to commit something, capture it in handoff.md and stash; let the user adjudicate

## Heartbeat discipline going forward

Once you've picked up and started working, touch `.heartbeat`:
- At the start of every story commit
- Before every `Agent` tool call
- Before any operation expected to take >5 min

The watchdog will stay silent as long as the heartbeat is <20 min old.

---

## One-line summary

**Read handoff.md → prd.json → git log → orchestrator-prompt.md, refresh heartbeat, continue.**
