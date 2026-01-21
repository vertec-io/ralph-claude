#!/bin/bash
# OpenCode CLI wrapper script for Ralph agent abstraction
# Accepts prompt via stdin, outputs to stdout
#
# Usage: echo "prompt" | ./opencode.sh [options]
#
# Environment variables:
#   MODEL                  - Model to use in provider/model format (e.g., "anthropic/claude-sonnet-4")
#   RALPH_VERBOSE          - Set to "true" for verbose output
#   OUTPUT_FORMAT          - Output format: "json" or "default" (default: "default")
#   RALPH_OPENCODE_SERVE   - Set to "true" to enable server mode for remote attachment
#   RALPH_OPENCODE_PORT    - Port for opencode serve (default: 4096)
#   RALPH_OPENCODE_HOSTNAME - Hostname for opencode serve (default: "0.0.0.0" for remote access)
#
# Server Mode:
#   When RALPH_OPENCODE_SERVE=true, this script will:
#   1. Start `opencode serve` in the background (if not already running)
#   2. Use `opencode run --attach` to connect to the server for each request
#   3. Remote clients can connect via: opencode attach http://hostname:port
#
# Required API key environment variables (set based on provider):
#   ANTHROPIC_API_KEY      - Required for Anthropic models (claude-sonnet-4, claude-haiku, etc.)
#   OPENAI_API_KEY         - Required for OpenAI models (gpt-4, gpt-4o, etc.)
#   AWS_ACCESS_KEY_ID      - Required for Amazon Bedrock models
#   AWS_SECRET_ACCESS_KEY  - Required for Amazon Bedrock models
#   GOOGLE_APPLICATION_CREDENTIALS - Required for Google Vertex AI models
#   GOOGLE_CLOUD_PROJECT   - Required for Google Vertex AI models
#
# Note: OpenCode stores credentials in ~/.local/share/opencode/auth.json
# You can also authenticate via the `/connect` command in interactive mode.
# See https://opencode.ai/docs/providers/ for full provider documentation.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source common utilities
source "$SCRIPT_DIR/common.sh"

# ============================================================================
# Configuration
# ============================================================================

# Default output format
OUTPUT_FORMAT="${OUTPUT_FORMAT:-default}"

# Verbose output
VERBOSE="${RALPH_VERBOSE:-false}"

# Model selection (OpenCode supports provider/model format)
MODEL="${MODEL:-}"

# Server mode configuration
OPENCODE_SERVE="${RALPH_OPENCODE_SERVE:-false}"
OPENCODE_PORT="${RALPH_OPENCODE_PORT:-4096}"
OPENCODE_HOSTNAME="${RALPH_OPENCODE_HOSTNAME:-0.0.0.0}"

# PID file for tracking server process
OPENCODE_PID_FILE="${OPENCODE_PID_FILE:-/tmp/opencode-serve.pid}"

# Server URL for attach mode
OPENCODE_SERVER_URL="http://${OPENCODE_HOSTNAME}:${OPENCODE_PORT}"

# Yolo mode - permissive permissions (skip all prompts)
YOLO_MODE="${YOLO_MODE:-false}"
if [ "$YOLO_MODE" = "true" ]; then
  # Set OPENCODE_PERMISSION with permissive JSON to allow all operations
  export OPENCODE_PERMISSION='{"*": "allow", "external_directory": "allow", "doom_loop": "allow"}'
fi

# ============================================================================
# Server mode functions
# ============================================================================

