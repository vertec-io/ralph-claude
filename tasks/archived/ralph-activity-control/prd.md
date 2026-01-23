# PRD: Ralph Activity Visibility and Interactive Control

## Type
Feature

## Introduction

Enhance Ralph (the autonomous loop) and ralph-tui with complete activity visibility, interactive control capabilities, and proper permission configuration for unattended operation. Currently, users have limited visibility into what the agent is doing during execution, no way to interrupt or inject guidance mid-iteration, and opencode may get stuck waiting for permission prompts.

This feature addresses three core problems:
1. **Visibility**: Can't see the full history of agent actions (only last 10 activities)
2. **Control**: Can't pause, inject prompts, or modify the PRD mid-run
3. **Permissions**: opencode prompts for permissions in non-interactive mode, causing stuck sessions

## Goals

- Provide complete activity history in ralph-tui (scrollable, searchable)
- Allow users to interrupt iterations and inject prompts to the agent
- Allow users to modify prd.json notes mid-run without stopping
- Support switching to full interactive mode mid-iteration
- Add `--yolo` flag to ralph.sh that enables opencode's permissive mode
- Ensure ralph can run fully unattended without permission prompts blocking

## User Stories

### US-001: Add --yolo flag to ralph.sh for permissive mode
**Description:** As a user, I want to run Ralph with a `--yolo` flag so that opencode runs with all permissions allowed and never prompts for approval.

**Acceptance Criteria:**
- [ ] ralph.sh accepts `--yolo` flag (e.g., `./ralph.sh tasks/foo --yolo`)
- [ ] When `--yolo` is set, export `YOLO_MODE=true` environment variable
- [ ] Update `agents/opencode.sh` to check `YOLO_MODE` and set `OPENCODE_PERMISSION` env var with permissive JSON
- [ ] Document the flag in ralph.sh help text
- [ ] Flag is passed through to tmux session environment
- [ ] Typecheck passes (for any Rust changes)

### US-002: Pass yolo mode through ralph-tui
**Description:** As a user, I want ralph-tui to respect and propagate the yolo mode setting when spawning opencode.

**Acceptance Criteria:**
- [ ] ralph-tui accepts `--yolo` flag
- [ ] When spawning opencode, adds permission flag if yolo mode enabled
- [ ] Display indicator in TUI header when running in yolo mode (e.g., "[YOLO]")
- [ ] Typecheck passes

### US-003: Scrollable activity history panel
**Description:** As a user, I want to see the complete activity history in ralph-tui, not just the last 10 actions, so I can debug issues and understand what the agent has done.

**Acceptance Criteria:**
- [ ] Activity panel shows full history (up to reasonable limit, e.g., 1000 activities)
- [ ] Can scroll through activities with j/k or arrow keys when panel is focused
- [ ] Shows timestamp for each activity
- [ ] Activity list auto-scrolls to bottom on new activities (unless user has scrolled up)
- [ ] Typecheck passes

### US-004: Activity detail view
**Description:** As a user, I want to see details about a specific activity, including any output or errors.

**Acceptance Criteria:**
- [ ] Pressing Enter on an activity shows expanded detail view
- [ ] Detail view shows: action type, target, timestamp, duration (if available)
- [ ] For bash commands: shows command output (truncated if long)
- [ ] For file operations: shows file path and operation result
- [ ] Esc returns to activity list
- [ ] Typecheck passes

### US-005: Pause iteration and inject prompt
**Description:** As a user, I want to pause the current iteration and send a message to the agent so I can provide guidance or corrections without stopping the entire Ralph loop.

**Acceptance Criteria:**
- [ ] Keybind (e.g., `Ctrl+P`) pauses the agent and opens a prompt input modal
- [ ] User can type a message to inject
- [ ] Message is sent to the agent's stdin as if the user typed it
- [ ] Agent continues after receiving the message
- [ ] Display "PAUSED" indicator while input modal is open
- [ ] Typecheck passes

### US-006: Switch to interactive mode
**Description:** As a user, I want to switch to full interactive mode mid-iteration so I can directly interact with the agent when needed.

**Acceptance Criteria:**
- [ ] Keybind (e.g., `Ctrl+I`) switches to interactive mode
- [ ] In interactive mode, all keyboard input goes to the agent
- [ ] Clear visual indicator showing "INTERACTIVE MODE"
- [ ] Keybind to return to monitoring mode (e.g., `Esc`)
- [ ] Typecheck passes

### US-007: Edit PRD notes mid-run
**Description:** As a user, I want to add notes to the current story in prd.json without stopping Ralph, so the next iteration sees my guidance.

**Acceptance Criteria:**
- [ ] Keybind (e.g., `n`) opens a notes editor for the current in-progress story
- [ ] Notes are saved to the story's `notes` field in prd.json
- [ ] Existing notes are preserved and new notes appended
- [ ] Agent sees updated notes on next iteration (no restart needed)
- [ ] Display confirmation when notes are saved
- [ ] Typecheck passes

