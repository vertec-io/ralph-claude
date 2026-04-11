---
name: ralph-handoff
description: "Create or update a handoff.md document that captures the current state of a long-running project so the next agent (or the same agent in a fresh context window) can pick up exactly where this one left off. Use when context is getting tight, when finishing a session, after merging a major PRD, or whenever the user says 'update the handoff', 'write a handoff', 'hand this off', or 'create a handoff doc'. Triggers on: handoff, update handoff, hand off, write handoff, /ralph-handoff."
version: "1.0"
---

# Ralph Handoff Document Generator

Creates or updates a `handoff.md` document at the repo root that captures the current state of a long-running project so the next agent — or the same agent in a fresh context window — can pick up exactly where you left off without losing context.

---

## Why This Exists

Long-running projects (multi-PRD efforts, autonomous agent workflows, compliance work) accumulate state that's expensive to reconstruct: which PRDs are done, which are in progress, where the worktrees live, what the audit conventions are, what the gotchas are, where the evidence lives, what the infrastructure looks like.

When a context window runs out — or a human stops working for the day and comes back tomorrow — that state has to come back from somewhere. Without a handoff doc, the next agent re-derives it from `git log` and trial and error, often making mistakes the previous agent already learned to avoid.

A good `handoff.md` lets the next agent be productive in the first message instead of the tenth.

---

## When To Run This

- **End of session, especially if context is tight** — generate the handoff before the window closes
- **After merging a major PRD** — update the PRD completion table and add the merge to recent history
- **After a significant architectural decision** — capture the decision and its motivation
- **When the user says "/ralph-handoff", "update the handoff", "write a handoff", "hand this off"**
- **When kicking off a new branch or worktree** — make sure the handoff knows about it
- **After the 3-round audit process completes** — record the outcome

---

## The Job

1. **Read** the existing `handoff.md` if it exists. Treat it as the base structure to update, not a draft to discard.
2. **Detect** the current state of the project: git status, recent commits, worktrees, branches, PRD task directories, recently merged work.
3. **Update** the dynamic sections (current state, PRD status table, in-progress PRD details, key findings) while **preserving** the stable sections (project description, architecture, infrastructure, repository map, build scripts).
4. **Add** any new PRDs, evidence files, or convention changes since the last handoff.
5. **Date-stamp** the "Current State" header so the next agent knows how fresh the doc is.
6. **Write** the updated handoff.md back.
7. **Show the user** a summary of what changed.

---

## The Standard Sections

A complete handoff.md has these sections in this order. Stable sections rarely change; dynamic sections are updated every session.

### Stable sections (preserve unless changed)

