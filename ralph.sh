#!/bin/bash
# Ralph - Multi-agent autonomous coding loop
# Usage: ralph [command] [task-directory] [options]
#
# Commands:
#   (default)     Start or resume a task (runs in tmux background)
#   attach        Watch running session output
#   checkpoint    Gracefully stop with state summary
#   stop          Force stop running session
#   status        List running Ralph sessions

set -e

VERSION="2.0.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Find agents directory (supports both dev and installed locations)
if [ -d "$SCRIPT_DIR/agents" ]; then
  AGENTS_DIR="$SCRIPT_DIR/agents"
elif [ -d "$HOME/.local/bin/ralph-agents" ]; then
  AGENTS_DIR="$HOME/.local/bin/ralph-agents"
else
  echo "Error: Cannot find agents directory"
  exit 1
fi

# Source common utilities for prompt preprocessing (if available)
if [ -f "$AGENTS_DIR/common.sh" ]; then
  source "$AGENTS_DIR/common.sh"
fi

# =============================================================================
# tmux Session Management
# =============================================================================

check_tmux() {
  if ! command -v tmux &>/dev/null; then
    echo "Error: tmux is required. Install with: apt install tmux"
    exit 1
  fi
}

get_session_name() {
  echo "ralph-$(basename "$1")"
}

session_exists() {
  tmux has-session -t "$1" 2>/dev/null
}

get_session_pid() {
  local pid_file="/tmp/${1}.pid"
  [ -f "$pid_file" ] && cat "$pid_file"
}

list_sessions() {
  tmux list-sessions -F "#{session_name}" 2>/dev/null | grep "^ralph-" || true
}

kill_session() {
  local name="$1"
  session_exists "$name" && tmux kill-session -t "$name" 2>/dev/null && rm -f "/tmp/${name}.pid"
}

# =============================================================================
# Global Session Registry (SQLite)
# =============================================================================

RALPH_DB_DIR="$HOME/.local/share/ralph"
RALPH_DB="$RALPH_DB_DIR/sessions.db"

# Initialize SQLite database if needed
init_session_db() {
  if ! command -v sqlite3 &>/dev/null; then
    # SQLite not available - degrade gracefully
    return 1
  fi
  
  mkdir -p "$RALPH_DB_DIR"
  
  sqlite3 "$RALPH_DB" <<EOF
CREATE TABLE IF NOT EXISTS sessions (
  session_name TEXT PRIMARY KEY,
  task_dir TEXT NOT NULL,
  pid INTEGER,
  agent TEXT,
  started_at TEXT,
  max_iterations INTEGER,
  current_iteration INTEGER DEFAULT 0,
  completed_stories INTEGER DEFAULT 0,
  total_stories INTEGER DEFAULT 0,
  status TEXT DEFAULT 'running'
);
EOF
}

# Register a new session in the database
register_session() {
  local session_name="$1"
  local task_dir="$2"
  local pid="$3"
  local agent="$4"
  local max_iter="$5"
  local total_stories="$6"
  local completed_stories="$7"
  
  command -v sqlite3 &>/dev/null || return 1
  init_session_db || return 1
  
  sqlite3 "$RALPH_DB" <<EOF
INSERT OR REPLACE INTO sessions 
  (session_name, task_dir, pid, agent, started_at, max_iterations, total_stories, completed_stories, status)
VALUES 
  ('$session_name', '$task_dir', $pid, '$agent', datetime('now'), $max_iter, $total_stories, $completed_stories, 'running');
EOF
}

# Update session progress
update_session_progress() {
  local session_name="$1"
  local current_iter="$2"
  local completed="$3"
  
  command -v sqlite3 &>/dev/null || return 1
  [ -f "$RALPH_DB" ] || return 1
  
  sqlite3 "$RALPH_DB" <<EOF
UPDATE sessions 
SET current_iteration = $current_iter, completed_stories = $completed
WHERE session_name = '$session_name';
EOF
}

# Mark session as completed or stopped
finish_session() {
  local session_name="$1"
  local status="$2"  # 'completed', 'stopped', 'failed'
  
  command -v sqlite3 &>/dev/null || return 1
  [ -f "$RALPH_DB" ] || return 1
  
  sqlite3 "$RALPH_DB" <<EOF
UPDATE sessions SET status = '$status' WHERE session_name = '$session_name';
EOF
}

