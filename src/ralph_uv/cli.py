"""Ralph CLI entrypoint using Click."""

from __future__ import annotations

import json
import os
import shlex
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path

import click

from ralph_uv import __version__
from ralph_uv.agents import VALID_AGENTS
from ralph_uv.attach import attach
from ralph_uv.loop import LoopConfig, LoopRunner
from ralph_uv.opencode_server import OpencodeServer, OpencodeServerError
from ralph_uv.session import (
    SessionDB,
    SessionInfo,
    checkpoint_session,
    get_status,
    stop_session,
    task_name_from_dir,
    tmux_create_session,
    tmux_kill_session,
    tmux_session_alive,
    tmux_session_exists,
    tmux_session_name,
)

DEFAULT_ITERATIONS = 10


# --- Helpers ---


def _find_active_tasks() -> list[Path]:
    """Find active task directories (those with prd.json, excluding archived)."""
    tasks_dir = Path("tasks")
    if not tasks_dir.is_dir():
        return []

    results: list[Path] = []
    for prd_file in sorted(tasks_dir.rglob("prd.json")):
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
    return [agent for agent in VALID_AGENTS if shutil.which(agent) is not None]


def _prompt_task_selection() -> Path | None:
    """Interactively prompt the user to select a task directory."""
    tasks = _find_active_tasks()

    if not tasks:
        if not Path("tasks").is_dir():
            click.echo("No tasks/ directory found in current project.")
        else:
            click.echo("No active tasks found in tasks/.")
        click.echo()
        click.echo("To create a new task:")
        click.echo("  1. Use /prd in Claude Code to create a PRD")
        click.echo("  2. Use /ralph to convert it to prd.json")
        click.echo("  3. Run: ralph-uv run tasks/{effort-name}")
        return None

    if len(tasks) == 1:
        click.echo(f"Found one active task: {tasks[0]}")
        return tasks[0]

    # Multiple tasks — prompt
    click.echo()
    click.echo("=" * 67)
    click.echo("  Ralph - Select a Task")
    click.echo("=" * 67)
    click.echo()

    for i, task in enumerate(tasks, 1):
        click.echo(f"  {i}) {_display_task_info(task)}")

    click.echo()
    selection: int = click.prompt(f"Select task [1-{len(tasks)}]", type=int, default=1)

    idx = selection - 1
    if 0 <= idx < len(tasks):
        return tasks[idx]

    click.echo("Invalid selection.")
    return None


def _resolve_agent(
    cli_agent: str | None,
    task_dir: Path,
    skip_prompts: bool,
) -> str:
    """Resolve which agent to use.

    Priority: CLI flag > prd.json saved > interactive prompt > only installed > default.
    """
    # 1. CLI override
    if cli_agent:
        if shutil.which(cli_agent) is None:
            click.echo(f"Warning: Agent '{cli_agent}' not found in PATH.", err=True)
        return cli_agent

    # 2. Check prd.json for saved agent
    prd_file = task_dir / "prd.json"
    if prd_file.is_file():
        try:
            prd = json.loads(prd_file.read_text())
            saved_agent = str(prd.get("agent", ""))
            if saved_agent and saved_agent in VALID_AGENTS:
                if shutil.which(saved_agent) is not None:
                    click.echo(f"Using saved agent: {saved_agent}")
                    return saved_agent
                else:
                    click.echo(
                        f"Warning: Saved agent '{saved_agent}' not installed.",
                        err=True,
                    )
        except (json.JSONDecodeError, OSError):
            pass

    # 3. Detect installed agents
    installed = _detect_installed_agents()

    if not installed:
        click.echo("Error: No supported AI coding agents found.", err=True)
        click.echo()
        click.echo("Please install one of the following:")
        click.echo("  - Claude Code: npm install -g @anthropic-ai/claude-code")
        click.echo("  - OpenCode: curl -fsSL https://opencode.ai/install | bash")
        raise SystemExit(1)

    if len(installed) == 1:
        click.echo(f"Using only installed agent: {installed[0]}")
        return installed[0]

    # Multiple agents available
    if skip_prompts:
        return installed[0]

    # Interactive prompt
    click.echo()
    click.echo("Available agents:")
    for i, agent in enumerate(installed, 1):
        click.echo(f"  {i}) {agent}")
    click.echo()

    selection: int = click.prompt(
        f"Select agent [1-{len(installed)}]", type=int, default=1
    )
    idx = selection - 1
    if 0 <= idx < len(installed):
        chosen = installed[idx]
        _save_agent_to_prd(prd_file, chosen)
        return chosen

    click.echo(f"Invalid selection. Using {installed[0]}.")
    return installed[0]