- **`# {Project Name} — Session Handoff`** (title)
- **`## What This Project Is`** — 2-3 paragraphs explaining the project's purpose and the business problem it solves. Written for an agent who has never seen the project.
- **`### Critical {Compliance/Business} Rule`** — The non-obvious rule that governs every decision. This is the thing the next agent must internalize. (For FIPS work it's "non-validated crypto = plaintext to assessors". For other projects it might be "PII never leaves region X" or "every query must be capped at 10k rows".)
- **`### Architecture Documents`** — Pointers to the canonical architecture/design docs.
- **`## Architecture — {Subsystem}`** — Subsystem deep-dives. Tables of components, build flags, status.
- **`## Repository Map`** — Where each repo lives, what branch it's on, what its purpose is. **Especially important for projects with sub-repos under the main repo path** (worktrees do not include them).
- **`## Infrastructure`** — VMs, controllers, identities, services, build scripts, ports, paths, credentials (or where to find them).
- **`## Key Build Scripts`** — Table of build/test/deploy scripts with their purposes.

### Dynamic sections (update every session)

- **`## Current State (as of YYYY-MM-DD)`** — The date in the header is required. Below the header, list the major validated paths, the merged PRDs, and the in-progress work.
- **`### {Top-level outcome} table`** — A table of validated paths or completed work. For FIPS this is the "E2E paths validated" table.
- **`### PRD Completion Status`** — Master table with columns: PRD #, Stories (done/total), Status, What It Did. Status values: DONE, DONE (merged), DONE (partial), IN PROGRESS, PLANNED, DEFERRED. Highlight the in-progress PRD with bold/asterisks.
- **`### PRD-{N}: {Title} (status)`** — Detail section for any in-progress or recently-completed PRD. Includes worktree path, branch name, the gap being closed, the user stories table, and any gotchas the next agent needs to know about.
- **`## Key Findings from This Session`** — Numbered list of non-obvious things this session learned that aren't already captured in code or commits. This is the "things you'd otherwise have to learn the hard way" section.

### Convention sections (preserve, add when new)

- **`**To audit when complete — MANDATORY 3-round audit process:**`** — If the project uses the 3-round audit convention (Round 1 = comprehensive, Round 2 = regression+consistency, Round 3 = final verification), include the template inline so the next agent knows to run it. See the template at the bottom of this skill file.
- **`**To merge when complete:**`** — Exact `git` commands the next agent should run to merge the in-progress branch.

### Reference sections (preserve, append)

- **`## Evidence & Documents`** — List of evidence files in `docs/evidence/` and the canonical reports/guides.
- **`## {Compliance Cert / External Reference} Quick Reference`** — Table of certificates, ticket IDs, vendor SKUs, or other external references with their meanings.

---

## How To Update (Step-by-Step)

### Step 1 — Read the existing handoff

```
Read the file at {repo-root}/handoff.md
```

If it doesn't exist, ask the user whether to create one from scratch. Don't assume — a handoff doc is a load-bearing artifact and the user might prefer a different structure or location.

### Step 2 — Detect current state

Run these in parallel to gather state. **Use the dedicated tools (Bash for git, Glob/Grep for files)** — never assume.

```bash
# Recent commits (what's happened since last handoff)
git log --oneline -20

# Current branch and clean state
git status --short
git branch --show-current

# Worktrees (each worktree is a parallel effort)
git worktree list

# Recent branches that may have been merged or deleted
git branch -a | head -30

# Task directories (each one is a PRD)
ls -1 tasks/ 2>/dev/null | sort
```

For each `tasks/{prd}/prd.json`, read it to get the story counts and pass/fail states. The PRD status table needs `{stories_done}/{stories_total}` accurate.

**Then do these four extra verification steps.** They catch the things `git status` alone misses. Skipping them is the single biggest source of weak handoffs:

#### 2a. Read each in-progress worktree's `progress.txt` (or equivalent progress log)

Ralph-style autonomous loops append detailed notes to a progress log inside the task directory — typically `tasks/{effort}/progress.txt`. Inside a worktree, that file contains:

- The **exact commit hashes** Ralph produced per story (often different from the worktree branch tip, since Ralph may have added commits to sub-repos)
- **Gotchas Ralph hit during implementation** (build errors, platform quirks, flaky patterns, workarounds) — these are prime Key Findings material and the next agent will otherwise re-learn them the hard way
- **Test runs with actual output** (exit codes, timings, failures) — this is how you verify that a story's `passes: true` claim actually reflects a passing test run
- **Outstanding follow-ups** that didn't make it into code yet
- **Cross-file dependencies** (e.g., "US-2002 should reuse the helpers added in US-2001 instead of duplicating")

If the worktree has this file, **read it before writing the handoff**. Promote the non-obvious gotchas into Key Findings. Do not just cite the file — summarize the actionable items inline so the next agent doesn't have to dig.

Other progress-log locations to check if `progress.txt` isn't where you expect: `tasks/{effort}/progress-1.txt`, `tasks/{effort}/notes.md`, `tasks/{effort}/journal.md`, or a `PROGRESS.md` at the repo root.

#### 2b. Verify any sub-repos the in-progress PRD touches

Some projects keep multiple git repos under one working directory — each with its own `.git` and remote (see "Sub-Repo Warning Convention" below). Git worktrees **do not** include these sub-repos, so an autonomous loop can commit to a sub-repo but forget to push it, or make changes in the worktree but not in the sub-repo.

For each sub-repo the in-progress PRD claims to have touched, run:

```bash
cd {absolute-path-to-sub-repo}
git branch --show-current                              # confirm it's on the right branch
git log origin/{branch}..HEAD --oneline                # unpushed commits (empty = in sync)
git status --short                                     # uncommitted changes (empty = clean)
git log --oneline -5                                   # recent history for the handoff table
```

Report the actual state in the handoff. Don't say "verify these sub-repos have commits" — that's outsourcing work the handoff exists to do. Say "JVM SDK at commit X, pushed; C SDK at commit Y, pushed; Go SDK has 2 uncommitted changes that need attention" based on what you actually saw.

If sub-repos have unpushed commits or dirty trees, that is a **blocker for merge** and belongs in the handoff's in-progress PRD section, not buried.

#### 2c. Sanity-check any evidence, report, or compliance files the PRD produced

If a story claims to have produced evidence (test-suite output, negative-test results, assessor-facing HTML), **read enough of the file to verify it looks real** — the first 20-40 lines plus the conclusion. What to look for:

- **Real timestamps** (not placeholder dates or copy-paste from templates)
- **Actual command output** (with exit codes, timings, byte counts) rather than narrative claims
- **File references that exist** (the file paths cited inside the evidence should actually be files on disk — spot-check two or three)
- **Internal consistency** (if the summary table says "8 of 8 PASS" then the per-test detail sections should contain 8 PASS verdicts)
- **Cross-references to commits** that you can verify with `git log`

You are not doing a full audit. You are spot-checking that the evidence file isn't fabricated or copy-pasted. If something looks wrong, flag it in the handoff as "needs verification in Round 1" — don't silently pass it through.

#### 2d. Check for stale references in the existing handoff

As the project progresses, prior Key Findings, prior PRD detail sections, and prior "in-progress" notes become obsolete. When you update the handoff, **search for tense and status inconsistencies**:

- Key Findings written in present/future tense about work that's now merged ("PRD-19 is in progress to fix it" → should become "PRD-19 fixed this and merged YYYY-MM-DD")
- In-progress PRD sections for work that's no longer in progress (move to a "Recently Completed PRDs" section or delete)
- Infrastructure/script/repo entries that no longer exist (removed, renamed, deprecated)
- Worktree paths in the handoff that no longer appear in `git worktree list`

Use `Grep` to find every occurrence of the in-progress PRD number in the handoff, then review each hit for staleness.

### Step 3 — Identify what changed

Compare the existing handoff against the current state:

- **New PRDs**: directories in `tasks/` not yet in the PRD status table → add a row
- **Status changes**: PRDs that progressed (PLANNED → IN PROGRESS → DONE) → update the row and the count
- **Newly merged branches**: branches in recent commits that aren't in the existing handoff's "merged" list → update the in-progress section to "DONE (merged)" and add a brief detail section
- **New worktrees**: worktrees in `git worktree list` not mentioned in the handoff → add an in-progress PRD section
- **New evidence files**: files in `docs/evidence/` not in the handoff's evidence list → append
- **New scripts, repos, or infrastructure**: anything that affects how the next agent runs builds or tests → add to Repository Map / Infrastructure / Key Build Scripts
- **Today's date** for the "Current State (as of YYYY-MM-DD)" header

### Step 4 — Update sections incrementally

**Don't rewrite the whole file.** Use `Edit` for targeted changes:

- Change the "Current State (as of ...)" date
- Update individual rows in the PRD status table
- Replace the in-progress PRD detail section with the new one (or move the old one to a "## Recently Completed PRDs" section if you want to preserve it)
- Append to "Key Findings from This Session" — don't delete previous findings unless they're stale or have been promoted to the main architecture sections

For brand-new sections (e.g., a new in-progress PRD), use `Edit` to insert them in the right place — usually right after the PRD status table.

### Step 5 — Honesty check

Before saving, verify:

- [ ] The "as of" date is today's date (resolved from the user's current date, not a guess)
- [ ] PRD status counts match what's actually in the prd.json files
- [ ] No PRD is marked DONE if its tests are failing or its merge hasn't happened
- [ ] No claims about evidence that doesn't exist (every referenced file should be a real file)
- [ ] No stale paths (branches/worktrees that no longer exist should be removed)
- [ ] The in-progress PRD section explains both **what's done** and **what's left**, not just one
- [ ] Any audit-found issues from previous rounds are still represented in "Key Findings" if they're load-bearing
- [ ] **Every sub-repo the in-progress PRD touches was actually verified** (Step 2b) — report observed state, not "next agent should verify" — UNLESS declared as a deferred verification (see "When Context Is Tight" below)
- [ ] **The worktree's `progress.txt` (or equivalent) was read** (Step 2a) and any non-obvious gotchas promoted to Key Findings — don't just tell the next agent "there's a progress log, read it" — UNLESS declared as a deferred verification
- [ ] **Evidence files were spot-checked** (Step 2c) — the skill did a sanity read, not just confirmed `ls` output — UNLESS declared as a deferred verification
- [ ] **Reference sections were updated alongside dynamic sections** — if a PRD added new scripts, those scripts belong in the Key Build Scripts table (not just in the PRD detail section); if a PRD added new evidence files, those belong in the Evidence Files list. The reference sections are where the next agent looks when they need a fact, not when they want a PRD narrative — they need to be current too.
- [ ] **Stale prior Key Findings were updated, not just ignored.** If finding #5 says "X is in progress" but X merged three commits ago, rewrite it in past tense or delete it. Leaving stale findings in place is how a handoff document loses trust.

