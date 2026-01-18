---
name: ralph
description: "Convert PRDs to prd.json format for the Ralph autonomous agent system. Use when you have an existing PRD and need to convert it to Ralph's JSON format. Triggers on: convert this prd, turn this into ralph format, create prd.json from this, ralph json, start ralph."
version: "2.0"
---

# Ralph PRD Converter

Converts existing PRDs to the prd.json format that Ralph uses for autonomous execution.

---

## The Job

1. Find the PRD in its task subdirectory: `tasks/{effort-name}/prd.md`
2. Convert it to `tasks/{effort-name}/prd.json`
3. Ensure `tasks/{effort-name}/progress.txt` exists

**All files for an effort live in the same subdirectory.**

---

## Directory Structure

```
tasks/
├── device-system-refactor/
│   ├── prd.md           # Source PRD (created by /prd skill)
│   ├── prd.json         # Created by THIS skill
│   └── progress.txt     # Ralph's iteration logs
├── fix-auth-timeout/
│   ├── prd.md
│   ├── prd.json
│   └── progress.txt
└── archived/            # Completed efforts
    └── ...
```

---

## Output Format

Generated files use **schemaVersion 2.0** with per-criteria tracking.

```json
{
  "schemaVersion": "2.0",
  "project": "[Project Name]",
  "taskDir": "tasks/[effort-name]",
  "branchName": "ralph/[effort-name]",
  "type": "feature|bug-investigation",
  "description": "[Description from PRD title/intro]",
  "userStories": [
    {
      "id": "US-001",
      "title": "[Story title]",
      "description": "As a [user], I want [feature] so that [benefit]",
      "acceptanceCriteria": [
        { "description": "Criterion 1", "passes": false },
        { "description": "Criterion 2", "passes": false },
        { "description": "Typecheck passes", "passes": false }
      ],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}
```

**Fields:**
- `schemaVersion`: Always "2.0" for new prd.json files
- `taskDir`: Path to the task subdirectory (used by ralph.sh)
- `type`: Either "feature" or "bug-investigation"
- `acceptanceCriteria`: Array of objects with `description` (string) and `passes` (bool, initially false)
- `notes`: Scratchpad for passing context between iterations (especially useful for bug investigations)

---

## Story Size: The Number One Rule

**Each story must be completable in ONE Ralph iteration (one context window).**

Ralph spawns a fresh Claude Code instance per iteration with no memory of previous work. If a story is too big, the LLM runs out of context before finishing and produces broken code.

### Right-sized stories:
- Add a database column and migration
- Add a UI component to an existing page
- Update a server action with new logic
- Add a filter dropdown to a list

### Too big (split these):
- "Build the entire dashboard" - Split into: schema, queries, UI components, filters
- "Add authentication" - Split into: schema, middleware, login UI, session handling
- "Refactor the API" - Split into one story per endpoint or pattern

**Rule of thumb:** If you cannot describe the change in 2-3 sentences, it is too big.

---

## Story Ordering: Dependencies First

Stories execute in priority order. Earlier stories must not depend on later ones.

**Correct order:**
1. Schema/database changes (migrations)
2. Server actions / backend logic
3. UI components that use the backend
4. Dashboard/summary views that aggregate data

**Wrong order:**
1. UI component (depends on schema that does not exist yet)
2. Schema change

**For Bug Investigations:**
1. Reproduction (must come first)
2. Instrumentation/logging
3. Root cause analysis
4. Solution evaluation
5. Implementation
6. Validation (must come last)

---

## Acceptance Criteria: Must Be Verifiable

Each criterion must be something Ralph can CHECK, not something vague.

### Good criteria (verifiable):
- "Add `status` column to tasks table with default 'pending'"
- "Filter dropdown has options: All, Active, Completed"
- "Clicking delete shows confirmation dialog"
- "Bug no longer reproduces with original steps"
- "Root cause documented in prd.json notes"
- "Typecheck passes"
- "Tests pass"

### Bad criteria (vague):
- "Works correctly"
- "User can do X easily"
- "Good UX"
- "Handles edge cases"
- "Bug is fixed" (without specifying how to verify)

### Always include as final criterion:
```
"Typecheck passes"
```

For stories with testable logic, also include:
```
"Tests pass"
```

### For stories that change UI, also include:
```
"Verify in browser"
```

Frontend stories are NOT complete until visually verified. Ralph will use browser automation (if available) or document that manual verification is needed.

---

## Conversion Rules

1. **schemaVersion**: Always set to "2.0"
2. **Each user story becomes one JSON entry**
3. **IDs**: Sequential (US-001, US-002, etc.)
4. **Priority**: Based on dependency order, then document order
5. **All stories**: `passes: false` and empty `notes`
6. **acceptanceCriteria**: Array of `{ "description": "...", "passes": false }` objects
7. **branchName**: Derive from effort name, kebab-case, prefixed with `ralph/`
8. **taskDir**: Set to the task subdirectory path
9. **type**: Set based on PRD type (feature or bug-investigation)
10. **Always add**: `{ "description": "Typecheck passes", "passes": false }` to every story's acceptance criteria

---

## Splitting Large PRDs

If a PRD has big features, split them:

**Original:**
> "Add user notification system"

**Split into:**
1. US-001: Add notifications table to database
2. US-002: Create notification service for sending notifications
3. US-003: Add notification bell icon to header
4. US-004: Create notification dropdown panel
5. US-005: Add mark-as-read functionality
6. US-006: Add notification preferences page

