"""Loop iteration driver for the Ralph daemon.

Drives loop iterations by sending prompts to opencode's HTTP API and
detecting completion via SSE events. Handles:

- Session creation via POST /session
- Prompt building using prompt.py template system
- Sending prompts via POST /session/{id}/message
- Monitoring completion via SSE GET /event stream
- Reading prd.json to check story completion
- Git push after iterations
- Retry with exponential backoff on failures
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Any

import aiohttp

from ralph_uv.prompt import PromptContext, build_prompt

if TYPE_CHECKING:
    from ralph_uv.daemon import Daemon, LoopEvent, LoopInfo
    from ralph_uv.opencode_lifecycle import OpenCodeInstance, OpenCodeManager

# Constants
COMPLETION_SIGNAL = "<promise>COMPLETE</promise>"
HTTP_TIMEOUT = 60.0  # seconds for HTTP requests
SSE_TIMEOUT = 3600.0  # 1 hour max per iteration
RETRY_BASE_DELAY = 5.0  # seconds
RETRY_MAX_DELAY = 60.0  # seconds
MAX_CONSECUTIVE_FAILURES = 3


class LoopStatus(Enum):
    """Status of a loop."""

    STARTING = "starting"
    RUNNING = "running"
    COMPLETED = "completed"
    EXHAUSTED = "exhausted"
    FAILED = "failed"
    STOPPING = "stopping"
    TIMED_OUT = "timed_out"


class IterationResult(Enum):
    """Result of a single iteration."""

    SUCCESS = "success"
    COMPLETED = "completed"  # All stories done
    FAILED = "failed"
    ABORTED = "aborted"


@dataclass
class IterationOutcome:
    """Outcome of a single iteration."""

    result: IterationResult
    story_id: str | None = None
    error_message: str = ""
    duration_seconds: float = 0.0


@dataclass
class LoopState:
    """State for a running loop."""

    loop_id: str
    task_dir: Path
    worktree_path: Path
    branch: str
    max_iterations: int
    push_frequency: int = 1
    timeout_hours: float = 24.0  # Per-loop timeout in hours

    # Runtime state
    iteration: int = 0
    consecutive_failures: int = 0
    last_error: str = ""
    status: LoopStatus = LoopStatus.STARTING
    started_at: datetime = field(default_factory=datetime.now)
    completed_at: datetime | None = None

    # Stop signal
    stop_requested: bool = False

    def is_timed_out(self) -> bool:
        """Check if the loop has exceeded its timeout."""
        if self.timeout_hours <= 0:
            return False  # No timeout (infinite)
        elapsed = datetime.now() - self.started_at
        timeout_seconds = self.timeout_hours * 3600
        return elapsed.total_seconds() > timeout_seconds


class LoopDriver:
    """Drives loop iterations via the opencode HTTP API.

    Responsibilities:
    - Create sessions for each iteration
    - Build prompts using the prompt.py template system
    - Send prompts and wait for completion
    - Monitor SSE events for session.idle
    - Check prd.json for story completion
    - Push to origin after iterations
    - Handle failures with retry and backoff
    """

    def __init__(
        self,
        daemon: Daemon,
        opencode_manager: OpenCodeManager,
    ) -> None:
        """Initialize the loop driver.

        Args:
            daemon: The daemon instance
            opencode_manager: Manager for opencode serve instances
        """
        self.daemon = daemon
        self.opencode_manager = opencode_manager
        self._log = logging.getLogger("ralphd.loop")
        self._active_loops: dict[str, asyncio.Task[None]] = {}

    async def start_loop(
        self,
        loop_info: LoopInfo,
        instance: OpenCodeInstance,
    ) -> asyncio.Task[None]:
        """Start running a loop in the background.

        Args:
            loop_info: Loop information from RPC
            instance: OpenCode instance for this loop

        Returns:
            Asyncio task running the loop
        """
        # Build loop state
        worktree_path = (
            Path(loop_info.worktree_path) if loop_info.worktree_path else Path.cwd()
        )
        task_dir = worktree_path / loop_info.task_dir

        state = LoopState(
            loop_id=loop_info.loop_id,
            task_dir=task_dir,
            worktree_path=worktree_path,
            branch=loop_info.branch,
            max_iterations=loop_info.max_iterations,
            push_frequency=loop_info.push_frequency,
            timeout_hours=loop_info.timeout_hours,
        )

        self._log.info(
            "Starting loop %s: task_dir=%s, max_iterations=%d",
            state.loop_id,
            state.task_dir,
            state.max_iterations,
        )

        # Start the loop task
        task = asyncio.create_task(
            self._run_loop(state, instance, loop_info),
            name=f"loop-{state.loop_id}",
        )
        self._active_loops[state.loop_id] = task

        return task

    async def stop_loop(self, loop_id: str) -> None:
        """Request a loop to stop gracefully."""
        task = self._active_loops.get(loop_id)
        if task is not None:
            task.cancel()
            try:
                await asyncio.wait_for(task, timeout=10.0)
            except (asyncio.CancelledError, TimeoutError):
                pass
            self._active_loops.pop(loop_id, None)

    async def _run_loop(
        self,
        state: LoopState,
        instance: OpenCodeInstance,
        loop_info: LoopInfo,
    ) -> None:
        """Run the loop iterations.

        This is the main loop that:
        1. Reads prd.json to find the next story
        2. Builds a prompt for the iteration
        3. Creates a session and sends the prompt
        4. Waits for completion via SSE
        5. Checks if all stories are complete
        6. Pushes to origin periodically
        """
        state.status = LoopStatus.RUNNING
        loop_info.status = "running"

        try:
            for iteration in range(1, state.max_iterations + 1):
                state.iteration = iteration
                loop_info.iteration = iteration

                # Check for stop request
                if state.stop_requested:
                    self._log.info("Loop %s: stop requested", state.loop_id)
                    break

                # Check for timeout
                if state.is_timed_out():
                    self._log.warning(
                        "Loop %s: timed out after %.1f hours at iteration %d",
                        state.loop_id,
                        state.timeout_hours,
                        iteration,
                    )
                    state.status = LoopStatus.TIMED_OUT
                    state.last_error = (
                        f"Loop timed out after {state.timeout_hours} hours"
                    )
                    await self._push_to_origin(state)
                    break

                # Read PRD and find next story
                prd = self._read_prd(state)
                if prd is None:
                    state.status = LoopStatus.FAILED
                    state.last_error = "Failed to read prd.json"
                    break

                next_story = self._get_next_story(prd)
                if next_story is None:
                    # All stories complete!
                    self._log.info(
                        "Loop %s: all stories complete at iteration %d",
                        state.loop_id,
                        iteration,
                    )
                    state.status = LoopStatus.COMPLETED
                    await self._push_to_origin(state)
                    break

                story_id = str(next_story.get("id", "unknown"))
                story_title = str(next_story.get("title", ""))
                self._log.info(
                    "Loop %s: iteration %d/%d - %s: %s",
                    state.loop_id,
                    iteration,
                    state.max_iterations,
                    story_id,
                    story_title,
                )

                # Run the iteration
                outcome = await self._run_iteration(
                    state,
                    instance,
                    prd,
                    next_story,
                    iteration,
                )

                # Handle outcome
                if outcome.result == IterationResult.COMPLETED:
                    # Agent signaled completion
                    self._log.info(
                        "Loop %s: agent signaled completion at iteration %d",
                        state.loop_id,
                        iteration,
                    )
                    state.status = LoopStatus.COMPLETED
                    # Track the final story that was completed
                    if outcome.story_id:
                        loop_info.final_story = outcome.story_id
                    await self._push_to_origin(state)
                    break

                elif outcome.result == IterationResult.FAILED:
                    state.consecutive_failures += 1
                    state.last_error = outcome.error_message
                    self._log.warning(
                        "Loop %s: iteration %d failed (%d consecutive): %s",
                        state.loop_id,
                        iteration,
                        state.consecutive_failures,
                        outcome.error_message,
                    )

                    if state.consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                        self._log.error(
                            "Loop %s: max consecutive failures reached, stopping",
                            state.loop_id,
                        )
                        state.status = LoopStatus.FAILED
                        break

                    # Retry with backoff
                    delay = min(
                        RETRY_BASE_DELAY * (2 ** (state.consecutive_failures - 1)),
                        RETRY_MAX_DELAY,
                    )
                    self._log.info(
                        "Loop %s: retrying in %.1f seconds",
                        state.loop_id,
                        delay,
                    )
                    await asyncio.sleep(delay)
                    continue

                elif outcome.result == IterationResult.ABORTED:
                    self._log.info("Loop %s: iteration aborted", state.loop_id)
                    break

                else:
                    # Success - reset failures, track final story, push if needed
                    state.consecutive_failures = 0

                    # Track the last successfully worked on story
                    if outcome.story_id:
                        loop_info.final_story = outcome.story_id

                    if iteration % state.push_frequency == 0:
                        await self._push_to_origin(state)

                    # Brief pause between iterations
                    await asyncio.sleep(2.0)

            else:
                # Max iterations reached without completion
                self._log.info(
                    "Loop %s: max iterations (%d) reached",
                    state.loop_id,
                    state.max_iterations,
                )
                state.status = LoopStatus.EXHAUSTED
                await self._push_to_origin(state)

        except asyncio.CancelledError:
            self._log.info("Loop %s: cancelled", state.loop_id)
            state.status = LoopStatus.STOPPING
            raise
        except Exception as e:
            self._log.exception("Loop %s: unexpected error: %s", state.loop_id, e)
            state.status = LoopStatus.FAILED
            state.last_error = str(e)
        finally:
            state.completed_at = datetime.now()
            loop_info.status = state.status.value

            # Deregister Ziti loop service (if registered)
            # Only deregister here for natural completion/failure/exhaustion/timeout
            # stop_loop handles deregistration for cancelled loops
            if state.status in (
                LoopStatus.COMPLETED,
                LoopStatus.EXHAUSTED,
                LoopStatus.FAILED,
                LoopStatus.TIMED_OUT,
            ):
                if self.daemon.loop_service_manager is not None:
                    try:
                        await self.daemon.loop_service_manager.deregister_loop_service(
                            state.loop_id
                        )
                        self._log.info(
                            "Loop %s: Ziti service deregistered on completion",
                            state.loop_id,
                        )
                    except Exception as e:
                        self._log.warning(
                            "Loop %s: failed to deregister Ziti service: %s",
                            state.loop_id,
                            e,
                        )

            # Emit completion event
            await self._emit_loop_event(state, loop_info)

            # Unregister from loop registry (persistence)
            try:
                await self.daemon.loop_registry.unregister_loop(state.loop_id)
            except Exception as e:
                self._log.warning(
                    "Loop %s: failed to unregister from registry: %s",
                    state.loop_id,
                    e,
                )

            # Clean up
            self._active_loops.pop(state.loop_id, None)

    async def _run_iteration(
        self,
        state: LoopState,
        instance: OpenCodeInstance,
        prd: dict[str, Any],
        story: dict[str, Any],
        iteration: int,
    ) -> IterationOutcome:
        """Run a single iteration.

        Args:
            state: Loop state
            instance: OpenCode instance
            prd: PRD data
            story: Next story to work on
            iteration: Current iteration number

        Returns:
            Iteration outcome
        """
        start_time = time.time()
        story_id = str(story.get("id", "unknown"))

        try:
            # Build prompt
            prompt = self._build_prompt(state, prd, iteration)

            # Create a new session
            session_id = await self.opencode_manager.create_session(state.loop_id)
            self._log.info(
                "Loop %s: created session %s for iteration %d",
                state.loop_id,
                session_id,
                iteration,
            )

            # Send prompt and wait for completion
            response = await self._send_prompt_and_wait(
                instance,
                session_id,
                prompt,
            )

            duration = time.time() - start_time

            # Check for completion signal in response
            if COMPLETION_SIGNAL in response:
                return IterationOutcome(
                    result=IterationResult.COMPLETED,
                    story_id=story_id,
                    duration_seconds=duration,
                )

            # Re-read PRD to check for completion
            updated_prd = self._read_prd(state)
            if updated_prd:
                next_story = self._get_next_story(updated_prd)
                if next_story is None:
                    return IterationOutcome(
                        result=IterationResult.COMPLETED,
                        story_id=story_id,
                        duration_seconds=duration,
                    )

            return IterationOutcome(
                result=IterationResult.SUCCESS,
                story_id=story_id,
                duration_seconds=duration,
            )

        except asyncio.CancelledError:
            return IterationOutcome(
                result=IterationResult.ABORTED,
                story_id=story_id,
                duration_seconds=time.time() - start_time,
            )
        except Exception as e:
            return IterationOutcome(
                result=IterationResult.FAILED,
                story_id=story_id,
                error_message=str(e),
                duration_seconds=time.time() - start_time,
            )

    def _build_prompt(
        self,
        state: LoopState,
        prd: dict[str, Any],
        iteration: int,
    ) -> str:
        """Build the prompt for an iteration.

        Uses the prompt.py template system. On first iteration,
        includes a First-Run Setup section.
        """
        branch_name = str(prd.get("branchName", state.branch))

        # Build base prompt
        context = PromptContext(
            task_dir=state.task_dir,
            prd_file=state.task_dir / "prd.json",
            progress_file=state.task_dir / "progress.txt",
            branch_name=branch_name,
            agent="opencode",
        )
        prompt = build_prompt(context)

        # Add first-run setup section for iteration 1
        if iteration == 1:
            first_run_section = self._build_first_run_section(state, prd)
            prompt = first_run_section + "\n\n" + prompt

        return prompt

    def _build_first_run_section(
        self,
        state: LoopState,
        prd: dict[str, Any],
    ) -> str:
        """Build the First-Run Setup section for iteration 1."""
        description = prd.get("description", "No description")
        branch_name = prd.get("branchName", state.branch)
        stories = prd.get("userStories", [])
        total_stories = len(stories)
        completed = sum(1 for s in stories if s.get("passes", False))

        return f"""## First-Run Setup

