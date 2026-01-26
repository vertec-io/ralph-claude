"""Ralph Daemon (ralphd) - Configuration and core daemon logic.

This module provides:
- Configuration loading from TOML and environment files
- Daemon lifecycle management
- Active loop registry with persistence
- Orphaned loop detection and cleanup on restart
- Ziti control service integration
- Event broadcasting to connected clients
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import socket
import sys
import tomllib
import weakref
from dataclasses import asdict, dataclass, field
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ralph_uv.daemon_loop import LoopDriver
    from ralph_uv.daemon_rpc import DaemonRpcHandler
    from ralph_uv.opencode_lifecycle import OpenCodeManager
    from ralph_uv.workspace import WorkspaceManager
    from ralph_uv.ziti import ZitiControlService, ZitiLoopServiceManager

# Default paths
DEFAULT_CONFIG_DIR = Path.home() / ".config" / "ralph"
DEFAULT_STATE_DIR = Path.home() / ".local" / "state" / "ralph-uv"
DEFAULT_WORKSPACE_DIR = Path.home() / "ralph-workspaces"

# Default config values
DEFAULT_MAX_CONCURRENT_LOOPS = 4
DEFAULT_LOOP_TIMEOUT_HOURS = 24
DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024  # 10MB
DEFAULT_LOG_BACKUP_COUNT = 5


@dataclass
class DaemonConfig:
    """Configuration for the Ralph daemon."""

    workspace_dir: Path = field(default_factory=lambda: DEFAULT_WORKSPACE_DIR)
    max_concurrent_loops: int = DEFAULT_MAX_CONCURRENT_LOOPS
    loop_timeout_hours: int = DEFAULT_LOOP_TIMEOUT_HOURS
    ziti_identity_path: Path | None = None
    log_file: Path = field(default_factory=lambda: DEFAULT_STATE_DIR / "daemon.log")
    log_max_bytes: int = DEFAULT_LOG_MAX_BYTES
    log_backup_count: int = DEFAULT_LOG_BACKUP_COUNT

    # Environment variables loaded from env file
    env_vars: dict[str, str] = field(default_factory=dict)


def load_config(
    config_path: Path | None = None,
    identity_override: Path | None = None,
    workspace_override: Path | None = None,
) -> DaemonConfig:
    """Load daemon configuration from TOML file and environment.

    Priority (highest to lowest):
    1. CLI flag overrides
    2. Config file values
    3. Default values

    Args:
        config_path: Path to config file (default: ~/.config/ralph/daemon.toml)
        identity_override: Override Ziti identity path from CLI
        workspace_override: Override workspace directory from CLI

    Returns:
        DaemonConfig with merged values
    """
    config = DaemonConfig()

    # Load from config file
    if config_path is None:
        config_path = DEFAULT_CONFIG_DIR / "daemon.toml"

    if config_path.is_file():
        _load_toml_config(config, config_path)

    # Load environment variables from env file
    env_file = DEFAULT_CONFIG_DIR / "env"
    if env_file.is_file():
        config.env_vars = _load_env_file(env_file)

    # Apply CLI overrides
    if identity_override:
        config.ziti_identity_path = identity_override
    if workspace_override:
        config.workspace_dir = workspace_override

    return config


def _load_toml_config(config: DaemonConfig, path: Path) -> None:
    """Load configuration from TOML file into config object."""
    try:
        with open(path, "rb") as f:
            data = tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError) as e:
        logging.warning("Failed to load config from %s: %s", path, e)
        return

    # Workspace directory
    if "workspace_dir" in data:
        config.workspace_dir = Path(data["workspace_dir"]).expanduser()

    # Max concurrent loops
    if "max_concurrent_loops" in data:
        val = data["max_concurrent_loops"]
        if isinstance(val, int) and val > 0:
            config.max_concurrent_loops = val

    # Loop timeout
    if "loop_timeout_hours" in data:
        val = data["loop_timeout_hours"]
        if isinstance(val, int) and val > 0:
            config.loop_timeout_hours = val

    # Ziti identity path
    if "ziti_identity_path" in data:
        config.ziti_identity_path = Path(data["ziti_identity_path"]).expanduser()

    # Logging config
    if "log" in data and isinstance(data["log"], dict):
        log_config = data["log"]
        if "file" in log_config:
            config.log_file = Path(log_config["file"]).expanduser()
        if "max_bytes" in log_config:
            val = log_config["max_bytes"]
            if isinstance(val, int) and val > 0:
                config.log_max_bytes = val
        if "backup_count" in log_config:
            val = log_config["backup_count"]
            if isinstance(val, int) and val >= 0:
                config.log_backup_count = val


def _load_env_file(path: Path) -> dict[str, str]:
    """Load environment variables from a shell-style env file.

    Supports:
    - KEY=value
    - KEY="value with spaces"
    - KEY='value with spaces'
    - export KEY=value
    - # comments
    """
    env_vars: dict[str, str] = {}

    try:
        content = path.read_text()
    except OSError as e:
        logging.warning("Failed to read env file %s: %s", path, e)
        return env_vars

    for line in content.splitlines():
        line = line.strip()

        # Skip empty lines and comments
        if not line or line.startswith("#"):
            continue

        # Remove 'export ' prefix if present
        if line.startswith("export "):
            line = line[7:].strip()

        # Split on first '='
        if "=" not in line:
            continue

        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()

        # Remove surrounding quotes
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]

        if key:
            env_vars[key] = value

    return env_vars


def setup_logging(config: DaemonConfig) -> logging.Logger:
    """Set up logging with rotation to the daemon log file.

    Args:
        config: Daemon configuration

    Returns:
        Configured logger instance
    """
    # Ensure log directory exists
    config.log_file.parent.mkdir(parents=True, exist_ok=True)

    # Create logger
    logger = logging.getLogger("ralphd")
    logger.setLevel(logging.DEBUG)

    # Clear any existing handlers
    logger.handlers.clear()

    # Create rotating file handler
    file_handler = RotatingFileHandler(
        config.log_file,
        maxBytes=config.log_max_bytes,
        backupCount=config.log_backup_count,
    )
    file_handler.setLevel(logging.DEBUG)

    # Create console handler for INFO and above
    console_handler = logging.StreamHandler(sys.stderr)
    console_handler.setLevel(logging.INFO)

    # Create formatter
    formatter = logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    file_handler.setFormatter(formatter)
    console_handler.setFormatter(formatter)

    # Add handlers
    logger.addHandler(file_handler)
    logger.addHandler(console_handler)

    return logger


@dataclass
class LoopInfo:
    """Information about an active loop."""

    loop_id: str
    task_name: str
    task_dir: str
    branch: str
    iteration: int
    max_iterations: int
    agent: str
    status: str  # "starting", "running", "stopping", "completed", "failed", "timed_out"
    started_at: str
    opencode_port: int | None = None
    opencode_pid: int | None = None
    worktree_path: str | None = None
    ziti_service_name: str | None = None  # Ziti service for client attachment
    push_frequency: int = 1  # Push after every N iterations (default: 1)
    final_story: str | None = None  # Last completed story ID (for completion events)
    last_error: str | None = None  # Error message (for failure events)
    timeout_hours: float = 24.0  # Per-loop timeout in hours (default: 24h)


@dataclass
class LoopEvent:
    """An event about a loop's status change.

    Events are broadcast to all connected clients subscribed to events.
    """

    type: str  # "loop_completed" or "loop_failed"
    loop_id: str
    task_name: str
    status: str  # "completed", "exhausted", "failed"
    iterations_used: int
    branch: str
    final_story: str | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to JSON-serializable dict."""
        data: dict[str, Any] = {
            "type": self.type,
            "loop_id": self.loop_id,
            "task_name": self.task_name,
            "status": self.status,
            "iterations_used": self.iterations_used,
            "branch": self.branch,
        }
        if self.final_story is not None:
            data["final_story"] = self.final_story
        if self.error is not None:
            data["error"] = self.error
        return data


