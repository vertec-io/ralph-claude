"""Agent abstraction layer for ralph-uv.

Provides a pluggable interface for running different coding agents (Claude Code,
OpenCode) with agent-specific completion detection and failover logic.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from abc import ABC, abstractmethod
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ralph_uv.interactive import InteractiveController, PtyAgent


COMPLETION_SIGNAL = "<promise>COMPLETE</promise>"
VALID_AGENTS = ("claude", "opencode")


@dataclass
class AgentResult:
    """Result of a single agent run."""

    output: str
    exit_code: int
    duration_seconds: float
    completed: bool = False
    failed: bool = False
    error_message: str = ""


@dataclass
class AgentConfig:
    """Configuration for agent execution."""

    prompt: str
    working_dir: Path
    yolo_mode: bool = False
    verbose: bool = False
    model: str = ""
    interactive_mode: bool = False


class Agent(ABC):
    """Abstract base class for coding agents.

    Subclasses implement the specific invocation and output parsing for each
    supported agent (Claude Code, OpenCode, etc.).
    """

    @abstractmethod
    def start(self, config: AgentConfig) -> subprocess.Popen[str]:
        """Start the agent subprocess.

        Args:
            config: Agent execution configuration including prompt and working dir.

        Returns:
            The running subprocess handle.
        """
        ...

    @abstractmethod
    def is_done(self, process: subprocess.Popen[str]) -> bool:
        """Check if the agent process has completed.

        Args:
            process: The running agent subprocess.

        Returns:
            True if the process has terminated.
        """
        ...

    @abstractmethod
    def get_output(self, process: subprocess.Popen[str]) -> AgentResult:
        """Get the result after the agent has completed.

        Blocks until the process terminates if it hasn't already, then
        parses the output into a structured result.

        Args:
            process: The agent subprocess (may still be running).

        Returns:
            Structured result with output, exit code, and completion status.
        """
        ...

    @property
    @abstractmethod
    def name(self) -> str:
        """The agent's identifier name."""
        ...

    def run(self, config: AgentConfig) -> AgentResult:
        """Convenience method: start agent, wait for completion, return result.

        Writes the prompt to the process stdin, waits for completion, and
        returns the structured result.

        Args:
            config: Agent execution configuration.

        Returns:
            Structured result from the agent run.
        """
        start_time = time.time()
        try:
            process = self.start(config)
            # Write prompt to stdin and close it
            if process.stdin is not None:
                process.stdin.write(config.prompt)
                process.stdin.close()
            # Wait for completion
            while not self.is_done(process):
                time.sleep(0.1)
            result = self.get_output(process)
            result.duration_seconds = time.time() - start_time
            return result
        except OSError as e:
            return AgentResult(
                output="",
                exit_code=1,
                duration_seconds=time.time() - start_time,
                failed=True,
                error_message=f"Failed to start agent: {e}",
            )

    def build_pty_command(self, config: AgentConfig) -> list[str]:
        """Build the command for PTY-based execution.

        Subclasses should override this if their PTY command differs
        from the pipe-based command.

        Args:
            config: Agent execution configuration.

        Returns:
            The command list for PTY execution.
        """
        # Default: same as pipe-based command
        return self._build_command_list(config)

    def build_pty_env(self, config: AgentConfig) -> dict[str, str]:
        """Build the environment for PTY-based execution.

        Args:
            config: Agent execution configuration.

        Returns:
            Environment variables dict.
        """
        return os.environ.copy()

    def _build_command_list(self, config: AgentConfig) -> list[str]:
        """Build the base command list. Subclasses should override."""
        return []

    def run_with_pty(
        self,
        config: AgentConfig,
        pty_agent: PtyAgent,
        interactive_controller: InteractiveController,
    ) -> AgentResult:
        """Run the agent with PTY support for interactive control.

        This alternative to run() uses a PTY instead of pipes, enabling
        interactive mode toggling. The InteractiveController manages the
        lifecycle of interactive sessions.

        Args:
            config: Agent execution configuration.
            pty_agent: The PTY agent manager.
            interactive_controller: Controller for interactive mode.

        Returns:
            Structured result from the agent run.
        """
        start_time = time.time()
        try:
            cmd = self.build_pty_command(config)
            env = self.build_pty_env(config)
            pty_agent.start(cmd, env, config.working_dir)

            # Write prompt to the PTY
            pty_agent.write_prompt(config.prompt)

            # Main loop: read output, check completion
            while not pty_agent.is_done():
                output_bytes = interactive_controller.check_output(timeout=0.2)

                if output_bytes and not interactive_controller.is_interactive:
                    # In autonomous mode, check for completion
                    text = output_bytes.decode("utf-8", errors="replace")
                    if interactive_controller.should_detect_completion(text):
                        pty_agent.terminate()
                        break

                # Small sleep to prevent busy-waiting
                if not output_bytes:
                    time.sleep(0.05)

            output = pty_agent.output
            exit_code = pty_agent.exit_code
            completed = (
                COMPLETION_SIGNAL in output
                and not interactive_controller.suppress_completion
            )
            failed = self._detect_failure(exit_code, output, "")
            error_message = ""
            if failed:
                error_message = self._extract_error(exit_code, output, "")

            return AgentResult(
                output=output,
                exit_code=exit_code,
                duration_seconds=time.time() - start_time,
                completed=completed,
                failed=failed,
                error_message=error_message,
            )
        except OSError as e:
            return AgentResult(
                output="",
                exit_code=1,
                duration_seconds=time.time() - start_time,
                failed=True,
                error_message=f"Failed to start agent with PTY: {e}",
            )
        finally:
            pty_agent.cleanup()

    def _detect_failure(self, exit_code: int, output: str, stderr: str) -> bool:
        """Common failure detection logic shared by all agents."""
        if exit_code != 0:
            return True
        if not output.strip():
            return True

        error_patterns = [
            r"API error",
            r"rate limit",
            r"quota exceeded",
            r"authentication failed",
            r"Connection refused",
            r"timeout",
            r"\b503\b",
            r"\b502\b",
            r"\b429\b",
            r"overloaded",
        ]
        for pattern in error_patterns:
            if re.search(pattern, output, re.IGNORECASE):
                return True

        return False

    def _extract_error(self, exit_code: int, output: str, stderr: str) -> str:
        """Extract a concise error message from agent output."""
        if exit_code != 0:
            if stderr.strip():
                lines = stderr.strip().splitlines()
                return f"Exit code {exit_code}: {lines[-1][:100]}"
            return f"Exit code {exit_code}"

        if not output.strip():
            return "Empty output"

        for line in output.splitlines():
            if re.search(r"error|failed|timeout|refused", line, re.IGNORECASE):
                return line[:100]

        return "Unknown error"


