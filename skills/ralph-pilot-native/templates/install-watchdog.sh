#!/usr/bin/env bash
# install-watchdog.sh — bootstrap the ralph-pilot-native systemd user watchdog
#
# Usage:
#   bash install-watchdog.sh <task-dir> <worktree-dir> <session-id>
#
# Args:
#   task-dir      Absolute path to tasks/<prd-slug>/
#   worktree-dir  Absolute path to the git worktree (claude --resume cwd)
#   session-id    Claude Code session ID (basename of *.jsonl in ~/.claude/projects/<encoded-cwd>/)
#
# Effects:
#   - Renders ~/.config/systemd/user/ralph-pilot-native-<task-slug>.{service,timer}
#   - Copies run-watchdog.sh into <task-dir>/.watchdog/
#   - Copies watchdog-prompt.md into <task-dir>/
#   - Runs systemctl --user daemon-reload and enables the timer

set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <task-dir> <worktree-dir> <session-id>" >&2
  exit 2
fi

TASK_DIR="$1"
WORKTREE_DIR="$2"
SESSION_ID="$3"

# Validate args
[[ -d "$TASK_DIR" ]]      || { echo "task-dir does not exist: $TASK_DIR" >&2; exit 1; }
[[ -d "$WORKTREE_DIR" ]]  || { echo "worktree-dir does not exist: $WORKTREE_DIR" >&2; exit 1; }
[[ -n "$SESSION_ID" ]]    || { echo "session-id is empty" >&2; exit 1; }

# Make all paths absolute (systemd requires absolute paths in unit files)
TASK_DIR="$(cd "$TASK_DIR" && pwd)"
WORKTREE_DIR="$(cd "$WORKTREE_DIR" && pwd)"

# Skill template directory (this script's own location)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Sanity-check templates
for t in run-watchdog.sh watchdog-prompt.md watchdog.service.template watchdog.timer.template; do
  [[ -f "$SCRIPT_DIR/$t" ]] || { echo "missing template: $SCRIPT_DIR/$t" >&2; exit 1; }
done

# Derive a stable unit name from the task dir basename
TASK_SLUG="$(basename "$TASK_DIR")"
UNIT_NAME="ralph-pilot-native-${TASK_SLUG}"

SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"

# Stage runtime files into the task dir
mkdir -p "$TASK_DIR/.watchdog"
cp "$SCRIPT_DIR/run-watchdog.sh"      "$TASK_DIR/.watchdog/run-watchdog.sh"
cp "$SCRIPT_DIR/watchdog-prompt.md"   "$TASK_DIR/watchdog-prompt.md"
chmod +x "$TASK_DIR/.watchdog/run-watchdog.sh"

WATCHDOG_SCRIPT="$TASK_DIR/.watchdog/run-watchdog.sh"

# Render service unit
sed -e "s|@TASK_DIR@|$TASK_DIR|g" \
    -e "s|@WORKTREE_DIR@|$WORKTREE_DIR|g" \
    -e "s|@SESSION_ID@|$SESSION_ID|g" \
    -e "s|@WATCHDOG_SCRIPT@|$WATCHDOG_SCRIPT|g" \
    -e "s|@UNIT_NAME@|$UNIT_NAME|g" \
    "$SCRIPT_DIR/watchdog.service.template" > "$SYSTEMD_DIR/$UNIT_NAME.service"

# Render timer unit
sed -e "s|@UNIT_NAME@|$UNIT_NAME|g" \
    "$SCRIPT_DIR/watchdog.timer.template" > "$SYSTEMD_DIR/$UNIT_NAME.timer"

# Initial heartbeat so the first tick sees liveness
touch "$TASK_DIR/.heartbeat"

# Enable + start the timer
systemctl --user daemon-reload
systemctl --user enable --now "$UNIT_NAME.timer"

cat <<EOF
ralph-pilot-native watchdog installed.

  Unit:        $UNIT_NAME.timer
  Task dir:    $TASK_DIR
  Worktree:    $WORKTREE_DIR
  Session ID:  $SESSION_ID
  Service:     $SYSTEMD_DIR/$UNIT_NAME.service
  Timer:       $SYSTEMD_DIR/$UNIT_NAME.timer
  Heartbeat:   $TASK_DIR/.heartbeat
  Watchdog log: $TASK_DIR/.watchdog/watchdog.log

Inspect:
  systemctl --user status  $UNIT_NAME.timer
  systemctl --user list-timers | grep $UNIT_NAME
  journalctl --user -u $UNIT_NAME.service -f

Disable:
  touch $TASK_DIR/.stop-watchdog
  # OR
  systemctl --user disable --now $UNIT_NAME.timer
EOF
