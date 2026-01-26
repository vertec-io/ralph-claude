"""Daemon RPC protocol for the Ralph daemon.

Implements JSON-RPC 2.0 methods for managing loops over the Ziti control service.

Methods:
- start_loop: Start a new loop with origin, branch, task_dir, etc.
- stop_loop: Stop a running loop by ID
- list_loops: List all active loops with status
- get_health: Get daemon health and resource info
- get_agents: Get available agent CLIs and versions

The protocol uses NDJSON (newline-delimited JSON) framing on the Ziti stream.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import platform
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ralph_uv.agent_manager import AgentManager
    from ralph_uv.daemon import Daemon

# JSON-RPC 2.0 error codes
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

# Custom error codes for daemon-specific errors
AGENT_NOT_FOUND = -32001
MAX_LOOPS_EXCEEDED = -32002
LOOP_NOT_FOUND = -32003
GIT_ERROR = -32004
ORIGIN_MISMATCH = -32005
BRANCH_NOT_FOUND = -32006
DISK_FULL = -32007


class RpcError(Exception):
    """JSON-RPC error with code, message, and optional data."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


@dataclass
class StartLoopParams:
    """Parameters for the start_loop RPC method."""

    origin_url: str
    branch: str
    task_dir: str
    max_iterations: int = 50
    agent: str = "opencode"
    push_frequency: int = 1  # Push after every N iterations

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> StartLoopParams:
        """Create StartLoopParams from a dict, validating required fields."""
        required_fields = ["origin_url", "branch", "task_dir"]
        missing = [f for f in required_fields if f not in data or not data[f]]
        if missing:
            raise RpcError(
                INVALID_PARAMS,
                f"Missing required parameter(s): {', '.join(missing)}",
            )

        return cls(
            origin_url=str(data["origin_url"]),
            branch=str(data["branch"]),
            task_dir=str(data["task_dir"]),
            max_iterations=int(data.get("max_iterations", 50)),
            agent=str(data.get("agent", "opencode")),
            push_frequency=int(data.get("push_frequency", 1)),
        )