### Step 6 — Show the user the diff

After writing, summarize the changes:

```
Updated handoff.md:
  - Current State date: 2026-04-09 → 2026-04-10
  - PRD status table: PRD-19 marked DONE (merged), PRD-20 added as PLANNED
  - New section: PRD-20 detail (11 stories, 3 SDKs, defense-in-depth model)
  - Key Findings: appended #6 (silent fallback gap discovered, see PRD-20)
  - Evidence: appended jvm-e2e-cipher-negotiation.txt
```

Don't claim "the file is now perfect". Claim "here's what changed". The user will say if more is needed.

---

## When Context Is Tight — Deferring Verification

This skill is often invoked precisely *because* context is running out. If you're in that situation and can't reasonably run every verification step in Step 2, **that is expected and acceptable** — but only if you are explicit about what was deferred and leave actionable instructions for the next agent.

**The non-negotiable minimum** (always doable even on near-empty context):

- Step 1 — Read the existing handoff
- Step 2 main git detection — `git log`, `git status`, `git worktree list`, `ls tasks/`, read `prd.json` pass/fail counts
- Step 2d — Grep the existing handoff for stale references to the in-progress PRD
- Step 4 — Update the dynamic sections (date, PRD status table, in-progress PRD detail row)
- Step 6 — Show the diff summary

