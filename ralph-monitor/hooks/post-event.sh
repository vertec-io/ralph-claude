#!/usr/bin/env bash
# Forwards a Claude Code hook payload (JSON on stdin) to the ralph-monitor server.
# Fails silently and quickly so the agent is never blocked by this hook.
exec curl -s --max-time 1 \
  -X POST "http://127.0.0.1:${RALPH_MONITOR_PORT:-7777}/event" \
  -H 'Content-Type: application/json' \
  --data-binary @- > /dev/null 2>&1 || true
