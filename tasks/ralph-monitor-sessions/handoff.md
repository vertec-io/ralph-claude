# ralph-monitor-sessions — Session Handoff

## Purpose of This Document

You are the next agent picking up this effort. The previous session designed and audited a 35-story PRD that evolves `ralph-monitor` from a passive PRD watcher into a local Claude conversation manager. **No implementation has happened yet** — your job is to set up the execution environment (worktree) and launch Ralph (via `/ralph-pilot-native`) against the PRD. This document captures everything you need so you don't have to re-derive it from `git log` and PRD prose.

## What This Project Is

`ralph-monitor` today is a Bun + Hono + React 18 + Vite web app that watches the filesystem for `prd.json` files, tails Ralph progress logs, and renders read-only PRD snapshots over SSE. It is a passive observer.

This PRD turns it into a **conversation manager**: the user can spawn `claude` sessions in any project from the browser, see live chat-style transcripts (with optional raw PTY stream toggle for `/ralph-pilot-native` autonomous runs), and recover gracefully across machine restarts via `claude --resume`. The data model is sqlite-backed three-tier: `projects → efforts → sessions`. Sessions are pre-allocated UUIDs (`claude --session-id`) so the DB row exists before the process starts; Claude's own JSONL transcripts on disk are the source of truth for conversation content.

The user's stated workflow problem: managing 3-5 PRDs across projects today requires a forest of terminal windows juggling `cd`, `claude --dangerously-skip-permissions`, and `claude --resume <id>` — a ceremony that falls apart on every machine restart. This PRD eliminates that ceremony.

### Critical Design Rule

**JSONL is the source of truth for conversation state.** ralph-monitor only persists *metadata* (project/effort/session rows) and stays out of Claude's transcript files. Spawned processes die with ralph-monitor on restart; "Resume" recovers via `claude --resume <id>`. Do not propose tmux, setsid, or other process-survival mechanisms — those are explicit Non-Goals (deferred to v2).

## Current State (as of 2026-04-29)

**Pre-launch.** Everything is staged for execution; nothing is implemented yet.

- Files in `tasks/ralph-monitor-sessions/`:
  - `prd.md` — 65 KB canonical PRD, 35 stories, audited twice (Round 1 → revision → Round 2 → revision)
  - `prd.json` — 64 KB Ralph-readable schema 2.4, 35 stories, validated parseable
  - `progress.txt` — empty header (Ralph will append iteration logs here)
- Branch: `main` (worktree NOT created yet)
- Repo dirty state: only `ralph-monitor/hooks/post-event.sh` and `ralph-monitor/server/snapshot.ts` carry pre-existing local edits — both unrelated to this effort and were already modified before this session started. Do not touch them.
- Untracked: `tasks/ralph-monitor-sessions/` (the PRD task dir)

### PRD Status

| PRD | Stories (done/total) | Status | What It Does |
|-----|----------------------|--------|--------------|
| **ralph-monitor-sessions** | 0/35 | **READY TO LAUNCH** | Sqlite-backed projects→efforts→sessions, PTY+WebSocket bridge, JSONL chat rendering, restart recovery, sidebar UI, 127.0.0.1-only auth-gated server |

prd.json fields confirmed: `schemaVersion: "2.4"`, `type: "feature"`, `modelHintMode: false`, `cavemanMode: false`, `mergeTarget: "main"`, `autoMerge: false`, `pauseBetweenStories: false`. ralph-tui task # is **2** (alphabetical position; `archived/` is #1).

## US-000a — Phase-0 Spike (READ THIS BEFORE LAUNCHING)

The first story Ralph will run is **US-000a**, a pre-implementation spike with two outputs. It is **not a user-ack decision gate** — Ralph produces the decision document and proceeds to US-001 automatically.

**What US-000a validates:**

1. **PTY library + Bun compatibility.** `node-pty` is the assumed library. If it fails to install/import under Bun, the spike falls back to `bun-pty`. **There is no `pty.js` fallback** — that package is unmaintained (last release 2015) and explicitly excluded. If both libraries fail, the spike's decision doc records the failure and Ralph stops; the user must intervene.

2. **Encoder collapse rule.** The PRD spec for the Claude project-directory encoder is `replace(/[^A-Za-z0-9]+/g, '-')` (the `+` collapses consecutive non-alnums). This is supported empirically (no `--` in any existing `~/.claude/projects/` directory) but the spike runs a final confirmation with `mkdir /tmp/ralph-encoder-test..foo` + `claude --session-id <uuid> --print "hi"` and inspects the resulting directory name. If collapse is wrong, the spike updates US-005a-1's encoder spec and FR-6 before US-001 begins.