class LoopRegistry:
    """Persists active loop information to disk for orphan detection.

    On daemon restart, we can detect orphaned loops (processes that died
    without proper cleanup) and either re-adopt them or clean them up.

    The registry file is stored at ~/.local/state/ralph-uv/loop_registry.json
    """

    def __init__(self, registry_path: Path | None = None) -> None:
        """Initialize the loop registry.

        Args:
            registry_path: Path to registry file (default: ~/.local/state/ralph-uv/loop_registry.json)
        """
        self._log = logging.getLogger("ralphd.registry")
        self._path = registry_path or (DEFAULT_STATE_DIR / "loop_registry.json")
        self._loops: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()

    async def load(self) -> list[dict[str, Any]]:
        """Load registry from disk.

        Returns:
            List of orphaned loop entries (loops that were running when daemon died)
        """
        async with self._lock:
            if not self._path.is_file():
                self._loops = {}
                return []

            try:
                content = self._path.read_text()
                data = json.loads(content)
                if not isinstance(data, dict):
                    self._loops = {}
                    return []

                self._loops = data.get("loops", {})
                # Return all loops as potential orphans (they were "active" when saved)
                orphans = list(self._loops.values())
                self._log.info(
                    "Loaded registry with %d potential orphan(s)", len(orphans)
                )
                return orphans
            except (OSError, json.JSONDecodeError) as e:
                self._log.warning("Failed to load registry: %s", e)
                self._loops = {}
                return []

    async def save(self) -> None:
        """Save registry to disk."""
        async with self._lock:
            try:
                self._path.parent.mkdir(parents=True, exist_ok=True)
                data = {"loops": self._loops}
                self._path.write_text(json.dumps(data, indent=2))
            except OSError as e:
                self._log.warning("Failed to save registry: %s", e)

    async def register_loop(self, loop_info: LoopInfo) -> None:
        """Register an active loop."""
        async with self._lock:
            # Convert LoopInfo to dict for JSON serialization
            self._loops[loop_info.loop_id] = {
                "loop_id": loop_info.loop_id,
                "task_name": loop_info.task_name,
                "task_dir": loop_info.task_dir,
                "branch": loop_info.branch,
                "iteration": loop_info.iteration,
                "max_iterations": loop_info.max_iterations,
                "agent": loop_info.agent,
                "status": loop_info.status,
                "started_at": loop_info.started_at,
                "opencode_port": loop_info.opencode_port,
                "opencode_pid": loop_info.opencode_pid,
                "worktree_path": loop_info.worktree_path,
                "timeout_hours": loop_info.timeout_hours,
            }
        await self.save()
        self._log.debug("Registered loop %s", loop_info.loop_id)

    async def update_loop(self, loop_id: str, updates: dict[str, Any]) -> None:
        """Update a loop's registry entry."""
        async with self._lock:
            if loop_id in self._loops:
                self._loops[loop_id].update(updates)
        await self.save()

    async def unregister_loop(self, loop_id: str) -> None:
        """Remove a loop from the registry."""
        async with self._lock:
            if loop_id in self._loops:
                del self._loops[loop_id]
                self._log.debug("Unregistered loop %s", loop_id)
        await self.save()

    async def clear(self) -> None:
        """Clear all loops from registry."""
        async with self._lock:
            self._loops.clear()
        await self.save()


