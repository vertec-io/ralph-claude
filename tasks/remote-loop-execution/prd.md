# PRD: Remote Loop Execution Feasibility Investigation

## Type
Bug Investigation (Investigation/Feasibility Study)

## Problem Statement

Currently, ralph loops can only be monitored and controlled from the same machine where they run. There is no mechanism to:

- Start a ralph loop on a remote machine and monitor it from a local client
- Connect ralph-tui or `ralph-uv attach` to a loop running on a different host
- Use the opencode TUI or web client to interact with a remote opencode loop

**Actual behavior:** All ralph-uv session management is local-only (tmux sessions for claude, local processes for opencode).

**Expected behavior:** Users should be able to run loops on remote machines (cloud VPS, LAN servers) and monitor/interact with them from local clients — using the opencode TUI for opencode loops, or tmux attach for claude loops.

## Environment

- Ralph-UV: Python, Click CLI, dual-mode session management:
  - **Claude agent**: libtmux-based (detached tmux sessions with remain-on-exit)
  - **Opencode agent**: `opencode serve` (headless HTTP server with SSE events)
- Ralph-TUI: Rust, ratatui, currently uses tmux pipe-pane
- Session tracking: SQLite at ~/.local/share/ralph/sessions.db
- Inter-process signals: Signal files at ~/.local/share/ralph/signals/
- OpenCode server: HTTP REST API + SSE events at configurable port (default 4096)
- OpenCode TUI: `opencode attach <url>` connects to any opencode server
- Both cloud (public IP) and LAN environments need support

## Goals

- Assess feasibility of remote loop monitoring and control
- Identify the minimal changes needed to enable remote connectivity
- Determine security requirements (auth, encryption)
- Evaluate approach options: OpenZiti overlay for transport, opencode server mode for opencode agent
- Implement dual-mode session management: tmux for claude, opencode serve for opencode
- Enable `ralph-uv attach` to use opencode TUI for opencode loops (locally and remotely)
- Document a recommended architecture for remote execution

## Investigation Stories

### US-001: Full architecture sketch
**Description:** As a developer, I need a complete architectural diagram/document showing all components, their roles, communication paths, and how they compose into the remote execution system.

**Acceptance Criteria:**
- [ ] Diagram showing: ralph-uv daemon, loop runners, RPC layer, OpenZiti overlay, client(s)
- [ ] Define the ralph-uv daemon's responsibilities (listen for start requests, manage loop lifecycles, expose per-loop RPC)
- [ ] Define how loop runners register with the daemon and expose their RPC
- [ ] Define client connection flow: client reads SQLite → if remote, connect via OpenZiti → remote daemon
- [ ] Define the "start loop" request/response contract (repo URL? task dir? branch? iterations?)
- [ ] Define how multiple concurrent loops are isolated (separate checkouts, separate sockets, separate Ziti services or multiplexed?)
- [ ] Document which existing code is reused vs. what's new
- [ ] Address: what happens on disconnect/reconnect, daemon crash, loop crash
- [ ] Define loop completion flow: daemon pushes event → local SQLite marked completed/failed
- [ ] Address stale state: how does local SQLite reconcile if no client was connected when loop finished?
- [ ] Save architecture document to `tasks/remote-loop-execution/architecture.md`

### US-002: Audit current RPC transport layer
**Description:** As a developer, I need to understand exactly how the current Unix socket RPC is implemented so I can identify extension points for OpenZiti transport.

**Acceptance Criteria:**
- [ ] Document all socket creation/binding code paths in `rpc.py`
- [ ] Document all client connection code in `attach.py`
- [ ] Identify where `AF_UNIX` is hardcoded vs. abstracted
- [ ] Map the full lifecycle: server start → client connect → subscribe → events → disconnect
- [ ] Note any assumptions that would break over a network (latency, ordering, disconnects)
- [ ] Update notes in prd.json with findings

### US-003: Evaluate OpenZiti Python SDK capabilities
**Description:** As a developer, I need to understand the OpenZiti Python SDK's capabilities for both server (daemon) and client (attach/TUI proxy) use.