3. **PTY parent's `comm` value.** The spike pins whether the PTY parent's `/proc/<pid>/comm` is `bun`, `node`, or something else — US-006's reconciler logic uses this value as a strict equality match (logical AND with the env-tag check).

**Output:** `tasks/ralph-monitor-sessions/decisions/US-000a-DECIDE_pty-and-encoder.md` (the directory will be created by Ralph during this story).

**If you read the decision doc and find that the encoder rule changed or the chosen PTY library has constraints not anticipated by US-005a-d, expect downstream stories to need minor AC tweaks** — this is the whole point of front-loading the spike.

## Key Findings from Pre-Execution Audits

These are non-obvious things the previous session learned during two rounds of auditing. They are baked into the PRD but worth surfacing here in case Ralph's implementation drifts:

1. **Sub-agent JSONLs are SEPARATE files**, not embedded in the parent transcript. `/ralph-pilot-native` writes sub-agent traces at `~/.claude/projects/<encoded-cwd>/<parent-uuid>/subagents/agent-<agentId>.jsonl` (with `.meta.json` sidecars). The parent JSONL only contains the `Agent` tool_use call and the final-answer tool_result. **v1 explicitly does NOT surface these as separate sessions.** The chat renderer (US-009) shows the parent's `Agent` tool calls with a footnote that says "Sub-agent trace not surfaced in v1 — see PRD non-goals." Adding a v2 sub-agent viewer is a known follow-up but out of scope here.

2. **The encoder rule is `[^A-Za-z0-9]+` with collapse**, not the per-character `[^A-Za-z0-9]` I initially wrote in earlier draft. Empirical evidence: no `~/.claude/projects/` directory contains `--`. US-000a confirms with a fresh test.

3. **`claude --session-id <uuid>` errors on collision** — it does not auto-resume. Always pre-allocate fresh UUIDs; use `--resume <uuid>` for reattachment. This is why the PRD's spawn primitive (US-005a-1 prepareSpawn) generates a UUID via `crypto.randomUUID()` per call.

4. **`ralph-monitor/server/liveness.ts` does NOT read `/proc/<pid>/environ` today.** It matches by `comm` + `cwd` only. US-006's `RALPH_MONITOR_SESSION` env-tag detection is **net-new infrastructure**, not an extension of existing code. The PRD's framing is correct on this; do not let an implementer story-skim and assume "small extension."

5. **`snapshot.ts:refreshSnapshot` consumes `taskDir`, `worktreeDir`, `sessionId`, `unitName`** — fields populated by `discovery.ts` from systemd `ExecStart=` lines, NOT from `prd.json`. US-012a's `getSnapshotForPath` takes a wider input (`{ prdPath, workingDir, sessionId?, unitName? }`) so effort-attached callers can pass only what they know; absent unit-derived fields gracefully degrade to empty arrays. Do not "simplify" US-012a's signature back to `getSnapshotForPath(prdPath)` — that's the very thing the previous round audited and rejected.

6. **The UI's existing decisions/agents/tasks panels are tightly coupled to `PRDRecord`** (see `ui/App.tsx:153-294` in the current main branch). US-012b extracts them into `ui/components/PrdSnapshotPanels.tsx` taking only `SnapshotData`. This is real refactor work, not a wiring change.

7. **ralph-monitor uses `chokidar` everywhere** (with `awaitWriteFinish`), not raw `node:fs.watch`. US-010's JSONL tail explicitly mandates chokidar to stay consistent. Don't introduce `fs.watch` for one new code path.

8. **`AppEvent['type']` union in `server/types.ts:108-127` is type-locked.** US-003 explicitly extends it with 10 new event types (`project.*`, `effort.*`, `session.*`, `lifecycle.snapshot`). Mechanically a string-list extension, but easy to miss — the AC is explicit.

9. **Hono+Bun WebSocket subprotocol echo is a "first-30-min surprise."** Hono's `upgradeWebSocket` doesn't natively expose `Sec-WebSocket-Protocol` negotiation; the implementation must read the header from the upgrade request and echo it via Bun.serve's `websocket` handler. US-005b's AC calls this out explicitly.

