# Remote Environment Bootstrapping Design

## Overview

This document defines how a remote machine receives code, agent CLIs, and project dependencies when a job is dispatched to it via `ralph-uv start-remote`. The bootstrapping flow is designed to minimize manual setup while ensuring reproducibility.

---

## 1. Code Sync Flow

### Strategy: Push to Origin, Fetch on Remote

The client pushes to the shared git origin (GitHub/GitLab), and the remote daemon fetches from there. This avoids implementing git-over-Ziti and leverages existing SSH/HTTPS git auth that's already configured on the remote.

### Sequence

```
LOCAL MACHINE                              REMOTE MACHINE (daemon)
─────────────                              ───────────────────────

1. Validate branch has no uncommitted changes
2. git push origin <branch> --force-with-lease
3. Dial ralph-control-<remote> via Ziti
4. Send start_loop RPC:
   {
     origin_url: "git@github.com:user/project.git",
     branch: "ralph/my-feature",
     task_dir: "tasks/my-feature",
     ...
   }
                                           5. Resolve workspace:
                                              ~/ralph-workspaces/<project>/
                                           6. If bare.git doesn't exist:
                                              git clone --bare <origin_url> bare.git
                                           7. cd bare.git && git fetch origin <branch>
                                           8. Create worktree checkout:
                                              git worktree add \
                                                ../checkouts/<task>-<uuid> \
                                                <branch>
                                           9. Return success + checkout path
```

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| Push to origin first | Avoids git-over-Ziti complexity. Origin already has SSH/HTTPS auth. |
| `--force-with-lease` on push | Safe force push for ralph branches (they're owned by the agent) |
| Bare repo per project | Efficient fetch (no working tree), supports multiple worktrees |
| Worktree per loop | True isolation (separate HEAD, index, working tree) |
| UUID suffix on checkout | Prevents collisions when same task runs multiple times |

### Git Auth on Remote

The remote machine must have git auth configured to fetch from the origin. Options:
- **SSH key**: `~/.ssh/id_ed25519` authorized on GitHub/GitLab
- **SSH agent**: Persistent agent with key loaded
- **HTTPS credential helper**: `git credential-store` or `gh auth setup-git`
- **Deploy key**: Read-only key scoped to the repository

The daemon does NOT store git credentials — it relies on the system's git configuration.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Origin unreachable | Daemon returns error: "Failed to fetch: <git error>" |
| Branch doesn't exist on origin | Client push step fails before RPC is sent |
| Bare repo exists, new project URL | Error: origin URL mismatch. User must clean workspace. |
| Stale worktree from crashed loop | Daemon prunes on startup: `git worktree prune` |
| Force push needed | `--force-with-lease` handles this; ralph branches are agent-owned |
| Large repos (first clone) | May take minutes. Daemon streams progress back or times out (10min) |

### Workspace Directory Structure

```
~/ralph-workspaces/
├── project-name/                    # One per origin repo
│   ├── bare.git/                    # Bare repo (fetch target)
│   │   ├── HEAD
│   │   ├── config                   # Has remote "origin" configured
│   │   └── ...
│   └── checkouts/
│       ├── my-feature-a1b2c3/       # Active worktree (loop running)
│       ├── fix-bug-d4e5f6/          # Another active worktree
│       └── old-task-g7h8i9/         # Completed (cleanup candidate)
└── another-project/
    ├── bare.git/
    └── checkouts/
```

### Project Name Resolution

The daemon derives the project name from the origin URL:
```python
def project_name_from_url(origin_url: str) -> str:
    """Extract project name from git URL.
    
    git@github.com:user/project.git  -> project
    https://github.com/user/project  -> project
    """
    # Strip .git suffix, take last path component
    path = origin_url.rstrip("/").rsplit("/", 1)[-1]
    return path.removesuffix(".git")
```

---

## 2. Agent CLI Auto-Install

### Strategy: Check First, Install on Demand

The daemon checks for agent binaries before starting a loop. If missing, it attempts automatic installation. If auto-install fails, it returns an informative error.

### Install Methods

| Agent | Check | Install Command | Runtime Deps |
|-------|-------|-----------------|--------------|
| `claude` | `which claude` | `npm install -g @anthropic-ai/claude-code` | Node.js 18+ |
| `opencode` | `which opencode` | `curl -fsSL https://opencode.ai/install \| bash` | Go (bundled), bun (optional for dev) |

### Claude Code Installation Detail

```bash
# Prerequisite: Node.js 18+ and npm must be installed
# Check:
node --version  # >= v18.0.0
npm --version

# Install:
npm install -g @anthropic-ai/claude-code

# Verify:
claude --version

# Auth (manual, one-time):
claude auth login
# OR set ANTHROPIC_API_KEY in environment
```

**Node.js requirement**: Claude Code requires Node.js 18+. If node is not installed, the daemon cannot auto-install claude. It returns an error suggesting the user install Node.js first.

### OpenCode Installation Detail

```bash
# OpenCode is distributed as a standalone Go binary
# Install via official script:
curl -fsSL https://opencode.ai/install | bash

# This downloads the appropriate binary for the platform and places it in:
# - Linux: ~/.local/bin/opencode (or /usr/local/bin/opencode if root)
# - macOS: ~/bin/opencode (or /usr/local/bin/opencode if root)

# Verify:
opencode --version

# Runtime dependencies for opencode serve:
# - None (Go binary is self-contained)
# - Optional: bun (for LSP features in some projects)

# Auth:
# Set ANTHROPIC_API_KEY (for Claude models via opencode)
# OR set OPENAI_API_KEY (for OpenAI models via opencode)
```

**Key difference from claude**: OpenCode is a standalone binary with no runtime dependencies (no Node.js/bun needed for core operation). The `opencode serve` mode is fully self-contained.

### Daemon Auto-Install Flow

```python
def ensure_agent_available(agent: str) -> AgentInfo | AgentError:
    """Ensure the requested agent CLI is available.
    
    Returns AgentInfo with binary path and version, or AgentError with
    install instructions if auto-install fails.
    """
    # 1. Check if binary exists
    binary = shutil.which(agent)
    if binary:
        version = get_agent_version(agent)
        return AgentInfo(path=binary, version=version)
    
    # 2. Attempt auto-install
    log.info(f"Agent '{agent}' not found. Attempting auto-install...")
    
    if agent == "claude":
        if not shutil.which("node"):
            return AgentError(
                message=f"Agent 'claude' requires Node.js 18+. Install Node.js first.",
                install_hint="curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -"
            )
        result = subprocess.run(
            ["npm", "install", "-g", "@anthropic-ai/claude-code"],
            capture_output=True, text=True, timeout=120
        )
        if result.returncode != 0:
            return AgentError(
                message=f"Auto-install failed: {result.stderr}",
                install_hint="npm install -g @anthropic-ai/claude-code"
            )
    
    elif agent == "opencode":
        result = subprocess.run(
            ["bash", "-c", "curl -fsSL https://opencode.ai/install | bash"],
            capture_output=True, text=True, timeout=120
        )
        if result.returncode != 0:
            return AgentError(
                message=f"Auto-install failed: {result.stderr}",
                install_hint="curl -fsSL https://opencode.ai/install | bash"
            )
    
    # 3. Verify installation
    binary = shutil.which(agent)
    if not binary:
        return AgentError(
            message=f"Agent '{agent}' still not found after install attempt.",
            install_hint=f"Install manually and ensure it's in PATH."
        )
    
    version = get_agent_version(agent)
    return AgentInfo(path=binary, version=version)
```

### Error Response to Client

When auto-install fails, the daemon returns a structured error:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32001,
    "message": "Agent 'claude' requires Node.js 18+. Install Node.js first.",
    "data": {
      "agent": "claude",
      "available_agents": ["opencode"],
      "install_hint": "curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -",
      "auto_install_attempted": true
    }
  }
}
```

---

## 3. Task 0: Project Dependency Installation

### Strategy: Agent-Driven, Not Daemon-Driven

The first iteration naturally handles dependency installation. The agent (claude or opencode) is given a prompt that includes a "first-run setup" instruction. This keeps the daemon simple and leverages the agent's ability to detect and install deps.

### Why Agent-Driven?

| Approach | Pros | Cons |
|----------|------|------|
| **Daemon installs deps** | Faster (no agent overhead) | Must detect package managers, handle monorepos, custom setups |
| **Agent installs deps** | Handles any project structure, follows README | Uses one iteration, slightly slower |

The agent-driven approach wins because:
1. Projects have diverse dependency patterns (monorepos, custom scripts, docker-compose, etc.)
2. The agent can read README.md/CONTRIBUTING.md for setup instructions
3. No daemon code to maintain for every package manager
4. If deps are already installed (cached), the agent skips straight to stories

### Prompt Integration

The prompt.md template includes a conditional section for remote execution:

```markdown
## First-Run Setup (Remote Execution)

