---
name: ralph-runner
description: Launch multiple Ralph PRDs sequentially or in parallel with isolated git worktrees, proper PID tracking, and --status / --stop / --clean subcommands. Use when you have two or more PRDs to execute at once (parallel when independent, sequential when dependent) rather than running a single PRD via ralph-tui or direct ralph.sh invocation. Provides the launcher script template, the PRD registry format, known pitfalls (Git Bash PID namespace, nohup wrapper PID capture, hung SSH recovery, Windows drive letter delimiter conflicts), and the relationship to /ralph-worktree (which handles a single PRD). TRIGGER phrases include "launch multiple PRDs", "run these in parallel", "run these in sequence", "launch the next batch", "launch-fips-agents", "ralph runner", "multi-PRD execution", and any request to orchestrate two or more Ralph loops simultaneously. This is the execution layer that /ralph-pilot reaches for in Phase 2 when a single worktree isn't enough.
---

# Ralph-Runner

Launch multiple Ralph PRDs in sequence, in parallel, or a mix — with proper worktree isolation, PID tracking, log capture, and subcommand control. Use this when you have more than one PRD to execute at the same time (even if only one is currently "running" and the others are queued), and you need a repeatable launcher that survives restarts and ends cleanly.

This skill is the multi-PRD sibling of `/ralph-worktree`, which handles a single PRD. For single-PRD runs, prefer `/ralph-worktree` + ralph-tui. For anything with two or more PRDs, use `/ralph-runner`.

---

## 1. When to use which execution mode

**Single PRD, interactive:** `/ralph-worktree` + `ralph-tui`. You can watch story-by-story progress in the TUI, intervene interactively, and don't need parallelism. This is the default for focused efforts.

**Single PRD, background:** `/ralph-worktree` + `nohup bash ralph.sh <task-dir> -i N -y > ralph.log 2>&1 &` + disown. Run when you want to work on something else while Ralph executes and don't need the TUI. Log and PID tracking are manual.

**Multiple PRDs, parallel:** `/ralph-runner` with all PRDs marked for parallel execution. Each PRD gets its own worktree at a known path, its own branch, its own log file, and its own PID file. They share the `.git` object database but cannot stomp on each other's working trees. Use when PRDs are independent (different codebases, no shared files, no sequencing requirement).

**Multiple PRDs, sequential:** `/ralph-runner` with PRDs marked for phased execution. Phase 1 runs sequentially; Phase 2 (if any) runs in parallel after Phase 1 completes. Use when later PRDs depend on artifacts from earlier ones.

**Multiple PRDs, mixed:** the `launch-fips-agents.sh` pattern — Phase 1 sequential (PRDs 1, 2, 3, 4) followed by Phase 2 parallel (PRDs 5, 6, 7, 8 all at once after Phase 1 finishes). This is the most common shape for large multi-PRD efforts.

**Never:** two Ralph loops in the same working tree. The launcher enforces worktree isolation for this reason; if you find yourself about to run two `ralph.sh` commands against the same directory, stop and use `/ralph-runner` instead.

---

## 2. Launcher script template

Use this as the starting point. Copy to the project root, edit the PRDS registry, edit the WORKDIR, then `chmod +x` and run.

