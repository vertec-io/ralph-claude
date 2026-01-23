"""Core iteration loop for Ralph agent runner."""

from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from ralph_uv.agents import (
    COMPLETION_SIGNAL,
    VALID_AGENTS,
    AgentConfig,
    AgentResult,
    FailureTracker,
    create_agent,
    resolve_agent,
)
from ralph_uv.branch import (
    BranchConfig,
    BranchError,
    create_branch_config,
    handle_completion,
    setup_branch,
)
from ralph_uv.opencode_server import OpencodeServer, OpencodeServerError
from ralph_uv.prompt import (
    PromptContext,
    build_prompt,
)
from ralph_uv.rpc import (
    RpcServer,
    SessionState,
    cleanup_socket,
)
from ralph_uv.session import (
    SessionDB,
    SessionInfo,
    read_signal,
    task_name_from_dir,
    tmux_session_name,
)

DEFAULT_MAX_ITERATIONS = 50
DEFAULT_ROTATE_THRESHOLD = 300
DEFAULT_FAILOVER_THRESHOLD = 3


@dataclass
class LoopConfig:
    """Configuration for a Ralph loop run."""

    task_dir: Path
    max_iterations: int = DEFAULT_MAX_ITERATIONS
    agent: str = "claude"
    agent_override: str | None = None  # CLI --agent override
    base_branch: str | None = None  # CLI --base-branch override
    rotate_threshold: int = DEFAULT_ROTATE_THRESHOLD
    failover_threshold: int = DEFAULT_FAILOVER_THRESHOLD
    yolo_mode: bool = False
    verbose: bool = False

    @property
    def prd_file(self) -> Path:
        return self.task_dir / "prd.json"

    @property
    def progress_file(self) -> Path:
        return self.task_dir / "progress.txt"


class ShutdownRequested(Exception):
    """Raised when a graceful shutdown is requested."""