class ClaudeAgent(Agent):
    """Agent implementation for Claude Code CLI.

    Invokes `claude --print --output-format stream-json` with the prompt
    provided via stdin. Parses stream-json output to extract the result.
    """

    @property
    def name(self) -> str:
        return "claude"

    def start(self, config: AgentConfig) -> subprocess.Popen[str]:
        """Start Claude Code as a subprocess."""
        cmd = self._build_command(config)
        env = self._build_env(config)

        return subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            cwd=str(config.working_dir),
        )

    def is_done(self, process: subprocess.Popen[str]) -> bool:
        """Check if Claude process has terminated."""
        return process.poll() is not None

    def get_output(self, process: subprocess.Popen[str]) -> AgentResult:
        """Wait for Claude to finish and parse the result."""
        stdout, stderr = process.communicate()
        exit_code = process.returncode

        output = self._parse_stream_json(stdout)
        completed = COMPLETION_SIGNAL in output
        failed = self._detect_failure(exit_code, output, stderr)
        error_message = ""
        if failed:
            error_message = self._extract_error(exit_code, output, stderr)

        return AgentResult(
            output=output,
            exit_code=exit_code,
            duration_seconds=0,  # Set by run()
            completed=completed,
            failed=failed,
            error_message=error_message,
        )

    def _build_command(self, config: AgentConfig) -> list[str]:
        """Build the claude CLI command.

        Uses --print mode which reads the prompt from stdin when piped.
        """
        cmd = ["claude", "--print", "--output-format", "stream-json"]

        if config.yolo_mode:
            cmd.append("--dangerously-skip-permissions")

        if config.verbose:
            cmd.append("--verbose")

        return cmd

    def _build_command_list(self, config: AgentConfig) -> list[str]:
        """Build command list (used by PTY execution)."""
        return self._build_command(config)

    def build_pty_command(self, config: AgentConfig) -> list[str]:
        """Build PTY command for Claude.

        In PTY mode, we use --print which accepts prompt from stdin.
        The prompt is delivered via a pipe (stdin_file), not the PTY.
        """
        return self._build_command(config)

    @contextmanager
    def _prompt_as_fd(self, prompt: str) -> Generator[int, None, None]:
        """Write prompt to a temp file and yield a readable fd for it.

        This allows passing the prompt to claude --print via stdin as a pipe,
        which is required because claude --print won't read from a TTY stdin.

        Args:
            prompt: The prompt text.

        Yields:
            A file descriptor open for reading with the prompt content.
        """
        tmp = tempfile.NamedTemporaryFile(
            mode="w", prefix="ralph-prompt-", suffix=".txt", delete=False
        )
        try:
            tmp.write(prompt)
            tmp.close()
            fd = os.open(tmp.name, os.O_RDONLY)
            try:
                yield fd
            finally:
                os.close(fd)
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass

    def run_with_pty(
        self,
        config: AgentConfig,
        pty_agent: PtyAgent,
        interactive_controller: InteractiveController,
    ) -> AgentResult:
        """Run Claude with PTY for output capture but pipe-based prompt delivery.

        Claude --print requires a piped stdin (not a TTY) to read the prompt.
        We write the prompt to a temp file, open it as a file descriptor, and
        pass it as stdin_file to the PTY agent. The PTY is only used for
        stdout/stderr, enabling interactive mode toggling.
        """
        start_time = time.time()
        try:
            cmd = self.build_pty_command(config)
            env = self.build_pty_env(config)

            with self._prompt_as_fd(config.prompt) as prompt_fd:
                pty_agent.start(cmd, env, config.working_dir, stdin_file=prompt_fd)

                # Main loop: read output, check completion
                while not pty_agent.is_done():
                    output_bytes = interactive_controller.check_output(timeout=0.2)

                    if output_bytes and not interactive_controller.is_interactive:
                        # In autonomous mode, check for completion
                        text = output_bytes.decode("utf-8", errors="replace")
                        if interactive_controller.should_detect_completion(text):
                            pty_agent.terminate()
                            break

                    # Small sleep to prevent busy-waiting
                    if not output_bytes:
                        time.sleep(0.05)

            output = pty_agent.output
            exit_code = pty_agent.exit_code
            completed = (
                COMPLETION_SIGNAL in output
                and not interactive_controller.suppress_completion
            )
            failed = self._detect_failure(exit_code, output, "")
            error_message = ""
            if failed:
                error_message = self._extract_error(exit_code, output, "")

            return AgentResult(
                output=output,
                exit_code=exit_code,
                duration_seconds=time.time() - start_time,
                completed=completed,
                failed=failed,
                error_message=error_message,
            )
        except OSError as e:
            return AgentResult(
                output="",
                exit_code=1,
                duration_seconds=time.time() - start_time,
                failed=True,
                error_message=f"Failed to start Claude with PTY: {e}",
            )
        finally:
            pty_agent.cleanup()

    def _build_env(self, config: AgentConfig) -> dict[str, str]:
        """Build the environment for Claude subprocess."""
        env = os.environ.copy()
        if config.model:
            # Claude CLI doesn't support model selection, but log awareness
            env["RALPH_MODEL_OVERRIDE"] = config.model
        return env

    def build_pty_env(self, config: AgentConfig) -> dict[str, str]:
        """Build PTY environment for Claude."""
        return self._build_env(config)

    def _parse_stream_json(self, raw_output: str) -> str:
        """Parse stream-json output to extract the result text."""
        for line in raw_output.splitlines():
            if '"type":"result"' in line or '"type": "result"' in line:
                try:
                    data: dict[str, Any] = json.loads(line)
                    result = data.get("result", "")
                    if result:
                        return str(result)
                except json.JSONDecodeError:
                    continue

        # Fall back to raw output
        return raw_output


