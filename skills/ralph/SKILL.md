---
name: ralph
description: "Convert PRDs to prd.json format for the Ralph autonomous agent system. Use when you have an existing PRD and need to convert it to Ralph's JSON format. Triggers on: convert this prd, turn this into ralph format, create prd.json from this, ralph json, start ralph."
version: "2.6"
---

# Ralph PRD Converter

Converts existing PRDs to the prd.json format that Ralph uses for autonomous execution.

---

## The Job

1. Find the PRD in its task subdirectory: `tasks/{effort-name}/prd.md`
2. Convert it to `tasks/{effort-name}/prd.json`
3. Ensure `tasks/{effort-name}/progress.txt` exists
4. **For investigations:** Ensure `tasks/{effort-name}/decisions/` directory exists

**All files for an effort live in the same subdirectory.**

---

## Directory Structure

```
tasks/
├── device-system-refactor/
│   ├── prd.md           # Source PRD (created by /prd skill)
│   ├── prd.json         # Created by THIS skill
│   └── progress.txt     # Ralph's iteration logs
├── thermal-camera-system/
│   ├── prd.md
│   ├── prd.json
│   ├── progress.txt
│   └── decisions/       # For investigation PRDs
│       └── US-010-DECIDE_architecture.md
└── archived/            # Completed efforts
    └── ...
```

---

## Output Format

Generated files use **schemaVersion 2.4** with support for phases, story spawning, decision gates, and optional mode flags.

### Basic Structure (Feature/Bug)

```json
{
  "schemaVersion": "2.4",
  "project": "[Project Name]",
  "taskDir": "tasks/[effort-name]",
  "branchName": "ralph/[effort-name]",
  "mergeTarget": "main|{branch-name}|null",
  "autoMerge": false,
  "pauseBetweenStories": false,
  "modelHintMode": false,
  "cavemanMode": false,
  "type": "feature|bug-investigation|investigation",
  "description": "[Description from PRD title/intro]",
  "userStories": [
    {
      "id": "US-001",
      "title": "[Story title]",
      "description": "As a [user], I want [feature] so that [benefit]",
      "acceptanceCriteria": [
        { "description": "Criterion 1", "passes": false },
        { "description": "Typecheck passes", "passes": false }
      ],
      "priority": 1,
      "modelHint": "opus",
      "passes": false,
      "notes": ""
    }
  ]
}
```

### Investigation Structure (Self-Expanding) ⭐ NEW

```json
{
  "schemaVersion": "2.4",
  "project": "[Project Name]",
  "taskDir": "tasks/[effort-name]",
  "branchName": "ralph/[effort-name]",
  "mergeTarget": "main",
  "autoMerge": false,
  "type": "investigation",
  "description": "[Description]",
  "phases": [
    {
      "id": 1,
      "name": "Discovery",
      "description": "Research and understand the problem space",
      "expandsTo": 2
    },
    {
      "id": 2,
      "name": "Implementation",
      "description": "Execute based on Phase 1 findings",
      "dynamic": true
    },
    {
      "id": 3,
      "name": "Validation",
      "description": "Verify all components work together",
      "requiresAllPrevious": true
    }
  ],
  "userStories": [
    {
      "id": "US-010",
      "title": "Research thermal camera integration",
      "description": "As a developer, I need to understand thermal camera options.",
      "phase": 1,
      "canSpawnStories": true,
      "spawnConfig": {
        "idPrefix": "US-010",
        "targetPhase": 2
      },
      "acceptanceCriteria": [
        { "description": "Document available SDKs/libraries", "passes": false },
        { "description": "Identify pros/cons of each option", "passes": false },
        { "description": "Create implementation stories OR decision gate", "passes": false },
        { "description": "Typecheck passes", "passes": false }
      ],
      "priority": 1,
      "passes": false,
      "notes": ""
    },
    {
      "id": "US-010-DECIDE",
      "title": "Architecture Decision: Control System Design",
      "description": "User decision required on architecture based on research.",
      "type": "decision-gate",
      "phase": 1,
      "blockedBy": ["US-010"],
      "blocks": [],
      "decisionConfig": {
        "slug": "architecture",
        "inputFile": "tasks/{effort-name}/decisions/US-010-DECIDE_architecture.md",
        "status": "pending",
        "options": [],
        "agentRecommendation": null,
        "recommendationReason": null,
        "confidenceLevel": null,
        "userSelection": null,
        "userNotes": null
      },
      "acceptanceCriteria": [
        { "description": "Options documented in decision file", "passes": false },
        { "description": "User has selected an option", "passes": false },
        { "description": "Implementation stories created based on selection", "passes": false }
      ],
      "priority": 2,
      "passes": false,
      "notes": ""
    },
    {
      "id": "US-999",
      "title": "Final Integration Validation",
      "description": "Verify all components work together.",
      "phase": 3,
      "blockedBy": [],
      "acceptanceCriteria": [
        { "description": "All components integrated", "passes": false },
        { "description": "End-to-end workflow tested", "passes": false },
        { "description": "No console errors", "passes": false },
        { "description": "Typecheck passes", "passes": false }
      ],
      "priority": 999,
      "passes": false,
      "notes": ""
    }
  ]
}
```

