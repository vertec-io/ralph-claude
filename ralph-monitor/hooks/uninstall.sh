#!/usr/bin/env bash
# Removes ralph-monitor hooks from ~/.claude/settings.json.

set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_CMD="$SCRIPT_DIR/post-event.sh"

SETTINGS="$HOME/.claude/settings.json"
if [[ ! -f "$SETTINGS" ]]; then
  echo "no settings.json found at $SETTINGS — nothing to uninstall"
  exit 0
fi

cp "$SETTINGS" "$SETTINGS.bak"

TMP=$(mktemp)
jq --arg cmd "$HOOK_CMD" '
  if .hooks then
    .hooks |= with_entries(
      .value |= (
        map(
          .hooks |= map(select(.command != $cmd))
          | select((.hooks // []) | length > 0)
        )
      )
    )
    | (if (.hooks | length) == 0 then del(.hooks) else . end)
  else . end
' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"

echo "uninstalled ralph-monitor hooks from $SETTINGS (backup: $SETTINGS.bak)"
