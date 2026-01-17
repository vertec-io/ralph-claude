#!/bin/bash
# Ralph Wiggum for Claude Code - Long-running AI agent loop
# Usage: ./ralph.sh [task-directory] [-i iterations] [--rotate-at N]
# Example: ./ralph.sh tasks/fix-auth-timeout -i 20
#
# For interactive mode with tmux, use: ./ralph-i.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Parse command line arguments
TASK_DIR=""
MAX_ITERATIONS=""
SKIP_PROMPTS=false
ROTATE_THRESHOLD=300

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
    -h|--help)
      echo "Ralph Wiggum - Autonomous Agent Loop"
      echo ""
      echo "Usage: ./ralph.sh [task-directory] [-i iterations] [--rotate-at N]"
      echo ""
      echo "Options:"
      echo "  -i, --iterations N   Max iterations (default: 10)"
      echo "  -y, --yes            Skip confirmation prompts"
      echo "  --rotate-at N        Rotate progress file at N lines (default: 300)"
      echo "  -h, --help           Show this help message"
      echo ""
      echo "For interactive mode with tmux, use: ./ralph-i.sh"
      exit 0
      ;;
    -*)
      echo "Unknown option: $1"
      echo "Usage: ./ralph.sh [task-directory] [-i iterations] [--rotate-at N]"
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

  # Create temp files for output
  OUTPUT_FILE=$(mktemp)
  STATUS_FILE=$(mktemp)
  trap "rm -f $OUTPUT_FILE $STATUS_FILE" EXIT

  # Run claude in background with streaming JSON output
  echo "$PROMPT" | claude --dangerously-skip-permissions --print --output-format stream-json --verbose > "$OUTPUT_FILE" 2>&1 &
  CLAUDE_PID=$!

  # Show spinner while claude runs
  SPINNER="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
  START_TIME=$(date +%s)
  LAST_STATUS="Starting..."

  # Print initial lines (spinner + status)
  echo ""
  echo ""

  while kill -0 $CLAUDE_PID 2>/dev/null; do
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
      if ! kill -0 $CLAUDE_PID 2>/dev/null; then
        break 2
      fi
      # Move up 2 lines, clear and print spinner, then status
      printf "\033[2A"
      printf "\r\033[K  ${SPINNER:$j:1} Claude working... %02d:%02d\n" $MINS $SECS
      printf "\033[K  \033[90m%.70s\033[0m\n" "$LAST_STATUS"
      sleep 0.1
    done
  done

  # Wait for claude to finish and get exit code
  wait $CLAUDE_PID || true

  # Clear spinner line and show completion
  ELAPSED=$(($(date +%s) - START_TIME))
  MINS=$((ELAPSED / 60))
  SECS=$((ELAPSED % 60))
  printf "\033[2A"
  printf "\r\033[K  ✓ Claude finished in %02d:%02d\n" $MINS $SECS
  printf "\033[K\n"

  # Extract final result from JSON output
  OUTPUT=$(grep '"type":"result"' "$OUTPUT_FILE" | tail -1 | jq -r '.result // empty' 2>/dev/null)

  # If no result found, try to get the raw text
  if [ -z "$OUTPUT" ]; then
    OUTPUT=$(cat "$OUTPUT_FILE")
  fi

  rm -f "$OUTPUT_FILE" $STATUS_FILE

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
