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

# Default command - can be overridden
CMD ["/bin/bash"]
