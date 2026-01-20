# PRD: OpenCode Integration & Remote Containerization

## Type
Feature

## Introduction

Extend Ralph to support OpenCode as an alternative agent alongside Claude Code, and add containerization support for running Ralph on remote servers. This enables model/provider flexibility, cost optimization, vendor independence, and the ability to run long-running autonomous tasks on remote infrastructure.

### Key Capabilities
1. **Multi-agent support**: Run Ralph with Claude Code OR OpenCode, with automatic failover
2. **Provider agnostic**: Use any LLM provider (Anthropic, OpenAI, Google, local models) via OpenCode
3. **Per-story model selection**: Choose different models for different story complexity
4. **Remote execution**: Run Ralph in Docker containers on remote servers
5. **Interactive remote sessions**: SSH into Claude sessions, `opencode attach` for OpenCode sessions
6. **Full control**: Observe, inject prompts, pause, resume, and override running sessions

## Goals

- Add OpenCode as a first-class alternative to Claude Code in Ralph
- Support agent selection via prd.json, CLI flag, and environment variable
- Implement automatic agent failover when one agent errors repeatedly
- Create Docker/Compose configuration for remote Ralph execution
- Enable interactive control of remote sessions (SSH for Claude, `opencode attach` for OpenCode)
- Support per-story model/agent override in prd.json schema
- Maintain backwards compatibility with existing Claude-only workflows

## User Stories

### US-001: OpenCode CLI Integration
**Description:** As a developer, I want Ralph to invoke OpenCode the same way it currently invokes Claude Code, so I can use alternative models.

**Acceptance Criteria:**
- [ ] Create `agents/opencode.sh` script that wraps OpenCode CLI for Ralph
- [ ] OpenCode invocation uses `opencode run` with appropriate flags
- [ ] Pass prompt via stdin or `--prompt` flag
- [ ] Handle OpenCode's `--format json` output for status parsing
- [ ] Configure permissions: `"permission": "allow"` for autonomous operation
- [ ] Typecheck passes (for any TypeScript components)
- [ ] Test: OpenCode successfully executes a simple task

### US-002: Agent Abstraction Layer
**Description:** As a developer, I want a unified interface for invoking either agent, so Ralph doesn't need agent-specific code in the main loop.

**Acceptance Criteria:**
- [ ] Create `agents/` directory with agent wrapper scripts
- [ ] Create `agents/claude.sh` that wraps current Claude invocation
- [ ] Create `agents/opencode.sh` that wraps OpenCode invocation
- [ ] Both scripts accept same interface: prompt via stdin, return output to stdout
- [ ] Both scripts handle `--dangerously-skip-permissions` equivalent
- [ ] Update `ralph.sh` to use agent abstraction instead of direct Claude call
- [ ] Typecheck passes
- [ ] Test: Ralph works with both agents via abstraction

### US-003: Agent Selection via CLI and Environment
**Description:** As a developer, I want to choose which agent to use via CLI flag or environment variable.

**Acceptance Criteria:**
- [ ] Add `--agent <claude|opencode>` flag to `ralph.sh` and `ralph-i.sh`
- [ ] Support `RALPH_AGENT` environment variable
- [ ] Precedence: CLI flag > env var > prd.json > default (claude)
- [ ] Display selected agent in Ralph startup banner
- [ ] Update help text with agent selection options
- [ ] Typecheck passes
- [ ] Test: Agent selection works via all three methods

### US-004: Agent Selection in prd.json Schema
**Description:** As a developer, I want to specify the default agent in my prd.json, so different tasks can use different agents.

**Acceptance Criteria:**
- [ ] Add `agent` field to prd.json schema: `"agent": "claude" | "opencode"`
- [ ] Update `prd.json.example` with agent field
- [ ] Ralph reads agent preference from prd.json
- [ ] Document new schema field in AGENTS.md
- [ ] Typecheck passes
- [ ] Test: prd.json agent selection works

### US-005: Per-Story Agent and Model Override
**Description:** As a developer, I want to override the agent or model for specific stories, so I can use cheaper models for simple tasks.

