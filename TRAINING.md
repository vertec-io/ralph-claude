# Ralph Training Guide

**Audience:** engineers joining a team that already uses Ralph for Claude Code to execute real engineering work at scale.
**Prerequisite:** read `README.md` first — it covers installation, the single-PRD workflow, and the underlying mechanics of ralph.sh / ralph-tui. This guide picks up where the README ends.
**Scope:** how to orchestrate Ralph as a production engineering system. Multi-PRD runs, the pilot role, monitoring discipline, durable project documents, and the anti-patterns we've learned the hard way.

---

## 1. Why this guide exists

The README teaches you how to run Ralph on a single task. That's enough to ship something real — one PRD, a few stories, a couple of hours of autonomous work. But the moment you're running multiple PRDs in parallel, or a single very large effort that spans days and multiple sessions, or anything with architectural stakes that could go sideways if left unsupervised, you need a different mental model. You need a system, not a command-line tool.

This guide is that mental model. It's the playbook for using Ralph as the engineering execution layer of a small team — the way a scaled-up team would use a CI system or a ticket tracker. The difference is that Ralph is an army of autonomous coding agents, not a passive tool, which means the orchestration layer above it is also autonomous, partnering with you continuously rather than waiting for you to pull a trigger.

Every skill, every rule, every document in this guide exists because we ran into the problem it solves at least once. Nothing here is theoretical. The failure modes in §11 all actually happened.

---

## 2. The mental model

