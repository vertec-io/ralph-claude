# Ralph for Claude Code

![Ralph](ralph.webp)

Ralph is an autonomous AI agent loop that runs [Claude Code](https://docs.anthropic.com/en/docs/claude-code) repeatedly until all PRD items are complete. Each iteration is a fresh Claude Code instance with clean context. Memory persists via git history, `progress.txt`, and `prd.json`.

**Supports both feature development AND bug investigations.**

Based on [Geoffrey Huntley's Ralph pattern](https://ghuntley.com/ralph/).

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- `jq` installed (`brew install jq` on macOS)
- A git repository for your project
- (Optional) `tmux` for interactive mode (`sudo apt install tmux` or `brew install tmux`)

### Optional: Playwright MCP (for browser testing)

For UI stories that require browser verification, install the Playwright MCP server:

```bash
claude mcp add playwright npx '@playwright/mcp@latest'
```

**Omarchy users:** The default Playwright config won't find Chromium. Edit your Claude config to add the executable path:

```bash
nano ~/.claude.json
```

Update the playwright MCP entry to include `--executable-path`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--executable-path",
        "/usr/bin/chromium"
      ]
    }
  }
}
```

## Installation

### Option 1: Install Ralph TUI (Recommended)

Ralph TUI is a native terminal interface that provides a better experience than the bash scripts.

**Using the installer (requires Rust):**

```bash
git clone https://github.com/apino/ralph-claude.git
cd ralph-claude
./install.sh
```

This installs:
- `ralph-tui` binary to `~/.local/bin/`
- `/prd` and `/ralph` skills to `~/.claude/skills/`
- Default `prompt.md` to `~/.config/ralph/`

**Using cargo (Rust users):**

```bash
cargo install --git https://github.com/apino/ralph-claude ralph-tui
```

Note: With cargo install, you'll need to manually copy skills and prompt.md:

```bash
git clone https://github.com/apino/ralph-claude.git
cp -r ralph-claude/skills/prd ~/.claude/skills/
cp -r ralph-claude/skills/ralph ~/.claude/skills/
mkdir -p ~/.config/ralph
cp ralph-claude/prompt.md ~/.config/ralph/
```

**Verify installation:**

```bash
ralph-tui --version
ralph-tui --help
```

**Uninstall:**

```bash
./uninstall.sh  # Works for both install.sh and cargo install
```

The script detects binaries in both `~/.local/bin/` and `~/.cargo/bin/`, removes config, and optionally removes skills.

### Option 2: Use bash scripts (no Rust required)

Copy the ralph files into your project:

```bash
# From your project root
mkdir -p scripts/ralph
cp /path/to/ralph-claude/ralph.sh scripts/ralph/
cp /path/to/ralph-claude/prompt.md scripts/ralph/
chmod +x scripts/ralph/ralph.sh
```

### Installing skills globally

The `/prd` and `/ralph` Claude Code skills are installed automatically with `install.sh`. To install manually:

```bash
mkdir -p ~/.claude/skills
cp -r skills/prd ~/.claude/skills/
cp -r skills/ralph ~/.claude/skills/
```

## Directory Structure

Each effort (feature or bug investigation) gets its own subdirectory:

```
tasks/
├── device-system-refactor/
│   ├── prd.md           # The requirements document
│   ├── prd.json         # Ralph-format JSON (created by /ralph skill)
│   └── progress.txt     # Ralph's iteration logs
├── fix-auth-timeout/
│   ├── prd.md
│   ├── prd.json
│   └── progress.txt
└── archived/            # Completed efforts (moved here when done)
    └── ...
```

This keeps each effort self-contained and allows multiple Ralph loops to run on different efforts without conflicts.

## Workflow

### 1. Create a PRD

Use the PRD skill to generate a detailed requirements document:

```
/prd create a PRD for [your feature or bug description]
```

The skill will:
- Ask clarifying questions (with lettered options for quick responses like "1A, 2C, 3B")
- Determine if this is a feature or bug investigation
- Create `tasks/{effort-name}/prd.md`
- Initialize `tasks/{effort-name}/progress.txt`

**For features:** Describe the new functionality you want.

**For bugs:** Describe the issue, symptoms, and any reproduction steps you know.

### 2. Convert PRD to Ralph format

Use the Ralph skill to convert the markdown PRD to JSON:

```
/ralph convert tasks/{effort-name}/prd.md
```

This creates `tasks/{effort-name}/prd.json` with user stories structured for autonomous execution.

### 3. Run Ralph

**Using Ralph TUI (recommended):**

```bash
# Interactive - select task from list
ralph-tui

