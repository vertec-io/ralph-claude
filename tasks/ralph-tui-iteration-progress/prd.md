# PRD: Ralph TUI Iteration & Progress Improvements

## Type
Feature

## Introduction

The ralph-tui application currently has two significant issues:

1. **Iteration restart not working**: When Claude finishes responding, it waits for more input instead of exiting. This is because ralph-tui runs Claude interactively (to preserve the embedded TUI experience), but unlike ralph.sh which uses `--print` mode, the interactive Claude doesn't auto-exit. The existing iteration restart logic never triggers because it depends on the child process exiting.

2. **Progress tracking is misleading**: Progress is calculated as `current_iteration / max_iterations`, showing 10% on iteration 1 of 10 regardless of actual story completion. Users want per-story progress based on acceptance criteria completion.

This PRD addresses both issues while adding a versioning system to support schema evolution and smooth upgrades for existing users.

## Goals

- Fix iteration auto-restart by detecting Claude idle state and triggering exit
- Add visual countdown indicator before restart so users understand what's happening
- Implement per-criteria progress tracking for accurate story progress display
- Add versioning system for prd.json schema and skills
- Update install.sh to detect version mismatches and prompt for upgrades
- Maintain backwards compatibility with existing prd.json files

## User Stories

### US-001: Track time since last PTY output
**Description:** As ralph-tui, I need to track when Claude last produced output so I can detect idle state.

**Acceptance Criteria:**
- [ ] Add `last_output_time: Instant` field to track last PTY output
- [ ] Update timestamp whenever new output is received from PTY reader thread
- [ ] Use thread-safe mechanism (Arc<Mutex> or AtomicU64 for timestamp)
- [ ] Typecheck passes

### US-002: Implement idle detection with configurable timeout
**Description:** As a user, I want ralph-tui to detect when Claude is idle so iterations can auto-restart.

**Acceptance Criteria:**
- [ ] Add `--idle-timeout <seconds>` CLI flag (default: 10 seconds)
- [ ] Detect idle state when no output for `idle_timeout` seconds AND some activity has occurred
- [ ] Don't trigger idle detection during initial startup (wait for first output)
- [ ] Store idle_timeout in App struct
- [ ] Typecheck passes

### US-003: Implement auto-exit on idle detection
**Description:** As ralph-tui, I need to gracefully exit Claude when idle is detected so iteration restart triggers.

**Acceptance Criteria:**
- [ ] When idle detected, send `/exit\n` to PTY
- [ ] Wait up to 2 seconds for Claude to exit
- [ ] If no exit after 2 seconds, send Ctrl+D (EOF)
- [ ] Wait another 2 seconds, then force-set child_exited if still running
- [ ] Existing iteration restart logic should then take over
- [ ] Typecheck passes

### US-004: Add visual countdown before restart
**Description:** As a user, I want to see a countdown when Claude is idle so I understand what's happening.

**Acceptance Criteria:**
- [ ] Display "Claude idle - restarting in Xs..." in the UI when idle detected
- [ ] Countdown from idle_timeout to 0
- [ ] Show in footer or status area with distinct styling
- [ ] Allow user to interrupt (press any key to cancel restart and continue interacting)
- [ ] Typecheck passes

### US-005: Add version field to prd.json schema
**Description:** As a developer, I need prd.json to have a version field so tools can detect schema compatibility.

**Acceptance Criteria:**
- [ ] Add `"schemaVersion": "1.0"` field to prd.json schema
- [ ] Current format (acceptanceCriteria as string[]) is version "1.0"
- [ ] New format (acceptanceCriteria as object[]) will be version "2.0"
- [ ] Update prd.json.example with schemaVersion field
- [ ] Typecheck passes

### US-006: Add version to ralph skill
**Description:** As a developer, I need the /ralph skill to have a version so install.sh can detect updates.

**Acceptance Criteria:**
- [ ] Add version field to SKILL.md frontmatter: `version: "1.0"`
- [ ] Document versioning scheme in skill header
- [ ] Update skills/ralph/SKILL.md
- [ ] Also update skills/prd/SKILL.md with version field

### US-007: Update install.sh to detect skill versions
**Description:** As a user, I want install.sh to detect when my installed skills are outdated.

**Acceptance Criteria:**
- [ ] Parse version from installed skill's SKILL.md frontmatter
- [ ] Parse version from repo's skill SKILL.md
- [ ] Compare versions and detect if upgrade available
- [ ] Works for both /prd and /ralph skills

### US-008: Add upgrade prompts to install.sh
**Description:** As a user, I want install.sh to ask me before overwriting my existing skills.

