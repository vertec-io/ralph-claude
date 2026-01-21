#!/bin/bash
# Ralph Wiggum for Claude Code - Long-running AI agent loop
# Usage: ./ralph.sh [task-directory] [-i iterations] [--rotate-at N]
# Example: ./ralph.sh tasks/fix-auth-timeout -i 20
#
# For interactive mode with tmux, use: ./ralph-i.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source common utilities for prompt preprocessing
source "$SCRIPT_DIR/agents/common.sh"

# Parse command line arguments
TASK_DIR=""
MAX_ITERATIONS=""
SKIP_PROMPTS=false
ROTATE_THRESHOLD=300

# Agent configuration (default to claude for backwards compatibility)
# Precedence: CLI --agent flag > RALPH_AGENT env var > default (claude)
AGENT="claude"
AGENT_SOURCE="default"
if [ -n "$RALPH_AGENT" ]; then
  AGENT="$RALPH_AGENT"
  AGENT_SOURCE="env"
fi

# Valid agents list
VALID_AGENTS="claude opencode"

# Failure tracking (associative arrays for per-agent tracking)
declare -A FAILURE_COUNT
declare -A LAST_FAILURE_MSG
for agent in $VALID_AGENTS; do
  FAILURE_COUNT[$agent]=0
  LAST_FAILURE_MSG[$agent]=""
done

# Failover configuration
# Precedence: CLI --failover-threshold > RALPH_FAILOVER_THRESHOLD env > prd.json failoverThreshold > default (3)
FAILOVER_THRESHOLD=3
FAILOVER_THRESHOLD_SOURCE="default"
if [ -n "$RALPH_FAILOVER_THRESHOLD" ]; then
  if [[ "$RALPH_FAILOVER_THRESHOLD" =~ ^[0-9]+$ ]]; then
    FAILOVER_THRESHOLD="$RALPH_FAILOVER_THRESHOLD"
    FAILOVER_THRESHOLD_SOURCE="env"
  else
    echo "Warning: Invalid RALPH_FAILOVER_THRESHOLD value '$RALPH_FAILOVER_THRESHOLD', using default of 3"
  fi
fi
FAILOVER_ENABLED=true

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
    --rotate-at)
      ROTATE_THRESHOLD="$2"
      shift 2
      ;;
    --agent)
      AGENT="$2"
      AGENT_SOURCE="cli"
      shift 2
      ;;
    --failover-threshold)
      if [[ "$2" =~ ^[0-9]+$ ]]; then
        FAILOVER_THRESHOLD="$2"
        FAILOVER_THRESHOLD_SOURCE="cli"
      else
        echo "Error: --failover-threshold requires a positive integer"
        exit 1
      fi
      shift 2
      ;;
    -h|--help)
      echo "Ralph Wiggum - Autonomous Agent Loop"
      echo ""
      echo "Usage: ./ralph.sh [task-directory] [-i iterations] [--agent <agent>] [--rotate-at N]"
      echo ""
      echo "Options:"
      echo "  -i, --iterations N        Max iterations (default: 10)"
      echo "  --agent <agent>           Select agent: claude, opencode (default: claude)"
      echo "  --failover-threshold N    Failures before automatic agent failover (default: 3)"
      echo "  -y, --yes                 Skip confirmation prompts"
      echo "  --rotate-at N             Rotate progress file at N lines (default: 300)"
      echo "  -h, --help                Show this help message"
      echo ""
      echo "Environment variables:"
      echo "  RALPH_AGENT               Set default agent (overridden by --agent flag)"
      echo "  RALPH_FAILOVER_THRESHOLD  Set failover threshold (overridden by --failover-threshold)"
      echo ""
      echo "For interactive mode with tmux, use: ./ralph-i.sh"
      exit 0
      ;;
    -*)
      echo "Unknown option: $1"
      echo "Usage: ./ralph.sh [task-directory] [-i iterations] [--agent <agent>] [--failover-threshold N] [--rotate-at N]"
      echo ""
      echo "For interactive mode, use: ./ralph-i.sh"
      exit 1
      ;;
    *)
      TASK_DIR="$1"
      shift
      ;;
  esac
done

# Validate agent name
if ! echo "$VALID_AGENTS" | grep -qw "$AGENT"; then
  echo "Error: Invalid agent '$AGENT'"
  echo "Valid agents: $VALID_AGENTS"
  exit 1