**Acceptance Criteria:**
- [ ] Document how to create a Ziti socket server (bind to a Ziti service) using `openziti` Python SDK
- [ ] Document how to connect as a Ziti client to a service using `openziti` Python SDK
- [ ] Determine if SDK supports asyncio (needed for RPC server integration)
- [ ] Determine how identity files (.json/.jwt) are loaded and used
- [ ] Test or document: can one SDK process host multiple services (one per loop)?
- [ ] Identify SDK limitations, maturity, and maintenance status
- [ ] Update notes in prd.json with findings

### US-004: Implement opencode server mode for local loops
**Description:** As a developer, I need ralph-uv to use `opencode serve` instead of tmux when the agent is opencode, so that attach uses the native opencode TUI.

**Acceptance Criteria:**
- [ ] When agent=opencode, `ralph-uv run` starts `opencode serve --port <auto>` instead of tmux session
- [ ] Ralph-uv tracks the opencode server PID and port in SQLite session entry
- [ ] Loop runner sends prompts via HTTP API (`POST /session/:id/message`) instead of shell injection
- [ ] Loop runner monitors completion via SSE events (`GET /event`) — waits for `session.idle` event
- [ ] `ralph-uv attach <task>` launches `opencode attach http://localhost:<port>` for opencode loops
- [ ] `ralph-uv stop <task>` calls `POST /session/:id/abort` for opencode loops
- [ ] Health check on startup: verify `GET /global/health` returns before sending prompts
- [ ] Opencode server process managed with proper lifecycle (start, health check, kill on completion)
- [ ] Typecheck passes

### US-005: Assess remote attach/monitoring over network
**Description:** As a developer, I need to determine if remote session attach is feasible over OpenZiti for both agent types, and what the user experience looks like.

**Acceptance Criteria:**
- [ ] Document remote opencode attach flow: Ziti proxies HTTP port → `opencode attach http://<ziti>:<port>`
- [ ] Analyze remote claude attach options (tmux socket proxy vs SSH-over-Ziti)
- [ ] Assess latency requirements for remote terminal/TUI session to feel responsive
- [ ] Test or estimate: SSE event latency over Ziti for opencode real-time updates
- [ ] Document architecture for both agent types' remote attach
- [ ] Update notes in prd.json with findings

### US-006: Design unified session DB schema for dual-mode + remote loops
**Description:** As a developer, I need to extend the SQLite session schema so it supports both agent types (tmux vs opencode-server) and remote loops, with enough info for clients to connect appropriately.

**Acceptance Criteria:**
- [ ] Design schema changes: add session_type (tmux|opencode-server), server_port, server_url, remote flag, Ziti service name, identity file path
- [ ] Define how opencode-server sessions are registered (port, PID, health URL)
- [ ] Define how remote loops are registered in local SQLite (on start-remote command)
- [ ] Ensure `ralph-uv status` can list all loops (local tmux, local opencode, remote tmux, remote opencode)
- [ ] Define how stale entries are cleaned up per type (tmux: pane_dead_status, opencode: health check failure)
- [ ] Define how ralph-tui dispatches attach per type (tmux pipe-pane vs opencode attach)
- [ ] Update notes in prd.json with findings

### US-007: Design remote environment bootstrapping flow
**Description:** As a developer, I need to understand how the remote machine gets the code, agent CLI, and project deps when a job is sent to it for the first time.

