"""Agent CLI detection, verification, and auto-installation.

This module handles:
- Detecting available agent CLIs (opencode, claude)
- Caching agent availability to avoid repeated filesystem lookups
- Auto-installing agents if missing
- Verifying installation success
"""

from __future__ import annotations

import asyncio
import datetime
import logging
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class AgentInfo:
    """Information about an agent CLI."""

    name: str
    available: bool
    path: str | None = None
    version: str | None = None
    install_attempted: bool = False
    install_error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize to dict for JSON-RPC response."""
        return {
            "name": self.name,
            "available": self.available,
            "path": self.path,
            "version": self.version,
        }


class AgentInstallError(Exception):
    """Exception raised when agent auto-install fails."""

    def __init__(self, agent: str, message: str, instructions: str) -> None:
        super().__init__(message)
        self.agent = agent
        self.message = message
        self.instructions = instructions


# Agent installation commands
AGENT_INSTALL_COMMANDS: dict[str, list[str]] = {
    "opencode": ["bash", "-c", "curl -fsSL https://opencode.ai/install | bash"],
    "claude": ["npm", "install", "-g", "@anthropic-ai/claude-code"],
}

# Manual installation instructions
AGENT_INSTALL_INSTRUCTIONS: dict[str, str] = {
    "opencode": (
        "Install opencode manually:\n"
        "  curl -fsSL https://opencode.ai/install | bash\n"
        "\n"
        "Or see: https://opencode.ai/docs/install"
    ),
    "claude": (
        "Install Claude Code manually:\n"
        "  npm install -g @anthropic-ai/claude-code\n"
        "\n"
        "Or see: https://docs.anthropic.com/claude-code"
    ),
}


class AgentManager:
    """Manages agent CLI detection, caching, and auto-installation.

    Provides methods to check agent availability, get version info,
    and attempt auto-installation of missing agents.
    """

    def __init__(self, cache_ttl_minutes: int = 5, auto_install: bool = True) -> None:
        """Initialize the agent manager.

        Args:
            cache_ttl_minutes: How long to cache agent availability (default: 5)
            auto_install: Whether to attempt auto-install for missing agents
        """
        self._log = logging.getLogger("ralphd.agents")
        self._cache: dict[str, AgentInfo] = {}
        self._cache_time: datetime.datetime | None = None
        self._cache_ttl = datetime.timedelta(minutes=cache_ttl_minutes)
        self._auto_install = auto_install
        self._install_lock = asyncio.Lock()

    def invalidate_cache(self) -> None:
        """Invalidate the agent cache, forcing re-check on next query."""
        self._cache.clear()
        self._cache_time = None
        self._log.debug("Agent cache invalidated")

    async def get_agent_info(
        self, agent_name: str, attempt_install: bool = True
    ) -> AgentInfo:
        """Get information about an agent CLI.

        Checks cache first, then filesystem. If the agent is not found
        and auto_install is enabled, attempts to install it.

        Args:
            agent_name: The agent to check ("opencode" or "claude")
            attempt_install: Whether to attempt auto-install if missing

        Returns:
            AgentInfo with availability, path, and version

        Raises:
            AgentInstallError: If auto-install was attempted but failed
        """
        # Check cache first
        now = datetime.datetime.now()
        if (
            self._cache_time is not None
            and now - self._cache_time < self._cache_ttl
            and agent_name in self._cache
        ):
            cached = self._cache[agent_name]
            # If cached as unavailable and install was previously attempted, don't retry
            if not cached.available and cached.install_attempted:
                raise AgentInstallError(
                    agent=agent_name,
                    message=cached.install_error or "Agent not available",
                    instructions=self._get_install_instructions(agent_name),
                )
            if cached.available:
                return cached

        # Check filesystem
        info = await self._check_agent(agent_name)

        if info.available:
            # Agent found - cache and return
            self._update_cache(agent_name, info)
            return info

        # Agent not found - attempt auto-install if enabled
        if attempt_install and self._auto_install:
            info = await self._attempt_install(agent_name)
            self._update_cache(agent_name, info)

            if not info.available:
                raise AgentInstallError(
                    agent=agent_name,
                    message=info.install_error or "Installation failed",
                    instructions=self._get_install_instructions(agent_name),
                )
            return info

        # No auto-install - just cache the unavailable state
        self._update_cache(agent_name, info)
        raise AgentInstallError(
            agent=agent_name,
            message=f"Agent '{agent_name}' is not installed",
            instructions=self._get_install_instructions(agent_name),
        )

    async def get_all_agents(self) -> list[AgentInfo]:
        """Get information about all known agents.

        Returns:
            List of AgentInfo for all agents (opencode, claude)
        """
        agents: list[AgentInfo] = []

        for agent_name in ["opencode", "claude"]:
            try:
                info = await self.get_agent_info(agent_name, attempt_install=False)
                agents.append(info)
            except AgentInstallError:
                # Agent not available - still include in list
                info = self._cache.get(agent_name) or AgentInfo(
                    name=agent_name, available=False
                )
                agents.append(info)

        return agents

    async def ensure_agent_available(self, agent_name: str) -> AgentInfo:
        """Ensure an agent is available, attempting install if needed.

        This is the main method to call before starting a loop with an agent.

        Args:
            agent_name: The agent to ensure is available

        Returns:
            AgentInfo with path and version

        Raises:
            AgentInstallError: If the agent is not available and can't be installed
        """
        return await self.get_agent_info(agent_name, attempt_install=True)

    def _update_cache(self, agent_name: str, info: AgentInfo) -> None:
        """Update the cache with agent info."""
        self._cache[agent_name] = info
        self._cache_time = datetime.datetime.now()

    async def _check_agent(self, agent_name: str) -> AgentInfo:
        """Check if an agent CLI is available and get its version.

        Args:
            agent_name: The agent to check

        Returns:
            AgentInfo with availability and version
        """
        # Use shutil.which to find the agent
        path = shutil.which(agent_name)
        if path is None:
            self._log.debug("Agent '%s' not found in PATH", agent_name)
            return AgentInfo(name=agent_name, available=False)

        self._log.debug("Agent '%s' found at: %s", agent_name, path)

        # Try to get version
        version = await self._get_agent_version(agent_name)

        return AgentInfo(
            name=agent_name,
            available=True,
            path=path,
            version=version,
        )

    async def _get_agent_version(self, agent_name: str) -> str | None:
        """Get the version of an agent CLI.

        Args:
            agent_name: The agent to get version for

        Returns:
            Version string or None if unable to determine
        """
        try:
            proc = await asyncio.create_subprocess_exec(
                agent_name,
                "--version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5.0)
            version = stdout.decode().strip().split("\n")[0][:100]
            return version if version else None
        except (TimeoutError, OSError) as e:
            self._log.debug("Failed to get version for %s: %s", agent_name, e)
            return None

    async def _attempt_install(self, agent_name: str) -> AgentInfo:
        """Attempt to auto-install an agent.

        Args:
            agent_name: The agent to install

        Returns:
            AgentInfo with the result (available=True if successful)
        """
        # Use lock to prevent concurrent install attempts
        async with self._install_lock:
            # Double-check after acquiring lock
            check = await self._check_agent(agent_name)
            if check.available:
                return check

            install_cmd = AGENT_INSTALL_COMMANDS.get(agent_name)
            if install_cmd is None:
                self._log.warning(
                    "No install command defined for agent: %s", agent_name
                )
                return AgentInfo(
                    name=agent_name,
                    available=False,
                    install_attempted=True,
                    install_error=f"No auto-install available for {agent_name}",
                )

            self._log.info("Attempting to auto-install agent: %s", agent_name)

            try:
                # Create environment with expanded PATH for npm/cargo
                env = os.environ.copy()
                # Add common bin directories to PATH
                extra_paths = [
                    str(Path.home() / ".local" / "bin"),
                    str(Path.home() / ".cargo" / "bin"),
                    str(Path.home() / ".npm-global" / "bin"),
                    "/usr/local/bin",
                ]
                env["PATH"] = ":".join(extra_paths) + ":" + env.get("PATH", "")

                proc = await asyncio.create_subprocess_exec(
                    *install_cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=env,
                )
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(),
                    timeout=300.0,  # 5 minute timeout for install
                )

                if proc.returncode != 0:
                    error_msg = stderr.decode().strip() or stdout.decode().strip()
                    self._log.error(
                        "Auto-install of %s failed (exit %d): %s",
                        agent_name,
                        proc.returncode,
                        error_msg[:500],
                    )
                    return AgentInfo(
                        name=agent_name,
                        available=False,
                        install_attempted=True,
                        install_error=(
                            f"Install command exited with code {proc.returncode}: "
                            f"{error_msg[:200]}"
                        ),
                    )

                self._log.info("Auto-install of %s completed, verifying...", agent_name)

            except TimeoutError:
                self._log.error("Auto-install of %s timed out", agent_name)
                return AgentInfo(
                    name=agent_name,
                    available=False,
                    install_attempted=True,
                    install_error="Installation timed out after 5 minutes",
                )
            except OSError as e:
                self._log.error("Auto-install of %s failed: %s", agent_name, e)
                return AgentInfo(
                    name=agent_name,
                    available=False,
                    install_attempted=True,
                    install_error=str(e),
                )

            # Verify installation succeeded
            verify = await self._check_agent(agent_name)
            if verify.available:
                self._log.info(
                    "Agent %s installed successfully at %s (version: %s)",
                    agent_name,
                    verify.path,
                    verify.version,
                )
                verify.install_attempted = True
                return verify

            self._log.error(
                "Agent %s install appeared to succeed but CLI not found in PATH",
                agent_name,
            )
            return AgentInfo(
                name=agent_name,
                available=False,
                install_attempted=True,
                install_error=(
                    f"Installation completed but '{agent_name}' not found in PATH. "
                    f"Try adding ~/.local/bin or ~/.cargo/bin to your PATH."
                ),
            )

    def _get_install_instructions(self, agent_name: str) -> str:
        """Get manual installation instructions for an agent."""
        return AGENT_INSTALL_INSTRUCTIONS.get(
            agent_name, f"Install {agent_name} and ensure it's in PATH"
        )
