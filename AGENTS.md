# Ralph Agent Instructions

## Overview

Ralph is an autonomous AI agent loop that runs coding agents (Claude Code or OpenCode) repeatedly until all PRD items are complete. Each iteration is a fresh agent instance with clean context.

Supports both **feature development** and **bug investigations**.

## Directory Structure

Each effort gets its own subdirectory under `tasks/`:

```
tasks/
├── my-feature/
│   ├── prd.md           # The requirements document
│   ├── prd.json         # Ralph-format JSON
│   └── progress.txt     # Iteration logs
├── fix-auth-timeout/
│   ├── prd.md
│   ├── prd.json
│   └── progress.txt
└── archived/            # Completed tasks
```

## Two Implementations

Ralph has two implementations:

### 1. ralph.sh (Bash) (deprecated)
The original bash implementation with full features. Currently trying to deprecate

```bash
# Start a task (runs in tmux background)
./ralph.sh tasks/my-feature

# With options
./ralph.sh tasks/my-feature -i 20 --agent opencode --yolo

# Session management
ralph attach              # Watch running session
ralph checkpoint          # Graceful stop with state save
ralph stop                # Force stop
ralph status              # List all sessions
```

### 2. ralph-uv (Python) (under development)
A Python rewrite with cleaner architecture and OpenCode server mode.

```bash
# Run via the Python CLI
ralph-uv run tasks/my-feature -i 10 -a claude

# Session management
ralph-uv status           # Show all sessions
ralph-uv stop my-feature  # Stop a session
ralph-uv attach my-feature # Attach to tmux session
```

## Key Files

- `ralph.sh` - Bash loop that spawns agent sessions in tmux
- `src/ralph_uv/` - Python implementation
  - `cli.py` - Click-based CLI entrypoint
  - `loop.py` - Core iteration logic
  - `agents.py` - Agent abstraction (Claude, OpenCode)
  - `session.py` - Session management (tmux, SQLite registry)
  - `prompt.py` - Prompt building and preprocessing
  - `branch.py` - Git branch management
  - `rpc.py` - JSON-RPC server for TUI communication
  - `opencode_server.py` - OpenCode HTTP API client
- `prompt.md` - Instructions given to each agent iteration
- `skills/prd/` - Skill for generating PRDs
- `skills/ralph/` - Skill for converting PRDs to JSON
- `plugins/opencode-ralph-hook/` - OpenCode plugin for completion detection
- `agents/` - Bash agent wrapper scripts
- `flowchart/` - Interactive React Flow diagram

## PRD Types

### Feature
Standard feature development with dependency-ordered stories.

### Bug Investigation
Follows: Reproduce → Instrument → Analyze → Evaluate → Implement → Validate

## Agents

Ralph supports multiple coding agents with automatic failover:

| Agent | Mode | Description |
|-------|------|-------------|
| `claude` | tmux | Claude Code CLI (`claude --print`), runs in tmux session |
| `opencode` | server | OpenCode via `opencode serve` HTTP API |

Agent resolution priority: CLI flag > story-level > prd.json > default (claude)

## Architecture

### Session Management

- **tmux sessions**: For claude agent, loops run in detached tmux sessions
- **opencode serve**: For opencode agent, uses HTTP API mode
- **SQLite registry**: `~/.local/share/ralph/sessions.db` tracks all sessions
- **Signal files**: `~/.local/share/ralph/signals/` for stop/checkpoint communication

### Dual-Mode Execution

1. **Claude agent (tmux mode)**:
   - Loop spawns in a detached tmux session
   - Agent inherits the terminal, runs `claude --print`
   - User can attach with `tmux attach -t ralph-<task>`

2. **OpenCode agent (server mode)**:
   - Starts `opencode serve` HTTP server
   - Loop sends prompts via POST to `/session/:id/message`
   - Completion detected via session.idle event

### Plugin-Based Completion Detection (OpenCode)

OpenCode uses a plugin (`plugins/opencode-ralph-hook/`) that:
- Listens for the `session.idle` event
- Writes a signal file when the agent finishes
- Ralph monitors this file to detect iteration completion

### RPC Layer

The Python implementation includes a JSON-RPC server for TUI integration:
- Unix socket at `~/.local/share/ralph/sockets/<task>.sock`
- Supports: get_state, subscribe, stop, checkpoint
- Background thread runs the asyncio event loop

## Patterns

- Each iteration spawns a fresh agent instance with clean context
- Memory persists via git history, `progress.txt`, and `prd.json`
- Stories should be small enough to complete in one context window
- Use the `notes` field in stories to pass context between iterations
- Always update AGENTS.md with discovered patterns for future iterations
- Progress files rotate at 300 lines (configurable with `--rotate-at`)
- Automatic failover between agents after 3 consecutive failures

## Remote Execution (In Progress)

The `tasks/remote-loop-execution/` task is implementing remote execution over OpenZiti:
- Local client can start/monitor loops on remote machines
- Daemon on remote machine manages loop lifecycle
- Sessions tracked with `transport: "ziti"` in SQLite
- Git push to origin, remote daemon fetches (no git-over-Ziti needed)

## Configuration

### prd.json fields
- `agent`: Default agent for the task ("claude" or "opencode")
- `failoverThreshold`: Failures before agent switch (default: 3)
- Story-level `agent` and `model` override task defaults

### Environment variables
- `RALPH_AGENT`: Default agent
- `RALPH_FAILOVER_THRESHOLD`: Failure threshold
- `YOLO_MODE`: Skip permission prompts
- `RALPH_VERBOSE`: Enable verbose output
- `RALPH_SIGNAL_FILE`: Signal file path (set by ralph for plugins)