# Check if opencode serve is already running
is_server_running() {
  if [ -f "$OPENCODE_PID_FILE" ]; then
    local pid
    pid=$(cat "$OPENCODE_PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    else
      # Stale PID file, clean up
      rm -f "$OPENCODE_PID_FILE"
    fi
  fi
  return 1
}

# Start opencode serve in background
start_server() {
  if is_server_running; then
    if [ "$VERBOSE" = "true" ]; then
      log_info "OpenCode server already running on port $OPENCODE_PORT"
    fi
    return 0
  fi

  log_info "Starting OpenCode server on $OPENCODE_HOSTNAME:$OPENCODE_PORT..."
  
  local serve_args=("--port" "$OPENCODE_PORT" "--hostname" "$OPENCODE_HOSTNAME")
  
  if [ "$VERBOSE" = "true" ]; then
    serve_args+=("--print-logs" "--log-level" "DEBUG")
  fi

  # Start server in background, redirect output to log file
  local log_file="/tmp/opencode-serve.log"
  opencode serve "${serve_args[@]}" > "$log_file" 2>&1 &
  local server_pid=$!
  
  # Save PID for later cleanup
  echo "$server_pid" > "$OPENCODE_PID_FILE"
  
  # Wait for server to start (check if port is listening)
  local max_wait=10
  local waited=0
  while [ $waited -lt $max_wait ]; do
    if curl -s "http://localhost:$OPENCODE_PORT" > /dev/null 2>&1; then
      log_info "OpenCode server started successfully (PID: $server_pid)"
      return 0
    fi
    sleep 0.5
    waited=$((waited + 1))
  done
  
  # Check if process is still alive
  if ! kill -0 "$server_pid" 2>/dev/null; then
    log_error "OpenCode server failed to start. Check $log_file for details."
    rm -f "$OPENCODE_PID_FILE"
    return 1
  fi
  
  log_warn "OpenCode server may not be ready yet, but process is running (PID: $server_pid)"
  return 0
}

# Stop opencode serve
stop_server() {
  if [ -f "$OPENCODE_PID_FILE" ]; then
    local pid
    pid=$(cat "$OPENCODE_PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      log_info "Stopping OpenCode server (PID: $pid)..."
      kill "$pid" 2>/dev/null
      rm -f "$OPENCODE_PID_FILE"
    fi
  fi
}

# ============================================================================
# Build command arguments
# ============================================================================

build_opencode_args() {
  local args=()

  # Handle output format
  case "$OUTPUT_FORMAT" in
    json)
      args+=("--format" "json")
      ;;
    default|*)
      args+=("--format" "default")
      ;;
  esac

  # Model selection
  if [ -n "$MODEL" ]; then
    args+=("--model" "$MODEL")
  fi

  # Verbose mode - use print-logs for debug output
  if [ "$VERBOSE" = "true" ]; then
    args+=("--print-logs")
    args+=("--log-level" "DEBUG")
  fi

  echo "${args[@]}"
}

# ============================================================================
# Main execution
# ============================================================================

main() {
  # Read prompt from stdin
  local prompt=""
  if [ ! -t 0 ]; then
    prompt=$(cat)
  fi

  if [ -z "$prompt" ]; then
    log_error "No prompt provided via stdin"
    echo "Usage: echo 'your prompt' | $0" >&2
    exit 1
  fi

  # Build command arguments
  local args
  args=$(build_opencode_args)

  # Log invocation if verbose
  if [ "$VERBOSE" = "true" ]; then
    log_info "Invoking OpenCode CLI with args: $args"
    log_info "Model: ${MODEL:-default}"
    log_info "Server mode: $OPENCODE_SERVE"
  fi

  # Server mode: start server and use --attach
  if [ "$OPENCODE_SERVE" = "true" ]; then
    if ! start_server; then
      log_error "Failed to start OpenCode server, falling back to direct execution"
      # Fall through to direct execution
    else
      # Use --attach to connect to the running server
      local attach_url="http://localhost:$OPENCODE_PORT"
      if [ "$VERBOSE" = "true" ]; then
        log_info "Using server mode: attaching to $attach_url"
      fi
      # Pipe prompt via stdin - much faster than CLI args for large prompts
      # shellcheck disable=SC2086
      echo "$prompt" | opencode run $args --attach "$attach_url"
      return $?
    fi
  fi

  # Direct execution (default mode or fallback)
  # Pipe prompt via stdin - much faster than CLI args for large prompts
  # shellcheck disable=SC2086
  echo "$prompt" | opencode run $args
}

# Run main function
main "$@"