This loop is running on a remote machine. Before starting on stories:

1. Check if project dependencies are already installed (e.g., node_modules/, .venv/, vendor/)
2. If dependencies are missing, look for lockfiles and install:
   - package-lock.json / yarn.lock / pnpm-lock.yaml → npm/yarn/pnpm install
   - requirements.txt / pyproject.toml / uv.lock → pip install / uv sync
   - go.mod → go mod download
   - Cargo.lock → cargo fetch
   - Gemfile.lock → bundle install
3. Check for any project-specific setup (e.g., .env.example → .env, database migrations)
4. After setup is complete, proceed to the first story normally.

If you encounter setup issues, document them in progress.txt and proceed to stories.
```

### How Task 0 Works in Practice

```
Iteration 1 (on fresh remote checkout):
├── Agent reads prd.json → finds US-001 (highest priority, passes: false)
├── Agent checks progress.txt → no prior progress
├── Agent sees "First-Run Setup" section in prompt
├── Agent detects no node_modules/ → runs `npm install`
├── Agent detects no .env → copies .env.example to .env
├── Agent proceeds to implement US-001
└── Normal iteration: implement, test, commit, update prd.json
```

If dependencies take too long and the agent times out, the next iteration picks up where it left off — deps are now installed, so it skips straight to the story.

### Dependency Caching

Worktrees from the same bare repo share git objects but NOT node_modules or .venv. However:
- If a worktree from the same project previously installed deps at the same versions, the OS-level package cache (npm/pip/cargo) speeds up subsequent installs.
- For truly fast fresh starts, the daemon could maintain a shared `node_modules` cache via `npm ci --cache ~/.npm`, but this is a future optimization.

---

## 4. Manual One-Time Setup per Remote Machine

### Required (Minimum Viable)

These must be done manually before the first `ralph-uv start-remote`:

| Step | Command | Purpose |
|------|---------|---------|
| 1. System packages | `sudo apt install git python3 python3-pip tmux` | Core tools |
| 2. Install ralph-uv | `pip install ralph-uv` or `uv tool install ralph-uv` | The daemon |
| 3. Enroll Ziti identity | Download .json from Ziti controller, `ziti enroll --jwt token.jwt` | Network access |
| 4. API key | `export ANTHROPIC_API_KEY=sk-...` in ~/.bashrc or systemd unit | Agent auth |
| 5. Agent auth (claude) | `claude auth login` | Claude-specific auth |
| 6. Git auth | SSH key or credential helper for origin access | Code fetch |
| 7. Start daemon | `ralphd --identity ~/.ziti/server.json` | Enable remote loops |

### Optional (Recommended)

| Step | Command | Purpose |
|------|---------|---------|
| Node.js 20 | `curl -fsSL https://deb.nodesource.com/setup_20.x \| sudo bash -` | For claude auto-install |
| systemd service | `sudo systemctl enable --now ralphd` | Auto-start on boot |
| uv | `curl -LsSf https://astral.sh/uv/install.sh \| sh` | Fast Python dep installs |
| Persistent env | API keys in `~/.config/ralph/env` loaded by daemon | Survives shell restarts |