These cost very little context and always produce a usable incremental update. Skipping them would leave the handoff meaningfully worse than it was.

**The deferrable steps:**

- Step 2a — Reading the worktree's `progress.txt` and promoting gotchas
- Step 2b — Verifying sub-repo state (branch, push status, clean tree) for each repo the in-progress PRD touches
- Step 2c — Spot-checking evidence files for fabrication or stale data

Each of these can produce high-value content but requires reading potentially large files. If context won't fit them, defer — **do not silently skip**.

### How to defer properly

Add a section to the handoff named exactly this:

```markdown
## Deferred Verifications (next agent: please complete)

The previous handoff update ran with tight context and deferred the following verifications. A fresh agent with a clean context window should run these as the first action of the next session, then remove each item from this section once verified.

### [ ] Read worktree progress.txt (Step 2a)
- **File:** `{worktree-path}/tasks/{effort}/progress.txt`
- **What to extract:** non-obvious gotchas, exact per-story commit hashes, test-run exit codes, outstanding follow-ups
- **Promote to:** Key Findings in handoff.md
- **Why deferred:** {one sentence — "file was 400 lines and context was already at 85%"}

### [ ] Verify sub-repo state (Step 2b)
- **Sub-repos to check:** {list absolute paths from the in-progress PRD's sub-repo table}
- **Commands per repo:** `git branch --show-current && git log origin/{branch}..HEAD --oneline && git status --short`
- **Expected state:** on `{branch}`, clean tree, no unpushed commits
- **Report to:** the in-progress PRD section's sub-repo table
- **Why deferred:** {one sentence}

### [ ] Spot-check evidence files (Step 2c)
- **Files to read:** `{list the files}`
- **What to check:** real timestamps, real command output with exit codes, internal consistency (summary table matches per-test details), file references that exist on disk
- **Flag to handoff:** any discrepancies belong in "Needs verification in Round 1" under the in-progress PRD
- **Why deferred:** {one sentence}
```

