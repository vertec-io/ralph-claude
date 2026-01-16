#!/bin/bash
# Ralph - Multi-agent autonomous coding loop
# Usage: ./ralph.sh [task-directory] [-i iterations] [-a agent]
# Example: ./ralph.sh tasks/fix-auth-timeout -i 20 -a claude

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# =============================================================================
# Agent Configuration
# =============================================================================
# Supported agents in fallback priority order (customize as needed)
AGENT_PRIORITY_ORDER=("opencode" "claude" "codex" "amp" "aider")

# Agent detection - checks if agent CLI is available
detect_installed_agents() {
  local installed=()
  for agent in "${AGENT_PRIORITY_ORDER[@]}"; do
    if command -v "$agent" &>/dev/null; then
      installed+=("$agent")
    fi
  done
  echo "${installed[@]}"
}

# Get agent display name
get_agent_display_name() {
  case "$1" in
    claude) echo "Claude Code (Anthropic)" ;;
    codex) echo "Codex CLI (OpenAI)" ;;
    opencode) echo "OpenCode" ;;
    aider) echo "Aider" ;;
    amp) echo "Amp (Sourcegraph)" ;;
    *) echo "$1" ;;
  esac
}

# Build the command for running an agent in non-interactive mode
# Arguments: agent_name prompt_text
build_agent_command() {
  local agent="$1"
  local prompt_file="$2"
  
  case "$agent" in
    claude)
      # Claude Code: --print for non-interactive, --dangerously-skip-permissions to skip prompts
      # --output-format stream-json for parseable output, --verbose for status
      echo "claude --dangerously-skip-permissions --print --output-format stream-json --verbose"
      ;;
    codex)
      # OpenAI Codex: exec for non-interactive, --yolo to skip approvals/sandbox
      # --json for JSONL output, --full-auto for workspace write access
      echo "codex exec --dangerously-bypass-approvals-and-sandbox --json --full-auto"
      ;;
    opencode)
      # OpenCode: run for non-interactive mode, --format json for structured output
      echo "opencode run --format json"
      ;;
    aider)
      # Aider: --message for non-interactive, --yes-always to skip confirmations
      # Note: aider reads from file with --message-file
      echo "aider --yes-always --message-file"
      ;;
    amp)
      # Amp: --execute for non-interactive, --dangerously-allow-all to skip permissions
      # --stream-json for structured output
      echo "amp --execute --dangerously-allow-all --stream-json"
      ;;
    *)
      echo ""
      ;;
  esac
}

# Check if output indicates an error that should trigger fallback
# Arguments: agent_name output_text exit_code
check_agent_error() {
  local agent="$1"
  local output="$2"
  local exit_code="$3"
  
  # Common error patterns across all agents
  local auth_patterns="invalid api key|authentication failed|unauthorized|invalid credentials|auth error|login required|sign in required|api key not found|invalid token|access denied"
  local rate_limit_patterns="rate limit|too many requests|429|quota exceeded|throttled|capacity"
  local context_patterns="context length|too many tokens|token limit|context window|maximum context|input too long|prompt too long"
  
  # Check exit code first
  if [ "$exit_code" -eq 0 ]; then
    echo "success"
    return
  fi
  
  # Convert output to lowercase for pattern matching
  local output_lower=$(echo "$output" | tr '[:upper:]' '[:lower:]')
  
  # Check for authentication errors
  if echo "$output_lower" | grep -qiE "$auth_patterns"; then
    echo "auth_error"
    return
  fi
  
  # Check for rate limit errors
  if echo "$output_lower" | grep -qiE "$rate_limit_patterns"; then
    echo "rate_limit"
    return
  fi
  
  # Check for context/token limit errors  
  if echo "$output_lower" | grep -qiE "$context_patterns"; then
    echo "context_limit"
    return
  fi
  
  # Generic error
  echo "unknown_error"
}

# Get human-readable error message
get_error_message() {
  case "$1" in
    auth_error) echo "Authentication failed - check API key or login status" ;;
    rate_limit) echo "Rate limit exceeded - too many requests" ;;
    context_limit) echo "Context/token limit exceeded - prompt too long" ;;
    unknown_error) echo "Unknown error occurred" ;;
    *) echo "Error: $1" ;;
  esac
}

# Parse command line arguments
TASK_DIR=""
MAX_ITERATIONS=""
SKIP_PROMPTS=false
SELECTED_AGENT=""

