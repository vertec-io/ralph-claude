"""Ralph CLI entrypoint."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

from ralph_uv import __version__
from ralph_uv.agents import VALID_AGENTS
from ralph_uv.attach import attach
from ralph_uv.loop import LoopConfig, LoopRunner
from ralph_uv.session import (
    SessionDB,
    SessionInfo,
    checkpoint_session,
    get_status,
    stop_session,
    task_name_from_dir,
    tmux_create_session,
    tmux_session_exists,
    tmux_session_name,
)

DEFAULT_ITERATIONS = 10


def _find_active_tasks() -> list[Path]:
    """Find active task directories (those with prd.json, excluding archived)."""
    tasks_dir = Path("tasks")
    if not tasks_dir.is_dir():
        return []

    results: list[Path] = []
    for prd_file in sorted(tasks_dir.rglob("prd.json")):
        # Skip archived tasks
        if "archived" in prd_file.parts:
            continue
        results.append(prd_file.parent)

    return results


def _display_task_info(task_dir: Path) -> str:
    """Format a task directory for display."""
    prd_file = task_dir / "prd.json"
    description = "No description"
    total = "?"
    done = "?"
    prd_type = "feature"

    try:
        prd = json.loads(prd_file.read_text())
        description = str(prd.get("description", "No description"))[:60]
        stories = prd.get("userStories", [])
        total = str(len(stories))
        done = str(sum(1 for s in stories if s.get("passes", False)))
        prd_type = str(prd.get("type", "feature"))
    except (json.JSONDecodeError, OSError):
        pass

    return f"{str(task_dir):<35} [{done}/{total}] ({prd_type})"


def _detect_installed_agents() -> list[str]:
    """Detect which supported agents are installed."""
    installed: list[str] = []
    for agent in VALID_AGENTS:
        if shutil.which(agent) is not None:
            installed.append(agent)
    return installed


def _prompt_task_selection() -> Path | None:
    """Interactively prompt the user to select a task directory.

    Returns the selected Path, or None if no tasks found / invalid selection.
    """
    tasks = _find_active_tasks()

    if not tasks:
        if not Path("tasks").is_dir():
            print("No tasks/ directory found in current project.")
        else:
            print("No active tasks found in tasks/.")
        print()
        print("To create a new task:")
        print("  1. Use /prd in Claude Code to create a PRD")
        print("  2. Use /ralph to convert it to prd.json")
        print("  3. Run: ralph-uv run tasks/{effort-name}")
        return None

    if len(tasks) == 1:
        print(f"Found one active task: {tasks[0]}")
        return tasks[0]

    # Multiple tasks — prompt
    print()
    print("=" * 67)
    print("  Ralph - Select a Task")
    print("=" * 67)
    print()
    print("Active tasks:")
    print()

    for i, task in enumerate(tasks, 1):
        print(f"  {i}) {_display_task_info(task)}")

    print()
    try:
        selection = input(f"Select task [1-{len(tasks)}]: ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        return None

    try:
        idx = int(selection) - 1
        if 0 <= idx < len(tasks):
            return tasks[idx]
    except ValueError:
        pass

    print("Invalid selection.")
    return None


def _prompt_iterations() -> int:
    """Interactively prompt for max iterations. Returns the chosen number."""
    try:
        raw = input(f"Max iterations [{DEFAULT_ITERATIONS}]: ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        return DEFAULT_ITERATIONS

    if not raw:
        return DEFAULT_ITERATIONS

    try:
        n = int(raw)
        if n > 0:
            return n
    except ValueError:
        pass

    print(f"Invalid number. Using default of {DEFAULT_ITERATIONS}.")
    return DEFAULT_ITERATIONS


def _resolve_agent(
    cli_agent: str | None,
    task_dir: Path,
    skip_prompts: bool,
) -> str:
    """Resolve which agent to use.

    Priority:
    1. CLI --agent flag
    2. Agent saved in prd.json
    3. Interactive prompt (if multiple installed)
    4. Only installed agent
    5. Default: claude

    Args:
        cli_agent: Agent name from CLI flag, or None.
        task_dir: The task directory (to check prd.json).
        skip_prompts: If True, skip interactive prompts.

    Returns:
        The resolved agent name.
    """
    # 1. CLI override
    if cli_agent:
        if shutil.which(cli_agent) is None:
            print(f"Warning: Agent '{cli_agent}' not found in PATH.")
        return cli_agent

    # 2. Check prd.json for saved agent
    prd_file = task_dir / "prd.json"
    if prd_file.is_file():
        try:
            prd = json.loads(prd_file.read_text())
            saved_agent = str(prd.get("agent", ""))
            if saved_agent and saved_agent in VALID_AGENTS:
                if shutil.which(saved_agent) is not None:
                    print(f"Using saved agent: {saved_agent}")
                    return saved_agent
                else:
                    print(
                        f"Warning: Saved agent '{saved_agent}' not installed. "
                        "Selecting another."
                    )
        except (json.JSONDecodeError, OSError):
            pass

    # 3. Detect installed agents
    installed = _detect_installed_agents()

    if not installed:
        print("Error: No supported AI coding agents found.")
        print()
        print("Please install one of the following:")
        print("  - Claude Code: npm install -g @anthropic-ai/claude-code")
        print("  - OpenCode: curl -fsSL https://opencode.ai/install | bash")
        sys.exit(1)

    if len(installed) == 1:
        print(f"Using only installed agent: {installed[0]}")
        return installed[0]

    # Multiple agents available
    if skip_prompts:
        # Default to first in priority order
        return installed[0]

    # Interactive prompt
    print()
    print("=" * 67)
    print("  Select AI Coding Agent")
    print("=" * 67)
    print()
    print("Available agents:")
    print()

    for i, agent in enumerate(installed, 1):
        print(f"  {i}) {agent}")

    print()
    try:
        raw = input(f"Select agent [1-{len(installed)}]: ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        return installed[0]

    try:
        idx = int(raw) - 1
        if 0 <= idx < len(installed):
            chosen = installed[idx]
            # Save to prd.json
            _save_agent_to_prd(prd_file, chosen)
            return chosen
    except ValueError:
        pass

    print(f"Invalid selection. Using {installed[0]}.")
    return installed[0]


def _save_agent_to_prd(prd_file: Path, agent: str) -> None:
    """Save the agent selection to prd.json."""
    if not prd_file.is_file():
        return
    try:
        prd = json.loads(prd_file.read_text())
        prd["agent"] = agent
        prd_file.write_text(json.dumps(prd, indent=2) + "\n")
        print(f"Agent preference saved to prd.json")
    except (json.JSONDecodeError, OSError):
        pass


def create_parser() -> argparse.ArgumentParser:
    """Create the argument parser for the ralph CLI."""
    parser = argparse.ArgumentParser(
        prog="ralph-uv",
        description="Ralph - Autonomous AI agent loop runner",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"ralph-uv {__version__}",
    )

    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # run command
    run_parser = subparsers.add_parser("run", help="Run the agent loop for a task")
    run_parser.add_argument(
        "task_dir",
        nargs="?",
        default=None,
        help="Path to the task directory containing prd.json (interactive if omitted)",
    )
    run_parser.add_argument(
        "-i",
        "--max-iterations",
        type=int,
        default=None,
        help=f"Maximum number of iterations (prompts if omitted, default: {DEFAULT_ITERATIONS})",
    )
    run_parser.add_argument(
        "-a",
        "--agent",
        choices=list(VALID_AGENTS),
        default=None,
        help="Agent to use (prompts if omitted)",
    )
    run_parser.add_argument(
        "--base-branch",
        default=None,
        help="Base branch to start from (default: current branch)",
    )
    run_parser.add_argument(
        "-y",
        "--yes",
        action="store_true",
        dest="skip_prompts",
        help="Skip interactive prompts, use defaults",
    )
    run_parser.add_argument(
        "--yolo",
        action="store_true",
        help="Skip agent permission checks (dangerously-skip-permissions)",
    )
    run_parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose agent output",
    )

    # status command
    status_parser = subparsers.add_parser(
        "status", help="Show status of running sessions"
    )
    status_parser.add_argument(
        "--json",
        action="store_true",
        dest="json_output",
        help="Output status as JSON for machine-readable output",
    )

    # stop command
    stop_parser = subparsers.add_parser("stop", help="Stop a running session")
    stop_parser.add_argument("task", help="Task name to stop")

    # checkpoint command
    checkpoint_parser = subparsers.add_parser(
        "checkpoint", help="Checkpoint a running session"
    )
    checkpoint_parser.add_argument("task", help="Task name to checkpoint")

    # attach command
    attach_parser = subparsers.add_parser("attach", help="Attach to a running session")
    attach_parser.add_argument("task", help="Task name to attach to")

    return parser


def _cmd_run(args: argparse.Namespace) -> int:
    """Execute the 'run' subcommand."""
    skip_prompts = args.skip_prompts

    # --- Resolve task directory ---
    if args.task_dir:
        task_dir = Path(args.task_dir).resolve()
    elif skip_prompts:
        print("Error: task_dir is required with --yes flag.")
        return 1
    else:
        selected = _prompt_task_selection()
        if selected is None:
            return 1
        task_dir = selected.resolve()

    # Validate task dir
    if not task_dir.is_dir():
        print(f"Error: Task directory not found: {task_dir}", file=sys.stderr)
        return 1
    if not (task_dir / "prd.json").is_file():
        print(f"Error: prd.json not found in {task_dir}", file=sys.stderr)
        return 1

    # --- Resolve iterations ---
    if args.max_iterations is not None:
        max_iterations = args.max_iterations
    elif skip_prompts:
        max_iterations = DEFAULT_ITERATIONS
    else:
        max_iterations = _prompt_iterations()

    # --- Resolve agent ---
    agent = _resolve_agent(args.agent, task_dir, skip_prompts)

    # --- Check if we're inside tmux already ---
    running_in_tmux = os.environ.get("RALPH_TMUX_SESSION", "")

    if running_in_tmux:
        # We're inside tmux — run the loop directly
        config = LoopConfig(
            task_dir=task_dir,
            max_iterations=max_iterations,
            agent=agent,
            agent_override=args.agent,
            base_branch=args.base_branch,
            yolo_mode=args.yolo,
            verbose=args.verbose,
        )
        runner = LoopRunner(config)
        return runner.run()
    else:
        # Not in tmux — spawn ourselves in a tmux session
        return _spawn_in_tmux(
            task_dir=task_dir,
            max_iterations=max_iterations,
            agent=agent,
            base_branch=args.base_branch,
            yolo=args.yolo,
            verbose=args.verbose,
        )


def _spawn_in_tmux(
    task_dir: Path,
    max_iterations: int,
    agent: str,
    base_branch: str | None,
    yolo: bool,
    verbose: bool,
) -> int:
    """Spawn ralph-uv inside a tmux session.

    Creates a detached tmux session running ralph-uv with the same arguments
    plus RALPH_TMUX_SESSION set. Registers the session in SQLite.
    Returns 0 on success.
    """
    from datetime import datetime

    task_name = task_name_from_dir(task_dir)
    session_name = tmux_session_name(task_name)

    # Check for existing session
    if tmux_session_exists(session_name):
        db = SessionDB()
        existing = db.get(task_name)
        if existing and existing.status == "running":
            print(
                f"Error: Session already running for '{task_name}'. "
                f"Use 'ralph-uv stop {task_name}' first.",
                file=sys.stderr,
            )
            return 1
        # Stale session — kill it
        from ralph_uv.session import tmux_kill_session

        tmux_kill_session(session_name)

    # Build command to run inside tmux
    cmd: list[str] = [
        sys.executable,
        "-m",
        "ralph_uv.cli",
        "run",
        str(task_dir),
        "-i",
        str(max_iterations),
        "-a",
        agent,
        "-y",  # Skip prompts inside tmux
    ]
    if base_branch:
        cmd.extend(["--base-branch", base_branch])
    if yolo:
        cmd.append("--yolo")
    if verbose:
        cmd.append("--verbose")

    # Set RALPH_TMUX_SESSION so the inner invocation knows it's in tmux
    env_prefix = f"RALPH_TMUX_SESSION='{session_name}'"
    cmd_str = f"{env_prefix} {' '.join(_shell_quote(c) for c in cmd)}"

    # Create tmux session
    import subprocess

    project_root = str(task_dir.parent.parent)
    subprocess.run(
        [
            "tmux",
            "new-session",
            "-d",
            "-s",
            session_name,
            "-x",
            "200",
            "-y",
            "50",
            "-c",
            project_root,
            f"bash -c '{cmd_str}'",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    # Register in SQLite
    import time

    time.sleep(0.5)  # Give tmux a moment to start
    pid = _get_tmux_pane_pid(session_name)

    db = SessionDB()
    now = datetime.now().isoformat()
    session = SessionInfo(
        task_name=task_name,
        task_dir=str(task_dir),
        pid=pid,
        tmux_session=session_name,
        agent=agent,
        status="running",
        started_at=now,
        updated_at=now,
        iteration=0,
        current_story="",
        max_iterations=max_iterations,
    )
    db.register(session)

    print(f"  Started tmux session: {session_name}")
    print(f"  Attach with: tmux attach -t {session_name}")
    return 0


def _get_tmux_pane_pid(session_name: str) -> int:
    """Get the PID of the process in the tmux session pane."""
    import subprocess

    result = subprocess.run(
        ["tmux", "list-panes", "-t", session_name, "-F", "#{pane_pid}"],
        capture_output=True,
        text=True,
    )
    if result.returncode == 0 and result.stdout.strip():
        return int(result.stdout.strip().splitlines()[0])
    return os.getpid()


def _shell_quote(s: str) -> str:
    """Simple shell quoting for tmux command arguments."""
    if not s:
        return "''"
    if all(c.isalnum() or c in "-_./=:@" for c in s):
        return s
    return "'" + s.replace("'", "'\"'\"'") + "'"


def _cmd_status(args: argparse.Namespace) -> int:
    """Execute the 'status' subcommand."""
    output = get_status(as_json=args.json_output)
    print(output)
    return 0


def _cmd_stop(args: argparse.Namespace) -> int:
    """Execute the 'stop' subcommand."""
    success = stop_session(args.task)
    return 0 if success else 1


def _cmd_checkpoint(args: argparse.Namespace) -> int:
    """Execute the 'checkpoint' subcommand."""
    success = checkpoint_session(args.task)
    return 0 if success else 1


def main() -> int:
    """Main entry point for the ralph CLI."""
    parser = create_parser()
    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        return 0

    match args.command:
        case "run":
            return _cmd_run(args)
        case "status":
            return _cmd_status(args)
        case "stop":
            return _cmd_stop(args)
        case "checkpoint":
            return _cmd_checkpoint(args)
        case "attach":
            return attach(args.task)

    return 0


def cli() -> None:
    """CLI wrapper that calls main() and exits with its return code."""
    sys.exit(main())


if __name__ == "__main__":
    cli()