# Remove session from database
unregister_session() {
  local session_name="$1"
  
  command -v sqlite3 &>/dev/null || return 1
  [ -f "$RALPH_DB" ] || return 1
  
  sqlite3 "$RALPH_DB" "DELETE FROM sessions WHERE session_name = '$session_name';"
}

# List all sessions from database (for global visibility)
list_all_sessions() {
  command -v sqlite3 &>/dev/null || { list_sessions; return; }
  [ -f "$RALPH_DB" ] || { list_sessions; return; }
  
  # Clean up stale sessions first (tmux session no longer exists)
  local db_sessions=$(sqlite3 "$RALPH_DB" "SELECT session_name FROM sessions WHERE status = 'running';")
  for session in $db_sessions; do
    if ! session_exists "$session"; then
      sqlite3 "$RALPH_DB" "UPDATE sessions SET status = 'dead' WHERE session_name = '$session';"
    fi
  done
  
  # Return running sessions
  sqlite3 "$RALPH_DB" "SELECT session_name FROM sessions WHERE status = 'running';"
}

# Get session info as JSON (for ralph-tui)
get_session_info() {
  local session_name="$1"
  
  command -v sqlite3 &>/dev/null || return 1
  [ -f "$RALPH_DB" ] || return 1
  
  sqlite3 -json "$RALPH_DB" "SELECT * FROM sessions WHERE session_name = '$session_name';" 2>/dev/null
}

# Get all sessions as JSON (for ralph-tui)
get_all_sessions_json() {
  command -v sqlite3 &>/dev/null || return 1
  [ -f "$RALPH_DB" ] || return 1
  
  # Clean up stale sessions first
  local db_sessions=$(sqlite3 "$RALPH_DB" "SELECT session_name FROM sessions WHERE status = 'running';")
  for session in $db_sessions; do
    if ! session_exists "$session"; then
      sqlite3 "$RALPH_DB" "UPDATE sessions SET status = 'dead' WHERE session_name = '$session';"
    fi
  done
  
  sqlite3 -json "$RALPH_DB" "SELECT * FROM sessions ORDER BY started_at DESC;"
}

# =============================================================================
# Checkpoint State Management
# =============================================================================

CHECKPOINT_REQUESTED=false
CURRENT_ITERATION=0

handle_checkpoint_signal() {
  echo -e "\n>>> Checkpoint requested. Saving state after current operation..."
  CHECKPOINT_REQUESTED=true
}
trap 'handle_checkpoint_signal' SIGUSR1

write_checkpoint() {
  local reason="${1:-user}"
  local done=0 total=0
  [ -f "$PRD_FILE" ] && {
    done=$(jq '[.userStories[] | select(.passes == true)] | length' "$PRD_FILE" 2>/dev/null || echo 0)
    total=$(jq '.userStories | length' "$PRD_FILE" 2>/dev/null || echo 0)
  }
  cat >> "$PROGRESS_FILE" << EOF

---
CHECKPOINT at $(date)
Iteration: $CURRENT_ITERATION/$MAX_ITERATIONS | Stories: $done/$total | Agent: $AGENT
Reason: $reason
To resume: ralph $TASK_DIR
---
EOF
  echo -e "\n=== Checkpoint saved ($done/$total stories) ===\nResume: ralph $TASK_DIR\n"
}

# =============================================================================
# Subcommand Handlers
# =============================================================================

