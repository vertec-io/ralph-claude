---
name: prd
description: "Generate a structured requirements document for features OR bug investigations. Use when planning a feature, troubleshooting a bug, or any multi-step effort. Triggers on: create a prd, write prd for, plan this feature, investigate this bug, troubleshoot, debug."
version: "1.3"
---

# PRD Generator

Create detailed requirements documents that are clear, actionable, and suitable for autonomous execution via Ralph.

**Supports three modes:**
1. **Feature** - Standard feature development with known scope
2. **Bug Investigation** - Structured debugging flow
3. **Investigation** - Self-expanding PRDs for complex tasks with unknown scope

---

## The Job

1. Determine the **type** (feature, bug, or investigation)
2. Ask 3-5 essential clarifying questions (with lettered options)
3. Generate a structured PRD based on answers
4. Create directory: `tasks/{effort-name}/`
5. Save PRD to `tasks/{effort-name}/prd.md`
6. Initialize empty `tasks/{effort-name}/progress.txt`
7. **For investigations:** Create `tasks/{effort-name}/decisions/` directory

**Important:** Do NOT start implementing. Just create the PRD and directory structure.

---

## Directory Structure

Each effort gets its own subdirectory:

```
tasks/
├── device-system-refactor/
│   ├── prd.md           # The requirements document
│   ├── prd.json         # Created by /ralph skill
│   └── progress.txt     # Ralph's iteration logs
├── thermal-camera-system/
│   ├── prd.md
│   ├── prd.json
│   ├── progress.txt
│   └── decisions/       # For investigation PRDs
│       └── US-010-DECIDE_architecture.md
└── archived/            # Completed efforts (via /archive skill)
    └── ...
```

---

## Step 1: Determine Type

First, identify what kind of effort this is:

### Feature PRD (Simple)
For new functionality with **known scope** - you can define all stories upfront.

**Signals:**
- "Add a button that..."
- "Create a form for..."
- "Implement feature X"
- Clear, bounded requirements

### Bug Investigation PRD
For troubleshooting, debugging, or fixing issues. Follows a structured investigation flow:
1. Reproduce the issue
2. Add instrumentation/logging
3. Identify root cause
4. Evaluate solutions
5. Implement fix
6. Validate fix

### Investigation PRD (Self-Expanding) ⭐ NEW
For complex tasks where the **full scope isn't known upfront**. Research discovers what needs to be built.

**Signals:**
- "Build a fully functional X system"
- "Migrate from A to B"
- "Validate all modules"
- "Integrate with hardware/external system"
- "Audit the codebase for X"
- Tasks involving: sensors, protocols, ML/AI, unknown APIs
- Anything needing a "spike" or "proof of concept"
- When you hear "I'm not sure how to approach this"

**Example complex feature:**
> "Build a thermal camera system that reads frames and controls microwave power based on temperature"

This requires research before implementation - you can't write implementation stories until you know:
- What SDK reads thermal frames?
- What protocol controls the microwave?
- What's the latency budget?
- Are there existing libraries to leverage?

---

## Step 2: Offer Self-Expanding Pattern (For Complex Tasks)

When you detect complexity signals, offer the choice:

```
This task involves **unknown scope** - you'll likely discover requirements
as you research and prototype.

Would you like to use a **self-expanding PRD**?

1. **Yes, use self-expanding pattern** (Recommended for this task)
   - Phase 1: Research/discovery stories
   - Phase 2: Implementation stories (auto-created from findings)
   - Phase 3: Integration/validation
   - Decision gates pause for your input when needed

2. **No, I'll define all stories upfront**
   - Standard PRD with fixed story list
   - Better if you already know the full scope

3. **Let me research first, then propose phases**
   - I'll do initial exploration
   - Then suggest a phased approach based on findings
```

**If user chooses option 1 or 3**, use the Investigation PRD structure below.

---

## Step 3: Clarifying Questions

Ask only critical questions where the initial prompt is ambiguous. Focus on:

- **Problem/Goal:** What problem does this solve?
- **Core Functionality:** What are the key actions?
- **Scope/Boundaries:** What should it NOT do?
- **Success Criteria:** How do we know it's done?