```bash
#!/bin/bash
# Multi-PRD Ralph launcher — parallel execution with isolated git worktrees.
#
# Each PRD gets its own worktree at a known path, its own branch, its own log
# file, and its own PID file. Worktrees share the .git object database but
# cannot stomp on each other's working trees.
#
# Usage:
#   ./launch-prds.sh          # launch all PRDs that are not already complete
#   ./launch-prds.sh --status # check progress + running status
#   ./launch-prds.sh --stop   # kill running Ralphs (leaves worktrees alone)
#   ./launch-prds.sh --clean  # remove worktrees (after merge)

set -e

WORKDIR="D:/your-orchestration-repo"
RALPH_SH="$WORKDIR/ralph.sh"

cd "$WORKDIR"

# ──────────────────────────────────────────────
#  PRD registry
#  format: task-dir|max-iterations|worktree-path|branch-name
#
#  CRITICAL: use | as the delimiter, NOT : — Windows drive letters contain :
# ──────────────────────────────────────────────

PRDS=(
  "tasks/prd-24-example|100|D:/prd-24-worktree|ralph/prd-24-example"
  "tasks/prd-25-example|20|D:/prd-25-worktree|ralph/prd-25-example"
)

# ──────────────────────────────────────────────
#  --status
# ──────────────────────────────────────────────

if [ "$1" = "--status" ]; then
  echo "================================================================"
  echo "  Multi-PRD Ralph Status — $(date)"
  echo "================================================================"
  echo ""
  for entry in "${PRDS[@]}"; do
    IFS='|' read -r TASK_DIR MAX_ITER WORKTREE BRANCH <<< "$entry"
    PRD_FILE="$TASK_DIR/prd.json"
    LOG_FILE="$TASK_DIR/ralph.log"
    PID_FILE="$TASK_DIR/ralph.pid"

    if [ ! -f "$PRD_FILE" ]; then
      echo "[MISSING] $TASK_DIR — no prd.json"
      continue
    fi

    # Prefer the worktree's prd.json if it exists (Ralph updates that one)
    WT_PRD_FILE="$WORKTREE/$TASK_DIR/prd.json"
    if [ -f "$WT_PRD_FILE" ]; then
      READ_FILE="$WT_PRD_FILE"
    else
      READ_FILE="$PRD_FILE"
    fi

    TOTAL=$(jq '.userStories | length' "$READ_FILE" 2>/dev/null || echo "?")
    DONE=$(jq '[.userStories[] | select(.passes == true)] | length' "$READ_FILE" 2>/dev/null || echo "?")

    # Windows-safe PID check: use PowerShell, NOT bash kill -0
    # Git Bash PIDs are MSYS namespace, not Windows — kill -0 gives false negatives
    PID_STATUS="no pid file"
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      if powershell -Command "if (Get-Process -Id $PID -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" 2>/dev/null; then
        PID_STATUS="running (PID $PID)"
      else
        PID_STATUS="stopped (PID $PID exited)"
      fi
    fi

    LOG_SIZE="(no log)"
    if [ -f "$LOG_FILE" ]; then
      LOG_SIZE="$(wc -l < "$LOG_FILE" 2>/dev/null) lines"
    fi

    WT_STATUS="absent"
    if [ -d "$WORKTREE" ]; then
      WT_STATUS="present"
    fi

    echo "── $TASK_DIR"
    echo "   stories:  $DONE/$TOTAL (source: $READ_FILE)"
    echo "   runtime:  $PID_STATUS"
    echo "   worktree: $WORKTREE ($WT_STATUS)"
    echo "   branch:   $BRANCH"
    echo "   log:      $LOG_FILE ($LOG_SIZE)"
    echo ""
  done
  exit 0
fi

# ──────────────────────────────────────────────
#  --stop
# ──────────────────────────────────────────────

if [ "$1" = "--stop" ]; then
  echo "Stopping running Ralph runs..."
  for entry in "${PRDS[@]}"; do
    IFS='|' read -r TASK_DIR MAX_ITER WORKTREE BRANCH <<< "$entry"
    PID_FILE="$TASK_DIR/ralph.pid"
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      echo "  killing PID $PID ($TASK_DIR) and descendants"
      # Kill the entire process tree (Ralph spawns grandchildren claude.exe)
      # Recursive PowerShell tree-kill: walk ParentProcessId, stop each child
      powershell -Command "function Kill-Tree(\$p) { Get-CimInstance Win32_Process -Filter \"ParentProcessId=\$p\" | ForEach-Object { Kill-Tree \$_.ProcessId; Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue } }; Kill-Tree $PID; Stop-Process -Id $PID -Force -ErrorAction SilentlyContinue" 2>/dev/null || true
      rm -f "$PID_FILE"
    fi
  done
  echo "Stopped."
  exit 0
fi

# ──────────────────────────────────────────────
#  --clean
# ──────────────────────────────────────────────

if [ "$1" = "--clean" ]; then
  echo "Removing worktrees (branches left in place)..."
  for entry in "${PRDS[@]}"; do
    IFS='|' read -r TASK_DIR MAX_ITER WORKTREE BRANCH <<< "$entry"
    if [ -d "$WORKTREE" ]; then
      echo "  git worktree remove --force $WORKTREE"
      git worktree remove --force "$WORKTREE" 2>&1 | tail -2
    fi
  done
  git worktree prune 2>&1
  echo "Cleaned."
  exit 0
fi

# ──────────────────────────────────────────────
#  Launch mode (default)
# ──────────────────────────────────────────────

echo "================================================================"
echo "  Launching PRDs in parallel (isolated worktrees)  $(date)"
echo "================================================================"
echo ""

for entry in "${PRDS[@]}"; do
  IFS='|' read -r TASK_DIR MAX_ITER WORKTREE BRANCH <<< "$entry"
  PRD_FILE="$TASK_DIR/prd.json"
  LOG_FILE="$WORKDIR/$TASK_DIR/ralph.log"
  PID_FILE="$WORKDIR/$TASK_DIR/ralph.pid"

  if [ ! -f "$PRD_FILE" ]; then
    echo "[SKIP] $TASK_DIR — no prd.json"
    continue
  fi

  # Skip if already complete
  TOTAL=$(jq '.userStories | length' "$PRD_FILE" 2>/dev/null || echo "0")
  DONE=$(jq '[.userStories[] | select(.passes == true)] | length' "$PRD_FILE" 2>/dev/null || echo "0")
  if [ "$DONE" -eq "$TOTAL" ] && [ "$TOTAL" -gt 0 ]; then
    echo "[SKIP] $TASK_DIR — already complete ($DONE/$TOTAL)"
    continue
  fi

  # Skip if already running
  if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if powershell -Command "if (Get-Process -Id $OLD_PID -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" 2>/dev/null; then
      echo "[SKIP] $TASK_DIR — already running (PID $OLD_PID). Use --stop to kill first."
      continue
    fi
  fi

  # Create or reuse worktree
  if [ -d "$WORKTREE" ]; then
    echo "[REUSE] $WORKTREE (already exists)"
  else
    echo "[CREATE] git worktree add $WORKTREE -b $BRANCH main"
    if ! git worktree add "$WORKTREE" -b "$BRANCH" main 2>&1 | tail -3; then
      # Branch already exists — check it out into a new worktree
      git worktree add "$WORKTREE" "$BRANCH" 2>&1 | tail -3
    fi
  fi

  echo "[LAUNCH] $TASK_DIR ($DONE/$TOTAL complete, budget $MAX_ITER iterations)"
  echo "         worktree: $WORKTREE"
  echo "         branch:   $BRANCH"
  echo "         log:      $LOG_FILE"

  # Launch ralph.sh from INSIDE the worktree so it operates on isolated files.
  # Subshell avoids affecting the launcher's cwd.
  # nohup + disown detaches the process from the launcher shell.
  (
    cd "$WORKTREE"
    nohup bash "$RALPH_SH" "$TASK_DIR" -i "$MAX_ITER" -y > "$LOG_FILE" 2>&1 &
    PID=$!
    echo "$PID" > "$PID_FILE"
    disown "$PID" 2>/dev/null || true
    echo "         PID: $PID  (WARNING: may be the nohup wrapper, not the real loop — see gotchas)"
  )
  echo ""
done

echo "================================================================"
echo "  Launched. Monitor with:  ./$(basename $0) --status"
echo "================================================================"
```

