"""Attach command: connect to a running ralph-uv tmux session.

Wraps `tmux attach-session` to connect the user's terminal directly to
the agent's TUI (opencode) or output (claude) running in the tmux pane.
"""

from __future__ import annotations

import sys

from ralph_uv.session import (
    SessionDB,
    tmux_attach_session,
    tmux_session_alive,
    tmux_session_exists,
    tmux_session_name,
)


def attach(task_name: str) -> int:
    """Attach to a running ralph-uv tmux session.

    Connects the user's terminal directly to the tmux pane where the
    agent is running. For opencode, this shows the full TUI. For claude,
    this shows the streaming output.

    Args:
        task_name: The task name to attach to.

    Returns:
        Exit code (0 = normal exit, 1 = error).
    """
    session_name = tmux_session_name(task_name)

    if not tmux_session_exists(session_name):
        # No tmux session at all — check SQLite for context
        db = SessionDB()
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