This is **iteration 1** of a new loop. Please ensure:

1. **Workspace**: You are in a fresh git worktree at `{state.worktree_path}`
2. **Branch**: The branch `{branch_name}` should be checked out
3. **Dependencies**: Run any necessary setup (npm install, pip install, etc.)

### Loop Context

- **Task**: {state.task_dir.name}
- **Description**: {description}
- **Progress**: {completed}/{total_stories} stories complete
- **Max iterations**: {state.max_iterations}

Please proceed with the highest priority incomplete story.
"""

    def _read_prd(self, state: LoopState) -> dict[str, Any] | None:
        """Read and parse prd.json from the worktree."""
        prd_path = state.task_dir / "prd.json"
        try:
            content = prd_path.read_text()
            result: dict[str, Any] = json.loads(content)
            return result
        except (OSError, json.JSONDecodeError) as e:
            self._log.error(
                "Loop %s: failed to read prd.json: %s",
                state.loop_id,
                e,
            )
            return None

    def _get_next_story(self, prd: dict[str, Any]) -> dict[str, Any] | None:
        """Get the highest priority story where passes is false."""
        stories: list[dict[str, Any]] = prd.get("userStories", [])
        incomplete = [s for s in stories if not s.get("passes", False)]
        if not incomplete:
            return None
        incomplete.sort(key=lambda s: s.get("priority", 999))
        return incomplete[0]

    async def _send_prompt_and_wait(
        self,
        instance: OpenCodeInstance,
        session_id: str,
        prompt: str,
    ) -> str:
        """Send a prompt to opencode and wait for completion.

        The POST /session/{id}/message endpoint is synchronous - it blocks
        until the agent finishes processing. We also monitor the SSE stream
        for session.idle events as a backup completion detection.

        Args:
            instance: OpenCode instance
            session_id: Session ID
            prompt: Prompt to send

        Returns:
            Response text from the agent
        """
        url = f"{instance.base_url}/session/{session_id}/message"
        self._log.debug(
            "Sending prompt to %s (length=%d)",
            url,
            len(prompt),
        )

        # Create SSE monitoring task
        sse_task = asyncio.create_task(
            self._monitor_sse_for_idle(instance, session_id),
            name=f"sse-{session_id}",
        )

        try:
            # Send prompt (synchronous endpoint)
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    url,
                    json={"message": prompt},
                    timeout=aiohttp.ClientTimeout(total=SSE_TIMEOUT),
                ) as resp:
                    if resp.status != 200:
                        text = await resp.text()
                        raise RuntimeError(
                            f"Failed to send prompt: HTTP {resp.status}: {text}"
                        )
                    data = await resp.json()
                    response_text = str(data.get("response", data.get("result", "")))
                    return response_text

        finally:
            # Cancel SSE monitoring
            sse_task.cancel()
            try:
                await sse_task
            except asyncio.CancelledError:
                pass

    async def _monitor_sse_for_idle(
        self,
        instance: OpenCodeInstance,
        session_id: str,
    ) -> None:
        """Monitor SSE stream for session.idle events.

        This is a backup completion detection mechanism. The primary
        method is the synchronous POST /session/{id}/message response.
        """
        url = f"{instance.base_url}/event"
        self._log.debug("Starting SSE monitor for session %s", session_id)

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    url,
                    timeout=aiohttp.ClientTimeout(total=SSE_TIMEOUT),
                ) as resp:
                    async for line in resp.content:
                        line_str = line.decode().strip()
                        if not line_str or not line_str.startswith("data:"):
                            continue

                        try:
                            data = json.loads(line_str[5:].strip())
                            event_type = data.get("type", "")
                            event_session = data.get("sessionId", "")

                            if (
                                event_type == "session.idle"
                                and event_session == session_id
                            ):
                                self._log.debug(
                                    "SSE: session.idle for %s",
                                    session_id,
                                )
                                return
                        except json.JSONDecodeError:
                            continue

        except asyncio.CancelledError:
            pass
        except Exception as e:
            self._log.debug("SSE monitor error: %s", e)

    async def _push_to_origin(self, state: LoopState) -> bool:
        """Push committed work to origin.

        Uses --force-with-lease to prevent data loss. Push failures
        are logged but don't fail the loop.

        Returns:
            True if push succeeded, False otherwise
        """
        self._log.info("Loop %s: pushing to origin", state.loop_id)

        try:
            proc = await asyncio.create_subprocess_exec(
                "git",
                "push",
                "origin",
                state.branch,
                "--force-with-lease",
                cwd=str(state.worktree_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60.0)

            if proc.returncode == 0:
                self._log.info("Loop %s: push succeeded", state.loop_id)
                return True
            else:
                stderr_text = stderr.decode(errors="replace")
                self._log.warning(
                    "Loop %s: push failed (non-fatal): %s",
                    state.loop_id,
                    stderr_text[:200],
                )
                return False

        except TimeoutError:
            self._log.warning(
                "Loop %s: push timed out (non-fatal)",
                state.loop_id,
            )
            return False
        except Exception as e:
            self._log.warning(
                "Loop %s: push error (non-fatal): %s",
                state.loop_id,
                e,
            )
            return False

    async def _emit_loop_event(
        self,
        state: LoopState,
        loop_info: LoopInfo,
    ) -> None:
        """Emit a loop completion/failure event.

        This notifies connected clients via the control service.
        Events are broadcast to all subscribed clients in real-time.
        If no clients are subscribed, events are logged but not queued.

        Args:
            state: Loop state with status and iteration info
            loop_info: Loop info to get final_story from
        """
        from ralph_uv.daemon import LoopEvent

        # Determine event type based on final status
        if state.status == LoopStatus.COMPLETED:
            event_type = "loop_completed"
        elif state.status == LoopStatus.EXHAUSTED:
            # Exhausted is also a form of completion (max iterations)
            event_type = "loop_completed"
        elif state.status == LoopStatus.TIMED_OUT:
            # Timeout is treated as a failure
            event_type = "loop_failed"
        else:
            event_type = "loop_failed"

        # Create the event
        event = LoopEvent(
            type=event_type,
            loop_id=state.loop_id,
            task_name=state.task_dir.name,
            status=state.status.value,
            iterations_used=state.iteration,
            branch=state.branch,
            final_story=loop_info.final_story,
            error=state.last_error
            if state.status in (LoopStatus.FAILED, LoopStatus.TIMED_OUT)
            else None,
        )

        # Update loop_info with last_error if failed or timed out
        if state.status in (LoopStatus.FAILED, LoopStatus.TIMED_OUT):
            loop_info.last_error = state.last_error

        self._log.info(
            "Loop %s: emitting %s event (status=%s, iterations=%d)",
            state.loop_id,
            event_type,
            state.status.value,
            state.iteration,
        )

        # Broadcast to subscribed clients via the event broadcaster
        sent_count = await self.daemon.event_broadcaster.broadcast(event)


def count_completed_stories(prd: dict[str, Any]) -> tuple[int, int]:
    """Count completed and total stories in a PRD.

    Returns:
        Tuple of (completed, total)
    """
    stories = prd.get("userStories", [])
    completed = sum(1 for s in stories if s.get("passes", False))
    return completed, len(stories)
