#!/bin/bash
# Claude Code CLI wrapper script for Ralph agent abstraction
# Accepts prompt via stdin, outputs to stdout
#
# Usage: echo "prompt" | ./claude.sh [options]
#
# Environment variables:
#   MODEL              - Model override (not currently supported by Claude CLI)
#   RALPH_VERBOSE      - Set to "true" for verbose output
#
# Supported options (via environment):
#   SKIP_PERMISSIONS   - Set to "true" to use --dangerously-skip-permissions
#   OUTPUT_FORMAT      - Output format: "stream-json" (default) or "text"

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source common utilities
source "$SCRIPT_DIR/common.sh"

# ============================================================================
# Configuration
# ============================================================================

# Default to skipping permissions for autonomous operation
SKIP_PERMISSIONS="${SKIP_PERMISSIONS:-true}"

# Default to stream-json output for status parsing
OUTPUT_FORMAT="${OUTPUT_FORMAT:-stream-json}"

# Verbose output
VERBOSE="${RALPH_VERBOSE:-false}"

# ============================================================================
# Build command arguments
# ============================================================================

build_claude_args() {
  local args=()

  # Always use --print for output to stdout
  args+=("--print")

  # Handle permissions flag
  if [ "$SKIP_PERMISSIONS" = "true" ]; then
    args+=("--dangerously-skip-permissions")
  fi

  # Handle output format
  case "$OUTPUT_FORMAT" in
    stream-json)
      args+=("--output-format" "stream-json")
      ;;
    text|*)
      # Default text output, no special flag needed
      ;;
  esac

  # Verbose mode
  if [ "$VERBOSE" = "true" ]; then
    args+=("--verbose")
  fi

  # Note: Claude CLI does not currently support model selection via command line
  # The MODEL environment variable is ignored but documented for future compatibility
  if [ -n "${MODEL:-}" ]; then
    log_warn "MODEL environment variable set but Claude CLI does not support model selection"
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
  args=$(build_claude_args)

  # Log invocation if verbose
  if [ "$VERBOSE" = "true" ]; then
    log_info "Invoking Claude CLI with args: $args"
  fi

  # Execute claude with prompt from stdin
  # shellcheck disable=SC2086
  echo "$prompt" | claude $args
}

# Run main function
main "$@"
