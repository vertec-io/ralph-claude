# PRD: Ralph TUI - Interactive Terminal Interface

## Type
Feature

## Introduction

Build a terminal user interface (TUI) application in Rust that provides a rich interactive experience for running Ralph autonomous agent loops. The TUI displays Ralph loop status, statistics, and metrics in one panel while embedding a live Claude Code session in another panel with full pass-through interaction.

This replaces the current tmux-based interactive mode (`-I` flag) with a proper TUI that offers:
- Real-time visibility into Claude Code's output
- Modal interaction with the embedded Claude session
- Dashboard showing iteration progress, token usage, and cost estimates
- Clean separation between Ralph orchestration and Claude execution

## Goals

- Create a Rust TUI application using ratatui for the interface
- Embed Claude Code as a subprocess with proper PTY handling for full terminal pass-through
- Display comprehensive Ralph statistics including token usage and cost estimates
- Implement modal input handling (toggle between Ralph controls and Claude interaction)
- Migrate existing ralph.sh by removing tmux code, keeping the TUI as the interactive option
- Maintain backward compatibility with headless/non-interactive ralph.sh usage

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Ralph TUI                                                          │
├─────────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────┐ ┌─────────────────────────────────────┐ │
│ │   Ralph Status Panel    │ │                                     │ │
│ │                         │ │                                     │ │
│ │ Iteration: 3/10         │ │      Claude Code Session            │ │
│ │ Story: US-004 (4/7)     │ │      (PTY pass-through)             │ │
│ │ Elapsed: 12:34          │ │                                     │ │
│ │ Branch: feature/auth    │ │  [Live terminal output from         │ │
│ │                         │ │   Claude Code displayed here]       │ │
│ │ ── Token Usage ──       │ │                                     │ │
│ │ Input:  45,230          │ │                                     │ │
│ │ Output: 12,450          │ │                                     │ │
│ │ Total:  57,680          │ │                                     │ │
│ │                         │ │                                     │ │
│ │ ── Cost Estimate ──     │ │                                     │ │
│ │ Session: $0.42          │ │                                     │ │
│ │ Total:   $1.87          │ │                                     │ │
│ │                         │ │                                     │ │
│ │ ── Recent Activity ──   │ │                                     │ │
│ │ • Reading prd.json      │ │                                     │ │
│ │ • Editing auth.ts       │ │                                     │ │
│ │ • Running tests...      │ │                                     │ │
│ └─────────────────────────┘ └─────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│ [Tab: Toggle Focus] [i: Enter Claude] [Esc: Exit Claude] [q: Quit] │
└─────────────────────────────────────────────────────────────────────┘
```

## User Stories

### Phase 1: Migration & Cleanup

#### US-001: Split ralph.sh into non-interactive and legacy interactive versions
**Description:** As a developer, I need to separate the clean Ralph loop from the tmux interactive code so we have a clean foundation.

**Acceptance Criteria:**
- [ ] Create `ralph-i.sh` containing the current tmux-based interactive functionality
- [ ] Remove all tmux/interactive code from `ralph.sh` (lines related to `-I` flag, tmux sessions, spinner UI)
- [ ] `ralph.sh` only supports non-interactive mode (remove `-I`/`--interactive` flag)
- [ ] `ralph-i.sh` works exactly as current `ralph.sh -I` does
- [ ] Update usage/help text in both scripts
- [ ] Both scripts tested and functional

### Phase 2: Rust TUI Foundation

#### US-002: Initialize Rust project with ratatui and dependencies
**Description:** As a developer, I need a Rust project structure with the necessary dependencies for building the TUI.

**Acceptance Criteria:**
- [ ] Create `ralph-tui/` directory in project root
- [ ] Initialize Cargo project with appropriate metadata
- [ ] Add dependencies: ratatui, crossterm, portable-pty, tokio, serde, serde_json
- [ ] Create basic main.rs that initializes terminal and shows "Hello Ralph" then exits
- [ ] `cargo build --release` succeeds
- [ ] Binary runs without errors

#### US-003: Implement basic two-panel layout
**Description:** As a user, I want to see a split-screen layout with Ralph status on the left and Claude area on the right.

**Acceptance Criteria:**
- [ ] Left panel (30% width) shows "Ralph Status" header
- [ ] Right panel (70% width) shows "Claude Code" header
- [ ] Bottom bar shows keybinding hints
- [ ] Panels have visible borders
- [ ] Layout resizes correctly when terminal is resized
- [ ] Press 'q' to quit cleanly
- [ ] `cargo build --release` succeeds

#### US-004: Implement PTY subprocess management
**Description:** As a developer, I need to spawn Claude Code in a pseudo-terminal so we can capture and display its full terminal output.

**Acceptance Criteria:**
- [ ] Use portable-pty to create a PTY pair
- [ ] Spawn a simple command (e.g., `bash`) as proof of concept
- [ ] Capture stdout from PTY and store in buffer
- [ ] PTY properly cleaned up on exit
- [ ] Handle PTY resize when terminal resizes
- [ ] `cargo build --release` succeeds

#### US-005: Render PTY output in Claude panel
**Description:** As a user, I want to see the Claude Code terminal output rendered in the right panel.

**Acceptance Criteria:**
- [ ] PTY output displayed in right panel with proper scrolling
- [ ] ANSI escape codes interpreted (colors, cursor movement, clearing)
- [ ] Output updates in real-time as subprocess produces output
- [ ] Panel shows most recent output (auto-scroll to bottom)
- [ ] Handle terminal control sequences properly (cursor positioning, etc.)
- [ ] `cargo build --release` succeeds

### Phase 3: Input Handling & Modal Interaction

#### US-006: Implement modal input system
**Description:** As a user, I want to toggle between controlling Ralph and interacting with Claude Code.

**Acceptance Criteria:**
- [ ] Default mode is "Ralph" mode (focus on left panel)
- [ ] Press 'i' or Tab to enter "Claude" mode (focus on right panel)
- [ ] Press Escape to exit "Claude" mode back to "Ralph" mode
- [ ] Visual indicator shows current mode (highlighted border or mode label)
- [ ] In Claude mode, status bar shows "Press Esc to return to Ralph"
- [ ] `cargo build --release` succeeds

#### US-007: Forward keyboard input to PTY in Claude mode
**Description:** As a user, I want my keystrokes to go to Claude Code when in Claude mode.

**Acceptance Criteria:**
- [ ] All printable characters forwarded to PTY stdin
- [ ] Special keys work: Enter, Backspace, Delete, Arrow keys
- [ ] Ctrl+C sends interrupt signal to PTY (not to TUI)
- [ ] Tab key works within Claude (not captured by TUI when in Claude mode)
- [ ] Escape exits Claude mode (does not forward to PTY)
- [ ] `cargo build --release` succeeds

### Phase 4: Ralph Integration

#### US-008: Parse prd.json and display story progress
**Description:** As a user, I want to see which story Ralph is working on and overall progress.

**Acceptance Criteria:**
- [ ] Accept task directory as CLI argument
- [ ] Read and parse prd.json from task directory
- [ ] Display: description, branch name, total stories, completed stories
- [ ] Show current story being worked on (first with passes: false)
- [ ] Progress updates when prd.json changes on disk (file watch or polling)
- [ ] `cargo build --release` succeeds

#### US-009: Spawn Claude Code with Ralph prompt
**Description:** As a developer, I need to spawn Claude Code with the Ralph agent prompt instead of a test shell.

**Acceptance Criteria:**
- [ ] Construct prompt from task directory, prd path, progress path, and prompt.md
- [ ] Spawn `claude --dangerously-skip-permissions` with prompt piped to stdin
- [ ] Claude Code runs in PTY and output displayed in right panel
- [ ] Handle Claude Code exit (iteration complete)
- [ ] `cargo build --release` succeeds

#### US-010: Implement iteration loop
**Description:** As a user, I want Ralph TUI to automatically start the next iteration when Claude completes.

**Acceptance Criteria:**
- [ ] Accept max iterations as CLI argument (default 10)
- [ ] When Claude process exits, check for completion signal in output
- [ ] If `<promise>COMPLETE</promise>` found, show completion message and exit
- [ ] If not complete and iterations remain, start next iteration automatically
- [ ] Display current iteration number (e.g., "Iteration 3/10")
- [ ] 2-second delay between iterations (matching ralph.sh behavior)
- [ ] `cargo build --release` succeeds

### Phase 5: Statistics & Dashboard

#### US-011: Track and display elapsed time
**Description:** As a user, I want to see how long the current iteration and total session have been running.

**Acceptance Criteria:**
- [ ] Display iteration elapsed time (MM:SS format)
- [ ] Display total session elapsed time
- [ ] Timers update every second
- [ ] Timer resets for each new iteration (iteration timer)
- [ ] `cargo build --release` succeeds

#### US-012: Parse Claude output for token usage
**Description:** As a user, I want to see token usage statistics from Claude Code.

**Acceptance Criteria:**
- [ ] Parse Claude Code output for token usage information
- [ ] Display input tokens, output tokens, total tokens
- [ ] Accumulate totals across iterations
- [ ] Update display in real-time as tokens are reported
- [ ] Handle cases where token info isn't available
- [ ] `cargo build --release` succeeds

#### US-013: Calculate and display cost estimates
**Description:** As a user, I want to see estimated costs based on token usage.

**Acceptance Criteria:**
- [ ] Calculate cost based on Claude Sonnet pricing (or configurable model)
- [ ] Display cost for current iteration
- [ ] Display cumulative cost for session
- [ ] Format as currency (e.g., "$0.42")
- [ ] Cost updates as token usage updates
- [ ] `cargo build --release` succeeds

#### US-014: Show recent activity log
**Description:** As a user, I want to see a summary of recent Claude actions in the status panel.

**Acceptance Criteria:**
- [ ] Parse Claude output for tool calls (Read, Edit, Write, Bash, etc.)
- [ ] Display last 5-10 actions in status panel
- [ ] Show action type and brief context (e.g., "Reading src/auth.ts")
- [ ] New actions push old ones up (scrolling log)
- [ ] Actions timestamped or in order
- [ ] `cargo build --release` succeeds

### Phase 6: Polish & Error Handling

#### US-015: Handle progress.txt rotation
**Description:** As a user, I want the TUI to handle progress file rotation like ralph.sh does.

**Acceptance Criteria:**
- [ ] Check progress.txt line count before each iteration
- [ ] If over threshold (configurable, default 300), perform rotation
- [ ] Create progress-N.txt with old content
- [ ] Create new progress.txt with summary header
- [ ] Support --rotate-at CLI argument
- [ ] `cargo build --release` succeeds

#### US-016: Graceful error handling and cleanup
**Description:** As a user, I want the TUI to handle errors gracefully and always restore my terminal.

**Acceptance Criteria:**
- [ ] Catch panics and restore terminal before showing error
- [ ] Handle Ctrl+C gracefully (cleanup PTY, restore terminal)
- [ ] Handle Claude process crashes (show error, allow retry or quit)
- [ ] Handle file read errors (prd.json missing, etc.) with clear messages
- [ ] Terminal always restored to normal state on exit
- [ ] `cargo build --release` succeeds

#### US-017: Add CLI argument parsing
**Description:** As a user, I want to configure the TUI via command line arguments.

**Acceptance Criteria:**
- [ ] Parse task directory argument (required, or prompt if missing)
- [ ] `--iterations` / `-i` for max iterations (default 10)
- [ ] `--rotate-at` for progress rotation threshold (default 300)
- [ ] `--help` shows usage information
- [ ] `--version` shows version
- [ ] Invalid arguments show helpful error messages
- [ ] `cargo build --release` succeeds

#### US-018: Create installation and build instructions
**Description:** As a user, I want clear instructions for building and using the TUI.

**Acceptance Criteria:**
- [ ] Add build instructions to README.md
- [ ] Document all CLI arguments
- [ ] Provide example usage commands
- [ ] Note Rust toolchain requirements
- [ ] Add to project's existing documentation structure

## Functional Requirements

- FR-1: The TUI shall display a split-panel layout with Ralph status (30%) and Claude session (70%)
- FR-2: The TUI shall spawn Claude Code in a pseudo-terminal for full terminal emulation
- FR-3: The TUI shall support modal input: Ralph mode (default) and Claude mode (interactive)
- FR-4: The TUI shall parse and display prd.json data including story progress
- FR-5: The TUI shall automatically run multiple iterations until completion or max reached
- FR-6: The TUI shall track and display token usage from Claude Code output
- FR-7: The TUI shall calculate cost estimates based on token usage
- FR-8: The TUI shall display recent tool/action activity parsed from Claude output
- FR-9: The TUI shall handle progress.txt rotation when file exceeds threshold
- FR-10: The TUI shall always restore terminal state on exit, including after errors
- FR-11: The TUI shall accept configuration via CLI arguments

## Non-Goals

- Multiple concurrent Claude sessions (single session only)
- Persistent session history or logging beyond progress.txt
- Remote/networked operation
- Custom theming or color configuration (use sensible defaults)
- Integration with other AI models (Claude Code only)
- GUI version (terminal only)

## Technical Considerations

### Dependencies
- **ratatui**: TUI framework (maintained fork of tui-rs)
- **crossterm**: Cross-platform terminal manipulation
- **portable-pty**: Cross-platform PTY handling
- **tokio**: Async runtime for handling PTY I/O and timers
- **serde/serde_json**: JSON parsing for prd.json
- **clap**: CLI argument parsing
- **notify** (optional): File watching for prd.json updates

### PTY Handling
The key technical challenge is properly embedding Claude Code's TUI within our TUI. This requires:
1. Creating a PTY pair (master/slave)
2. Spawning Claude Code attached to the slave
3. Reading from master and interpreting terminal escape sequences
4. Writing user input to master
5. Handling terminal resize (SIGWINCH equivalent)

Consider using a terminal emulator library like `vt100` or `alacritty_terminal` to properly interpret escape sequences.

### Parsing Claude Output
Claude Code outputs status information that we can parse:
- Tool calls appear with specific patterns
- Token usage may be in verbose output or stream-json format
- Need to handle both visual output (for display) and structured data (for stats)

### File Structure
```
ralph-tui/
├── Cargo.toml
├── src/
│   ├── main.rs           # Entry point, CLI parsing
│   ├── app.rs            # Application state
│   ├── ui.rs             # UI layout and rendering
│   ├── pty.rs            # PTY management
│   ├── ralph.rs          # Ralph loop logic, prd parsing
│   ├── stats.rs          # Token/cost tracking
│   └── input.rs          # Input handling, modal system
```

## Success Metrics

- TUI launches and displays correctly on Linux (primary) and macOS
- Claude Code session is fully interactive (can send messages, see output)
- Token usage and costs displayed accurately
- Iteration loop works correctly (auto-advance, completion detection)
- Terminal always restored cleanly on exit
- Performance: <50ms input latency, smooth scrolling

## Open Questions

1. Should we support Windows? (PTY handling is more complex there)
2. Should token/cost data persist between TUI sessions?
3. Should we add a "pause" feature to stop iteration auto-advance?
4. How should we handle Claude Code's own Ctrl+C behavior vs TUI quit?
5. Should the left panel be collapsible to give Claude more space?
