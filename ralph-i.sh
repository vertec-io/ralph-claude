#!/bin/bash
# Ralph Wiggum Interactive Mode - TUI with tmux
# Usage: ./ralph-i.sh [task-directory] [-i iterations] [--rotate-at N]
# Example: ./ralph-i.sh tasks/fix-auth-timeout -i 20

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
      echo "Ralph Wiggum Interactive Mode - TUI with tmux"
      echo ""
      echo "Usage: ./ralph-i.sh [task-directory] [-i iterations] [--rotate-at N]"
      echo ""
      echo "Options:"
      echo "  -i, --iterations N   Max iterations (default: 10)"
      echo "  -y, --yes            Skip confirmation prompts"
      echo "  --rotate-at N        Rotate progress file at N lines (default: 300)"
      echo "  -h, --help           Show this help message"
      echo ""
      echo "Interactive Controls:"
      echo "  i: Send message to Claude"
      echo "  f: Force checkpoint (save progress)"
      echo "  q: Quit iteration"
      exit 0
      ;;
    -*)
      echo "Unknown option: $1"
      echo "Usage: ./ralph-i.sh [task-directory] [-i iterations] [--rotate-at N]"
      exit 1
      ;;
    *)
      TASK_DIR="$1"
      shift
      ;;
  esac
done

