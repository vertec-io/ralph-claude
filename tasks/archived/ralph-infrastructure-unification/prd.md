# PRD: Ralph Infrastructure Unification

## Type
Feature

## Introduction

Ralph's core loop (`ralph.sh`) is a 1,400+ line bash script that has grown organically to include tmux session management, SQLite tracking, multi-agent failover, and progress rotation. The TUI (`ralph-tui`) is a separate Rust binary that can either run standalone or attach to a ralph.sh tmux session. This effort unifies the architecture by:

1. Rewriting the ralph loop as a Python package, installable via `uv tool install` as the `ralph-uv` command
2. Making ralph-tui purely a visualizer/controller (no longer spawning agents itself)
3. Adding proper branch management configurable per-task at launch time
4. Integrating opencode stop-hook detection via an opencode plugin
5. Adding a full wizard in ralph-tui for starting new loops

The result is a clean separation: `ralph-uv` (Python) owns the loop lifecycle, `ralph-tui` visualizes and controls running loops, and `ralph-uv attach` is a single-loop view. The existing `ralph.sh` remains unchanged and in active use during development.

## Goals

- Create a Python package installable as `ralph-uv` via `uv tool install` (coexists with existing `ralph.sh`)
- Unify ralph-tui to be a pure visualizer/controller that communicates with the ralph-uv loop process
- Allow ralph-tui to start new loops via a full wizard (task, branch, iterations, agent)
- Make `ralph-uv attach` a single-loop equivalent of ralph-tui
- Add configurable branch management (base branch + end-of-loop behavior) specified at launch
- Support opencode as an agent via a stop-hook plugin that signals iteration completion
- Maintain backward compatibility with existing prd.json schema and task directory structure

## User Stories

### US-001: Python Package Scaffold
**Description:** As a developer, I want the ralph Python package scaffolded with pyproject.toml and uv tool configuration so that the project can be installed as a CLI tool.

**Acceptance Criteria:**
- [ ] Create `pyproject.toml` with `[project.scripts]` entry for `ralph-uv` CLI
- [ ] Python 3.12+ requirement specified
- [ ] `uv tool install .` works and provides the `ralph-uv` command (do NOT install globally during development — use `uv run ralph-uv` instead)
- [ ] Basic CLI entrypoint prints version and help
- [ ] Project uses `src/ralph_uv/` layout

### US-002: Core Loop Logic in Python
**Description:** As a developer, I want the core iteration loop ported from bash to Python so it's maintainable and testable.

**Acceptance Criteria:**
- [ ] Iteration loop spawns agent subprocess, waits for completion, checks results
- [ ] Supports max iteration count (configurable, default 50)
- [ ] Detects `<promise>COMPLETE</promise>` in agent output to stop loop
- [ ] Progress.txt rotation logic works (threshold configurable, default 300 lines)
- [ ] Consecutive failure tracking per agent works
- [ ] Graceful shutdown on SIGINT/SIGTERM

### US-003: Agent Abstraction Layer
**Description:** As a developer, I want a pluggable agent interface so ralph can run different coding agents (claude code, opencode) with agent-specific completion detection.

**Acceptance Criteria:**
- [ ] Abstract `Agent` base class with `start()`, `is_done()`, `get_output()` methods
- [ ] `ClaudeAgent` implementation using `claude --print --output-format stream-json` (or equivalent current invocation)
- [ ] `OpencodeAgent` implementation (placeholder, full implementation in US-008)
- [ ] Agent selection configurable per-task in prd.json and overridable at launch
- [ ] Failover logic: switch agents after N consecutive failures (configurable threshold)

### US-004: Branch Management
**Description:** As a user, I want to specify what branch ralph starts from and what happens at the end of the loop so I have control over git workflow.