There are four layers, and every piece of work flows through all four before it ships.

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 4 — Strategy                                          │
│  Where the project is going, why, and what rules apply       │
│  Lives in: STRATEGY.md, ROADMAP.md                           │
│  Changes: rarely. Measured in months.                        │
├─────────────────────────────────────────────────────────────┤
│  Layer 3 — Plan                                              │
│  A concrete effort, scoped, audited, ready to execute        │
│  Lives in: tasks/prd-NN-*/prd.md + prd.json                  │
│  Changes: through collaborative authoring, often multi-session│
├─────────────────────────────────────────────────────────────┤
│  Layer 2 — Execute                                           │
│  Ralph running the plan story-by-story in isolated worktrees │
│  Lives in: git worktrees, ralph.sh loops, ralph-tui          │
│  Changes: continuously, by the agent, not by you             │
├─────────────────────────────────────────────────────────────┤
│  Layer 1 — Oversee                                           │
│  Watching the execution, catching problems, preserving state │
│  Lives in: outstanding-items.md, handoff.md, auto-memory     │
│  Changes: every checkpoint. The living pulse of the project. │
└─────────────────────────────────────────────────────────────┘
```

Each layer has one job and one set of tools. You don't short-circuit the layers — you don't launch execution without a plan, you don't plan without strategy, and you don't oversee a run you never launched. Breaking the layers is where problems come from.

---

## 3. The team

There are three roles in this system, and you need to recognize all three to operate it.

### The **human pilot**
You. The person reading this document. You bring:
- Business judgment and strategic intent
- Customer context and relationship knowledge
- Ownership of irreversible decisions (merging to main, publishing PRs, engaging external parties, spending money)
- The authority to say "stop, I was wrong about the whole direction, restart"
- A finite amount of attention per day

You do **not** write production code in this workflow. Not because you can't — because Ralph is faster at it and your attention is scarcer than Ralph's. Your leverage is in the PRDs you author and the strategic decisions you make, not in lines of code you type. If you find yourself writing the code Ralph was supposed to write, ask yourself whether the PRD was specific enough — that's usually the real problem.

### The **model pilot** (a.k.a. **ralph-pilot**)
This is Claude, operating via the `/ralph-pilot` skill, functioning as your engineering partner for the full lifecycle of an effort. The model pilot:
- Co-authors PRDs with you across multiple sessions
- Runs `/ralph-audit` before launch to catch gaps
- Sets up the execution environment (worktrees, launcher scripts, PID tracking)
- Monitors running Ralph loops with the checkpoint diagnostic sweep
- Intervenes on failures (hung SSH sessions, stuck iterations, orphaned processes)
- Maintains the durable documents (outstanding-items, tracker, handoff, memories)
- Reports honestly on progress, including when progress has stalled
- Transfers context across sessions so you don't lose state between runs

You and the model pilot are **partners**, not boss/subordinate. You can override the model pilot at any time, and the model pilot can push back on you at any time. Each of you brings capabilities the other doesn't have.

### **Ralph** (the executing agent)
Ralph is the autonomous coding agent running in isolated worktrees, doing the actual engineering work story by story. Each iteration is a fresh Claude Code process with clean context, a focused prompt, and access to the task directory, the code, and the tools. Ralph:
- Reads `prd.json` at the start of each iteration to find the next pending story
- Executes one story per iteration (sometimes more, sometimes partial)
- Commits its work to the worktree's branch
- Updates `prd.json` to mark acceptance criteria as they pass
- Writes to `progress.txt` to carry state between iterations
- Exits when all stories pass, or when the iteration budget runs out

Ralph is smart, fast, and genuinely autonomous — but it runs in a bounded context window, can't see what's happening in other worktrees, doesn't maintain a mental model of the full project, and can't make strategic decisions. That's what the pilots are for.

---

## 4. The skills at a glance

Ralph comes with a set of skills that map onto the four layers. Everything you do flows through them. Memorize what each one does and when to reach for it.

### Tier 1 — Authoring (Layer 3, Plan)

| Skill | What it does | When to reach for it |
|---|---|---|
| `/prd` | Generates a structured requirements document for a feature, bug, or self-expanding investigation | You have an idea or a bug and need to turn it into an executable plan |
| `/research-prd` | Generates a research PRD where stories produce decision documents with citations rather than code | You need to make an informed architectural or technology choice before you can plan the real work |
| `/ralph-audit` | Runs parallel disjoint-angle audit agents on a drafted PRD | Every PRD, before launch. Non-negotiable quality gate. |
| `/ralph-handoff` | Creates or updates `handoff.md` to preserve session state | End of any session with unfinished authoring or in-flight runs |

### Tier 2 — Execution (Layer 2, Execute)

| Skill | What it does | When to reach for it |
|---|---|---|
| `/ralph` | Converts `prd.md` to `prd.json` for Ralph to consume | After authoring is done, before the first launch |
| `/ralph-worktree` | Creates an isolated git worktree for a single PRD | Every single-PRD run. Enables parallelism by isolating from main. |
| `/ralph-runner` | Launches multiple PRDs sequentially or in parallel with worktree isolation, PID tracking, status/stop/clean subcommands | Any time you have two or more PRDs to run at once |

### Tier 0 — The operator

| Skill | What it does | When to reach for it |
|---|---|---|
| `/ralph-pilot` | The meta-skill that ties all the others together: co-authors, audits, launches, monitors, intervenes, preserves knowledge | Every session where you're actively running or planning Ralph work. It's the default operating mode. |

**Key insight:** `/ralph-pilot` is a verb; the other skills are nouns. The pilot is the thing that invokes the others in the right order with the right scope. You don't run `/prd` in isolation and call it done — you run it as part of a pilot session where the pilot then iterates with you, runs the audit, converts to JSON, sets up the worktree, and watches the loop. The pilot is how the other skills compose into a workflow.

---

## 5. Your first PRD, end to end

Here's the canonical flow for a new effort. Follow this sequence until you've internalized it; then you'll know when and why to deviate.

### Step 1 — Open a session with the model pilot

Start by asking Claude something like *"I want to plan a new effort, can you pilot this with me?"* This primes the conversation so the model enters ralph-pilot mode and applies the discipline from that skill. If the trigger doesn't fire automatically, you can explicitly say *"use /ralph-pilot for this."*

### Step 2 — State the problem, not the solution

Describe the problem you're trying to solve. Don't describe the solution you've half-decided. The pilot's first job is to ask clarifying questions that expose the hidden scope — what "done" looks like, who consumes the output, what constraints apply, what's in scope and what isn't.

Expect a conversation. A good pilot will push back on vague asks, suggest splitting overly-large efforts into phases, and surface assumptions you didn't know you were making. This is normal and desired. **Resist the urge to rush to execution.** A PRD that takes an extra hour of authoring will save ten iterations of wasted execution.

### Step 3 — Let the pilot invoke `/prd` or `/research-prd`

Once the scope is clear enough, the pilot will invoke one of the authoring skills. `/prd` for feature work, bug investigations, and most engineering efforts. `/research-prd` when the output is a decision document with citations (evaluating libraries, choosing between architectural options, exploring an unfamiliar problem space).

The output lands in `tasks/prd-NN-<effort>/prd.md` alongside an empty `progress.txt` and (for investigations) a `decisions/` subdirectory.

### Step 4 — Iterate the PRD

The first draft is a starting point, not a final deliverable. Read it back, ask the pilot to refine sections that don't match your intent, challenge stories that feel underspecified. This is where multi-session authoring shines — if you run out of context or the session is ending, have the pilot run `/ralph-handoff` to preserve state, and pick up in the next session.

### Step 5 — Run `/ralph-audit` before launch

Non-negotiable. The audit spawns multiple disjoint-angle subagents that review the PRD for gaps the author missed: scope completeness, methodology rigor, strategic alignment, hidden assumptions, mega-stories that can't fit in one iteration, broken codebase assumptions, missing verification steps.

**Expect the audit to find real issues.** Every audit we've run has surfaced something worth fixing. If the audit comes back empty, either the PRD is trivially small or the audit didn't run properly. Fold the findings back into the PRD before moving on.

### Step 6 — Convert to `prd.json` via `/ralph`

This is a mechanical skill invocation — read the PRD, produce the JSON. The pilot handles this. Priority numbers matter: stories that should run first get lower numbers.

### Step 7 — Set up execution

For a single PRD, use `/ralph-worktree` to create an isolated git worktree. You can then launch via `ralph-tui` (interactive, great for watching progress and intervening) or as a background process via `nohup bash ralph.sh <task-dir> -i N -y > log &` if you want Ralph to run while you work on something else.

For multiple PRDs, skip ahead to §6 on multi-PRD runs.

### Step 8 — Monitor via the pilot

While Ralph runs, check in periodically — every 30 minutes for fast-moving stories, every 2-3 hours for long runs involving VM builds or complex validation. Each checkpoint, the pilot runs the diagnostic sweep described in §8 and reports status, flagging any anomalies.

**Key rule:** don't touch files Ralph is actively writing. Don't edit `prd.json` while Ralph has an iteration in flight unless you know exactly what you're doing and the edit is on a cell Ralph isn't touching. The pilot knows how to inject a new story safely mid-run if needed — trust that and let the pilot do it.

### Step 9 — Post-execution

When Ralph finishes (all stories pass, or it hits the iteration budget), the pilot:
- Verifies Ralph's completion claims against the actual commit log and evidence files
- Runs any cleanup passes from `outstanding-items.md` (stuff like rename passes, leak scrubs)
- Updates the trackers and strategic documents
- Merges the ralph branch to main (with explicit user confirmation for irreversible operations)
- Writes the session handoff via `/ralph-handoff`

---

## 6. Multi-PRD runs

Some efforts involve two or more PRDs that can run concurrently or in a specific sequence. The single-PRD workflow doesn't scale to these — you need `/ralph-runner`.

### When to go multi-PRD

- **Parallel:** Two or more PRDs that touch different codebases, different files, or have no shared state. Run them concurrently to save wall-clock time.
- **Sequential:** PRDs with a strict dependency order — PRD B can't start until PRD A produces some artifact. The runner handles the gating.
- **Mixed (the most common shape):** Phase 1 runs a few PRDs sequentially (maybe PRDs that build up architectural foundations), then Phase 2 runs everything else in parallel. `launch-fips-agents.sh` is the canonical example.

### The golden rule

**Never run two Ralph loops in the same working tree.** Ever. Two agents will silently stomp on each other's commits — one wins, the other's work is lost, and you won't notice until the failing tests surface the corruption hours later. `/ralph-runner` enforces one-worktree-per-PRD via `git worktree add`, and you should structure any ad-hoc multi-PRD run the same way.

### The runner script structure

The `/ralph-runner` skill contains the full template. The high-level shape:

```bash
PRDS=(
  "tasks/prd-24|100|D:/prd-24-worktree|ralph/prd-24"
  "tasks/prd-25|20|D:/prd-25-worktree|ralph/prd-25"
)

