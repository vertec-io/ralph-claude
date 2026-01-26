"""Ralph Daemon (ralphd) - Configuration and core daemon logic.

This module provides:
- Configuration loading from TOML and environment files
- Daemon lifecycle management
- Active loop registry
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import socket
import sys
import tomllib
from dataclasses import dataclass, field
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

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
    status: str  # "starting", "running", "stopping", "completed", "failed"
    started_at: str
    opencode_port: int | None = None
    opencode_pid: int | None = None
    worktree_path: str | None = None


class Daemon:
    """Ralph daemon that manages loop execution.

    The daemon:
    - Listens for control requests over Ziti
    - Manages git workspaces for incoming loop requests
    - Starts/stops opencode serve instances per loop
    - Tracks active loops and their status
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

    @property
    def active_loop_count(self) -> int:
        """Return the number of active loops."""
        return len(self._active_loops)

    @property
    def hostname(self) -> str:
        """Return the hostname for service naming."""
        return self._hostname

    def apply_environment(self) -> None:
        """Apply loaded environment variables to the process environment."""
        for key, value in self.config.env_vars.items():
            os.environ[key] = value
            self._log.debug("Set environment variable: %s", key)

    async def start(self) -> None:
        """Start the daemon.

        This method:
        1. Applies environment variables
        2. Sets up signal handlers
        3. Starts the main event loop
        """
        import datetime

        self._started_at = datetime.datetime.now().isoformat()
        self._log.info("Starting ralphd on %s", self._hostname)
        self._log.info("Workspace directory: %s", self.config.workspace_dir)
        self._log.info("Max concurrent loops: %d", self.config.max_concurrent_loops)

        # Apply environment variables
        self.apply_environment()

        # Ensure workspace directory exists
        self.config.workspace_dir.mkdir(parents=True, exist_ok=True)

        # Set up signal handlers
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, self._handle_shutdown_signal, sig)

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
        """Clean up active loops on shutdown."""
        if not self._active_loops:
            self._log.info("No active loops to clean up")
            return

        self._log.info("Stopping %d active loop(s)...", len(self._active_loops))

        # TODO: Implement proper cleanup once loop management is added
        # For now, just log that we would clean up
        for loop_id, info in self._active_loops.items():
            self._log.info(
                "Would stop loop %s (task: %s, iteration: %d)",
                loop_id,
                info.task_name,
                info.iteration,
            )

    def get_health(self) -> dict[str, Any]:
        """Return health/status information about the daemon."""
        return {
            "hostname": self._hostname,
            "started_at": self._started_at,
            "active_loops": self.active_loop_count,
            "max_concurrent_loops": self.config.max_concurrent_loops,
            "workspace_dir": str(self.config.workspace_dir),
        }