while [[ $# -gt 0 ]]; do
  case $1 in
    -i|--iterations)
      MAX_ITERATIONS="$2"
      shift 2
      ;;
    -y|--yes)
      SKIP_PROMPTS=true
      shift
      ;;
    -a|--agent)
      SELECTED_AGENT="$2"
      shift 2
      ;;
    -*)
      echo "Unknown option: $1"
      echo "Usage: ./ralph.sh [task-directory] [-i iterations] [-a agent]"
      echo ""
      echo "Options:"
      echo "  -i, --iterations N   Maximum iterations (default: 10)"
      echo "  -a, --agent NAME     Agent to use (claude, codex, opencode, aider, amp)"
      echo "  -y, --yes            Skip confirmation prompts"
      exit 1
      ;;
    *)
      TASK_DIR="$1"
      shift
      ;;
  esac
done

# Function to find active tasks (directories with prd.json, excluding archived)
find_active_tasks() {
  find tasks -maxdepth 2 -name "prd.json" -type f 2>/dev/null | \
    grep -v "tasks/archived/" | \
    xargs -I {} dirname {} | \
    sort
}

# Function to display task info
display_task_info() {
  local task_dir="$1"
  local prd_file="$task_dir/prd.json"
  local description=$(jq -r '.description // "No description"' "$prd_file" 2>/dev/null | head -c 60)
  local total=$(jq '.userStories | length' "$prd_file" 2>/dev/null || echo "?")
  local done=$(jq '[.userStories[] | select(.passes == true)] | length' "$prd_file" 2>/dev/null || echo "?")
  local type=$(jq -r '.type // "feature"' "$prd_file" 2>/dev/null)
  printf "%-35s [%s/%s] %s\n" "$task_dir" "$done" "$total" "($type)"
}