---

## Schema v2.4 Fields

### PRD-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schemaVersion` | string | Yes | Always "2.4" for new files |
| `project` | string | Yes | Project name |
| `taskDir` | string | Yes | Path to task subdirectory |
| `branchName` | string | Yes | Git branch name (ralph/effort-name) |
| `mergeTarget` | string\|null | Yes | Branch to merge into, or null |
| `autoMerge` | boolean | Yes | Auto-merge on completion |
| `type` | string | Yes | "feature", "bug-investigation", or "investigation" |
| `description` | string | Yes | PRD description |
| `pauseBetweenStories` | boolean | No | Pause for user input between stories (default: false) |
| `modelHintMode` | boolean | No | Default false. When true, stories with `modelHint` are delegated to Agent sub-tasks on cheaper models; independent unblocked stories may run in parallel. See §Optional Mode Flags. |
| `cavemanMode` | boolean | No | Default false. When true, Ralph compresses progress files, uses caveman-style terse chat output when running headless, and `/ralph-worktree` compresses AGENTS.md/CLAUDE.md once at setup. See §Optional Mode Flags. |
| `phases` | array | No | Phase definitions (investigation only) |
| `userStories` | array | Yes | Array of story objects |

### Phase Fields (Investigation PRDs only)

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Phase number (1, 2, 3...) |
| `name` | string | Phase name (Discovery, Implementation, Validation) |
| `description` | string | What this phase accomplishes |
| `expandsTo` | number | Which phase this phase creates stories for |
| `dynamic` | boolean | Stories created at runtime |
| `requiresAllPrevious` | boolean | Must wait for all prior phases |

### Story-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Story ID (US-001, US-010-A, etc.) |
| `title` | string | Yes | Story title |
| `description` | string | Yes | Story description |
| `acceptanceCriteria` | array | Yes | Array of {description, passes} |
| `priority` | number | Yes | Execution order (lower = first) |
| `passes` | boolean | Yes | Story completion status |
| `notes` | string | Yes | Scratchpad for context |
| `modelHint` | string | No | "opus" (default), "sonnet", or "haiku". Only honored when `modelHintMode: true`. See §Optional Mode Flags. |
| `phase` | number | No | Which phase (investigation only) |
| `type` | string | No | "decision-gate" for decisions |
| `canSpawnStories` | boolean | No | Can create child stories |
| `spawnConfig` | object | No | How to spawn stories |
| `blockedBy` | array | No | Story IDs that must complete first |
| `blocks` | array | No | Story IDs blocked by this story |
| `decisionConfig` | object | No | Decision gate configuration |