---

## 3. Sequential + parallel combined (launch-fips-agents style)

When some PRDs must finish before others start (Phase 1 sequential) and the rest can run together (Phase 2 parallel), use the combined pattern. The sequential block uses `tee` to stream output to both terminal and log, then gates on completion before moving to the parallel phase.

```bash
# ──────────────────────────────────────────────
#  Phase 1: Sequential PRDs via ralph.sh
# ──────────────────────────────────────────────

PHASE1_PRDS=(
  "tasks/prd-01|15"
  "tasks/prd-02|20"
  "tasks/prd-03|25"
)

PHASE1_START=$(date +%s)
for entry in "${PHASE1_PRDS[@]}"; do
  TASK_DIR="${entry%%|*}"
  MAX_ITER="${entry##*|}"
  PRD_FILE="$TASK_DIR/prd.json"
  LOG_FILE="$TASK_DIR/ralph.log"

  TOTAL=$(jq '.userStories | length' "$PRD_FILE" 2>/dev/null || echo "0")
  DONE=$(jq '[.userStories[] | select(.passes == true)] | length' "$PRD_FILE" 2>/dev/null || echo "0")

  if [ "$DONE" -eq "$TOTAL" ] && [ "$TOTAL" -gt 0 ]; then
    echo "[SKIP] $TASK_DIR — already complete ($DONE/$TOTAL)"
    continue
  fi

  echo "[Starting] $TASK_DIR"
  "$RALPH_SH" "$TASK_DIR" -i "$MAX_ITER" -y 2>&1 | tee "$LOG_FILE"
  EXIT_CODE=${PIPESTATUS[0]}

  DONE=$(jq '[.userStories[] | select(.passes == true)] | length' "$PRD_FILE" 2>/dev/null || echo "0")
  TOTAL=$(jq '.userStories | length' "$PRD_FILE" 2>/dev/null || echo "0")

  if [ "$DONE" -ne "$TOTAL" ]; then
    echo "[INCOMPLETE] $TASK_DIR — $DONE/$TOTAL after $MAX_ITER iterations"
    echo "Stopping Phase 1. Fix issues and re-run."
    exit 1
  fi
  echo ""
  sleep 10
done

# ──────────────────────────────────────────────
#  Phase 2: Parallel PRDs
# ──────────────────────────────────────────────
# At this point Phase 1 is done; Phase 2 uses the parallel launcher above
# or spawns each PRD with its own nohup bash ralph.sh ... & pattern.
```