**Acceptance Criteria:**
- [ ] If installed skill version < repo version, prompt: "Skill X has update (v1.0 → v2.0). Upgrade? [y/N]"
- [ ] Show what changed (if possible, or just version numbers)
- [ ] Backup old skill before overwriting: `skill.backup-{date}`
- [ ] If versions match, skip with message "Skill X is up to date (v1.0)"
- [ ] Add `--force` flag to skip prompts and always upgrade

### US-009: Update prd.json schema for per-criteria tracking
**Description:** As a developer, I need acceptanceCriteria to track individual completion status.

**Acceptance Criteria:**
- [ ] Change schema from `acceptanceCriteria: string[]` to `acceptanceCriteria: {description: string, passes: boolean}[]`
- [ ] Set schemaVersion to "2.0" for this format
- [ ] Update prd.json.example with new format
- [ ] All criteria default to `passes: false`

### US-010: Update /ralph skill for new schema
**Description:** As a user of /ralph, I need it to generate prd.json with the new per-criteria format.

**Acceptance Criteria:**
- [ ] Update skills/ralph/SKILL.md output format documentation
- [ ] Update all examples to use new acceptanceCriteria format
- [ ] Set skill version to "2.0"
- [ ] Generated prd.json files use schemaVersion "2.0"

### US-011: Update prompt.md for per-criteria tracking
**Description:** As Ralph, I need instructions on how to mark individual acceptance criteria as passing.

**Acceptance Criteria:**
- [ ] Add section explaining per-criteria tracking
- [ ] Instruct Ralph to set `passes: true` on individual criteria as they're verified
- [ ] Story is complete when ALL criteria have `passes: true`
- [ ] Update the "Update PRD" step to include criteria updates
- [ ] Typecheck passes (for any code changes)

### US-012: Update ralph-tui parsing for new schema
**Description:** As ralph-tui, I need to parse both old and new prd.json formats.

**Acceptance Criteria:**
- [ ] Update UserStory struct to support new AcceptanceCriterion type
- [ ] Add AcceptanceCriterion struct: `{description: String, passes: bool}`
- [ ] Detect schemaVersion and parse accordingly
- [ ] For v1.0 (string[]), convert to objects with `passes: false`
- [ ] Typecheck passes

### US-013: Display per-criteria progress in TUI
**Description:** As a user, I want to see progress based on acceptance criteria completion.

**Acceptance Criteria:**
- [ ] Calculate story progress as: `criteria_passed / total_criteria * 100`
- [ ] Display progress bar for each story in story list
- [ ] Show "2/5 criteria" or similar text alongside progress bar
- [ ] In story details view, show checkmarks next to passing criteria
- [ ] Typecheck passes

### US-014: Update install.sh for prompt.md versioning
**Description:** As a user, I want install.sh to handle prompt.md upgrades too.

**Acceptance Criteria:**
- [ ] Add version comment at top of prompt.md: `<!-- version: 2.0 -->`
- [ ] Parse version from installed and repo prompt.md
- [ ] Prompt for upgrade if version mismatch
- [ ] Backup old prompt.md before overwriting

## Functional Requirements

- FR-1: Idle detection triggers after configurable timeout (default 10s) with no PTY output
- FR-2: Auto-exit sequence: `/exit` → wait 2s → Ctrl+D → wait 2s → force exit
- FR-3: Visual countdown in UI during idle detection phase
- FR-4: User can cancel idle restart by pressing any key
- FR-5: prd.json schemaVersion field identifies format version
- FR-6: install.sh compares versions and prompts for upgrades
- FR-7: Backups created before overwriting skills or config
- FR-8: ralph-tui supports both v1.0 and v2.0 prd.json formats
- FR-9: Progress calculated from acceptance criteria, not iterations
- FR-10: Story details view shows individual criteria status

## Non-Goals

- No automatic migration of existing prd.json files (user must regenerate or manually update)
- No progress.txt schema changes
- No changes to how Ralph commits or reports progress
- No web UI or remote monitoring

## Technical Considerations

- Thread-safe timestamp tracking for idle detection (PTY reader is on separate thread)
- Serde `#[serde(untagged)]` or custom deserializer for supporting both schema versions
- Version parsing with semver-like comparison (or simple string compare for now)
- Backup naming: `{filename}.backup-{YYYYMMDD-HHMMSS}`

## Success Metrics

- Iterations auto-restart within 15 seconds of Claude finishing
- Progress bar accurately reflects criteria completion (not iterations)
- Users with existing installs can upgrade smoothly via install.sh
- No breaking changes for users with v1.0 prd.json files

## Open Questions

- Should we support automatic prd.json migration (v1 → v2)?
- What's the right default idle timeout? 10s feels safe but may be slow.
- Should criteria progress be persisted even if story isn't complete? (current plan: yes, via prd.json updates)