# Subcommands: --status / --stop / --clean
# Default: launch all PRDs in the registry with isolated worktrees

for entry in "${PRDS[@]}"; do
  IFS='|' read -r TASK_DIR MAX_ITER WORKTREE BRANCH <<< "$entry"
  git worktree add "$WORKTREE" -b "$BRANCH" main
  ( cd "$WORKTREE" && nohup bash ralph.sh "$TASK_DIR" -i "$MAX_ITER" -y > ralph.log 2>&1 & )
done
```

Key details in the skill file:
- `|` as the delimiter (not `:` — Windows drive letters contain `:`)
- PowerShell for PID liveness checks on Windows (Git Bash's `kill -0` lies about Windows PIDs)
- `--stop` does process-tree kills because Ralph spawns grandchildren claude.exe processes
- `--status` cross-checks commits and log mtime, not just the PID file (the PID file is approximate — commits are ground truth)

### When NOT to go multi-PRD

- Single PRD — use `/ralph-worktree` + `ralph-tui` instead. Much better interactive experience.
- Ad-hoc one-off builds — don't build infrastructure for a single command you'll run once.
- Remote execution on a build farm — the runner assumes ralph.sh runs locally. Remote orchestration is a different problem.

---

## 7. Monitoring a running Ralph

This is the part that distinguishes a team using Ralph effectively from one that just fires-and-forgets. Autonomous doesn't mean unsupervised. Your job during a run — and the pilot's job — is to watch for the patterns that indicate everything is fine vs. the patterns that indicate something is wrong.

### The checkpoint diagnostic sweep

Every status check runs the same sequence. Not optional. The order matters because each step informs the next.

1. **Story count.** Read `prd.json`, count stories where `passes: true`. Compare to total. Note the delta since last check.
2. **Pending stories.** Sort pending by priority, show the top 3, show AC progress on each.
3. **Recent commits.** `git log --oneline --since='30 minutes ago'` in the worktree. **Commits are ground truth — not the iteration counter, not the AC flags, not the log content, not your own optimism.** If git log and prd.json disagree, git log wins.
4. **Iteration counter.** `grep "Iteration [0-9]* of" ralph.log | tail -3` — shows the last three iteration headers the bash loop wrote. Compare to budget.
5. **Latest real log content.** Strip spinner and ANSI codes, find the last real status message. Tells you what Ralph thinks it's doing right now. The incantation: `tail -500 ralph.log | tr -d '\r' | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' | grep -v '^$' | grep -vE 'Claude working|Starting\.\.\.' | tail -15`
6. **Log mtime.** `stat --format='%y' ralph.log` — is it being written to right now? If mtime hasn't updated in 10+ minutes, that's an alarm.
7. **Process health.** Is the ralph.sh loop bash process still alive? Is there an active claude subprocess? Use PowerShell on Windows, not bash `kill -0`.
8. **Hung SSH sessions.** For any story involving VM work — `Get-CimInstance Win32_Process -Filter "Name='ssh.exe'"`. Sessions older than ~10 minutes are suspicious; older than 30 minutes are hangs.