### SpawnConfig Fields

| Field | Type | Description |
|-------|------|-------------|
| `idPrefix` | string | Prefix for spawned story IDs |
| `targetPhase` | number | Which phase spawned stories belong to |

### DecisionConfig Fields

| Field | Type | Description |
|-------|------|-------------|
| `slug` | string | URL-safe identifier for decision |
| `inputFile` | string | Path to decision markdown file |
| `status` | string | "pending", "answered", "applied" |
| `options` | array | Available options (populated by agent) |
| `agentRecommendation` | string | Recommended option ID |
| `recommendationReason` | string | Why agent recommends this |
| `confidenceLevel` | string | "HIGH", "MEDIUM", "LOW" |
| `userSelection` | string | User's chosen option |
| `userNotes` | string | Additional user context |

---

## Optional Mode Flags

Ralph supports two **independent** mode flags on prd.json: `modelHintMode` and `cavemanMode`. Both default to `false`. They are orthogonal — you can enable either, both, or neither.

The default is always **both off** (i.e., the classic Ralph behavior: full Opus, serial, prose). Flip them only when `/ralph-pilot` has recommended the change AND the user has explicitly confirmed it, or when the user directly invoked `/ralph-modelhint` or `/ralph-caveman`.

### `modelHintMode: true` — delegation + parallelism

What it changes:
- `modelHint` on stories is **honored**: stories tagged `"sonnet"` or `"haiku"` are delegated to Agent sub-tasks on those models; Opus reviews the returned patch, re-runs the validation gate, and commits.
- Independent unblocked stories may run as **parallel** Agent sub-tasks (main thread serializes the apply+commit step; cap is 3 concurrent sub-agents).
- Safety carve-outs: decision-gate stories, `canSpawnStories: true` discovery stories, and the final validation story (US-999) always run on Opus regardless of their `modelHint`.

Best for: large PRDs (~15+ stories) where ≥50% of work is mechanical (CRUD, view XML from a spec, test scaffolds, callsite migrations). Cost savings come from Haiku/Sonnet delegation; wall-clock savings come from parallelism.

Avoid when: >50% of stories need Opus anyway (delegation overhead defeats the savings), PRD is research/investigation-heavy, or you don't yet know the codebase well enough to classify stories.

### `cavemanMode: true` — compression + terse output

What it changes:
- `ralph.sh` runs `caveman` on rotated `progress-N.txt` files so future iterations that read them consume fewer input tokens.
- `/ralph-worktree` runs a one-time `caveman` pass on AGENTS.md and CLAUDE.md files in the worktree at setup (these load every session, so compression here is high-leverage).
- When the run is **headless** (not attached to ralph-tui), `ralph.sh` sets `RALPH_HEADLESS=1` and prompt.md adopts caveman-style terse chat output.
- **Always in full prose regardless of this flag:** commit messages, decision-gate files (`decisions/*.md`), AGENTS.md additions during a run, and the Codebase Patterns section of progress.txt. Compression on these degrades readability for humans (commits) or for future Ralph iterations (patterns) and is never worth it.

Best for: long-running PRDs where input-token cost compounds (progress.txt grows large, AGENTS.md is substantial), or any PRD where output readability matters less than speed/cost.