### Rules for the deferred section

1. **Each deferred item is a concrete task** — file path, command to run, expected state, where to put the results. Not a vague "check X."
2. **Include the "why deferred"** — context pressure is the usual reason, but there may be others (worktree inaccessible, file too large to read in one call, tool output missing). Naming the reason helps the next agent judge whether to retry the same way.
3. **Use `[ ]` unchecked checkboxes** — the next agent checks them off as they complete each task, then deletes the section when all are done.
4. **Put the section right after "Key Findings"** so it's prominent but doesn't push down the stable reference sections.
5. **Don't defer Step 2d (staleness check), Step 4 (dynamic updates), or Step 5 (honesty check of what you DID do).** Those are cheap and are the skill's baseline value.
6. **Don't defer everything.** If you cannot run any of 2a/2b/2c, the handoff update is probably too thin to be worth saving — in that case, stop and tell the user "context is too tight to produce a useful handoff update; please start a fresh session first." Producing an empty incremental update with three deferrals is worse than no update.

### Diff summary when items are deferred

Make deferrals explicit in the Step 6 diff summary. Don't bury them.

```
Updated handoff.md:
  - Current State date: 2026-04-11 → 2026-04-12
  - PRD status table: PRD-22 story count 3/8 → 7/8
  - New section: Deferred Verifications (3 items, context was tight)
  - Key Findings: unchanged (Step 2a deferred)
```

The user needs to know upfront that this is a partial update, not a complete one. If they have context to spare, they can ask you to complete the deferred items in the same session.

### When NOT to defer

Don't defer to save effort. Defer to survive context pressure. If you have the context to run a step and you skip it anyway, that is exactly the "silent skip" failure mode this skill exists to prevent. The deferral mechanism exists to make partial updates honest, not to make laziness acceptable.

The test: if you're skipping a step for any reason other than "the read or the commands won't fit in my remaining context," you're not deferring — you're skipping, and that's not allowed.

---

## What NOT To Do

- **Don't rewrite stable sections.** If the project description, architecture, or infrastructure hasn't changed, leave them alone. Rewriting introduces drift.
- **Don't delete "Key Findings" entries** unless they're definitively obsolete (the underlying issue was fixed and documented elsewhere). Findings are session memory — they accumulate over time.
- **Don't make up content.** Every claim in the handoff must be verifiable in the repo, the git history, or external systems the user can check. If you're uncertain, ask the user before writing it down.
- **Don't write a handoff for work the user is still actively doing.** A handoff is for transition between sessions/agents. If the user is mid-task, ask whether they want a partial handoff (capturing the current state of in-progress work) or whether they want to wait until the task is done.
- **Don't include secrets, passwords, or credentials in plaintext.** Reference the secrets manager, environment variable name, or `.env` file location instead.
- **Don't include line counts, file counts, or other metrics that go stale immediately.** Mention them in the diff summary if you want, but not in the persistent doc.
- **Don't outsource verification to the next agent.** If the handoff says "verify X" or "confirm Y" or "check whether Z was pushed", the skill didn't finish its job. Those verifications were the handoff's entire purpose. Run the commands yourself, report the actual state, and only leave work for the next agent that genuinely requires fresh action (audit rounds, code review, running tests against a live system). Telling the next agent to re-derive state the skill could have captured is exactly the failure mode this skill exists to prevent.
- **Don't treat `passes: true` in a prd.json as proof that anything works.** That flag is set by whatever loop wrote the file; it's a claim, not a verification. Cross-check against the progress log (Step 2a) and the evidence files (Step 2c) before amplifying the claim in the handoff. If you can't cross-check, say so — "PRD claims 11/11 passing, evidence files present but not spot-checked" is honest; "PRD is complete and ready to merge" is not.
- **Don't only update the dynamic sections.** Reference sections (evidence file lists, build script tables, CMVP/ticket/SKU reference tables) look stable but they accumulate drift just like dynamic sections do — just more slowly. When a PRD adds a new script or a new evidence file, the reference sections need the addition too, or the next agent reads the reference section, doesn't find what they need, and concludes the handoff is wrong about everything.