find_session() {
  local task_dir="$1"
  if [ -n "$task_dir" ]; then
    get_session_name "$task_dir"
  else
    # Use global session list (falls back to tmux-only if no sqlite)
    local sessions=($(list_all_sessions))
    [ ${#sessions[@]} -eq 0 ] && echo "" && return
    [ ${#sessions[@]} -eq 1 ] && echo "${sessions[0]}" && return
    echo "MULTIPLE"
  fi
}

cmd_attach() {
  check_tmux
  local session=$(find_session "$1")
  [ -z "$session" ] && echo "No Ralph session found. Start: ralph tasks/your-task" && exit 1
  [ "$session" = "MULTIPLE" ] && { echo "Multiple sessions. Specify: ralph attach <task>"; list_sessions; exit 1; }
  session_exists "$session" || { echo "Session '$session' not found."; exit 1; }
  echo "Attaching to $session... (Ctrl+B d to detach)"
  tmux attach-session -t "$session"
}

cmd_status() {
  check_tmux
  
  # Try to get rich info from SQLite first
  if command -v sqlite3 &>/dev/null && [ -f "$RALPH_DB" ]; then
    # Clean up stale sessions
    local db_sessions=$(sqlite3 "$RALPH_DB" "SELECT session_name FROM sessions WHERE status = 'running';")
    for session in $db_sessions; do
      if ! session_exists "$session"; then
        sqlite3 "$RALPH_DB" "UPDATE sessions SET status = 'dead' WHERE session_name = '$session';"
      fi
    done
    
    local running=$(sqlite3 "$RALPH_DB" "SELECT COUNT(*) FROM sessions WHERE status = 'running';")
    if [ "$running" -eq 0 ]; then
      echo "No Ralph sessions running."
      
      # Show recent sessions if any
      local recent=$(sqlite3 -separator ' | ' "$RALPH_DB" "SELECT session_name, status, task_dir FROM sessions ORDER BY started_at DESC LIMIT 5;" 2>/dev/null)
      if [ -n "$recent" ]; then
        echo ""
        echo "Recent sessions:"
        echo "$recent" | while read line; do
          echo "  $line"
        done
      fi
      exit 0
    fi
    
    echo "Running Ralph sessions:"
    echo ""
    sqlite3 -separator '' "$RALPH_DB" "
      SELECT 
        '  ' || session_name || 
        '  (' || completed_stories || '/' || total_stories || ' stories)' ||
        '  [' || agent || ']' ||
        '  iter ' || current_iteration || '/' || max_iterations ||
        char(10) || '    ' || task_dir
      FROM sessions 
      WHERE status = 'running'
      ORDER BY started_at DESC;
    "
    echo ""
    echo "Commands: ralph attach|checkpoint|stop [task]"
    echo "          ralph status --json  (machine-readable)"
  else
    # Fallback to tmux-only
    local sessions=($(list_sessions))
    [ ${#sessions[@]} -eq 0 ] && echo "No Ralph sessions running." && exit 0
    echo "Running Ralph sessions:"
    for s in "${sessions[@]}"; do
      local prd="tasks/${s#ralph-}/prd.json"
      local info=""
      [ -f "$prd" ] && info="($(jq '[.userStories[] | select(.passes == true)] | length' "$prd")/$(jq '.userStories | length' "$prd") stories)"
      echo "  $s  $info"
    done
    echo -e "\nCommands: ralph attach|checkpoint|stop [task]"
  fi
}

cmd_stop() {
  check_tmux
  local session=$(find_session "$1")
  [ -z "$session" ] && echo "No Ralph session found." && exit 1
  [ "$session" = "MULTIPLE" ] && { echo "Multiple sessions. Specify: ralph stop <task>"; list_all_sessions; exit 1; }
  echo "Stopping $session..."
  kill_session "$session" && {
    finish_session "$session" "stopped"
    echo "Stopped."
  }
}

cmd_checkpoint() {
  check_tmux
  local session=$(find_session "$1")
  [ -z "$session" ] && echo "No Ralph session found." && exit 1
  [ "$session" = "MULTIPLE" ] && { echo "Multiple sessions. Specify: ralph checkpoint <task>"; exit 1; }
  local pid=$(get_session_pid "$session")
  [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null && { echo "Process not found. Try: ralph stop ${session#ralph-}"; exit 1; }
  echo "Sending checkpoint to $session (PID $pid)..."
  kill -USR1 "$pid"
  echo "Checkpoint requested. Watch: ralph attach ${session#ralph-}"
}

# =============================================================================
# Subcommand Dispatch (before arg parsing)
# =============================================================================

case "${1:-}" in
  attach)     shift; cmd_attach "$1"; exit 0 ;;
  status)
    if [ "${2:-}" = "--json" ]; then
      get_all_sessions_json
    else
      cmd_status
    fi
    exit 0
    ;;
  stop)       shift; cmd_stop "$1"; exit 0 ;;
  checkpoint) shift; cmd_checkpoint "$1"; exit 0 ;;
  --version|-v) echo "ralph version $VERSION"; exit 0 ;;
esac

# =============================================================================
# Configuration
# =============================================================================

RUNNING_IN_TMUX="${RALPH_TMUX_SESSION:-}"

# Parse command line arguments
TASK_DIR=""
MAX_ITERATIONS=""
SKIP_PROMPTS=false
ROTATE_THRESHOLD=300

# Agent configuration
AGENT="${RALPH_AGENT:-claude}"
AGENT_SOURCE="default"
[ -n "$RALPH_AGENT" ] && AGENT_SOURCE="env"

# Yolo mode - permissive mode that skips all agent permission prompts
YOLO_MODE="${YOLO_MODE:-false}"

VALID_AGENTS="claude opencode"

declare -A FAILURE_COUNT
declare -A LAST_FAILURE_MSG
for agent in $VALID_AGENTS; do
  FAILURE_COUNT[$agent]=0
  LAST_FAILURE_MSG[$agent]=""
done

FAILOVER_THRESHOLD="${RALPH_FAILOVER_THRESHOLD:-3}"
FAILOVER_THRESHOLD_SOURCE="default"
[ -n "$RALPH_FAILOVER_THRESHOLD" ] && FAILOVER_THRESHOLD_SOURCE="env"
if ! [[ "$FAILOVER_THRESHOLD" =~ ^[0-9]+$ ]]; then
  echo "Warning: Invalid RALPH_FAILOVER_THRESHOLD, using 3"
  FAILOVER_THRESHOLD=3
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
    --yolo)
      YOLO_MODE=true
      shift
      ;;
    -a)
      AGENT="$2"
      AGENT_SOURCE="cli"
      shift 2
      ;;
    -h|--help)
      cat << 'EOF'
