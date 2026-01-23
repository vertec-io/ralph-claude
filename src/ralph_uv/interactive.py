"""Interactive agent control mode for ralph-uv.

Provides the ability to pause the autonomous loop, interact directly with
the agent (Claude Code or OpenCode) via PTY, and resume autonomous operation
without triggering a false iteration completion.

When interactive mode is enabled:
- Completion detection (both <promise>COMPLETE</promise> and signal files) is suppressed
- User keystrokes are forwarded directly to the agent PTY
- The agent continues processing user input normally

When interactive mode is disabled:
- Completion detection resumes
- Agent output is captured for autonomous processing
"""

from __future__ import annotations

import os
import pty
import select
import subprocess
import sys
import termios
import tty
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ralph_uv.agents import COMPLETION_SIGNAL

# Escape key byte
ESC_KEY = b"\x1b"

# Default PTY read buffer size
PTY_BUFFER_SIZE = 4096


@dataclass
class InteractiveState:
    """Tracks the interactive mode state for a running agent."""

    enabled: bool = False
    pty_master_fd: int | None = None
    pty_slave_fd: int | None = None
    process: subprocess.Popen[bytes] | None = None
    output_buffer: list[str] = field(default_factory=list)
    _suppress_completion: bool = False
    _original_termios: list[Any] | None = None

    @property
    def suppress_completion(self) -> bool:
        """Whether completion detection should be suppressed."""
        return self.enabled or self._suppress_completion

    def enable(self) -> None:
        """Enable interactive mode."""
        self.enabled = True
        self._suppress_completion = True

    def disable(self) -> None:
        """Disable interactive mode.

        Completion detection resumes but any signals received during
        interactive mode are discarded.
        """
        self.enabled = False
        # Brief suppression period to avoid stale completions
        self._suppress_completion = False


class PtyAgent:
    """Manages an agent subprocess via a PTY for interactive control.

    Instead of using stdin/stdout pipes (which don't support interactive
    terminal features), this spawns the agent with a real PTY. This allows:
    - Sending Esc key to interrupt the agent
    - Forwarding user keystrokes for direct interaction
    - Capturing output in real-time for both autonomous and interactive modes
    """

    def __init__(self) -> None:
        self._master_fd: int | None = None
        self._slave_fd: int | None = None
        self._process: subprocess.Popen[bytes] | None = None
        self._output_lines: list[str] = []
        self._raw_output: bytes = b""

    @property
    def master_fd(self) -> int | None:
        """The master PTY file descriptor for reading/writing."""
        return self._master_fd

    @property
    def process(self) -> subprocess.Popen[bytes] | None:
        """The underlying subprocess."""
        return self._process

    @property
    def output(self) -> str:
        """All captured output so far."""
        return self._raw_output.decode("utf-8", errors="replace")

    def start(
        self,
        cmd: list[str],
        env: dict[str, str],
        cwd: Path,
        stdin_file: int | None = None,
    ) -> None:
        """Start the agent with a PTY.

        Args:
            cmd: The command to run (e.g., ["claude", "--print", ...]).
            env: Environment variables for the subprocess.
            cwd: Working directory for the subprocess.
            stdin_file: Optional file descriptor to use for stdin instead of
                the PTY. When provided, the PTY is only used for stdout/stderr,
                allowing pipe-based prompt delivery while retaining PTY output
                capture for interactive mode.
        """
        # Create a PTY pair
        self._master_fd, self._slave_fd = pty.openpty()

        # Use stdin_file for stdin if provided (pipe-based prompt delivery),
        # otherwise use PTY slave for full PTY stdin/stdout/stderr
        stdin_fd = stdin_file if stdin_file is not None else self._slave_fd

        self._process = subprocess.Popen(
            cmd,
            stdin=stdin_fd,
            stdout=self._slave_fd,
            stderr=self._slave_fd,
            env=env,
            cwd=str(cwd),
            start_new_session=True,
        )

        # Close slave fd in parent process (child has its own copy)
        os.close(self._slave_fd)
        self._slave_fd = None

    def write_input(self, data: bytes) -> None:
        """Write data to the agent's PTY input.

        Args:
            data: Raw bytes to send to the agent (keystrokes, etc.)
        """
        if self._master_fd is not None:
            os.write(self._master_fd, data)

    def write_prompt(self, prompt: str) -> None:
        """Write the prompt text to the agent's stdin via PTY.

        Args:
            prompt: The prompt text to send to the agent.
        """
        if self._master_fd is not None:
            # Send prompt as if typed, followed by EOF signal
            os.write(self._master_fd, prompt.encode("utf-8"))
            # Send Ctrl+D (EOF) to signal end of input
            os.write(self._master_fd, b"\x04")

    def send_escape(self) -> None:
        """Send Escape key to the agent to interrupt/pause it."""
        self.write_input(ESC_KEY)

    def read_available(self, timeout: float = 0.1) -> bytes:
        """Read any available output from the PTY (non-blocking).

        Args:
            timeout: How long to wait for data (seconds).

        Returns:
            Raw bytes read from the PTY, or empty bytes if nothing available.
        """
        if self._master_fd is None:
            return b""

        try:
            ready, _, _ = select.select([self._master_fd], [], [], timeout)
            if ready:
                data = os.read(self._master_fd, PTY_BUFFER_SIZE)
                self._raw_output += data
                return data
        except (OSError, ValueError):
            pass

        return b""

    def is_done(self) -> bool:
        """Check if the agent process has terminated."""
        if self._process is None:
            return True
        return self._process.poll() is not None

    def terminate(self, timeout: float = 10.0) -> None:
        """Gracefully terminate the agent process."""
        if self._process is None:
            return

        if self._process.poll() is None:
            self._process.terminate()
            try:
                self._process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait()

    def cleanup(self) -> None:
        """Clean up PTY file descriptors."""
        if self._master_fd is not None:
            try:
                os.close(self._master_fd)
            except OSError:
                pass
            self._master_fd = None

        if self._slave_fd is not None:
            try:
                os.close(self._slave_fd)
            except OSError:
                pass
            self._slave_fd = None

    @property
    def exit_code(self) -> int:
        """The process exit code, or -1 if still running."""
        if self._process is None:
            return -1
        code = self._process.poll()
        return code if code is not None else -1


