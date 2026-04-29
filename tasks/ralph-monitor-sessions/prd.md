# PRD: ralph-monitor — Project & Session Management

## Type
Feature

## Introduction

Evolve `ralph-monitor` from a passive PRD watcher into a local Claude conversation manager. Today it discovers PRDs from the filesystem and renders read-only snapshots over SSE; the user is forced to manage Claude sessions manually via a forest of terminal windows, juggling `cd`, `claude --dangerously-skip-permissions`, and `claude --resume <id>` ceremonies that fall apart whenever the machine restarts.

This effort introduces a sqlite-backed three-tier model — `projects → efforts → sessions` — where ralph-monitor can spawn, track, and resume Claude conversations across restarts. Sessions are pre-allocated UUIDs (`claude --session-id`) so the DB row exists before the process starts, and Claude's own JSONL transcripts on disk become the source of truth for conversation state.

### Empirical findings baked into this PRD (verified during prior audit cycles)

- **Encoding:** the Claude project-directory encoding rule maps non-alphanumeric characters to `-`. Spec it as `replace(/[^A-Za-z0-9]+/g, '-')` (the `+` collapses consecutive non-alnums; verified empirically — zero `--` directories observed in `~/.claude/projects/`). US-000a runs a final empirical test to lock this in.
- **Collisions:** `claude --session-id <existing-uuid>` errors out (no auto-resume); the spawner always pre-allocates a fresh UUID and uses `--resume <uuid>` for reattachment.
- **Sub-agents:** `/ralph-pilot-native` sub-agents emit **separate** JSONLs at `~/.claude/projects/<encoded-cwd>/<parent-uuid>/subagents/agent-<agentId>.jsonl`. Their parent transcript only contains the `Agent` tool_use call and the final-answer tool_result. v1 renders the parent's view as-is; surfacing nested sub-agent traces is **out of scope (v2)**.
- **Liveness:** the current `ralph-monitor/server/liveness.ts` matches by `/proc/<pid>/comm` + `/proc/<pid>/cwd` only; it does NOT read `/proc/<pid>/environ`. The `RALPH_MONITOR_SESSION` env-tag mechanism is **net-new** infrastructure.
- **Snapshot:** `ralph-monitor/server/snapshot.ts:refreshSnapshot(prd: PRDRecord)` consumes `taskDir`, `worktreeDir`, `sessionId`, `unitName`. Only `taskDir` is derivable from a bare `prd_path`; the others come from systemd `ExecStart=` lines via `discovery.ts`. The path-keyed entry point introduced in US-012a takes a wider input — `{ prdPath, workingDir, sessionId? }` — and the systemd-driven `refreshSnapshot` is rewritten as a thin caller.
- **Watch library:** ralph-monitor uses `chokidar` (with `awaitWriteFinish`) throughout `server/watchers.ts` — not raw `node:fs.watch`. New JSONL tailing reuses chokidar.
- **Event bus:** `store.ts:recordEvent(evt: AppEvent)` is type-locked to a union in `types.ts:108-127`. New event types must be added to that union as part of US-003.

## Goals

- Persist projects, efforts, and Claude sessions in a sqlite database that survives ralph-monitor restarts.
- Spawn Claude sessions with pre-allocated UUIDs so the DB row and JSONL path are deterministic from the moment of spawn.
- Render any session's conversation as a chat-style transcript by parsing its JSONL on disk, with live updates as new turns land.
- Provide a raw PTY stream toggle for live byte-level output of autonomous runs.
- Recover gracefully from ralph-monitor restarts: dormant sessions render from JSONL, "Resume" button reattaches via `claude --resume`.
- Surface filesystem-discovered PRDs (from existing systemd-unit-rooted discovery) in an "Unmanaged" section so legacy work isn't lost; let the user adopt them into the new model on demand.
- Bind to 127.0.0.1 only (refuse to start on any other bind) and gate all API/WebSocket access behind an auth token from day one.
- Refactor `snapshot.ts` and the UI's PRD-detail panels to be path-keyed so they can hang off `Effort.prd_path`.
- Ship as a single binary on a single port — no auxiliary services, no tmux dependency.
- De-risk node-pty + Bun compatibility before any session-spawn work begins.

## User Stories

### US-000a: PTY library + encoder collapse spike (decision document)
**Description:** As a developer, before any spawn/PTY/WebSocket work, I need to validate that a PTY library actually works under Bun AND empirically confirm the JSONL directory-name encoding rule.

**Type:** Pre-implementation spike. Produces a decision document; downstream stories reference its outputs by name. Ralph proceeds to US-001 once the document exists (no user-ack gate).

**Acceptance Criteria:**
- [ ] **PTY library validation:** add `node-pty` to `ralph-monitor/package.json` and attempt to install + import under Bun; write a throwaway script `ralph-monitor/scripts/pty-spike.ts` that spawns `bash -c 'echo hi; sleep 0.5'` in a PTY, captures stdout, sends a `resize` event, and exits cleanly. Verify bidirectional bytes work (write to stdin, read from stdout)
- [ ] If `node-pty` fails under Bun, repeat with `bun-pty` (if it exists)
- [ ] **No `pty.js` fallback** — `pty.js` is unmaintained (last release 2015) and not viable under modern Bun. If both `node-pty` and `bun-pty` fail, the decision document records the failure and stops; no autoproceed to a non-viable shim
- [ ] **Pin the PTY parent's `/proc/<pid>/comm` value** by inspecting it during the spike (likely `bun` or `node` depending on how the PTY library spawns; this value is consumed by US-006's reconciliation logic)
- [ ] **Encoder collapse empirical test:** run `mkdir -p '/tmp/ralph-encoder-test..foo'; (cd '/tmp/ralph-encoder-test..foo' && claude --session-id $(cat /proc/sys/kernel/random/uuid) --dangerously-skip-permissions --print "hi" < /dev/null)`; then `ls ~/.claude/projects/ | grep ralph-encoder-test`. Document whether the resulting directory name is `-tmp-ralph-encoder-test--foo` (per-char) or `-tmp-ralph-encoder-test-foo` (collapsed). The expected and currently-spec'd answer is **collapsed** (`+` in regex); if observation differs, the encoder spec in US-005a-1 and FR-6 must be updated to match before proceeding. Clean up the test directory and JSONL afterward
- [ ] Produce `tasks/ralph-monitor-sessions/decisions/US-000a-DECIDE_pty-and-encoder.md` containing: chosen PTY library + version, observed PTY-parent `comm` value, encoder regex (collapsed vs per-char), any platform constraints, and the empirical test command outputs as evidence
- [ ] Update US-005a-1 and FR-6 to reference the empirically-confirmed encoder regex
- [ ] Delete the throwaway spike script; the decision document remains
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)

### US-001: Sqlite schema and migrations
**Description:** As a developer, I need a sqlite database with `projects`, `efforts`, and `sessions` tables so all conversation state can be persisted across restarts.

**Acceptance Criteria:**
- [ ] `bun:sqlite` is wired into `ralph-monitor/server/` and a migration runner applies schema on startup
- [ ] DB file lives at `~/.config/ralph-monitor/ralph-monitor.db` (path configurable via `RALPH_MONITOR_DB`); parent dir created with `0700`
- [ ] Schema implements three tables:
  - `projects(id TEXT PK, name TEXT NOT NULL, root_dir TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_opened_at INTEGER, archived INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0)`
  - `efforts(id TEXT PK, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('prd','task','general')), prd_path TEXT, working_dir TEXT, status TEXT NOT NULL CHECK (status IN ('active','done','archived')) DEFAULT 'active', created_at INTEGER NOT NULL, completed_at INTEGER, CHECK (kind != 'prd' OR (prd_path IS NOT NULL AND length(prd_path) > 0)))`
  - `sessions(id TEXT PK, effort_id TEXT NOT NULL REFERENCES efforts(id) ON DELETE CASCADE, working_dir TEXT, jsonl_path TEXT NOT NULL, title TEXT, mode TEXT NOT NULL CHECK (mode IN ('interactive','autonomous')), process_pid INTEGER, process_started_at INTEGER, last_activity_at INTEGER, created_at INTEGER NOT NULL)`