async def cleanup_orphaned_loop(
    orphan: dict[str, Any],
    workspace_dir: Path,
    log: logging.Logger,
) -> None:
    """Clean up an orphaned loop.

    Attempts to:
    1. Kill any orphaned opencode serve process
    2. Clean up worktree if it exists

    Args:
        orphan: Orphaned loop info from registry
        workspace_dir: Base workspace directory
        log: Logger instance
    """
    loop_id = orphan.get("loop_id", "unknown")
    pid = orphan.get("opencode_pid")
    worktree_path = orphan.get("worktree_path")

    log.info("Cleaning up orphaned loop %s (pid=%s)", loop_id, pid)

    # Try to kill orphaned process
    if pid:
        try:
            # Check if process is still running
            os.kill(pid, 0)  # Signal 0 = check existence
            log.info("Killing orphaned process %d for loop %s", pid, loop_id)
            # Try SIGTERM first
            os.kill(pid, signal.SIGTERM)
            # Wait a bit then SIGKILL if needed
            await asyncio.sleep(2.0)
            try:
                os.kill(pid, 0)
                # Still alive, use SIGKILL
                os.kill(pid, signal.SIGKILL)
                log.info("Sent SIGKILL to orphaned process %d", pid)
            except OSError:
                pass  # Process already dead
        except OSError:
            # Process doesn't exist (already dead)
            log.debug("Orphaned process %d for loop %s no longer exists", pid, loop_id)

    # Note: We don't clean up worktrees here because git worktree prune
    # handles stale worktrees on daemon startup. The worktree might be
    # useful for debugging anyway.
    if worktree_path:
        log.debug(
            "Orphaned loop %s had worktree at %s (not removing)", loop_id, worktree_path
        )