Each is one focused change that can be completed and verified independently.

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
  "schemaVersion": "2.0",
  "project": "TaskApp",
  "taskDir": "tasks/task-status",
  "branchName": "ralph/task-status",
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
        { "description": "Verify in browser", "passes": false }
      ],
      "priority": 2,
      "passes": false,
      "notes": ""
    },
    {
      "id": "US-003",
      "title": "Add status toggle to task list rows",
      "description": "As a user, I want to change task status directly from the list.",
      "acceptanceCriteria": [
        { "description": "Each row has status dropdown or toggle", "passes": false },
        { "description": "Changing status saves immediately", "passes": false },
        { "description": "UI updates without page refresh", "passes": false },
        { "description": "Typecheck passes", "passes": false },
        { "description": "Verify in browser", "passes": false }
      ],
      "priority": 3,
      "passes": false,
      "notes": ""
    },
    {
      "id": "US-004",
      "title": "Filter tasks by status",
      "description": "As a user, I want to filter the list to see only certain statuses.",
      "acceptanceCriteria": [
        { "description": "Filter dropdown: All | Pending | In Progress | Done", "passes": false },
        { "description": "Filter persists in URL params", "passes": false },
        { "description": "Typecheck passes", "passes": false },
        { "description": "Verify in browser", "passes": false }
      ],
      "priority": 4,
      "passes": false,
      "notes": ""
    }
  ]
}
```

---

## Example: Bug Investigation PRD

**Output:** `tasks/fix-auth-timeout/prd.json`
```json
{
  "schemaVersion": "2.0",
  "project": "TaskApp",
  "taskDir": "tasks/fix-auth-timeout",
  "branchName": "ralph/fix-auth-timeout",
  "type": "bug-investigation",
  "description": "Fix Auth Timeout - Users randomly logged out after 5 minutes",
  "userStories": [
    {
      "id": "US-001",
      "title": "Reproduce the auth timeout issue",
      "description": "As a developer, I need to reliably reproduce the bug.",
      "acceptanceCriteria": [
        { "description": "Document exact steps to reproduce", "passes": false },
        { "description": "Identify minimum conditions to trigger timeout", "passes": false },
        { "description": "Create automated test if possible", "passes": false },
        { "description": "Typecheck passes", "passes": false }
      ],
      "priority": 1,
      "passes": false,
      "notes": ""
    },
    {
      "id": "US-002",
      "title": "Add logging to auth flow",
      "description": "As a developer, I need visibility into the auth state.",
      "acceptanceCriteria": [
        { "description": "Add logging to session refresh logic", "passes": false },
        { "description": "Log token expiration times", "passes": false },
        { "description": "Capture state when timeout occurs", "passes": false },
        { "description": "Typecheck passes", "passes": false }
      ],
      "priority": 2,
      "passes": false,
      "notes": ""
    },
    {
      "id": "US-003",
      "title": "Identify root cause",
      "description": "As a developer, I need to understand why timeouts occur.",
      "acceptanceCriteria": [
        { "description": "Document root cause in notes field", "passes": false },
        { "description": "Identify specific code causing the issue", "passes": false },
        { "description": "Typecheck passes", "passes": false }
      ],
      "priority": 3,
      "passes": false,
      "notes": ""
    },
    {
      "id": "US-004",
      "title": "Implement auth timeout fix",
      "description": "As a developer, I need to fix the timeout issue.",
      "acceptanceCriteria": [
        { "description": "Implement fix based on root cause", "passes": false },
        { "description": "Ensure fix handles edge cases", "passes": false },
        { "description": "Typecheck passes", "passes": false },
        { "description": "Tests pass", "passes": false }
      ],
      "priority": 4,
      "passes": false,
      "notes": ""
    },
    {
      "id": "US-005",
      "title": "Validate auth fix",
      "description": "As a developer, I need to confirm the fix works.",
      "acceptanceCriteria": [
        { "description": "Original reproduction steps no longer cause timeout", "passes": false },
        { "description": "Session persists correctly for extended periods", "passes": false },
        { "description": "Remove debug logging", "passes": false },
        { "description": "Typecheck passes", "passes": false }
      ],
      "priority": 5,
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
./ralph.sh tasks/fix-auth-timeout

# Or with max iterations
./ralph.sh tasks/fix-auth-timeout 20
```

Ralph will:
1. Read `prd.json` from the specified task directory
2. Log progress to `progress.txt` in the same directory
3. Work through stories until all pass or max iterations reached

---

## Archiving Completed Efforts

When an effort is complete and you want to archive it:

```bash
# Move completed effort to archived folder
mkdir -p tasks/archived
mv tasks/fix-auth-timeout tasks/archived/
```

Or use the project's archive conventions. The archived folder keeps completed work organized while keeping the active `tasks/` directory clean.

---

## Checklist Before Saving

Before writing prd.json, verify:

- [ ] `schemaVersion` is set to "2.0"
- [ ] prd.json is saved in the same directory as prd.md
- [ ] `taskDir` field matches the directory path
- [ ] `type` field is set correctly (feature or bug-investigation)
- [ ] `acceptanceCriteria` uses object format: `{ "description": "...", "passes": false }`
- [ ] Each story is completable in one iteration (small enough)
- [ ] Stories are ordered by dependency (schema → backend → UI)
- [ ] Every story has "Typecheck passes" as criterion
- [ ] UI stories have "Verify in browser" as criterion
- [ ] Bug investigation stories follow the reproduce → analyze → fix → validate flow
- [ ] Acceptance criteria are verifiable (not vague)
- [ ] No story depends on a later story
