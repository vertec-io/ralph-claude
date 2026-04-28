#!/usr/bin/env bash
# Installs ralph-monitor hooks into ~/.claude/settings.json.
# Idempotent: runs jq with a uniqueness check on our hook command path.
# Safe: backs up the prior settings.json to settings.json.bak before writing.

set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required (apt: sudo apt install jq, brew: brew install jq)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_CMD="$SCRIPT_DIR/post-event.sh"

if [[ ! -x "$HOOK_CMD" ]]; then
  chmod +x "$HOOK_CMD" || { echo "error: cannot chmod $HOOK_CMD" >&2; exit 1; }
fi

SETTINGS="$HOME/.claude/settings.json"
mkdir -p "$(dirname "$SETTINGS")"
[[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"

# Backup
cp "$SETTINGS" "$SETTINGS.bak"

# Idempotent reinstall: first strip any existing entries with our cmd path,
# then add the canonical set. This way upgrading the hook schema (e.g. adding
# PreToolUse(Task)) Just Works on rerun.
TMP=$(mktemp)
jq --arg cmd "$HOOK_CMD" '
  # Strip prior ralph-monitor entries
  (if .hooks then
     .hooks |= with_entries(
       .value |= (
         map(
           .hooks |= map(select(.command != $cmd))
           | select((.hooks // []) | length > 0)
         )
       )
     )
   else . end)

  # Add canonical set
  | .hooks //= {}
  | .hooks.PreToolUse //= []
  | .hooks.PostToolUse //= []
  | .hooks.Stop //= []
  | .hooks.UserPromptSubmit //= []
  | .hooks.PreToolUse += [{
      "matcher": "Task|Agent",
      "hooks": [{"type": "command", "command": $cmd}]
    }]
  | .hooks.PostToolUse += [{
      "matcher": "Edit|Write|Task|Agent",
      "hooks": [{"type": "command", "command": $cmd}]
    }]
  | .hooks.Stop += [{
      "hooks": [{"type": "command", "command": $cmd}]
    }]
  | .hooks.UserPromptSubmit += [{
      "hooks": [{"type": "command", "command": $cmd}]
    }]
' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"

echo "installed ralph-monitor hooks"
echo "  hook command: $HOOK_CMD"
echo "  settings:     $SETTINGS (backup: $SETTINGS.bak)"
echo
echo "events captured:"
echo "  PreToolUse  (Task)               → agent dispatch start"
echo "  PostToolUse (Edit|Write|Task|Agent) → tool completion + agent end"
echo "  Stop                             → orchestrator turn boundary"
echo "  UserPromptSubmit                 → user message into orchestrator"
echo
echo "(rerunning install.sh is safe — it strips and re-adds our entries)"
echo "uninstall: bash $SCRIPT_DIR/uninstall.sh"