- [ ] `sessions.working_dir` is nullable; resolution order at spawn/resolve time is `session.working_dir ?? effort.working_dir ?? project.root_dir`
- [ ] `projects.root_dir` is normalized via `realpath` + trailing-slash strip before insert; case is preserved
- [ ] All foreign keys cascade on delete; no nullable FK columns
- [ ] Indexes: `idx_projects_archived ON projects(archived)`, `idx_efforts_project ON efforts(project_id)`, `idx_efforts_status ON efforts(status)`, `idx_sessions_effort ON sessions(effort_id)`, `idx_sessions_last_activity ON sessions(last_activity_at)`, partial index `idx_sessions_live ON sessions(process_pid) WHERE process_pid IS NOT NULL`, partial unique index `idx_sessions_one_live_per_effort ON sessions(effort_id) WHERE process_pid IS NOT NULL`
- [ ] On project creation, an auto-generated `general` effort is inserted in the same transaction
- [ ] `PRAGMA user_version = 1` is set after first migration; runner reads `user_version` and applies only newer migrations
- [ ] Migration runner is idempotent
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)

### US-002: Persistence layer (CRUD operations)
**Description:** As a developer, I need typed CRUD operations for projects/efforts/sessions so server endpoints have a clean data layer to call into.

**Acceptance Criteria:**
- [ ] `server/db/projects.ts`, `server/db/efforts.ts`, `server/db/sessions.ts` expose typed create/read/update/delete/list functions
- [ ] All write operations use prepared statements
- [ ] List operations support filtering (`archived`, `pinned`) and ordering (`last_opened_at DESC` default)
- [ ] Soft-delete via `archived` flag for projects/efforts; hard-delete is a separate explicit function
- [ ] `createSession({ effort_id, mode, working_dir?, title? })` requires a pre-allocated UUID passed in (caller-allocated, never auto-generated by the DB layer); rejects collisions with a typed error
- [ ] `getProjectByRootDir(path)` normalizes path via `realpath` before lookup
- [ ] Unit tests cover create, list-with-filter, archive, hard-delete, AND the one-live-session-per-effort uniqueness violation (insert two sessions with same effort_id and non-null process_pid → second INSERT fails with the partial unique index error)
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)

### US-003: Server API endpoints + AppEvent union extension + lifecycle snapshot
**Description:** As a frontend developer, I need REST endpoints AND a cleanly-extended event channel so the UI can manage the project hierarchy.

**Acceptance Criteria:**
- [ ] Extend `AppEvent['type']` union in `server/types.ts` to include: `project.created`, `project.updated`, `project.deleted`, `effort.created`, `effort.updated`, `effort.deleted`, `session.created`, `session.updated`, `session.deleted`, `session.exited`, `lifecycle.snapshot`
- [ ] `GET /api/projects?status=active|recent|archived&pinned=true|false` returns filtered list
- [ ] `POST /api/projects` body `{ name, root_dir }` realpath-normalizes `root_dir` server-side, creates project + auto-`general` effort, returns full record
- [ ] `PATCH /api/projects/:id` updates `name`, `archived`, `pinned`
- [ ] `DELETE /api/projects/:id?confirm_name=<typed>` requires `confirm_name` matching `project.name` exactly; cascades to efforts and sessions; returns 422 on mismatch
- [ ] `GET /api/projects/:id/efforts`, `POST /api/projects/:id/efforts`, `PATCH /api/efforts/:id`, `DELETE /api/efforts/:id` (no typed-name requirement on effort delete)
- [ ] `GET /api/efforts/:id/sessions`, `PATCH /api/sessions/:id`, `DELETE /api/sessions/:id` (and `?purge_jsonl=true` for atomic JSONL+row removal)
- [ ] **Lifecycle snapshot on connect:** `/events` SSE endpoint emits a `lifecycle.snapshot` event on every new client connection containing `{ projects: [...], efforts: [...], live_session_ids: [...] }` BEFORE any subsequent lifecycle events. This eliminates the fetch-then-subscribe race window
- [ ] All mutation endpoints emit the corresponding scoped event via `store.recordEvent`
- [ ] Endpoint errors return JSON `{ error, details }` with appropriate HTTP status codes
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)

### US-004: Auth token, localhost-only binding, dev-token endpoint, WebSocket auth
**Description:** As the operator, I need refuse-to-start on non-loopback bind, a bearer token gating all API/SSE/WebSocket access, and visible error reporting under systemd.

**Acceptance Criteria:**
- [ ] Server binds to `127.0.0.1` by default
- [ ] If `RALPH_MONITOR_BIND` is set to anything other than `127.0.0.1`, the server **refuses to start**: writes the reason to `~/.config/ralph-monitor/last-error.txt` (atomic write, overwrites), prints to stderr, and exits non-zero. Error message: `"ralph-monitor refuses to bind to non-loopback address. Set RALPH_MONITOR_BIND=127.0.0.1 or unset it. Network exposure is not supported in v1."`
- [ ] On first start, generate a 32-byte random token (`crypto.randomBytes(32).toString('hex')`), write to `~/.config/ralph-monitor/token` with `0600` perms; if the file exists, reuse it
- [ ] All `/api/*` and `/events` routes require `Authorization: Bearer <token>` header OR `?token=<token>` query param (latter for SSE only; logs a warning about access-log leakage)
- [ ] WebSocket auth uses `Sec-WebSocket-Protocol: bearer.<token>` subprotocol — NOT a query-string token. The server validates the subprotocol on upgrade and echoes it back on success per RFC 6455; rejects with HTTP 401 on missing/invalid subprotocol
- [ ] Static asset routes (`/`, `/index.html`, JS/CSS bundle) remain unauthenticated
- [ ] `GET /api/dev-token` returns `{ token }` ONLY when the actual listening socket address is loopback (inspected at request time, not from env). Returns 404 on non-loopback (and per refuse-to-start, this case shouldn't happen anyway — belt-and-suspenders)
- [ ] The dev `index.html` fetches `/api/dev-token` on load, caches the token in memory for fetches/SSE/WS
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)
- [ ] Manual verification (also exercised in US-018): `curl http://127.0.0.1:PORT/api/projects` → 401; with bearer header → list; `RALPH_MONITOR_BIND=0.0.0.0 bun run server` exits non-zero with the refusal printed AND `last-error.txt` populated

### US-005a-1: Spawn primitive — registry, mutex, encoder, DB row
**Description:** As a developer, I need the foundational pieces of the spawn primitive: a session registry (in-memory `Map<sessionId, PtyHandle>`), per-effort spawn mutex, the encoder helper, and DB-row-before-spawn semantics — without yet calling the actual `claude` binary.

**Acceptance Criteria:**
- [ ] `server/sessions/registry.ts` exports an in-memory `Map<sessionId, PtyHandle>` with `register/unregister/get` methods. Registry is the single source of truth for live PTY handles; downstream stories (US-005b WebSocket, US-005c ring buffer, US-016 status badge) attach to it
- [ ] `server/sessions/spawnMutex.ts` exports a per-effort async mutex: `withEffortLock(effortId, fn)`. Concurrent spawn requests for the same effort serialize through this lock; the lock releases on success or error
- [ ] `server/jsonl/paths.ts` exports `encodeClaudeProjectDir(absPath: string): string` implementing the regex `absPath.replace(/[^A-Za-z0-9]+/g, '-')` (the `+` collapses consecutive non-alnums, per US-000a empirical confirmation). If `absPath` is empty or not absolute, throws a typed error
- [ ] Encoder unit tests cover: leading slash, dots, underscores, hyphens, consecutive non-alnums (`/foo..bar` → `-foo-bar`), trailing-slash-after-realpath (verified to be neutralized), Unicode characters (one code unit → one `-`; documented as a known limitation if Claude differs — see Open Questions)
- [ ] `server/sessions/spawn.ts` exports `prepareSpawn({ effort_id, mode, working_dir?, title? })`: validates effort exists, resolves `working_dir` via `session.working_dir ?? effort.working_dir ?? project.root_dir`, calls `realpath` on the resolved path (typed error on failure), generates a fresh UUID via `crypto.randomUUID()`, computes `jsonl_path` via `encodeClaudeProjectDir(resolved-cwd) + '/' + uuid + '.jsonl'`, INSERTs the session row with `process_pid = NULL`. If the partial-unique-index check fires (effort already has a live session), surfaces a 409 typed error and rolls back. Returns `{ uuid, jsonlPath, resolvedCwd, projectRootDir }`
- [ ] `prepareSpawn` is wrapped in `withEffortLock(effort_id, ...)` so concurrent calls serialize
- [ ] Unit tests cover: encoder edge cases, working-dir resolution chain, missing-cwd error path, one-live-session-per-effort 409
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)

