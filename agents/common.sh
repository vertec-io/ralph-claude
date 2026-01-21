#!/bin/bash
# Common utilities shared by agent wrapper scripts
# These functions handle error detection, output parsing, and shared configuration

# Exit on error by default (can be overridden by sourcing scripts)
set -e

# Get the directory where the agents are located
AGENTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ============================================================================
# Prompt Preprocessing
# ============================================================================

# Preprocess prompt to filter agent-specific sections
# Removes content intended for other agents, keeps content for the specified agent
#
# Conditional markers:
#   <!-- agent:claude --> ... content for Claude only ... <!-- /agent:claude -->
#   <!-- agent:opencode --> ... content for OpenCode only ... <!-- /agent:opencode -->
#
# Content outside agent markers is included for all agents.
#
# Usage: processed_prompt=$(preprocess_prompt "$prompt" "claude")
# Args:
#   $1 - The raw prompt text
#   $2 - The current agent name (e.g., "claude", "opencode")
# Returns: The processed prompt via stdout
preprocess_prompt() {
  local prompt="$1"
  local agent="$2"
  
  # List of all known agents for filtering
  local all_agents="claude opencode"
  
  # Start with the full prompt
  local result="$prompt"
  
  # For each agent, either keep their section or remove it
  for a in $all_agents; do
    if [ "$a" = "$agent" ]; then
      # Keep content for current agent: remove only the markers, keep the content
      # Pattern: <!-- agent:$agent --> content <!-- /agent:$agent -->
      # Replace with just: content
      result=$(echo "$result" | sed "s/<!-- agent:$a -->//g; s/<!-- \/agent:$a -->//g")
    else
      # Remove content for other agents: remove markers AND content between them
      # Use awk for multi-line removal
      result=$(echo "$result" | awk -v agent="$a" '
        BEGIN { skip = 0 }
        /<!-- agent:/ && $0 ~ "agent:" agent " -->" { skip = 1; next }
        /<!-- [/]agent:/ && $0 ~ "[/]agent:" agent " -->" { skip = 0; next }
        !skip { print }
      ')
    fi
  done
  
  echo "$result"
}

# ============================================================================
# Error Detection
# ============================================================================

# Check if output contains common error patterns
# Returns 0 (success) if errors found, 1 if no errors
# Usage: if detect_error_patterns "$output"; then echo "Error found"; fi
detect_error_patterns() {
  local output="$1"

  # Common error patterns to detect
  local patterns=(
    "Error:"
    "error:"
    "FATAL:"
    "fatal:"
    "Exception:"
    "Traceback"
    "panic:"
    "FAILED"
    "command not found"
    "No such file or directory"
    "Permission denied"
    "Connection refused"
    "rate limit"
    "quota exceeded"
    "API error"
    "authentication failed"
    "unauthorized"
  )

  for pattern in "${patterns[@]}"; do
    if echo "$output" | grep -qi "$pattern"; then
      return 0
    fi
  done

  return 1
}

# Extract error message from agent output
# Usage: error_msg=$(extract_error_message "$output")
extract_error_message() {
  local output="$1"

  # Try to find the most relevant error line
  local error_line=""

  # Look for lines starting with Error:, error:, etc.
  error_line=$(echo "$output" | grep -iE "^(Error|FATAL|Exception|panic):" | head -1)

  if [ -z "$error_line" ]; then
    # Look for lines containing error anywhere
    error_line=$(echo "$output" | grep -i "error" | head -1)
  fi

  if [ -z "$error_line" ]; then
    echo "Unknown error occurred"
  else
    echo "$error_line"
  fi
}

# ============================================================================
# Output Parsing
# ============================================================================

# Parse JSON streaming output to extract the final result
# Usage: result=$(parse_stream_json_result "$json_output")
parse_stream_json_result() {
  local json_output="$1"

  # Look for type=result message and extract result field
  echo "$json_output" | grep '"type":"result"' | tail -1 | jq -r '.result // empty' 2>/dev/null
}

# Extract tool calls from streaming JSON output
# Returns newline-separated list of tool names
# Usage: tools=$(extract_tool_calls "$json_output")
extract_tool_calls() {
  local json_output="$1"

  echo "$json_output" | grep -o '"tool_name":"[^"]*"' | cut -d'"' -f4 | sort -u
}

# Check if output indicates successful completion
# Returns 0 if the <promise>COMPLETE</promise> tag is found
# Usage: if is_task_complete "$output"; then echo "Done!"; fi
is_task_complete() {
  local output="$1"
  echo "$output" | grep -q "<promise>COMPLETE</promise>"
}

# ============================================================================
# Environment & Configuration
# ============================================================================

# Get the current agent name from environment or default
# Usage: agent=$(get_agent_name)
get_agent_name() {
  echo "${RALPH_AGENT:-claude}"
}

# Get the model to use, checking environment variable
# Usage: model=$(get_model)
get_model() {
  echo "${MODEL:-}"
}

# Validate that required environment variables are set
# Usage: validate_env_vars ANTHROPIC_API_KEY OPENAI_API_KEY
validate_env_vars() {
  local missing=()

  for var in "$@"; do
    if [ -z "${!var:-}" ]; then
      missing+=("$var")
    fi
  done

  if [ ${#missing[@]} -gt 0 ]; then
    echo "Error: Missing required environment variables: ${missing[*]}" >&2
    return 1
  fi

  return 0
}

# ============================================================================
# Logging
# ============================================================================

# Log a message with timestamp to stderr
# Usage: log_info "Starting agent..."
log_info() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] INFO: $*" >&2
}

# Log an error message with timestamp to stderr
# Usage: log_error "Something went wrong"
log_error() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2
}

# Log a warning message with timestamp to stderr
# Usage: log_warn "This might be a problem"
log_warn() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARN: $*" >&2
}