**Acceptance Criteria:**
- [ ] Design the code sync flow: local creates branch → pushes to origin → pushes to remote bare repo → daemon checks out working dir
- [ ] Define how the remote bare repo is set up (one-time manual? auto-created by daemon on first push?)
- [ ] Design agent CLI auto-install: daemon checks for claude/opencode binary, installs if missing on first use
- [ ] Document what 'install opencode CLI' looks like programmatically
- [ ] Design 'task 0' pattern: first iteration installs project deps before real work begins
- [ ] Address lockfile discovery: how does task 0 find lockfiles that may not be in repo root?
- [ ] Define what manual one-time setup the user must do on the remote (git, jq, python, bun/node for opencode, API keys)
- [ ] Address: how does the remote get prompt.md, agents/ scripts, and AGENTS.md? (via git push — they're in the repo)
- [ ] Document the full sequence: user runs 'ralph-uv start-remote' → what happens step by step until loop iteration 1 begins
- [ ] Update notes in prd.json with findings

### US-008: Prototype opencode remote loop over Ziti
**Description:** As a developer, I need to validate the architecture with a minimal proof-of-concept: start opencode serve on a remote machine, proxy via Ziti, attach locally.

**Acceptance Criteria:**
- [ ] Set up OpenZiti network (controller + edge router, or CloudZiti)
- [ ] Enroll a ralph-uv daemon server identity and a client identity
- [ ] Create a Ziti service that proxies to the remote opencode HTTP port
- [ ] Start `opencode serve` on remote, verify `opencode attach` works via Ziti proxy locally
- [ ] Send a prompt via Ziti-proxied HTTP API and verify response
- [ ] Verify SSE event streaming works over Ziti (real-time progress updates)
- [ ] Measure latency overhead: local opencode attach vs Ziti-proxied opencode attach
- [ ] Test abort/stop via Ziti-proxied API
- [ ] Document any issues discovered during prototype
- [ ] Update notes in prd.json with findings and measurements
- [ ] Typecheck passes

## OpenCode Server Mode Architecture

### Dual-Mode Agent Management

Ralph-uv uses **different session management strategies per agent**:

| Agent | Local Management | Attach Method | Remote Strategy |
|-------|-----------------|---------------|-----------------|
| Claude | tmux session (libtmux) | `tmux attach -t <name>` | Proxy tmux socket over Ziti |
| OpenCode | `opencode serve` (HTTP server) | `opencode attach <url>` | Proxy HTTP port over Ziti |

### How OpenCode Server Mode Works

OpenCode has a built-in client-server architecture:
- `opencode serve [--port N] [--hostname H]` — starts a headless HTTP server
- `opencode attach <url>` — connects the full TUI to a running server
- The server exposes: sessions, messages, events (SSE), file operations, agent control
- Multiple clients can connect to the same server simultaneously

### OpenCode Loop Flow (Local)

1. `ralph-uv run tasks/my-task/ -a opencode` detects opencode agent
2. Instead of spawning a tmux session, ralph-uv starts `opencode serve --port <auto>`
3. Ralph-uv sends prompts to the opencode server via HTTP API (`POST /session/:id/message`)
4. Loop progress monitored via SSE events (`GET /event`)
5. `ralph-uv attach my-task` launches `opencode attach http://localhost:<port>` — full TUI experience
6. Stop/abort via HTTP API (`POST /session/:id/abort`)

### OpenCode Loop Flow (Remote via Ziti)

1. `ralph-uv run-remote tasks/my-task/ -a opencode` sends start request over Ziti
2. Remote daemon starts `opencode serve --port <auto> --hostname 0.0.0.0`
3. Ziti service exposes the opencode HTTP port (Ziti handles auth/encryption)
4. Local ralph-uv registers remote loop in SQLite with Ziti connection info
5. `ralph-uv attach my-task` dials Ziti service, gets proxied HTTP URL
6. Launches `opencode attach http://<ziti-proxy>:<port>` — same TUI, works remotely
7. Stop/checkpoint via Ziti-proxied HTTP API calls to opencode server

### Key OpenCode Server APIs Used by Ralph

| Endpoint | Purpose |
|----------|---------|
| `POST /session` | Create new session for each iteration |
| `POST /session/:id/message` | Send the ralph prompt (sync, waits for response) |
| `POST /session/:id/prompt_async` | Send prompt without waiting (for background loops) |
| `GET /event` | SSE stream for monitoring progress, completion, errors |
| `POST /session/:id/abort` | Stop current iteration |
| `GET /session/status` | Check if agent is idle/working |
| `GET /global/health` | Verify server is alive |
| `GET /session/:id/diff` | Get file changes made by agent |

### Advantages Over tmux for OpenCode

1. **Native TUI**: `opencode attach` gives the full opencode experience (themes, keybinds, session history)
2. **Programmatic control**: HTTP API for sending prompts, no shell command injection
3. **Multi-client**: Multiple users can monitor the same loop simultaneously
4. **Network-native**: HTTP is trivially proxied over Ziti (no tmux socket hacks)
5. **Event streaming**: SSE provides real-time progress without polling
6. **Session persistence**: OpenCode manages its own session storage, survives crashes
7. **Web UI option**: `opencode web` could also connect to the same server for browser-based monitoring

### Ralph-TUI Integration

When ralph-tui shows an opencode loop:
- For local loops: embed or spawn `opencode attach http://localhost:<port>`
- For remote loops: embed or spawn `opencode attach http://<ziti-proxy>:<port>`
- The opencode TUI handles all rendering, ralph-tui just manages the connection URL

## Hypotheses

1. **OpenCode server mode is the natural remote solution for opencode loops:** Since opencode already has a client-server architecture with HTTP API + SSE events, proxying the HTTP port over Ziti gives remote attach "for free" — no custom protocol needed.

2. **Dual-mode is cleaner than forcing one approach:** Claude doesn't have a server mode, so tmux remains the right choice. OpenCode's server mode is purpose-built for multi-client access. Using each agent's native approach avoids impedance mismatch.

3. **Ziti HTTP proxy is trivial:** Unlike tmux socket proxying (which requires Unix domain socket tricks), HTTP port proxying over Ziti is straightforward — it's just TCP forwarding to a known port.

4. **Unified SQLite still works:** Session DB stores connection type (tmux vs opencode-server) and connection info (tmux session name vs HTTP URL). Attach logic branches based on type.

5. **OpenZiti eliminates custom auth:** Zero-trust identity model means no need for API keys, TLS cert management, or custom auth — Ziti handles it all at the network layer. OpenCode's own `OPENCODE_SERVER_PASSWORD` provides an additional layer if desired.

6. **Daemon manages both agent types:** Remote daemon starts either tmux sessions (claude) or opencode serve processes (opencode). Both are supervised the same way — just different lifecycle management.

7. **Ralph loop logic simplifies for opencode:** Instead of shell command injection into a tmux pane, ralph-uv can use the opencode HTTP API to send prompts programmatically. This eliminates the completion detection hacks (signal files, TypeScript plugins).

## Related Code

- `src/ralph_uv/cli.py` - Click CLI (run/stop/attach/status commands, spawning logic)
- `src/ralph_uv/session.py` - libtmux session management, SQLite registry, signal files
- `src/ralph_uv/attach.py` - Attach command (validates session liveness, dispatches to tmux or opencode attach)
- `src/ralph_uv/loop.py` - Loop runner (manages agent iterations, reads prd.json)
- `src/ralph_uv/agents.py` - Agent implementations (claude via tmux, opencode via server mode)
- `src/ralph_uv/branch.py` - Git branch management for task branches
- `ralph-tui/src/main.rs` - TUI entry point, tmux attachment
- `opencode/` - OpenCode source code (reference for server/TUI architecture)
- `opencode/packages/opencode/src/server/` - OpenCode HTTP server implementation
- `opencode/packages/opencode/src/cli/cmd/tui/` - OpenCode TUI client (attach command)
- `opencode/packages/sdk/js/` - OpenCode JavaScript SDK (typed HTTP client)

## Non-Goals

- Building a custom web UI for remote monitoring (opencode web exists for opencode loops)
- Cross-platform remote access (Windows → Linux, etc.)
- Auto-discovery of remote ralph instances (mDNS/Ziti discovery may come later)
- Modifying opencode source code (we use it as-is via its public APIs)
- Supporting agents other than claude and opencode

## Functional Requirements

- FR-1: Produce a complete architecture document covering all components and their interactions
- FR-2: Document the current session management layer and its extension points for both agents
- FR-3: Evaluate OpenZiti Python SDK for both server and client use cases
- FR-4: Implement opencode server mode for local opencode loops (replace tmux for opencode agent)
- FR-5: Implement `ralph-uv attach` dispatching: tmux attach for claude, opencode attach for opencode
- FR-6: Design unified SQLite schema for remote loop registration (both agent types)
- FR-7: Enable remote opencode loops via Ziti-proxied HTTP port to opencode server
- FR-8: Create a working proof-of-concept demonstrating remote opencode attach over Ziti
- FR-9: Define the daemon's "start loop" API contract (supporting both tmux and opencode serve)
- FR-10: Ralph loop runner uses opencode HTTP API for prompt submission (no shell injection)

## Technical Considerations

### Claude Agent (tmux-based)
- Session management uses libtmux (Python API over tmux server)
- Tmux sessions use `remain-on-exit` so crash output is preserved in dead panes
- `tmux_session_alive()` distinguishes "session exists" from "process is still running" via `pane_dead_status`
- Attach is `tmux attach-session -t <name>` — full terminal takeover
- Remote attach for claude: proxy tmux socket over Ziti (or SSH-over-Ziti)

### OpenCode Agent (server-based)
- `opencode serve --port <auto> --hostname 127.0.0.1` starts headless server
- Server exposes OpenAPI 3.1 spec at `/doc`, SSE events at `/event`
- `opencode attach http://localhost:<port>` connects full TUI to server
- Health check: `GET /global/health` returns `{ healthy: true, version: "..." }`
- Session management: create session → send prompt → wait for idle event → repeat
- Abort: `POST /session/:id/abort` stops current agent loop
- OpenCode stores sessions in `~/.opencode/data/storage/` (filesystem, not SQLite)
- Multiple clients can connect simultaneously (SSE broadcast to all)
- `OPENCODE_SERVER_PASSWORD` enables HTTP Basic Auth (optional)
- Port auto-assignment: opencode tries 4096, increments if in use

### General
- Stop/checkpoint uses signal files at `~/.local/share/ralph/signals/` (for claude loops)
- For opencode loops, stop uses HTTP API (`POST /session/:id/abort`)
- Network disconnects need graceful handling (reconnection, state recovery)
- OpenZiti adds a dependency (tunneler binary or SDK library)
- OpenZiti Python SDK: `openziti` package on PyPI
- Daemon process manages both tmux sessions (claude) and opencode serve processes (opencode)
- Consider systemd unit file for the ralph-uv daemon on remote machines
- Remote opencode attach is just `opencode attach http://<ziti-proxy>:<port>` — no special protocol needed

## Success Metrics

- Local opencode loops work via server mode: `ralph-uv run -a opencode` starts server, attach shows TUI
- Clear go/no-go recommendation for remote execution via OpenZiti
- If go: estimated implementation effort in developer-days
- Proof-of-concept: remote opencode server accessible via Ziti, local `opencode attach` works
- SSE event latency characterized over Ziti (LAN and WAN)
- Daemon architecture documented for remote loop starting (both agent types)
- Ralph loop runner successfully sends prompts via opencode HTTP API (no shell injection)

## Resolved Questions

- **Protocol:** JSON-RPC (keep the existing protocol, transport-agnostic)
- **Relay/proxy:** No relay service. Ralph-uv IS the server; ralph-tui and ralph-uv attach are clients.
- **Client architecture:** Ralph-tui connects through a local ralph-uv proxy (ralph-uv as server model)
- **Credentials:** Config file and environment variables
- **Remote starting:** Yes — remote clients can start NEW loops on the remote machine. A small always-running service on the remote box listens for requests to start loops.
- **Networking:** OpenZiti for transport (zero-trust overlay network with built-in identity, encryption, and mutual auth)

## Architectural Direction

Ralph-uv should be thought of as a **server**. Ralph-tui and `ralph-uv attach` are **clients**.

### Core Insight: Unified Session DB

The key architectural decision is that **remote loops are registered in the same local SQLite database as local loops**. This means:

- `ralph-uv status` shows both local and remote loops
- `ralph-tui` lists all loops (local + remote) from SQLite
- `ralph-uv attach <task>` looks up the loop in SQLite, sees connection info, and connects appropriately (Unix socket for local, OpenZiti for remote)
- **No separate proxy process needed** — the Ziti transport is an implementation detail inside the attach/TUI client code

### Components

1. **Remote daemon** (ralph-uv daemon, runs on remote machine):
   - Persistent process, listens for requests over OpenZiti
   - Accepts "start loop" requests:
     - Claude: spawns tmux session (same as local)
     - OpenCode: starts `opencode serve` process on allocated port
   - Manages lifecycles: tmux sessions via libtmux, opencode processes via PID tracking
   - Exposes session control (start/stop/checkpoint/status) over Ziti
   - For opencode: Ziti service proxies the opencode HTTP port directly

2. **Local ralph-uv** (existing, enhanced):
   - Dual-mode session spawning: tmux for claude, opencode serve for opencode
   - When a remote loop is started, registers it in local SQLite with connection info
   - `ralph-uv attach` dispatches:
     - Claude local: `tmux attach -t <name>`
     - Claude remote: proxy tmux over Ziti
     - OpenCode local: `opencode attach http://localhost:<port>`
     - OpenCode remote: `opencode attach http://<ziti-proxy>:<port>`
   - `ralph-uv status` shows all loops regardless of location/agent type

3. **Ralph-tui** (existing, enhanced):
   - Reads loops from SQLite (already does this)
   - For opencode loops: spawns/embeds opencode TUI via `opencode attach <url>`
   - For claude loops: tmux pipe-pane (existing) or tmux socket proxy (remote)
   - No awareness of remote vs local needed in the UI beyond a location indicator

4. **OpenZiti overlay**:
   - Handles encryption, mutual auth, NAT traversal
   - Remote daemon binds to Ziti services:
     - One service for daemon control RPC (start/stop/status)
     - Per-loop services for opencode HTTP ports (or one service with port routing)
   - Local clients dial the Ziti service
   - Identity files manually provisioned via Ziti admin console

## Resolved Questions (Round 2)

- **SDK:** Python SDK (`openziti`) for everything — both server-side (ralph-uv daemon) and client-side (ralph-tui will need a Python proxy/bridge, or ralph-uv attach becomes the primary client)
- **Daemon vs loop runner:** Separate process. Daemon listens for requests, spawns loop runner subprocesses.
- **Concurrent loops:** Separate checkouts of the base branch per loop, same model as local concurrent loops.
- **Identity provisioning:** Manual — user creates identities in Ziti admin console, provides identity file to ralph-uv config. SDK just needs to load the identity JSON/JWT.

## Remote Environment Bootstrapping

When a job is sent to a remote machine, the following must happen before the loop can start:

### Code Sync Flow
1. Local machine creates the branch and pushes to origin (so it's backed up)
2. Local machine pushes the branch to a bare repo on the remote (via git push over Ziti or SSH)
3. Remote daemon checks out the branch into a working directory (separate checkout per loop)

### Agent CLI Auto-Install
- Daemon checks if the requested agent CLI (`claude` or `opencode`) is installed
- If missing, installs it automatically (one-time per agent type)
- User's API keys / claude auth are pre-configured manually on the remote

### Project Dependencies ("Task 0")
- First iteration of the loop is effectively "task 0": install project deps
- The agent discovers lockfiles (package.json, Cargo.toml, pyproject.toml, etc.) which may not be in the repo root
- Agent runs appropriate install commands (npm install, cargo build, pip install, etc.)
- This happens naturally as part of the first story's acceptance criteria (e.g., "Typecheck passes" will fail until deps are installed)

### Manual One-Time Setup (per remote machine)
- Install: git, jq, python 3.12+, bash
- Authenticate: `claude` CLI login, or set API keys for opencode
- Install: ralph-uv daemon
- Configure: OpenZiti identity file
- Set up: bare git repo directory for receiving pushes

### What Gets Synced With the Code
- The git repo includes: prd.json, prompt.md, agents/ scripts, AGENTS.md
- These are part of the repo, so they arrive via git push automatically
- No separate file sync needed for ralph infrastructure files

## Lifecycle: Loop Completion

- **Local loops:** Loop runner marks its own session as `completed`/`failed` in SQLite (existing behavior).
- **Remote loops:** Remote daemon pushes a completion event over Ziti. Local SQLite is updated to `completed`/`failed`.
- **Records are never deleted** — just marked with terminal status.
- **Edge case:** If no client is actively connected when a remote loop finishes, the local SQLite may be stale. On next `attach` or `status`, the client should reconcile with the remote daemon.

## Open Questions

- How does ralph-tui (Rust) embed/spawn opencode TUI? Options: fork/exec `opencode attach <url>`, embed via PTY, or reimplement in Rust.
- What does the daemon's "start loop" API look like? (task dir, git repo URL, branch, max iterations, agent type, etc.)
- Should each remote opencode loop get its own Ziti service (one per HTTP port), or one service per daemon with port routing?
- How to handle opencode server port allocation? Options: random port from range, sequential from 4096, per-task fixed port.
- How to detect opencode server health from ralph-uv? `GET /global/health` is the obvious choice, but what about startup race conditions?
- Should ralph-uv use the opencode JS SDK (via subprocess/bridge) or make raw HTTP requests to the opencode server?
- How does ralph-uv send the loop prompt to opencode? Options: `POST /session/:id/message` (sync, blocks until done) vs `POST /session/:id/prompt_async` (async, monitor via SSE).
- For claude remote loops: (a) proxy tmux server socket over Ziti, (b) SSH-over-Ziti tunnel, (c) capture-pane streaming?
- How does opencode server handle the ralph prompt.md / AGENTS.md? Does it read them from the working directory automatically, or do they need to be passed via the API?

## Merge Target

None - this is an investigation/feasibility study. Results inform future implementation work.