class InteractiveController:
    """Controls the interactive mode toggle and PTY forwarding.

    This controller manages the lifecycle of interactive sessions:
    1. When toggled ON: sends Esc to agent, sets up user keystroke forwarding
    2. While ON: forwards stdin to agent PTY, forwards agent output to stdout
    3. When toggled OFF: re-enables completion detection, stops forwarding

    The controller works with both the attach command (direct terminal) and
    the TUI (via RPC-mediated commands).
    """

    def __init__(self, pty_agent: PtyAgent) -> None:
        self._pty_agent = pty_agent
        self._state = InteractiveState()
        self._original_termios: list[Any] | None = None

    @property
    def state(self) -> InteractiveState:
        """The current interactive state."""
        return self._state

    @property
    def is_interactive(self) -> bool:
        """Whether interactive mode is currently enabled."""
        return self._state.enabled

    @property
    def suppress_completion(self) -> bool:
        """Whether completion detection should be suppressed."""
        return self._state.suppress_completion

    def toggle(self) -> bool:
        """Toggle interactive mode on/off.

        When toggling ON:
        - Sends Esc key to the agent to interrupt it
        - Enables user keystroke forwarding

        When toggling OFF:
        - Re-enables completion detection
        - Agent continues from wherever user left it

        Returns:
            The new interactive mode state (True = interactive, False = autonomous).
        """
        if self._state.enabled:
            self._disable_interactive()
        else:
            self._enable_interactive()
        return self._state.enabled

    def set_mode(self, enabled: bool) -> None:
        """Set interactive mode to a specific state.

        Args:
            enabled: True to enable interactive mode, False to disable.
        """
        if enabled and not self._state.enabled:
            self._enable_interactive()
        elif not enabled and self._state.enabled:
            self._disable_interactive()

    def forward_input(self, data: bytes) -> None:
        """Forward user input to the agent PTY.

        Only effective when interactive mode is enabled.

        Args:
            data: Raw bytes from user input to forward.
        """
        if self._state.enabled:
            self._pty_agent.write_input(data)

    def check_output(self, timeout: float = 0.05) -> bytes:
        """Check for and return any agent output.

        In both interactive and autonomous mode, this reads from the PTY.
        The caller decides what to do with the output based on mode.

        Args:
            timeout: How long to wait for data.

        Returns:
            Raw bytes of agent output.
        """
        return self._pty_agent.read_available(timeout)

    def should_detect_completion(self, output: str) -> bool:
        """Check if completion should be detected in the given output.

        Args:
            output: The output text to check for completion signals.

        Returns:
            True if completion signal was found AND mode allows detection.
        """
        if self._state.suppress_completion:
            return False
        return COMPLETION_SIGNAL in output

    def setup_terminal_raw_mode(self) -> None:
        """Set terminal to raw mode for direct keystroke capture.

        Only call this when the user has a direct terminal connection
        (e.g., attach command). Not needed for RPC-mediated interaction.
        """
        if sys.stdin.isatty():
            self._original_termios = termios.tcgetattr(sys.stdin.fileno())
            tty.setraw(sys.stdin.fileno())

    def restore_terminal(self) -> None:
        """Restore terminal to its original mode."""
        if self._original_termios is not None and sys.stdin.isatty():
            termios.tcsetattr(
                sys.stdin.fileno(), termios.TCSADRAIN, self._original_termios
            )
            self._original_termios = None

    def _enable_interactive(self) -> None:
        """Enable interactive mode: pause agent, start forwarding."""
        # Send Esc to interrupt the agent
        self._pty_agent.send_escape()
        self._state.enable()

    def _disable_interactive(self) -> None:
        """Disable interactive mode: resume autonomous operation."""
        self._state.disable()