class OpencodeAgent(Agent):
    """Agent implementation for OpenCode CLI with signal-file based completion.

    Uses the ralph-hook plugin to detect when opencode finishes processing.
    The plugin writes a signal file when the session.idle event fires.
    This agent watches the signal file via inotify (Linux) or polling for
    changes, providing reliable completion detection without polling the
    process stdout.

    Plugin deployment:
    - Copies the bundled plugin to .opencode/plugins/ in the working directory
    - Sets RALPH_SIGNAL_FILE env var pointing to a temp signal file
    - Watches the signal file for changes using inotify (Linux) or stat polling

    Completion detection:
    - Primary: signal file written by plugin (session.idle event)
    - Fallback: process exit (handles plugin load failure gracefully)
    - Interactive mode: completion detection suppressed until mode exits
    """

    # Path to the bundled plugin relative to this file
    _PLUGIN_DIR = (
        Path(__file__).parent.parent.parent / "plugins" / "opencode-ralph-hook"
    )

    def __init__(self) -> None:
        self._signal_file: Path | None = None
        self._signal_dir: Path | None = None
        self._inotify_fd: int | None = None
        self._watch_fd: int | None = None

    @property
    def name(self) -> str:
        return "opencode"

    def start(self, config: AgentConfig) -> subprocess.Popen[str]:
        """Start OpenCode as a subprocess with plugin deployment."""
        # Set up signal file for completion detection
        self._setup_signal_file()

        # Deploy plugin to working directory
        self._deploy_plugin(config.working_dir)

        cmd = self._build_command(config)
        env = self._build_env(config)

        return subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            cwd=str(config.working_dir),
        )

    def is_done(self, process: subprocess.Popen[str]) -> bool:
        """Check if OpenCode process has terminated or signaled idle."""
        # Process exited - always done
        if process.poll() is not None:
            return True

        # Check signal file for idle signal (primary detection)
        if self._check_signal_file():
            return True

        return False

    def get_output(self, process: subprocess.Popen[str]) -> AgentResult:
        """Wait for OpenCode to finish and parse the result."""
        stdout, stderr = process.communicate()
        exit_code = process.returncode

        output = self._parse_output(stdout)
        completed = COMPLETION_SIGNAL in output
        failed = self._detect_failure(exit_code, output, stderr)
        error_message = ""
        if failed:
            error_message = self._extract_error(exit_code, output, stderr)

        # Clean up signal infrastructure
        self._cleanup_signal()

        return AgentResult(
            output=output,
            exit_code=exit_code,
            duration_seconds=0,  # Set by run()
            completed=completed,
            failed=failed,
            error_message=error_message,
        )

    def run(self, config: AgentConfig) -> AgentResult:
        """Run opencode with signal-file based completion detection.

        Overrides base run() to add interactive_mode awareness:
        - When interactive_mode is True, signal file writes are ignored
        - When interactive_mode becomes False, detection resumes
        """
        start_time = time.time()
        try:
            process = self.start(config)
            # Write prompt to stdin and close it
            if process.stdin is not None:
                process.stdin.write(config.prompt)
                process.stdin.close()

            # Wait for completion, respecting interactive_mode
            while True:
                if process.poll() is not None:
                    break

                if not config.interactive_mode:
                    if self._check_signal_file():
                        # Signal received - agent finished processing
                        # Terminate the process gracefully
                        process.terminate()
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
                        break
                else:
                    # Interactive mode: consume and discard any signal file
                    # writes to prevent stale signals on mode exit
                    self._discard_signal_file()

                time.sleep(0.2)

            result = self.get_output(process)
            result.duration_seconds = time.time() - start_time
            return result
        except OSError as e:
            self._cleanup_signal()
            return AgentResult(
                output="",
                exit_code=1,
                duration_seconds=time.time() - start_time,
                failed=True,
                error_message=f"Failed to start agent: {e}",
            )

    def _setup_signal_file(self) -> None:
        """Create a temporary directory and signal file path for this run."""
        self._signal_dir = Path(tempfile.mkdtemp(prefix="ralph-opencode-"))
        self._signal_file = self._signal_dir / "idle.signal"

    def _check_signal_file(self) -> bool:
        """Check if the signal file has been written (idle event received)."""
        if self._signal_file is None:
            return False
        return self._signal_file.exists()

    def _discard_signal_file(self) -> None:
        """Remove signal file if it exists (consumed during interactive mode)."""
        if self._signal_file is not None and self._signal_file.exists():
            try:
                self._signal_file.unlink()
            except OSError:
                pass

    def _cleanup_signal(self) -> None:
        """Clean up signal file and temporary directory."""
        if self._signal_dir is not None:
            try:
                shutil.rmtree(str(self._signal_dir), ignore_errors=True)
            except OSError:
                pass
            self._signal_dir = None
            self._signal_file = None

    def _deploy_plugin(self, working_dir: Path) -> None:
        """Deploy the ralph-hook plugin to the working directory.

        Copies the built plugin (dist/) to .opencode/plugins/ralph-hook/
        in the working directory so opencode loads it on startup.

        Falls back gracefully if the plugin dist doesn't exist (plugin
        hasn't been built yet).
        """
        plugin_dist = self._PLUGIN_DIR / "dist"
        if not plugin_dist.is_dir():
            # Plugin not built - try global installation fallback
            return

        target_dir = working_dir / ".opencode" / "plugins" / "ralph-hook"
        target_dir.mkdir(parents=True, exist_ok=True)

        # Copy dist files
        for item in plugin_dist.iterdir():
            dest = target_dir / item.name
            if item.is_file():
                shutil.copy2(str(item), str(dest))

        # Copy package.json for module resolution
        pkg_json = self._PLUGIN_DIR / "package.json"
        if pkg_json.is_file():
            shutil.copy2(str(pkg_json), str(target_dir / "package.json"))

    def _build_command(self, config: AgentConfig) -> list[str]:
        """Build the opencode CLI command."""
        cmd = ["opencode", "run"]

        if config.model:
            cmd.extend(["--model", config.model])

        if config.verbose:
            cmd.extend(["--print-logs", "--log-level", "DEBUG"])

        return cmd

    def _build_command_list(self, config: AgentConfig) -> list[str]:
        """Build command list (used by PTY execution)."""
        return self._build_command(config)

    def build_pty_command(self, config: AgentConfig) -> list[str]:
        """Build PTY command for OpenCode."""
        return self._build_command(config)

    def _build_env(self, config: AgentConfig) -> dict[str, str]:
        """Build the environment for OpenCode subprocess.

        Sets RALPH_SIGNAL_FILE so the plugin knows where to write the
        idle signal. Also sets RALPH_SESSION_ID for signal identification.
        """
        env = os.environ.copy()

        # Signal file for the plugin
        if self._signal_file is not None:
            env["RALPH_SIGNAL_FILE"] = str(self._signal_file)
            env["RALPH_SESSION_ID"] = str(os.getpid())

        if config.yolo_mode:
            env["OPENCODE_PERMISSION"] = (
                '{"*": "allow", "external_directory": "allow", "doom_loop": "allow"}'
            )

        if config.verbose:
            env["RALPH_DEBUG"] = "1"

        return env

    def build_pty_env(self, config: AgentConfig) -> dict[str, str]:
        """Build PTY environment for OpenCode.

        Sets up signal file and deploys plugin for PTY mode too.
        """
        self._setup_signal_file()
        return self._build_env(config)

    def run_with_pty(
        self,
        config: AgentConfig,
        pty_agent: PtyAgent,
        interactive_controller: InteractiveController,
    ) -> AgentResult:
        """Run OpenCode with PTY and signal-file awareness.

        Overrides base to add signal file handling:
        - Deploys plugin before starting
        - Checks signal file for completion (primary detection)
        - Discards signal file writes during interactive mode
        - Cleans up signal infrastructure on exit
        """
        # Deploy plugin to working dir
        self._deploy_plugin(config.working_dir)
        self._setup_signal_file()

        start_time = time.time()
        try:
            cmd = self.build_pty_command(config)
            env = self.build_pty_env(config)
            pty_agent.start(cmd, env, config.working_dir)

            # Write prompt to the PTY
            pty_agent.write_prompt(config.prompt)

            # Main loop: read output, check signal file and completion
            while not pty_agent.is_done():
                output_bytes = interactive_controller.check_output(timeout=0.2)

                if not interactive_controller.is_interactive:
                    # Check signal file (primary completion for opencode)
                    if self._check_signal_file():
                        pty_agent.terminate()
                        break

                    # Also check output for COMPLETE signal
                    if output_bytes:
                        text = output_bytes.decode("utf-8", errors="replace")
                        if interactive_controller.should_detect_completion(text):
                            pty_agent.terminate()
                            break
                else:
                    # Interactive mode: discard signal file writes
                    self._discard_signal_file()

                if not output_bytes:
                    time.sleep(0.05)

            output = pty_agent.output
            exit_code = pty_agent.exit_code
            completed = (
                COMPLETION_SIGNAL in output
                and not interactive_controller.suppress_completion
            )
            failed = self._detect_failure(exit_code, output, "")
            error_message = ""
            if failed:
                error_message = self._extract_error(exit_code, output, "")

            return AgentResult(
                output=output,
                exit_code=exit_code,
                duration_seconds=time.time() - start_time,
                completed=completed,
                failed=failed,
                error_message=error_message,
            )
        except OSError as e:
            return AgentResult(
                output="",
                exit_code=1,
                duration_seconds=time.time() - start_time,
                failed=True,
                error_message=f"Failed to start opencode with PTY: {e}",
            )
        finally:
            pty_agent.cleanup()
            self._cleanup_signal()

    def _parse_output(self, raw_output: str) -> str:
        """Parse OpenCode output. Currently returns raw output."""
        # OpenCode outputs directly without a structured format wrapper
        return raw_output