### US-005a-2: Spawn primitive — actual `claude` invocation + registry registration
**Description:** As a developer, I need to actually spawn the `claude` process via the chosen PTY library, register the handle in the registry, and roll back the DB row if registration fails.

**Acceptance Criteria:**
- [ ] `server/sessions/spawn.ts` exports `spawnSession({ effort_id, mode, working_dir?, initial_prompt? })`: calls `prepareSpawn` (US-005a-1), then spawns the PTY child
- [ ] PTY spawn command: `claude --session-id <uuid> --dangerously-skip-permissions --name <effort-name>:<uuid-prefix>` in the resolved cwd, with env `RALPH_MONITOR_SESSION=<uuid>`
- [ ] When `resolvedCwd !== projectRootDir`, the spawn command includes `--add-dir <projectRootDir>`
- [ ] **Synchronous registration invariant**: immediately after spawn, the spawn function calls `registry.register(uuid, ptyHandle)`. If registration throws (map collision, type mismatch, etc.), the function sends `SIGTERM` to the child, waits up to 5s for exit (escalating to `SIGKILL`), and hard-deletes the DB row. No "live row, unreachable PTY" half-state is ever persisted
- [ ] On successful spawn + registration: `UPDATE sessions SET process_pid = ..., process_started_at = ...`; emit `session.created` via `store.recordEvent`
- [ ] On spawn failure (binary not found, working dir invalid, permission denied): hard-delete the DB row; surface the underlying error
- [ ] PTY library and the parent process's `comm` value come from US-000a's decision document
- [ ] Integration test: spawn a tiny PTY child (`bash -c 'sleep 5'` rather than `claude` for test speed), verify registry.get returns the handle within the function's return; force a registration failure (mock) and verify the SIGTERM-then-rollback path
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)

### US-005a-3: Mode-conditional initial prompt handling
**Description:** As a user, when I create an autonomous session with an initial prompt, that prompt should be written to the PTY stdin so the agent starts working immediately. For interactive sessions, no auto-write happens — the user types from the UI.

**Acceptance Criteria:**
- [ ] In `spawnSession`, if `mode === 'autonomous'` AND `initial_prompt` is provided: after the PTY is registered, write `initial_prompt + '\r'` to PTY stdin
- [ ] If `mode === 'interactive'`: PTY stdin remains open but no auto-write happens; the user's first input arrives via WebSocket
- [ ] If `mode === 'autonomous'` but no `initial_prompt` is provided: spawn proceeds, no auto-write — caller's choice (fine for autonomous sessions that resume an existing skill state)
- [ ] Unit/integration test: mock-spawn an autonomous session with an initial prompt, verify a stdin write occurs synchronously after registration; mock-spawn an interactive session, verify NO stdin write happens
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)

### US-005b: WebSocket PTY bridge (resize + exit handling)
**Description:** As a user, I need bidirectional bytes between the browser and the spawned PTY.

**Acceptance Criteria:**
- [ ] `WebSocket /ws/sessions/:id` accepts authenticated upgrade per US-004 (subprotocol auth)
- [ ] Hono+Bun WebSocket nuance: subprotocol negotiation goes through Bun.serve's `websocket` handler. The implementation reads `Sec-WebSocket-Protocol` from the upgrade request, validates `bearer.<token>`, and echoes the matched protocol in the upgrade response
- [ ] WS handler attaches/detaches against the registry from US-005a-1
- [ ] PTY → WS: every PTY chunk emits a `{type:'data', bytes}` message (binary frame)
- [ ] WS → PTY: incoming `{type:'input', data}` messages are written to PTY stdin
- [ ] `{type:'resize', rows, cols}` control messages call `pty.resize(cols, rows)`
- [ ] On PTY exit: server emits `{type:'exit', code}` to all attached clients, closes WS connections, updates `sessions.process_pid = NULL` + `process_started_at = NULL` + `last_activity_at = now()`, calls `registry.unregister(sessionId)`, emits `session.exited` via `store.recordEvent`
- [ ] Integration test: spawn `bash -c 'echo hi'`, open WS, verify `data` arrives, verify `exit` with code 0, verify registry entry is gone
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)

### US-005c: Server-side ring buffer for late-attaching clients
**Description:** As a user opening the session view AFTER the PTY has been emitting bytes, I want to see the recent history.

**Acceptance Criteria:**
- [ ] Each `PtyHandle` in the registry carries a ring buffer (default 256 KB; configurable via `RALPH_MONITOR_PTY_BUFFER_BYTES`)
- [ ] Every PTY → WS data chunk also appends to the ring buffer; oldest bytes drop on overflow
- [ ] On new WS attach: server sends a `{type:'replay', bytes}` frame with the buffer contents BEFORE any subsequent `data` frames
- [ ] Multiple concurrent WS clients each receive replay independently
- [ ] On PTY exit, the buffer is preserved in the (now-detached) handle for 60s (configurable) so a client that attaches right after exit still sees the final output, then GC'd
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)

### US-005d: Spawn endpoint
**Description:** As a frontend developer, I need a `POST /api/sessions` endpoint that wraps `spawnSession`.

**Acceptance Criteria:**
- [ ] `POST /api/sessions` body `{ effort_id, mode, working_dir?, initial_prompt? }` calls `spawnSession`, returns `{ id, jsonl_path, ws_url }`
- [ ] Returns 409 on the one-live-session-per-effort violation
- [ ] Returns 404 if `effort_id` doesn't exist
- [ ] Returns 422 if `working_dir` resolves outside the project's `root_dir` AND its known worktrees (uses `server/git/worktrees.ts:listWorktrees(projectRootDir)` shared helper — see Technical Considerations)
- [ ] Argv assertion test: when resolved cwd != `project.root_dir`, the spawn command includes `--add-dir <project.root_dir>`
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)

### US-006: Startup process reconciliation (greenfield)
**Description:** As ralph-monitor, on startup I need to figure out which DB-tracked sessions still have live processes. The current `liveness.ts` matches by `/proc/<pid>/comm` + `/proc/<pid>/cwd` only; this story adds `/proc/<pid>/environ` reading and `RALPH_MONITOR_SESSION` env-tag detection as net-new code.

**Acceptance Criteria:**
- [ ] New `server/sessions/reconcile.ts` exports `reconcileSessionsOnStartup(): Promise<ReconcileResult>`
- [ ] For each DB session with non-null `process_pid`: read `/proc/<pid>/comm` AND `/proc/<pid>/environ` (null-byte-separated)
- [ ] **Match requires both conditions (logical AND, not OR — protects against PID reuse):** `comm == <PTY-parent-comm-from-US-000a>` AND `environ contains RALPH_MONITOR_SESSION=<session-uuid>`
- [ ] If matched: mark as `live-orphaned` (alive but ralph-monitor's PTY parent died, so we cannot reattach). API exposes `{ status: 'live-orphaned', live: true, attached: false }`
- [ ] If not matched: mark as `dormant` (`UPDATE sessions SET process_pid = NULL, process_started_at = NULL`)
- [ ] `GET /api/sessions/:id` returns computed `status: 'dormant' | 'live-attached' | 'live-orphaned' | 'exited'` (where `live-attached` = registry has an entry; reconciliation runs only at startup)
- [ ] **v1 reachability note (preserved in code comment):** `live-orphaned` is logically reachable but practically zero in v1 because owned processes die with ralph-monitor (no `setsid`); the code path is kept live so v2 setsid work doesn't need a rewrite
- [ ] Linux-only; on macOS/other, the reconciler logs a warning and marks all PID-bearing rows as dormant
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)