# Check for tmux
if ! command -v tmux &> /dev/null; then
  echo "Error: tmux not found. Interactive mode requires tmux."
  echo "Install with: sudo apt install tmux (Debian/Ubuntu) or brew install tmux (macOS)"
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
    echo "  3. Run ./ralph-i.sh tasks/{effort-name}"
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
    echo "║  Ralph Wiggum Interactive - Select a Task                     ║"
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
echo "║  Ralph Wiggum Interactive - Autonomous Agent Loop             ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Task:       $TASK_DIR"
echo "  Branch:     $BRANCH_NAME"
echo "  Progress:   $COMPLETED_STORIES / $TOTAL_STORIES stories complete"
echo "  Max iters:  $MAX_ITERATIONS"
echo "  Mode:       Interactive (tmux)"
echo ""
echo "  $DESCRIPTION"
echo ""
echo "  ┌─────────────────────────────────────────────────────────────┐"
echo "  │  i: Send message    f: Force checkpoint    q: Quit iter   │"
echo "  └─────────────────────────────────────────────────────────────┘"
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

  # ═══════════════════════════════════════════════════════════════
  # INTERACTIVE MODE (tmux-based)
  # ═══════════════════════════════════════════════════════════════
  TMUX_SESSION="ralph-$$-$i"
  PROMPT_FILE_TMP=$(mktemp)
  echo "$PROMPT" > "$PROMPT_FILE_TMP"

  # Start Claude in a tmux session (use script for unbuffered output)
  tmux new-session -d -s "$TMUX_SESSION" \
    "script -q -c 'cat \"$PROMPT_FILE_TMP\" | claude --dangerously-skip-permissions' '$OUTPUT_FILE'; echo 'RALPH_SESSION_DONE' >> '$OUTPUT_FILE'"

  # Show spinner while monitoring tmux session
  SPINNER="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
  START_TIME=$(date +%s)
  LAST_STATUS="Starting..."
  LAST_MODEL_TEXT=""
  LAST_TOOL=""
  MSG_SENT_TIME=0
  AWAITING_RESPONSE=false
  USER_QUIT=false

  # Print initial lines (spinner + model text + status + tool + shortcuts)
  echo ""
  echo ""
  echo ""
  echo ""
  echo ""

  # Save terminal settings for raw input (only if we have a tty)
  HAS_TTY=false
  if [ -t 0 ]; then
    OLD_STTY=$(stty -g)
    # Trap to restore terminal on exit/interrupt (includes temp file cleanup)
    trap 'stty "$OLD_STTY" 2>/dev/null; tmux kill-session -t "$TMUX_SESSION" 2>/dev/null; rm -f "$OUTPUT_FILE" "$STATUS_FILE" "$PROMPT_FILE_TMP" 2>/dev/null; exit' INT TERM EXIT
    stty -echo -icanon min 0 time 1
    HAS_TTY=true
  fi

  while tmux has-session -t "$TMUX_SESSION" 2>/dev/null; do
    # Check if session completed
    if grep -q "RALPH_SESSION_DONE" "$OUTPUT_FILE" 2>/dev/null; then
      break
    fi

    ELAPSED=$(($(date +%s) - START_TIME))
    MINS=$((ELAPSED / 60))
    SECS=$((ELAPSED % 60))

    # Get latest output from tmux pane - look for meaningful content
    PANE_CONTENT=$(tmux capture-pane -t "$TMUX_SESSION" -p 2>/dev/null)

    # Get the last tool call line (● followed by tool name and parenthesis)
    # Tools: Read, Bash, Edit, Write, Grep, Glob, Search, Task, WebFetch, etc.
    NEW_TOOL=$(echo "$PANE_CONTENT" | grep -E "^● [A-Za-z]+\(" | tail -1 | head -c 100)

    # Get the last status/thinking line (various Unicode stars/dots used by Claude Code)
    NEW_STATUS=$(echo "$PANE_CONTENT" | grep -E "^[✢·✻✽✶⋆] |^\* " | tail -1 | head -c 100)

    # Get Claude's thinking/commentary lines (● followed by text, not a tool call)
    NEW_THINKING=$(echo "$PANE_CONTENT" | grep "^● " | grep -v "^● [A-Za-z]*(" | tail -1 | head -c 100)

    # Get text that looks like Claude's natural language output (starts with letter)
    NEW_TEXT=$(echo "$PANE_CONTENT" | \
      grep -v "^$" | \
      grep -v "^● " | \
      grep -v "^⎿" | \
      grep -v "^[✢·✻✽✶⋆*] " | \
      grep -v "^  ☐" | \
      grep -v "^  ☑" | \
      grep -v "^─" | \
      grep -v "^❯" | \
      grep -v "^>" | \
      grep -v "bypass permissions" | \
      grep -v "shift+tab" | \
      grep -v "press.*to edit" | \
      grep -v "queued" | \
      grep -v "ctrl+c to interrupt" | \
      grep "^[A-Za-z]" | \
      tail -1 | head -c 100)

    # Update tool if we found a new one
    if [ -n "$NEW_TOOL" ]; then
      LAST_TOOL="$NEW_TOOL"
      if [ "$AWAITING_RESPONSE" = true ]; then
        AWAITING_RESPONSE=false
      fi
    fi

    # Update status line (spinner indicators)
    if [ -n "$NEW_STATUS" ]; then
      if [ "$AWAITING_RESPONSE" = true ]; then
        LAST_STATUS="← CLAUDE: $NEW_STATUS"
        AWAITING_RESPONSE=false
      else
        LAST_STATUS="$NEW_STATUS"
      fi
    fi

    # Update model text (thinking commentary or natural language)
    if [ -n "$NEW_THINKING" ]; then
      LAST_MODEL_TEXT="$NEW_THINKING"
    elif [ -n "$NEW_TEXT" ] && [ ${#NEW_TEXT} -gt 10 ]; then
      LAST_MODEL_TEXT="$NEW_TEXT"
    fi

    # Check for keyboard input (non-blocking)
    KEY=""
    read -t 0.05 -n 1 KEY 2>/dev/null || true

    if [[ "$KEY" = "i" || "$KEY" = "m" ]] && [ "$HAS_TTY" = true ]; then  # 'i' or 'm' for message
      # Fully restore terminal for input
      stty "$OLD_STTY"

      # Clear display area and show input prompt
      printf "\033[5A"
      printf "\033[K\n\033[K\n\033[K\n\033[K\n\033[K"
      printf "\033[5A"
      printf "  \033[33mEnter message (double-Enter to send, Esc to cancel):\033[0m\n"
      printf "  > "

      # Read input character by character to detect Escape and double-Enter
      USER_MSG=""
      CANCELLED=false
      LAST_ENTER_MS=0
      while true; do
        IFS= read -rsn1 char < /dev/tty
        if [[ "$char" == $'\x1b' ]]; then
          # Escape pressed - cancel
          CANCELLED=true
          break
        elif [[ "$char" == "" ]]; then
          # Enter pressed - check for double-enter
          CURRENT_MS=$(($(date +%s%N) / 1000000))
          TIME_DIFF=$((CURRENT_MS - LAST_ENTER_MS))
          if [ $LAST_ENTER_MS -gt 0 ] && [ $TIME_DIFF -lt 400 ]; then
            # Double-enter detected - send message (remove trailing newline)
            USER_MSG="${USER_MSG%$'\n'}"
            echo
            break
          else
            # Single enter - add newline
            LAST_ENTER_MS=$CURRENT_MS
            USER_MSG+=$'\n'
            echo
            printf "  > "
          fi
        elif [[ "$char" == $'\x7f' || "$char" == $'\x08' ]]; then
          # Backspace - remove last char
          if [ ${#USER_MSG} -gt 0 ]; then
            LAST_CHAR="${USER_MSG: -1}"
            USER_MSG="${USER_MSG%?}"
            if [[ "$LAST_CHAR" == $'\n' ]]; then
              # Move cursor up and to end of previous line
              printf "\033[A\033[999C"
            else
              printf "\b \b"
            fi
          fi
          LAST_ENTER_MS=0
        else
          # Regular character - reset enter timer
          USER_MSG+="$char"
          printf "%s" "$char"
          LAST_ENTER_MS=0
        fi
      done

      if [ "$CANCELLED" = true ]; then
        LAST_STATUS="(cancelled)"
      elif [ -n "$USER_MSG" ]; then
        # Send message to tmux
        tmux send-keys -t "$TMUX_SESSION" "$USER_MSG" Enter
        # Show truncated preview (first line + line count if multiline)
        LINE_COUNT=$(echo "$USER_MSG" | wc -l)
        FIRST_LINE=$(echo "$USER_MSG" | head -1 | head -c 35)
        if [ "$LINE_COUNT" -gt 1 ]; then
          LAST_STATUS="→ YOU: $FIRST_LINE... ($LINE_COUNT lines)"
        else
          LAST_STATUS="→ YOU: $FIRST_LINE"
        fi
        MSG_SENT_TIME=$(date +%s)
        AWAITING_RESPONSE=true
      else
        LAST_STATUS="(empty - cancelled)"
      fi

      # Restore raw mode and redraw
      stty -echo -icanon min 0 time 1
      printf "\033[K\n\033[K\n\033[K\n\033[K\n"

    elif [ "$KEY" = "f" ] && [ "$HAS_TTY" = true ]; then  # 'f' for force checkpoint
      CHECKPOINT_MSG="IMPORTANT: Please stop what you're doing and update prd.json and progress.txt with your current progress, any challenges or blockers, and incomplete items. Then continue."
      tmux send-keys -t "$TMUX_SESSION" "$CHECKPOINT_MSG" Enter
      LAST_STATUS="→ CHECKPOINT: Requesting progress save..."
      MSG_SENT_TIME=$(date +%s)
      AWAITING_RESPONSE=true
    elif [ "$KEY" = "q" ] && [ "$HAS_TTY" = true ]; then  # 'q' to quit entirely
      USER_QUIT=true
      # Kill the tmux session gracefully
      tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
      LAST_STATUS="Quitting..."
      break
    fi

    # Update display (5 lines: spinner, model text, status, tool, shortcuts)
    # Get terminal width, default to 80
    TERM_WIDTH=$(tput cols 2>/dev/null || echo 80)
    MAX_LEN=$((TERM_WIDTH - 5))  # Leave room for leading spaces and safety

    # Truncate text to fit terminal
    DISP_MODEL="${LAST_MODEL_TEXT:0:$MAX_LEN}"
    DISP_STATUS="${LAST_STATUS:0:$MAX_LEN}"
    DISP_TOOL="${LAST_TOOL:0:$MAX_LEN}"

    printf "\033[5A\r"
    printf "\033[K  ${SPINNER:0:1} Claude working... %02d:%02d\n" $MINS $SECS
    # Model text line (Claude's actual output)
    if [ -n "$LAST_MODEL_TEXT" ]; then
      printf "\033[K  \033[97m%s\033[0m\n" "$DISP_MODEL"  # bright white for model text
    else
      printf "\033[K  \033[90m(waiting for output...)\033[0m\n"
    fi
    # Status line with color based on state
    if [[ "$LAST_STATUS" == "→ YOU:"* ]]; then
      printf "\033[K  \033[33m%s\033[0m\n" "$DISP_STATUS"  # yellow
    elif [[ "$LAST_STATUS" == "→ CHECKPOINT:"* ]]; then
      printf "\033[K  \033[35m%s\033[0m\n" "$DISP_STATUS"  # magenta
    elif [[ "$LAST_STATUS" == "← CLAUDE:"* ]]; then
      printf "\033[K  \033[32m%s\033[0m\n" "$DISP_STATUS"  # green
    else
      printf "\033[K  \033[37m%s\033[0m\n" "$DISP_STATUS"  # white
    fi
    # Tool line (always show, even if empty)
    if [ -n "$LAST_TOOL" ]; then
      printf "\033[K  \033[36m%s\033[0m\n" "$DISP_TOOL"  # cyan for tool
    else
      printf "\033[K  \033[90m(no tool)\033[0m\n"
    fi
    printf "\033[K  \033[90m[i: message | f: checkpoint | q: quit]\033[0m\n"

    # Rotate spinner
    SPINNER="${SPINNER:1}${SPINNER:0:1}"
    sleep 0.1
  done

  # Restore terminal settings and reset trap to just temp file cleanup
  if [ "$HAS_TTY" = true ]; then
    trap "rm -f $OUTPUT_FILE $STATUS_FILE" EXIT
    stty "$OLD_STTY"
  fi

  # Wait for tmux session to fully close
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  rm -f "$PROMPT_FILE_TMP"

  # Clear spinner lines and show completion
  ELAPSED=$(($(date +%s) - START_TIME))
  MINS=$((ELAPSED / 60))
  SECS=$((ELAPSED % 60))
  printf "\033[5A"
  printf "\r\033[K  ✓ Claude finished in %02d:%02d\n" $MINS $SECS
  printf "\033[K\n"
  printf "\033[K\n"
  printf "\033[K\n"
  printf "\033[K\n"

  # Handle user quit - restore terminal, clean up, and exit
  if [ "$USER_QUIT" = true ]; then
    rm -f "$OUTPUT_FILE" "$STATUS_FILE" "$PROMPT_FILE_TMP" 2>/dev/null
    # Clear spinner lines
    printf "\033[5A"
    printf "\r\033[K  ⏹ Stopped by user\n"
    printf "\033[K\n"
    printf "\033[K\n"
    printf "\033[K\n"
    printf "\033[K\n"
    echo ""
    COMPLETED_STORIES=$(jq '[.userStories[] | select(.passes == true)] | length' "$PRD_FILE" 2>/dev/null || echo "?")
    echo "  Progress: $COMPLETED_STORIES of $TOTAL_STORIES stories complete."
    echo "  Run again with: ./ralph-i.sh $TASK_DIR"
    echo ""
    exit 0
  fi

  # Get output (remove the done marker and script artifacts)
  OUTPUT=$(grep -v "RALPH_SESSION_DONE" "$OUTPUT_FILE" 2>/dev/null | sed 's/\r//g' || cat "$OUTPUT_FILE")

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
echo "  Run again with more iterations: ./ralph-i.sh $TASK_DIR <more_iterations>"
exit 1