### Daemon Systemd Unit

```ini
[Unit]
Description=Ralph Remote Daemon
After=network.target

[Service]
Type=simple
User=ralph
Environment="ANTHROPIC_API_KEY=sk-..."
Environment="PATH=/home/ralph/.local/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=/home/ralph/.local/bin/ralphd --identity /home/ralph/.ziti/server.json
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Daemon Environment File (Alternative)

Instead of hardcoding keys in the systemd unit:

```bash
# ~/.config/ralph/env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
RALPH_WORKSPACE_DIR=~/ralph-workspaces
RALPH_MAX_CONCURRENT_LOOPS=4
RALPH_ZITI_IDENTITY=~/.ziti/server.json
```

The daemon reads this file on startup:
```python
def load_env_file(path: Path = Path.home() / ".config/ralph/env") -> None:
    """Load environment variables from ralph env file."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())
```

### Validation Command

The daemon provides a self-check command:

```bash
$ ralphd check

Ralph Daemon - System Check
───────────────────────────
✓ Python 3.11.7
✓ git 2.43.0
✓ tmux 3.4
✓ Ziti identity: ~/.ziti/server.json (enrolled)
✓ Workspace dir: ~/ralph-workspaces/ (writable)
✓ ANTHROPIC_API_KEY: set (sk-ant-...****)
✗ Node.js: not found (optional, needed for claude auto-install)
✓ opencode: 0.2.1 (/home/ralph/.local/bin/opencode)
✗ claude: not found (can auto-install if Node.js is added)
✓ Git auth: SSH key found (~/.ssh/id_ed25519)

Status: Ready (with warnings)
  - Install Node.js 20 for claude agent support
```

---

## 5. Full start-remote Sequence

### User Command

```bash
ralph-uv start-remote tasks/my-feature --remote my-server -i 20 -a opencode
```

### Complete Flow (User Command to Loop Iteration 1)

```
TIME  LOCATION   ACTION
────  ────────   ──────

T+0s  LOCAL      User runs: ralph-uv start-remote tasks/my-feature --remote my-server

T+1s  LOCAL      CLI validates:
                   ├── tasks/my-feature/prd.json exists
                   ├── prd.json has branchName field
                   ├── "my-server" is in ~/.config/ralph/remotes.toml
                   └── Current branch matches prd.json branchName

T+2s  LOCAL      CLI ensures branch is pushed:
                   git push origin ralph/my-feature --force-with-lease
                   (fails if uncommitted changes → "Commit changes first")

T+3s  LOCAL      CLI loads Ziti client identity from remotes.toml
                   Dials: ralph-control-my-server

T+4s  REMOTE     Daemon receives start_loop RPC:
                   {
                     origin_url: "git@github.com:user/project.git",
                     branch: "ralph/my-feature",
                     task_dir: "tasks/my-feature",
                     max_iterations: 20,
                     agent: "opencode"
                   }

T+5s  REMOTE     Daemon resolves workspace:
                   project = "project"  (from origin_url)
                   workspace = ~/ralph-workspaces/project/

T+6s  REMOTE     Daemon checks bare repo:
                   IF ~/ralph-workspaces/project/bare.git exists:
                     Verify origin matches
                     git fetch origin ralph/my-feature
                   ELSE:
                     git clone --bare <origin_url> bare.git

T+10s REMOTE     Daemon creates worktree:
                   uuid = "a1b2c3"
                   git worktree add \
                     ~/ralph-workspaces/project/checkouts/my-feature-a1b2c3 \
                     ralph/my-feature

T+11s REMOTE     Daemon checks agent:
                   which opencode → /home/ralph/.local/bin/opencode ✓
                   (If missing: attempt auto-install → return error if fails)

T+12s REMOTE     Daemon registers Ziti service:
                   Service: "ralph-loop-my-feature-a1b2c3"
                   Bind to Ziti network

T+13s REMOTE     Daemon starts loop (agent=opencode):
                   ├── Start: opencode serve --port <auto>
                   │   cwd = ~/ralph-workspaces/project/checkouts/my-feature-a1b2c3
                   ├── Wait for health: GET /global/health → 200 OK
                   ├── Register in daemon's internal loop registry
                   └── Begin iteration loop (iteration 1)

T+14s REMOTE     Daemon sends start_loop response:
                   {
                     status: "started",
                     loop_id: "my-feature-a1b2c3",
                     ziti_service: "ralph-loop-my-feature-a1b2c3",
                     server_url: "http://ziti-intercept-host:14097"
                   }

T+15s LOCAL      CLI receives success response:
                   ├── Registers in local sessions.db:
                   │   INSERT INTO sessions (
                   │     task_name, task_dir, pid, agent, status,
                   │     session_type, transport, ziti_service,
                   │     ziti_identity, remote_host, server_url
                   │   ) VALUES (
                   │     'my-feature', 'tasks/my-feature', 0, 'opencode',
                   │     'running', 'opencode-server', 'ziti',
                   │     'ralph-loop-my-feature-a1b2c3',
                   │     '~/.ziti/client.json', 'my-server',
                   │     'http://ziti-intercept-host:14097'
                   │   )
                   └── Prints:
                       "Loop started on my-server (opencode)."
                       "  Attach: ralph-uv attach my-feature"
                       "  Status: ralph-uv status"

T+16s REMOTE     Loop iteration 1 begins:
                   ├── Agent reads prompt (includes "First-Run Setup" section)
                   ├── Agent detects missing node_modules/
                   ├── Agent runs: npm install
                   ├── Agent reads prd.json → picks US-001
                   ├── Agent implements US-001
                   ├── Agent runs typecheck/lint/test
                   ├── Agent commits: "feat: US-001 - Feature title"
                   ├── Agent updates prd.json: US-001.passes = true
                   └── Agent appends to progress.txt

T+5m  REMOTE     Loop iteration 2 begins:
                   ├── Agent reads prompt (no "First-Run Setup" needed — deps exist)
                   ├── Agent picks US-002
                   └── Normal iteration...
```

### Error Scenarios

| Error | When | Client sees |
|-------|------|-------------|
| Branch not pushed | T+2s | "Error: Branch 'ralph/my-feature' has uncommitted changes. Commit first." |
| Remote not found | T+3s | "Error: Remote 'my-server' not configured. Run: ralph-uv register-remote" |
| Ziti dial fails | T+3s | "Error: Cannot reach my-server. Is ralphd running?" |
| Origin fetch fails | T+6s | "Error: Daemon failed to fetch branch: Permission denied (publickey)" |
| Agent not available | T+11s | "Error: Agent 'opencode' not found on my-server. Install: curl ..." |
| Max concurrent loops | T+12s | "Error: my-server has 4/4 concurrent loops. Stop one first." |

### Git Commit Push-Back

After each iteration, the agent commits to the local worktree. These commits stay local on the remote until:
1. **Loop completes**: Daemon pushes the branch back to origin
2. **User requests**: `ralph-uv sync-remote my-feature` triggers push
3. **Automatic (configurable)**: Daemon pushes after every N iterations

```python
# In daemon loop runner, after successful iteration:
def _push_progress(self, checkout_dir: Path, branch: str) -> None:
    """Push committed work back to origin."""
    result = subprocess.run(
        ["git", "push", "origin", branch, "--force-with-lease"],
        cwd=checkout_dir,
        capture_output=True, text=True
    )
    if result.returncode != 0:
        log.warning(f"Push failed: {result.stderr}")
        # Non-fatal: work is still in the local checkout
```

Default behavior: push to origin after every successful iteration. This ensures the client can see progress and the work isn't lost if the remote crashes.

---

## 6. Daemon Configuration

### Config File: `~/.config/ralph/daemon.toml`

```toml
# Ralph daemon configuration

[daemon]
workspace_dir = "~/ralph-workspaces"
max_concurrent_loops = 4
loop_timeout_hours = 24
push_after_iterations = 1  # Push to origin every N iterations (0 = never)

[ziti]
identity = "~/.ziti/server.json"
control_service_prefix = "ralph-control"  # Suffix is hostname

[agents.claude]
auto_install = true  # Attempt npm install if missing
min_version = "1.0.0"  # Minimum acceptable version

[agents.opencode]
auto_install = true
min_version = "0.2.0"

[cleanup]
max_checkout_age_days = 7   # Remove checkouts older than this
max_workspace_gb = 50       # Warn if workspace exceeds this
prune_on_startup = true     # git worktree prune on daemon start
```

---

## 7. Security Considerations

| Concern | Mitigation |
|---------|------------|
| API keys on remote | Stored in env/systemd, never transmitted over Ziti |
| Git credentials | Standard SSH/credential helper, not managed by daemon |
| Code execution | Only from fetched git repos (origin URL validated) |
| Agent auto-install | Uses official install channels (npm registry, opencode.ai) |
| Workspace isolation | Separate worktrees, no shared mutable state between loops |
| Daemon privileges | Runs as unprivileged user, no root needed |
| Origin URL spoofing | Daemon can maintain an allowlist of permitted origins |

---

## 8. Future Enhancements

- **Shallow clones**: `git clone --depth 1` for large repos (trade-off: can't use git worktree with shallow)
- **Pre-built images**: Docker/Nix-based environments with deps pre-installed
- **Workspace sharing**: Symlink node_modules between same-project worktrees
- **Auto-scaling**: Cloud provider integration (spawn VMs, enroll Ziti, start daemon)
- **Binary caching**: Pre-download agent binaries as part of machine provisioning
- **Health monitoring**: Expose Prometheus metrics from daemon for alerting
