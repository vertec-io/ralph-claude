# Remote Execution with Docker

Ralph can run in a Docker container for remote, isolated execution. This guide covers building, running, and interacting with Ralph in Docker.

## Table of Contents

- [Quick Start](#quick-start)
- [Docker Build](#docker-build)
- [Docker Run](#docker-run)
- [Docker Compose Workflow](#docker-compose-workflow)
- [Environment Variables](#environment-variables)
- [SSH Access for Claude Sessions](#ssh-access-for-claude-sessions)
- [OpenCode Attach Workflow](#opencode-attach-workflow)
- [Status API](#status-api)
- [Troubleshooting](#troubleshooting)

## Quick Start

```bash
# 1. Copy the environment template and fill in your API key
cp docker/.env.example .env
# Edit .env and set ANTHROPIC_API_KEY

# 2. Build and run
docker-compose up --build

# 3. In another terminal, execute Ralph
docker-compose exec ralph ralph.sh tasks/my-task
```

## Docker Build

### Basic Build

```bash
docker build -t ralph .
```

### Build with SSH Server

To enable SSH access for remote Claude session attachment:

```bash
docker build --build-arg ENABLE_SSH=true -t ralph-ssh .
```

### Build Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `ENABLE_SSH` | `false` | Install and configure SSH server |
| `USER_UID` | `1001` | UID for the ralph user (for volume permissions) |
| `USER_GID` | `1001` | GID for the ralph user |

**Example with custom UID for volume compatibility:**

```bash
docker build \
  --build-arg USER_UID=$(id -u) \
  --build-arg USER_GID=$(id -g) \
  -t ralph .
```

## Docker Run

### Basic Run

```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY \
  -v $(pwd)/tasks:/app/project/tasks \
  ralph
```

This starts an interactive shell. Run Ralph commands manually:

```bash
ralph.sh tasks/my-task
```

### Run a Specific Task

```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY \
  -v $(pwd)/tasks:/app/project/tasks \
  ralph \
  ralph.sh tasks/my-task 10
```

### Clone a Project from Git

```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY \
  -e RALPH_PROJECT_GIT_URL=https://github.com/your-org/your-repo.git \
  -e RALPH_PROJECT_BRANCH=main \
  -e RALPH_SETUP_COMMANDS="npm install" \
  ralph \
  ralph.sh tasks/my-task
```

### Run with OpenCode Agent

```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY \
  -e RALPH_AGENT=opencode \
  -v $(pwd)/tasks:/app/project/tasks \
  ralph \
  ralph.sh tasks/my-task --agent opencode
```

## Docker Compose Workflow

Docker Compose provides easier configuration management and persistent containers.

### Setup

```bash
# 1. Copy environment template
cp docker/.env.example .env

# 2. Edit .env with your settings
nano .env  # Set at least ANTHROPIC_API_KEY
```

### Common Commands

```bash
# Build the image
docker-compose build

# Start container in background
docker-compose up -d

# View logs
docker-compose logs -f ralph

# Open a shell in the container
docker-compose exec ralph bash

# Run Ralph on a task
docker-compose exec ralph ralph.sh tasks/my-task

# Run Ralph in interactive mode
docker-compose exec ralph ralph-i.sh tasks/my-task

# Stop and remove container
docker-compose down
```

### Using Git Clone Mode

Set these in your `.env`:

```bash
RALPH_PROJECT_GIT_URL=https://github.com/your-org/your-repo.git
RALPH_PROJECT_BRANCH=feature-branch
RALPH_SETUP_COMMANDS=npm install
```

Then:

```bash
docker-compose up -d
docker-compose exec ralph ralph.sh tasks/my-task
```

### Using Volume Mount Mode

Comment out `RALPH_PROJECT_GIT_URL` and mount your project:

```yaml
# In docker-compose.yml, replace the volumes section:
volumes:
  - .:/app/project:rw
```

## Environment Variables

### API Keys

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes (for Claude) | Anthropic API key |
| `OPENAI_API_KEY` | No | OpenAI API key (for OpenCode with GPT models) |
| `AWS_ACCESS_KEY_ID` | No | AWS credentials (for OpenCode with Bedrock) |
| `AWS_SECRET_ACCESS_KEY` | No | AWS credentials |
| `AWS_DEFAULT_REGION` | No | AWS region (default: us-east-1) |
| `GOOGLE_APPLICATION_CREDENTIALS` | No | Path to Google Cloud credentials JSON |

### Project Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RALPH_PROJECT_GIT_URL` | (empty) | Git URL to clone |
| `RALPH_PROJECT_BRANCH` | `main` | Branch to checkout |
| `RALPH_SETUP_COMMANDS` | (empty) | Commands to run after clone (e.g., `npm install`) |
| `RALPH_PROJECT_SSH_KEY` | (empty) | SSH private key for private repos |

### Ralph Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RALPH_AGENT` | `claude` | Default agent: `claude` or `opencode` |
| `RALPH_FAILOVER_THRESHOLD` | `3` | Failures before switching agents |
| `RALPH_OPENCODE_SERVE` | `false` | Enable OpenCode server mode |
| `RALPH_OPENCODE_PORT` | `4096` | OpenCode server port |
| `RALPH_STATUS_PORT` | `8080` | Status API HTTP port |

### SSH Server (when built with `ENABLE_SSH=true`)

| Variable | Default | Description |
|----------|---------|-------------|
| `RALPH_SSH_AUTHORIZED_KEYS` | (empty) | SSH public key(s) for access |
| `RALPH_SSH_PORT` | `2222` | Host port mapped to container SSH |
| `ENABLE_SSH` | `false` | Set at build time |

## SSH Access for Claude Sessions

SSH access allows you to attach to running Claude/tmux sessions from a remote machine.

### Setup

1. **Build with SSH enabled:**

   ```bash
   docker build --build-arg ENABLE_SSH=true -t ralph-ssh .
   ```

   Or with docker-compose:

   ```bash
   ENABLE_SSH=true docker-compose build
   ```

2. **Configure authorized keys in `.env`:**

   ```bash
   RALPH_SSH_AUTHORIZED_KEYS="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5... user@host"
   ```

   Get your public key with:
   ```bash
   cat ~/.ssh/id_ed25519.pub
   # or
   cat ~/.ssh/id_rsa.pub
   ```

3. **Start the container:**

   ```bash
   docker-compose up -d
   ```

### Connect and Attach

```bash
# SSH into the container (default port 2222)
ssh -p 2222 ralph@localhost

# Inside the container, list Ralph sessions
ralph-attach.sh

# Or attach to tmux directly
tmux list-sessions
tmux attach-session -t ralph-xxx
```

### Remote Access

From a remote machine:

```bash
# SSH to the Docker host, then to the container
ssh user@docker-host
ssh -p 2222 ralph@localhost

# Or use SSH port forwarding
ssh -L 2222:localhost:2222 user@docker-host
# Then from your local machine:
ssh -p 2222 ralph@localhost
```

### Using ralph-attach.sh

The `ralph-attach.sh` helper script simplifies finding and attaching to Ralph tmux sessions:

```bash
# List all Ralph sessions and auto-attach if only one
ralph-attach.sh

# Attach to a specific session by number
ralph-attach.sh 1

# Attach to a specific session by name
ralph-attach.sh ralph-12345-3
```

**Tip:** Press `Ctrl+B, D` to detach from a tmux session without stopping it.

## OpenCode Attach Workflow

OpenCode supports a server mode for remote TUI attachment, allowing you to view and interact with the agent from another machine.

### Enable Server Mode

Set in your `.env`:

```bash
RALPH_OPENCODE_SERVE=true
RALPH_OPENCODE_PORT=4096
```

Or pass directly:

```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY \
  -e RALPH_AGENT=opencode \
  -e RALPH_OPENCODE_SERVE=true \
  -p 4096:4096 \
  -v $(pwd)/tasks:/app/project/tasks \
  ralph \
  ralph.sh tasks/my-task
```

### Connect from Remote Client

From another machine with OpenCode installed:

```bash
# Attach to the running OpenCode session
opencode attach http://docker-host:4096
```

This gives you a full TUI experience for the remote agent session.

### How It Works

1. When `RALPH_OPENCODE_SERVE=true`, the OpenCode agent wrapper starts `opencode serve` in the background
2. Each Ralph iteration uses `opencode run --attach http://localhost:4096` to connect
3. Remote clients can attach with `opencode attach http://host:4096`
4. Multiple clients can observe the same session

## Status API

Ralph includes an HTTP status API for monitoring task progress.

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Full task status (JSON) |
| `GET /status` | Full task status (alias) |
| `GET /health` | Health check |

### Example Response

```json
{
  "task": "device-system-refactor",
  "description": "Refactor device system for better modularity",
  "branch": "ralph/device-system-refactor",
  "agent": "claude",
  "iteration": 5,
  "stories": {
    "complete": 3,
    "total": 8,
    "progress": "37.5%"
  },
  "currentStory": {
    "id": "US-004",
    "title": "Extract device types"
  },
  "status": "running",
  "lastUpdate": "2024-01-15T10:30:00Z"
}
```

### Access the API

```bash
# From the host
curl http://localhost:8080/status

# Health check
curl http://localhost:8080/health
```

### Configuration

Set the port in `.env`:

```bash
RALPH_STATUS_PORT=8080
```

The status API starts automatically when the container has a task directory with a `prd.json` file.

## Troubleshooting

### Permission Denied on Volume Mounts

If you get permission errors when Ralph writes to mounted volumes:

```bash
# Build with matching UID/GID
docker build \
  --build-arg USER_UID=$(id -u) \
  --build-arg USER_GID=$(id -g) \
  -t ralph .
```

Or add to `.env`:

```bash
USER_UID=1000
USER_GID=1000
```

### SSH Connection Refused

1. Ensure the image was built with `ENABLE_SSH=true`
2. Check that `RALPH_SSH_AUTHORIZED_KEYS` is set correctly
3. Verify the port mapping: host port 2222 maps to container port 22

```bash
# Check if sshd is running
docker-compose exec ralph ps aux | grep sshd

# Check SSH logs
docker-compose exec ralph cat /var/log/auth.log
```

### OpenCode Server Won't Start

1. Check the server log:

   ```bash
   docker-compose exec ralph cat /tmp/opencode-serve.log
   ```

2. Verify the port isn't already in use:

   ```bash
   docker-compose exec ralph netstat -tlnp | grep 4096
   ```

3. Try restarting the server:

   ```bash
   docker-compose exec ralph pkill -f "opencode serve"
   # Server will restart on next Ralph iteration
   ```

### Status API Returns No Data

1. Ensure `RALPH_TASK_DIR` is set or a task directory exists with `prd.json`
2. Check the status API log:

   ```bash
   docker-compose exec ralph cat /tmp/ralph-status.log
   ```

### Container Exits Immediately

Check that you're using interactive mode:

```bash
# Use -it for interactive
docker run -it --rm ralph bash

# Or with docker-compose, ensure stdin_open and tty are set
docker-compose exec ralph bash
```

### Git Clone Fails

1. For HTTPS repos, ensure the URL is correct
2. For SSH repos, ensure `RALPH_PROJECT_SSH_KEY` contains the private key:

   ```bash
   # Base64 encode your key (recommended for multi-line)
   cat ~/.ssh/id_rsa | base64 -w0
   ```

3. Check the entrypoint logs:

   ```bash
   docker-compose logs ralph | grep -i "clone\|git"
   ```