### US-008: Activity search/filter
**Description:** As a user, I want to search through activities to find specific actions.

**Acceptance Criteria:**
- [ ] Keybind (e.g., `/`) opens search input
- [ ] Filter activities by search term (matches action type or target)
- [ ] Highlight matching activities
- [ ] n/N to jump to next/previous match
- [ ] Clear filter with Esc
- [ ] Typecheck passes

### US-009: Attach mode improvements
**Description:** As a user running `ralph-tui --attach`, I want the same activity visibility and control features available.

**Acceptance Criteria:**
- [ ] Attach mode parses activities from tmux capture output
- [ ] Activity history panel works in attach mode
- [ ] Inject prompt works by sending to tmux session
- [ ] Interactive mode works by attaching to tmux
- [ ] Typecheck passes

## Functional Requirements

- FR-1: ralph.sh shall accept `--yolo` flag that enables permissive mode for opencode
- FR-2: When `--yolo` is enabled, opencode shall run with `"permission": "allow"` equivalent
- FR-3: ralph-tui shall maintain activity history up to 1000 entries in memory
- FR-4: ralph-tui shall support scrolling through activity history
- FR-5: ralph-tui shall allow pausing iteration and injecting text to agent stdin
- FR-6: ralph-tui shall allow switching between monitor and interactive modes
- FR-7: ralph-tui shall allow editing story notes in prd.json without restart
- FR-8: ralph-tui shall support searching/filtering activity history
- FR-9: All features shall work in both normal mode and attach mode

## Non-Goals

- Persistent activity logging to files (keep in-memory only per user preference)
- Automatic detection of stuck permission prompts
- Multi-session management (showing all running Ralph loops)
- Undo/rollback of agent actions
- Activity replay functionality

## Technical Considerations

### opencode Permission Configuration

Based on [opencode docs](https://opencode.ai/docs/cli/), opencode supports runtime permission overrides via environment variable:

```bash
OPENCODE_PERMISSION='{"*": "allow", "external_directory": "allow", "doom_loop": "allow"}'
```

**Implementation approach:**
1. In `agents/opencode.sh`, when `SKIP_PERMISSIONS=true` (already exported by ralph.sh), set `OPENCODE_PERMISSION` env var
2. The permission JSON should allow all operations: `{"*": "allow", "external_directory": "allow", "doom_loop": "allow"}`
3. This overrides the defaults without needing config file changes

**Key permissions to allow:**
- `*` - All standard tool operations (read, edit, bash, etc.)
- `external_directory` - Operations outside project dir (e.g., `/tmp/*` for playwright screenshots)
- `doom_loop` - Repeated identical tool calls (can happen legitimately)

The existing `SKIP_PERMISSIONS=true` export in ralph.sh (line 833) is already in place but not used by opencode.sh.

### Activity Parsing

Current parsing in ralph-tui (lines 217-308) detects patterns like:
- `reading /path/to/file`
- `editing /path/to/file`
- `bash(...)`
- Tool call formats from Claude output

May need to enhance parsing to capture:
- Timestamps (from terminal output or inferred)
- Duration (track time between activities)
- Outcomes (success/failure indicators)

### Input Injection

Current PTY input forwarding (lines 1130-1219) already handles sending keystrokes. For prompt injection:
1. Pause by not forwarding agent output (buffer it)
2. Show user input modal
3. Send user text to PTY stdin
4. Resume output forwarding

### Attach Mode Considerations

Attach mode uses `tmux capture-pane` for output. For injection:
- Use `tmux send-keys -t <session>` to inject text
- For interactive mode, use `tmux attach -t <session>` in a subprocess

## Design Considerations

### Keybindings (proposed)

| Key | Action | Mode |
|-----|--------|------|
| `j/k` | Scroll activity list | Ralph mode |
| `Enter` | View activity details | Activity list focused |
| `Ctrl+P` | Pause and inject prompt | Any mode |
| `Ctrl+I` | Switch to interactive mode | Ralph mode |
| `Esc` | Exit interactive/detail view | Interactive/Detail mode |
| `n` | Edit story notes | Ralph mode |
| `/` | Search activities | Ralph mode |
| `n/N` | Next/prev search match | Search active |

### Visual Indicators

- `[YOLO]` in header when running permissive mode
- `[PAUSED]` when injection modal is open
- `[INTERACTIVE]` when in interactive mode
- Activity timestamps in relative format (e.g., "2m ago")

## Success Metrics

- Can run Ralph for 20+ iterations without permission prompts blocking
- Can view complete activity history for any iteration
- Can successfully inject a prompt and see agent respond
- Can edit notes mid-run and verify agent sees them in next iteration

## Open Questions

1. ~~Does opencode have a CLI flag for permissive mode?~~ **RESOLVED**: Use `OPENCODE_PERMISSION` env var
2. Should we show a warning when enabling yolo mode about the risks?
3. What's the best UX for the prompt injection modal? Full-screen or overlay?
4. Should activity search be fuzzy or exact match?

## Merge Target

None - Leave as standalone branch