### US-007: Resume dormant session
**Description:** As a user, "Resume" on a dormant session should spawn `claude --resume <id>` and reattach.

**Acceptance Criteria:**
- [ ] `POST /api/sessions/:id/resume` spawns `claude --resume <session-id> --dangerously-skip-permissions` in the session's resolved cwd with `RALPH_MONITOR_SESSION=<id>` env tag, registers in the registry per US-005a-2 invariants
- [ ] DB row updates `process_pid` and `process_started_at`
- [ ] Returns 409 if status is `live-attached` or `live-orphaned`
- [ ] Returns 404 if the JSONL no longer exists at `jsonl_path`
- [ ] Returns 409 if a different session in the same effort is currently live (one-live-session-per-effort)
- [ ] WebSocket reconnect to `/ws/sessions/:id` attaches to the new PTY; ring buffer is fresh
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)
- [ ] Playwright MCP verification: `pkill -f "ralph-monitor"`, restart server, navigate to a session whose chat view shows prior turns, click Resume, verify the input box becomes active and a new user turn lands in the JSONL

### US-008a: JSONL parser — record types, segment union, parseTranscript
**Description:** As a developer, I need a complete parser that converts Claude's JSONL into a typed turn model.

**Acceptance Criteria:**
- [ ] `server/jsonl/parser.ts` exports `parseTranscript(path: string): Promise<Turn[]>`
- [ ] `Turn` discriminated union covers ALL observed top-level `type` values: `user`, `assistant`, `system`, `queue-operation`, `attachment`, `ai-title`, `last-prompt`, `file-history-snapshot`, `permission-mode`. Non-renderable types map to `{ kind: 'meta', type, raw }`
- [ ] `user`/`assistant` records expose: `parentUuid`, `isSidechain`, `cwd`, `gitBranch`, `sessionId`, `timestamp` (parsed to ms), `requestId`, `uuid`, and `message.content[]` parsed into typed segments: `{type:'text', text}` | `{type:'tool_use', id, name, input}` | `{type:'tool_result', tool_use_id, content}`
- [ ] Unknown record types are preserved as `{ kind: 'raw', type, content: <obj> }` and logged once per unique type at WARN level
- [ ] Unit tests: fresh single-turn transcript, transcript with tool uses + results, transcript with all observed `type` values, parent transcript containing an `Agent` tool_use call
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)

### US-008b: JSONL streaming parser — offset tracking, is_partial, isSidechain
**Description:** As a developer, I need a streaming parser variant that handles incremental file growth, partial-record safety, and partial-message replacement.

**Acceptance Criteria:**
- [ ] `server/jsonl/parser.ts` exports `parseStream(path: string, fromOffset: number): AsyncIterable<{ turn: Turn, byteOffset: number }>`
- [ ] Parser tracks the byte offset of the last *complete* newline; never emits a turn from a buffered partial record. `parseStream` resumes from the caller-supplied offset and only yields new turns past it
- [ ] Records with `is_partial: true` are tagged so consumers can replace-in-place by `uuid` rather than appending
- [ ] Records with `isSidechain: true` are emitted with the flag preserved (defense-in-depth — parent JSONLs do not normally contain sidechain records, but the parser doesn't strip them; the renderer in US-009 filters them on the client side)
- [ ] Unit tests: transcript with a partial trailing record (no newline at EOF) — verify the parser stops at the last complete newline; transcript with `is_partial: true` followed by the final non-partial — verify both yield with the offset advancing; transcript with `isSidechain: true` records — verify the flag round-trips
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)

### US-009: Chat-style session renderer with Agent-tool affordance
**Description:** As a user, I see the conversation rendered as readable chat with turns, tool calls, and tool results inline — including `Agent` invocation affordances.

