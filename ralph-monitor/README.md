# ralph-monitor

A local web app that monitors `/ralph-pilot-native` PRDs in real time. Renders each PRD's `prd.json` story tree, criterion-level progress, recent commits, watchdog liveness, decision-gate state, and a cross-PRD live event feed.

## Architecture

- **Server** (`server/index.ts`) — Bun + Hono. SSE on `/events`, JSON snapshot on `/api/state`, hook receiver on `/event`. Listens on `127.0.0.1:7777`.
- **Discovery** (`server/discovery.ts`) — walks `~/.config/systemd/user/ralph-pilot-native-*.service` and parses `ExecStart` to extract task-dir / worktree-dir / session-id. New units auto-appear; removed units auto-disappear.
- **Watchers** (`server/watchers.ts`) — chokidar watches per-PRD `prd.json`, `.heartbeat`, `.watchdog/watchdog.log`, `decisions/`, and `.git/refs/heads/*`. Debounced 250 ms. Plus a 15 s safety refresh for process-presence.
- **Liveness** (`server/liveness.ts`) — same multi-signal model as the watchdog (`run-watchdog.sh`): heartbeat freshness, claude-comm-with-cwd-match, JSONL mtime.
- **UI** (`ui/`) — React 18 + Vite + Tailwind 4. Three-pane layout: PRD list / detail / event feed. Subscribes to `/events`, re-fetches `/api/state` on each `update` event for simplicity.
- **Hooks** (`hooks/`) — opt-in. `install.sh` jq-merges Claude Code hooks (`PostToolUse: Edit|Write|Agent`, `Stop`, `UserPromptSubmit`) into `~/.claude/settings.json`. Hook scripts forward JSON to `localhost:7777/event`. Backup of settings written each install/uninstall.

## Requirements

- Bun (https://bun.sh)
- jq (for hook installation only)
- systemd-user (Linux). The discovery layer reads `~/.config/systemd/user/`.

## Setup

```bash
cd ~/dev/ralph-claude/ralph-monitor
bun install
bun run dev          # starts server on 7777, UI on 5173
```

Open <http://localhost:5173>.

If a `/ralph-pilot-native` watchdog is already installed somewhere, it should appear in the PRD list immediately.

## Run as a background service

```bash
bash install-service.sh
```

Starts the server under `systemd --user` so it survives logout. Then access <http://localhost:7777> directly (production: serve the built UI from the same Bun process — see Production below).

To stop:

```bash
systemctl --user disable --now ralph-monitor.service
```

## Hooks (optional)

Hooks reduce event latency from ~1s (filesystem polling) to ~50ms (immediate push). Install once:

```bash
bash hooks/install.sh
```

This edits `~/.claude/settings.json` (backup at `~/.claude/settings.json.bak`). Captures:

- `PostToolUse` (matcher: `Edit|Write|Agent`) — surfaces tool-use activity in the event feed
- `Stop` — orchestrator turn boundaries
- `UserPromptSubmit` — when you send a message into the orchestrator

The hooks are scoped per-cwd. The server filters events by matching `cwd` against known PRD worktree paths; events from unrelated Claude Code sessions are still recorded but not attributed to a PRD.

To uninstall:

```bash
bash hooks/uninstall.sh
```

## Production (single-binary UI)

```bash
bun run build              # builds UI to dist/
# Then have server serve dist/ as static — TODO if you want to skip Vite in prod.
```

For local dev, just run `bun run dev` and use Vite's HMR.

## Status pips

| Color  | Meaning                                                                                  |
|--------|------------------------------------------------------------------------------------------|
| 🟢 active   | heartbeat fresh OR claude process alive in worktree                                  |
| 🟡 idle     | no heartbeat / no process, but session JSONL written within 30 min                   |
| 🔴 crashed  | none of the above; orchestrator presumed dead                                        |
| 🔵 complete | every story in `prd.json` has `passes: true`                                          |
| 🟣 blocked  | at least one decision file is pending and no other progress signal                   |

## Why this exists

`/ralph-pilot-native` runs PRDs as a single Claude Code session backed by a systemd watchdog. This UI gives you the same observability you'd get from `ralph-tui` — but for the native execution model, with cross-PRD aggregation and a richer live event feed. See `~/.claude/skills/ralph-pilot-native/SKILL.md` for the orchestration model.