**Acceptance Criteria:**
- [ ] Add optional `agent` field to userStory schema in prd.json
- [ ] Add optional `model` field to userStory schema (e.g., "anthropic/claude-haiku-4-5")
- [ ] Ralph uses story-level override when present, falls back to task-level
- [ ] For OpenCode: pass model via `--model` flag
- [ ] For Claude: model selection may require different approach (document limitation if needed)
- [ ] Update `prd.json.example` with per-story override example
- [ ] Typecheck passes
- [ ] Test: Per-story model override works with OpenCode

### US-006: Agent Prompt Compatibility
**Description:** As a developer, I want the Ralph prompt to work with both agents, with agent-specific sections where needed.

**Acceptance Criteria:**
- [ ] Audit `prompt.md` for Claude-specific assumptions
- [ ] Add agent-specific sections using conditional markers (e.g., `<!-- agent:opencode -->`)
- [ ] Create prompt preprocessing in Ralph to include/exclude sections based on agent
- [ ] Or: Create `prompt-base.md` + `prompt-claude.md` + `prompt-opencode.md` with includes
- [ ] Document any behavioral differences between agents
- [ ] Typecheck passes
- [ ] Test: Both agents understand and follow Ralph instructions

### US-007: Automatic Agent Failover
**Description:** As a developer, I want Ralph to automatically switch to the other agent if one fails repeatedly, so tasks can continue despite provider issues.

**Acceptance Criteria:**
- [ ] Track consecutive failures per agent
- [ ] After N failures (configurable, default 3), switch to alternate agent
- [ ] Log failover events to progress.txt
- [ ] Add `--failover-threshold N` CLI flag
- [ ] Add `RALPH_FAILOVER_THRESHOLD` env var
- [ ] Reset failure count on successful iteration
- [ ] Typecheck passes
- [ ] Test: Failover triggers after simulated failures

### US-008: Dockerfile for Ralph
**Description:** As a developer, I want a Dockerfile that packages Ralph with both Claude and OpenCode agents.

**Acceptance Criteria:**
- [ ] Create `Dockerfile` based on a Node.js + Python base image
- [ ] Install Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- [ ] Install OpenCode (`npm install -g opencode-ai`)
- [ ] Install common development tools (git, jq, curl)
- [ ] Copy Ralph scripts and configuration
- [ ] Set up working directory structure
- [ ] Support API keys via environment variables
- [ ] Test: Container builds successfully
- [ ] Test: Container runs Ralph with both agents

### US-009: Docker Compose Configuration
**Description:** As a developer, I want a docker-compose.yml that makes it easy to run Ralph with a project cloned from git.

**Acceptance Criteria:**
- [ ] Create `docker-compose.yml` for Ralph
- [ ] Support project git URL via environment variable (`RALPH_PROJECT_GIT_URL`)
- [ ] Support project branch via environment variable (`RALPH_PROJECT_BRANCH`)
- [ ] Clone project on container startup
- [ ] Optional: Run setup commands from config (`RALPH_SETUP_COMMANDS`)
- [ ] Mount secrets file if provided (`RALPH_SECRETS_FILE`)
- [ ] Persist task state via volumes
- [ ] Test: Compose up clones project and runs Ralph

### US-010: Remote Session Access - SSH for Claude
**Description:** As a developer, I want to SSH into a remote Ralph container and attach to the Claude tmux session.

**Acceptance Criteria:**
- [ ] Add SSH server to Docker image (optional, via build arg)
- [ ] Ralph runs Claude sessions in named tmux sessions
- [ ] Document SSH connection process: `ssh user@host` then `tmux attach -t ralph-*`
- [ ] Add `ralph-attach.sh` helper script for finding/attaching to sessions
- [ ] Test: Can SSH and interact with running Claude session

### US-011: Remote Session Access - OpenCode Attach
**Description:** As a developer, I want to connect my local OpenCode TUI to a remote Ralph OpenCode session.

**Acceptance Criteria:**
- [ ] When using OpenCode agent, start with `opencode serve` in background
- [ ] Expose OpenCode server port (default 4096)
- [ ] Document `opencode attach http://remote:4096` workflow
- [ ] Add port configuration via environment variable
- [ ] Consider security: document OPENCODE_SERVER_PASSWORD for auth
- [ ] Test: Local `opencode attach` connects to remote session