### Format Questions Like This:

```
1. What is the primary goal of this feature?
   A. Improve user onboarding experience
   B. Increase user retention
   C. Reduce support burden
   D. Other: [please specify]

2. Who is the target user?
   A. New users only
   B. Existing users only
   C. All users
   D. Admin users only

3. What is the scope?
   A. Minimal viable version
   B. Full-featured implementation
   C. Just the backend/API
   D. Just the UI
```

This lets users respond with "1A, 2C, 3B" for quick iteration.

### For Bug Investigations, also ask:

```
1. How reliably can you reproduce this?
   A. 100% reproducible with known steps
   B. Intermittent but frequent
   C. Rare / hard to reproduce
   D. Only seen in production

2. What's the impact severity?
   A. Critical - blocking users
   B. High - major functionality broken
   C. Medium - workaround exists
   D. Low - minor inconvenience

3. What debugging has been done so far?
   A. None yet
   B. Basic investigation (logs checked)
   C. Significant debugging already
   D. Root cause identified, need fix
```

### For Investigations, also ask:

```
1. How much is known about the problem space?
   A. Very little - need significant research
   B. Some knowledge - need to validate approaches
   C. Good understanding - need to evaluate options
   D. Clear path - just need to implement

2. Are there multiple possible architectures/approaches?
   A. Yes, will need to evaluate and choose
   B. Maybe, depends on research findings
   C. No, path is clear
   D. Unknown

3. Should I pause for your decision on architecture choices?
   A. Yes, always ask before major decisions
   B. Only if options are roughly equal
   C. No, make the best choice and proceed
```

### For All PRDs, also ask about merge target:

```
N. Once complete, where should this branch be merged?
   A. Main branch (will merge to main when done)
   B. Another branch: [please specify]
   C. No merge target (leave as standalone branch)
```

If user chooses A or B, follow up with:

```
N+1. Should Ralph auto-merge when complete, or ask first?
   A. Auto-merge (merge automatically when all stories pass)
   B. Ask first (prompt for confirmation before merging)
```

---

## Step 4: PRD Structure

Generate the PRD with these sections:

### 1. Introduction/Overview
Brief description of the feature/issue and the problem it solves.

### 2. Type
Either `Feature`, `Bug Investigation`, or `Investigation`.

### 3. Goals
Specific, measurable objectives (bullet list).

### 4. User Stories
Each story needs:
- **Title:** Short descriptive name
- **Description:** "As a [user], I want [feature] so that [benefit]"
- **Acceptance Criteria:** Verifiable checklist of what "done" means

Each story should be small enough to implement in one focused session (one Ralph iteration).

**Format:**
```markdown
### US-001: [Title]
**Description:** As a [user], I want [feature] so that [benefit].

**Acceptance Criteria:**
- [ ] Specific verifiable criterion
- [ ] Another criterion
- [ ] Typecheck/lint passes
- [ ] **[UI stories only]** Verify in browser
```

**Important:**
- Acceptance criteria must be verifiable, not vague. "Works correctly" is bad. "Button shows confirmation dialog before deleting" is good.
- **For any story with UI changes:** Always include "Verify in browser" as acceptance criteria.

### 5. Functional Requirements
Numbered list of specific functionalities:
- "FR-1: The system must allow users to..."
- "FR-2: When a user clicks X, the system must..."

Be explicit and unambiguous.

### 6. Non-Goals (Out of Scope)
What this feature will NOT include. Critical for managing scope.

### 7. Design Considerations (Optional)
- UI/UX requirements
- Link to mockups if available
- Relevant existing components to reuse

### 8. Technical Considerations (Optional)
- Known constraints or dependencies
- Integration points with existing systems
- Performance requirements

### 9. Success Metrics
How will success be measured?
- "Reduce time to complete X by 50%"
- "Increase conversion rate by 10%"

### 10. Open Questions
Remaining questions or areas needing clarification.

### 11. Merge Target
Where this branch should be merged when complete:
- `main` - Merge to main branch
- `{branch-name}` - Merge to specified branch
- `none` - No merge target (standalone branch)