# --- Plugin Deployment Utilities ---


PLUGIN_SOURCE_DIR = (
    Path(__file__).parent.parent.parent / "plugins" / "opencode-ralph-hook"
)
GLOBAL_PLUGIN_DIR = Path.home() / ".config" / "opencode" / "plugins" / "ralph-hook"


def deploy_plugin_globally() -> bool:
    """Install the ralph-hook plugin globally at ~/.config/opencode/plugins/.

    Returns True if successful, False otherwise.
    This allows the plugin to work without per-project deployment.
    """
    plugin_dist = PLUGIN_SOURCE_DIR / "dist"
    if not plugin_dist.is_dir():
        return False

    GLOBAL_PLUGIN_DIR.mkdir(parents=True, exist_ok=True)

    try:
        for item in plugin_dist.iterdir():
            if item.is_file():
                dest = GLOBAL_PLUGIN_DIR / item.name
                shutil.copy2(str(item), str(dest))

        pkg_json = PLUGIN_SOURCE_DIR / "package.json"
        if pkg_json.is_file():
            shutil.copy2(str(pkg_json), str(GLOBAL_PLUGIN_DIR / "package.json"))

        return True
    except OSError:
        return False


def is_plugin_installed_globally() -> bool:
    """Check if the ralph-hook plugin is installed globally."""
    return (GLOBAL_PLUGIN_DIR / "index.js").exists()