fi

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

# Resolve task directory (handle both relative and absolute paths)
if [[ "$TASK_DIR" = /* ]]; then
  FULL_TASK_DIR="$TASK_DIR"
else
  FULL_TASK_DIR="$(pwd)/$TASK_DIR"
fi

PRD_FILE="$FULL_TASK_DIR/prd.json"
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

# Read agent from prd.json if not already set by CLI or env var
# Precedence: CLI > env var > prd.json > default
if [ "$AGENT_SOURCE" = "default" ]; then
  PRD_AGENT=$(jq -r '.agent // empty' "$PRD_FILE" 2>/dev/null)
  if [ -n "$PRD_AGENT" ]; then
    AGENT="$PRD_AGENT"
    AGENT_SOURCE="prd"
  fi
fi

# Read failoverThreshold from prd.json if not already set by CLI or env var
# Precedence: CLI > env var > prd.json > default
if [ "$FAILOVER_THRESHOLD_SOURCE" = "default" ]; then
  PRD_FAILOVER_THRESHOLD=$(jq -r '.failoverThreshold // empty' "$PRD_FILE" 2>/dev/null)
  if [ -n "$PRD_FAILOVER_THRESHOLD" ]; then
    if [[ "$PRD_FAILOVER_THRESHOLD" =~ ^[0-9]+$ ]]; then
      FAILOVER_THRESHOLD="$PRD_FAILOVER_THRESHOLD"
      FAILOVER_THRESHOLD_SOURCE="prd"
    else
      echo "Warning: Invalid failoverThreshold value '$PRD_FAILOVER_THRESHOLD' in prd.json, using default of 3"
    fi
  fi
fi

# Validate agent wrapper script exists
AGENT_SCRIPT="$SCRIPT_DIR/agents/$AGENT.sh"
if [ ! -f "$AGENT_SCRIPT" ]; then
  echo "Error: Agent script not found: $AGENT_SCRIPT"
  echo "Valid agents: $(ls "$SCRIPT_DIR/agents/"*.sh 2>/dev/null | xargs -n1 basename | sed 's/\.sh$//' | grep -v '^common$' | tr '\n' ' ')"
  exit 1
fi

if [ ! -x "$AGENT_SCRIPT" ]; then
  echo "Error: Agent script is not executable: $AGENT_SCRIPT"
  echo "Run: chmod +x $AGENT_SCRIPT"
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

# Function to rotate progress file if needed
rotate_progress_if_needed() {
  local lines=$(wc -l < "$PROGRESS_FILE")
  local has_prior_rotation=false
  [ -f "$TASK_DIR/progress-1.txt" ] && has_prior_rotation=true

  # Check if we should prompt about threshold
  local within_threshold_range=$((ROTATE_THRESHOLD - 50))
  if [ $lines -gt $within_threshold_range ] || [ "$has_prior_rotation" = true ]; then
    if [ "$SKIP_PROMPTS" = false ] && [ -z "$ROTATION_CONFIRMED" ]; then
      echo ""
      echo "Progress file has $lines lines (rotation threshold: $ROTATE_THRESHOLD)"
      read -p "Rotation threshold [$ROTATE_THRESHOLD]: " NEW_THRESHOLD
      if [ -n "$NEW_THRESHOLD" ] && [[ "$NEW_THRESHOLD" =~ ^[0-9]+$ ]]; then
        ROTATE_THRESHOLD=$NEW_THRESHOLD
      fi
      ROTATION_CONFIRMED=true
    fi
  fi

  # Perform rotation if over threshold
  if [ $lines -gt $ROTATE_THRESHOLD ]; then
    echo ""
    echo "Progress file exceeds $ROTATE_THRESHOLD lines. Rotating..."

    # Find next rotation number
    local n=1
    while [ -f "$TASK_DIR/progress-$n.txt" ]; do
      n=$((n + 1))
    done

    # Move current to progress-N.txt
    mv "$PROGRESS_FILE" "$TASK_DIR/progress-$n.txt"

    # Extract codebase patterns section
    local patterns_section=""
    if grep -q "## Codebase Patterns" "$TASK_DIR/progress-$n.txt"; then
      patterns_section=$(sed -n '/## Codebase Patterns/,/^## [^C]/p' "$TASK_DIR/progress-$n.txt" | sed '$d')
    fi

    # Get effort info from rotated file
    local effort_name=$(grep "^Effort:" "$TASK_DIR/progress-$n.txt" | head -1)
    local effort_type=$(grep "^Type:" "$TASK_DIR/progress-$n.txt" | head -1)
    local started=$(grep "^Started:" "$TASK_DIR/progress-$n.txt" | head -1)

    # Count stories completed in rotated file
    local story_count=$(grep -c "^## .* - S[0-9]" "$TASK_DIR/progress-$n.txt" 2>/dev/null || echo "0")

    # Build reference chain
    local prior_ref=""
    if [ $n -gt 1 ]; then
      prior_ref=" (continues from progress-$((n-1)).txt)"
    fi

    # Create new progress.txt with minimal context
    cat > "$PROGRESS_FILE" << EOF
# Ralph Progress Log
$effort_name
$effort_type
$started
Rotation: $n (rotated at $(date))

$patterns_section

## Prior Progress
Completed $story_count iterations in progress-$n.txt$prior_ref.
_See progress-$n.txt for detailed iteration logs._

---
EOF

    echo "Created summary. Previous progress saved to progress-$n.txt"
    echo ""
  fi
}

# Function to detect if an iteration failed
# Uses exit code and output content to determine failure
# Args:
#   $1 - Exit code from agent
#   $2 - Output content from agent
# Returns: 0 if iteration failed, 1 if successful
detect_iteration_failure() {
  local exit_code="$1"
  local output="$2"
  
  # Non-zero exit code is a failure
  if [ "$exit_code" -ne 0 ]; then
    return 0
  fi
  
  # Empty output is a failure
  if [ -z "$output" ]; then
    return 0
  fi
  
  # Use common.sh error detection patterns
  if detect_error_patterns "$output"; then
    # Check if the error is in the agent's own operation (not in the code it's working on)
    # Agent-level errors typically contain these patterns
    local agent_error_patterns=(
      "API error"
      "rate limit"
      "quota exceeded"
      "authentication failed"
      "Connection refused"
      "timeout"
      "503"
      "502"
      "429"
      "overloaded"
    )
    
    for pattern in "${agent_error_patterns[@]}"; do
      if echo "$output" | grep -qi "$pattern"; then
        return 0
      fi
    done
  fi
  
  # If we get here, iteration was successful (or at least not a critical failure)
  return 1
}

# Function to log failure to progress.txt
# Args:
#   $1 - Agent name
#   $2 - Story ID
#   $3 - Error message
#   $4 - Iteration number
log_failure_to_progress() {
  local agent="$1"
  local story_id="$2"
  local error_msg="$3"
  local iteration="$4"
  local failure_count="${FAILURE_COUNT[$agent]}"
  
  cat >> "$PROGRESS_FILE" << EOF

## $(date '+%Y-%m-%d %H:%M') - FAILURE (Iteration $iteration)
- **Agent:** $agent
- **Story:** $story_id
- **Consecutive failures:** $failure_count
- **Error:** $error_msg
---
EOF
}

# Function to get the alternate agent for failover
# Args:
#   $1 - Current agent name
# Returns: The alternate agent name via stdout
get_alternate_agent() {
  local current="$1"
  
  # Simple toggle between available agents
  # For now, we only have claude and opencode
  case "$current" in
    claude)
      echo "opencode"
      ;;
    opencode)
      echo "claude"
      ;;
    *)
      # Default fallback
      echo "claude"
      ;;
  esac
}

# Function to log failover event to progress.txt
# Args:
#   $1 - Original agent
#   $2 - New agent
#   $3 - Story ID
#   $4 - Reason (last error message)
#   $5 - Failure count
log_failover_to_progress() {
  local from_agent="$1"
  local to_agent="$2"
  local story_id="$3"
  local reason="$4"
  local failure_count="$5"
  
  cat >> "$PROGRESS_FILE" << EOF

## $(date '+%Y-%m-%d %H:%M') - FAILOVER
- **From agent:** $from_agent
- **To agent:** $to_agent
- **Story:** $story_id
- **Consecutive failures before failover:** $failure_count
- **Reason:** $reason
---
EOF
}

# Function to check if both agents have failed
# Returns: 0 if both failed, 1 if at least one is still viable
both_agents_failed() {
  for agent in $VALID_AGENTS; do
    if [ "${FAILURE_COUNT[$agent]}" -lt "$FAILOVER_THRESHOLD" ]; then
      return 1
    fi
  done
  return 0
}

# Get info from prd.json for display
DESCRIPTION=$(jq -r '.description // "No description"' "$PRD_FILE" 2>/dev/null || echo "Unknown")
BRANCH_NAME=$(jq -r '.branchName // "unknown"' "$PRD_FILE" 2>/dev/null || echo "unknown")
TOTAL_STORIES=$(jq '.userStories | length' "$PRD_FILE" 2>/dev/null || echo "?")
COMPLETED_STORIES=$(jq '[.userStories[] | select(.passes == true)] | length' "$PRD_FILE" 2>/dev/null || echo "?")

echo ""
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║  Ralph Wiggum - Autonomous Agent Loop                         ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Task:       $TASK_DIR"
echo "  Branch:     $BRANCH_NAME"
echo "  Agent:      $AGENT ($AGENT_SOURCE)"
echo "  Progress:   $COMPLETED_STORIES / $TOTAL_STORIES stories complete"
echo "  Max iters:  $MAX_ITERATIONS"
echo ""
echo "  $DESCRIPTION"
echo ""

for i in $(seq 1 $MAX_ITERATIONS); do
  # Check and rotate progress file if needed
  rotate_progress_if_needed

  # Refresh progress count
  COMPLETED_STORIES=$(jq '[.userStories[] | select(.passes == true)] | length' "$PRD_FILE" 2>/dev/null || echo "?")

  # Determine agent for this iteration (story-level overrides task-level)
  # Find the next story: highest priority where passes: false
  NEXT_STORY_AGENT=$(jq -r '
    [.userStories[] | select(.passes == false)] 
    | sort_by(.priority) 
    | first 
    | .agent // empty
  ' "$PRD_FILE" 2>/dev/null)
  
  NEXT_STORY_ID=$(jq -r '
    [.userStories[] | select(.passes == false)] 
    | sort_by(.priority) 
    | first 
    | .id // empty
  ' "$PRD_FILE" 2>/dev/null)
  
  NEXT_STORY_MODEL=$(jq -r '
    [.userStories[] | select(.passes == false)] 
    | sort_by(.priority) 
    | first 
    | .model // empty
  ' "$PRD_FILE" 2>/dev/null)
  
  # Use story-level agent if set, otherwise fall back to task-level AGENT
  ITERATION_AGENT="$AGENT"
  ITERATION_AGENT_SOURCE="$AGENT_SOURCE"
  if [ -n "$NEXT_STORY_AGENT" ]; then
    # Validate story-level agent
    if echo "$VALID_AGENTS" | grep -qw "$NEXT_STORY_AGENT"; then
      ITERATION_AGENT="$NEXT_STORY_AGENT"
      ITERATION_AGENT_SOURCE="story"
    else
      echo "Warning: Invalid agent '$NEXT_STORY_AGENT' in story $NEXT_STORY_ID, using $AGENT"
    fi
  fi
  
  # Use story-level model if set (e.g., "anthropic/claude-haiku-4")
  ITERATION_MODEL=""
  if [ -n "$NEXT_STORY_MODEL" ]; then
    ITERATION_MODEL="$NEXT_STORY_MODEL"
  fi
  
  # Update agent script path for this iteration
  ITERATION_AGENT_SCRIPT="$SCRIPT_DIR/agents/$ITERATION_AGENT.sh"

  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  Iteration $i of $MAX_ITERATIONS ($COMPLETED_STORIES/$TOTAL_STORIES complete)"
  if [ "$ITERATION_AGENT" != "$AGENT" ]; then
    echo "  Agent: $ITERATION_AGENT (story override for $NEXT_STORY_ID)"
  fi
  if [ -n "$ITERATION_MODEL" ]; then
    echo "  Model: $ITERATION_MODEL (story override for $NEXT_STORY_ID)"
  fi
  echo "═══════════════════════════════════════════════════════════════"

  # Build the prompt with task directory context
  # Preprocess to filter agent-specific sections for the current iteration agent
  RAW_PROMPT_CONTENT="$(cat "$PROMPT_FILE")"
  PROCESSED_PROMPT_CONTENT="$(preprocess_prompt "$RAW_PROMPT_CONTENT" "$ITERATION_AGENT")"
  
  PROMPT="# Ralph Agent Instructions

Task Directory: $TASK_DIR
PRD File: $TASK_DIR/prd.json
Progress File: $TASK_DIR/progress.txt

$PROCESSED_PROMPT_CONTENT
"

  # Create temp files for output
  OUTPUT_FILE=$(mktemp)
  STATUS_FILE=$(mktemp)
  trap "rm -f $OUTPUT_FILE $STATUS_FILE" EXIT

  # Run agent in background with streaming JSON output
  # Agent wrapper scripts accept prompt via stdin and output to stdout
  # Configuration is passed via environment variables
  SKIP_PERMISSIONS=true \
  OUTPUT_FORMAT=stream-json \
  RALPH_VERBOSE=true \
  MODEL="$ITERATION_MODEL" \
  echo "$PROMPT" | "$ITERATION_AGENT_SCRIPT" > "$OUTPUT_FILE" 2>&1 &
  AGENT_PID=$!

  # Show spinner while agent runs
  SPINNER="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
  START_TIME=$(date +%s)
  LAST_STATUS="Starting..."

  # Print initial lines (spinner + status)
  echo ""
  echo ""

  while kill -0 $AGENT_PID 2>/dev/null; do
    ELAPSED=$(($(date +%s) - START_TIME))
    MINS=$((ELAPSED / 60))
    SECS=$((ELAPSED % 60))

    # Parse JSON output for status updates
    if [ -f "$OUTPUT_FILE" ]; then
      # Look for tool calls, assistant messages, etc.
      TOOL_NAME=$(tail -n 20 "$OUTPUT_FILE" 2>/dev/null | grep -o '"tool_name":"[^"]*"' | tail -1 | cut -d'"' -f4)
      if [ -n "$TOOL_NAME" ]; then
        LAST_STATUS="Using $TOOL_NAME..."
      else
        # Look for text content being generated
        TEXT_PREVIEW=$(tail -n 5 "$OUTPUT_FILE" 2>/dev/null | grep -o '"text":"[^"]*"' | tail -1 | cut -d'"' -f4 | head -c 60)
        if [ -n "$TEXT_PREVIEW" ]; then
          LAST_STATUS="$TEXT_PREVIEW"
        fi
      fi
    fi

    for (( j=0; j<${#SPINNER}; j++ )); do
      if ! kill -0 $AGENT_PID 2>/dev/null; then
        break 2
      fi
      # Move up 2 lines, clear and print spinner, then status
      printf "\033[2A"
      printf "\r\033[K  ${SPINNER:$j:1} Agent ($ITERATION_AGENT) working... %02d:%02d\n" $MINS $SECS
      printf "\033[K  \033[90m%.70s\033[0m\n" "$LAST_STATUS"
      sleep 0.1
    done
  done

  # Wait for agent to finish and capture exit code
  AGENT_EXIT_CODE=0
  wait $AGENT_PID || AGENT_EXIT_CODE=$?

  # Clear spinner line and show completion
  ELAPSED=$(($(date +%s) - START_TIME))
  MINS=$((ELAPSED / 60))
  SECS=$((ELAPSED % 60))
  printf "\033[2A"
  printf "\r\033[K  ✓ Agent ($ITERATION_AGENT) finished in %02d:%02d\n" $MINS $SECS
  printf "\033[K\n"

  # Extract final result from JSON output
  OUTPUT=$(grep '"type":"result"' "$OUTPUT_FILE" | tail -1 | jq -r '.result // empty' 2>/dev/null)

  # If no result found, try to get the raw text
  if [ -z "$OUTPUT" ]; then
    OUTPUT=$(cat "$OUTPUT_FILE")
  fi

  rm -f "$OUTPUT_FILE" $STATUS_FILE

  # Check for iteration failure using exit code and output patterns
  if detect_iteration_failure "$AGENT_EXIT_CODE" "$OUTPUT"; then
    # Increment failure count for this agent
    FAILURE_COUNT[$ITERATION_AGENT]=$((${FAILURE_COUNT[$ITERATION_AGENT]} + 1))
    
    # Extract error message for logging
    ERROR_MSG=$(extract_error_message "$OUTPUT")
    if [ "$AGENT_EXIT_CODE" -ne 0 ]; then
      ERROR_MSG="Exit code $AGENT_EXIT_CODE: $ERROR_MSG"
    fi
    LAST_FAILURE_MSG[$ITERATION_AGENT]="$ERROR_MSG"
    
    # Log failure to progress.txt
    log_failure_to_progress "$ITERATION_AGENT" "$NEXT_STORY_ID" "$ERROR_MSG" "$i"
    
    echo ""
    echo "  ⚠ Iteration failed (${FAILURE_COUNT[$ITERATION_AGENT]} consecutive failures for $ITERATION_AGENT)"
    echo "  Error: $ERROR_MSG"
    
    # Check if we should perform automatic failover
    if [ "$FAILOVER_ENABLED" = true ] && [ "${FAILURE_COUNT[$ITERATION_AGENT]}" -ge "$FAILOVER_THRESHOLD" ]; then
      # First check if both agents have exceeded threshold
      if both_agents_failed; then
        echo ""
        echo "╔═══════════════════════════════════════════════════════════════╗"
        echo "║  Ralph stopping - all agents have failed                      ║"
        echo "╚═══════════════════════════════════════════════════════════════╝"
        echo ""
        echo "  All available agents have exceeded the failure threshold ($FAILOVER_THRESHOLD)."
        echo "  Agent failure counts:"
        for agent in $VALID_AGENTS; do
          echo "    - $agent: ${FAILURE_COUNT[$agent]} consecutive failures"
          if [ -n "${LAST_FAILURE_MSG[$agent]}" ]; then
            echo "      Last error: ${LAST_FAILURE_MSG[$agent]}"
          fi
        done
        echo ""
        echo "  Possible causes:"
        echo "    - API rate limits or service outages"
        echo "    - Invalid API keys or authentication issues"
        echo "    - Network connectivity problems"
        echo ""
        echo "  Check $PROGRESS_FILE for detailed failure logs."
        exit 1
      fi
      
      # Perform failover to alternate agent
      ALTERNATE_AGENT=$(get_alternate_agent "$ITERATION_AGENT")
      
      echo ""
      echo "  🔄 Automatic failover: switching from $ITERATION_AGENT to $ALTERNATE_AGENT"
      echo "     (threshold: $FAILOVER_THRESHOLD consecutive failures)"
      
      # Log failover to progress.txt
      log_failover_to_progress "$ITERATION_AGENT" "$ALTERNATE_AGENT" "$NEXT_STORY_ID" "$ERROR_MSG" "${FAILURE_COUNT[$ITERATION_AGENT]}"
      
      # Update the task-level agent for subsequent iterations
      # This ensures the next iteration uses the alternate agent
      AGENT="$ALTERNATE_AGENT"
      AGENT_SOURCE="failover"
      AGENT_SCRIPT="$SCRIPT_DIR/agents/$AGENT.sh"
      
      # Note: We don't reset failure count here - the alternate agent
      # will get its own count incremented if it also fails
      
      echo "     Next iteration will use $ALTERNATE_AGENT"
    fi
  else
    # Successful iteration - reset failure count for this agent
    FAILURE_COUNT[$ITERATION_AGENT]=0
    LAST_FAILURE_MSG[$ITERATION_AGENT]=""
  fi

  # Show output
  echo ""
  echo "$OUTPUT"

  # Check for completion signal
  if echo "$OUTPUT" | grep -q "<promise>COMPLETE</promise>"; then
    echo ""
    echo "╔═══════════════════════════════════════════════════════════════╗"
    echo "║  Ralph completed all tasks!                                   ║"
    echo "╚═══════════════════════════════════════════════════════════════╝"
    echo ""
    echo "  Completed at iteration $i of $MAX_ITERATIONS"
    echo "  Check $PROGRESS_FILE for details."
    echo ""

    # Offer to archive
    echo "  To archive this completed effort:"
    echo "    mkdir -p tasks/archived && mv $TASK_DIR tasks/archived/"
    echo ""
    exit 0
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
echo "  Check $PROGRESS_FILE for status."
echo "  Run again with more iterations: ./ralph.sh $TASK_DIR <more_iterations>"
exit 1