def _save_agent_to_prd(prd_file: Path, agent: str) -> None:
    """Save the agent selection to prd.json."""
    if not prd_file.is_file():
        return
    try:
        prd = json.loads(prd_file.read_text())
        prd["agent"] = agent
        prd_file.write_text(json.dumps(prd, indent=2) + "\n")
        click.echo("Agent preference saved to prd.json")
    except (json.JSONDecodeError, OSError):
        pass


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
    task_name = task_name_from_dir(task_dir)
    session_name = tmux_session_name(task_name)

    # Check for existing session
    db = SessionDB()
    existing = db.get(task_name)
    if tmux_session_exists(session_name):
        if existing and existing.status == "running":
            click.echo(
                f"Error: Session already running for '{task_name}'. "
                f"Use 'ralph-uv stop {task_name}' first.",
                err=True,
            )
            return 1
        # Stale tmux session — kill it
        tmux_kill_session(session_name)
    elif existing and existing.status == "running":
        # DB says running but tmux is gone — stale entry, clean it up
        db.update_status(task_name, "failed")

    # Build command to run inside tmux
    cmd_parts: list[str] = [
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
        cmd_parts.extend(["--base-branch", base_branch])
    if yolo:
        cmd_parts.append("--yolo")
    if verbose:
        cmd_parts.append("--verbose")

    # Create tmux session via libtmux
    cmd_str = shlex.join(cmd_parts)
    project_root = str(task_dir.parent.parent)
    pid = tmux_create_session(
        session_name,
        cmd_str,
        project_root,
        environment={"RALPH_TMUX_SESSION": session_name},
    )

    # Give the inner process a moment to start, then verify it survived
    time.sleep(1.0)

    if not tmux_session_alive(session_name):
        # Capture any crash output from the pane before killing
        if tmux_session_exists(session_name):
            tmux_kill_session(session_name)
        click.echo(
            f"Error: tmux session '{session_name}' died immediately after starting.",
            err=True,
        )
        click.echo(
            "  The inner process likely crashed. Try running directly:",
            err=True,
        )
        click.echo(f"  RALPH_TMUX_SESSION={session_name} {cmd_str}", err=True)
        return 1

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

    click.echo(f"  Started tmux session: {session_name}")
    click.echo(f"  Attach with: tmux attach -t {session_name}")
    return 0


def _spawn_opencode_server(
    task_dir: Path,
    max_iterations: int,
    agent: str,
    base_branch: str | None,
    yolo: bool,
    verbose: bool,
) -> int:
    """Spawn ralph-uv with opencode serve mode.

    Starts an opencode serve process, registers it in SQLite, then runs
    the loop directly (sending prompts via HTTP API).
    Returns 0 on success.
    """
    task_name = task_name_from_dir(task_dir)
    project_root = task_dir.parent.parent

    # Check for existing session
    db = SessionDB()
    existing = db.get(task_name)
    if existing and existing.status == "running":
        if existing.session_type == "opencode-server":
            from ralph_uv.session import opencode_server_alive

            if opencode_server_alive(existing.server_port):
                click.echo(
                    f"Error: Session already running for '{task_name}'. "
                    f"Use 'ralph-uv stop {task_name}' first.",
                    err=True,
                )
                return 1
        elif tmux_session_exists(tmux_session_name(task_name)):
            click.echo(
                f"Error: Session already running for '{task_name}'. "
                f"Use 'ralph-uv stop {task_name}' first.",
                err=True,
            )
            return 1
        # Stale entry — clean it up
        db.update_status(task_name, "failed")

    # Start opencode serve
    server = OpencodeServer(
        working_dir=project_root,
        verbose=verbose,
    )

    try:
        server.start()
    except OpencodeServerError as e:
        click.echo(f"Error starting opencode server: {e}", err=True)
        return 1

    # Wait for health check
    click.echo(f"  Starting opencode serve on port {server.port}...")
    try:
        server.wait_until_healthy()
    except OpencodeServerError as e:
        click.echo(f"Error: opencode server failed health check: {e}", err=True)
        server.stop()
        return 1

    click.echo(f"  OpenCode server healthy at {server.url}")

    # Register in database
    now = datetime.now().isoformat()
    session = SessionInfo(
        task_name=task_name,
        task_dir=str(task_dir),
        pid=server.pid or os.getpid(),
        tmux_session="",  # Not used for opencode-server
        agent=agent,
        status="running",
        started_at=now,
        updated_at=now,
        iteration=0,
        current_story="",
        max_iterations=max_iterations,
        session_type="opencode-server",
        server_port=server.port,
    )
    db.register(session)

    click.echo(f"  Attach with: opencode attach {server.url}")

    # Run the loop directly (in this process) using the opencode server
    config = LoopConfig(
        task_dir=task_dir,
        max_iterations=max_iterations,
        agent=agent,
        agent_override=agent,
        base_branch=base_branch,
        yolo_mode=yolo,
        verbose=verbose,
    )
    runner = LoopRunner(config, opencode_server=server)
    rc = 1
    try:
        rc = runner.run()
    finally:
        server.stop()
        # Update session status
        final_status = "completed" if rc == 0 else "stopped"
        db.update_status(task_name, final_status)

    return rc


# --- Click CLI ---


@click.group()
@click.version_option(version=__version__, prog_name="ralph-uv")
def cli() -> None:
    """Ralph - Autonomous AI agent loop runner."""
    pass


@cli.command()
@click.argument("task_dir", required=False, type=click.Path(exists=False))
@click.option(
    "-i",
    "--max-iterations",
    type=int,
    default=None,
    help=f"Maximum iterations (default: {DEFAULT_ITERATIONS}).",
)
@click.option(
    "-a",
    "--agent",
    type=click.Choice(list(VALID_AGENTS)),
    default=None,
    help="Agent to use.",
)
@click.option("--base-branch", default=None, help="Base branch to start from.")
@click.option(
    "-y",
    "--yes",
    "skip_prompts",
    is_flag=True,
    help="Skip interactive prompts, use defaults.",
)
@click.option("--yolo", is_flag=True, help="Skip agent permission checks.")
@click.option("--verbose", is_flag=True, help="Enable verbose agent output.")
def run(
    task_dir: str | None,
    max_iterations: int | None,
    agent: str | None,
    base_branch: str | None,
    skip_prompts: bool,
    yolo: bool,
    verbose: bool,
) -> None:
    """Run the agent loop for a task."""
    # --- Resolve task directory ---
    if task_dir:
        resolved_dir = Path(task_dir).resolve()
    elif skip_prompts:
        click.echo("Error: task_dir is required with --yes flag.", err=True)
        raise SystemExit(1)
    else:
        selected = _prompt_task_selection()
        if selected is None:
            raise SystemExit(1)
        resolved_dir = selected.resolve()

    # Validate task dir
    if not resolved_dir.is_dir():
        click.echo(f"Error: Task directory not found: {resolved_dir}", err=True)
        raise SystemExit(1)
    if not (resolved_dir / "prd.json").is_file():
        click.echo(f"Error: prd.json not found in {resolved_dir}", err=True)
        raise SystemExit(1)

    # --- Resolve iterations ---
    if max_iterations is None:
        if skip_prompts:
            max_iterations = DEFAULT_ITERATIONS
        else:
            max_iterations = click.prompt(
                "Max iterations", type=int, default=DEFAULT_ITERATIONS
            )

    assert max_iterations is not None  # Guaranteed by prompt/default above

    # --- Resolve agent ---
    resolved_agent = _resolve_agent(agent, resolved_dir, skip_prompts)

    # --- Check if we're inside tmux already ---
    running_in_tmux = os.environ.get("RALPH_TMUX_SESSION", "")

    if running_in_tmux:
        # We're inside tmux — run the loop directly
        config = LoopConfig(
            task_dir=resolved_dir,
            max_iterations=max_iterations,
            agent=resolved_agent,
            agent_override=agent,
            base_branch=base_branch,
            yolo_mode=yolo,
            verbose=verbose,
        )
        runner = LoopRunner(config)
        raise SystemExit(runner.run())
    elif resolved_agent == "opencode":
        # OpenCode agent: use opencode serve mode (HTTP API)
        rc = _spawn_opencode_server(
            task_dir=resolved_dir,
            max_iterations=max_iterations,
            agent=resolved_agent,
            base_branch=base_branch,
            yolo=yolo,
            verbose=verbose,
        )
        raise SystemExit(rc)
    else:
        # Claude agent: spawn ourselves in a tmux session
        rc = _spawn_in_tmux(
            task_dir=resolved_dir,
            max_iterations=max_iterations,
            agent=resolved_agent,
            base_branch=base_branch,
            yolo=yolo,
            verbose=verbose,
        )
        raise SystemExit(rc)


@cli.command()
@click.option("--json", "json_output", is_flag=True, help="Output as JSON.")
def status(json_output: bool) -> None:
    """Show status of running sessions."""
    output = get_status(as_json=json_output)
    click.echo(output)


@cli.command()
@click.argument("task")
def stop(task: str) -> None:
    """Stop a running session."""
    success = stop_session(task)
    if not success:
        raise SystemExit(1)


@cli.command()
@click.argument("task")
def checkpoint(task: str) -> None:
    """Checkpoint a running session (pause after current iteration)."""
    success = checkpoint_session(task)
    if not success:
        raise SystemExit(1)


@cli.command(name="attach")
@click.argument("task")
def attach_cmd(task: str) -> None:
    """Attach to a running session"""
    rc = attach(task)
    if rc != 0:
        raise SystemExit(rc)


if __name__ == "__main__":
    cli()