Report the results concisely. Tables beat prose for status. Highlight what's new since last check. Distinguish "making progress" from "running but stuck" from "completely hung."

### The intervention decision tree

**Progress visible (new commits, AC advances, log mtime active)** → stay out of the way. Don't interrupt Ralph mid-iteration. Report status and step back.

**Slow iteration but activity present (log mtime advancing, CPU time increasing, no hung SSH)** → wait. Legitimately long iterations happen on stories with big builds, multi-binary cross-compilation, long E2E validations. Document the expected delay for your user so they're not worried, but don't act.

**Stalled (no commits in 30+ min, log mtime flat)** → investigate. Read the last real log content. Check for hung SSH sessions. If the log is frozen on a single status line for 15 minutes, something's stuck.

**Confirmed hung (dead log, hung SSH session, no CPU progress)** → intervene. Recovery procedure:
1. Kill hung SSH with `powershell -Command "Stop-Process -Id <pid> -Force"`
2. Clean up remote state if applicable (`ssh host "pkill -9 -f <pattern>"`)
3. Wait for Ralph's claude subprocess to recover — usually ralph.sh sees the broken pipe and spawns the next iteration within 30 seconds
4. Add the hang cause to `outstanding-items.md` — it's usually a real upstream bug worth capturing

**Gap discovered (Ralph explicitly says "scoped out of this iteration" or "needs follow-up story")** → three options:
- **Inject inline** — add a new story to `prd.json` with priority placing it ahead of any blocked stories. Use the Edit tool with exact-string matching on a unique cell boundary Ralph isn't touching. Safe to do while Ralph is running.
- **Defer to follow-on PRD** — capture in `outstanding-items.md`, plan a future PRD.
- **Let Ralph handle it** — sometimes Ralph will self-expand and fix the gap in a subsequent iteration without intervention. Watch the commit log; if Ralph is making progress, stay out of the way.

