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

## Session manager — restart and recovery

Beyond passive PRD watching, ralph-monitor now also operates as a local Claude conversation manager: it stores projects → efforts → sessions in sqlite, owns PTY processes for live `claude` sessions, and renders chat transcripts directly from the JSONL files Claude Code writes to `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`.

### Restarting ralph-monitor

`ralph-monitor` owns the PTYs of every session it spawns. When the server stops (Ctrl+C, `pkill -f ralph-monitor`, `systemctl --user restart ralph-monitor.service`, or a crash), the kernel sends SIGHUP to those child processes and they exit. The DB rows are preserved.

On restart, the reconciler walks every row with a non-null `process_pid` and:

- If the PID is no longer alive → clears `process_pid` and `process_started_at`. The session moves to `dormant`.
- If the PID is alive but its `/proc/<pid>/comm != "bun"` or `RALPH_MONITOR_SESSION` env mismatches → treats the session as `live-orphaned` (rare; happens only if a foreign process recycled the PID before the row was reconciled).
- Otherwise → re-attaches.

Because owned children die with the parent, the common case after a restart is "every session is dormant." The transcript view still renders prior turns by parsing the JSONL file directly — only the live PTY is gone.

To restart cleanly:

```bash
pkill -f ralph-monitor
# or, if running under systemd:
systemctl --user restart ralph-monitor.service
```

### Resuming a session

A dormant session shows a **Resume** button in its detail pane. Clicking it calls `POST /api/sessions/:id/resume`, which spawns a new PTY running `claude --resume <session-uuid>`. Claude Code reads the existing JSONL, replays the conversation into its working memory, and continues from the last turn. The session moves to `live-attached`, the input box re-enables, and you can keep typing.

For an orphaned session (rare — see above), the detail pane shows a **Kill & Resume** button. This sends SIGTERM (then SIGKILL after 5s) to the orphaned PID, clears the DB pid columns, and then runs the same Resume flow. The last in-flight turn is lost — use this only when the orphaned PTY is unrecoverable, not as a routine restart.

### What happens to autonomous runs on restart

Autonomous sessions (e.g., `/ralph-pilot-native` orchestrators that run unattended for hours) follow the same ownership rule: the PTY is a child of `ralph-monitor`, so a server restart kills it. When ralph-monitor comes back up, the session is dormant, and the JSONL on disk is intact and parseable through the last fully-flushed turn boundary.

Click **Resume**: `claude --resume <id>` continues the run from the last completed turn. Sub-agent transcripts (written to `<encoded-cwd>/<session-uuid>/subagents/agent-*.jsonl`) are preserved on disk but are not surfaced as separate sessions in the sidebar — the parent session's chat view shows Agent tool-use blocks expandably (per US-009).

This is reliable for "I started something at 5pm, restarted ralph-monitor at 6pm, want to keep going" — Claude Code's `--resume` is the supported continuation path.

True out-of-process survival (the autonomous run keeps running while ralph-monitor is down) is deferred to v2; it requires `setsid` to detach the PTY from the manager's process group and is non-trivial. v1's contract: ralph-monitor restart = every owned session goes dormant.
