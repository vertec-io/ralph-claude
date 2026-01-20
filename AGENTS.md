# Ralph Agent Instructions

## Overview

Ralph is an autonomous AI agent loop that runs AI coding agents (Claude Code or OpenCode) repeatedly until all PRD items are complete. Each iteration is a fresh agent instance with clean context.

Supports both **feature development** and **bug investigations**.

## Multi-Agent Support

Ralph supports multiple AI agents:

- **Claude** - Anthropic's Claude Code CLI (`@anthropic-ai/claude-code`)
- **OpenCode** - Multi-provider CLI supporting various models (`opencode-ai`)

### Agent Selection

Agent selection follows this precedence (highest to lowest):

1. **Story-level override** - `agent` field in a specific user story
2. **CLI flag** - `--agent <claude|opencode>`
3. **Environment variable** - `RALPH_AGENT=<claude|opencode>`
4. **PRD configuration** - `agent` field in prd.json
5. **Default** - `claude`

```bash
# CLI flag (highest precedence)
./ralph.sh tasks/my-task --agent opencode

# Environment variable
RALPH_AGENT=opencode ./ralph.sh tasks/my-task

# PRD configuration (in prd.json)
{
  "agent": "opencode",
  "userStories": [...]
}
```

### Per-Story Agent Override

Individual stories can use a different agent than the task default:

```json
{
  "agent": "claude",
  "userStories": [
    {
      "id": "US-001",
      "title": "Backend API work",
      "agent": "claude",
      ...
    },
    {
      "id": "US-002", 
      "title": "Frontend work with cheaper model",
      "agent": "opencode",
      "model": "anthropic/claude-haiku-4",
      ...
    }
  ]
}
```

### Per-Story Model Override

For OpenCode, you can specify models per-story for cost optimization:

```json
{
  "id": "US-003",
  "title": "Simple documentation update",
  "agent": "opencode",
  "model": "anthropic/claude-haiku-4",
  ...
}
```

**Note**: Claude Code CLI does not support model selection via command line - it uses the model determined by your subscription.

### Automatic Failover

Ralph automatically switches agents after consecutive failures:

- Default threshold: 3 consecutive failures
- Failure detection: exit codes, empty output, rate limits, API errors
- If both agents fail, Ralph stops with a detailed error

Configure the failover threshold:

```bash
# CLI flag
./ralph.sh tasks/my-task --failover-threshold 5

# Environment variable
RALPH_FAILOVER_THRESHOLD=5 ./ralph.sh tasks/my-task

# PRD configuration (in prd.json)
{
  "failoverThreshold": 5,
  ...
}
```

### Agent Wrapper Scripts

Agent logic is encapsulated in wrapper scripts under `agents/`:

- `agents/claude.sh` - Claude Code CLI wrapper
- `agents/opencode.sh` - OpenCode CLI wrapper
- `agents/common.sh` - Shared utilities (error detection, prompt preprocessing)

## Directory Structure

Each effort gets its own subdirectory under `tasks/`:

```
tasks/
├── device-system-refactor/
│   ├── prd.md           # The requirements document
│   ├── prd.json         # Ralph-format JSON
│   └── progress.txt     # Iteration logs
├── fix-auth-timeout/
│   ├── prd.md
│   ├── prd.json
│   └── progress.txt
└── ...
```

## Commands

```bash
# Run Ralph for a specific task
./ralph.sh tasks/device-system-refactor

# Run with more iterations
./ralph.sh tasks/fix-auth-timeout 20

# Run the flowchart dev server
cd flowchart && npm run dev
```

## Key Files

- `ralph.sh` - The bash loop that spawns fresh Claude Code instances
- `prompt.md` - Instructions given to each Claude Code instance
- `skills/prd/` - Skill for generating PRDs (features and bugs)
- `skills/ralph/` - Skill for converting PRDs to JSON
- `prd.json.example` - Example PRD format
- `flowchart/` - Interactive React Flow diagram explaining how Ralph works

## PRD Types

### Feature
Standard feature development with dependency-ordered stories.

### Bug Investigation
Follows: Reproduce → Instrument → Analyze → Evaluate → Implement → Validate

## Patterns

- Each iteration spawns a fresh Claude Code instance with clean context
- Memory persists via git history, `progress.txt`, and `prd.json`
- Stories should be small enough to complete in one context window
- Use the `notes` field in stories to pass context between iterations
- Always update AGENTS.md with discovered patterns for future iterations