Ralph - Autonomous Multi-Agent Coding Loop (v2.0.0)

Usage: ralph [command] [task-directory] [options]

Commands:
  (default)             Start task (runs in tmux background)
  attach [task]         Watch running session output
  checkpoint [task]     Graceful stop with state save
  stop [task]           Force stop session
  status                List running sessions

Options:
  -i, --iterations N        Max iterations (default: 10)
  -a, --agent NAME          Agent: claude, opencode (default: claude)
  --failover-threshold N    Failures before agent switch (default: 3)
  --yolo                    Permissive mode: skip all agent permission prompts
  -y, --yes                 Skip prompts
  --rotate-at N             Rotate progress at N lines (default: 300)
  --version                 Show version
  -h, --help                Show help

Examples:
  ralph tasks/my-feature       # Start in background
  ralph attach                 # Watch output
  ralph checkpoint             # Graceful stop

For TUI: ralph-tui
EOF
      exit 0
      ;;
    -*)
      echo "Unknown option: $1"
      echo "Run 'ralph --help' for usage."
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
# Look for prompt.md in installed location first, then repo location
if [ -f "$HOME/.local/share/ralph/prompt.md" ]; then
  PROMPT_FILE="$HOME/.local/share/ralph/prompt.md"
elif [ -f "$SCRIPT_DIR/prompt.md" ]; then
  PROMPT_FILE="$SCRIPT_DIR/prompt.md"
else
  echo "Error: prompt.md not found"
  echo "Expected locations:"
  echo "  - $HOME/.local/share/ralph/prompt.md (installed)"
  echo "  - $SCRIPT_DIR/prompt.md (repo)"
  exit 1