**Acceptance Criteria:**
- [ ] `ralph-uv run --base-branch <branch>` flag to specify starting branch
- [ ] If no base-branch specified, use current branch
- [ ] Ralph creates/checks out the task branch (from prd.json `branchName`) based off the specified base
- [ ] At loop completion: behavior controlled by prd.json `mergeTarget` and `autoMerge` fields
- [ ] If `autoMerge: true` and `mergeTarget` set, ralph creates PR and merges automatically
- [ ] If `autoMerge: false` and `mergeTarget` set, ralph creates PR but does not merge
- [ ] If no `mergeTarget`, loop just stops (branch left as-is)
- [ ] Branch state validated before starting (clean working tree required)

### US-005: Session Management (tmux + SQLite)
**Description:** As a user, I want ralph sessions to run in tmux with SQLite tracking so I can manage multiple concurrent loops.

**Acceptance Criteria:**
- [ ] Ralph runs agent in a tmux session (one per task)
- [ ] SQLite registry at `~/.local/share/ralph/sessions.db` tracks running sessions
- [ ] `ralph-uv status` lists all running sessions (with `--json` flag for machine-readable output)
- [ ] `ralph-uv stop <task>` sends graceful shutdown signal
- [ ] `ralph-uv checkpoint <task>` saves state and pauses
- [ ] Session cleanup on normal completion or crash

### US-006: Prompt Preprocessing
**Description:** As a developer, I want the prompt.md template system ported to Python so agents receive properly formatted instructions.

**Acceptance Criteria:**
- [ ] Loads prompt.md from task dir, then `~/.config/ralph/prompt.md`, then bundled default
- [ ] Preprocesses template with task context (prd.json path, progress.txt path, branch info)
- [ ] Injects AGENTS.md content if present
- [ ] Passes final prompt to agent subprocess
- [ ] Supports the existing `{VARIABLE}` substitution pattern

### US-007: TUI Communication Protocol (JSON-RPC over Unix Socket)
**Description:** As a developer, I want a JSON-RPC communication protocol between ralph (Python) and ralph-tui (Rust) so the TUI can observe and control running loops.

**Acceptance Criteria:**
- [ ] Ralph exposes a JSON-RPC server on a Unix domain socket per session (`~/.local/share/ralph/sockets/<task>.sock`)
- [ ] State queries: `get_status` returns current iteration, story, agent, interactive_mode flag, recent output
- [ ] Control commands: `start`, `stop`, `checkpoint`, `inject_prompt`, `set_interactive_mode`
- [ ] Event subscription: TUI can subscribe to real-time output stream and state changes
- [ ] Protocol documented in `docs/protocol.md`
- [ ] ralph-tui can still read prd.json and progress.txt directly for supplemental status

### US-008: Opencode Stop-Hook Plugin
**Description:** As a developer, I want an opencode plugin that signals when opencode completes an iteration so ralph can detect completion without polling.