10. **One-live-session-per-effort is enforced at TWO layers**: a partial unique index `idx_sessions_one_live_per_effort` (DB level) AND a per-effort async mutex in `server/sessions/spawnMutex.ts` (server level). Both are required: the index catches concurrent races at the storage layer; the mutex prevents *attempting* a spawn that would collide and incur unnecessary SIGTERM/rollback. Don't drop either.

11. **`live-orphaned` state is logically reachable but practically zero in v1.** Owned processes die with ralph-monitor (no setsid). US-006's reconciler code path is preserved live so v2 setsid work doesn't need a rewrite, but realistically the only live-orphaned cases in v1 are extreme edge cases (the OS scheduler delayed parent death past child detection, etc.). Don't spend disproportionate effort on this state.

## Next Steps (For You, the Next /ralph-pilot-native)

The user's plan is: **you create a worktree via `/ralph-worktree`, then orchestrate the PRD via `/ralph-pilot-native`** (the META-skill, not direct `ralph.sh`). Concretely:

1. **Read this handoff** (you just did) and the PRD at `tasks/ralph-monitor-sessions/prd.md` end-to-end. Don't skim — the audit findings above are pointers, not substitutes.

2. **Run `/ralph-worktree`** to create an isolated worktree for this PRD. The worktree branch should be `ralph/ralph-monitor-sessions` (matches `prd.json` `branchName`). Name the worktree directory whatever convention the user prefers (likely `~/dev/ralph-claude-ralph-monitor-sessions/` or similar — confirm with the user before creating).

3. **Inside the worktree, run `/ralph-pilot-native`** to orchestrate the PRD. This META-skill:
   - Delegates each implementation story to an Agent sub-task on Opus (per `modelHintMode: false`)
   - Reviews the patch in the orchestrator's main thread, applies it, runs the typecheck gate, commits
   - Handles decision-gate / discovery / final-validation stories on the orchestrator thread directly
   - Is backed by a systemd-user-timer watchdog that resurrects via `claude --resume` if it dies

4. **Watch for US-000a's decision doc.** After story 1 completes, `tasks/ralph-monitor-sessions/decisions/US-000a-DECIDE_pty-and-encoder.md` will exist. Skim it for: chosen PTY library, observed `comm` value, encoder regex confirmation. If the encoder regex differs from the PRD's spec (collapse `+` was wrong), the spike's AC mandates updating US-005a-1 and FR-6 before proceeding — Ralph should do this itself, but verify.

5. **Periodic check-ins.** With 35 stories at ~one Ralph iteration each, expect a multi-day run. The progress.txt file in the task dir will accumulate per-story notes including any gotchas Ralph hits — read it periodically for issues that warrant intervention. The key risk windows:
   - **US-005a-2** (actual claude spawn + registration) — first integration of US-000a's chosen PTY library with the registry/mutex from US-005a-1. If Hono+Bun WS subprotocol echo bites here, expect delays.
   - **US-012a-c** (snapshot.ts refactor) — touches existing code; backward-compat for systemd-discovered PRDs is critical. Re-read finding #5 if Ralph reports test failures.
   - **US-018** (E2E validation) — three scenarios, the autonomous-mid-flight scenario is the one most likely to surface bugs in the JSONL parser's offset semantics or chokidar's debounce behavior.

## Architecture Pointers

The PRD touches these existing files (do NOT pre-emptively edit them — Ralph will):

| Path | Current shape | What this PRD changes |
|------|---------------|------------------------|
| `ralph-monitor/server/snapshot.ts` | `refreshSnapshot(prd: PRDRecord)` rooted in systemd-unit discovery | US-012a adds `getSnapshotForPath` wider entry; refactors `refreshSnapshot` as thin caller |
| `ralph-monitor/server/liveness.ts` | matches by `/proc/<pid>/comm` + `/proc/<pid>/cwd`; no `environ` reading | US-006 adds startup reconciler in `server/sessions/reconcile.ts` reading `environ` |
| `ralph-monitor/server/discovery.ts` | walks `~/.config/systemd/user`, builds `PRDRecord` | US-013 left-anti-joins against `effort.prd_path` for "Unmanaged PRDs" filter |
| `ralph-monitor/server/store.ts:recordEvent` | type-locked to `AppEvent` union | US-003 extends `AppEvent['type']` with 10 new variants |
| `ralph-monitor/server/types.ts:108-127` | `AppEvent` union | Same |
| `ralph-monitor/server/index.ts:17-42` | `/events` SSE channel emits `state`/`update`/`ping` | US-003 adds `lifecycle.snapshot` on connect; US-010 adds separate per-session SSE endpoint |
| `ralph-monitor/server/watchers.ts` | uses `chokidar` with `awaitWriteFinish` | US-010 reuses chokidar; do NOT introduce `fs.watch` |
| `ralph-monitor/ui/App.tsx:153-294` | inline decisions/agents/tasks panels coupled to PRDRecord | US-012b extracts to `ui/components/PrdSnapshotPanels.tsx` |
| `ralph-monitor/ui/sse.ts:38-49` | re-fetches `/api/state` on every `update` | Stays for legacy snapshots; new lifecycle events use scoped re-fetches |
| `ralph-monitor/package.json` | Bun ≥ 1.0; chokidar present; no PTY libs; no xterm.js | US-000a adds `node-pty` (or alternate); US-011 adds `xterm` + `xterm-addon-fit`; US-014b adds `lucide-react` |