The choice depends on urgency and scope. Small, blocking, well-understood gaps → inject. Large, ambiguous, or cross-PRD gaps → defer. Already-in-progress → let Ralph work.

### How to be wrong gracefully

You will be wrong about things during monitoring. You'll misdiagnose a slow iteration as a hang. You'll suggest a fix that's the wrong shape. You'll miss a subtle progress signal and tell the user Ralph is stuck when it isn't.

**Say so directly. Correct the record in the same response that acknowledges it. Don't wait for the user to catch it.** Credibility with the user depends on being correctable, not on being right the first time. The honest-reporting rule is load-bearing — without it, the user can't trust anything you say, and the whole partnership breaks.

---

## 8. The four durable documents

Every non-trivial Ralph project has the same four documents. Each has one job. Each has a specific home for specific content. If you catch yourself writing something and you're not sure which document it belongs in, the answer is almost always one of these four.

### `STRATEGY.md` (repo root)

The durable strategic direction. Why this project exists, what model it follows, what hard rules govern architectural decisions. Changes rarely — measured in months. Read first in every new session, before doing anything else.

Example content: "This project replaces the application-layer cipher with FIPS-validated AES-256-GCM. The architectural model is reference-branch + hooks + plugin. Hard rules: no FIPS references in public-repos/ commits or branches."

### `ROADMAP.md` (repo root)

Planned future strategic efforts that aren't yet scoped as PRDs. A parking lot for ideas graded by horizon (near-term / mid-term / long-term). Items graduate out by becoming PRDs or being declined.

Example content: "Long-term: native Rust SDK for OpenZiti, internal use initially, eventual open-source contribution. No external demand yet, no PRD, revisit post-Phase-3."

### `docs/internal/outstanding-items.md`

Open findings, gaps, and follow-up items from active work. Changes constantly. Every item has an OI-NNN ID, a source, a status, an owner, and resolution notes when closed. Never deleted — closed items move to a "Closed items" section for audit trail.

Example content: "OI-001 — Plugin provider wiring gap. Source: VS-03 iteration 6. Resolved 2026-04-12 via IS-21 commit a7a406f."

### `handoff.md` (repo root)

Session-level state for cross-session continuity. Updated at the end of each significant session via `/ralph-handoff`. Captures: where work currently stands, what's in flight, what decisions were made, what open questions remain, how to pick up in the next session.

Example content: "Current state: PRD-24 Phase 3 in progress, 46/48 stories done. VS-08 and VS-11 pending. Ralph running in D:/prd-24-worktree, PID 52716, iter 35/100. Resume by: check status via launch-prds.sh --status, verify Ralph is still alive."

### The routing rule

When you discover something worth preserving, route it:

- **A bug or gap** → `outstanding-items.md`
- **A planned future effort** → `ROADMAP.md`
- **A strategic principle or hard rule** → `STRATEGY.md`
- **A session-level context snapshot** → `handoff.md`