**Acceptance Criteria:**
- [ ] `ui/components/SessionTranscript.tsx` accepts `{ sessionId, turns: Turn[] }` and renders parsed turns
- [ ] **Renderer skips turns where `isSidechain === true`** (defense-in-depth filter; parent JSONLs do not normally contain sidechain records, but the renderer is the load-bearing filter)
- [ ] User turns / assistant turns / system turns render with distinct styling; `meta`-kind turns are not rendered
- [ ] Tool uses render as collapsible `▶ <tool-name>(<short-input>)`; tool results below them, also collapsible (collapsed by default if output > 10 lines)
- [ ] **Agent tool calls** (`tool_use.name === 'Agent'`) render with explicit affordance: header `▶ Agent: <input.description>` + `subagent_type` shown as a pill; body shows `subagent_type` and `prompt` when expanded; the corresponding tool_result renders as a collapsible "Final answer" block; a small dimmed footnote reads `"Sub-agent trace not surfaced in v1 — see PRD non-goals"`
- [ ] Code blocks (` ``` ` fences) render with monospace font and a single accent background — no language-aware tokenization
- [ ] Sticky-bottom: auto-scroll on new turns UNLESS the user has scrolled up
- [ ] Empty state for sessions whose JSONL is empty/missing
- [ ] `is_partial: true` updates replace the matching prior partial record by `uuid`
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)
- [ ] Using Playwright MCP, start `bun run dev` in `ralph-monitor/`, navigate to a session URL with at least one Agent tool call in its JSONL, verify: user/assistant turns visible, Agent tool block with `Agent: <description>` label and `subagent_type` pill, tool result expanded shows final answer text, code block monospace

### US-010: Live JSONL tail (chokidar-based per-session SSE)
**Description:** As a user, when a session is active, the chat view updates in real time as new turns land.

**Acceptance Criteria:**
- [ ] Server endpoint `GET /api/sessions/:id/transcript/stream` streams turns over a per-session SSE channel (separate from `/events`)
- [ ] **Watch library: chokidar** (with `awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }`) — consistent with the rest of `ralph-monitor/server/watchers.ts`. Do NOT use raw `node:fs.watch`
- [ ] On connect: emits `snapshot` event with all current turns (via `parseTranscript` from US-008a)
- [ ] Subsequently emits `turn` events as new turns land, using `parseStream` from US-008b with per-client offset tracking
- [ ] Multiple concurrent clients on the same session each track their own offset; one chokidar watcher per session id is shared across clients
- [ ] Partial records (`is_partial: true`) are emitted with the flag set
- [ ] On JSONL deletion: emits `{type:'gone'}` and closes
- [ ] On JSONL truncation (size shrunk): emits a fresh `snapshot` event (treat as recreated)
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)
- [ ] Manual verification (in US-018): open session, run `claude --resume <id>` in another terminal, type a message, watch the new turn appear without refresh

### US-011: Raw PTY stream toggle (xterm.js)
**Description:** As a user watching an autonomous run, I want a "raw stream" view showing live byte-level PTY output.

**Acceptance Criteria:**
- [ ] Add `xterm` + `xterm-addon-fit` to `ralph-monitor/package.json` (and `xterm-addon-attach` if the chosen integration shape needs it; see Technical Considerations)
- [ ] Session detail view (US-016a) has a view-mode toggle: "Chat" (default) and "Stream"
- [ ] Stream mode mounts xterm.js connected to the WebSocket from US-005b; receives the `replay` frame on connect (US-005c) before live `data` frames
- [ ] Stream mode is disabled (button greyed with tooltip) when status is `dormant`, `live-orphaned`, or `exited` — chat mode remains available
- [ ] xterm.js handles ANSI/cursor sequences natively; no custom escape filtering
- [ ] Switching Chat ↔ Stream does not disconnect the WebSocket; each view mounts/unmounts independently
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)
- [ ] Using Playwright MCP, start a session with active PTY, switch to Stream mode, verify xterm container is visible and `browser_console_messages` shows no errors

### US-012a: Refactor snapshot.ts to a wider path-keyed entry point
**Description:** As a developer, I need `snapshot.ts` to support reading a snapshot for an arbitrary `prdPath` (plus optional context fields) so it can serve effort-attached PRDs without losing systemd-discovered functionality.

**Acceptance Criteria:**
- [ ] `server/snapshot.ts` exports new function: `getSnapshotForPath(input: { prdPath: string; workingDir: string; sessionId?: string; unitName?: string }): Promise<SnapshotData>`
- [ ] The wider input lets effort-attached callers (US-012c) supply `prdPath` + `workingDir` (with `sessionId` and `unitName` undefined), while systemd-attached callers (existing `refreshSnapshot`) supply all four
- [ ] `SnapshotData` shape is unchanged from what `refreshSnapshot` currently returns; fields whose values depend on absent inputs (e.g., `agents` depends on `unitName`/`sessionId`) gracefully degrade to empty arrays/null
- [ ] Existing `refreshSnapshot(prd: PRDRecord)` is rewritten as a thin caller: `getSnapshotForPath({ prdPath: join(prd.taskDir, 'prd.json'), workingDir: prd.worktreeDir, sessionId: prd.sessionId, unitName: prd.unitName })`
- [ ] If `prdPath` doesn't exist on disk, returns `{ status: 'pending' }` shape — caller-friendly, never throws
- [ ] Unit tests cover: existing `refreshSnapshot` output is unchanged for a discovered PRD; `getSnapshotForPath` with effort-attached inputs returns the same shape but with `agents: []` and other unit-dependent fields empty; missing-file returns `{ status: 'pending' }`
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)

### US-012b: Decouple decisions/agents/tasks UI panels from PRDRecord
**Description:** As a developer, I need the UI panels to accept a generic snapshot prop so they render for both systemd- and effort-attached PRDs.

**Acceptance Criteria:**
- [ ] Extract panels from `ui/App.tsx` into `ui/components/PrdSnapshotPanels.tsx` exposing `<PrdSnapshotPanels snapshot={SnapshotData} />`
- [ ] The component takes only the snapshot data as a prop — no global `PRDRecord` reach
- [ ] Empty/null fields (e.g., `snapshot.agents.processes = []` for an effort-attached PRD without a live session) render gracefully — no crashes, no error styling, just an empty state ("No agent processes")
- [ ] `App.tsx` updated to render `<PrdSnapshotPanels snapshot={prd}>` for the existing systemd case with no behavior change
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)
- [ ] Playwright MCP: navigate to the existing PRD detail view, verify decisions/agents/tasks panels render unchanged

### US-012c: Wire Effort.prd_path into the snapshot panels
**Description:** As a user, opening an Effort with `kind='prd'` shows the same decisions/agents/tasks panels driven by `effort.prd_path`.

**Acceptance Criteria:**
- [ ] New endpoint `GET /api/efforts/:id/snapshot` returns the snapshot via `getSnapshotForPath({ prdPath: effort.prd_path, workingDir: effort.working_dir ?? project.root_dir })`. Returns `{ status: 'pending' }` when the file is missing; 404 for non-PRD efforts
- [ ] Per-effort scoped event `effort.<id>.snapshot.updated` fires when the underlying file watcher (chokidar on `effort.prd_path`) detects changes
- [ ] Effort detail view renders `<PrdSnapshotPanels />` with the result of `/api/efforts/:id/snapshot`
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)
- [ ] Using Playwright MCP, navigate to a PRD effort detail view, verify decisions/agents panels render

### US-013: Unmanaged PRDs section + adopt + discovery collision handling
**Description:** As an existing ralph-monitor user, PRDs from systemd-unit discovery appear in an "Unmanaged" section, get adopted into projects on demand, and never double-up with effort-attached ones.

**Acceptance Criteria:**
- [ ] Existing `discovery.ts` continues walking systemd units producing PRD records
- [ ] `GET /api/unmanaged-prds` returns the discovered list MINUS any whose `taskDir + '/prd.json'` matches an effort's `prd_path` (left-anti-join). The join key is explicit: `effort.prd_path === path.join(record.taskDir, 'prd.json')`
- [ ] Sidebar has a top-level "Unmanaged PRDs" section, rendered when non-empty
- [ ] Clicking an unmanaged PRD opens an "Adopt into project" dialog: pick existing project (autocomplete by `root_dir`) OR create new project; on submit, creates an effort with `kind='prd'`, `prd_path = join(taskDir, 'prd.json')`, `working_dir = record.worktreeDir` if present
- [ ] When a discovered PRD's `worktreeDir` matches a worktree of an existing project's `root_dir` (via shared `server/git/worktrees.ts:listWorktrees(projectRootDir)` helper, cached for 30s, evicted on project delete), suggest that project as the default in the dialog
- [ ] After adoption, the unmanaged item disappears from the list (left-anti-join)
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)
- [ ] Using Playwright MCP, with at least one PRD on disk, verify "Unmanaged PRDs" section appears, click adopt, complete dialog, verify the PRD now appears under a project AND no longer appears in Unmanaged

### US-014a: Sidebar shell with lifecycle sections and project nodes
**Description:** As a user, I need the sidebar with three collapsible lifecycle sections and project rows.

**Acceptance Criteria:**
- [ ] `ui/components/Sidebar.tsx` renders three collapsible sections: Active, Recent (last_opened_at within 30d AND no live session), Archived (collapsed by default)
- [ ] "Active" includes any project with at least one live session (live-attached or live-orphaned) plus any pinned project
- [ ] Section counts shown in headers ("Active (3)")
- [ ] Project rows display: name, status dot, last-activity time
- [ ] Boundary: a project with no `last_opened_at` (never opened) appears in "Active" if newly created OR pinned, else in "Recent" with "—" for time
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)
- [ ] Using Playwright MCP, with seeded data spanning all three sections, verify sections render with correct counts

### US-014b: Effort and session nesting under project nodes (depends on US-006 reconciler)
**Description:** As a user, I expand a project to see efforts, expand an effort to see sessions, with status indicators that reflect reconciler output.

**Blocked By:** US-006 (sidebar status icons consume reconciliation results)

**Acceptance Criteria:**
- [ ] Each project node expands to its efforts (excluding archived efforts unless a per-project "show archived" toggle is on)
- [ ] Each effort expands to its sessions, showing for each: title, status icon, last-activity timestamp
- [ ] **Status icon set (lucide-react names, pinned to avoid divergence):** `Circle` (filled green) for `live-attached`, `CircleAlert` (yellow) for `live-orphaned`, `CircleSlash` (grey) for `dormant`, `CircleOff` (faded grey) for `exited`. The lucide-react package is added to `ralph-monitor/package.json` if not present
- [ ] Session row's status icon updates live via `/events` SSE (`session.updated`, `session.exited`)
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)
- [ ] Using Playwright MCP, expand a project, expand an effort, verify session list with at least 2 distinct status icons rendered

### US-014c: Right-click context menus and URL-based selection persistence
**Description:** As a user, I need actions on each node and the ability to deep-link.

**Acceptance Criteria:**
- [ ] Right-click on project → menu: Pin/Unpin, Archive/Unarchive, Rename, Delete
- [ ] Right-click on effort → menu: Archive/Unarchive, Rename, Delete
- [ ] Right-click on session → menu: Kill (only when status is `live-attached` or `live-orphaned`), Delete (with `purge_jsonl` checkbox in confirm dialog)
- [ ] Selection persists across reload via URL: `/p/:projectId`, `/p/:projectId/e/:effortId`, `/p/:projectId/e/:effortId/s/:sessionId`
- [ ] Direct navigation expands the relevant tree path on mount
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)
- [ ] Using Playwright MCP, right-click a project and verify menu items; navigate to a session URL directly and verify the tree auto-expands

### US-015a: `/api/fs/list` with realpath-then-allowlist
**Description:** As a frontend developer, I need a server endpoint to list directory contents safely.

**Acceptance Criteria:**
- [ ] `GET /api/fs/list?path=<absolute-path>` (auth-required) returns `{ entries: [{ name, isDir, isSymlink }], normalizedPath }`
- [ ] Server calls `realpath(path)` first; if it fails, returns 404
- [ ] After realpath, checks the resolved path starts with one of the realpath'd allowed roots from `RALPH_MONITOR_PROJECT_ROOTS` (default `$HOME`); else 403 with `{ error: 'path_outside_allowlist', allowed: [...] }`
- [ ] Endpoint filters dotfiles by default; `?show_hidden=true` toggles
- [ ] Unit tests: traversal attempt (`/home/user/../../etc/passwd` → 403 after realpath), symlink pointing outside allowlist (403), missing path (404), happy-path listing
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)

### US-015b: New Project flow with worktree detection (uses shared git helper)
**Description:** As a user, "New Project" picks a directory and creates a project — and warns me if the picked directory is a worktree of an existing project.

**Acceptance Criteria:**
- [ ] Sidebar header has a "+" menu with "New Project"
- [ ] Dialog opens a directory picker that calls `/api/fs/list`; user navigates from `$HOME` (or first allowed root) downward
- [ ] Name field defaulted to `basename(picked-path)`; user can override
- [ ] **Worktree detection** uses shared helper `server/git/worktrees.ts:checkIsWorktreeOfProject(pickedPath, projects[])` (see Technical Considerations). Endpoint `GET /api/projects/check-worktree?path=<picked-path>` returns `{ matched: true, projectId, branch }` if `git -C <picked> rev-parse --git-common-dir` matches an existing project's `.git` common dir
- [ ] If matched, dialog shows: *"This looks like a worktree of Project X (branch: Y). Add as a new effort under X instead?"* with two actions: (a) "Add as effort under X" (creates effort with `working_dir = picked-path`; never duplicates project), (b) "Create new project anyway"; default focus on (a)
- [ ] On project create, server realpaths and trims trailing slash before insert (per US-001)
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)
- [ ] Using Playwright MCP, new-project from a non-worktree path → verify project appears; from a worktree path → verify the detection dialog appears

### US-015c: New Effort flow
**Description:** As a user, within a project context, I create a new effort.

**Acceptance Criteria:**
- [ ] Right-click on project (or "+" in project header) → "New Effort" dialog
- [ ] Fields: `name`, `kind` (PRD/Task/General), `prd_path` (only for PRD; reuses the directory picker, validated within `project.root_dir` or a known worktree using the shared `listWorktrees` helper), optional `working_dir`
- [ ] On submit, POST `/api/projects/:id/efforts`; new effort appears in sidebar
- [ ] Validation: kind=PRD requires non-empty `prd_path` (matches schema CHECK); UI surfaces server-side errors clearly
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)
- [ ] Using Playwright MCP, right-click project, choose "New Effort", fill PRD fields, submit, verify effort appears

### US-015d: New Session flow
**Description:** As a user, within an effort context, I spawn a new Claude session.

**Acceptance Criteria:**
- [ ] Right-click on effort → "New Session" dialog
- [ ] Fields: `mode` (Interactive default, Autonomous opt-in), optional `working_dir` override (defaults to `effort.working_dir`), optional `initial_prompt`
- [ ] On submit, POST `/api/sessions`; navigates to session detail view (US-016a); WebSocket attaches automatically
- [ ] 409 surfaced clearly when one-live-session-per-effort fires
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)
- [ ] Using Playwright MCP, right-click effort, choose "New Session", submit, verify the session detail view loads and the chat or stream shows the spawned `claude` greeting

### US-016a: Session detail shell — header, breadcrumb, view-mode toggle, chat input
**Description:** As a user, opening a session shows me the conversation, breadcrumb context, and lets me type new messages.

**Blocked By:** US-009, US-010, US-011 (chat + tail + stream are mounted children); US-014c (URL routing); US-015d (entered via Spawn flow)

**Acceptance Criteria:**
- [ ] `ui/components/SessionDetail.tsx` renders: header (effort/project breadcrumb, session title, status badge slot, view-mode toggle), main pane (chat OR stream depending on mode), footer (input box + send button)
- [ ] When session's resolved cwd differs from `effort.working_dir`, header shows a "Working on: <basename of effort.working_dir>" chip distinct from a "cwd: <basename>" chip
- [ ] Input box sends to WebSocket as `{type:'input', data: <text> + '\r'}` for live sessions
- [ ] Keyboard: Enter sends, Shift+Enter inserts newline (sent on next Enter)
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)
- [ ] Using Playwright MCP, open an active session, type "hello", press Enter, wait for assistant turn via `browser_wait_for` against `[data-testid="turn-assistant"]` with 30s timeout, verify a user turn lands in the chat view; click view-mode toggle, verify stream mode renders

### US-016b: Status badge live updates and exit/Resume affordance
**Description:** As a user, the session status badge updates live, and on exit I see the exit code and a Resume button.

**Acceptance Criteria:**
- [ ] Status badge live-updates from `dormant | live-attached | live-orphaned | exited` via SSE (`/events` `session.*` events)
- [ ] On `exited`: input is replaced with "Exit code: N" + a "Resume" button that POSTs `/api/sessions/:id/resume`
- [ ] On `dormant` (no PTY): input is disabled with a "Resume" button
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)
- [ ] Using Playwright MCP, induce a session exit (e.g., by sending `exit` to a bash-spawned test session), verify badge transitions to `exited`, exit-code displayed, Resume button present

### US-016c: Kill endpoint + live-orphaned UX
**Description:** As a user, I need to kill an unreachable orphaned session and replace it with a fresh attached one.

**Acceptance Criteria:**
- [ ] New endpoint `POST /api/sessions/:id/kill`: sends `SIGTERM` to `process_pid` if alive, waits 5s for exit, escalates to `SIGKILL`. Returns 204 on success, 404 if session doesn't exist, 409 if status is `dormant` or `exited` (nothing to kill)
- [ ] On kill: updates DB row (`process_pid = NULL`, `process_started_at = NULL`), unregisters from registry if attached, emits `session.exited` SSE event
- [ ] JSONL file is preserved (not deleted) — kill is a process action, not a data action
- [ ] Idempotent: calling Kill on an already-exited session returns 409 (clear contract — user can retry safely without surprise)
- [ ] In `SessionDetail.tsx`, when status is `live-orphaned`: input is disabled with tooltip "PTY unreachable; kill and resume to regain control"; a "Kill & Resume" button is shown that calls Kill then Resume in sequence
- [ ] **UX prose** (in code comment near the button): *"Kill is destructive — the last in-flight turn is lost. Use this when the orphaned PTY is unrecoverable, not as a routine restart."*
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)
- [ ] Using Playwright MCP, simulate a `live-orphaned` session (manually mark a row as such for the test fixture), verify the Kill & Resume button appears, click it, verify the kill+resume sequence completes and status transitions to `live-attached`

### US-017a: Archive, pin, rename
**Description:** As a user, I organize my sidebar without destructive actions.

**Acceptance Criteria:**
- [ ] Archive moves a project/effort out of Active/Recent into Archived without deleting data
- [ ] Pin keeps a project at the top of Active; unpin returns it to normal lifecycle ordering
- [ ] Rename updates `name`; reflects immediately in sidebar and any open detail views
- [ ] Archiving a project also archives all its efforts (UI confirms first if any effort has a live session, blocked with "Stop the live session first")
- [ ] Archiving an effort with a live session is blocked with a clear error
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)
- [ ] Using Playwright MCP, archive a project → moves to Archived; pin another → sticks to top; rename a third → name updates everywhere

### US-017b: Safe-delete with cascade rules and JSONL purge option
**Description:** As a user, I can delete projects/efforts/sessions with explicit safety rails proportional to blast radius.

**Acceptance Criteria:**
- [ ] **Delete project** requires typed-name confirmation matching `project.name` exactly; UI dialog explicitly states cascade ("This will delete N efforts and M sessions. JSONL files are NOT deleted unless you also tick 'purge JSONLs'.")
- [ ] **Delete effort** requires single-button confirmation (no typed name); cascade warning shown; live-session block enforced
- [ ] **Delete session** offers a `purge_jsonl` checkbox (default unchecked); on confirm calls `DELETE /api/sessions/:id?purge_jsonl=<bool>`
- [ ] Endpoints reject deletes when a child row has a live session; UI surfaces the error
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)
- [ ] Using Playwright MCP, attempt to delete a project without typing the name → blocked; type the name → succeeds; delete a session with `purge_jsonl` ticked → JSONL is removed from disk

### US-018: End-to-end multi-project restart-recovery validation (deterministic)
**Description:** Validate the workflow end-to-end: actively work on multiple PRDs, restart, recover, continue. All outcomes pinned.

**Acceptance Criteria:**
- [ ] **Scenario A (interactive sessions):** create 2 projects each with a PRD effort and 1 interactive session; in each, exchange at least 2 turns via Playwright MCP typing into the input box, waiting for assistant turns via `browser_wait_for` against `[data-testid="turn-assistant"]` with 30s timeout. Stop ralph-monitor via `pkill -f "ralph-monitor"` (NOT Ctrl+C — must be reproducible from a script). Restart. Verify: both sessions appear in their respective project trees; both show as `dormant`; chat view renders prior turns from JSONL; click Resume → status transitions to `live-attached` → input box becomes active → type a new message → new user turn appears in chat (wait via the same selector strategy)
- [ ] **Scenario B (autonomous mid-flight):** create 1 project + PRD effort + 1 autonomous session; spawn `/ralph-pilot-native` against a PRD that runs at least 3 stories. While the run is mid-flight (verified by tail of JSONL showing turn writes), `pkill -f "ralph-monitor"`. Restart. Verify: session shows as `exited` (per Non-Goal — owned processes die with ralph-monitor; `live-orphaned` is reserved for v2 setsid work). JSONL contents are intact and parseable (no truncated final record per US-008b's offset semantics). Click Resume → `claude --resume <id>` continues the run from where it left off
- [ ] **Scenario C (sub-agent transcripts on disk):** during scenario B, verify that `<encoded-cwd>/<session-uuid>/subagents/agent-*.jsonl` files were written. Confirm the chat view does NOT attempt to render them as separate sessions (per v1 non-goal); the parent's chat view shows `Agent` tool calls as expandable blocks per US-009
- [ ] **API verification:** `GET /api/sessions` returns correct status for each scenario
- [ ] Document the recovery flow in `ralph-monitor/README.md` with sections: "Restarting ralph-monitor", "Resuming a session", "What happens to autonomous runs on restart"
- [ ] Typecheck passes (`bunx tsc --noEmit -p ralph-monitor/`)
- [ ] Using Playwright MCP, walk through scenarios A and B end-to-end and capture screenshots: sidebar populated post-restart, dormant chat view, resumed-session input active, exited autonomous session with Resume button visible

## Functional Requirements

- FR-1: A sqlite database at `~/.config/ralph-monitor/ralph-monitor.db` (configurable via `RALPH_MONITOR_DB`) persists projects, efforts, and sessions across restarts.
- FR-2: Each project has a `root_dir` (UNIQUE; realpath-normalized at insert), name, archived/pinned flags, and `last_opened_at`.
- FR-3: Each effort belongs to exactly one project and has `kind ∈ {prd, task, general}`; PRD efforts must carry a non-empty `prd_path` (enforced via schema CHECK), and may carry an optional `working_dir`. The file at `prd_path` need not exist yet.
- FR-4: Every project has an auto-created `general` effort.
- FR-5: Each session has a pre-allocated UUID used as both the DB primary key and the value passed to `claude --session-id`. UUIDs are never reused (Claude errors on collision; spawner always generates fresh UUIDs).
- FR-6: A session's working directory resolves as `session.working_dir ?? effort.working_dir ?? project.root_dir`. The JSONL path is `~/.claude/projects/<encoded-resolved-cwd>/<session-id>.jsonl` where `encoded` applies `replace(/[^A-Za-z0-9]+/g, '-')` (the `+` collapses consecutive non-alnums; empirically confirmed by US-000a, no `--` ever appears in real Claude project directory names). Implemented as a single shared helper `encodeClaudeProjectDir` in `server/jsonl/paths.ts`.
- FR-7: Spawned Claude processes carry `RALPH_MONITOR_SESSION=<uuid>` in env. Startup reconciliation (US-006) reads `/proc/<pid>/environ` and matches against the env tag AND `comm` (logical AND, not OR — protects against PID reuse). The current `liveness.ts` does NOT do this; it is net-new infrastructure.
- FR-8: A WebSocket endpoint provides bidirectional PTY I/O. Auth uses `Sec-WebSocket-Protocol: bearer.<token>` subprotocol — NOT a query-string token. A server-side ring buffer (default 256 KB; configurable via `RALPH_MONITOR_PTY_BUFFER_BYTES`) supports late-attaching clients via a `replay` frame.
- FR-9: SSE topology is split: the existing `/events` channel carries lifecycle events (`project.*`, `effort.*`, `session.*`, `lifecycle.snapshot` on connect, plus existing legacy `update`/`state`/`ping`). A separate per-session endpoint `/api/sessions/:id/transcript/stream` carries `snapshot` + `turn` + `gone` events for JSONL tailing.
- FR-10: The UI sidebar groups projects into Active / Recent (≤30d, no live session) / Archived sections with counts; each project expands to efforts, each effort to sessions with status icons (lucide-react: Circle/CircleAlert/CircleSlash/CircleOff).
- FR-11: PRDs already discovered via the existing systemd-unit walker appear in an "Unmanaged PRDs" section, filtered to exclude any whose `taskDir + '/prd.json'` is referenced by an effort's `prd_path` (left-anti-join).
- FR-12: The server binds to `127.0.0.1` only; setting `RALPH_MONITOR_BIND` to anything else causes refusal-to-start with the error written to `~/.config/ralph-monitor/last-error.txt` AND printed to stderr. All `/api/*` and `/events` access requires a bearer token (auto-generated, `~/.config/ralph-monitor/token`, `0600`). The dev-token endpoint at `/api/dev-token` only responds when the actual listening socket address is loopback.
- FR-13: At most one `live-attached` or `live-orphaned` session per effort, enforced via (a) partial unique index `idx_sessions_one_live_per_effort` AND (b) per-effort async mutex in `server/sessions/spawnMutex.ts`. Both layers required: the index catches concurrent races at the storage layer; the mutex prevents *attempting* a spawn that would collide and incur unnecessary SIGTERM/rollback.
- FR-14: The session detail view supports two render modes: chat (JSONL-rendered, default) and stream (raw PTY bytes via xterm.js, only available when status is `live-attached`).
- FR-15: Resume of a dormant session spawns `claude --resume <id>`; resume of a `live-orphaned` session requires explicit "Kill & Resume" via `POST /api/sessions/:id/kill` followed by Resume.
- FR-16: Archive is non-destructive. Hard-delete of a project requires typed-name confirmation; hard-delete of a session optionally purges the JSONL via `?purge_jsonl=true`.
- FR-17: Sub-agent JSONLs from `/ralph-pilot-native` runs (at `<encoded-cwd>/<parent-uuid>/subagents/agent-*.jsonl`) are NOT surfaced as separate sessions in v1. The parent session's chat view renders `Agent` tool calls per US-009; sub-agent transcripts on disk are untouched.
- FR-18: The chat renderer (US-009) filters turns where `isSidechain === true` as the load-bearing defense-in-depth measure. The parser (US-008b) preserves the flag for forensic value.

## Non-Goals

- **No tmux integration.** Owned processes die with ralph-monitor.
- **No `setsid` / detached survival of autonomous runs in v1.** A future PRD may reintroduce this scoped to autonomous sessions.
- **No remote / multi-machine support.** Non-loopback bind causes refuse-to-start.
- **No general-purpose terminal.** Sessions spawn `claude`, not arbitrary shells.
- **No conversation editing or history rewriting.** JSONL is read-only from ralph-monitor.
- **No worktree management UI.** Worktrees stay a Ralph concern.
- **No model hints.** All stories run on opus.
- **No cross-project search or full-text search of conversations.**
- **No notifications, badges for "new turn since you last looked," or mobile/PWA polish.**
- **No migration of `ralph.sh`-style loop PRDs.** Loop model stays read-only via existing snapshot views.
- **No sub-agent transcript surfacing in v1.** Sub-agent JSONLs exist on disk; v1 only renders the parent's `Agent` tool calls.
- **No `pty.js` shim fallback.** If US-000a finds no viable PTY library, the spike escalates to the user with the decision document; ralph-monitor does not autoproceed to an unmaintained dependency.

## Design Considerations

- **Sidebar visual model:** Three collapsible sections with counts. Status icons per FR-10 (lucide-react). Pinned indicator: small pin icon next to the project name.
- **Chat view aesthetics:** Monospace for code blocks. Role-prefixed blocks. Tool uses render as `▶ <name>(<short-input>)` collapsibles; `Agent` tool calls get a distinct affordance per US-009.
- **xterm.js placement:** Mount inside the same session detail panel as the chat view; toggle swaps which child is visible without remounting either, so neither loses state.
- **Reuse via decoupling, not duplication:** US-012b extracts the existing decisions/agents/tasks panels into a generic component so both legacy systemd-discovered and new effort-attached PRDs render through the same surface.

## Technical Considerations

- **`bun:sqlite`** is the intended driver (built-in, atomic writes, ralph-monitor already on Bun ≥ 1.0).
- **PTY library:** chosen via the US-000a spike. The decision document at `tasks/ralph-monitor-sessions/decisions/US-000a-DECIDE_pty-and-encoder.md` is authoritative; subsequent stories reference the chosen library by name.
- **Linux-only.** `/proc/<pid>/environ` reading is Linux-specific; the reconciler logs a warning and degrades to "all sessions dormant" on non-Linux.
- **JSONL format breadth.** Beyond `user`/`assistant`/`system`, the parser must classify (or safely ignore) `queue-operation`, `attachment`, `ai-title`, `last-prompt`, `file-history-snapshot`, `permission-mode`. Records may carry `is_partial: true` (replace-by-uuid in renderer). Parser tracks byte offset of last *complete* newline — never emits a turn from a buffered partial record.
- **Watch library: chokidar.** ralph-monitor uses chokidar throughout (`server/watchers.ts`). New JSONL tailing in US-010 reuses chokidar with `awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }`. Do NOT introduce raw `node:fs.watch`.
- **`AppEvent` union extension.** US-003 adds 10 new event types (`project.*`, `effort.*`, `session.*`, `lifecycle.snapshot`) to the `AppEvent['type']` union in `server/types.ts`. Mechanically a string-list extension; called out as an explicit AC because it's load-bearing for the SSE topology to work.
- **Existing SSE channel:** `/events` exists at `server/index.ts:17-42` and emits `state` (initial), `update` (any AppEvent), `ping` (keepalive). New lifecycle events slot in via `store.recordEvent`. The current UI consumer (`ui/sse.ts:38-49`) re-fetches `/api/state` on every `update` for the legacy snapshot data; new lifecycle events use scoped re-fetches per resource. The `lifecycle.snapshot` event on connect (US-003) eliminates the fetch-then-subscribe race window.
- **Per-session SSE:** the JSONL transcript stream lives on `/api/sessions/:id/transcript/stream` (NOT on `/events`), to avoid coupling per-session traffic to the global channel.
- **Hono+Bun WebSocket subprotocol echo.** Hono's `upgradeWebSocket` doesn't natively expose `Sec-WebSocket-Protocol` negotiation; the implementation reads the header in the upgrade request, validates `bearer.<token>`, and echoes the matched protocol back via Bun.serve's `websocket` handler. Plan for a "first-30-min surprise" when wiring this up.
- **Worktree-as-working-dir:** when an effort points at a worktree, spawn includes `--add-dir <project_root>` so the agent can read shared resources (only when resolved cwd differs from `project.root_dir`).
- **Encoder helper:** `server/jsonl/paths.ts:encodeClaudeProjectDir(absPath: string)` is the single source of truth. Implementation: `absPath.replace(/[^A-Za-z0-9]+/g, '-')`. Throws on empty/non-absolute input. Unit tests cover ASCII edge cases; Unicode is documented as a known divergence point (see Open Questions).
- **Path normalization:** `realpath` is applied at three points: `projects.root_dir` insert (US-001/002), `working_dir` resolution at spawn (US-005a-1), `/api/fs/list` allowlist check (US-015a).
- **Shared git helper:** `server/git/worktrees.ts` provides `listWorktrees(projectRootDir): Worktree[]` (parses `git -C <path> worktree list --porcelain`) and `checkIsWorktreeOfProject(pickedPath, projects[]): { matched, projectId, branch } | null`. Used by US-005d (working_dir validation), US-013 (project suggestion in adopt dialog), US-015b (worktree detection on new project), US-015c (prd_path validation). Cached per projectRootDir for 30s; cache evicted on project delete.
- **xterm.js deps:** US-011 adds `xterm`, `xterm-addon-fit` (and `xterm-addon-attach` if the chosen integration shape needs it). `lucide-react` is added for sidebar status icons (US-014b) if not already present.
- **`live-orphaned` reachability in v1:** logically reachable via the state machine but practically zero because owned processes die with ralph-monitor (no setsid). The code path is preserved live so v2 setsid work doesn't need a rewrite — fixture tests for US-016c and US-017 stub this state.

## Success Metrics

- After a machine restart, the user can return to all in-progress PRDs across projects in under 30 seconds (vs. multi-minute manual `cd` + `--resume` ceremony today).
- Restarting ralph-monitor itself loses zero conversation state (JSONL preserved; "Resume" reattaches in one click).
- The user can launch a new Claude session in any registered project without leaving the browser.
- Live `/ralph-pilot-native` runs are observable in real time via the chat view (turn-level granularity) without needing ralph-tui.

## Open Questions

- **Ring buffer size for PTY replay:** 256 KB default is a guess. Configurable via env so users can tune. Revisit after US-018.
- **Token rotation:** No mechanism in v1 to rotate the auth token without deleting the file and restarting.
- **Project root allowlist tightening:** `RALPH_MONITOR_PROJECT_ROOTS` defaults to `$HOME`. Consider `$HOME/dev` if users feel the default is too broad.
- **Encoder Unicode behavior:** the helper operates on JS string code units; non-ASCII chars become one `-` each. If Claude internally byte-iterates UTF-8 (so `é` → 2 bytes → `--`), the helpers diverge. Verify with a `mkdir /tmp/café && cd /tmp/café && claude --session-id <uuid> --print "hi"` smoke test as a v2 polish; out of scope for v1 unless the user has a Unicode-named directory.
- **v2 — Sub-agent transcript viewer:** read-only nested viewer for `<parent>/subagents/agent-*.jsonl`. Useful for debugging `/ralph-pilot-native`. Out of scope for v1.
- **v2 — Independently-spawned sessions at worktree paths:** detect `claude` sessions started outside ralph-monitor and offer to claim them. Out of scope for v1.
- **v2 — Detached autonomous runs:** wrapping autonomous spawns with `setsid` or tmux so they survive ralph-monitor restart.
- **`is_partial` semantics under load:** is `is_partial: true` a streaming-chunk artifact or retry-after-failure? The renderer's "replace by uuid" rule handles both functionally; intent informs debouncing.

## Merge Target

`main` — Merge to main branch when complete.
Auto-merge: No (ask for confirmation first).
