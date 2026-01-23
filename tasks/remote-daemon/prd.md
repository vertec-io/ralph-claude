# PRD: Remote Daemon (ralphd)

## Type
Feature

## Introduction

Build `ralphd`, a standalone daemon process that runs on remote machines and accepts loop execution requests over an OpenZiti overlay network. The daemon manages the full lifecycle of remote loops: receiving code via git fetch, starting opencode in server mode (HTTP API), monitoring progress via SSE events, and exposing per-loop Ziti services for client attachment.

This is the server-side component of the remote loop execution system. A local `ralph-uv start-remote` command pushes the branch to origin, dials the daemon over Ziti, and the daemon handles everything from there.

## Goals

- Implement a long-running daemon (`ralphd`) that listens for loop requests over OpenZiti
- Use `opencode serve` (HTTP API + SSE) for agent execution, not the TUI/plugin approach
- Handle remote bootstrapping: git fetch from origin, worktree checkout, agent auto-install
- Expose per-loop Ziti services so clients can attach via `opencode attach`
- Provide a `ralphd check` validation command for setup verification
- Support concurrent loops with proper isolation (separate worktrees, ports, services)

## User Stories

### US-001: Daemon CLI entrypoint and configuration loading
**Description:** As a developer, I need a `ralphd` entrypoint that loads configuration and starts the daemon process.

**Acceptance Criteria:**
- [ ] New CLI entrypoint `ralphd` registered in pyproject.toml (separate from `ralph-uv`)
- [ ] Loads config from `~/.config/ralph/daemon.toml` (workspace_dir, max_concurrent_loops, ziti identity path)
- [ ] Loads environment variables from `~/.config/ralph/env` (API keys, PATH extensions)
- [ ] Accepts `--identity` flag to override Ziti identity path
- [ ] Accepts `--workspace-dir` flag to override workspace directory
- [ ] Logs to `~/.local/state/ralph-uv/daemon.log` with rotation
- [ ] Graceful shutdown on SIGTERM/SIGINT (cleanup active loops)
- [ ] Typecheck passes

### US-002: OpenZiti SDK integration and control service binding
**Description:** As a developer, I need the daemon to load a Ziti identity and bind a control service for receiving requests.

**Acceptance Criteria:**
- [ ] Load Ziti identity JSON file using `openziti` Python SDK
- [ ] Bind to Ziti service `ralph-control-{hostname}` for incoming RPC connections
- [ ] Accept multiple concurrent client connections on the control service
- [ ] Handle connection lifecycle (accept, read, respond, close)
- [ ] Log Ziti enrollment/binding status on startup
- [ ] Graceful Ziti teardown on shutdown (unbind services, close context)
- [ ] Typecheck passes

### US-003: Daemon control RPC protocol (start_loop, stop_loop, list_loops, get_health)
**Description:** As a developer, I need the daemon to handle JSON-RPC 2.0 requests for managing loops.

**Acceptance Criteria:**
- [ ] `start_loop` method: accepts origin_url, branch, task_dir, max_iterations, agent params
- [ ] `stop_loop` method: accepts loop_id, sends abort to the running loop
- [ ] `list_loops` method: returns all active loops with status, iteration, agent, task info
- [ ] `get_health` method: returns daemon uptime, active loop count, system resources
- [ ] `get_agents` method: returns available agent CLIs with versions
- [ ] JSON-RPC 2.0 error responses for invalid params, agent not found, max loops exceeded
- [ ] NDJSON framing on the Ziti stream (same as existing RPC protocol)
- [ ] Typecheck passes

### US-004: Git workspace management (bare repo, fetch, worktree checkout)
**Description:** As a developer, I need the daemon to manage git workspaces for incoming loop requests.

**Acceptance Criteria:**
- [ ] Resolve project name from origin URL (strip .git suffix, take last path component)
- [ ] Create `~/ralph-workspaces/{project}/bare.git` via `git clone --bare` on first use
- [ ] Validate origin URL matches existing bare repo (error if mismatch)
- [ ] `git fetch origin {branch}` into bare repo on each start_loop request
- [ ] Create isolated worktree: `git worktree add checkouts/{task}-{uuid} {branch}`
- [ ] `git worktree prune` on daemon startup to clean stale worktrees
- [ ] Return checkout path in start_loop response
- [ ] Handle errors: origin unreachable, branch not found, disk full
- [ ] Typecheck passes

