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

### Step 4.5 — Copy .env files (CRITICAL)

Git worktrees do NOT include `.gitignored` files like `.env`. The worktree will be missing environment variables needed to run the app (database URLs, API keys, auth secrets, etc.). **This causes silent failures** where services appear unreachable.

**Copy all `.env` files from the main repo to the worktree:**

```bash
# Find all .env files in the main repo (they're gitignored, won't be in the worktree)
find . -name '.env' -not -path '*/node_modules/*' -not -path '*/.git/*' | while read envfile; do
  target="../{effort-name}/${envfile}"
  if [ ! -f "$target" ]; then
    mkdir -p "$(dirname "$target")"
    cp "$envfile" "$target"
    echo "  Copied $envfile → $target"
  fi
done
```

**Per-project .env locations:** Check `CLAUDE.md` or `AGENTS.md` files in the repo for project-specific `.env` locations. If the project has a `.env.example`, use it as a reference for required variables.

**Why this matters:** Without the `.env`, apps can't reach databases, APIs, or services. The UI will show "unreachable" errors with no obvious cause. This has caused debugging confusion multiple times.

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

## After Creation — Show Launch Info with TUI Task Number

After creating worktrees, show the user the **Ralph TUI task number** so they can select it without scanning a long list. The TUI lists tasks alphabetically by directory name — determine the position by sorting all `tasks/*/` directories alphabetically and finding where the new task falls.

**How to determine the TUI number:**

```bash
ls -1 tasks/ | sort | grep -n "{effort-name}" | cut -d: -f1
```

This gives you the number the user will type when `ralph-tui` prompts "Select task [1-N]:".

**Format (single worktree):**

```
Worktree ready at D:\{effort-name} on branch {branchName}.

| TUI # | Task Dir | Stories | Type |
|-------|----------|---------|------|
| 20 | tasks/fix-app-design-system-compliance | 8 | feature |

Launch: /ralph-loop D:\{effort-name} tasks/{effort-name}
```

**Format (multiple worktrees):**

```
Worktrees ready:

| TUI # | Task Dir | Stories | Type |
|-------|----------|---------|------|
| 3 | tasks/ai-dock-expansion | 7 | feature |
| 16 | tasks/dataview-full-app | 14 | feature |
| 47 | tasks/shopflow-full-app | 21 | feature |

Launch commands:
  /ralph-loop D:\ai-dock-expansion tasks/ai-dock-expansion
  /ralph-loop D:\dataview-full-app tasks/dataview-full-app
  /ralph-loop D:\shopflow-full-app tasks/shopflow-full-app
```

The **TUI #** column matches what `ralph-tui` shows when it prompts "Select task [1-N]:", so the user can type the number directly without scanning the full list.
