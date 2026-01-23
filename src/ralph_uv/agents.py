"""Agent abstraction layer for ralph-uv.

Provides a pluggable interface for running different coding agents (Claude Code,
OpenCode) with agent-specific completion detection and failover logic.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


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

    def _build_env(self, config: AgentConfig) -> dict[str, str]:
        """Build the environment for Claude subprocess."""
        env = os.environ.copy()
        if config.model:
            # Claude CLI doesn't support model selection, but log awareness
            env["RALPH_MODEL_OVERRIDE"] = config.model
        return env

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
    """Agent implementation for OpenCode CLI.

    Placeholder implementation - full integration with stop-hook plugin
    is handled in US-008. This provides the basic subprocess invocation
    using `opencode run` with prompt via stdin.
    """

    @property
    def name(self) -> str:
        return "opencode"

    def start(self, config: AgentConfig) -> subprocess.Popen[str]:
        """Start OpenCode as a subprocess."""
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
        """Check if OpenCode process has terminated."""
        return process.poll() is not None

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

        return AgentResult(
            output=output,
            exit_code=exit_code,
            duration_seconds=0,  # Set by run()
            completed=completed,
            failed=failed,
            error_message=error_message,
        )

    def _build_command(self, config: AgentConfig) -> list[str]:
        """Build the opencode CLI command."""
        cmd = ["opencode", "run"]

        if config.model:
            cmd.extend(["--model", config.model])

        if config.verbose:
            cmd.extend(["--print-logs", "--log-level", "DEBUG"])

        return cmd

    def _build_env(self, config: AgentConfig) -> dict[str, str]:
        """Build the environment for OpenCode subprocess."""
        env = os.environ.copy()
        if config.yolo_mode:
            env["OPENCODE_PERMISSION"] = (
                '{"*": "allow", "external_directory": "allow", "doom_loop": "allow"}'
            )
        return env

    def _parse_output(self, raw_output: str) -> str:
        """Parse OpenCode output. Currently returns raw output."""
        # OpenCode outputs directly without a structured format wrapper
        # Future: parse JSON format if --format json is used
        return raw_output


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
                f"Unknown agent: '{agent_name}'. Valid agents: {', '.join(VALID_AGENTS)}"
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