fi

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
AGENT_SCRIPT="$AGENTS_DIR/$AGENT.sh"
if [ ! -f "$AGENT_SCRIPT" ]; then
  echo "Error: Agent script not found: $AGENT_SCRIPT"
  echo "Valid agents: $(ls "$AGENTS_DIR/"*.sh 2>/dev/null | xargs -n1 basename | sed 's/\.sh$//' | grep -v '^common$' | tr '\n' ' ')"
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
# Note: Threshold prompting now happens BEFORE tmux spawn, so this just rotates
rotate_progress_if_needed() {
  local lines=$(wc -l < "$PROGRESS_FILE")

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

# Function to generate a summary document at the end of a Ralph run
# Creates SUMMARY.md in the task directory with comprehensive run details
generate_summary() {
  local exit_reason="$1"  # "complete", "max_iterations", or "all_agents_failed"
  local summary_file="$FULL_TASK_DIR/SUMMARY.md"
  local end_time=$(date)
  local start_time=$(grep "^Started:" "$PROGRESS_FILE" | head -1 | sed 's/Started: //')
  
  # Get story details from prd.json
  local completed=$(jq '[.userStories[] | select(.passes == true)] | length' "$PRD_FILE" 2>/dev/null || echo "0")
  local total=$(jq '.userStories | length' "$PRD_FILE" 2>/dev/null || echo "0")
  local prd_type=$(jq -r '.type // "feature"' "$PRD_FILE" 2>/dev/null || echo "feature")
  local description=$(jq -r '.description // "No description"' "$PRD_FILE" 2>/dev/null || echo "No description")
  local branch=$(jq -r '.branchName // "unknown"' "$PRD_FILE" 2>/dev/null || echo "unknown")
  
  # Count git commits on the branch
  local commit_count=$(git log --oneline "$branch" 2>/dev/null | wc -l || echo "0")
  local recent_commits=$(git log --oneline -10 "$branch" 2>/dev/null || echo "No commits found")
  
  # Get files changed (if on branch)
  local files_changed=""
  if git rev-parse --verify "$branch" >/dev/null 2>&1; then
    local base_branch=$(git merge-base main "$branch" 2>/dev/null || git merge-base master "$branch" 2>/dev/null || echo "")
    if [ -n "$base_branch" ]; then
      files_changed=$(git diff --name-only "$base_branch" "$branch" 2>/dev/null | head -50)
    fi
  fi
  
  # Extract codebase patterns from progress.txt
  local patterns=""
  if grep -q "## Codebase Patterns" "$PROGRESS_FILE"; then
    patterns=$(sed -n '/## Codebase Patterns/,/^## [^C]/p' "$PROGRESS_FILE" | sed '1d;$d')
  fi
  
  # Count iterations from progress file
  local iteration_count=$(grep -c "^## [0-9-]* [0-9:]* - " "$PROGRESS_FILE" 2>/dev/null || echo "$CURRENT_ITERATION")
  
  # Determine status emoji and text
  local status_emoji status_text
  case "$exit_reason" in
    complete)
      status_emoji="✅"
      status_text="COMPLETED SUCCESSFULLY"
      ;;
    max_iterations)
      status_emoji="⏸️"
      status_text="PAUSED (max iterations reached)"
      ;;
    all_agents_failed)
      status_emoji="❌"
      status_text="STOPPED (all agents failed)"
      ;;
    *)
      status_emoji="❓"
      status_text="ENDED"
      ;;
  esac
  
  # Generate the summary document
  cat > "$summary_file" << EOF
# Ralph Run Summary

## $status_emoji Status: $status_text

**Task:** $(basename "$FULL_TASK_DIR")
**Type:** $prd_type
**Description:** $description

---

## Run Details

