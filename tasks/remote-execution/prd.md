# PRD: Remote Project Execution

## Type
Feature

## Introduction

Add the ability to run Ralph projects on remote servers via SSH. This allows users to leverage more powerful cloud/server resources for running Ralph iterations instead of being limited to local machine capabilities.

## Goals

- Execute Ralph on a remote host via SSH
- Support CLI flag, config file, and interactive prompt for specifying remote host
- Use SSH keys for authentication (no passwords)
- Stream output back to local terminal
- Handle basic error cases (connection failure, missing dependencies)

## User Stories

### US-001: Add remote host CLI flag to ralph.sh
**Description:** As a user, I want to specify a remote host via CLI so I can quickly run on a remote server.

**Acceptance Criteria:**
- [ ] `ralph.sh` accepts `--remote user@host` flag
- [ ] Flag is optional; omitting it runs locally (existing behavior)
- [ ] Help text documents the new flag
- [ ] Invalid host format shows clear error message

### US-002: Add remote host config file support
**Description:** As a user, I want to configure a default remote host so I don't have to type it every time.

**Acceptance Criteria:**
- [ ] Read `remote_host` from `ralph.config` or task-level config
- [ ] CLI flag overrides config file
- [ ] Document config format in README or inline comments

### US-003: Add interactive remote host prompt
**Description:** As a user, I want to be prompted for remote execution option when starting Ralph.

**Acceptance Criteria:**
- [ ] If no remote flag and no config, prompt: "Run locally or remotely? [L/r]"
- [ ] If "r", prompt for "Remote host (user@host):"
- [ ] Can skip prompt with `--local` flag to force local execution

### US-004: Implement SSH execution wrapper
**Description:** As a user, I want Ralph to execute on the remote host and stream output back.

**Acceptance Criteria:**
- [ ] SSH to remote host using SSH keys (no password)
- [ ] Sync project files to remote (rsync or scp)
- [ ] Execute `ralph.sh` on remote with same arguments
- [ ] Stream stdout/stderr back to local terminal in real-time
- [ ] Exit code from remote is propagated to local

### US-005: Handle remote execution errors gracefully
**Description:** As a user, I want clear error messages when remote execution fails.

**Acceptance Criteria:**
- [ ] Connection failure shows "Cannot connect to host" with troubleshooting hints
- [ ] Missing SSH key shows "SSH key authentication failed"
- [ ] Missing ralph.sh on remote shows "Ralph not found on remote host"
- [ ] Network interruption attempts graceful handling

## Functional Requirements

- FR-1: Add `--remote user@host` CLI flag to `ralph.sh`
- FR-2: Add `--local` flag to skip remote prompt and force local execution
- FR-3: Support `remote_host` field in config file (ralph.config or task config)
- FR-4: Prompt for remote execution when no flag/config specified
- FR-5: Use `rsync` to sync project directory to remote before execution
- FR-6: Execute ralph.sh on remote via SSH with `-t` for TTY allocation
- FR-7: Stream remote output to local terminal in real-time
- FR-8: Propagate remote exit code to local shell
- FR-9: Require SSH key authentication (reject password prompts)

## Non-Goals

- No support for multiple simultaneous remote hosts
- No job queuing or scheduling
- No web UI for remote monitoring
- No password authentication
- No automatic remote environment setup (user must have Ralph installed)

## Technical Considerations

- Use `rsync -avz --delete` for efficient file sync
- SSH with `-o BatchMode=yes` to fail fast on auth issues
- Consider `--exclude .git` to speed up sync
- Remote must have Ralph already installed at expected path
- May need to handle different remote shell environments (bash assumed)

## Success Metrics

- User can run `ralph.sh --remote user@server tasks/my-task` successfully
- Output appears in real-time, not buffered until completion
- Failed connections show actionable error messages within 5 seconds

## Open Questions

- Should we sync back changes from remote automatically?
- What's the expected remote Ralph installation path?
- Should there be a `--dry-run` to show what would be synced?

## Merge Target

None - standalone branch