class DaemonRpcHandler:
    """Handles JSON-RPC requests for the Ralph daemon.

    Provides methods for starting/stopping loops, querying status,
    and checking agent availability.
    """

    def __init__(self, daemon: Daemon) -> None:
        """Initialize the RPC handler.

        Args:
            daemon: The daemon instance to handle requests for
        """
        self.daemon = daemon
        self._log = logging.getLogger("ralphd.rpc")

        # Method dispatch table
        self._methods: dict[str, Any] = {
            "start_loop": self._handle_start_loop,
            "stop_loop": self._handle_stop_loop,
            "list_loops": self._handle_list_loops,
            "get_health": self._handle_get_health,
            "get_agents": self._handle_get_agents,
        }

        # Agent manager for CLI detection and auto-install (lazy initialized)
        self._agent_manager: AgentManager | None = None

    @property
    def agent_manager(self) -> AgentManager:
        """Get or create the agent manager."""
        if self._agent_manager is None:
            from ralph_uv.agent_manager import AgentManager

            self._agent_manager = AgentManager()
        return self._agent_manager

    async def handle_request(self, raw: str) -> dict[str, Any] | None:
        """Parse and dispatch a JSON-RPC request.

        Args:
            raw: Raw JSON-RPC request string

        Returns:
            JSON-RPC response dict, or None for notifications
        """
        try:
            request: dict[str, Any] = json.loads(raw)
        except json.JSONDecodeError:
            return self._error_response(None, PARSE_ERROR, "Parse error")

        # Validate JSON-RPC 2.0 structure
        if not isinstance(request, dict):
            return self._error_response(None, INVALID_REQUEST, "Invalid request")

        jsonrpc = request.get("jsonrpc")
        if jsonrpc != "2.0":
            return self._error_response(
                request.get("id"), INVALID_REQUEST, "Invalid JSON-RPC version"
            )

        method = request.get("method")
        if not isinstance(method, str):
            return self._error_response(
                request.get("id"), INVALID_REQUEST, "Missing method"
            )

        request_id = request.get("id")
        params = request.get("params", {})
        if not isinstance(params, dict):
            params = {}

        # Notifications (no id) don't get responses
        is_notification = request_id is None

        try:
            result = await self._dispatch(method, params)
            if is_notification:
                return None
            return self._success_response(request_id, result)
        except RpcError as e:
            if is_notification:
                return None
            return self._error_response(request_id, e.code, e.message, e.data)
        except Exception as e:
            self._log.exception("Unhandled error in RPC method %s: %s", method, e)
            if is_notification:
                return None
            return self._error_response(request_id, INTERNAL_ERROR, str(e))

    async def _dispatch(self, method: str, params: dict[str, Any]) -> Any:
        """Dispatch a method call to the appropriate handler."""
        handler = self._methods.get(method)
        if handler is None:
            raise RpcError(METHOD_NOT_FOUND, f"Method not found: {method}")

        return await handler(params)

    # --- RPC Method Handlers ---

    async def _handle_start_loop(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle start_loop request.

        Starts a new loop with the given parameters.

        Params:
            origin_url: Git origin URL to clone/fetch
            branch: Branch name to checkout
            task_dir: Relative path to task directory containing prd.json
            max_iterations: Maximum iterations (default: 50)
            agent: Agent to use (default: "opencode")
            push_frequency: Push after every N iterations (default: 1)

        Returns:
            loop_id: Unique ID for the started loop
            status: "starting"
            worktree_path: Path to the checkout directory
        """
        # Parse and validate params
        try:
            loop_params = StartLoopParams.from_dict(params)
        except RpcError:
            raise
        except Exception as e:
            raise RpcError(INVALID_PARAMS, f"Invalid parameters: {e}") from e

        # Check max concurrent loops
        if self.daemon.active_loop_count >= self.daemon.config.max_concurrent_loops:
            max_loops = self.daemon.config.max_concurrent_loops
            raise RpcError(
                MAX_LOOPS_EXCEEDED,
                f"Maximum concurrent loops reached ({max_loops})",
                {"active_loops": self.daemon.active_loop_count},
            )

        # Validate agent availability (attempts auto-install if missing)
        from ralph_uv.agent_manager import AgentInstallError

        try:
            await self.agent_manager.ensure_agent_available(loop_params.agent)
        except AgentInstallError as e:
            raise RpcError(
                AGENT_NOT_FOUND,
                f"Agent '{loop_params.agent}' is not available: {e.message}",
                {
                    "agent": loop_params.agent,
                    "install_instructions": e.instructions,
                },
            ) from e

        # Generate loop ID
        loop_id = f"loop-{uuid.uuid4().hex[:8]}"
        task_name = self._extract_task_name(loop_params.task_dir)

        # Set up git workspace
        from ralph_uv.workspace import (
            BranchNotFoundError,
            DiskFullError,
            OriginMismatchError,
            OriginUnreachableError,
            WorkspaceError,
        )

        try:
            worktree_info = await self.daemon.workspace_manager.setup_workspace(
                origin_url=loop_params.origin_url,
                branch=loop_params.branch,
                task_name=task_name,
            )
        except OriginUnreachableError as e:
            raise RpcError(
                GIT_ERROR,
                f"Cannot reach origin repository: {e}",
                {"origin_url": loop_params.origin_url},
            ) from e
        except BranchNotFoundError as e:
            raise RpcError(
                BRANCH_NOT_FOUND,
                f"Branch not found: {loop_params.branch}",
                {"branch": loop_params.branch, "detail": str(e)},
            ) from e
        except OriginMismatchError as e:
            raise RpcError(
                ORIGIN_MISMATCH,
                f"Origin URL mismatch: {e}",
                {"origin_url": loop_params.origin_url},
            ) from e
        except DiskFullError as e:
            raise RpcError(
                DISK_FULL,
                f"Insufficient disk space: {e}",
            ) from e
        except (WorkspaceError, ValueError) as e:
            raise RpcError(
                GIT_ERROR,
                f"Workspace setup failed: {e}",
            ) from e

        # Create loop info
        from ralph_uv.daemon import LoopInfo

        loop_info = LoopInfo(
            loop_id=loop_id,
            task_name=task_name,
            task_dir=loop_params.task_dir,
            branch=loop_params.branch,
            iteration=0,
            max_iterations=loop_params.max_iterations,
            agent=loop_params.agent,
            status="starting",
            started_at=datetime.datetime.now().isoformat(),
            worktree_path=str(worktree_info.worktree_path),
        )

        # Register the loop
        self.daemon._active_loops[loop_id] = loop_info
        self._log.info(
            "Started loop %s: task=%s, branch=%s, agent=%s, worktree=%s",
            loop_id,
            task_name,
            loop_params.branch,
            loop_params.agent,
            worktree_info.worktree_path,
        )

        # TODO: Actually start the loop (opencode serve, etc.)
        # This will be implemented in US-006, US-007

        return {
            "loop_id": loop_id,
            "status": "starting",
            "task_name": task_name,
            "branch": loop_params.branch,
            "agent": loop_params.agent,
            "max_iterations": loop_params.max_iterations,
            "worktree_path": str(worktree_info.worktree_path),
        }

    async def _handle_stop_loop(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle stop_loop request.

        Stops a running loop by ID.

        Params:
            loop_id: The loop ID to stop

        Returns:
            loop_id: The stopped loop ID
            status: "stopping" or "not_found"
        """
        loop_id = params.get("loop_id")
        if not loop_id or not isinstance(loop_id, str):
            raise RpcError(INVALID_PARAMS, "Missing required parameter: loop_id")

        loop_info = self.daemon._active_loops.get(loop_id)
        if loop_info is None:
            raise RpcError(
                LOOP_NOT_FOUND,
                f"Loop not found: {loop_id}",
                {"loop_id": loop_id},
            )

        # Mark loop as stopping
        loop_info.status = "stopping"
        self._log.info("Stopping loop %s (task=%s)", loop_id, loop_info.task_name)

        # TODO: Actually stop the loop (abort opencode session, cleanup)
        # This will be implemented in US-006

        return {
            "loop_id": loop_id,
            "status": "stopping",
            "task_name": loop_info.task_name,
        }

    async def _handle_list_loops(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle list_loops request.

        Returns all active loops with status information.

        Returns:
            loops: List of loop info dicts
            count: Number of active loops
        """
        loops: list[dict[str, Any]] = []
        for loop_id, loop_info in self.daemon._active_loops.items():
            loops.append(
                {
                    "loop_id": loop_id,
                    "task_name": loop_info.task_name,
                    "task_dir": loop_info.task_dir,
                    "branch": loop_info.branch,
                    "iteration": loop_info.iteration,
                    "max_iterations": loop_info.max_iterations,
                    "agent": loop_info.agent,
                    "status": loop_info.status,
                    "started_at": loop_info.started_at,
                    "opencode_port": loop_info.opencode_port,
                    "worktree_path": loop_info.worktree_path,
                }
            )

        return {
            "loops": loops,
            "count": len(loops),
        }

    async def _handle_get_health(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle get_health request.

        Returns daemon health and resource information.

        Returns:
            hostname: Machine hostname
            started_at: Daemon start time
            uptime_seconds: Seconds since daemon start
            active_loops: Number of active loops
            max_concurrent_loops: Max allowed loops
            workspace_dir: Path to workspace directory
            ziti_status: Ziti connection status
            control_service: Control service name
            system: System resource info
        """
        health = self.daemon.get_health()

        # Calculate uptime
        uptime_seconds: float = 0
        if health.get("started_at"):
            started = datetime.datetime.fromisoformat(health["started_at"])
            uptime_seconds = (datetime.datetime.now() - started).total_seconds()

        # Get system resources
        system_info = self._get_system_info()

        return {
            **health,
            "uptime_seconds": uptime_seconds,
            "system": system_info,
        }

    async def _handle_get_agents(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle get_agents request.

        Returns available agent CLIs with version information.

        Returns:
            agents: List of agent info dicts
        """
        agent_infos = await self.agent_manager.get_all_agents()
        return {"agents": [info.to_dict() for info in agent_infos]}

    # --- Helper Methods ---

    def _extract_task_name(self, task_dir: str) -> str:
        """Extract task name from task directory path."""
        # Strip trailing slashes and get last component
        parts = task_dir.rstrip("/").split("/")
        return parts[-1] if parts else "unknown"

    def _get_system_info(self) -> dict[str, Any]:
        """Get system resource information."""
        info: dict[str, Any] = {
            "platform": platform.system(),
            "platform_release": platform.release(),
            "python_version": platform.python_version(),
        }

        # Try to get memory info (Linux)
        try:
            with open("/proc/meminfo") as f:
                meminfo = f.read()
                for line in meminfo.split("\n"):
                    if line.startswith("MemTotal:"):
                        info["memory_total_kb"] = int(line.split()[1])
                    elif line.startswith("MemAvailable:"):
                        info["memory_available_kb"] = int(line.split()[1])
        except (OSError, ValueError, IndexError):
            pass

        # Try to get load average
        try:
            load = os.getloadavg()
            info["load_avg_1m"] = load[0]
            info["load_avg_5m"] = load[1]
            info["load_avg_15m"] = load[2]
        except (OSError, AttributeError):
            pass

        return info

    # --- Response Helpers ---

    @staticmethod
    def _success_response(request_id: Any, result: Any) -> dict[str, Any]:
        """Build a JSON-RPC 2.0 success response."""
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": result,
        }

    @staticmethod
    def _error_response(
        request_id: Any, code: int, message: str, data: Any = None
    ) -> dict[str, Any]:
        """Build a JSON-RPC 2.0 error response."""
        error: dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": error,
        }


def format_response(response: dict[str, Any]) -> bytes:
    """Format a JSON-RPC response as NDJSON.

    Args:
        response: JSON-RPC response dict

    Returns:
        NDJSON-formatted bytes (JSON + newline)
    """
    return json.dumps(response, separators=(",", ":")).encode() + b"\n"