If something fits two categories, it's probably ambiguous and should be clarified before writing. Never duplicate — pick one home and link from the others if needed.

---

## 9. Knowledge preservation

The project state you carry in your head right now will evaporate the moment this session ends. The only continuity is the filesystem. If you discover something worth remembering, write it down *in the right place* (see §8) before the session ends.

### What goes where

- **New finding during a Ralph run** → `outstanding-items.md` with an OI-NNN ID
- **Strategic lesson about how to approach a class of problems** → `STRATEGY.md` or a project memory
- **Operational gotcha about the runtime, tools, or environment** → `CLAUDE.md` or a project memory
- **Relationship or process fact about how the user wants to work** → feedback memory in `~/.claude/projects/<project>/memory/`
- **One-off reminder for a specific project state** → `handoff.md`

### The anti-pattern

The anti-pattern is thinking "I'll remember that for next time." Your future self is a different process with no memory of this conversation. Write it down immediately. The tracker is cheap to update and expensive to reconstruct from scratch.

---

## 10. Real-world case studies

### Case study — PRD-24 on openziti-fips (the one that produced this guide)

**Scope:** refactor a FIPS cryptographic implementation from invasive patches across 5 sub-repos into a hook-based plugin architecture, with full end-to-end validation across 9 paths including Windows (OpenSSL + CNG), Linux C (OpenSSL + AWS-LC), Linux Go full stack (AWS-LC + OpenSSL + Native FIPS), JVM BCFIPS, cross-SDK wire compatibility, and a cross-SDK hard-fail negative test suite.

**Authoring phase:** Multiple sessions of collaborative PRD work. The initial draft was a single-phase research PRD. The pilot raised concerns about scope and methodology that triggered a rewrite into a three-phase self-expanding investigation PRD with explicit Discovery → Implementation → Validation phases. The pilot ran `/ralph-audit` with 3 parallel audit agents — scope completeness, methodology rigor, strategic alignment — and found real issues the author hadn't seen. The audit findings forced a mid-draft restructure (CMVP inheritance concerns, split vs. consolidate decisions, plugin-distribution-model scope, security-as-first-class-design-constraint framing). The final PRD was ~27 fixed stories covering Discovery + Validation, with Implementation stories dynamically spawned by the last Discovery story based on decisions made during discovery.

**Execution phase:** Ralph ran for ~12 hours continuously across 35 iterations. Phase 1 Discovery completed in ~12 iterations (16 stories). Phase 2 Implementation was spawned dynamically at the end of Phase 1 based on the chosen hook design (5 hooks × multiple consumers + build system + test infrastructure = 20 spawned stories). Phase 3 Validation ran the 11 fixed VS-* stories, each replaying one of the reference implementation's validated paths against the new plugin architecture.

**Bugs found and fixed during the run:**
- **OI-001 — plugin provider registration gap.** Discovered by Ralph in VS-03 iteration 6 while trying to dial the plugin-hosted fips-host. The plugin's `vertecProvider` was dead code because upstream `secretstream.DefaultProvider()` had no setter and was returning the unconditional ChaCha20 default. Ralph scoped the fix out of the current iteration and proposed a `sync.Once`-guarded `RegisterDefault()` pattern. The model pilot injected an `IS-21` story into the running `prd.json` with the fix spec. Ralph picked it up on the next iteration, implemented the setter in `public-repos/secretstream`, added a plugin-side `init()` to call it, verified the fix via a startup probe, and committed. All 6 ACs passed in a single iteration.
- **OI-010 — router drops `CipherPreferencesHeader`.** Discovered by Ralph in VS-03 iteration 8 after IS-21 unblocked the plugin provider. The edge router was synthesizing a fresh connect message on the terminator side without copying the cipher preferences header from the client's original message. Ralph diagnosed the root cause, fixed it inline in the same VS-03 iteration chain (commit `9bf3802`), pushed the fix to `vertec-io/ziti` on a neutrally-framed branch (`feature/crypto-extensibility`), and then closed VS-03 completely.
- **OI-009 — latent dial timeout bug.** Discovered when a Ralph iteration hung for 90 minutes on VS-03 waiting for two SSH sessions running `ziti-edge-tunnel` with `ZITI_DIAL_TIMEOUT_MS=20000`. The plugin tunneler wasn't honoring the dial timeout when the handshake blocked indefinitely. This was a pre-existing latent bug in `ziti-sdk-c` that had never been hit because no one had ever tried to dial a cipher-mismatched peer. The model pilot killed the stuck SSH sessions, Ralph recovered, and OI-009 was captured in the tracker for future fix.

