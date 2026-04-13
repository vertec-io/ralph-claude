---
name: ralph-audit
description: "Audit a PRD (or any plan document) with parallel disjoint-angle audit agents before running Ralph. Catches blockers, mega-stories, broken codebase assumptions, and design flaws while they're still cheap to fix. Use when a PRD has been drafted but not yet converted to prd.json. Triggers on: audit this prd, ralph audit, audit before ralph, pressure-test the prd, audit the plan."
version: "1.0"
---

# Ralph Audit

Run parallel disjoint-angle audits on a PRD before converting it to `prd.json` and launching Ralph. Surfaces blockers early — broken codebase assumptions, mega-stories Ralph will get stuck on, data model flaws, sequencing bugs, and domain-specific design risks.

**Why this pattern works:**
- **Disjoint angles** — each auditor has non-overlapping scope, findings don't duplicate, coverage is broad
- **Self-contained prompts** — each agent starts with fresh context and reads the actual code, not your assumptions about it
- **Parallel execution** — 5 audits in one message complete in the time of one audit
- **Severity-tagged punch list** — makes it easy to triage BLOCKER vs QUALITY vs GAP

Running this before `/ralph` saves 1-3 wasted Ralph sessions on PRDs with foundational issues.

---

## When to Use

- **ALWAYS after drafting a PRD, before `/ralph` conversion.** The pattern's value is preventing expensive mid-implementation surprises.
- **After significant PRD revisions** (e.g., scope changes, new stories added, major architectural pivots) — re-audit the changed areas.
- **Before launching a long Ralph run** when you suspect something might be off but can't articulate what.

**Not for:** trivially small PRDs (< 5 stories), maintenance tasks, bug fixes with known scope, or PRDs you're already confident in. The overhead isn't worth it for small efforts.

---

## The Job

1. Ask the user for the PRD path (or detect it from context — the most recently created PRD in `tasks/`).
2. Read the PRD top-to-bottom once to understand scope, phases, story structure, and the risk surface.
3. **Pick the 5th audit angle** — the topic-specific deep dive. Four angles are fixed; the fifth is customized to the PRD's highest technical risk.
4. Launch 5 audit agents **in parallel** (single message, 5 `Agent` tool calls).
5. Wait for all 5 to return.
6. Consolidate findings into a single report with severity tags.
7. Present the report to the user with a recommendation (proceed / revise / block).

**Important:** Do NOT modify the PRD yourself. Your job is to audit and report. The user decides whether findings warrant revision.

---

## Step 1: Locate the PRD

Default: ask the user for the path, or auto-detect the most recent `tasks/*/prd.md` file (excluding `tasks/archived/`).

Confirm the path before launching — audits against the wrong file waste time.

---

## Step 2: Read the PRD

Read the PRD once, end to end. While reading, build a mental model of:

- **Scope** — what's being built, how many stories, how many phases
- **Claims about existing code** — every "the X module currently does Y" statement is a fact to verify
- **Mega-story risk** — stories that bundle many tasks (e.g., "annotate every endpoint", "port every feature")
- **Architectural choices** — data models, crypto designs, state machines, new abstractions
- **Dependencies** — explicit `Blocked By` edges, implicit ordering, decision gates
- **Topic-specific risk** — the one thing most likely to blow up in Phase N+1 if designed wrong

This read informs the 5th audit angle.

---

## Step 3: The Five Audit Angles

Four angles are **fixed templates**. The fifth is **customized per-PRD** to target the topic-specific risk you identified in Step 2.

### Angle 1 (FIXED): Codebase Grounding

**Purpose:** verify every claim the PRD makes about existing code is accurate. PRDs drift from reality fast; claims like "X module has Y feature" or "the Z table has N columns" are often stale.

**What the agent does:** reads the actual files cited in the PRD, greps for referenced symbols, counts enforcement sites, confirms schemas.

**Template prompt:**

