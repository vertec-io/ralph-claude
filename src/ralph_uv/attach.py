"""Attach command: connect to a running ralph-uv session.

Supports two session types:
- tmux: Wraps `tmux attach-session` for claude/opencode TUI sessions.
- opencode-server: Runs `opencode attach http://localhost:<port>` for
  opencode serve sessions, giving users the native opencode TUI.
"""

from __future__ import annotations

import subprocess
import sys

from ralph_uv.session import (
    SessionDB,
    opencode_server_alive,
    tmux_attach_session,
    tmux_session_alive,
    tmux_session_exists,
    tmux_session_name,
)


def attach(task_name: str) -> int:
    """Attach to a running ralph-uv session.

    Dispatches based on session_type:
    - opencode-server: runs `opencode attach http://localhost:<port>`
    - tmux: runs `tmux attach-session -t <name>`

    Args:
        task_name: The task name to attach to.

    Returns:
        Exit code (0 = normal exit, 1 = error).
    """
    db = SessionDB()
    session = db.get(task_name)

    if session is not None and session.session_type == "opencode-server":
        return _attach_opencode_server(task_name, session.server_port, db)

    return _attach_tmux(task_name, db)


def _attach_opencode_server(task_name: str, port: int | None, db: SessionDB) -> int:
    """Attach to an opencode-server session via `opencode attach`.

    Args:
        task_name: The task name.
        port: The opencode serve port.
        db: Session database.

    Returns:
        Exit code.
    """
    if port is None:
        print(
            f"Error: Session '{task_name}' has no server port recorded.",
            file=sys.stderr,
        )
        return 1

    if not opencode_server_alive(port):
        # Server is not responding — mark as failed
        db.update_status(task_name, "failed")
        print(
            f"Error: OpenCode server for '{task_name}' is not responding "
            f"(port {port}).",
            file=sys.stderr,
        )
        print(
            f"  Restart with: ralph-uv run tasks/{task_name}/",
            file=sys.stderr,
        )
        return 1

    url = f"http://localhost:{port}"
    print(f"Attaching to opencode server at {url}...")

    # Run opencode attach — it takes over the terminal
    result = subprocess.run(["opencode", "attach", url])
    return result.returncode


def _attach_tmux(task_name: str, db: SessionDB) -> int:
    """Attach to a tmux session.

    Args:
        task_name: The task name.
        db: Session database.

    Returns:
        Exit code.
    """
    session_name = tmux_session_name(task_name)

    if not tmux_session_exists(session_name):
        # No tmux session at all — check SQLite for context
        session = db.get(task_name)
        if session is not None:
            # Stale DB entry — mark as failed
            if session.status == "running":
                db.update_status(task_name, "failed")
            print(
                f"Error: Session '{task_name}' is no longer running "
                f"(tmux session gone, last status: {session.status}).",
                file=sys.stderr,
            )
            print(
                f"  Restart with: ralph-uv run tasks/{task_name}/",
                file=sys.stderr,
            )
        else:
            print(
                f"Error: No session found for task '{task_name}'.",
                file=sys.stderr,
            )
            print(
                f"  Start one with: ralph-uv run tasks/{task_name}/",
                file=sys.stderr,
            )
        return 1

    if not tmux_session_alive(session_name):
        # Session exists (remain-on-exit) but process is dead
        print(
            f"Error: Session '{task_name}' process has exited.",
            file=sys.stderr,
        )
        print(
            "  The tmux pane still has output. Attach to view crash log:",
            file=sys.stderr,
        )
        print(f"  tmux attach -t {session_name}", file=sys.stderr)
        print(
            f"  Then kill it: tmux kill-session -t {session_name}",
            file=sys.stderr,
        )
        return 1

    # Attach to the tmux session
    return tmux_attach_session(session_name)
