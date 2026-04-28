#!/usr/bin/env bash
# run-watchdog.sh — single watchdog tick
#
# Fired by the systemd user timer every ~25 min. Checks <task-dir>/.heartbeat;
# if stale, resurrects the orchestrator session via `claude --resume <id>`.
#
# Args (passed by the systemd unit):
#   $1 = task-dir       (absolute)
#   $2 = worktree-dir   (absolute, used as cwd for claude --resume)
#   $3 = session-id     (claude session id)

set -euo pipefail

TASK_DIR="$1"
WORKTREE_DIR="$2"
SESSION_ID="$3"

LOG_DIR="$TASK_DIR/.watchdog"
LOG="$LOG_DIR/watchdog.log"
LOCK="$LOG_DIR/lock"
HEARTBEAT="$TASK_DIR/.heartbeat"
STOP_SIGNAL="$TASK_DIR/.stop-watchdog"

mkdir -p "$LOG_DIR"

log() { echo "[$(date -Iseconds)] $*" >> "$LOG"; }

# Acquire flock; if another tick is mid-resurrect, exit immediately
exec 9>"$LOCK"
if ! flock -n 9; then
  log "skip: another tick holds the lock"
  exit 0
fi

# Honor the stop signal
if [[ -f "$STOP_SIGNAL" ]]; then
  UNIT_NAME="ralph-pilot-native-$(basename "$TASK_DIR")"
  log "stop signal present: disabling $UNIT_NAME.timer"
  systemctl --user disable --now "$UNIT_NAME.timer" >> "$LOG" 2>&1 || true
  exit 0
fi

# Multi-signal liveness check. The orchestrator is "alive" if ANY of:
#   1. .heartbeat file mtime < 20 min old (cooperative signal — orchestrator updates it)
#   2. A claude process exists whose cwd is the worktree (process-presence)
#   3. The session JSONL has been written to in the last 30 min (session-activity)
#
# Signals 2 and 3 catch the case where the orchestrator is blocked on a long
# synchronous Agent call (can't touch .heartbeat for 30+ min) but is still
# very much alive.
NOW=$(date +%s)
HEARTBEAT_THRESHOLD_SECS=1200      # 20 min
JSONL_THRESHOLD_SECS=1800          # 30 min — more lenient (fallback signal)

is_alive=false
reason=""

# Signal 1: heartbeat file
if [[ -f "$HEARTBEAT" ]]; then
  HB_AGE=$(( NOW - $(stat -c %Y "$HEARTBEAT") ))
  if (( HB_AGE < HEARTBEAT_THRESHOLD_SECS )); then
    is_alive=true
    reason="heartbeat ${HB_AGE}s old"
  fi
fi

# Signal 2: any claude process whose cwd is the worktree
if ! $is_alive; then
  for pid in $(pgrep -x claude 2>/dev/null || true); do
    pid_cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    if [[ "$pid_cwd" == "$WORKTREE_DIR" ]]; then
      is_alive=true
      reason="claude pid $pid has cwd=$WORKTREE_DIR"
      break
    fi
  done
fi

# Signal 3: session JSONL written to recently
if ! $is_alive; then
  ENCODED_CWD="$(echo "$WORKTREE_DIR" | sed 's|/|-|g')"
  JSONL="$HOME/.claude/projects/$ENCODED_CWD/$SESSION_ID.jsonl"
  if [[ -f "$JSONL" ]]; then
    JL_AGE=$(( NOW - $(stat -c %Y "$JSONL") ))
    if (( JL_AGE < JSONL_THRESHOLD_SECS )); then
      is_alive=true
      reason="session jsonl written ${JL_AGE}s ago"
    fi
  fi
fi

if $is_alive; then
  log "alive: $reason, no action"
  exit 0
fi

log "stale: no liveness signals, resurrecting"

# Find claude binary
CLAUDE_BIN="$(command -v claude || true)"
if [[ -z "$CLAUDE_BIN" ]]; then
  for candidate in "$HOME/.local/bin/claude" "$HOME/.bun/bin/claude" "/usr/local/bin/claude"; do
    if [[ -x "$candidate" ]]; then CLAUDE_BIN="$candidate"; break; fi
  done
fi
if [[ -z "$CLAUDE_BIN" ]]; then
  log "ERROR: claude binary not found in PATH or known locations"
  exit 1
fi

# Refresh the heartbeat BEFORE spawning so we don't trigger another tick
# while the resumed session is starting up.
touch "$HEARTBEAT"

# Read the watchdog prompt
PROMPT_FILE="$TASK_DIR/watchdog-prompt.md"
if [[ ! -f "$PROMPT_FILE" ]]; then
  log "ERROR: watchdog-prompt.md missing at $PROMPT_FILE"
  exit 1
fi

log "spawning: $CLAUDE_BIN --resume $SESSION_ID -p (cwd=$WORKTREE_DIR)"

# Run claude --resume with skip-perms and the watchdog prompt as stdin/-p input
# We use --print so it runs to completion non-interactively.
# Output is appended to the watchdog log.
cd "$WORKTREE_DIR"
{
  echo "===== resurrection $(date -Iseconds) ====="
  # </dev/null avoids the CLI's 3s stdin probe. We pass the prompt as a positional arg,
  # not via stdin; without this redirect every resurrection eats a 3-second wait.
  "$CLAUDE_BIN" \
    --resume "$SESSION_ID" \
    --dangerously-skip-permissions \
    --print \
    "$(cat "$PROMPT_FILE")" </dev/null
  echo "===== resurrection complete (exit=$?) ====="
} >> "$LOG" 2>&1 || log "WARN: claude --resume exited non-zero"

# Refresh heartbeat after the resumed session exits, so the next tick can
# see whether the session continued working (it will have updated .heartbeat
# itself if it did real work) or just bounced off.
log "tick complete"