### US-005: Agent CLI detection and auto-install
**Description:** As a developer, I need the daemon to verify agent availability and attempt auto-install if missing.

**Acceptance Criteria:**
- [ ] Check `which opencode` before starting a loop
- [ ] If missing: attempt `curl -fsSL https://opencode.ai/install | bash`
- [ ] Verify installation succeeded with `which opencode` after install
- [ ] Return structured error if auto-install fails (with install instructions)
- [ ] Cache agent availability (don't re-check on every loop start)
- [ ] `get_agents` RPC returns installed agents with version numbers
- [ ] Typecheck passes

### US-006: OpenCode serve lifecycle management
**Description:** As a developer, I need the daemon to start `opencode serve` for each loop and manage its lifecycle.

**Acceptance Criteria:**
- [ ] Start `opencode serve --port {auto} --hostname 127.0.0.1` per loop
- [ ] Port allocation: start at 4096, increment if in use (or use OS-assigned)
- [ ] Wait for health check: `GET /global/health` returns 200 before proceeding
- [ ] Track opencode server PID and port per loop in daemon's internal registry
- [ ] Set `OPENCODE_PERMISSION` env to allow all permissions (same as yolo mode)
- [ ] Set API key environment variables from daemon's loaded env
- [ ] Set working directory to the worktree checkout path
- [ ] On stop_loop: send `POST /session/:id/abort`, then SIGTERM, then SIGKILL after timeout
- [ ] Typecheck passes

### US-007: Loop iteration driver via opencode HTTP API
**Description:** As a developer, I need the daemon to drive loop iterations by sending prompts to opencode's HTTP API and detecting completion via SSE.

**Acceptance Criteria:**
- [ ] Create a new session via `POST /session` at start of each iteration
- [ ] Build prompt using existing prompt.md template system (reuse `prompt.py`)
- [ ] Send prompt via `POST /session/{id}/message` (synchronous, waits for response)
- [ ] Monitor completion via SSE `GET /event` stream (wait for `session.idle` event)
- [ ] After each iteration: read prd.json from worktree to check story completion
- [ ] If all stories pass: mark loop completed, push to origin, clean up
- [ ] If max iterations reached: mark loop exhausted, push to origin
- [ ] Handle iteration failures: log error, increment failure counter, retry with backoff
- [ ] Include "First-Run Setup" section in prompt for iteration 1
- [ ] Typecheck passes

### US-008: Per-loop Ziti service registration for client attachment
**Description:** As a developer, I need each active loop to have its own Ziti service so clients can attach directly.

**Acceptance Criteria:**
- [ ] Register Ziti service `ralph-loop-{task}-{uuid}` when loop starts
- [ ] Ziti service proxies to the opencode serve HTTP port (TCP forwarding)
- [ ] Clients can `opencode attach http://{ziti-intercept}:{port}` through the Ziti service
- [ ] Deregister Ziti service when loop completes or is stopped
- [ ] Multiple clients can connect to the same loop service simultaneously
- [ ] Log service registration/deregistration events
- [ ] Typecheck passes

### US-009: Git push-back after iterations
**Description:** As a developer, I need the daemon to push committed work back to origin so progress is visible.

**Acceptance Criteria:**
- [ ] After each successful iteration: `git push origin {branch} --force-with-lease`
- [ ] Push is non-fatal: if push fails, log warning and continue (work is in local checkout)
- [ ] Configurable push frequency: every N iterations (default: 1)
- [ ] Final push on loop completion (ensure all work is pushed)
- [ ] Handle push conflicts gracefully (force-with-lease protects against data loss)
- [ ] Typecheck passes

### US-010: Loop completion events and client notification
**Description:** As a developer, I need the daemon to notify connected clients when loops complete.

**Acceptance Criteria:**
- [ ] On loop completion: emit `loop_completed` event on the control service
- [ ] Event payload includes: loop_id, task_name, status, iterations_used, final_story, branch
- [ ] On loop failure: emit `loop_failed` event with error details
- [ ] Clients subscribed to control service receive events in real-time
- [ ] If no client connected: events are logged but not queued (client reconciles on next connect)
- [ ] Typecheck passes

### US-011: `ralphd check` validation command
**Description:** As a developer, I need a self-check command that validates the remote machine is ready.

**Acceptance Criteria:**
- [ ] `ralphd check` runs system validation and reports status
- [ ] Checks: Python version, git, tmux, Ziti identity (enrolled), workspace dir (writable)
- [ ] Checks: API keys set (ANTHROPIC_API_KEY, etc.), agent CLIs available
- [ ] Checks: Git auth configured (SSH key or credential helper)
- [ ] Reports ready/not-ready status with actionable fix instructions
- [ ] Exit code 0 if ready, non-zero if issues found
- [ ] Typecheck passes

### US-012: Concurrent loop isolation and resource limits
**Description:** As a developer, I need the daemon to enforce resource limits and isolate concurrent loops.

**Acceptance Criteria:**
- [ ] Enforce max_concurrent_loops (configurable, default: 4)
- [ ] Return error if max loops exceeded on start_loop request
- [ ] Each loop gets: separate worktree, separate opencode serve port, separate Ziti service
- [ ] Per-loop timeout (configurable, default: 24h) — terminate loop if exceeded
- [ ] Track active loops in daemon's internal registry (in-memory + optional persistence)
- [ ] On daemon restart: detect orphaned loop processes, clean up or re-adopt
- [ ] Typecheck passes

## Functional Requirements

- FR-1: `ralphd` is a separate CLI entrypoint installed alongside `ralph-uv`
- FR-2: Daemon binds to OpenZiti control service using the `openziti` Python SDK
- FR-3: Control service accepts JSON-RPC 2.0 requests (start_loop, stop_loop, list_loops, get_health, get_agents)
- FR-4: Git workspaces use bare repos with worktree checkouts for isolation
- FR-5: Agent execution uses `opencode serve` HTTP API, not TUI/plugin/tmux
- FR-6: Loop iterations send prompts via HTTP, detect completion via SSE `session.idle`
- FR-7: Per-loop Ziti services enable direct client attachment via `opencode attach`
- FR-8: Work is pushed back to origin after each iteration (configurable frequency)
- FR-9: `ralphd check` validates system readiness
- FR-10: Concurrent loops are isolated (worktree, port, service) with configurable limits

## Non-Goals

- Claude agent support (added in a follow-up effort)
- Client-side implementation (`ralph-uv start-remote` command)
- Ralph-tui remote integration
- Web UI or dashboard
- Auto-scaling or cloud provider integration
- Multi-tenant support (multiple users on same machine)
- OpenCode source modifications

## Technical Considerations

- Reuses existing `prompt.py` for prompt building
- Reuses existing `loop.py` iteration logic patterns (prd.json reading, story tracking)
- OpenZiti Python SDK (`openziti` on PyPI) wraps the C SDK via ctypes — no native asyncio support. May need a thread pool for blocking Ziti operations.
- `opencode serve` uses Bun internally but is distributed as a standalone binary
- The daemon is a single Python process; loop management via subprocess + asyncio
- NDJSON framing for RPC matches the existing protocol in `docs/protocol.md`
- OpenCode credentials stored in `~/.local/share/opencode/auth.json` (set up via `/connect` once)
- The daemon loads API keys from `~/.config/ralph/env` and passes them to opencode subprocesses

## Success Metrics

- `ralphd` starts and binds to Ziti control service successfully
- `ralphd check` validates readiness and reports clear status
- A start_loop request triggers: git fetch, worktree checkout, opencode serve start, prompt sent
- Loop iterations complete and push progress to origin
- Clients can attach to running loops via the per-loop Ziti service
- Concurrent loops run in isolation without interfering with each other
- Daemon handles crashes gracefully (loop failures don't crash daemon)

## Open Questions

- Should opencode serve port allocation use a fixed range (4096-4196) or OS-assigned ports?
- How to handle opencode serve crashes mid-iteration? (restart opencode serve and retry vs mark iteration failed)
- Should the daemon persist active loop state to disk (survive daemon restarts) or start fresh?
- What's the ideal SSE event monitoring strategy? (dedicated thread per loop vs shared asyncio event loop)

## Merge Target

`ralph/remote-loop-execution` - Merge into the current investigation branch.
Auto-merge: No (ask for confirmation first)