# If no task directory provided, find and prompt
if [ -z "$TASK_DIR" ]; then
  # Find active tasks
  ACTIVE_TASKS=($(find_active_tasks))
  TASK_COUNT=${#ACTIVE_TASKS[@]}

  if [ $TASK_COUNT -eq 0 ]; then
    echo "No active tasks found."
    echo ""
    echo "To create a new task:"
    echo "  1. Use /prd to create a PRD in tasks/{effort-name}/"
    echo "  2. Use /ralph to convert it to prd.json"
    echo "  3. Run ./ralph.sh tasks/{effort-name}"
    exit 1
  elif [ $TASK_COUNT -eq 1 ]; then
    # Only one task, use it automatically
    TASK_DIR="${ACTIVE_TASKS[0]}"
    echo "Found one active task: $TASK_DIR"
    echo ""
  else
    # Multiple tasks, prompt for selection
    echo ""
    echo "╔═══════════════════════════════════════════════════════════════╗"
    echo "║  Ralph Wiggum - Select a Task                                 ║"
    echo "╚═══════════════════════════════════════════════════════════════╝"
    echo ""
    echo "Active tasks:"
    echo ""

    for i in "${!ACTIVE_TASKS[@]}"; do
      printf "  %d) " "$((i+1))"
      display_task_info "${ACTIVE_TASKS[$i]}"
    done

    echo ""
    read -p "Select task [1-$TASK_COUNT]: " SELECTION

    # Validate selection
    if ! [[ "$SELECTION" =~ ^[0-9]+$ ]] || [ "$SELECTION" -lt 1 ] || [ "$SELECTION" -gt $TASK_COUNT ]; then
      echo "Invalid selection. Exiting."
      exit 1
    fi

    TASK_DIR="${ACTIVE_TASKS[$((SELECTION-1))]}"
    echo ""
    echo "Selected: $TASK_DIR"
    echo ""
  fi
fi

# Prompt for iterations if not provided via -i flag
if [ -z "$MAX_ITERATIONS" ]; then
  read -p "Max iterations [10]: " ITER_INPUT
  if [ -z "$ITER_INPUT" ]; then
    MAX_ITERATIONS=10
  elif [[ "$ITER_INPUT" =~ ^[0-9]+$ ]]; then
    MAX_ITERATIONS="$ITER_INPUT"
  else
    echo "Invalid number. Using default of 10."
    MAX_ITERATIONS=10
  fi
fi

# =============================================================================
# Agent Selection
# =============================================================================

# Resolve task directory first (needed to check prd.json for saved agent)
if [[ "$TASK_DIR" = /* ]]; then
  FULL_TASK_DIR="$TASK_DIR"
else
  FULL_TASK_DIR="$(pwd)/$TASK_DIR"
fi

PRD_FILE="$FULL_TASK_DIR/prd.json"

# Detect installed agents
INSTALLED_AGENTS=($(detect_installed_agents))
INSTALLED_COUNT=${#INSTALLED_AGENTS[@]}

if [ $INSTALLED_COUNT -eq 0 ]; then
  echo ""
  echo "Error: No supported AI coding agents found."
  echo ""
  echo "Please install one of the following:"
  echo "  - Claude Code: npm install -g @anthropic-ai/claude-code"
  echo "  - OpenAI Codex: npm install -g @openai/codex"
  echo "  - OpenCode: curl -fsSL https://opencode.ai/install | bash"
  echo "  - Aider: pip install aider-chat"
  echo "  - Amp: curl -fsSL https://ampcode.com/install.sh | bash"
  exit 1
fi

# Check if agent was specified via CLI flag
if [ -n "$SELECTED_AGENT" ]; then
  # Validate the selected agent is installed
  if ! command -v "$SELECTED_AGENT" &>/dev/null; then
    echo "Error: Agent '$SELECTED_AGENT' is not installed."
    echo "Installed agents: ${INSTALLED_AGENTS[*]}"
    exit 1
  fi
  CURRENT_AGENT="$SELECTED_AGENT"
# Check if agent is saved in prd.json
elif [ -f "$PRD_FILE" ] && jq -e '.agent' "$PRD_FILE" &>/dev/null; then
  SAVED_AGENT=$(jq -r '.agent' "$PRD_FILE")
  if command -v "$SAVED_AGENT" &>/dev/null; then
    CURRENT_AGENT="$SAVED_AGENT"
    echo "Using saved agent: $(get_agent_display_name "$CURRENT_AGENT")"
  else
    echo "Warning: Saved agent '$SAVED_AGENT' is not installed. Please select a new agent."
    CURRENT_AGENT=""
  fi
else
  CURRENT_AGENT=""
fi

# If no agent selected yet and multiple agents available, prompt user
if [ -z "$CURRENT_AGENT" ]; then
  if [ $INSTALLED_COUNT -eq 1 ]; then
    CURRENT_AGENT="${INSTALLED_AGENTS[0]}"
    echo "Using only installed agent: $(get_agent_display_name "$CURRENT_AGENT")"
  else
    echo ""
    echo "╔═══════════════════════════════════════════════════════════════╗"
    echo "║  Select AI Coding Agent                                       ║"
    echo "╚═══════════════════════════════════════════════════════════════╝"
    echo ""
    echo "Available agents (in fallback priority order):"
    echo ""
    
    for i in "${!INSTALLED_AGENTS[@]}"; do
      local_agent="${INSTALLED_AGENTS[$i]}"
      printf "  %d) %s\n" "$((i+1))" "$(get_agent_display_name "$local_agent")"
    done
    
    echo ""
    read -p "Select agent [1-$INSTALLED_COUNT]: " AGENT_SELECTION
    
    # Validate selection
    if ! [[ "$AGENT_SELECTION" =~ ^[0-9]+$ ]] || [ "$AGENT_SELECTION" -lt 1 ] || [ "$AGENT_SELECTION" -gt $INSTALLED_COUNT ]; then
      echo "Invalid selection. Using first available: ${INSTALLED_AGENTS[0]}"
      CURRENT_AGENT="${INSTALLED_AGENTS[0]}"
    else
      CURRENT_AGENT="${INSTALLED_AGENTS[$((AGENT_SELECTION-1))]}"
    fi
    
    echo ""
    echo "Selected: $(get_agent_display_name "$CURRENT_AGENT")"
  fi
  
  # Save agent selection to prd.json
  if [ -f "$PRD_FILE" ]; then
    TMP_FILE=$(mktemp)
    jq --arg agent "$CURRENT_AGENT" '. + {agent: $agent}' "$PRD_FILE" > "$TMP_FILE" && mv "$TMP_FILE" "$PRD_FILE"
    echo "Agent preference saved to prd.json"
  fi
fi

# Build the fallback order starting with current agent
FALLBACK_AGENTS=("$CURRENT_AGENT")
for agent in "${INSTALLED_AGENTS[@]}"; do
  if [ "$agent" != "$CURRENT_AGENT" ]; then
    FALLBACK_AGENTS+=("$agent")
  fi
done

# Task directory was already resolved above for agent selection
PROGRESS_FILE="$FULL_TASK_DIR/progress.txt"
PROMPT_FILE="$SCRIPT_DIR/prompt.md"

# Validate task directory exists
if [ ! -d "$FULL_TASK_DIR" ]; then
  echo "Error: Task directory not found: $TASK_DIR"
  exit 1
fi

# Validate prd.json exists
if [ ! -f "$PRD_FILE" ]; then
  echo "Error: prd.json not found in $TASK_DIR"
  echo "Run the /ralph skill first to convert your PRD to JSON format."
  exit 1
fi

# Initialize progress file if it doesn't exist
if [ ! -f "$PROGRESS_FILE" ]; then
  EFFORT_NAME=$(basename "$TASK_DIR")
  PRD_TYPE=$(jq -r '.type // "feature"' "$PRD_FILE" 2>/dev/null || echo "feature")
  echo "# Ralph Progress Log" > "$PROGRESS_FILE"
  echo "Effort: $EFFORT_NAME" >> "$PROGRESS_FILE"
  echo "Type: $PRD_TYPE" >> "$PROGRESS_FILE"
  echo "Started: $(date)" >> "$PROGRESS_FILE"
  echo "---" >> "$PROGRESS_FILE"
fi

# Get info from prd.json for display
DESCRIPTION=$(jq -r '.description // "No description"' "$PRD_FILE" 2>/dev/null || echo "Unknown")
BRANCH_NAME=$(jq -r '.branchName // "unknown"' "$PRD_FILE" 2>/dev/null || echo "unknown")
TOTAL_STORIES=$(jq '.userStories | length' "$PRD_FILE" 2>/dev/null || echo "?")
COMPLETED_STORIES=$(jq '[.userStories[] | select(.passes == true)] | length' "$PRD_FILE" 2>/dev/null || echo "?")

echo ""
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║  Ralph - Autonomous Agent Loop                                ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Task:       $TASK_DIR"
echo "  Branch:     $BRANCH_NAME"
echo "  Progress:   $COMPLETED_STORIES / $TOTAL_STORIES stories complete"
echo "  Max iters:  $MAX_ITERATIONS"
echo "  Agent:      $(get_agent_display_name "$CURRENT_AGENT")"
if [ ${#FALLBACK_AGENTS[@]} -gt 1 ]; then
  echo "  Fallbacks:  ${FALLBACK_AGENTS[*]:1}"
fi
echo ""
echo "  $DESCRIPTION"
echo ""

# =============================================================================
# Run Agent Function
# =============================================================================
# Runs an agent and returns output. Handles agent-specific invocation.
# Arguments: agent_name prompt_text prompt_file
# Returns: Sets AGENT_OUTPUT, AGENT_EXIT_CODE
run_agent() {
  local agent="$1"
  local prompt_text="$2"
  local prompt_file="$3"
  
  local output_file=$(mktemp)
  local agent_pid
  local agent_display=$(get_agent_display_name "$agent")
  
  case "$agent" in
    claude)
      echo "$prompt_text" | claude --dangerously-skip-permissions --print --output-format stream-json --verbose > "$output_file" 2>&1 &
      agent_pid=$!
      ;;
    codex)
      # Codex exec takes prompt as argument, not stdin
      codex exec --dangerously-bypass-approvals-and-sandbox --json --full-auto "$prompt_text" > "$output_file" 2>&1 &
      agent_pid=$!
      ;;
    opencode)
      # OpenCode run takes prompt as argument
      opencode run --format json "$prompt_text" > "$output_file" 2>&1 &
      agent_pid=$!
      ;;
    aider)
      # Aider uses --message for non-interactive, write prompt to temp file
      echo "$prompt_text" > "$prompt_file"
      aider --yes-always --message-file "$prompt_file" > "$output_file" 2>&1 &
      agent_pid=$!
      ;;
    amp)
      # Amp uses --execute with prompt as argument
      amp --execute "$prompt_text" --dangerously-allow-all --stream-json > "$output_file" 2>&1 &
      agent_pid=$!
      ;;
    *)
      echo "Unknown agent: $agent"
      AGENT_OUTPUT="Unknown agent: $agent"
      AGENT_EXIT_CODE=1
      return
      ;;
  esac
  
  # Show spinner while agent runs
  local spinner="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
  local start_time=$(date +%s)
  local last_status="Starting..."
  
  # Print initial lines (spinner + status)
  echo ""
  echo ""
  
  while kill -0 $agent_pid 2>/dev/null; do
    local elapsed=$(($(date +%s) - start_time))
    local mins=$((elapsed / 60))
    local secs=$((elapsed % 60))
    
    # Parse output for status updates (works for JSON-outputting agents)
    if [ -f "$output_file" ]; then
      local tool_name=$(tail -n 20 "$output_file" 2>/dev/null | grep -o '"tool_name":"[^"]*"' | tail -1 | cut -d'"' -f4)
      if [ -n "$tool_name" ]; then
        last_status="Using $tool_name..."
      else
        local text_preview=$(tail -n 5 "$output_file" 2>/dev/null | grep -o '"text":"[^"]*"' | tail -1 | cut -d'"' -f4 | head -c 60)
        if [ -n "$text_preview" ]; then
          last_status="$text_preview"
        fi
      fi
    fi
    
    for (( j=0; j<${#spinner}; j++ )); do
      if ! kill -0 $agent_pid 2>/dev/null; then
        break 2
      fi
      printf "\033[2A"
      printf "\r\033[K  ${spinner:$j:1} $agent_display working... %02d:%02d\n" $mins $secs
      printf "\033[K  \033[90m%.70s\033[0m\n" "$last_status"
      sleep 0.1
    done
  done
  
  # Wait for agent to finish and capture exit code
  wait $agent_pid
  AGENT_EXIT_CODE=$?
  
  # Clear spinner and show completion
  local elapsed=$(($(date +%s) - start_time))
  local mins=$((elapsed / 60))
  local secs=$((elapsed % 60))
  printf "\033[2A"
  
  if [ $AGENT_EXIT_CODE -eq 0 ]; then
    printf "\r\033[K  ✓ $agent_display finished in %02d:%02d\n" $mins $secs
  else
    printf "\r\033[K  ✗ $agent_display exited with code $AGENT_EXIT_CODE in %02d:%02d\n" $mins $secs
  fi
  printf "\033[K\n"
  
  # Extract output based on agent type
  case "$agent" in
    claude)
      # Claude outputs JSON with type:result containing the final message
      AGENT_OUTPUT=$(grep '"type":"result"' "$output_file" | tail -1 | jq -r '.result // empty' 2>/dev/null)
      if [ -z "$AGENT_OUTPUT" ]; then
        AGENT_OUTPUT=$(cat "$output_file")
      fi
      ;;
    codex|opencode|amp)
      # These output JSONL, get the final result or raw output
      AGENT_OUTPUT=$(cat "$output_file")
      ;;
    aider)
      # Aider outputs plain text
      AGENT_OUTPUT=$(cat "$output_file")
      ;;
    *)
      AGENT_OUTPUT=$(cat "$output_file")
      ;;
  esac
  
  rm -f "$output_file"
}

# =============================================================================
# Main Iteration Loop
# =============================================================================
for i in $(seq 1 $MAX_ITERATIONS); do
  # Refresh progress count
  COMPLETED_STORIES=$(jq '[.userStories[] | select(.passes == true)] | length' "$PRD_FILE" 2>/dev/null || echo "?")

  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  Iteration $i of $MAX_ITERATIONS ($COMPLETED_STORIES/$TOTAL_STORIES complete)"
  echo "═══════════════════════════════════════════════════════════════"

  # Build the prompt with task directory context
  PROMPT="# Ralph Agent Instructions

Task Directory: $TASK_DIR
PRD File: $TASK_DIR/prd.json
Progress File: $TASK_DIR/progress.txt

$(cat "$PROMPT_FILE")
"

  # Create temp file for prompt (needed by some agents)
  PROMPT_TEMP_FILE=$(mktemp)
  trap "rm -f $PROMPT_TEMP_FILE" EXIT
  
  # Try agents with fallback
  ITERATION_SUCCESS=false
  TRIED_AGENTS=()
  
  for try_agent in "${FALLBACK_AGENTS[@]}"; do
    TRIED_AGENTS+=("$try_agent")
    
    echo ""
    echo "  Running with $(get_agent_display_name "$try_agent")..."
    
    # Run the agent
    run_agent "$try_agent" "$PROMPT" "$PROMPT_TEMP_FILE"
    
    # Check for errors
    ERROR_TYPE=$(check_agent_error "$try_agent" "$AGENT_OUTPUT" "$AGENT_EXIT_CODE")
    
    if [ "$ERROR_TYPE" = "success" ]; then
      ITERATION_SUCCESS=true
      break
    fi
    
    # Handle error with potential fallback
    ERROR_MSG=$(get_error_message "$ERROR_TYPE")
    echo ""
    echo "  ⚠ $ERROR_MSG"
    
    # Check if we have more agents to try
    if [ ${#TRIED_AGENTS[@]} -lt ${#FALLBACK_AGENTS[@]} ]; then
      NEXT_AGENT_IDX=${#TRIED_AGENTS[@]}
      NEXT_AGENT="${FALLBACK_AGENTS[$NEXT_AGENT_IDX]}"
      echo "  → Falling back to $(get_agent_display_name "$NEXT_AGENT")..."
      sleep 1
    else
      echo "  ✗ All agents failed. Output from last attempt:"
      echo ""
      echo "$AGENT_OUTPUT"
      echo ""
      echo "═══════════════════════════════════════════════════════════════"
      echo "  All agents exhausted. Please check your configuration."
      echo "═══════════════════════════════════════════════════════════════"
      exit 1
    fi
  done
  
  rm -f "$PROMPT_TEMP_FILE"
  
  # Show output from successful agent
  if [ "$ITERATION_SUCCESS" = true ]; then
    echo ""
    echo "$AGENT_OUTPUT"
    
    # Check for completion signal - must be careful to avoid false positives
    # from JSON output that contains the string embedded in other content
    COMPLETION_DETECTED=false
    
    # First, check for error indicators in the output that would invalidate completion
    if echo "$AGENT_OUTPUT" | grep -qE '"is_error"\s*:\s*true|"error_during_execution"|"subtype"\s*:\s*"error"'; then
      # Output contains error markers - don't treat as complete even if signal present
      echo ""
      echo "  ⚠ Agent reported errors in output, continuing to next iteration..."
      COMPLETION_DETECTED=false
    # Check for completion signal - look for it as actual output, not just embedded in JSON
    # The signal should appear either standalone or as the text content of a message
    elif echo "$AGENT_OUTPUT" | grep -qE '^\s*<promise>COMPLETE</promise>\s*$|"text"\s*:\s*"<promise>COMPLETE</promise>"'; then
      COMPLETION_DETECTED=true
    fi
    
    if [ "$COMPLETION_DETECTED" = true ]; then
      # Verify completion by checking prd.json - all stories should have passes: true
      INCOMPLETE_STORIES=$(jq '[.userStories[] | select(.passes == false)] | length' "$PRD_FILE" 2>/dev/null || echo "1")
      
      if [ "$INCOMPLETE_STORIES" = "0" ]; then
        echo ""
        echo "╔═══════════════════════════════════════════════════════════════╗"
        echo "║  Ralph completed all tasks!                                   ║"
        echo "╚═══════════════════════════════════════════════════════════════╝"
        echo ""
        echo "  Completed at iteration $i of $MAX_ITERATIONS"
        echo "  Agent: $(get_agent_display_name "${TRIED_AGENTS[-1]}")"
        echo "  Check $PROGRESS_FILE for details."
        echo ""

        # Offer to archive
        echo "  To archive this completed effort:"
        echo "    mkdir -p tasks/archived && mv $TASK_DIR tasks/archived/"
        echo ""
        exit 0
      else
        echo ""
        echo "  ⚠ Agent signaled completion but $INCOMPLETE_STORIES stories still incomplete."
        echo "  Continuing to next iteration..."
      fi
    fi
  fi

  echo ""
  echo "Iteration $i complete. Continuing in 2 seconds..."
  sleep 2
done

echo ""
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║  Ralph reached max iterations                                 ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""
COMPLETED_STORIES=$(jq '[.userStories[] | select(.passes == true)] | length' "$PRD_FILE" 2>/dev/null || echo "?")
echo "  Completed $COMPLETED_STORIES of $TOTAL_STORIES stories in $MAX_ITERATIONS iterations."
echo "  Agent: $(get_agent_display_name "$CURRENT_AGENT")"
echo "  Check $PROGRESS_FILE for status."
echo "  Run again with more iterations: ./ralph.sh $TASK_DIR -i <more_iterations>"
exit 1