# Run specific task
ralph-tui tasks/device-system-refactor

# With options
ralph-tui tasks/fix-auth-timeout -i 20 --rotate-at 300
```

Ralph TUI provides:
- Split-screen view: status panel + Claude Code output
- Real-time progress tracking
- Modal input (press `i` to interact with Claude)
- Automatic iteration management

**Using bash script:**

```bash
./scripts/ralph/ralph.sh [task-directory] [-i iterations] [-I|--interactive] [--rotate-at N]
```

**Options:**
| Flag | Description |
|------|-------------|
| `-i N` | Set max iterations (default: 10) |
| `-I` or `--interactive` | Enable interactive mode (requires tmux) |
| `--rotate-at N` | Set progress.txt rotation threshold in lines (default: 500) |
| `-y` | Skip all confirmation prompts |

Examples:
```bash
# Basic mode - prompts for task and iterations
./ralph.sh

# Run specific task (prompts for iterations)
./ralph.sh tasks/device-system-refactor

# Run with explicit iteration count (no prompts)
./ralph.sh tasks/fix-auth-timeout -i 20

# Interactive mode - allows sending messages mid-iteration
./ralph.sh tasks/fix-auth-timeout -I

# Custom rotation threshold (rotate progress.txt at 300 lines)
./ralph.sh tasks/big-refactor --rotate-at 300
```

**Interactive prompts:**

1. **Task selection** (if no task directory specified):
   - If **one active task**: Runs it automatically
   - If **multiple active tasks**: Shows numbered list to choose from
   - If **no active tasks**: Shows instructions for creating one

2. **Iteration count** (if `-i` not specified):
   ```
   Max iterations [10]:
   ```
   Press Enter for default (10) or enter a number.

3. **Rotation threshold** (if progress.txt is near threshold or has been rotated before):
   ```
   Progress file has 475 lines (rotation threshold: 500)
   Rotation threshold [500]:
   ```
   Press Enter to accept or enter a new value.

Ralph will:
1. Create a feature branch (from PRD `branchName`)
2. Pick the highest priority story where `passes: false`
3. Implement that single story
4. Run quality checks (typecheck, tests)
5. Commit if checks pass
6. Update `prd.json` to mark story as `passes: true`
7. Append learnings to `progress.txt`
8. Rotate `progress.txt` if it exceeds threshold
9. Repeat until all stories pass or max iterations reached

### 4. Archive completed efforts

When Ralph completes (or you're done with an effort), archive it:

```bash
mkdir -p tasks/archived
mv tasks/fix-auth-timeout tasks/archived/
```

This keeps the active `tasks/` directory clean while preserving completed work.

## Key Files

| File | Purpose |
|------|---------|
| `ralph.sh` | The bash loop that spawns fresh Claude Code instances |
| `prompt.md` | Instructions given to each Claude Code instance |
| `skills/prd/` | Skill for generating PRDs (features and bugs) |
| `skills/ralph/` | Skill for converting PRDs to JSON |
| `prd.json.example` | Example PRD format |

## PRD Types

### Feature PRD

For new functionality, enhancements, or refactors. Stories follow dependency order:
1. Schema/database changes
2. Backend logic
3. UI components
4. Integration/polish

### Bug Investigation PRD

For troubleshooting and fixing issues. Stories follow investigation flow:
1. **Reproduce** - Document exact reproduction steps
2. **Instrument** - Add logging to understand the issue
3. **Analyze** - Identify root cause (document in `notes` field)
4. **Evaluate** - Consider solution options
5. **Implement** - Fix the bug
6. **Validate** - Confirm the fix works

The `notes` field in each story passes context between iterations.

## Critical Concepts

### Each Iteration = Fresh Context

Each iteration spawns a **new Claude Code instance** with clean context. The only memory between iterations is:
- Git history (commits from previous iterations)
- `progress.txt` (learnings and context)
- `prd.json` (which stories are done, plus notes)

### Small Tasks

Each PRD item should be small enough to complete in one context window. If a task is too big, the LLM runs out of context before finishing and produces poor code.

**Right-sized stories:**
- Add a database column and migration
- Add logging to a specific code area
- Implement a focused bug fix
- Validate a fix with tests

**Too big (split these):**
- "Build the entire dashboard" - Split into: schema, queries, UI components, filters
- "Add authentication" - Split into: schema, middleware, login UI, session handling
- "Fix all the bugs" - Focus on one specific issue

**Rule of thumb:** If you cannot describe the change in 2-3 sentences, it is too big.

### AGENTS.md Updates

After each iteration, Ralph updates relevant `AGENTS.md` files with learnings. Claude Code automatically reads these files, so future iterations benefit from discovered patterns and gotchas.

### Feedback Loops

Ralph only works if there are feedback loops:
- Typecheck catches type errors
- Tests verify behavior
- CI must stay green (broken code compounds across iterations)

### Stop Condition

When all stories have `passes: true`, Ralph outputs `<promise>COMPLETE</promise>` and the loop exits.

## Interactive Mode

Interactive mode (`-I` flag) lets you send messages to Claude while it's working, without interrupting the current iteration.

**Requirements:** tmux must be installed.

**Keyboard shortcuts:**
| Key | Action |
|-----|--------|
| `i` | Send a message to Claude (supports multiline - double-Enter to send, Esc to cancel) |
| `f` | Force a checkpoint (asks Claude to update progress files) |
| `q` | Quit the current iteration gracefully |

**Use cases:**
- Ask Claude if it's stuck when you see it repeating actions
- Provide additional context or hints
- Request a checkpoint to save progress before stopping
- Redirect Claude when it's going down the wrong path

**Example interaction:**
```
╔═══════════════════════════════════════════════════════════════╗
║  Ralph Wiggum - Autonomous Agent Loop                         ║
╚═══════════════════════════════════════════════════════════════╝

  Task:       tasks/meteorite-refactor
  Mode:       Interactive (tmux)

  ┌─────────────────────────────────────────────────────────────┐
  │  i: Send message    f: Force checkpoint    q: Quit iter   │
  └─────────────────────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════
  Iteration 3 of 20 (2/15 complete)