```
Audit a PRD's claims about existing code against what's actually in the repo.

**PRD path:** {ABSOLUTE_PATH_TO_PRD}
**Repo root:** {ABSOLUTE_REPO_ROOT}

**Your job:** read the PRD, then verify every concrete claim it makes about
existing code. Report cases where the PRD assumes something exists or works
a certain way and the code says otherwise.

**Specific things to verify** (customize this list per-PRD — list every
concrete claim you noticed in Step 2):
1. [Claim 1 — e.g., "PRD says X module has Y function at path/to/file.rs"]
2. [Claim 2 — e.g., "PRD says there are N enforcement sites for pattern Z"]
3. [Claim 3 — e.g., "PRD says table T has columns A, B, C"]
...

**Deliverable:** punch list of [CONFIRMED] / [WRONG] / [MISSING] items with
file paths and line numbers. Under 500 words. Focus on items that would
cause Ralph to get stuck or build the wrong thing.
```

**Keep the customized claim list in the prompt** — this is the single most valuable input. Every item becomes a fact-check the agent will perform.

---

### Angle 2 (FIXED): Story Sizing, AC Quality, Ralph-Readiness

**Purpose:** catch mega-stories Ralph will iterate on forever, vague ACs that lead to wrong implementation, missing validation gates, and missing dependency edges.

**What the agent does:** reads every story, evaluates AC quality, flags mega-stories, checks for `cargo check`/`bunx tsc --noEmit`/Playwright MCP coverage, verifies decision gate blocking.

**Template prompt:**

```
Audit a PRD for completeness, story sizing, and acceptance criterion quality.

**PRD path:** {ABSOLUTE_PATH_TO_PRD}

**Context:** This PRD will be executed by Ralph, an autonomous agent loop,
one story per iteration. Ralph needs verifiable ACs, mega-stories span many
iterations, vague ACs lead to wrong implementation.

**Your job:**
1. Read the PRD end to end.
2. For each user story, evaluate:
   - Is the AC list verifiable? Flag vague items ("works correctly").
   - Is the story sized to one Ralph iteration, or a mega-story?
   - For UI stories: is there a Playwright MCP step? Is it specific
     (URL, action, expected result)?
   - For backend stories: is there a `cargo check` + `cargo test` gate?
   - For TS/V2 stories: is there a `bunx tsc --noEmit` gate?
3. Mega-story detection — flag stories with:
   - "For every X" language over a large N
   - Multiple distinct concerns bundled (framework + CRUD + polling + retry)
   - Can Spawn Stories: Yes without pre-split guidance
4. Missing stories — things the PRD describes in prose but has no story for.
5. Decision gate ownership — do all `Blocked By` edges correctly reference
   the gate that actually resolves their dependency?
6. Self-expanding mechanic — do discovery stories require updating BOTH
   prd.md AND prd.json? Without this, appended stories never reach Ralph.
7. Cross-PRD coupling — does the PRD depend on types/contracts owned by
   another PRD? Is the coordination explicit?

**Deliverable:** categorized punch list:
- [BLOCKER] — stops Ralph cold
- [MEGA] — story too large, will span many iterations
- [QUALITY] — Ralph will probably do the wrong thing
- [GAP] — missing scope or dependency

Cite story IDs. Under 500 words.
```

---

### Angle 3 (FIXED): Architectural Design Soundness

**Purpose:** pressure-test new abstractions, data models, state machines, and API surfaces proposed in the PRD. Independent second opinion on design correctness before implementation locks it in.

**What the agent does:** reads the architecture doc (if one exists), reads the PRD's data model / schema / type definitions, stress-tests the design with edge cases and "but what about X" questions.

**Template prompt:**