@dataclass
class FailureTracker:
    """Tracks consecutive failures per agent for failover logic."""

    counts: dict[str, int] = field(default_factory=lambda: {a: 0 for a in VALID_AGENTS})
    last_errors: dict[str, str] = field(
        default_factory=lambda: {a: "" for a in VALID_AGENTS}
    )

    def record_failure(self, agent: str, error_msg: str) -> None:
        """Record a failure for the given agent."""
        self.counts[agent] = self.counts.get(agent, 0) + 1
        self.last_errors[agent] = error_msg

    def reset(self, agent: str) -> None:
        """Reset failure count for a successful agent."""
        self.counts[agent] = 0
        self.last_errors[agent] = ""

    def should_failover(self, agent: str, threshold: int) -> bool:
        """Check if the agent has exceeded the failure threshold."""
        return self.counts.get(agent, 0) >= threshold

    def all_failed(self, threshold: int) -> bool:
        """Check if all agents have exceeded the failure threshold."""
        return all(self.counts.get(a, 0) >= threshold for a in VALID_AGENTS)

    def get_alternate(self, current: str) -> str:
        """Get the alternate agent for failover."""
        for agent in VALID_AGENTS:
            if agent != current:
                return agent
        return current


def create_agent(agent_name: str) -> Agent:
    """Factory function to create an agent by name.

    Args:
        agent_name: The agent identifier ("claude" or "opencode").

    Returns:
        An Agent instance for the specified agent.

    Raises:
        ValueError: If the agent name is not recognized.
    """
    match agent_name:
        case "claude":
            return ClaudeAgent()
        case "opencode":
            return OpencodeAgent()
        case _:
            raise ValueError(
                f"Unknown agent: '{agent_name}'. Valid agents: {', '.join(VALID_AGENTS)}"  # noqa: E501
            )


def resolve_agent(
    prd: dict[str, Any],
    story: dict[str, Any] | None,
    cli_override: str | None,
) -> str:
    """Resolve which agent to use based on priority: CLI > story > prd > default.

    Resolution order (highest priority first):
    1. CLI --agent flag override
    2. Story-level agent field
    3. PRD-level agent field
    4. Default: "claude"

    Args:
        prd: The parsed prd.json content.
        story: The current story being worked on (may be None).
        cli_override: Agent name from CLI --agent flag (may be None).

    Returns:
        The resolved agent name.
    """
    # 1. CLI override takes highest priority
    if cli_override and cli_override in VALID_AGENTS:
        return cli_override

    # 2. Story-level agent
    if story:
        story_agent = str(story.get("agent", ""))
        if story_agent in VALID_AGENTS:
            return story_agent

    # 3. PRD-level agent
    prd_agent = str(prd.get("agent", ""))
    if prd_agent in VALID_AGENTS:
        return prd_agent

    # 4. Default
    return "claude"
