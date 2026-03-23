---
name: ralph-worktree
description: "Create an isolated git worktree for a Ralph PRD so it can run without conflicting with other work. Use after /prd and /ralph have created the task directory and prd.json. Triggers on: start ralph, create worktree for ralph, ralph worktree, launch ralph, kick off ralph."
version: "1.0"
---

# Ralph Worktree Launcher

Creates an isolated git worktree for a Ralph PRD and gives you the command to start the Ralph loop.

---

## When to Use

After you have:
1. A PRD created via `/prd` at `tasks/{effort-name}/prd.md`
2. A prd.json created via `/ralph` at `tasks/{effort-name}/prd.json`

This skill creates the worktree so you can run Ralph without conflicting with other work on `main`.

---

## The Job

1. Read the prd.json to get the `branchName`
2. Commit any uncommitted task files to `main`
3. Create a git worktree at `../{effort-name}` on a new branch
4. Tell the user the command to start Ralph

---

## Steps

### Step 1 — Find the PRD

Look for the task directory. If the user says "start ralph for console-v2", look at `tasks/console-v2/prd.json`.

If ambiguous, list available task directories that have a `prd.json`:

```bash
find tasks -name prd.json -type f
```

### Step 2 — Read the branch name

Read `prd.json` and extract the `branchName` field (e.g., `ralph/console-v2`).

### Step 3 — Commit task files

If the task files (prd.md, prd.json, progress.txt) are uncommitted, stage and commit them:

```bash
git add tasks/{effort-name}/
git commit -m "feat: Create PRD for {effort-name}"
```

### Step 4 — Create the worktree

```bash
git worktree add ../{effort-name} -b {branchName}
```

This creates:
- A new branch `{branchName}` from the current HEAD
- A working directory at `../{effort-name}` (sibling to the main repo)

### Step 5 — Report to user

Tell the user:

```
Worktree ready at D:\{effort-name} on branch {branchName}.

Start Ralph:
  cd D:\{effort-name}
  ralph run tasks/{effort-name}
```

---

## Cleanup After Ralph Completes

When the user says Ralph is done and wants to merge:

```bash
# From the main repo
cd D:\ai-company

# Merge the branch
git merge {branchName} --no-edit

# Push
git push origin main

# Clean up
git worktree remove --force ../{effort-name}
git branch -d {branchName}
```

If the worktree directory has a file lock (common after Ralph runs):

```bash
# Prune the worktree reference and delete the branch
git worktree prune
git branch -d {branchName}
# User deletes the directory manually
```

---

## Multiple Worktrees

Multiple Ralph agents can run simultaneously in separate worktrees. Each gets its own branch and directory:

```
D:\ai-company/          ← main (your working directory)
D:\console-v2/          ← ralph/console-v2 (Ralph agent 1)
D:\instance-agent/      ← ralph/instance-agent (Ralph agent 2)
D:\caddy-migration/     ← ralph/caddy-migration (Ralph agent 3)
```

**Rules for parallel Ralph agents:**
- Each PRD must set `autoMerge: false` — never auto-merge
- Each PRD must set a unique `branchName`
- Merge branches back to main one at a time after Ralph completes
- Resolve any merge conflicts manually

---

## PRD Configuration for Worktrees

The prd.json should have these settings for worktree-based execution:

```json
{
  "branchName": "ralph/{effort-name}",
  "mergeTarget": "main",
  "autoMerge": false
}
```

- `branchName`: The branch Ralph works on (created by this skill)
- `mergeTarget`: Where to merge when done (usually `main`)
- `autoMerge: false`: Never auto-merge — user merges manually after review

---

## Example

User: "Create a worktree for the console-v2 PRD"

1. Read `tasks/console-v2/prd.json` → `branchName: "ralph/console-v2"`
2. Commit task files if needed
3. Run: `git worktree add ../console-v2 -b ralph/console-v2`
4. Report:

```
Worktree ready at D:\console-v2 on branch ralph/console-v2.

Start Ralph:
  cd D:\console-v2
  ralph run tasks/console-v2
```

---

## After Creation — Show Launch Commands

After creating worktrees, show the user **only the worktrees just created** with their launch commands. Don't list all active worktrees — the user just needs to know the task directory for the ones they're about to launch.

**Format:**

```
Worktrees ready:

| # | Worktree | Task Dir | Stories |
|---|----------|----------|---------|
| 1 | D:\3d-cad-research | tasks/3d-cad-research | 14 research |
| 2 | D:\dataview-full-app | tasks/dataview-full-app | 14 feature |
| 3 | D:\ai-dock-expansion | tasks/ai-dock-expansion | 7 feature |

Launch commands:
  /ralph-loop D:\3d-cad-research tasks/3d-cad-research
  /ralph-loop D:\dataview-full-app tasks/dataview-full-app
  /ralph-loop D:\ai-dock-expansion tasks/ai-dock-expansion
```

The user copies the task dir from here when the ralph script prompts for a task number. Keep it concise — only show what was just created.