```
Audit the architectural design proposed in a PRD. Pressure-test data models,
new abstractions, state machines, and API surfaces.

**PRD path:** {ABSOLUTE_PATH_TO_PRD}
**Architecture doc (if any):** {ABSOLUTE_PATH_TO_ARCH_DOC_OR_NONE}
**Repo root:** {ABSOLUTE_REPO_ROOT}

**The design to pressure-test:** [summarize the specific design in 2-5 lines —
the data model, the new type, the state machine, the API shape, whatever
is most at risk]

**Your job — stress-test the design:**

1. **Data model correctness.** If there are new tables: check for missing
   indexes, foreign keys, unique constraints, cascade rules, NOT NULL on
   fields that should be required, enum columns vs typed enums, timestamp
   defaults. Missing constraints are where bugs hide.

2. **Abstraction leakage.** If there's a new abstraction (manifest, registry,
   protocol): check whether it actually fits all claimed consumers. Look for
   the one case that doesn't fit — that's where the abstraction will fragment
   into per-consumer special cases.

3. **State ownership.** If the PRD conflates definition (what a thing IS)
   with state (runtime fact about this instance), that's a smell. Separate
   them or prove they belong together.

4. **Generalization trap.** If the design claims "one path serves N consumers"
   (UI + headless, human + agent, etc.), verify that the *operation* is
   actually identical — not just that the endpoint is the same. Wizard flows
   with progress UI are not stateless clients of a stateless endpoint.

5. **Versioning + migration.** How does the design evolve? Is there a version
   field? A migration policy? What happens to old data when the schema changes?

6. **Validation location.** Where does field validation run? Serde? A separate
   pass? Per-field validators? Distributed across handlers?

7. **Security boundaries.** Are there assumptions about who can do what
   that aren't explicitly enforced? Is "trust the gateway" a tacit pattern?

8. **Failure modes.** What happens on partial failure? What does the rollback
   path look like? What about concurrent mutations?

**Deliverable:** architectural risks and recommendations:
- [RISK-HIGH] — fundamental issue; design will leak
- [RISK-MED] — correctness issue under edge cases
- [SUGGEST] — cleaner alternative

Under 500 words. If you find a fundamental issue, say so loudly.
```

---

### Angle 4 (FIXED): Sequencing, Dependencies, Parallelism

**Purpose:** catch bad ordering that wastes Ralph iterations, hidden blockers, risk concentrated in late phases, and missed parallelism opportunities.

**Template prompt:**

```
Audit phase sequencing, story dependencies, and risk concentration in a PRD.

**PRD path:** {ABSOLUTE_PATH_TO_PRD}

**Context:** Ralph executes stories sequentially. Bad sequencing = wasted
iterations. Risk concentrated in late phases = late discovery of fundamental
problems. Cross-PRD coupling creates hidden blockers.

**Your job:**

1. **Map the dependency graph.** Are there explicit `Blocked By` edges
   missing where they should exist? Are there edges that could be relaxed
   to enable parallelism?

2. **Front-loaded risk check:** identify the 3 biggest unknowns in the PRD.
   Are they resolved in Phase 0/1 with decision gates or validation stories,
   or do they surface mid-implementation where cascading rework is expensive?
   If a risk is back-loaded, recommend a spike or early validation story.

3. **Decision gate blocking.** Do all decision gates have explicit Blocks
   relationships to the stories that depend on their resolution? If a story
   starts before its resolving gate, Ralph will make the wrong assumption.

4. **Parallelism opportunities.** Are there phases or stories that COULD
   run in parallel but don't have that flagged? Note the winnable time.

5. **Mega-dependency stories.** Stories blocked by "all Phase N stories"
   — what's the cutoff rule for appended (Phase 0 discovery) stories?
   Without an explicit cutoff, these never unblock.

6. **Cross-PRD coupling.** Does this PRD depend on types/contracts owned
   by another PRD? Is the coordination in explicit architecture docs or
   just PRD-to-PRD narrative notes that will rot?

7. **Decision gate user-wait cost.** How many total halts for user input?
   Can some be batched into one review session?

**Deliverable:** sequencing issues + recommended changes. Cite story IDs.
Propose concrete reorderings, new edges, or edges to relax. Under 500 words.
```

---

### Angle 5 (CUSTOMIZED): Topic-Specific Deep Dive

**Purpose:** the most important audit. The generic angles catch most issues, but every PRD has ONE technical risk that deserves a dedicated deep read — the thing that if wrong, the entire PRD cascades into rework.

**How to pick the 5th angle:**

Ask yourself: *"If this PRD fails, what's the most likely single cause?"* The answer is your 5th audit.

Examples from real audits:

- **PRD about porting features from V1 to V2:** deep audit of the V1 feature inventory. Does the PRD's prose list actually cover the real feature surface? (Real finding: a 10-feature prose list missed 23 features including the single most critical one.)
- **PRD about a new permission system:** deep audit of the existing governance crate it plans to extend. Is the extension actually clean or is it a rewrite? (Real finding: "just add a subject_kind enum" was actually a multi-table schema surgery.)
- **PRD about a new visualization engine:** deep audit of WebGPU browser compatibility + upstream library maturity. (Hypothetical.)
- **PRD about an install wizard:** deep audit of the existing install pipeline. Does it actually support user inputs, or is it zero-input? (Real finding: pipeline was a zero-input docker-compose wrapper.)
- **PRD about auth migration:** deep audit of the existing auth surface and every consumer. How deep is the migration, really?
- **PRD about a data model change:** deep audit of the existing schema and every query that touches the affected tables.

**Template prompt structure** (customize the body per-PRD):

```
Audit [specific topic] in a PRD. This is the highest-stakes audit for this
PRD because [reason].

**PRD path:** {ABSOLUTE_PATH_TO_PRD}
**Repo root:** {ABSOLUTE_REPO_ROOT}

**Why this matters:** [one paragraph explaining why this topic is the
load-bearing assumption of the PRD — what happens if the PRD is wrong
about it]

**What to investigate:**
1. [Specific file path / module / pattern to read]
2. [Specific claim in the PRD to verify deeply]
3. [Specific question about feasibility of the proposed approach]
...

**Specifically look for:**
- [Known-unknown 1]
- [Known-unknown 2]
- [Edge case 1]
- [Edge case 2]

**Deliverable:** [specific format — punch list, recommendation, feature
inventory, whatever fits]. Under 500 words (or 800 if this is the most
critical audit). Cite file paths.
```

---

## Step 4: Launch the Five Audits in Parallel

**Critical:** launch all 5 `Agent` calls in a **single message**. This is the only way to get true parallelism — sequential messages run sequentially.

```
<launch in one message>
Agent(subagent_type: "general-purpose", description: "Audit codebase grounding", prompt: "<angle 1 prompt>")
Agent(subagent_type: "general-purpose", description: "Audit story sizing and ACs", prompt: "<angle 2 prompt>")
Agent(subagent_type: "general-purpose", description: "Audit architectural design", prompt: "<angle 3 prompt>")
Agent(subagent_type: "general-purpose", description: "Audit sequencing and dependencies", prompt: "<angle 4 prompt>")
Agent(subagent_type: "general-purpose", description: "Audit <topic-specific>", prompt: "<angle 5 prompt>")
</launch in one message>
```

Each `description` should be 3-5 words. Each `prompt` must be fully self-contained — the agents start with no context from this conversation.

Expected completion time: 1-3 minutes per agent, running in parallel.

---

## Step 5: Consolidate Findings

Once all 5 audits return, consolidate into a single report. The output format:

```markdown
## Consolidated Audit Report — {PRD Name}

### 🔴 CRITICAL BLOCKERS
1. **{Issue title}.** {Which auditor found it, what it is, why it's a blocker,
   concrete fix recommendation.} Cite file paths.
2. ...

### 🟡 HIGH ISSUES
7. **{Issue title}.** {Same format, one paragraph each.}
...

### 🟢 SEQUENCING & QUALITY
15. **{Issue title}.** {One-sentence summary + fix.}
...

### 🔵 MEDIUM / SUGGESTIONS
{Bulleted list, one line each.}

---

### My recommendation

{One of:}
- **Proceed to /ralph conversion.** No blockers; minor quality items can be
  addressed as Ralph runs or in a follow-up.
- **Apply targeted revision pass.** Specific blockers listed; estimate of
  effort to fix; recommendation to re-audit after changes.
- **Major revision required.** Fundamental issues found; PRD should be
  rewritten before proceeding. Cite the deepest issues.

{List any open questions the user needs to answer before revision can proceed.}
```

**De-duplicate across auditors.** When two auditors find the same issue from different angles, merge them into one entry and cite both.

**Severity assignment rules:**