class EventBroadcaster:
    """Broadcasts events to all subscribed clients.

    Manages a set of subscribed StreamWriters and broadcasts events
    as NDJSON-formatted JSON-RPC 2.0 notifications.

    Events are NOT queued - if no clients are connected, events are
    only logged and discarded.
    """

    def __init__(self) -> None:
        """Initialize the event broadcaster."""
        self._log = logging.getLogger("ralphd.events")
        # Use weakref to avoid keeping dead connections alive
        self._subscribers: set[asyncio.StreamWriter] = set()
        self._lock = asyncio.Lock()

    @property
    def subscriber_count(self) -> int:
        """Return the number of subscribed clients."""
        return len(self._subscribers)

    async def subscribe(self, writer: asyncio.StreamWriter) -> None:
        """Subscribe a client to receive events.

        Args:
            writer: StreamWriter for the client connection
        """
        async with self._lock:
            self._subscribers.add(writer)
            self._log.debug(
                "Client subscribed to events (total: %d)",
                len(self._subscribers),
            )

    async def unsubscribe(self, writer: asyncio.StreamWriter) -> None:
        """Unsubscribe a client from events.

        Args:
            writer: StreamWriter for the client connection
        """
        async with self._lock:
            self._subscribers.discard(writer)
            self._log.debug(
                "Client unsubscribed from events (total: %d)",
                len(self._subscribers),
            )

    async def broadcast(self, event: LoopEvent) -> int:
        """Broadcast an event to all subscribed clients.

        Events are sent as JSON-RPC 2.0 notifications (no id field).
        If no clients are subscribed, the event is logged but not queued.

        Args:
            event: The event to broadcast

        Returns:
            Number of clients that received the event
        """
        event_dict = event.to_dict()

        # Log the event
        self._log.info(
            "Broadcasting event: %s (loop_id=%s, status=%s)",
            event.type,
            event.loop_id,
            event.status,
        )

        async with self._lock:
            if not self._subscribers:
                self._log.debug("No clients subscribed - event not sent")
                return 0

            # Build JSON-RPC 2.0 notification (no id field)
            notification = {
                "jsonrpc": "2.0",
                "method": "event",
                "params": event_dict,
            }
            data = json.dumps(notification, separators=(",", ":")).encode() + b"\n"

            # Send to all subscribers, remove dead ones
            dead_writers: list[asyncio.StreamWriter] = []
            sent_count = 0

            for writer in self._subscribers:
                try:
                    writer.write(data)
                    await writer.drain()
                    sent_count += 1
                except Exception as e:
                    self._log.debug("Failed to send event to client: %s", e)
                    dead_writers.append(writer)

            # Clean up dead connections
            for writer in dead_writers:
                self._subscribers.discard(writer)

            self._log.debug(
                "Event sent to %d client(s) (removed %d dead)",
                sent_count,
                len(dead_writers),
            )
            return sent_count


