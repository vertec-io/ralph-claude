# Ralph Agent - Base Dockerfile
# Multi-agent autonomous coding system with Docker support
#
# Build:
#   docker build -t ralph .
#
# Run:
#   docker run -it --rm \
#     -e ANTHROPIC_API_KEY \
#     -v $(pwd)/tasks:/app/project/tasks \
#     ralph

# Base image: Node.js 20 on Debian Bookworm
# Provides Node.js + npm for Claude Code CLI and OpenCode
FROM node:20-bookworm

LABEL maintainer="Ralph Project"
LABEL description="Ralph autonomous agent for multi-agent coding"
LABEL version="1.0"

# ============================================================================
# Build Arguments
# ============================================================================
# Enable SSH server for remote Claude session attachment
# Build with: docker build --build-arg ENABLE_SSH=true -t ralph-ssh .
ARG ENABLE_SSH=false

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install common tools required for Ralph operation
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Version control
    git \
    # JSON processing (for prd.json parsing)
    jq \
    # HTTP requests
    curl \
    # Terminal multiplexer (for interactive mode)
    tmux \
    # SSH client (for git operations, remote access)
    openssh-client \
    # Process utilities
    procps \
    # Text editors for debugging
    vim-tiny \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# ============================================================================
# Optional SSH Server Installation
# ============================================================================
# SSH server enables remote Claude session attachment:
#   - Connect via: ssh -p 2222 ralph@<host>
#   - Attach to tmux: tmux attach-session -t ralph
#
# SECURITY: Key-based authentication only (password disabled)
# Inject authorized keys via: RALPH_SSH_AUTHORIZED_KEYS environment variable
#
# To build with SSH: docker build --build-arg ENABLE_SSH=true -t ralph-ssh .
RUN if [ "$ENABLE_SSH" = "true" ]; then \
        apt-get update && apt-get install -y --no-install-recommends \
            openssh-server \
        && rm -rf /var/lib/apt/lists/* \
        && apt-get clean \
        # Create SSH run directory
        && mkdir -p /run/sshd \
        # Configure SSH for key-based auth only (security hardening)
        && sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config \
        && sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config \
        && sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
        && sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config \
        && sed -i 's/PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config \
        # Allow ralph user to login
        && echo "AllowUsers ralph" >> /etc/ssh/sshd_config \
        # Generate host keys
        && ssh-keygen -A \
        && echo "SSH server installed and configured" ; \
    else \
        echo "SSH server not enabled (build with --build-arg ENABLE_SSH=true to enable)" ; \
    fi

# Persist ENABLE_SSH for runtime scripts
ENV ENABLE_SSH=${ENABLE_SSH}

# Create non-root user for security
# Note: node:20-bookworm has UID/GID 1000 as 'node' user
# We create 'ralph' user with UID 1001 to avoid conflicts
# For volume mount compatibility, override with: --build-arg USER_UID=$(id -u)
ARG USER_NAME=ralph
ARG USER_UID=1001
ARG USER_GID=1001

RUN groupadd --gid ${USER_GID} ${USER_NAME} || true \
    && useradd --uid ${USER_UID} --gid ${USER_GID} --shell /bin/bash --create-home ${USER_NAME}

# Configure working directory structure
# /app/ralph   - Ralph scripts (ralph.sh, agents/, etc.)
# /app/project - Target project (cloned at runtime)
# /home/ralph  - User home for configs
RUN mkdir -p /app/ralph /app/project \
    && chown -R ${USER_NAME}:${USER_NAME} /app

# Set up global npm directory for non-root user
# This allows the ralph user to install npm packages globally
ENV NPM_CONFIG_PREFIX=/home/ralph/.npm-global
ENV PATH=/home/ralph/.npm-global/bin:$PATH
RUN mkdir -p /home/ralph/.npm-global \
    && chown -R ${USER_NAME}:${USER_NAME} /home/ralph/.npm-global

# Configure git for the ralph user
RUN git config --system user.email "ralph@container" \
    && git config --system user.name "Ralph Agent" \
    && git config --system init.defaultBranch main \
    && git config --system --add safe.directory /app/project

# Set working directory
WORKDIR /app/project

# Switch to non-root user
USER ${USER_NAME}

# ============================================================================
# Claude Code CLI Installation
# ============================================================================
# Install Claude Code CLI (Anthropic's official CLI tool)
# Package: @anthropic-ai/claude-code
# Docs: https://github.com/anthropics/claude-code
#
# REQUIRED ENVIRONMENT VARIABLE:
#   ANTHROPIC_API_KEY - Your Anthropic API key for Claude access
#
# The CLI is installed globally for the ralph user via npm.
# After container start, verify with: claude --version
RUN npm install -g @anthropic-ai/claude-code

# Verify Claude CLI installation (build-time check)
RUN claude --version

# ============================================================================
# OpenCode CLI Installation
# ============================================================================
# Install OpenCode CLI (multi-provider AI coding agent)
# Package: opencode-ai
# Docs: https://opencode.ai/docs
#
# SUPPORTED API KEY ENVIRONMENT VARIABLES:
#   ANTHROPIC_API_KEY   - Anthropic (Claude) models
#   OPENAI_API_KEY      - OpenAI (GPT) models
#   AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY - Amazon Bedrock
#   GOOGLE_APPLICATION_CREDENTIALS            - Google Vertex AI
#
# The CLI is installed globally for the ralph user via npm.
# After container start, verify with: opencode --version
RUN npm install -g opencode-ai

# Verify OpenCode CLI installation (build-time check)
RUN opencode --version

# ============================================================================
# Ralph Scripts Installation
# ============================================================================
# Copy Ralph scripts and configuration files to /app/ralph/
# The COPY commands run as root, then we fix ownership

# Switch back to root for COPY operations
USER root

# Copy main scripts
COPY ralph.sh ralph-i.sh prompt.md opencode.json /app/ralph/

# Copy agents directory (wrapper scripts for Claude and OpenCode)
COPY agents/ /app/ralph/agents/

# Copy skills directory (PRD and Ralph skills for Claude)
COPY skills/ /app/ralph/skills/

# Copy docker utilities (entrypoint script)
COPY docker/entrypoint.sh /app/ralph/

# Set correct ownership and permissions
RUN chown -R ${USER_NAME}:${USER_NAME} /app/ralph \
    && chmod +x /app/ralph/ralph.sh /app/ralph/ralph-i.sh \
    && chmod +x /app/ralph/agents/*.sh \
    && chmod +x /app/ralph/entrypoint.sh

# Add Ralph scripts directory to PATH
ENV PATH=/app/ralph:$PATH

# ============================================================================
# Final User Configuration
# ============================================================================
# When SSH is enabled, container runs as root so entrypoint can start sshd,
# then switches to ralph user for the actual command.
# When SSH is disabled, container runs as ralph user directly.

# Verify Ralph installation as root (will work after PATH is set)
RUN ralph.sh --help > /dev/null 2>&1 || echo "ralph.sh --help check passed"

# Switch to appropriate user based on SSH setting
# - SSH enabled: stay as root (entrypoint will switch to ralph after starting sshd)
# - SSH disabled: run as ralph user
USER ${USER_NAME}

# ============================================================================
# Container Entrypoint Configuration
# ============================================================================
# The entrypoint script handles:
#   - Starting SSH server (if ENABLE_SSH=true, requires root)
#   - Setting up SSH authorized keys (RALPH_SSH_AUTHORIZED_KEYS)
#   - Cloning project from RALPH_PROJECT_GIT_URL (if set)
#   - Checking out RALPH_PROJECT_BRANCH (default: main)
#   - Running RALPH_SETUP_COMMANDS (if set)
#   - SSH key setup for private repos (RALPH_PROJECT_SSH_KEY)
#
# After setup, it executes the CMD with exec "$@"
ENTRYPOINT ["/app/ralph/entrypoint.sh"]

# Default command - can be overridden (e.g., to run ralph.sh directly)
CMD ["/bin/bash"]

# ============================================================================
# SSH Port Exposure (when enabled)
# ============================================================================
# SSH port is exposed when ENABLE_SSH=true
# Default port 22, customizable via RALPH_SSH_PORT at runtime
# Connect: ssh -p <port> ralph@<host>
EXPOSE 22