**User interventions during 12 hours of autonomous work:**
1. Added `IS-21` to `prd.json` when a blocker was discovered (one Edit tool call)
2. Killed hung SSH sessions during the 90-minute hang (three PowerShell invocations)

That's it. Everything else — 48 stories worth of hook design, plugin code, build scripts, test infrastructure, cross-SDK wire vectors, E2E replays, negative test suite, upstream commits to a neutrally-framed branch — was done by Ralph autonomously, with the model pilot doing checkpoint monitoring and tracker maintenance but no direct code work.

**What made this work:**
- A well-audited PRD with clear acceptance criteria on every story
- Self-expanding phases so the Implementation plan emerged from Discovery findings rather than being guessed up front
- A hard rule (pre-push hook) that enforced neutral framing on all upstream commits
- A tracker discipline that captured every finding as an OI item so nothing was lost
- A model pilot that monitored without interrupting, intervened only on clear-cut failures, and never touched files Ralph was actively writing

**What would have broken it:**
- Skipping `/ralph-audit` — the audit caught scope issues that would have produced a much worse PRD
- Running Ralph without the pre-push hook — one accidental push of a FIPS-framed commit to the vertec-io fork would have complicated the whole upstream engagement story
- Treating "Ralph is running" as "we can walk away" — the hangs would have eaten the iteration budget without intervention
- Editing files in the worktree while Ralph was mid-iteration — guaranteed corruption
- Losing findings in conversation prose instead of writing them to `outstanding-items.md` — half the tracker items were discovered hours before they were actioned

---

## 11. Anti-patterns (things we've learned not to do)

### Rushing to execute

The urge to launch Ralph early is strong because watching Ralph run is exciting. Resist it. A PRD that saves 3 more clarifying questions costs 30 iterations of wasted execution.

### Two Ralphs in the same worktree

Two agents writing to the same files will silently stomp on each other. One wins, the other's work vanishes. You won't notice until the failing tests surface the corruption hours later. One worktree per PRD, always, no exceptions.

### Skipping `/ralph-audit`

Every audit we've run has surfaced real issues. Skipping the audit to save time during authoring costs you 10x the time during execution, when you're fixing issues mid-flight that could have been fixed on paper.

### Trusting flags over commits

Ralph marks stories as `passes: true` in `prd.json`. Don't trust the flag without checking the commit. Sometimes a story gets marked optimistically and the commit is thin or missing evidence. Commits are ground truth; flags are intent.

### Editing files Ralph is touching

If Ralph is actively writing to `prd.json` or a file in the worktree and you edit the same file at the same time, you're racing the agent. Don't. If you need to inject a story mid-run, use Edit with a unique-string match on a cell Ralph isn't touching, and do it between iterations if possible.

### Burying findings in conversation prose

You discover a bug during a checkpoint. You mention it in your response to the user. You move on. Now the bug lives only in the conversation history, which will be gone when the session ends. Write it to `outstanding-items.md` **immediately**. The tracker is cheap; reconstructing a lost finding is expensive.

### Launching without understanding the budget

"Iteration budget" isn't a guess — it's a contract with Ralph. If you launch with `-i 20` and the PRD has 30 stories, Ralph will exit incomplete and you'll need to relaunch. Calculate: remaining stories × average iterations per story + safety margin = budget. If your estimate is 40, set 60.

### Intervention pong

Pilot intervenes → Ralph recovers → new problem → pilot intervenes again → new problem → pilot intervenes again. This is the anti-pattern of intervening too eagerly. Only intervene on clear-cut failures (hung process, dead log). Let Ralph work through ambiguous situations on its own — self-expansion is a feature, not a bug.

