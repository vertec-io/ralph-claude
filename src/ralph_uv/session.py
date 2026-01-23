"""Session management for ralph-uv.

Provides tmux-based session running with SQLite registry for tracking
multiple concurrent loops. Supports status queries, graceful stop,
and checkpoint/pause operations.
"""

from __future__ import annotations

import json
import os
import signal
import sqlite3
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import libtmux
from libtmux.exc import LibTmuxException

# Default paths
DATA_DIR = Path.home() / ".local" / "share" / "ralph"
DB_PATH = DATA_DIR / "sessions.db"

# Tmux session name prefix to avoid collisions
TMUX_PREFIX = "ralph-"

# Signal file for stop/checkpoint communication
SIGNAL_DIR = DATA_DIR / "signals"


@dataclass
class SessionInfo:
    """Information about a ralph session."""

    task_name: str
    task_dir: str
    pid: int
    tmux_session: str
    agent: str
    status: str  # "running", "stopped", "completed", "failed", "checkpointed"
    started_at: str
    updated_at: str
    iteration: int = 0
    current_story: str = ""
    max_iterations: int = 50

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return asdict(self)


class SessionDB:
    """SQLite registry for ralph sessions.

    Database is stored at ~/.local/share/ralph/sessions.db.
    """

    def __init__(self, db_path: Path | None = None) -> None:
        self.db_path = db_path or DB_PATH
        self._ensure_dir()
        self._init_db()

    def _ensure_dir(self) -> None:
        """Ensure the data directory exists."""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

    def _init_db(self) -> None:
        """Initialize the database schema."""
        with self._connect() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    task_name TEXT PRIMARY KEY,
                    task_dir TEXT NOT NULL,
                    pid INTEGER NOT NULL,
                    tmux_session TEXT NOT NULL,
                    agent TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'running',
                    started_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    iteration INTEGER NOT NULL DEFAULT 0,
                    current_story TEXT NOT NULL DEFAULT '',
                    max_iterations INTEGER NOT NULL DEFAULT 50
                )
            """)

    def _connect(self) -> sqlite3.Connection:
        """Create a database connection."""
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        return conn

    def register(self, session: SessionInfo) -> None:
        """Register a new session or update existing one."""
        with self._connect() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO sessions
                (task_name, task_dir, pid, tmux_session, agent, status,
                 started_at, updated_at, iteration, current_story, max_iterations)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session.task_name,
                    session.task_dir,
                    session.pid,
                    session.tmux_session,
                    session.agent,
                    session.status,
                    session.started_at,
                    session.updated_at,
                    session.iteration,
                    session.current_story,
                    session.max_iterations,
                ),
            )

    def update_status(self, task_name: str, status: str) -> None:
        """Update session status."""
        now = datetime.now().isoformat()
        with self._connect() as conn:
            conn.execute(
                "UPDATE sessions SET status = ?, updated_at = ? WHERE task_name = ?",
                (status, now, task_name),
            )

    def update_progress(
        self, task_name: str, iteration: int, current_story: str
    ) -> None:
        """Update session progress (iteration and current story)."""
        now = datetime.now().isoformat()
        with self._connect() as conn:
            conn.execute(
                """UPDATE sessions
                SET iteration = ?, current_story = ?, updated_at = ?
                WHERE task_name = ?""",
                (iteration, current_story, now, task_name),
            )

    def get(self, task_name: str) -> SessionInfo | None:
        """Get session info by task name."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM sessions WHERE task_name = ?", (task_name,)
            ).fetchone()
            if row is None:
                return None
            return self._row_to_session(row)

    def list_all(self) -> list[SessionInfo]:
        """List all sessions."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM sessions ORDER BY started_at DESC"
            ).fetchall()
            return [self._row_to_session(row) for row in rows]

    def list_running(self) -> list[SessionInfo]:
        """List only running sessions (validates against actual tmux state)."""
        sessions = self.list_all()
        running: list[SessionInfo] = []
        for s in sessions:
            if s.status == "running":
                # Validate tmux session still exists
                if tmux_session_exists(s.tmux_session):
                    running.append(s)
                else:
                    # Stale entry - mark as failed
                    self.update_status(s.task_name, "failed")
        return running

    def remove(self, task_name: str) -> None:
        """Remove a session entry."""
        with self._connect() as conn:
            conn.execute("DELETE FROM sessions WHERE task_name = ?", (task_name,))

    def _row_to_session(self, row: sqlite3.Row) -> SessionInfo:
        """Convert a database row to SessionInfo."""
        return SessionInfo(
            task_name=row["task_name"],
            task_dir=row["task_dir"],
            pid=row["pid"],
            tmux_session=row["tmux_session"],
            agent=row["agent"],
            status=row["status"],
            started_at=row["started_at"],
            updated_at=row["updated_at"],
            iteration=row["iteration"],
            current_story=row["current_story"],
            max_iterations=row["max_iterations"],
        )


# --- Tmux Operations (via libtmux) ---


def _get_server() -> libtmux.Server:
    """Get a libtmux Server instance."""
    return libtmux.Server()


def tmux_session_exists(session_name: str) -> bool:
    """Check if a tmux session exists."""
    try:
        server = _get_server()
        matches = server.sessions.filter(session_name=session_name)
        return len(matches) > 0
    except LibTmuxException:
        return False


def tmux_session_alive(session_name: str) -> bool:
    """Check if a tmux session exists AND its pane process is still running.

    With remain-on-exit, the session stays around after the process dies.
    This checks pane_dead_status: None means alive, a value means exited.
    """
    try:
        server = _get_server()
        matches = server.sessions.filter(session_name=session_name)
        if not matches:
            return False
        session = matches[0]
        pane = session.active_window.active_pane
        if pane is None:
            return False
        # pane_dead_status is None when alive, exit code (int) when dead
        return pane.pane_dead_status is None
    except (LibTmuxException, AttributeError):
        return False


def tmux_create_session(
    session_name: str,
    command: str,
    cwd: str,
    *,
    environment: dict[str, str] | None = None,
    width: int = 200,
    height: int = 50,
) -> int:
    """Create a new detached tmux session running the given command.

    Args:
        session_name: Name for the tmux session.
        command: Shell command string to run in the session.
        cwd: Working directory for the session.
        environment: Environment variables to set in the session.
        width: Terminal width (default 200).
        height: Terminal height (default 50).

    Returns:
        The PID of the process running in the tmux pane.
    """
    import shlex

    server = _get_server()

    # Build the shell command with env vars as inline prefix.
    # tmux's window_command is run through the default shell, so
    # `KEY=value command args` works natively.
    if environment:
        exports = " ".join(f"{k}={shlex.quote(v)}" for k, v in environment.items())
        shell_cmd = f"{exports} {command}"
    else:
        shell_cmd = command

    session = server.new_session(
        session_name=session_name,
        start_directory=cwd,
        window_command=shell_cmd,
        attach=False,
        x=width,
        y=height,
    )

    # Keep the pane open if the process exits, so crash output is visible
    session.set_option("remain-on-exit", "on")

    pane = session.active_window.active_pane
    if pane is not None:
        pid_str = pane.pane_pid
        if pid_str:
            return int(pid_str)
    return os.getpid()


def tmux_kill_session(session_name: str) -> None:
    """Kill a tmux session."""
    try:
        server = _get_server()
        matches = server.sessions.filter(session_name=session_name)
        if matches:
            matches[0].kill()
    except LibTmuxException:
        pass


def tmux_list_sessions() -> list[str]:
    """List all tmux sessions with the ralph prefix."""
    try:
        server = _get_server()
        return [
            s.session_name
            for s in server.sessions
            if s.session_name and s.session_name.startswith(TMUX_PREFIX)
        ]
    except LibTmuxException:
        return []


def tmux_attach_session(session_name: str) -> int:
    """Attach to a tmux session (takes over terminal).

    Returns the exit code from tmux attach.
    """
    result = subprocess.run(["tmux", "attach-session", "-t", session_name])
    return result.returncode


# --- Signal File Operations ---


def get_signal_path(task_name: str) -> Path:
    """Get the signal file path for a task."""
    SIGNAL_DIR.mkdir(parents=True, exist_ok=True)
    return SIGNAL_DIR / f"{task_name}.signal"


def write_signal(task_name: str, signal_type: str) -> None:
    """Write a signal file for the given task.

    Signal types: "stop", "checkpoint"
    """
    signal_path = get_signal_path(task_name)
    data = {
        "type": signal_type,
        "timestamp": datetime.now().isoformat(),
    }
    signal_path.write_text(json.dumps(data))


def read_signal(task_name: str) -> dict[str, str] | None:
    """Read and consume a signal file. Returns None if no signal."""
    signal_path = get_signal_path(task_name)
    if not signal_path.is_file():
        return None
    try:
        data: dict[str, str] = json.loads(signal_path.read_text())
        signal_path.unlink()  # Consume the signal
        return data
    except (json.JSONDecodeError, OSError):
        return None


def clear_signal(task_name: str) -> None:
    """Clear any pending signal for a task."""
    signal_path = get_signal_path(task_name)
    if signal_path.is_file():
        signal_path.unlink()


# --- Task Name Utilities ---


def task_name_from_dir(task_dir: Path) -> str:
    """Extract task name from task directory path.

    e.g., /path/to/tasks/my-feature -> my-feature
    """
    return task_dir.name


def tmux_session_name(task_name: str) -> str:
    """Generate tmux session name from task name."""
    return f"{TMUX_PREFIX}{task_name}"


# --- High-Level Session Operations ---


def start_session(
    task_dir: Path,
    agent: str,
    max_iterations: int,
    base_branch: str | None = None,
    db: SessionDB | None = None,
) -> SessionInfo:
    """Start a new ralph session in tmux.

    Creates a tmux session running ralph-uv run for the given task,
    and registers it in the session database.
    """
    if db is None:
        db = SessionDB()

    task_name = task_name_from_dir(task_dir)
    session_name = tmux_session_name(task_name)

    # Check for existing session
    if tmux_session_exists(session_name):
        existing = db.get(task_name)
        if existing and existing.status == "running":
            raise SessionError(
                f"Session already running for task '{task_name}'. "
                f"Use 'ralph-uv stop {task_name}' first."
            )
        # Stale session - clean up
        tmux_kill_session(session_name)

    # Build the ralph-uv run command for inside tmux
    import shlex

    cmd_parts: list[str] = [
        sys.executable,
        "-m",
        "ralph_uv.cli",
        "run",
        str(task_dir),
        "--max-iterations",
        str(max_iterations),
    ]
    if agent:
        cmd_parts.extend(["--agent", agent])
    if base_branch:
        cmd_parts.extend(["--base-branch", base_branch])

    cmd_str = shlex.join(cmd_parts)

    # Create tmux session
    cwd = str(task_dir.parent.parent)  # Project root
    pid = tmux_create_session(
        session_name,
        cmd_str,
        cwd,
        environment={"RALPH_TMUX_SESSION": session_name},
    )

    # Register in database
    now = datetime.now().isoformat()
    session = SessionInfo(
        task_name=task_name,
        task_dir=str(task_dir),
        pid=pid,
        tmux_session=session_name,
        agent=agent or "claude",
        status="running",
        started_at=now,
        updated_at=now,
        iteration=0,
        current_story="",
        max_iterations=max_iterations,
    )
    db.register(session)
    clear_signal(task_name)

    return session


def stop_session(task_name: str, db: SessionDB | None = None) -> bool:
    """Send stop signal to a running session.

    Returns True if the signal was sent successfully.
    """
    if db is None:
        db = SessionDB()

    session = db.get(task_name)
    if session is None:
        print(f"Error: No session found for task '{task_name}'", file=sys.stderr)
        return False

    if session.status != "running":
        print(
            f"Error: Session '{task_name}' is not running (status: {session.status})",
            file=sys.stderr,
        )
        return False

    # Write stop signal file
    write_signal(task_name, "stop")

    # Also send SIGINT to the process as a backup
    try:
        os.kill(session.pid, signal.SIGINT)
    except (OSError, ProcessLookupError):
        pass  # Process may already be gone

    print(f"Stop signal sent to session '{task_name}'")
    return True


def checkpoint_session(task_name: str, db: SessionDB | None = None) -> bool:
    """Send checkpoint signal to a running session.

    The session will save state and pause after the current iteration.
    Returns True if the signal was sent successfully.
    """
    if db is None:
        db = SessionDB()

    session = db.get(task_name)
    if session is None:
        print(f"Error: No session found for task '{task_name}'", file=sys.stderr)
        return False

    if session.status != "running":
        print(
            f"Error: Session '{task_name}' is not running (status: {session.status})",
            file=sys.stderr,
        )
        return False

    # Write checkpoint signal file
    write_signal(task_name, "checkpoint")
    print(f"Checkpoint signal sent to session '{task_name}'")
    return True


def cleanup_session(task_name: str, status: str, db: SessionDB | None = None) -> None:
    """Clean up a session on completion or crash.

    Updates the database status and optionally kills the tmux session.
    """
    if db is None:
        db = SessionDB()

    session = db.get(task_name)
    if session is None:
        return

    # Kill tmux session if it's still running
    if tmux_session_exists(session.tmux_session):
        tmux_kill_session(session.tmux_session)

    # Update status in database
    db.update_status(task_name, status)

    # Clear any pending signals
    clear_signal(task_name)


def get_status(as_json: bool = False, db: SessionDB | None = None) -> str:
    """Get status of all sessions.

    Returns formatted string for display, or JSON if as_json=True.
    """
    if db is None:
        db = SessionDB()

    sessions = db.list_all()

    # Validate running sessions against tmux
    for s in sessions:
        if s.status == "running" and not tmux_session_exists(s.tmux_session):
            db.update_status(s.task_name, "failed")
            s.status = "failed"

    if as_json:
        return json.dumps([s.to_dict() for s in sessions], indent=2)

    if not sessions:
        return "No sessions found."

    lines: list[str] = []
    lines.append(f"{'Task':<30} {'Status':<14} {'Agent':<10} {'Iter':<8} {'Story'}")
    lines.append("-" * 80)

    for s in sessions:
        iter_str = f"{s.iteration}/{s.max_iterations}"
        story = s.current_story or "-"
        lines.append(
            f"{s.task_name:<30} {s.status:<14} {s.agent:<10} {iter_str:<8} {story}"
        )

    return "\n".join(lines)


class SessionError(Exception):
    """Raised when a session operation fails."""