class DaemonConnectionHandler:
    """Handler for incoming control service connections.

    This implements the ConnectionHandler protocol from ziti.py and
    handles JSON-RPC requests from clients. It also supports event
    subscription via the subscribe_events RPC method.
    """

    def __init__(self, daemon: Daemon) -> None:
        """Initialize the connection handler.

        Args:
            daemon: The daemon instance to handle requests for
        """
        self.daemon = daemon
        self._log = logging.getLogger("ralphd.handler")
        self._rpc_handler: DaemonRpcHandler | None = None

    def _get_rpc_handler(self) -> DaemonRpcHandler:
        """Get or create the RPC handler (lazy initialization)."""
        if self._rpc_handler is None:
            from ralph_uv.daemon_rpc import DaemonRpcHandler

            self._rpc_handler = DaemonRpcHandler(self.daemon)
        return self._rpc_handler

    async def handle_connection(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        """Handle an incoming connection.

        Reads NDJSON-framed JSON-RPC requests and sends responses.
        Clients can subscribe to events using the subscribe_events method.

        Args:
            reader: Stream reader for receiving data
            writer: Stream writer for sending data
        """
        from ralph_uv.daemon_rpc import format_response

        self._log.debug("New connection established")
        rpc_handler = self._get_rpc_handler()
        subscribed = False

        try:
            while True:
                # Read a line (NDJSON framing)
                line = await reader.readline()
                if not line:
                    # Connection closed
                    break

                raw_request = line.decode().strip()
                if not raw_request:
                    continue

                self._log.debug("Received request: %s", raw_request[:200])

                # Check for subscribe_events to handle subscription
                try:
                    request = json.loads(raw_request)
                    if request.get("method") == "subscribe_events":
                        if not subscribed:
                            await self.daemon.event_broadcaster.subscribe(writer)
                            subscribed = True
                            self._log.debug("Client subscribed to events")
                        # Send success response
                        subscribe_response: dict[str, Any] = {
                            "jsonrpc": "2.0",
                            "id": request.get("id"),
                            "result": {"subscribed": True},
                        }
                        writer.write(format_response(subscribe_response))
                        await writer.drain()
                        continue
                except json.JSONDecodeError:
                    pass

                # Process the JSON-RPC request
                response: dict[str, Any] | None = await rpc_handler.handle_request(
                    raw_request
                )

                # Send response (skip for notifications which return None)
                if response is not None:
                    writer.write(format_response(response))
                    await writer.drain()

        except asyncio.CancelledError:
            self._log.debug("Connection handler cancelled")
            raise
        except Exception as e:
            self._log.exception("Error handling connection: %s", e)
        finally:
            # Unsubscribe if subscribed
            if subscribed:
                await self.daemon.event_broadcaster.unsubscribe(writer)
                self._log.debug("Client unsubscribed from events on disconnect")

            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass


class Daemon:
    """Ralph daemon that manages loop execution.

    The daemon:
    - Listens for control requests over Ziti
    - Manages git workspaces for incoming loop requests
    - Starts/stops opencode serve instances per loop
    - Tracks active loops and their status
    - Persists loop registry for orphan detection on restart
    """

    def __init__(self, config: DaemonConfig) -> None:
        """Initialize the daemon.

        Args:
            config: Daemon configuration
        """
        self.config = config
        self._log = logging.getLogger("ralphd")
        self._active_loops: dict[str, LoopInfo] = {}
        self._shutdown_event = asyncio.Event()
        self._hostname = socket.gethostname()
        self._started_at: str | None = None
        self._control_service: ZitiControlService | None = None
        self._connection_handler: DaemonConnectionHandler | None = None
        self._workspace_manager: WorkspaceManager | None = None
        self._opencode_manager: OpenCodeManager | None = None
        self._loop_driver: LoopDriver | None = None
        self._loop_service_manager: ZitiLoopServiceManager | None = None
        self._event_broadcaster: EventBroadcaster | None = None
        self._loop_registry: LoopRegistry | None = None

    @property
    def active_loop_count(self) -> int:
        """Return the number of active loops."""
        return len(self._active_loops)

    @property
    def hostname(self) -> str:
        """Return the hostname for service naming."""
        return self._hostname

    @property
    def control_service_name(self) -> str:
        """Return the control service name."""
        return f"ralph-control-{self._hostname}"

    @property
    def ziti_enabled(self) -> bool:
        """Return True if Ziti is configured and available."""
        return self.config.ziti_identity_path is not None

    @property
    def workspace_manager(self) -> WorkspaceManager:
        """Return the workspace manager, creating it if needed."""
        if self._workspace_manager is None:
            from ralph_uv.workspace import WorkspaceManager

            self._workspace_manager = WorkspaceManager(self.config.workspace_dir)
        return self._workspace_manager

    @property
    def opencode_manager(self) -> OpenCodeManager:
        """Return the opencode manager, creating it if needed."""
        if self._opencode_manager is None:
            from ralph_uv.opencode_lifecycle import OpenCodeManager

            self._opencode_manager = OpenCodeManager(
                env_vars=self.config.env_vars,
            )
        return self._opencode_manager

    @property
    def loop_driver(self) -> LoopDriver:
        """Return the loop driver, creating it if needed."""
        if self._loop_driver is None:
            from ralph_uv.daemon_loop import LoopDriver

            self._loop_driver = LoopDriver(
                daemon=self,
                opencode_manager=self.opencode_manager,
            )
        return self._loop_driver

    @property
    def event_broadcaster(self) -> EventBroadcaster:
        """Return the event broadcaster, creating it if needed."""
        if self._event_broadcaster is None:
            self._event_broadcaster = EventBroadcaster()
        return self._event_broadcaster

    @property
    def loop_service_manager(self) -> ZitiLoopServiceManager | None:
        """Return the Ziti loop service manager, creating it if Ziti is enabled.

        Returns None if Ziti is not configured.
        """
        if not self.ziti_enabled:
            return None

        if self._loop_service_manager is None:
            from ralph_uv.ziti import ZitiLoopServiceManager, check_ziti_available

            if not check_ziti_available():
                return None

            assert self.config.ziti_identity_path is not None
            self._loop_service_manager = ZitiLoopServiceManager(
                identity_path=self.config.ziti_identity_path,
                hostname=self._hostname,
            )
        return self._loop_service_manager

    @property
    def loop_registry(self) -> LoopRegistry:
        """Return the loop registry, creating it if needed."""
        if self._loop_registry is None:
            self._loop_registry = LoopRegistry()
        return self._loop_registry

    def apply_environment(self) -> None:
        """Apply loaded environment variables to the process environment."""
        for key, value in self.config.env_vars.items():
            os.environ[key] = value
            self._log.debug("Set environment variable: %s", key)

    async def _start_ziti_control_service(self) -> bool:
        """Start the Ziti control service.

        Returns:
            True if started successfully, False otherwise
        """
        if not self.ziti_enabled:
            self._log.info("Ziti not configured - skipping control service")
            return True

        from ralph_uv.ziti import ZitiControlService, check_ziti_available

        if not check_ziti_available():
            self._log.warning(
                "openziti package not installed - control service disabled"
            )
            return True

        assert self.config.ziti_identity_path is not None

        # Create connection handler
        self._connection_handler = DaemonConnectionHandler(self)

        # Create and start control service
        self._control_service = ZitiControlService(
            identity_path=self.config.ziti_identity_path,
            hostname=self._hostname,
            handler=self._connection_handler,
        )

        self._log.info(
            "Starting Ziti control service: %s", self._control_service.service_name
        )

        if not await self._control_service.start():
            self._log.error("Failed to start Ziti control service")
            return False

        self._log.info(
            "Ziti control service started: %s", self._control_service.service_name
        )
        return True

    async def start(self) -> None:
        """Start the daemon.

        This method:
        1. Loads loop registry and cleans up orphaned loops from previous runs
        2. Applies environment variables
        3. Sets up signal handlers
        4. Starts the Ziti control service (if configured)
        5. Waits for shutdown signal
        """
        import datetime

        self._started_at = datetime.datetime.now().isoformat()
        self._log.info("Starting ralphd on %s", self._hostname)
        self._log.info("Workspace directory: %s", self.config.workspace_dir)
        self._log.info("Max concurrent loops: %d", self.config.max_concurrent_loops)
        self._log.info("Loop timeout: %d hours", self.config.loop_timeout_hours)

        if self.config.ziti_identity_path:
            self._log.info("Ziti identity: %s", self.config.ziti_identity_path)
        else:
            self._log.info("Ziti not configured (no identity path)")

        # Apply environment variables
        self.apply_environment()

        # Ensure workspace directory exists
        self.config.workspace_dir.mkdir(parents=True, exist_ok=True)

        # Load loop registry and clean up orphans from previous runs
        orphans = await self.loop_registry.load()
        if orphans:
            self._log.info("Found %d orphaned loop(s) from previous run", len(orphans))
            for orphan in orphans:
                await cleanup_orphaned_loop(
                    orphan, self.config.workspace_dir, self._log
                )
            # Clear the registry after cleanup
            await self.loop_registry.clear()
            self._log.info("Orphan cleanup complete")

        # Prune stale worktrees on startup
        await self.workspace_manager.prune_stale_worktrees()

        # Set up signal handlers
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, self._handle_shutdown_signal, sig)

        # Start Ziti control service
        if not await self._start_ziti_control_service():
            self._log.error("Failed to start - exiting")
            return

        self._log.info("Daemon started, waiting for shutdown signal...")

        # Wait for shutdown
        await self._shutdown_event.wait()

        self._log.info("Shutdown signal received, cleaning up...")
        await self._cleanup()
        self._log.info("Daemon stopped")

    def _handle_shutdown_signal(self, sig: signal.Signals) -> None:
        """Handle shutdown signal (SIGTERM/SIGINT)."""
        self._log.info("Received signal %s", sig.name)
        self._shutdown_event.set()

    async def _cleanup(self) -> None:
        """Clean up active loops and Ziti services on shutdown."""
        # Stop all opencode instances
        if self._opencode_manager is not None:
            self._log.info("Stopping all opencode instances...")
            await self._opencode_manager.stop_all()

        # Shutdown all loop Ziti services
        if self._loop_service_manager is not None:
            self._log.info("Shutting down all loop Ziti services...")
            await self._loop_service_manager.shutdown_all()
            self._loop_service_manager = None

        # Clean up Ziti control service
        if self._control_service is not None:
            self._log.info("Shutting down Ziti control service...")
            await self._control_service.shutdown()
            self._control_service = None

        # Log active loops that are being cleaned up
        if self._active_loops:
            self._log.info("Cleaning up %d active loop(s)...", len(self._active_loops))
            for loop_id, info in self._active_loops.items():
                self._log.info(
                    "Loop %s stopped (task: %s, iteration: %d)",
                    loop_id,
                    info.task_name,
                    info.iteration,
                )
            self._active_loops.clear()
        else:
            self._log.info("No active loops to clean up")

        # Clear loop registry on clean shutdown (no orphans)
        if self._loop_registry is not None:
            await self._loop_registry.clear()
            self._log.info("Loop registry cleared")

    def get_health(self) -> dict[str, Any]:
        """Return health/status information about the daemon."""
        ziti_status = "disabled"
        if self._control_service is not None:
            ziti_status = "bound" if self._control_service.is_bound else "not_bound"
        elif self.ziti_enabled:
            ziti_status = "configured"

        return {
            "hostname": self._hostname,
            "started_at": self._started_at,
            "active_loops": self.active_loop_count,
            "max_concurrent_loops": self.config.max_concurrent_loops,
            "workspace_dir": str(self.config.workspace_dir),
            "ziti_status": ziti_status,
            "control_service": self.control_service_name if self.ziti_enabled else None,
        }