| Metric | Value |
|--------|-------|
| Started | $start_time |
| Ended | $end_time |
| Branch | \`$branch\` |
| Stories Completed | $completed / $total |
| Iterations Run | $iteration_count |
| Final Agent | $AGENT |

---

## Story Status

EOF

  # Add story details
  jq -r '.userStories[] | "### " + .id + ": " + .title + "\n- **Status:** " + (if .passes then "✅ Complete" else "❌ Incomplete" end) + "\n- **Priority:** " + (.priority | tostring) + (if .notes != "" then "\n- **Notes:** " + .notes else "" end) + "\n"' "$PRD_FILE" >> "$summary_file" 2>/dev/null

  # Add acceptance criteria details for incomplete stories
  cat >> "$summary_file" << EOF

---

## Incomplete Work

EOF

  local incomplete=$(jq -r '.userStories[] | select(.passes == false) | .id + ": " + .title' "$PRD_FILE" 2>/dev/null)
  if [ -z "$incomplete" ]; then
    echo "All stories completed!" >> "$summary_file"
  else
    echo "The following stories remain incomplete:" >> "$summary_file"
    echo "" >> "$summary_file"
    jq -r '.userStories[] | select(.passes == false) | "- **" + .id + ":** " + .title' "$PRD_FILE" >> "$summary_file" 2>/dev/null
    echo "" >> "$summary_file"
    echo "### Incomplete Acceptance Criteria" >> "$summary_file"
    echo "" >> "$summary_file"
    jq -r '.userStories[] | select(.passes == false) | "**" + .id + ":**\n" + ([.acceptanceCriteria[] | select(.passes == false or .passes == null) | "- [ ] " + (if type == "object" then .description else . end)] | join("\n")) + "\n"' "$PRD_FILE" >> "$summary_file" 2>/dev/null
  fi

  # Add codebase patterns if found
  if [ -n "$patterns" ]; then
    cat >> "$summary_file" << EOF

---

## Codebase Patterns Discovered

$patterns
EOF
  fi

  # Add files changed
  if [ -n "$files_changed" ]; then
    cat >> "$summary_file" << EOF

---

## Files Changed

\`\`\`
$files_changed
\`\`\`
EOF
  fi

  # Add recent commits
  cat >> "$summary_file" << EOF

---

## Recent Commits

\`\`\`
$recent_commits
\`\`\`

---

## Next Steps

EOF

  case "$exit_reason" in
    complete)
      cat >> "$summary_file" << EOF
1. Review the changes on branch \`$branch\`
2. Run full test suite: \`npm test\` or equivalent
3. Create a pull request if satisfied
4. Archive this task: \`mkdir -p tasks/archived && mv $TASK_DIR tasks/archived/\`
EOF
      ;;
    max_iterations)
      cat >> "$summary_file" << EOF
1. Review progress in \`progress.txt\`
2. Check if stories are stuck (might need PRD adjustment)
3. Resume with more iterations: \`ralph $TASK_DIR -i 20\`
4. Or investigate incomplete stories manually
EOF
      ;;
    all_agents_failed)
      cat >> "$summary_file" << EOF
1. Check API keys and rate limits
2. Review error logs in \`progress.txt\`
3. Wait and retry: \`ralph $TASK_DIR\`
4. Try a different agent: \`ralph $TASK_DIR --agent opencode\`
EOF
      ;;
  esac

  cat >> "$summary_file" << EOF

---

*Generated by Ralph v$VERSION at $end_time*
EOF

  echo "$summary_file"
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

# =============================================================================
# tmux Session Setup
# =============================================================================

SESSION_NAME=$(get_session_name "$TASK_DIR")

# Check if session already exists (and we're not inside it)
if session_exists "$SESSION_NAME" && [ -z "$RUNNING_IN_TMUX" ]; then
  echo "Error: Session '$SESSION_NAME' already running."
  echo ""
  echo "  ralph attach      # Watch output"
  echo "  ralph checkpoint  # Graceful stop"
  echo "  ralph stop        # Force stop"
  exit 1
fi

# If not in tmux, spawn ourselves in a new tmux session
if [ -z "$RUNNING_IN_TMUX" ]; then
  check_tmux
  
  # Check rotation threshold BEFORE spawning tmux (so user sees the prompt)
  if [ -f "$PROGRESS_FILE" ] && [ "$SKIP_PROMPTS" = false ]; then
    local_lines=$(wc -l < "$PROGRESS_FILE")
    local_has_prior_rotation=false
    [ -f "$FULL_TASK_DIR/progress-1.txt" ] && local_has_prior_rotation=true
    
    local_within_threshold=$((ROTATE_THRESHOLD - 50))
    if [ $local_lines -gt $local_within_threshold ] || [ "$local_has_prior_rotation" = true ]; then
      echo ""
      echo "Progress file has $local_lines lines (rotation threshold: $ROTATE_THRESHOLD)"
      read -p "Rotation threshold [$ROTATE_THRESHOLD]: " NEW_THRESHOLD
      if [ -n "$NEW_THRESHOLD" ] && [[ "$NEW_THRESHOLD" =~ ^[0-9]+$ ]]; then
        ROTATE_THRESHOLD=$NEW_THRESHOLD
      fi
    fi
  fi
  
  echo ""
  echo "======================================================================="
  echo "  Starting Ralph in background"
  echo "======================================================================="
  echo ""
  echo "  Session:    $SESSION_NAME"
  echo "  Task:       $TASK_DIR"
  echo "  Progress:   $COMPLETED_STORIES / $TOTAL_STORIES stories"
  echo "  Max iters:  $MAX_ITERATIONS"
  echo "  Agent:      $AGENT ($AGENT_SOURCE)"
  echo ""
  echo "  $DESCRIPTION"
  echo ""
  echo "-----------------------------------------------------------------------"
  echo "  ralph attach      # Watch output"
  echo "  ralph checkpoint  # Graceful stop"
  echo "  ralph stop        # Force stop"
  echo ""
  
  # Build tmux command - use absolute path for task dir
  # Pass -y to skip prompts inside tmux since we already prompted
  TMUX_CMD="RALPH_TMUX_SESSION='$SESSION_NAME' '$0' '$FULL_TASK_DIR' -i $MAX_ITERATIONS --agent '$AGENT' -y"
  [ "$YOLO_MODE" = true ] && TMUX_CMD+=" --yolo"
  TMUX_CMD+=" --rotate-at $ROTATE_THRESHOLD --failover-threshold $FAILOVER_THRESHOLD"
  
  tmux new-session -d -s "$SESSION_NAME" -x 200 -y 50 "bash -c '$TMUX_CMD'"
  
  # Register session in global database (get PID from tmux)
  sleep 0.5  # Give tmux a moment to start
  TMUX_PID=$(tmux list-panes -t "$SESSION_NAME" -F "#{pane_pid}" 2>/dev/null | head -1)
  register_session "$SESSION_NAME" "$FULL_TASK_DIR" "${TMUX_PID:-0}" "$AGENT" "$MAX_ITERATIONS" "$TOTAL_STORIES" "$COMPLETED_STORIES"
  
  exit 0
fi

# =============================================================================
# Running inside tmux - Main Loop
# =============================================================================

# Write PID for checkpoint command
echo $$ > "/tmp/${SESSION_NAME}.pid"
trap 'rm -f "/tmp/${SESSION_NAME}.pid"' EXIT

echo ""
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║  Ralph - Autonomous Agent Loop (v$VERSION)                      ║"
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
echo "  To checkpoint: ralph checkpoint (from another terminal)"
echo ""

for i in $(seq 1 $MAX_ITERATIONS); do
  CURRENT_ITERATION=$i
  
  # Check for checkpoint request
  if [ "$CHECKPOINT_REQUESTED" = true ]; then
    write_checkpoint "user"
    finish_session "$SESSION_NAME" "stopped"
    exit 0
  fi
  # Check and rotate progress file if needed
  rotate_progress_if_needed

  # Refresh progress count
  COMPLETED_STORIES=$(jq '[.userStories[] | select(.passes == true)] | length' "$PRD_FILE" 2>/dev/null || echo "?")
  
  # Update global session registry
  update_session_progress "$SESSION_NAME" "$CURRENT_ITERATION" "$COMPLETED_STORIES"

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
  ITERATION_AGENT_SCRIPT="$AGENTS_DIR/$ITERATION_AGENT.sh"

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
  # Note: export ensures env vars are available to piped command
  export SKIP_PERMISSIONS=true
  export OUTPUT_FORMAT=stream-json
  export RALPH_VERBOSE=true
  export MODEL="$ITERATION_MODEL"
  export YOLO_MODE="$YOLO_MODE"
  
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

    # Parse output for status updates (supports multiple formats)
    if [ -f "$OUTPUT_FILE" ]; then
      # Get last 50 lines for parsing (use strings to handle binary content)
      RECENT_OUTPUT=$(tail -c 8192 "$OUTPUT_FILE" 2>/dev/null | strings 2>/dev/null)
      
      # Try multiple patterns in order of preference:
      
      # 1. OpenCode debug logs: permission=bash pattern=<command>
      # Extract just the command, stopping at ruleset= or end of relevant content
      BASH_CMD=$(echo "$RECENT_OUTPUT" | grep -o 'permission=bash pattern=[^ ]*' | tail -1 | sed 's/permission=bash pattern=//')
      if [ -n "$BASH_CMD" ]; then
        # Clean up and truncate
        BASH_CMD=$(echo "$BASH_CMD" | head -c 60)
        LAST_STATUS="$ $BASH_CMD"
      else
        # 2. OpenCode debug logs: permission=<tool> pattern=<path>
        # Extract tool name and the file/pattern it's operating on
        TOOL_LINE=$(echo "$RECENT_OUTPUT" | grep -oE 'permission=(read|write|edit|glob|grep|webfetch|task) pattern=[^ ]+' | tail -1)
        TOOL_PATTERN=$(echo "$TOOL_LINE" | sed 's/permission=//' | sed 's/ pattern=/: /' | head -c 60)
        if [ -n "$TOOL_PATTERN" ]; then
          LAST_STATUS="Using $TOOL_PATTERN..."
        else
          # 3. Text content in the output (assistant speaking)
          # Look for lines that look like actual text, not log fragments
          # Must be at least 10 chars, no '=' signs (log format), and start with a letter
          TEXT_LINE=$(echo "$RECENT_OUTPUT" | grep -v '^INFO\|^ERROR\|^WARN\|^DEBUG\|service=\|status=\|permission=\|pattern=\|duration=\|cwd=\|git=' | grep -v '^\[\|^{' | grep '^[A-Za-z]' | tail -5 | awk 'length > 15' | tail -1 | head -c 70)
          if [ -n "$TEXT_LINE" ]; then
            LAST_STATUS="$TEXT_LINE"
          else
            # 4. JSON format: tool_name field
            TOOL_NAME=$(echo "$RECENT_OUTPUT" | grep -o '"tool_name":"[^"]*"' | tail -1 | cut -d'"' -f4)
            if [ -n "$TOOL_NAME" ]; then
              LAST_STATUS="Using $TOOL_NAME..."
            else
              # 5. JSON format: text content
              TEXT_PREVIEW=$(echo "$RECENT_OUTPUT" | grep -o '"text":"[^"]*"' | tail -1 | cut -d'"' -f4 | head -c 60)
              if [ -n "$TEXT_PREVIEW" ]; then
                LAST_STATUS="$TEXT_PREVIEW"
              fi
            fi
          fi
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
        
        # Generate summary document
        SUMMARY_FILE=$(generate_summary "all_agents_failed")
        echo "  📄 Summary generated: $SUMMARY_FILE"
        echo ""
        echo "  Check $PROGRESS_FILE for detailed failure logs."
        
        # Mark session as failed in global registry
        finish_session "$SESSION_NAME" "failed"
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
      AGENT_SCRIPT="$AGENTS_DIR/$AGENT.sh"
      
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
    echo ""
    
    # Generate summary document
    SUMMARY_FILE=$(generate_summary "complete")
    echo "  📄 Summary generated: $SUMMARY_FILE"
    echo ""
    echo "  Check $PROGRESS_FILE for iteration details."
    echo ""

    # Offer to archive
    echo "  To archive this completed effort:"
    echo "    mkdir -p tasks/archived && mv $TASK_DIR tasks/archived/"
    echo ""
    
    # Mark session as completed in global registry
    finish_session "$SESSION_NAME" "completed"
    exit 0
  fi

  # Check for checkpoint after iteration
  if [ "$CHECKPOINT_REQUESTED" = true ]; then
    write_checkpoint "user"
    finish_session "$SESSION_NAME" "stopped"
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
echo "  Agent: $AGENT"
echo ""

# Generate summary document
SUMMARY_FILE=$(generate_summary "max_iterations")
echo "  📄 Summary generated: $SUMMARY_FILE"
echo ""
echo "  Check $PROGRESS_FILE for iteration details."
echo "  Run again: ralph $TASK_DIR -i <more_iterations>"

# Mark session as stopped in global registry
finish_session "$SESSION_NAME" "stopped"
exit 1
