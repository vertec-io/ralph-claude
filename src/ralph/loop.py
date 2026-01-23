"""Core iteration loop for Ralph agent runner."""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from types import FrameType
from typing import Any


COMPLETION_SIGNAL = "<promise>COMPLETE</promise>"
DEFAULT_MAX_ITERATIONS = 50
DEFAULT_ROTATE_THRESHOLD = 300
DEFAULT_FAILOVER_THRESHOLD = 3

VALID_AGENTS = ("claude", "opencode")


@dataclass
class LoopConfig:
    """Configuration for a Ralph loop run."""

    task_dir: Path
    max_iterations: int = DEFAULT_MAX_ITERATIONS
    agent: str = "claude"
    rotate_threshold: int = DEFAULT_ROTATE_THRESHOLD
    failover_threshold: int = DEFAULT_FAILOVER_THRESHOLD
    yolo_mode: bool = False

    @property
    def prd_file(self) -> Path:
        return self.task_dir / "prd.json"

    @property
    def progress_file(self) -> Path:
        return self.task_dir / "progress.txt"


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
        return all(self.counts.get(agent, 0) >= threshold for agent in VALID_AGENTS)

    def get_alternate(self, current: str) -> str:
        """Get the alternate agent for failover."""
        for agent in VALID_AGENTS:
            if agent != current:
                return agent
        return current


@dataclass
class IterationResult:
    """Result of a single agent iteration."""

    output: str
    exit_code: int
    duration_seconds: float
    completed: bool = False
    failed: bool = False
    error_message: str = ""


class ShutdownRequested(Exception):
    """Raised when a graceful shutdown is requested."""


