# Ralph Agent Instructions

## Overview

Ralph is an autonomous AI agent loop that runs coding agents repeatedly until all PRD items are complete. Each iteration is a fresh agent instance with clean context.

Supports **multiple AI coding agents** with automatic fallback:
- **OpenCode** - Open source coding agent
- **Claude Code** - Anthropic's CLI agent  
- **Codex CLI** - OpenAI's coding agent
- **Amp** - Sourcegraph's frontier coding agent
- **Aider** - AI pair programming in terminal

Supports both **feature development** and **bug investigations**.

## Directory Structure

Each effort gets its own subdirectory under `tasks/`:

```
tasks/
├── device-system-refactor/
│   ├── prd.md           # The requirements document
│   ├── prd.json         # Ralph-format JSON (includes agent preference)
│   └── progress.txt     # Iteration logs
├── fix-auth-timeout/
│   ├── prd.md
│   ├── prd.json
│   └── progress.txt
└── ...
```

## Commands

```bash
# Run Ralph for a specific task (will prompt for agent if multiple installed)
./ralph.sh tasks/device-system-refactor

# Run with specific iterations
./ralph.sh tasks/fix-auth-timeout -i 20

# Run with a specific agent
./ralph.sh tasks/fix-auth-timeout -a claude

# Run with agent and iterations
./ralph.sh tasks/fix-auth-timeout -i 20 -a opencode

# Skip prompts (use saved preferences)
./ralph.sh tasks/fix-auth-timeout -y

# Run the flowchart dev server
cd flowchart && npm run dev
```

## Command Line Options

| Flag | Description |
|------|-------------|
| `-i, --iterations N` | Maximum iterations (default: 10) |
| `-a, --agent NAME` | Agent to use: `claude`, `codex`, `opencode`, `aider`, `amp` |
| `-y, --yes` | Skip confirmation prompts |

## Supported Agents

| Agent | Command | Non-interactive Flag | Skip Permissions |
|-------|---------|---------------------|------------------|
| Claude Code | `claude` | `--print` | `--dangerously-skip-permissions` |
| Codex CLI | `codex` | `exec` | `--dangerously-bypass-approvals-and-sandbox` |
| OpenCode | `opencode` | `run` | (permission config) |
| Aider | `aider` | `--message-file` | `--yes-always` |
| Amp | `amp` | `--execute` | `--dangerously-allow-all` |

## Agent Selection & Fallback

1. **CLI flag** (`-a agent`) takes highest priority
2. **Saved in prd.json** - Agent preference persists per task
3. **Interactive prompt** - If multiple agents installed, prompts for selection
4. **Single agent** - Uses the only installed agent automatically

### Auto-Fallback on Errors

If an agent fails due to:
- **Authentication errors** - Invalid API key, login required
- **Rate limits** - Too many requests, quota exceeded
- **Context limits** - Token limit exceeded, prompt too long

Ralph automatically tries the next agent in priority order:
`opencode → claude → codex → amp → aider`

Each agent gets 1 attempt before fallback.

## Key Files

- `ralph.sh` - The bash loop that spawns agent instances with fallback
- `prompt.md` - Instructions given to each agent instance
- `skills/prd/` - Skill for generating PRDs (features and bugs)
- `skills/ralph/` - Skill for converting PRDs to JSON
- `prd.json.example` - Example PRD format (includes `agent` field)
- `flowchart/` - Interactive React Flow diagram explaining how Ralph works

## PRD Types

### Feature
Standard feature development with dependency-ordered stories.

### Bug Investigation
Follows: Reproduce → Instrument → Analyze → Evaluate → Implement → Validate

## prd.json Schema

```json
{
  "project": "MyApp",
  "taskDir": "tasks/my-feature",
  "branchName": "ralph/my-feature",
  "type": "feature",
  "description": "Feature description",
  "agent": "claude",  // Preferred agent (saved on first selection)
  "userStories": [...]
}
```

## Patterns

- Each iteration spawns a fresh agent instance with clean context
- Memory persists via git history, `progress.txt`, and `prd.json`
- Stories should be small enough to complete in one context window
- Use the `notes` field in stories to pass context between iterations
- Agent preference is saved per-task in `prd.json`
- Always update AGENTS.md with discovered patterns for future iterations