**Acceptance Criteria:**
- [ ] Opencode plugin written in TypeScript per opencode plugin API
- [ ] Plugin listens for `session.idle` event (fires when opencode finishes processing)
- [ ] Plugin reads `RALPH_SIGNAL_FILE` env var to discover where to write the signal
- [ ] Signal is a JSON file write: `{"event": "idle", "timestamp": "<iso>", "session_id": "<id>"}`
- [ ] Ralph's `OpencodeAgent` watches the signal file (inotify on Linux) for changes
- [ ] Completion only honored when `interactive_mode` is false (see US-012)
- [ ] Plugin loaded via `.opencode/plugins/` directory (ralph copies it into the task's working directory before spawning opencode)
- [ ] Fallback: plugin can also be installed globally at `~/.config/opencode/plugins/`
- [ ] Document plugin mechanism in README

### US-009: TUI Loop Start Wizard
**Description:** As a user, I want a full wizard in ralph-tui to start new loops so I don't need to use the CLI separately.

**Acceptance Criteria:**
- [ ] Wizard accessible via hotkey in ralph-tui
- [ ] Step 1: Select task directory (list available tasks/ subdirectories)
- [ ] Step 2: Configure base branch (default: current branch, option to type another)
- [ ] Step 3: Set max iterations (default: 50, editable)
- [ ] Step 4: Select agent (claude/opencode, default from prd.json or claude)
- [ ] Step 5: Confirm and launch
- [ ] Wizard sends start command to ralph-uv via the communication protocol (US-007)
- [ ] New loop appears in TUI session list immediately

### US-010: Ralph Attach (Single-Loop View)
**Description:** As a user, I want `ralph-uv attach <task>` to show a single-loop view similar to ralph-tui but focused on one session, with full agent interaction support.

**Acceptance Criteria:**
- [ ] `ralph-uv attach <task>` opens a terminal UI showing one running loop
- [ ] Shows: current iteration, story progress, live agent output
- [ ] Supports interactive mode toggle (hotkey `i`) for direct agent interaction
- [ ] In interactive mode: PTY input forwarded to agent, completion detection suppressed
- [ ] Exiting interactive mode (hotkey `i` again or `Esc`) re-enables autonomous monitoring
- [ ] Supports stop/checkpoint commands
- [ ] Exits cleanly when loop completes or user presses quit key
- [ ] Communicates with ralph-uv loop via JSON-RPC protocol from US-007
- [ ] Part of the Python package (not a separate binary)

### US-012: Interactive Agent Control Mode
**Description:** As a user, I want to pause the autonomous loop, interact directly with the agent (claude or opencode), and resume autonomous operation without triggering a false iteration completion.

**Acceptance Criteria:**
- [ ] `interactive_mode` boolean tracked in session state, exposed via JSON-RPC
- [ ] Toggling interactive mode ON: sends agent's pause key (Esc) through PTY, suppresses completion detection
- [ ] While interactive: user keystrokes forwarded directly to agent PTY
- [ ] Toggling interactive mode OFF: re-enables completion detection (agent continues from wherever user left it)
- [ ] Claude Code: interrupt via Esc, user types input, agent processes and continues
- [ ] Opencode: pause via Esc, user types input, agent processes and continues
- [ ] Signal file writes during interactive mode are queued/ignored until mode exits
- [ ] Output parsing for `<promise>COMPLETE</promise>` suppressed during interactive mode
- [ ] Both ralph-tui and ralph-uv attach support this toggle with the same hotkey (`i`)
- [ ] Visual indicator in UI shows current mode (autonomous vs interactive)

## Functional Requirements

- FR-1: `ralph-uv run <task-dir>` starts the loop for a task directory (always in tmux)
- FR-2: `ralph-uv run --base-branch <branch>` specifies the git branch to start from
- FR-3: `ralph-uv run --max-iterations <N>` overrides default iteration limit
- FR-4: `ralph-uv run --agent <claude|opencode>` overrides the agent selection
- FR-5: `ralph-uv status [--json]` lists all running ralph-uv sessions
- FR-6: `ralph-uv stop <task>` gracefully stops a running loop
- FR-7: `ralph-uv checkpoint <task>` pauses with state save
- FR-8: `ralph-uv attach <task>` opens single-loop terminal view (part of Python package)
- FR-9: The Python package is installable via `uv tool install .` providing the `ralph-uv` command
- FR-10: Agent failover switches to alternate agent after N consecutive failures
- FR-11: Branch management creates task branch from specified base, handles PR creation on completion
- FR-12: Opencode plugin signals completion via `session.idle` event writing to `RALPH_SIGNAL_FILE`
- FR-13: ralph-tui wizard allows starting new loops with full configuration
- FR-14: Communication protocol uses JSON-RPC over Unix domain sockets (`~/.local/share/ralph/sockets/<task>.sock`)
- FR-15: Interactive mode toggle (`i` key) allows direct agent interaction in TUI/attach
- FR-16: Completion detection suppressed while interactive mode is active
- FR-17: ralph-uv always runs inside tmux (no non-tmux mode)

## Non-Goals

- No web UI or dashboard (terminal only)
- No remote execution support in this effort (separate task exists)
- No changes to prd.json schema (both v1.0 and v2.0 remain supported)
- No changes to prompt.md template format
- No rewrite of ralph-tui in Python (stays Rust)
- No changes to the flowchart visualization app
- No container/Docker support in this effort
- ralph-tui does NOT start loops via CLI invocation -- only through its internal wizard/JSON-RPC
- No non-tmux execution mode (ralph-uv always uses tmux)
- No modifications to ralph.sh (it remains in active use as-is)

## Technical Considerations

- Python 3.12+ required
- Use `uv` for package management and tool installation
- The Python package should use `click` or `typer` for CLI argument parsing
- Agent subprocesses should use `asyncio` for non-blocking I/O
- IPC protocol: JSON-RPC over Unix domain sockets (one socket per session at `~/.local/share/ralph/sockets/<task>.sock`)
- SQLite registry format does NOT need to stay compatible with existing ralph-tui Rust code -- this is an extensive rewrite, prioritize clean design. Ralph-tui will be updated to use whatever schema the Python version produces.
- tmux session naming convention must remain compatible
- ralph-uv always runs inside tmux (no non-tmux mode)
- Opencode plugin API docs: https://opencode.ai/docs/plugins/
- Opencode plugin discovers its signal path via the `RALPH_SIGNAL_FILE` environment variable, which ralph-uv sets before spawning the opencode process. The plugin writes a JSON payload to this file on `session.idle` events. ralph-uv watches this file with inotify/polling.
- `ralph-uv attach` is part of the Python package (lightweight single-loop view for quick checks). ralph-tui is the full multi-session dashboard.
- During development, use `uv run ralph-uv` to test — do NOT install globally with `uv tool install` since the old `ralph` tool is still in use.

### Interactive Agent Control in TUI/Attach

Both claude code and opencode must be interactable inside ralph-tui and ralph-uv attach. The user may want to:
1. **Pause the agent** to type a manual command/correction
2. **Resume autonomous operation** after the manual input
3. This must NOT trigger `is_done()` / iteration completion detection

#### Agent Pause/Resume Mechanisms:
- **Claude Code**: Escape key interrupts the current operation. After user input, the agent continues.
- **Opencode**: Escape key pauses the agent. After user input, the agent continues.

#### Approaches for Preventing False Completion Detection:

**Option A: Explicit Mode Toggle (Recommended)**
- Ralph-tui/attach has an explicit "interactive mode" toggle (hotkey, e.g. `i`)
- When toggled ON: ralph suppresses completion detection, PTY input goes directly to agent
- When toggled OFF: ralph resumes autonomous monitoring, completion detection re-enabled
- The agent's own pause mechanism (Esc) is sent through the PTY when entering interactive mode
- Exiting interactive mode does NOT send any resume signal -- the user's input to the agent will have already continued it

**Option B: Debounce/Cooldown on Completion Signal**
- After detecting user input to the PTY, apply a cooldown period (e.g., 30s) before honoring any completion signal
- Simpler but less precise -- may delay legitimate completions

**Option C: Signal File Lock**
- For opencode: when user enters interactive mode, ralph renames/locks the signal file so the plugin can't write to it
- For claude: suppress output parsing during interactive mode
- Similar to Option A but at the signal mechanism level rather than UI level

The implementation should use **Option A** as the primary approach, with the completion detection simply gated by an `interactive_mode: bool` flag in the session state. When `interactive_mode` is true, all completion signals (output parsing for claude, signal file for opencode) are ignored.

## Design Considerations

- ralph-tui's existing UI layout (dual-panel with stories left, output right) should be preserved
- The wizard should use ratatui's built-in widget patterns (list selection, text input)
- `ralph-uv attach` should look like a stripped-down version of ralph-tui (same output rendering)

## Success Metrics

- `uv run ralph-uv` works during development; `uv tool install .` produces a working `ralph-uv` command
- All existing tasks can be run with ralph-uv without modification
- ralph-tui can start, observe, and control loops without CLI interaction
- Opencode agent completes iterations with proper stop-hook detection
- Branch management correctly handles branch creation and PR workflow

## Open Questions

- None remaining (all resolved, see decisions below)

## Merge Target

None (standalone branch)