- **CRITICAL BLOCKER** — Ralph will fail, data will be corrupted, security will be broken, or the PRD's foundational claim is false
- **HIGH** — Correctness bug under edge cases, missing constraint, design smell that will bite later, or mega-story that will stall Ralph
- **SEQUENCING & QUALITY** — Wrong edges, missed parallelism, vague ACs, missing validation gates, minor documentation errors
- **MEDIUM / SUGGEST** — Style, optimization, future-facing improvements

---

## Examples of Good 5th Angles

When reading a PRD, these questions often reveal the right 5th angle:

| PRD Topic | Good 5th Angle |
|-----------|----------------|
| Feature port from old app to new app | Full feature inventory of old app — does the prose list actually cover it? |
| New permission/RBAC/auth system | Deep read of existing auth surface and every consumer; extension-vs-rewrite feasibility |
| Install wizard / provisioning | Existing pipeline capabilities — does it actually take user input? |
| Migration from library A to library B | Breaking changes inventory + upgrade path for every consumer |
| New data model / schema change | Query-level impact analysis on every existing consumer |
| Refactor / code organization | File-level mega-story detection; actual line counts vs claimed |
| New abstraction (manifest, registry, protocol) | Does it fit all claimed consumers, or leak into per-case special handling? |
| Integration with third-party system | Upstream API stability, quotas, error semantics, SDK gaps |
| UI framework change | Component migration path, state management compatibility, routing |
| Cryptographic or security-critical feature | Crypto design review, threat model, canonical forms, key lifecycle |

---

## Anti-Patterns

**Don't:**

1. **Launch audits sequentially.** You lose all the parallelism value. Single message with 5 tool calls.
2. **Write vague prompts.** "Audit the PRD for issues" produces useless output. Each prompt must have specific questions, file paths, and a concrete deliverable format.
3. **Copy the template prompts without customizing.** The Angle 1 claim list MUST be populated with claims from the actual PRD. The Angle 5 topic MUST be picked from the specific risk surface. Generic prompts produce generic findings.
4. **Skip the initial PRD read.** If you don't understand the PRD, you can't pick the 5th angle or populate Angle 1's claims list.
5. **Auto-fix based on audit findings.** Your job is to audit and report. The user decides whether findings warrant revision. Presenting findings != modifying files.
6. **De-rate severity.** If an auditor found a BLOCKER, report it as BLOCKER. Don't soften because the fix looks painful.
7. **Forget the de-duplication pass.** Multiple auditors will find the same issue from different angles. Merge them.
8. **Run on PRDs that don't need auditing.** Small feature PRDs with known scope don't need this. The skill is for substantial efforts where blockers are expensive.

---

## Delegating to Background Agents

If you delegate the audit to another skill or subagent, you MUST include:

```
Before running the audit, read the skill file at
~/.claude/skills/ralph-audit/SKILL.md and follow the 5-angle pattern
exactly. Launch all 5 Agent calls in a single message for parallelism.
```

Otherwise the subagent may run audits sequentially or skip the topic-specific 5th angle.

---

## Checklist

Before returning the consolidated report:

- [ ] Read the PRD end to end at least once
- [ ] Identified the topic-specific risk and picked the 5th angle accordingly
- [ ] Populated Angle 1's claim list with concrete items from the PRD
- [ ] Customized Angle 5's prompt with specific files / patterns / questions
- [ ] Launched all 5 audits in a **single message** (5 Agent calls in one tool-use block)
- [ ] Waited for all 5 to return
- [ ] De-duplicated findings across auditors
- [ ] Assigned severity tags per the rules
- [ ] Produced a consolidated report with CRITICAL / HIGH / SEQUENCING / MEDIUM sections
- [ ] Ended with an explicit recommendation (proceed / revise / major rewrite)
- [ ] Listed any open questions the user needs to answer

---

## Output

Present the consolidated report to the user. Do NOT:

- Modify the PRD yourself
- Run `/ralph` conversion
- Take any destructive action

DO:

- Be blunt about severity
- Cite file paths and line numbers from the audit findings
- Recommend next steps clearly
- Offer to apply a revision pass if the user asks, but wait for them to ask