### US-012: Interactive Control Enhancement
**Description:** As a developer, I want full control over remote Ralph sessions (observe, inject, pause, resume).

**Acceptance Criteria:**
- [ ] Existing `ralph-i.sh` interactive mode works in container
- [ ] Add `pause` command to interactive mode (saves state, stops iteration)
- [ ] Add `resume` command to continue from pause
- [ ] Add `override` command to change current story mid-iteration
- [ ] State persists via progress.txt and prd.json
- [ ] Document interactive commands
- [ ] Test: Pause/resume cycle works correctly

### US-013: Container Health and Status API
**Description:** As a developer, I want a simple status endpoint to check Ralph's progress programmatically.

**Acceptance Criteria:**
- [ ] Create simple HTTP status endpoint (can be shell script + netcat, or tiny Node server)
- [ ] Endpoint returns JSON: `{task, agent, iteration, stories: {complete, total}, status}`
- [ ] Status accessible on configurable port (default 8080)
- [ ] Optional: WebSocket for real-time updates
- [ ] Test: Status endpoint returns accurate data

### US-014: Documentation and Examples
**Description:** As a developer, I want comprehensive documentation for the new features.

**Acceptance Criteria:**
- [ ] Update AGENTS.md with multi-agent documentation
- [ ] Document prd.json schema changes (agent, model fields)
- [ ] Create `docs/remote-execution.md` with Docker/remote workflow
- [ ] Create `docs/opencode-integration.md` with OpenCode-specific details
- [ ] Add examples to `examples/` directory
- [ ] Update README.md with new features overview
- [ ] Test: Documentation is accurate and complete

## Functional Requirements

- FR-1: Ralph shall support both Claude Code and OpenCode as agent backends
- FR-2: Agent selection shall follow precedence: CLI > env var > prd.json > default
- FR-3: Ralph shall automatically failover to alternate agent after N consecutive failures
- FR-4: prd.json shall support task-level and story-level agent/model configuration
- FR-5: Docker container shall include both agent CLIs pre-installed
- FR-6: Container shall clone project from git URL on startup
- FR-7: Remote Claude sessions shall be accessible via SSH + tmux attach
- FR-8: Remote OpenCode sessions shall be accessible via `opencode attach`
- FR-9: Status API shall report current progress in JSON format
- FR-10: All existing Ralph functionality shall continue working with Claude agent

## Non-Goals

- OpenZiti network integration (future version)
- Kubernetes deployment (future version)
- Web dashboard UI (simple status API only for now)
- Automatic model complexity estimation (manual per-story override only)
- Multi-container orchestration (single container runs multiple Ralph instances same as local)
- Cloud secrets manager integration (env vars and secrets file only)

## Technical Considerations

### OpenCode CLI Differences
- Uses `opencode run "prompt"` for non-interactive execution
- Supports `--format json` for structured output
- Permissions configured via config file or `--permission` flag
- Model specified via `--model provider/model` flag
- Server mode via `opencode serve` for remote TUI attachment

### Agent Abstraction Design
```
agents/
  claude.sh    # Wraps: echo "$PROMPT" | claude --dangerously-skip-permissions --print ...
  opencode.sh  # Wraps: opencode run --format json --model $MODEL "$PROMPT"
  common.sh    # Shared utilities (output parsing, error detection)
```

### Container Architecture
```
ralph-container/
  /app/ralph/          # Ralph scripts
  /app/project/        # Cloned project (working directory)
  /app/tasks/          # Task directories (can be volume mounted)
  /app/secrets/        # Optional secrets mount
```

### Port Assignments
- 22: SSH (optional)
- 4096: OpenCode server
- 8080: Ralph status API

## Success Metrics

- Ralph completes tasks successfully using OpenCode with at least 3 different providers
- Failover triggers correctly and allows task completion despite provider outage
- Remote container execution works end-to-end from clone to completion
- Users can interactively control remote sessions via SSH/attach
- No regression in existing Claude-only workflows

## Open Questions

1. Should we support running multiple Ralph instances in parallel within one container? (Current answer: yes, same as local)
2. How should we handle OpenCode's session persistence vs Claude's stateless approach?
3. Should the status API require authentication?
4. What's the best way to handle long-running container lifecycle (auto-shutdown on completion)?