### Making strategic decisions alone

The human pilot makes strategic decisions (what to build, whether to merge, how to frame upstream commits). The model pilot makes operational decisions (which skill to invoke, when to intervene, how to route a finding to a document). Don't confuse the two. The model pilot should not merge to main without explicit human approval. The human pilot should not debug hung SSH sessions by hand when the model pilot has the checkpoint sweep memorized.

### Running blind

"Ralph is running" is not a status. "Ralph just closed VS-07 at commit `2dfe03b`, is on iteration 35 of 100, working VS-08 with 0/6 ACs passing, log mtime is current, no hung processes" is a status. If you can't describe the current state of the run in one paragraph, you don't know the current state.

---

## 12. When you're the human pilot

- Read `STRATEGY.md`, `ROADMAP.md`, `outstanding-items.md`, and `handoff.md` at the start of every session. Even if you wrote them. You will have forgotten things.
- Focus your attention on the questions only you can answer: strategic direction, customer context, irreversible decisions.
- Delegate execution discipline to the model pilot. That's what it's for.
- When you disagree with the model pilot, say so directly. Don't nod along and then override silently.
- When the model pilot is right and you were wrong, acknowledge it. Builds the partnership.
- Approve irreversible operations (merges, pushes, deletions) explicitly. Don't assume the model pilot should figure out your preferences.
- Batch your check-ins — 4-5 status checks over a 12-hour run is enough, 40 is too many.

## 13. When you're the model pilot

- Read `STRATEGY.md`, `ROADMAP.md`, `outstanding-items.md`, `handoff.md`, and `CLAUDE.md` before doing anything else in a new session.
- Run the checkpoint diagnostic sweep at every status check. Don't skip steps even if the user asked about one specific thing.
- Report honestly, in tables, with deltas from the last check.
- Commits are truth. Not flags, not counters, not your own optimism.
- Never touch files Ralph is actively writing.
- Inject stories with care — unique-string Edit on cells Ralph isn't touching.
- Route every new finding to the right durable document before the response ends.
- Admit mistakes immediately in the same response that realizes them.
- Recommend defaults when asking the user for decisions — don't give 5 options, give 1 option with reasoning.
- Don't interrupt with routine updates. Reserve length for moments that need it.
- Save memories for durable lessons, handoff for session state, outstanding-items for findings, strategy for rules.

## 14. Further reading

- `README.md` — single-PRD quick-start, install instructions, mechanics
- `skills/ralph-pilot/SKILL.md` — the full pilot operating manual, including the checkpoint sweep, intervention decision tree, document routing rules, and the invisible-moves interview template
- `skills/ralph-runner/SKILL.md` — the multi-PRD launcher template plus eight known pitfalls with symptoms and fixes
- `skills/prd/SKILL.md` — PRD authoring conventions
- `skills/research-prd/SKILL.md` — research-mode PRDs with decision gates
- `skills/ralph-audit/SKILL.md` — the pre-launch quality gate
- `skills/ralph/SKILL.md` — PRD-to-JSON conversion rules
- `skills/ralph-worktree/SKILL.md` — single-PRD worktree setup
- `skills/ralph-handoff/SKILL.md` — cross-session state preservation
- `prompt.md` — the Ralph iteration loop prompt (what Ralph reads at the start of every iteration)
- `AGENTS.md` — project-specific agent rules (in any repo that uses Ralph)

---

## 15. One last thing

This guide, the skills, the execution system — all of it came from running into problems and capturing the lessons. If you hit something that isn't in here, that's probably a sign the guide needs another entry. Write it down. The next team member shouldn't have to learn it the hard way just because you did.

The system compounds. Every lesson you capture makes the next PRD cheaper. Every skill you extract from tacit knowledge to explicit documentation makes the next team member faster. Every OI item you close with good resolution notes makes the audit trail more valuable. Engineering output per dollar compounds at a different rate than any other input in the project — and it compounds precisely because we treat the execution system as first-class infrastructure worth investing in.

Welcome aboard. Now go run a PRD.