Phase 1's `tee` pattern streams live output to the terminal AND the log, so you can watch it in a terminal while you also have durable log files for later analysis. Phase 2 is pure background — no tee, just redirect to log files.

---

## 4. Known pitfalls (learned the hard way)

### Pitfall 1: Git Bash kill -0 on Windows PIDs gives false negatives

Git Bash (MSYS) maintains its own PID namespace, which does NOT match Windows PIDs. `kill -0 $PID` against a PID captured from `$!` will return false even when the process is running, because Git Bash is checking its MSYS PID space and the PID is a Windows process ID.

**Fix:** always check process liveness via PowerShell, not via bash built-ins:

```bash
if powershell -Command "if (Get-Process -Id $PID -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" 2>/dev/null; then
  echo "alive"
fi
```

### Pitfall 2: nohup wrapper captures the wrong PID

`nohup bash ralph.sh ... &` backgrounds the nohup+bash wrapper. `$!` captures the wrapper's PID. But ralph.sh itself spawns a LOOP bash that actually runs iterations, and THAT is the real long-running process. The wrapper may exit shortly after starting, leaving `$!`'s captured PID pointing at a dead process even though Ralph is still running fine.

**Symptom:** `--status` says "stopped (PID N exited)" but Ralph is clearly still committing work.

**Mitigation:** either (a) use `ps` / `Get-CimInstance` to find the real loop PID by command line pattern match after launch, or (b) accept that the PID file is approximate and cross-check with `git log --since` or log mtime for ground truth. Commits and log mtime are more reliable progress indicators than the PID file.

### Pitfall 3: Windows drive letters conflict with `:` as a registry delimiter

A PRD registry entry like `tasks/prd-24|100|D:/worktree|ralph/prd-24` split on `:` gives you five fields, not four, because `D:` itself contains a colon. Every field after the drive letter is off by one.

**Fix:** use `|` (pipe) as the delimiter instead of `:`. The PRD registry in this template already does this.

### Pitfall 4: Two Ralph loops in the same worktree

If you skip the per-PRD worktree step and run two `ralph.sh` commands against the same working directory, you get two Claude agents `git checkout`-ing to different branches, writing the same files, and stomping on each other's commits. One agent wins, the other agent's work is silently lost.

**Fix:** every PRD gets its own worktree. This is non-negotiable. The launcher template enforces it via the `git worktree add` step. If you're tempted to skip this to save time, don't — the debugging cost of the stomping scenario is vastly higher than the few seconds saved by not creating a worktree.

### Pitfall 5: Hung SSH sessions from remote commands

Ralph running E2E validation often SSHes into a remote VM to build and run binaries. If the remote command hangs (blocked on a network read, infinite retry loop, waiting for user input on a non-tty), the SSH session hangs with it. The claude subprocess blocks on the SSH completion, the iteration hangs, ralph.sh hangs waiting for the iteration, and nothing appears to be happening.

**Symptom:** log mtime stops updating, iteration counter frozen, CPU time on claude subprocess is flat (near zero), two or three ssh.exe processes older than ~10 minutes.

**Recovery:**
```bash
# Identify hung ssh sessions
powershell -Command "Get-CimInstance Win32_Process -Filter \"Name='ssh.exe'\""

# Kill them
powershell -Command "Stop-Process -Id <pid1>,<pid2> -Force"

# Clean up any remote processes
ssh ubuntu@vm-host "pkill -9 -f <pattern>"
```