═══════════════════════════════════════════════════════════════

  ⠹ Claude working... 32:15
  Let me check the serial port configuration...
  ● Bash(ls -la /dev/ttyUSB*)
  [i: message | f: checkpoint | q: quit]

[User presses 'i']

  Enter message (double-Enter to send, Esc to cancel):
  > You've been testing serial for 30 min. Is there an issue?
  > (press Enter twice to send)
```

## Progress Rotation

For long-running efforts, `progress.txt` can grow very large, consuming excessive context tokens. Ralph automatically rotates the file when it exceeds a threshold (default: 500 lines).

**How it works:**

1. Before each iteration, Ralph checks `progress.txt` line count
2. If approaching threshold (within 50 lines) or already rotated once, prompts to confirm threshold
3. When threshold exceeded:
   - Renames `progress.txt` → `progress-N.txt`
   - Creates new `progress.txt` with:
     - Codebase Patterns section (preserved)
     - Brief summary referencing prior file
     - Ready for new iteration logs

**File structure after rotation:**
```
tasks/big-refactor/
├── prd.json
├── progress.txt       # Current (lines 1-500, references progress-1.txt)
├── progress-1.txt     # Previous (lines 1-500, references progress-0.txt if exists)
└── progress-2.txt     # Older
```

**Example rotated progress.txt:**
```markdown
# Ralph Progress Log
Effort: meteorite-refactor
Type: feature
Started: Fri Jan 10 09:00:00 2025
Rotation: 1 (rotated at Thu Jan 16 14:30:00 2026)

## Codebase Patterns
- Use `sql<number>` template for aggregations
- Always use `IF NOT EXISTS` for migrations
- Export types from actions.ts for UI components

## Prior Progress
Completed 12 iterations in progress-1.txt.
_See progress-1.txt for detailed iteration logs._

---
## 2025-01-16 14:35 - S13
- What was implemented: ...
```

Claude can read prior progress files if needed for additional context, but typically the summary and patterns provide sufficient continuity.

## Debugging

Check current state:

```bash
# See which stories are done
cat tasks/{effort-name}/prd.json | jq '.userStories[] | {id, title, passes, notes}'

# See learnings from previous iterations
cat tasks/{effort-name}/progress.txt

# Check git history
git log --oneline -10

# List available task directories
ls -la tasks/
```

## Customizing prompt.md

Ralph uses `prompt.md` to instruct Claude on how to work. Edit it to customize behavior for your project:
- Add project-specific quality check commands
- Include codebase conventions
- Add common gotchas for your stack

**Prompt locations (Ralph TUI checks in order):**

1. `./ralph/prompt.md` - Project-specific customization
2. `~/.config/ralph/prompt.md` - Global user default
3. Embedded fallback - Built into the binary

To customize per-project, create `ralph/prompt.md` in your project root:

```bash
mkdir -p ralph
cp ~/.config/ralph/prompt.md ralph/prompt.md
# Edit ralph/prompt.md with project-specific instructions
```

## References

- [Geoffrey Huntley's Ralph article](https://ghuntley.com/ralph/)
- [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code)
