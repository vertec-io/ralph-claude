#!/usr/bin/env bash
# Installs ralph-monitor as a systemd --user service.
# Renders the template with absolute paths from THIS install location.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/ralph-monitor.service.template"
SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"

BUN_BIN="$(command -v bun || true)"
[[ -z "$BUN_BIN" ]] && { echo "error: bun not found in PATH"; exit 1; }

sed -e "s|@INSTALL_DIR@|$SCRIPT_DIR|g" \
    -e "s|@BUN_BIN@|$BUN_BIN|g" \
    "$TEMPLATE" > "$SYSTEMD_DIR/ralph-monitor.service"

systemctl --user daemon-reload
systemctl --user enable --now ralph-monitor.service

echo "installed and started ralph-monitor.service"
echo "  status:  systemctl --user status ralph-monitor.service"
echo "  logs:    journalctl --user -u ralph-monitor.service -f"
echo "  ui dev:  cd $SCRIPT_DIR && bun run dev:ui"
echo "  stop:    systemctl --user disable --now ralph-monitor.service"