If a merge target is specified, also indicate:
- `auto-merge: yes` - Merge automatically when all stories pass
- `auto-merge: no` - Ask for confirmation before merging

---

## Investigation PRD Structure ⭐ NEW

For self-expanding PRDs, use this adapted structure:

```markdown
# PRD: [System/Feature Name]

## Type
Investigation (Self-Expanding)

## Overview
What we're trying to build/achieve and why the scope requires discovery.

## Phases

### Phase 1: Discovery
Research and understand the problem space. Stories in this phase:
- Analyze existing systems/code
- Research libraries, APIs, or hardware
- Prototype approaches
- **May spawn implementation stories based on findings**

### Phase 2: Implementation
Execute based on Phase 1 findings. Stories in this phase:
- Created dynamically from discovery findings
- Implement chosen architecture
- Build components identified in Phase 1

### Phase 3: Integration & Validation
Verify everything works together. Stories in this phase:
- Integration testing
- End-to-end validation
- Performance verification

## Discovery Stories (Phase 1)

### US-010: Research [Component/Area]
**Description:** As a developer, I need to understand [X] to make informed implementation decisions.

**Phase:** 1 (Discovery)
**Can Spawn Stories:** Yes

**Acceptance Criteria:**
- [ ] Document available approaches/libraries
- [ ] Identify pros/cons of each option
- [ ] Create implementation stories for chosen approach OR create decision gate if user input needed
- [ ] Typecheck passes

### US-010-DECIDE: Architecture Decision (Decision Gate)
**Description:** User decision required on architecture based on research findings.

**Phase:** 1
**Type:** Decision Gate
**Blocked By:** US-010
**Blocks:** Implementation stories (US-011-*)

**Acceptance Criteria:**
- [ ] Options documented in `decisions/US-010-DECIDE_architecture.md`
- [ ] User has selected an option
- [ ] Implementation stories created based on selection

## Implementation Stories (Phase 2)

*These will be created by Phase 1 discovery stories or after decision gates are resolved.*

### US-011-A: [Will be created after US-010 completes]
### US-011-B: [Will be created after US-010 completes]

## Validation Stories (Phase 3)

### US-999: Final Integration Validation
**Description:** Verify all components work together correctly.

**Phase:** 3
**Blocked By:** All Phase 2 stories

**Acceptance Criteria:**
- [ ] All components integrated
- [ ] End-to-end workflow tested
- [ ] No console errors
- [ ] Performance acceptable
- [ ] Typecheck passes
- [ ] Verify in browser (if applicable)

## Decision Points

List anticipated decisions that may require user input:
1. Architecture selection (after US-010)
2. [Other potential decisions]

## Non-Goals
- What we're NOT trying to build in this effort

## Open Questions
Unknowns that Phase 1 should answer.
```

---

## Decision Gates

When research reveals multiple viable approaches, create a **Decision Gate** story:

### When to Create a Decision Gate:
- Multiple architectures are viable and roughly equal
- Trade-offs require business/user input
- The choice significantly impacts implementation scope
- Agent confidence is low on best path

### When NOT to Create a Decision Gate:
- One option is clearly superior
- The decision is purely technical with obvious best practice
- Agent has high confidence in recommendation

### Decision Gate Story Format:

```markdown
### US-010-DECIDE: [Decision Name]
**Description:** User decision required on [topic] based on research findings.

**Type:** Decision Gate
**Blocked By:** [Research story that produced options]
**Blocks:** [Implementation stories that depend on this decision]

**Acceptance Criteria:**
- [ ] Options documented in decisions/US-010-DECIDE_[slug].md
- [ ] User has selected an option in the decision file
- [ ] Implementation stories created based on selection
```

### Decision File Template:

Create `decisions/US-010-DECIDE_[slug].md`:

```markdown
# Decision: [Topic]
**Story:** US-010-DECIDE
**Status:** ⏳ PENDING
**Blocks:** [List of blocked stories]

---

## Context

[Summary of research findings that led to this decision point]

## Options

### Option A: [Name]
[Description]

| Pros | Cons |
|------|------|
| Pro 1 | Con 1 |
| Pro 2 | Con 2 |

**Estimated effort:** [X stories]

### Option B: [Name]
[Description]

| Pros | Cons |
|------|------|
| Pro 1 | Con 1 |
| Pro 2 | Con 2 |

**Estimated effort:** [X stories]

## Agent Recommendation

**Recommended: Option [X]**

Reasoning: [Why this option seems best]

Confidence: [HIGH/MEDIUM/LOW] - [Explanation]

---

## Your Decision

> Edit this section, save the file, then run `ralph run`

**Selected Option:**
<!-- Enter: A, B, etc. -->

**Additional Requirements:** (optional)
<!-- Any constraints or preferences for implementation -->

**Notes:** (optional)
<!-- Any context for why you chose this option -->

---
*Generated by Ralph • Decision required to continue*
```

---

## Writing for Junior Developers

The PRD reader may be a junior developer or AI agent. Therefore:

- Be explicit and unambiguous
- Avoid jargon or explain it
- Provide enough detail to understand purpose and core logic
- Number requirements for easy reference
- Use concrete examples where helpful

---

## Bug Investigation PRD Structure

For bug investigations, use this adapted structure:

```markdown
# PRD: [Bug/Issue Name]

## Type
Bug Investigation

## Problem Statement
Clear description of the bug:
- What is happening (actual behavior)
- What should happen (expected behavior)
- When it started (if known)
- Impact on users

## Reproduction Steps
1. Step to reproduce
2. Another step
3. Expected vs actual result

## Environment
- Browser/OS/Device (if relevant)
- Environment (dev/staging/prod)
- Relevant versions

## Goals
- Identify root cause
- Implement fix
- Prevent regression

## Investigation Stories

### US-001: Reproduce the issue reliably
**Description:** As a developer, I need to reliably reproduce the bug so I can debug it.

**Acceptance Criteria:**
- [ ] Document exact reproduction steps
- [ ] Identify minimum conditions to trigger bug
- [ ] Create test case or script if possible
- [ ] Typecheck passes

### US-002: Add instrumentation and logging
**Description:** As a developer, I need visibility into what's happening when the bug occurs.

**Acceptance Criteria:**
- [ ] Add relevant logging to suspected areas
- [ ] Capture state at key points
- [ ] Log errors with full context
- [ ] Typecheck passes

### US-003: Identify root cause
**Description:** As a developer, I need to understand why the bug is happening.

**Acceptance Criteria:**
- [ ] Document the root cause clearly
- [ ] Identify the specific code/logic causing the issue
- [ ] Understand the conditions that trigger it
- [ ] Update notes in prd.json with findings

### US-004: Evaluate solution options
**Description:** As a developer, I need to consider different fix approaches.

**Acceptance Criteria:**
- [ ] Document at least 2 potential solutions
- [ ] List pros/cons of each approach
- [ ] Recommend best solution with rationale
- [ ] Update notes in prd.json with decision

### US-005: Implement the fix
**Description:** As a developer, I need to fix the bug.

**Acceptance Criteria:**
- [ ] Implement chosen solution
- [ ] Ensure fix doesn't introduce regressions
- [ ] Typecheck passes
- [ ] Tests pass (if applicable)

### US-006: Validate the fix
**Description:** As a developer, I need to confirm the bug is fixed.

**Acceptance Criteria:**
- [ ] Original reproduction steps no longer trigger bug
- [ ] Test edge cases related to the fix
- [ ] Remove or reduce debug logging if added
- [ ] Typecheck passes
- [ ] Verify in browser (if UI-related)

## Hypotheses
Initial theories about what might be causing the issue:
1. Hypothesis A: [theory]
2. Hypothesis B: [theory]

## Related Code
Files/areas likely involved:
- `path/to/file.ts` - reason
- `path/to/other.ts` - reason

## Non-Goals
- What we're NOT trying to fix in this investigation
- Related issues to address separately

## Open Questions
Unknowns that might affect the investigation.
```

---

## Output

1. **Create directory:** `tasks/{effort-name}/` (kebab-case)
2. **For investigations:** Create `tasks/{effort-name}/decisions/` subdirectory
3. **Save PRD:** `tasks/{effort-name}/prd.md`
4. **Initialize progress file:** `tasks/{effort-name}/progress.txt` with header:

```
# Ralph Progress Log
Effort: {effort-name}
Type: {Feature|Bug Investigation|Investigation}
Started: {date}
---

## Codebase Patterns
[Patterns discovered during this effort will be added here]

---
```

---

## Example Feature PRD

```markdown
# PRD: Task Priority System

## Type
Feature

## Introduction

Add priority levels to tasks so users can focus on what matters most. Tasks can be marked as high, medium, or low priority, with visual indicators and filtering to help users manage their workload effectively.

## Goals

- Allow assigning priority (high/medium/low) to any task
- Provide clear visual differentiation between priority levels
- Enable filtering and sorting by priority
- Default new tasks to medium priority

## User Stories

### US-001: Add priority field to database
**Description:** As a developer, I need to store task priority so it persists across sessions.

**Acceptance Criteria:**
- [ ] Add priority column to tasks table: 'high' | 'medium' | 'low' (default 'medium')
- [ ] Generate and run migration successfully
- [ ] Typecheck passes

### US-002: Display priority indicator on task cards
**Description:** As a user, I want to see task priority at a glance so I know what needs attention first.

**Acceptance Criteria:**
- [ ] Each task card shows colored priority badge (red=high, yellow=medium, gray=low)
- [ ] Priority visible without hovering or clicking
- [ ] Typecheck passes
- [ ] Verify in browser

### US-003: Add priority selector to task edit
**Description:** As a user, I want to change a task's priority when editing it.

**Acceptance Criteria:**
- [ ] Priority dropdown in task edit modal
- [ ] Shows current priority as selected
- [ ] Saves immediately on selection change
- [ ] Typecheck passes
- [ ] Verify in browser

### US-004: Filter tasks by priority
**Description:** As a user, I want to filter the task list to see only high-priority items when I'm focused.

**Acceptance Criteria:**
- [ ] Filter dropdown with options: All | High | Medium | Low
- [ ] Filter persists in URL params
- [ ] Empty state message when no tasks match filter
- [ ] Typecheck passes
- [ ] Verify in browser

## Functional Requirements

- FR-1: Add `priority` field to tasks table ('high' | 'medium' | 'low', default 'medium')
- FR-2: Display colored priority badge on each task card
- FR-3: Include priority selector in task edit modal
- FR-4: Add priority filter dropdown to task list header
- FR-5: Sort by priority within each status column (high to medium to low)

## Non-Goals

- No priority-based notifications or reminders
- No automatic priority assignment based on due date
- No priority inheritance for subtasks

## Technical Considerations

- Reuse existing badge component with color variants
- Filter state managed via URL search params
- Priority stored in database, not computed

## Success Metrics

- Users can change priority in under 2 clicks
- High-priority tasks immediately visible at top of lists
- No regression in task list performance

## Open Questions

- Should priority affect task ordering within a column?
- Should we add keyboard shortcuts for priority changes?

## Merge Target

`main` - Merge to main branch when complete.
Auto-merge: No (ask for confirmation first)
```

---

## Checklist

Before saving the PRD:

- [ ] Determined type (Feature, Bug Investigation, or Investigation)
- [ ] Asked clarifying questions with lettered options
- [ ] **For complex tasks:** Offered self-expanding pattern choice
- [ ] Asked about merge target branch
- [ ] Incorporated user's answers
- [ ] Created `tasks/{effort-name}/` directory
- [ ] **For investigations:** Created `tasks/{effort-name}/decisions/` directory
- [ ] User stories are small and specific (completable in one iteration)
- [ ] **For investigations:** Discovery stories have `Can Spawn Stories: Yes`
- [ ] **For investigations:** Decision gates documented where user input may be needed
- [ ] Acceptance criteria are verifiable (not vague)
- [ ] Functional requirements are numbered and unambiguous
- [ ] Non-goals section defines clear boundaries
- [ ] Merge target section specifies destination branch or none
- [ ] Saved PRD to `tasks/{effort-name}/prd.md`
- [ ] Initialized `tasks/{effort-name}/progress.txt`