New code lives under:
- `ralph-monitor/server/db/{projects,efforts,sessions}.ts` (US-002)
- `ralph-monitor/server/jsonl/{paths,parser}.ts` (US-005a-1, US-008a/b)
- `ralph-monitor/server/sessions/{registry,spawnMutex,spawn,reconcile}.ts` (US-005a-1, US-005a-2, US-006)
- `ralph-monitor/server/git/worktrees.ts` (shared helper for US-005d, US-013, US-015b/c)
- `ralph-monitor/ui/components/{Sidebar,SessionDetail,SessionTranscript,PrdSnapshotPanels}.tsx` (US-009, US-012b, US-014a-c, US-016a-c)

## Repository Map

| Repo | Path | Branch | Purpose |
|------|------|--------|---------|
| ralph-claude (main checkout) | `/home/apino/dev/ralph-claude` | `main` | Source of truth; do not implement directly here |
| ralph-claude (Ralph worktree) | TBD — `/ralph-worktree` decides | `ralph/ralph-monitor-sessions` | Where Ralph executes the PRD; create as step 1 |

There are no sub-repos for this PRD (single-repo effort). Sub-repo verification (Step 2b in the handoff skill) does not apply.

## Infrastructure

This PRD does not touch any external infrastructure. Everything ships as part of the existing `ralph-monitor` Bun process. New runtime artifacts:

- `~/.config/ralph-monitor/ralph-monitor.db` (sqlite, mode 0600 dir)
- `~/.config/ralph-monitor/token` (32-byte hex auth token, mode 0600)
- `~/.config/ralph-monitor/last-error.txt` (refuse-to-start error reporting)

All path-configurable via env vars: `RALPH_MONITOR_DB`, `RALPH_MONITOR_BIND` (loopback-only — non-loopback causes refuse-to-start), `RALPH_MONITOR_PROJECT_ROOTS` (default `$HOME`), `RALPH_MONITOR_PTY_BUFFER_BYTES` (default 256 KB).

## Key Build Scripts

Existing scripts in `ralph-monitor/`:
- `bun run dev` — starts dev server on port 5173 (vite) and proxies API to 7777
- `bunx tsc --noEmit -p ralph-monitor/` — typecheck (every story's final AC)

The PRD does not introduce new top-level build scripts. US-000a creates and deletes a one-off `ralph-monitor/scripts/pty-spike.ts`.

## Launch Commands

After running `/ralph-worktree` to create the worktree:

```bash
# Option A: /ralph-pilot-native (recommended — what the user wants)
cd <worktree-path>
# Then in a Claude Code session in that dir:
# Invoke /ralph-pilot-native; pass tasks/ralph-monitor-sessions as the target

# Option B: Direct ralph.sh (fallback only)
cd <worktree-path>
./ralph.sh tasks/ralph-monitor-sessions

# Option C: ralph-tui
cd <worktree-path>
# Run ralph-tui, pick task #2
```

## What This Handoff Is NOT

- It is NOT a substitute for reading `prd.md`. The PRD has the canonical AC text; this doc has the audit findings + execution context.
- It does NOT pre-commit to a worktree path or branch naming. `/ralph-worktree` will ask the user; respect their choice.
- It does NOT capture every audit finding — only the load-bearing ones. A few smaller items (e.g., the encoder defensive throw on empty input, `live-orphaned` v1 unreachability note) live only in the PRD ACs.

---

**End of handoff.** When you complete the PRD execution and merge to `main` (`autoMerge: false` — confirm with user first), update this file: change "READY TO LAUNCH" → "DONE (merged)" in the PRD status table, append a "Recently Completed PRDs" section with the completion date, and append any non-obvious post-implementation findings to Key Findings.