Avoid when: PRD is decision-gate-heavy (compressed decision docs are harder for humans to review — though the carve-out protects decisions/*.md itself, surrounding context gets compressed), or you want every iteration's chat log to stay pristine for debugging a new workflow.

### Combinations

| `modelHintMode` | `cavemanMode` | Result |
|---|---|---|
| false | false | **Default.** Classic Ralph: Opus, serial, prose. |
| true | false | Delegation + parallelism, full-prose output. |
| false | true | Opus serial everywhere, but compressed context and terse headless output. |
| true | true | Maximum efficiency. Previously called "efficiency mode." |

### Who sets the flags

The PRD author sets both flags when generating prd.json. `/ralph-pilot` §11 (or the focused skills `/ralph-modelhint` and `/ralph-caveman`) will have already gotten explicit user confirmation. **Do not flip either to `true` unilaterally** — default to `false` if no pilot or user confirmation is on record.

### `modelHint` guidance

Populate `modelHint` on stories only when `modelHintMode: true`. If the PRD (or pilot) did not specify per-story model hints, use these heuristics. Default to `"opus"` if unsure.

| Story shape | modelHint |
|---|---|
| Architecture / design / data-model stories | `opus` |
| Decision-gate stories | `opus` |
| Discovery/research stories | `opus` |
| Final validation stories (US-999) | `opus` |
| Add a column + migration | `haiku` |
| Write view XML / form layout from a spec | `haiku` |
| Add a filter dropdown to an existing list | `haiku` |
| Write tests for an already-designed helper | `haiku` |
| Mechanical callsite migration (rename X→Y across N files) | `haiku` |
| New UI component with non-trivial state | `sonnet` |
| Server action with non-trivial business logic | `sonnet` |
| Refactor that touches multiple modules | `sonnet` |

When in doubt, prefer `opus`. A wrongly-hinted mechanical story costs a tiny bit of Opus; a wrongly-hinted design story costs a bad commit.

---

## Story Size: The Number One Rule

**Each story must be completable in ONE Ralph iteration (one context window).**

Ralph spawns a fresh Claude Code instance per iteration with no memory of previous work. If a story is too big, the LLM runs out of context before finishing and produces broken code.

### Right-sized stories:
- Add a database column and migration
- Add a UI component to an existing page
- Update a server action with new logic
- Add a filter dropdown to a list
- Research a library and document findings
- Create implementation stories from research

### Too big (split these):
- "Build the entire dashboard" - Split into: schema, queries, UI components, filters
- "Add authentication" - Split into: schema, middleware, login UI, session handling
- "Refactor the API" - Split into one story per endpoint or pattern
- "Research and implement X" - Split into: research story, then implementation stories

**Rule of thumb:** If you cannot describe the change in 2-3 sentences, it is too big.

---

## Story Ordering: Dependencies First

Stories execute in priority order. Earlier stories must not depend on later ones.

**Correct order:**
1. Schema/database changes (migrations)
2. Server actions / backend logic
3. UI components that use the backend
4. Dashboard/summary views that aggregate data

**For Bug Investigations:**
1. Reproduction (must come first)
2. Instrumentation/logging
3. Root cause analysis
4. Solution evaluation
5. Implementation
6. Validation (must come last)

**For Investigations (Self-Expanding):**
1. Phase 1: Discovery stories (priority 1-99)
2. Decision gates (priority based on blocked-by)
3. Phase 2: Implementation stories (priority 100-899) - created dynamically
4. Phase 3: Validation stories (priority 900-999)

---

## Acceptance Criteria: Must Be Verifiable

Each criterion must be something Ralph can CHECK, not something vague.

### Good criteria (verifiable):
- "Add `status` column to tasks table with default 'pending'"
- "Filter dropdown has options: All, Active, Completed"
- "Clicking delete shows confirmation dialog"
- "Document at least 2 architecture options with pros/cons"
- "Implementation stories created for chosen approach"
- "Options documented in decisions/US-010-DECIDE_architecture.md"
- "Typecheck passes"

### Bad criteria (vague):
- "Works correctly"
- "User can do X easily"
- "Good UX"
- "Handles edge cases"
- "Research is complete" (without specifying deliverable)

### Always include as final criterion:
```
"Typecheck passes"
```

For stories with testable logic:
```
"Tests pass"
```

For stories that change UI:
```
"Using Playwright MCP, verify: [specific behavior to check]"
```

**IMPORTANT:** Ralph is a full Claude Code instance with Playwright MCP, Docker CLI, and Bash. It can start dev servers, rebuild containers, navigate browsers, click buttons, and assert results. Never treat browser verification as a "manual" step — always write explicit Playwright verification criteria with service startup instructions.

For discovery stories:
```
"Create implementation stories for chosen approach OR create decision gate if user input needed"
```

---

## Conversion Rules

### Basic Rules (All PRDs)

1. **schemaVersion**: Always set to "2.4"
2. **Each user story becomes one JSON entry**
3. **IDs**: Sequential (US-001, US-002) or hierarchical (US-010, US-010-A, US-010-B)
4. **Priority**: Based on dependency order, then document order
5. **All stories**: `passes: false` and empty `notes`
6. **acceptanceCriteria**: Array of `{ "description": "...", "passes": false }`
7. **branchName**: Derive from effort name, kebab-case, prefixed with `ralph/`
8. **taskDir**: Set to the task subdirectory path
9. **Always add**: `{ "description": "Typecheck passes", "passes": false }`

### Service & Process Management Rules

10. **CRITICAL: Never kill all Node processes.** When starting or restarting dev servers, use targeted process management: kill by port (`lsof -ti:3001 | xargs kill` on Unix, or `netstat -ano | findstr :3001` then `taskkill /PID` on Windows) or by specific process name. **NEVER run `pkill node`, `killall node`, or `taskkill /IM node.exe /F`** — this kills the Playwright MCP server, which is irrecoverable and breaks all browser testing for the rest of the session.
11. **Starting services for browser tests:** When an AC requires Playwright verification, start the required services (e.g., `cargo run` for hf-api, `bun run dev` for V2 app) in the background, wait for them to be ready, then use Playwright MCP to navigate and verify. Stop services after verification if they weren't already running.

### Investigation-Specific Rules

12. **type**: Set to "investigation" for self-expanding PRDs
13. **phases**: Define phase structure if PRD specifies phases
14. **phase**: Set on each story to indicate which phase it belongs to
15. **canSpawnStories**: Set to `true` on discovery stories that create implementation stories
16. **spawnConfig**: Include `idPrefix` and `targetPhase` for spawning stories
17. **Decision gates**: Create with `type: "decision-gate"` and `decisionConfig`
18. **blockedBy/blocks**: Set up dependency chains between stories
19. **US-999**: Create final validation story with high priority (999) and `blockedBy` all Phase 2 stories

---

## Example: Feature PRD

**Input PRD:**
```markdown
# Task Status Feature

Add ability to mark tasks with different statuses.

## Requirements
- Toggle between pending/in-progress/done on task list
- Filter list by status
- Show status badge on each task
- Persist status in database
```

**Output:** `tasks/task-status/prd.json`
```json
{
  "schemaVersion": "2.4",
  "project": "TaskApp",
  "taskDir": "tasks/task-status",
  "branchName": "ralph/task-status",
  "mergeTarget": "main",
  "autoMerge": false,
  "type": "feature",
  "description": "Task Status Feature - Track task progress with status indicators",
  "userStories": [
    {
      "id": "US-001",
      "title": "Add status field to tasks table",
      "description": "As a developer, I need to store task status in the database.",
      "acceptanceCriteria": [
        { "description": "Add status column: 'pending' | 'in_progress' | 'done' (default 'pending')", "passes": false },
        { "description": "Generate and run migration successfully", "passes": false },
        { "description": "Typecheck passes", "passes": false }
      ],
      "priority": 1,
      "passes": false,
      "notes": ""
    },
    {
      "id": "US-002",
      "title": "Display status badge on task cards",
      "description": "As a user, I want to see task status at a glance.",
      "acceptanceCriteria": [
        { "description": "Each task card shows colored status badge", "passes": false },
        { "description": "Badge colors: gray=pending, blue=in_progress, green=done", "passes": false },
        { "description": "Typecheck passes", "passes": false },
        { "description": "Using Playwright MCP, verify: task cards display colored status badges", "passes": false }
      ],
      "priority": 2,
      "passes": false,
      "notes": ""
    }
  ]
}
```

---

## Example: Investigation PRD (Self-Expanding)

**Input PRD:**
```markdown
# PRD: Thermal Camera Control System

## Type
Investigation (Self-Expanding)

## Overview
Build a system that reads thermal camera frames and uses temperature data
to control microwave power and print speed.

## Phases
- Phase 1: Discovery - Research hardware, SDKs, protocols
- Phase 2: Implementation - Build based on findings
- Phase 3: Validation - Integration testing

## Discovery Stories

### US-010: Research thermal camera integration
Can Spawn Stories: Yes
...

### US-020: Research microwave control protocol
Can Spawn Stories: Yes
...

### US-010-DECIDE: Architecture Decision
Type: Decision Gate
...

## Validation Stories

### US-999: Final Integration Validation
...
```

**Output:** `tasks/thermal-camera/prd.json`
```json
{
  "schemaVersion": "2.4",
  "project": "ThermalControl",
  "taskDir": "tasks/thermal-camera",
  "branchName": "ralph/thermal-camera",
  "mergeTarget": "main",
  "autoMerge": false,
  "type": "investigation",
  "description": "Thermal Camera Control System - Read thermal frames and control equipment",
  "phases": [
    {
      "id": 1,
      "name": "Discovery",
      "description": "Research hardware, SDKs, and protocols",
      "expandsTo": 2
    },
    {
      "id": 2,
      "name": "Implementation",
      "description": "Build components based on research findings",
      "dynamic": true
    },
    {
      "id": 3,
      "name": "Validation",
      "description": "Integration testing and verification",
      "requiresAllPrevious": true
    }
  ],
  "userStories": [
    {
      "id": "US-010",
      "title": "Research thermal camera integration",
      "description": "As a developer, I need to understand thermal camera options and SDKs.",
      "phase": 1,
      "canSpawnStories": true,
      "spawnConfig": {
        "idPrefix": "US-010",
        "targetPhase": 2
      },
      "acceptanceCriteria": [
        { "description": "Document available thermal camera SDKs (FLIR, Seek, etc.)", "passes": false },
        { "description": "Identify frame rate and resolution capabilities", "passes": false },
        { "description": "Document integration complexity for each option", "passes": false },
        { "description": "Create implementation stories OR decision gate", "passes": false },
        { "description": "Typecheck passes", "passes": false }
      ],
      "priority": 1,
      "passes": false,
      "notes": ""
    },
    {
      "id": "US-020",
      "title": "Research microwave control protocol",
      "description": "As a developer, I need to understand how to control microwave power.",
      "phase": 1,
      "canSpawnStories": true,
      "spawnConfig": {
        "idPrefix": "US-020",
        "targetPhase": 2
      },
      "acceptanceCriteria": [
        { "description": "Document control interface (GPIO, serial, etc.)", "passes": false },
        { "description": "Identify power level granularity", "passes": false },
        { "description": "Document safety considerations", "passes": false },
        { "description": "Create implementation stories OR decision gate", "passes": false },
        { "description": "Typecheck passes", "passes": false }
      ],
      "priority": 2,
      "passes": false,
      "notes": ""
    },
    {
      "id": "US-010-DECIDE",
      "title": "Architecture Decision: System Integration Approach",
      "description": "User decision required on overall system architecture.",
      "type": "decision-gate",
      "phase": 1,
      "blockedBy": ["US-010", "US-020"],
      "blocks": [],
      "decisionConfig": {
        "slug": "architecture",
        "inputFile": "tasks/{effort-name}/decisions/US-010-DECIDE_architecture.md",
        "status": "pending",
        "options": [],
        "agentRecommendation": null,
        "recommendationReason": null,
        "confidenceLevel": null,
        "userSelection": null,
        "userNotes": null
      },
      "acceptanceCriteria": [
        { "description": "Options documented in decisions/US-010-DECIDE_architecture.md", "passes": false },
        { "description": "User has selected an architecture option", "passes": false },
        { "description": "Implementation stories created based on selection", "passes": false }
      ],
      "priority": 10,
      "passes": false,
      "notes": ""
    },
    {
      "id": "US-999",
      "title": "Final Integration Validation",
      "description": "Verify all components work together correctly.",
      "phase": 3,
      "blockedBy": [],
      "acceptanceCriteria": [
        { "description": "Thermal camera reads frames successfully", "passes": false },
        { "description": "Temperature data extracted from frames", "passes": false },
        { "description": "Microwave power responds to temperature changes", "passes": false },
        { "description": "End-to-end latency within acceptable range", "passes": false },
        { "description": "No console errors", "passes": false },
        { "description": "Typecheck passes", "passes": false }
      ],
      "priority": 999,
      "passes": false,
      "notes": ""
    }
  ]
}
```

---

## Running Ralph

After creating prd.json, run Ralph from the project root:

```bash
# Run ralph for a specific task directory
./ralph.sh tasks/thermal-camera

# Or with max iterations
./ralph.sh tasks/thermal-camera 20
```

Ralph will:
1. Read `prd.json` from the specified task directory
2. Log progress to `progress.txt` in the same directory
3. Work through stories until all pass or max iterations reached
4. **For investigations:** Create implementation stories as discovery completes
5. **For decision gates:** Write decision file and wait for user input

---

## Research Mode

When converting a Research PRD (created by `/research-prd`), use these additional rules:

### prd.json Differences

1. **type:** Set to `"research"`
2. **Story IDs:** Use `RS-` prefix (not `US-`)
3. **No "Typecheck passes" criterion** — use document quality criteria instead
4. **researchConfig:** Add research-specific configuration

```json
{
  "schemaVersion": "2.4",
  "type": "research",
  "researchConfig": {
    "outputDir": "research/{layer}/",
    "architectureTargets": ["architecture/{layer}/{file}.md"],
    "sourceRequirements": {
      "minimumPerStory": 5,
      "requirePrimarySources": true,
      "requireURLs": true
    }
  }
}
```

### Research Ralph Prompt

When the user runs `/ralph-loop` for a research PRD, they should use this prompt template:

```
You are a research agent working on a Hyperfactory architecture research effort.

Read tasks/{effort-name}/prd.json to find the next incomplete research story.

For each research story:
1. Read the story's acceptance criteria carefully
2. Use WebSearch and WebFetch to find authoritative sources
3. Analyze findings against Hyperfactory's constraints (air-gap, licensing, scale, manufacturing context)
4. Write the research document to the specified deliverable path
5. Cite ALL sources with URLs — no "industry best practice" without citation
6. If you lack deep knowledge on a topic, say so explicitly and recommend specific readings
7. Register new research files in research/index.md
8. Update the story's acceptance criteria in prd.json as you complete them
9. Mark the story as passes: true when all criteria are met

For decision gate stories:
1. Write the decision file to decisions/{slug}.md
2. Include your recommendation with confidence level (HIGH/MEDIUM/LOW)
3. Be honest about what you're unsure about
4. Mark the decision status as "pending" — do NOT mark it as passes: true
5. The loop will continue but the decision gate blocks downstream stories

You do NOT write code, run typechecks, or verify in browser. You produce research documents.

Log your progress to tasks/{effort-name}/progress.txt after each story.
```

The user invokes it as:
```bash
/ralph-loop [paste research prompt above] --max-iterations 30 --completion-promise 'All research stories complete'
```

---

## Checklist Before Saving

Before writing prd.json, verify:

- [ ] `schemaVersion` is set to "2.4"
- [ ] `modelHintMode` and `cavemanMode` are both `false` unless /ralph-pilot, /ralph-modelhint, or /ralph-caveman has explicitly confirmed the change with the user
- [ ] prd.json is saved in the same directory as prd.md
- [ ] `taskDir` field matches the directory path
- [ ] `mergeTarget` field is set (branch name or `null`)
- [ ] `autoMerge` field is set (`true` or `false`)
- [ ] `type` field is correct (feature, bug-investigation, or investigation)
- [ ] `acceptanceCriteria` uses object format
- [ ] Each story is completable in one iteration
- [ ] Stories are ordered by dependency
- [ ] Every story has "Typecheck passes" criterion
- [ ] UI stories have explicit Playwright MCP verification criterion (not vague "Verify in browser")
- [ ] **Investigation PRDs:**
  - [ ] `phases` array defined
  - [ ] Discovery stories have `phase`, `canSpawnStories`, `spawnConfig`
  - [ ] Decision gates have `type: "decision-gate"` and `decisionConfig`
  - [ ] `blockedBy`/`blocks` arrays set up correctly
  - [ ] Final validation story (US-999) exists

---

## After Conversion — Show Task Info with TUI Number

After creating the prd.json, show the user the **Ralph TUI task number** and launch command. The TUI lists tasks alphabetically by directory name — determine the position so the user can select it directly.

**How to determine the TUI number:**

```bash
ls -1 tasks/ | sort | grep -n "{effort-name}" | cut -d: -f1
```

**Format (single PRD):**

```
prd.json created at tasks/{effort-name}/prd.json ({N} stories, {type})

| TUI # | Task Dir | Stories | Type |
|-------|----------|---------|------|
| 20 | tasks/fix-app-design-system-compliance | 8 | feature |

Launch: /ralph-loop D:\{worktree} tasks/{effort-name}
```

**Format (multiple PRDs):**

```
| TUI # | Task Dir | Stories | Type |
|-------|----------|---------|------|
| 16 | tasks/dataview-full-app | 14 | feature |
| 47 | tasks/shopflow-full-app | 21 | feature |

Launch commands:
  /ralph-loop D:\dataview-full-app tasks/dataview-full-app
  /ralph-loop D:\shopflow-full-app tasks/shopflow-full-app
```

The **TUI #** matches what `ralph-tui` shows when it prompts "Select task [1-N]:", so the user can type the number directly without scanning the full list. Keep it concise — only show the PRDs just created.

---

## Delegating to Background Agents

If you are delegating prd.json creation to a background Agent (subagent), you **MUST** include the following in the agent's prompt:

1. **Tell the agent to read this skill file first:**
   ```
   Before generating any JSON, read the skill file at C:\Users\apino\.claude\skills\ralph\skill.md
   and follow the schema EXACTLY. Pay special attention to the "Output Format" and "Schema v2.1 Fields" sections.
   ```

2. **Explicitly list the critical field names that agents commonly get wrong:**
   ```
   CRITICAL schema requirements:
   - The stories array MUST be named "userStories" (NOT "stories")
   - Each story MUST have: id, title, description, acceptanceCriteria, priority, passes (boolean), notes (string)
   - acceptanceCriteria MUST be an array of objects: [{"description": "...", "passes": false}] (NOT string arrays)
   - The PRD MUST have a "description" field (string)
   - Do NOT add extra fields like "files", "deliverable", or "title" at the PRD level
   - Decision gates MUST have decisionConfig.inputFile pointing to tasks/{effort-name}/decisions/{slug}.md (NOT repo root decisions/)
   - Decision files go INSIDE the task directory, never at the repo root
   ```

**Why this matters:** Background agents don't automatically receive skill context. Without explicit instructions, they generate "reasonable-looking" JSON with wrong field names (`stories` instead of `userStories`, string arrays instead of objects), which causes ralph-tui to fail to load the PRD. This has happened multiple times.