class LoopRunner:
    """Runs the core Ralph iteration loop."""

    def __init__(self, config: LoopConfig) -> None:
        self.config = config
        self.failures = FailureTracker()
        self.current_iteration = 0
        self.current_agent = config.agent
        self._shutdown_requested = False
        self._original_sigint: Any = None
        self._original_sigterm: Any = None

    def run(self) -> int:
        """Run the loop. Returns exit code (0 = complete, 1 = stopped/failed)."""
        self._install_signal_handlers()
        try:
            return self._run_loop()
        finally:
            self._restore_signal_handlers()

    def _run_loop(self) -> int:
        """Inner loop logic."""
        self._validate_config()
        self._print_banner()

        for i in range(1, self.config.max_iterations + 1):
            self.current_iteration = i

            if self._shutdown_requested:
                self._handle_shutdown()
                return 1

            self._rotate_progress_if_needed()

            # Get current story info
            prd = self._read_prd()
            next_story = self._get_next_story(prd)
            if next_story is None:
                # All stories complete
                self._print_complete(i)
                return 0

            completed_count = self._count_completed(prd)
            total_count = len(prd.get("userStories", []))

            self._print_iteration_header(i, completed_count, total_count, next_story)

            # Determine agent for this iteration (story override)
            iteration_agent = self._get_iteration_agent(next_story)

            # Run the agent
            result = self._run_agent(iteration_agent, next_story)

            # Handle result
            if result.failed:
                self._handle_failure(iteration_agent, next_story, result, i)
            else:
                self.failures.reset(iteration_agent)

            # Check for completion signal
            if result.completed:
                self._print_complete(i)
                return 0

            # Check for shutdown after iteration
            if self._shutdown_requested:
                self._handle_shutdown()
                return 1

            # Brief pause between iterations
            print(f"\nIteration {i} complete. Continuing in 2 seconds...")
            time.sleep(2)

        # Max iterations reached
        self._print_max_iterations()
        return 1

    def _validate_config(self) -> None:
        """Validate configuration before starting."""
        if not self.config.task_dir.is_dir():
            print(
                f"Error: Task directory not found: {self.config.task_dir}",
                file=sys.stderr,
            )
            sys.exit(1)
        if not self.config.prd_file.is_file():
            print(
                f"Error: prd.json not found in {self.config.task_dir}", file=sys.stderr
            )
            sys.exit(1)
        if self.config.agent not in VALID_AGENTS:
            print(
                f"Error: Invalid agent '{self.config.agent}'. Valid: {', '.join(VALID_AGENTS)}",
                file=sys.stderr,
            )
            sys.exit(1)

    def _read_prd(self) -> dict[str, Any]:
        """Read and parse prd.json."""
        try:
            return json.loads(self.config.prd_file.read_text())  # type: ignore[no-any-return]
        except (json.JSONDecodeError, OSError) as e:
            print(f"Error reading prd.json: {e}", file=sys.stderr)
            sys.exit(1)

    def _get_next_story(self, prd: dict[str, Any]) -> dict[str, Any] | None:
        """Get the highest priority story where passes is false."""
        stories: list[dict[str, Any]] = prd.get("userStories", [])
        incomplete = [s for s in stories if not s.get("passes", False)]
        if not incomplete:
            return None
        incomplete.sort(key=lambda s: s.get("priority", 999))
        return incomplete[0]

    def _count_completed(self, prd: dict[str, Any]) -> int:
        """Count completed stories."""
        stories = prd.get("userStories", [])
        return sum(1 for s in stories if s.get("passes", False))

    def _get_iteration_agent(self, story: dict[str, Any]) -> str:
        """Determine which agent to use for this iteration."""
        story_agent: str = story.get("agent", "")
        if story_agent and story_agent in VALID_AGENTS:
            return story_agent
        return self.current_agent

    def _run_agent(self, agent: str, story: dict[str, Any]) -> IterationResult:
        """Spawn the agent subprocess and capture results."""
        agents_dir = self._find_agents_dir()
        agent_script = agents_dir / f"{agent}.sh"

        if not agent_script.is_file():
            return IterationResult(
                output="",
                exit_code=1,
                duration_seconds=0,
                failed=True,
                error_message=f"Agent script not found: {agent_script}",
            )

        # Build the prompt
        prompt = self._build_prompt()

        # Set up environment
        env = os.environ.copy()
        env["SKIP_PERMISSIONS"] = "true"
        env["OUTPUT_FORMAT"] = "stream-json"
        env["RALPH_VERBOSE"] = "true"
        env["YOLO_MODE"] = "true" if self.config.yolo_mode else "false"

        start_time = time.time()
        try:
            proc = subprocess.run(
                [str(agent_script)],
                input=prompt,
                capture_output=True,
                text=True,
                env=env,
                cwd=str(self.config.task_dir.parent.parent),  # Project root
                timeout=None,  # No timeout - agent manages its own time
            )
            duration = time.time() - start_time
            output = self._extract_output(proc.stdout)

            # Detect completion
            completed = COMPLETION_SIGNAL in output

            # Detect failure
            failed = self._detect_failure(proc.returncode, output)
            error_msg = ""
            if failed:
                error_msg = self._extract_error(proc.returncode, output, proc.stderr)

            return IterationResult(
                output=output,
                exit_code=proc.returncode,
                duration_seconds=duration,
                completed=completed,
                failed=failed,
                error_message=error_msg,
            )
        except subprocess.TimeoutExpired:
            duration = time.time() - start_time
            return IterationResult(
                output="",
                exit_code=1,
                duration_seconds=duration,
                failed=True,
                error_message="Agent timed out",
            )
        except OSError as e:
            duration = time.time() - start_time
            return IterationResult(
                output="",
                exit_code=1,
                duration_seconds=duration,
                failed=True,
                error_message=f"Failed to start agent: {e}",
            )

    def _find_agents_dir(self) -> Path:
        """Find the agents directory."""
        # Check relative to project root (task_dir is tasks/xxx, so go up 2)
        project_root = self.config.task_dir.parent.parent
        agents_dir = project_root / "agents"
        if agents_dir.is_dir():
            return agents_dir

        # Check installed location
        installed = Path.home() / ".local" / "bin" / "ralph-agents"
        if installed.is_dir():
            return installed

        print("Error: Cannot find agents directory", file=sys.stderr)
        sys.exit(1)

    def _build_prompt(self) -> str:
        """Build the prompt for the agent."""
        # Load prompt.md template
        prompt_content = self._load_prompt_template()

        task_dir_rel = str(self.config.task_dir)
        return (
            f"# Ralph Agent Instructions\n\n"
            f"Task Directory: {task_dir_rel}\n"
            f"PRD File: {task_dir_rel}/prd.json\n"
            f"Progress File: {task_dir_rel}/progress.txt\n\n"
            f"{prompt_content}\n"
        )

    def _load_prompt_template(self) -> str:
        """Load prompt.md from task dir, config dir, or bundled default."""
        # 1. Task directory
        task_prompt = self.config.task_dir / "prompt.md"
        if task_prompt.is_file():
            return task_prompt.read_text()

        # 2. User config
        config_prompt = Path.home() / ".config" / "ralph" / "prompt.md"
        if config_prompt.is_file():
            return config_prompt.read_text()

        # 3. Project root
        project_root = self.config.task_dir.parent.parent
        root_prompt = project_root / "prompt.md"
        if root_prompt.is_file():
            return root_prompt.read_text()

        # 4. Installed location
        installed_prompt = Path.home() / ".local" / "share" / "ralph" / "prompt.md"
        if installed_prompt.is_file():
            return installed_prompt.read_text()

        return "# No prompt template found\nImplement the next story from prd.json."

    def _extract_output(self, raw_output: str) -> str:
        """Extract meaningful output from agent response (handles stream-json)."""
        # Try to find result from stream-json format
        for line in raw_output.splitlines():
            if '"type":"result"' in line or '"type": "result"' in line:
                try:
                    data = json.loads(line)
                    result: str = data.get("result", "")
                    if result:
                        return result
                except json.JSONDecodeError:
                    continue

        # Fall back to raw output
        return raw_output

    def _detect_failure(self, exit_code: int, output: str) -> bool:
        """Detect if an iteration failed."""
        if exit_code != 0:
            return True
        if not output.strip():
            return True

        # Check for agent-level error patterns
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
            # Check stderr first
            if stderr.strip():
                lines = stderr.strip().splitlines()
                return f"Exit code {exit_code}: {lines[-1][:100]}"
            return f"Exit code {exit_code}"

        if not output.strip():
            return "Empty output"

        # Extract first error-like line
        for line in output.splitlines():
            if re.search(r"error|failed|timeout|refused", line, re.IGNORECASE):
                return line[:100]

        return "Unknown error"

    def _handle_failure(
        self, agent: str, story: dict[str, Any], result: IterationResult, iteration: int
    ) -> None:
        """Handle a failed iteration with failover logic."""
        story_id = story.get("id", "unknown")
        self.failures.record_failure(agent, result.error_message)
        count = self.failures.counts.get(agent, 0)

        print(
            f"\n  Warning: Iteration failed ({count} consecutive failures for {agent})"
        )
        print(f"  Error: {result.error_message}")

        # Log to progress
        self._log_failure_to_progress(agent, story_id, result.error_message, iteration)

        # Check failover
        if self.failures.should_failover(agent, self.config.failover_threshold):
            if self.failures.all_failed(self.config.failover_threshold):
                print("\n  All agents have exceeded failure threshold. Stopping.")
                self._shutdown_requested = True
                return

            # Failover to alternate
            alternate = self.failures.get_alternate(agent)
            print(f"\n  Failover: switching from {agent} to {alternate}")
            self.current_agent = alternate
            self._log_failover_to_progress(
                agent, alternate, story_id, result.error_message
            )

    def _log_failure_to_progress(
        self, agent: str, story_id: str, error_msg: str, iteration: int
    ) -> None:
        """Append failure entry to progress.txt."""
        now = datetime.now().strftime("%Y-%m-%d %H:%M")
        count = self.failures.counts.get(agent, 0)
        entry = (
            f"\n## {now} - FAILURE (Iteration {iteration})\n"
            f"- **Agent:** {agent}\n"
            f"- **Story:** {story_id}\n"
            f"- **Consecutive failures:** {count}\n"
            f"- **Error:** {error_msg}\n"
            f"---\n"
        )
        self._append_progress(entry)

    def _log_failover_to_progress(
        self, from_agent: str, to_agent: str, story_id: str, reason: str
    ) -> None:
        """Append failover entry to progress.txt."""
        now = datetime.now().strftime("%Y-%m-%d %H:%M")
        count = self.failures.counts.get(from_agent, 0)
        entry = (
            f"\n## {now} - FAILOVER\n"
            f"- **From agent:** {from_agent}\n"
            f"- **To agent:** {to_agent}\n"
            f"- **Story:** {story_id}\n"
            f"- **Consecutive failures before failover:** {count}\n"
            f"- **Reason:** {reason}\n"
            f"---\n"
        )
        self._append_progress(entry)

    def _append_progress(self, text: str) -> None:
        """Append text to progress file."""
        with open(self.config.progress_file, "a") as f:
            f.write(text)

    def _rotate_progress_if_needed(self) -> None:
        """Rotate progress.txt if it exceeds the threshold."""
        progress = self.config.progress_file
        if not progress.is_file():
            return

        lines = progress.read_text().splitlines()
        if len(lines) <= self.config.rotate_threshold:
            return

        print(
            f"\nProgress file exceeds {self.config.rotate_threshold} lines. Rotating..."
        )

        # Find next rotation number
        n = 1
        while (self.config.task_dir / f"progress-{n}.txt").exists():
            n += 1

        # Move current to progress-N.txt
        rotated = self.config.task_dir / f"progress-{n}.txt"
        rotated.write_text(progress.read_text())

        # Extract codebase patterns section
        content = progress.read_text()
        patterns_section = self._extract_patterns_section(content)

        # Extract metadata from rotated file
        effort_name = ""
        effort_type = ""
        started = ""
        for line in lines:
            if line.startswith("Effort:"):
                effort_name = line
            elif line.startswith("Type:"):
                effort_type = line
            elif line.startswith("Started:"):
                started = line

        # Count story iterations in rotated file
        story_count = sum(1 for line in lines if re.match(r"^## .* - S[0-9]", line))

        # Build reference chain
        prior_ref = ""
        if n > 1:
            prior_ref = f" (continues from progress-{n - 1}.txt)"

        # Create new progress.txt with minimal context
        now = datetime.now().strftime("%Y-%m-%d %H:%M")
        new_content = (
            f"# Ralph Progress Log\n"
            f"{effort_name}\n"
            f"{effort_type}\n"
            f"{started}\n"
            f"Rotation: {n} (rotated at {now})\n\n"
            f"{patterns_section}\n\n"
            f"## Prior Progress\n"
            f"Completed {story_count} iterations in progress-{n}.txt{prior_ref}.\n"
            f"_See progress-{n}.txt for detailed iteration logs._\n\n"
            f"---\n"
        )
        progress.write_text(new_content)
        print(f"Created summary. Previous progress saved to progress-{n}.txt")

    def _extract_patterns_section(self, content: str) -> str:
        """Extract the ## Codebase Patterns section from progress content."""
        lines = content.splitlines()
        in_patterns = False
        patterns_lines: list[str] = []

        for line in lines:
            if line.strip() == "## Codebase Patterns":
                in_patterns = True
                patterns_lines.append(line)
                continue
            if in_patterns:
                # Stop at next ## section that isn't Codebase Patterns
                if line.startswith("## ") and "Codebase Patterns" not in line:
                    break
                patterns_lines.append(line)

        return "\n".join(patterns_lines) if patterns_lines else ""

    def _install_signal_handlers(self) -> None:
        """Install SIGINT/SIGTERM handlers for graceful shutdown."""
        self._original_sigint = signal.getsignal(signal.SIGINT)
        self._original_sigterm = signal.getsignal(signal.SIGTERM)
        signal.signal(signal.SIGINT, self._signal_handler)
        signal.signal(signal.SIGTERM, self._signal_handler)

    def _restore_signal_handlers(self) -> None:
        """Restore original signal handlers."""
        if self._original_sigint is not None:
            signal.signal(signal.SIGINT, self._original_sigint)
        if self._original_sigterm is not None:
            signal.signal(signal.SIGTERM, self._original_sigterm)

    def _signal_handler(self, signum: int, frame: FrameType | None) -> None:
        """Handle shutdown signals gracefully."""
        sig_name = signal.Signals(signum).name
        print(
            f"\n>>> {sig_name} received. Shutting down gracefully after current operation..."
        )
        self._shutdown_requested = True

    def _handle_shutdown(self) -> None:
        """Handle graceful shutdown by writing checkpoint."""
        prd = self._read_prd()
        completed = self._count_completed(prd)
        total = len(prd.get("userStories", []))
        now = datetime.now().strftime("%Y-%m-%d %H:%M")

        entry = (
            f"\n---\n"
            f"CHECKPOINT at {now}\n"
            f"Iteration: {self.current_iteration}/{self.config.max_iterations} | "
            f"Stories: {completed}/{total} | Agent: {self.current_agent}\n"
            f"Reason: shutdown signal\n"
            f"---\n"
        )
        self._append_progress(entry)
        print(f"\n=== Checkpoint saved ({completed}/{total} stories) ===")

    def _print_banner(self) -> None:
        """Print the startup banner."""
        prd = self._read_prd()
        completed = self._count_completed(prd)
        total = len(prd.get("userStories", []))
        description = prd.get("description", "No description")
        branch = prd.get("branchName", "unknown")

        print()
        print("=" * 67)
        print("  Ralph - Autonomous Agent Loop (Python)")
        print("=" * 67)
        print()
        print(f"  Task:       {self.config.task_dir}")
        print(f"  Branch:     {branch}")
        print(f"  Agent:      {self.current_agent}")
        print(f"  Progress:   {completed} / {total} stories complete")
        print(f"  Max iters:  {self.config.max_iterations}")
        print()
        print(f"  {description}")
        print()

    def _print_iteration_header(
        self, iteration: int, completed: int, total: int, story: dict[str, Any]
    ) -> None:
        """Print the iteration header."""
        story_id = story.get("id", "?")
        story_title = story.get("title", "?")
        print()
        print("=" * 67)
        print(
            f"  Iteration {iteration} of {self.config.max_iterations} "
            f"({completed}/{total} complete) - {story_id}: {story_title}"
        )
        print("=" * 67)

    def _print_complete(self, iteration: int) -> None:
        """Print completion message."""
        print()
        print("=" * 67)
        print("  Ralph completed all tasks!")
        print("=" * 67)
        print()
        print(f"  Completed at iteration {iteration} of {self.config.max_iterations}")
        print()

    def _print_max_iterations(self) -> None:
        """Print max iterations reached message."""
        prd = self._read_prd()
        completed = self._count_completed(prd)
        total = len(prd.get("userStories", []))

        print()
        print("=" * 67)
        print("  Ralph reached max iterations")
        print("=" * 67)
        print()
        print(
            f"  Completed {completed} of {total} stories "
            f"in {self.config.max_iterations} iterations."
        )
        print(f"  Agent: {self.current_agent}")
        print()
        print(f"  Run again with more iterations to continue.")