---

## The 3-Round Audit Convention (Template)

Many projects benefit from a mandatory 3-round audit process before merging in-progress work. If the project uses this convention, include the following template in the in-progress PRD section so the next agent knows to run it:

```markdown
**To audit when complete — MANDATORY 3-round audit process:**

Run at least THREE audit → fix rounds before considering this done. Use subagents (Agent tool with subagent_type="Explore" for audits, direct edits for fixes). Each round should:

**Round 1: Comprehensive audit** — Launch parallel subagents to check:
1. Code changes: every file/line listed in the PRD's acceptance criteria is actually changed and correct
2. Tests: all new tests pass, existing tests not broken
3. Evidence: any E2E or integration evidence required by the PRD is captured
4. Evidence files: no claims exceed test evidence, no internal references that shouldn't be there
5. prd.json states: pass/fail accurately reflects what was tested
6. Documentation: any doc updates required by the PRD are complete

Fix ALL issues found. Commit fixes.

**Round 2: Regression + consistency audit** — Launch parallel subagents to check:
1. Cross-file consistency: do all the docs, evidence files, and prd.json tell the same story?
2. Backward compatibility: does the change preserve existing behavior when the feature flag is off (or default)?
3. No hardcoded paths, no stale references to old file names or removed content
4. No regressions in adjacent features

Fix ALL issues found. Commit fixes.

**Round 3: Final verification** — Launch one thorough subagent to:
1. Read every modified file end-to-end and flag anything an assessor / reviewer would question
2. Verify the merge will be clean (no conflicts with main)
3. Verify any sub-repo changes have been pushed to their respective remotes
4. Confirm all tests pass one final time

Only merge after Round 3 produces zero issues.
```

The audit convention is project-specific — don't add it to projects that don't use it. If the existing handoff already has it, preserve it verbatim.

---

## Sub-Repo Warning Convention

Some projects keep multiple git repos under a single working directory (each repo has its own `.git` and remote). Worktrees do **not** include these sub-repos. If the project has this pattern, the in-progress PRD section must include an explicit warning:

```markdown
**IMPORTANT — sub-repo locations (NOT in worktree):**

The SDK source repos are at the following absolute paths and have their own remotes. They are NOT copied into Ralph worktrees. To make code changes, cd into the absolute path:

| Repo | Absolute Path | Remote | Branch |
|------|---------------|--------|--------|
| {sdk-1} | D:/{project}/repos/{...} | R2rho/{...} | {branch} |
| ... | ... | ... | ... |

When committing SDK changes, commit and push from inside the sub-repo. When committing PRD/docs/evidence changes, commit those in the worktree as usual.
```

This is the convention used in the openziti-fips project (see `repos/phase-1/*` and `repos/phase-2/*`).

---

## Example Invocation

User says: "/ralph-handoff" or "update the handoff for me".

1. Read existing `handoff.md`
2. Run git/file detection in parallel (1 message, multiple Bash calls)
3. Read each `tasks/*/prd.json` for current pass/fail states
4. Identify deltas vs. existing handoff
5. Use `Edit` to update each changed section in place
6. Show the user a diff summary

If there's no existing handoff:

1. Ask: "No handoff.md found. Create one at {repo-root}/handoff.md? I'll need a few details about the project to fill in the stable sections."
2. If yes, ask for: project name, one-sentence description, the critical rule, the main subsystem name. Then auto-detect the rest.

---

## Output Location

By convention: `{repo-root}/handoff.md`. Some projects use `HANDOFF.md` (uppercase) or put it under `docs/`. Check what already exists; don't create a duplicate at a different path.

If the user has a strong preference for a different location, respect it and remember the choice for next time.

---

## Final Note

A handoff doc is not a marketing document. Its job is to make the next agent immediately productive. Write it like a colleague who just walked into the room — explain what you'd want explained if you were them. Brevity matters less than completeness; the next agent has no context, and an extra paragraph is cheaper than a wrong assumption.

If you find yourself writing the same paragraph in two sessions in a row, that paragraph belongs in a stable section. Promote it.