After killing, Ralph's claude subprocess will get a broken-pipe error on its SSH call, the iteration will exit, and ralph.sh will spawn the next iteration. Usually recovery is within 30 seconds.

Always add the finding to `outstanding-items.md` — a hung SSH usually means a real bug in the code being tested (e.g., ignoring a dial timeout, infinite retry on handshake failure). Capture it.

### Pitfall 6: Branch accumulation from previous runs

After many PRD runs, branches accumulate: `ralph/prd-22-...`, `ralph/prd-23-...`, `ralph/prd-24-...`. Most are stale after their PRD is merged. Leaving them cluttered makes it hard to spot new branches and consumes `.git/refs` entries.

**Fix:** after a merge, delete the branch:
```bash
git branch -D ralph/prd-NN-...
git worktree remove --force D:/prd-NN-worktree
git worktree prune
```

Or use the launcher's `--clean` subcommand.

### Pitfall 7: The `$!` after a subshell doesn't do what you expect

In the launch loop, the template uses a subshell `( cd ... ; nohup ... & echo $! > ... )`. The `$!` inside the subshell captures the backgrounded process, which is what you want. But if you try to use `$!` OUTSIDE the subshell, it refers to the subshell itself, not the process inside it.

**Fix:** always capture the PID inside the subshell as the template does. Don't move the `echo "$PID" > "$PID_FILE"` out of the subshell — it will capture the wrong value.

### Pitfall 8: PowerShell strings in heredocs

Embedding PowerShell in bash heredocs requires escaping dollar signs: `\$_` instead of `$_`, `\$PID` instead of `$PID`. Otherwise bash interpolates the variable (usually to empty) before PowerShell sees it. Every PowerShell invocation in the template escapes its PowerShell variables this way.

---

## 5. Relationship to other skills

- **`/ralph-worktree`** — handles a single PRD worktree. Use when you only have one PRD. Provides TUI integration. `/ralph-runner` is the multi-PRD sibling.
- **`/ralph`** — converts a PRD to prd.json. Runs before `/ralph-runner`, not as part of it.
- **`/ralph-pilot`** — the meta-skill that decides *when* to invoke `/ralph-runner`. The runner is a tool; the pilot is the operator.
- **`/ralph-audit`** — runs before `/ralph-runner` in Phase 1 of the effort, not during execution.
- **`/ralph-handoff`** — handoff.md lives outside the runner but may reference running PRDs for continuity.

---

## 6. Checklist before launching a multi-PRD run

1. Every PRD has a valid `prd.json` that Ralph can read. Verify with `python -c "import json; json.load(open('tasks/prd-NN/prd.json'))"`.
2. Every PRD has been through `/ralph-audit` — you are not launching un-audited plans.
3. The user has approved the execution, especially if any PRD will push to external remotes.
4. The PRD registry in the launcher script is correct: right task dirs, right iteration budgets, right worktree paths, right branch names.
5. The delimiter is `|`, not `:`. Double-check if any Windows paths are involved.
6. Stale worktrees from previous runs are removed (`--clean`).
7. Stale branches from previous runs are deleted.
8. `main` is in the state you want the worktrees to branch from. No uncommitted changes, no half-applied stashes.
9. Log file paths point somewhere reasonable (the default is `tasks/prd-NN/ralph.log`, not `/tmp` — you want these persisted).
10. You know how you'll monitor progress: `--status` subcommand, `tail -f` on the log files, ralph-tui, or a combination. Running blind is fine for short runs but painful for long ones.

---

## 7. When NOT to use this skill

- **Single PRD runs** — use `/ralph-worktree` + ralph-tui. Much simpler, better interactive experience.
- **Ad-hoc one-shot builds** — if you're just running a single `ralph.sh` invocation to test something, do it manually. The runner template is overkill for one-off work.
- **Remote execution** — this skill assumes ralph.sh runs on the local machine. If Ralph should run on a remote build host, use a different orchestration layer (screen/tmux on the remote, or a scheduled job).

---

## 8. Relationship to `launch-fips-agents.sh`

The existing `launch-fips-agents.sh` in some projects is an older Phase 1 sequential + Phase 2 parallel pattern that predates this skill. It uses the same ideas but with less robust subcommand handling. When porting old launchers to this skill, keep the same PRD groupings but swap in the template above for cleaner subcommand support and PID tracking.