class LoopRunner:
    """Runs the core Ralph iteration loop."""

    def __init__(
        self,
        config: LoopConfig,
        opencode_server: OpencodeServer | None = None,
    ) -> None:
        self.config = config
        self.failures = FailureTracker()
        self.current_iteration = 0
        self.current_agent = config.agent
        self._shutdown_requested = False
        self._checkpoint_requested = False
        self._original_sigint: signal._HANDLER = signal.SIG_DFL
        self._original_sigterm: signal._HANDLER = signal.SIG_DFL
        self._session_db: SessionDB | None = None
        self._task_name = task_name_from_dir(config.task_dir)
        self._rpc_server: RpcServer | None = None
        self._rpc_thread: threading.Thread | None = None
        self._rpc_loop: asyncio.AbstractEventLoop | None = None
        self._opencode_server = opencode_server
        self._opencode_session_id: str | None = None

    def run(self) -> int:
        """Run the loop. Returns exit code (0 = complete, 1 = stopped/failed)."""
        self._install_signal_handlers()
        self._register_session()
        self._start_rpc_server()
        try:
            result = self._run_loop()
            # Update session status based on result
            status = "completed" if result == 0 else "stopped"
            if self._checkpoint_requested:
                status = "checkpointed"
            self._update_session_status(status)
            self._update_rpc_state(status=status)
            return result
        except Exception:
            self._update_session_status("failed")
            self._update_rpc_state(status="failed")
            raise
        finally:
            self._stop_rpc_server()
            self._restore_signal_handlers()

    # --- RPC Server Lifecycle ---

    def _start_rpc_server(self) -> None:
        """Start the JSON-RPC server in a background thread."""
        now = datetime.now().isoformat()
        rpc_state = SessionState(
            task_name=self._task_name,
            task_dir=str(self.config.task_dir),
            max_iterations=self.config.max_iterations,
            agent=self.current_agent,
            status="running",
            started_at=now,
            updated_at=now,
        )
        self._rpc_server = RpcServer(rpc_state)
        self._rpc_server.set_callbacks(
            on_stop=self._rpc_on_stop,
            on_checkpoint=self._rpc_on_checkpoint,
            on_set_interactive=self._rpc_on_set_interactive,
            on_write_pty=self._rpc_on_write_pty,
        )

        # Run the asyncio event loop in a daemon thread
        self._rpc_loop = asyncio.new_event_loop()
        self._rpc_thread = threading.Thread(
            target=self._run_rpc_loop,
            daemon=True,
            name="ralph-rpc-server",
        )
        self._rpc_thread.start()

    def _run_rpc_loop(self) -> None:
        """Run the RPC server's asyncio event loop (runs in background thread)."""
        if self._rpc_loop is None or self._rpc_server is None:
            return
        asyncio.set_event_loop(self._rpc_loop)
        self._rpc_loop.run_until_complete(self._rpc_server.start())
        self._rpc_loop.run_forever()

    def _stop_rpc_server(self) -> None:
        """Stop the JSON-RPC server and clean up."""
        if self._rpc_loop is not None and self._rpc_server is not None:
            # Schedule the stop coroutine on the RPC event loop
            future = asyncio.run_coroutine_threadsafe(
                self._rpc_server.stop(), self._rpc_loop
            )
            try:
                future.result(timeout=5.0)
            except (TimeoutError, Exception):
                pass

            # Stop the event loop
            self._rpc_loop.call_soon_threadsafe(self._rpc_loop.stop)

            # Wait for the thread to finish
            if self._rpc_thread is not None:
                self._rpc_thread.join(timeout=3.0)

            self._rpc_loop = None
            self._rpc_server = None
            self._rpc_thread = None
        else:
            # Still clean up socket file if server didn't start properly
            cleanup_socket(self._task_name)

    def _update_rpc_state(self, **kwargs: Any) -> None:
        """Update RPC session state (thread-safe)."""
        if self._rpc_server is not None:
            self._rpc_server.update_state(**kwargs)

    def _rpc_append_output(self, line: str) -> None:
        """Append output to RPC buffer (thread-safe)."""
        if self._rpc_server is not None:
            self._rpc_server.append_output(line)

    def _rpc_on_stop(self) -> None:
        """Callback from RPC server when TUI sends stop command."""
        self._shutdown_requested = True

    def _rpc_on_checkpoint(self) -> None:
        """Callback from RPC server when TUI sends checkpoint command."""
        self._checkpoint_requested = True
        self._shutdown_requested = True

    def _rpc_on_set_interactive(self, enabled: bool) -> None:
        """Callback from RPC server when TUI toggles interactive mode.

        With tmux-based execution, interactive mode is handled by
        tmux attach/detach — no PTY forwarding needed here.
        """
        pass

    def _rpc_on_write_pty(self, data: str) -> None:
        """Callback from RPC server when attach client sends PTY input.

        With tmux-based execution, the user interacts directly via
        tmux attach — no PTY forwarding needed here.
        """
        pass

    # --- Loop Logic ---

    def _run_loop(self) -> int:
        """Inner loop logic."""
        self._validate_config()

        # Set up branch before starting
        branch_config = self._setup_branch()

        self._print_banner()

        for i in range(1, self.config.max_iterations + 1):
            self.current_iteration = i

            # Check for external signals (stop/checkpoint)
            self._check_signals()

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
                self._handle_branch_completion(branch_config)
                return 0

            completed_count = self._count_completed(prd)
            total_count = len(prd.get("userStories", []))

            # Update session progress
            story_id = str(next_story.get("id", ""))
            self._update_session_progress(i, story_id)

            # Update RPC state with current iteration info
            self._update_rpc_state(
                iteration=i,
                current_story=story_id,
            )

            self._print_iteration_header(i, completed_count, total_count, next_story)

            # Resolve which agent to use for this iteration
            iteration_agent = self._resolve_agent_name(prd, next_story)
            self._update_rpc_state(agent=iteration_agent)

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
                self._handle_branch_completion(branch_config)
                return 0

            # Check for external signals after iteration
            self._check_signals()

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

    def _register_session(self) -> None:
        """Register this loop in the session database."""
        self._session_db = SessionDB()
        now = datetime.now().isoformat()
        session = SessionInfo(
            task_name=self._task_name,
            task_dir=str(self.config.task_dir),
            pid=os.getpid(),
            tmux_session=tmux_session_name(self._task_name),
            agent=self.current_agent,
            status="running",
            started_at=now,
            updated_at=now,
            iteration=0,
            current_story="",
            max_iterations=self.config.max_iterations,
        )
        self._session_db.register(session)

    def _update_session_status(self, status: str) -> None:
        """Update session status in the database."""
        if self._session_db is not None:
            self._session_db.update_status(self._task_name, status)

    def _update_session_progress(self, iteration: int, story_id: str) -> None:
        """Update session progress in the database."""
        if self._session_db is not None:
            self._session_db.update_progress(self._task_name, iteration, story_id)

    def _check_signals(self) -> None:
        """Check for stop/checkpoint signals from external commands."""
        signal_data = read_signal(self._task_name)
        if signal_data is None:
            return
        signal_type = signal_data.get("type", "")
        if signal_type == "stop":
            print(
                "\n>>> Stop signal received. Shutting down after current operation..."
            )
            self._shutdown_requested = True
        elif signal_type == "checkpoint":
            print(
                "\n>>> Checkpoint signal received. Pausing after current operation..."
            )
            self._checkpoint_requested = True
            self._shutdown_requested = True

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

    def _setup_branch(self) -> BranchConfig:
        """Set up the task branch before starting the loop.

        Returns the BranchConfig for use at completion.
        """
        prd = self._read_prd()
        try:
            branch_config = create_branch_config(prd, self.config.base_branch)
        except BranchError as e:
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)

        try:
            setup_branch(branch_config)
        except BranchError as e:
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)

        return branch_config

    def _handle_branch_completion(self, branch_config: BranchConfig) -> None:
        """Handle branch operations at loop completion."""
        try:
            handle_completion(branch_config)
        except BranchError as e:
            print(
                f"  Warning: Branch completion failed: {e}",
                file=sys.stderr,
            )

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
        result: dict[str, Any] = incomplete[0]
        return result

    def _count_completed(self, prd: dict[str, Any]) -> int:
        """Count completed stories."""
        stories = prd.get("userStories", [])
        return sum(1 for s in stories if s.get("passes", False))

    def _resolve_agent_name(self, prd: dict[str, Any], story: dict[str, Any]) -> str:
        """Resolve which agent to use for this iteration."""
        return resolve_agent(prd, story, self.config.agent_override)

    def _run_agent(self, agent_name: str, story: dict[str, Any]) -> AgentResult:
        """Run the agent for one iteration.

        Two modes:
        1. OpenCode server mode: Send prompts via HTTP API, monitor SSE for completion.
        2. Terminal mode (tmux): Agent inherits the terminal from the tmux session.
        """
        prompt = self._build_prompt(agent_name)

        # Check for injected prompt from TUI
        if self._rpc_server is not None and self._rpc_server.state.injected_prompt:
            prompt = self._rpc_server.state.injected_prompt + "\n\n" + prompt
            self._rpc_server.state.injected_prompt = ""

        # OpenCode server mode: use HTTP API
        if self._opencode_server is not None and agent_name == "opencode":
            return self._run_agent_via_server(prompt)

        # Terminal mode: agent inherits the terminal (tmux pane)
        agent = create_agent(agent_name)
        working_dir = self.config.task_dir.parent.parent  # Project root

        agent_config = AgentConfig(
            prompt=prompt,
            working_dir=working_dir,
            yolo_mode=self.config.yolo_mode,
            verbose=self.config.verbose,
        )

        result = agent.run_in_terminal(agent_config)

        # Append output to RPC buffer for TUI visibility
        if result.output:
            for line in result.output.splitlines()[-50:]:
                self._rpc_append_output(line)

        return result

    def _run_agent_via_server(self, prompt: str) -> AgentResult:
        """Run an iteration via the opencode HTTP server.

        Creates a session (or reuses existing), sends the prompt,
        and waits for the session to become idle.
        """
        assert self._opencode_server is not None
        start_time = time.time()

        try:
            # Create a new session for each iteration
            session = self._opencode_server.create_session()
            self._opencode_session_id = session.session_id
            print(f"  OpenCode session: {session.session_id}")

            # Send prompt synchronously (blocks until agent responds)
            # POST /session/:id/message is synchronous — it returns when done
            response = self._opencode_server.send_prompt(session.session_id, prompt)

            elapsed = time.time() - start_time

            # Check for completion signal in the response
            output = str(response) if response else ""
            completed = COMPLETION_SIGNAL in output

            return AgentResult(
                output=output,
                exit_code=0,
                duration_seconds=elapsed,
                completed=completed,
                failed=False,
                error_message="",
            )

        except OpencodeServerError as e:
            elapsed = time.time() - start_time
            return AgentResult(
                output="",
                exit_code=1,
                duration_seconds=elapsed,
                completed=False,
                failed=True,
                error_message=f"OpenCode server error: {e}",
            )

    def _build_prompt(self, agent_name: str) -> str:
        """Build the prompt for the agent using the prompt module."""
        prd = self._read_prd()
        branch_name = str(prd.get("branchName", ""))

        context = PromptContext(
            task_dir=self.config.task_dir,
            prd_file=self.config.prd_file,
            progress_file=self.config.progress_file,
            branch_name=branch_name,
            agent=agent_name,
        )
        return build_prompt(context)

    def _handle_failure(
        self, agent: str, story: dict[str, Any], result: AgentResult, iteration: int
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
        signal.signal(signal.SIGINT, self._original_sigint)
        signal.signal(signal.SIGTERM, self._original_sigterm)

    def _signal_handler(self, signum: int, frame: Any) -> None:  # noqa: ANN401
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
        print("  Run again with more iterations to continue.")
