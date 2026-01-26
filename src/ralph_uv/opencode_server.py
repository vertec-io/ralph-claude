"""OpenCode server mode for ralph-uv.

Manages an opencode serve process and provides HTTP client methods for
the loop runner to interact with it. This replaces the tmux-based approach
when agent=opencode, giving users the native opencode TUI via `opencode attach`.

Architecture:
- start(): Spawns `opencode serve --port <port>` as a subprocess
- health_check(): Verifies GET /global/health returns OK
- create_session(): Creates a new opencode session
- send_prompt(): Sends a prompt via POST /session/:id/message
- wait_for_idle(): Monitors SSE events for session.idle
- abort_session(): Stops processing via POST /session/:id/abort
- stop(): Kills the opencode serve process

The server stores sessions in ~/.opencode/data/storage/ (filesystem).
Multiple clients can connect simultaneously (SSE broadcast).
"""

from __future__ import annotations

import json
import logging
import os
import signal
import socket
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen


def _get_logger() -> logging.Logger:
    """Get or create the opencode-server logger."""
    logger = logging.getLogger("ralph_uv.opencode_server")
    if not logger.handlers:
        log_dir = Path.home() / ".local" / "state" / "ralph-uv"
        log_dir.mkdir(parents=True, exist_ok=True)
        handler = logging.FileHandler(log_dir / "opencode-server.log")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logger.addHandler(handler)
        logger.setLevel(logging.DEBUG)
    return logger


# Port range for auto-assignment
PORT_RANGE_START = 14096
PORT_RANGE_END = 14196

# Timeouts
HEALTH_CHECK_TIMEOUT = 30  # seconds to wait for server to become healthy
HEALTH_CHECK_INTERVAL = 0.5  # seconds between health check attempts
HTTP_TIMEOUT = 30  # seconds for HTTP requests
SSE_POLL_INTERVAL = 0.5  # seconds between SSE read attempts


class OpencodeServerError(Exception):
    """Raised when an opencode server operation fails."""


@dataclass
class OpencodeSession:
    """Represents an opencode session on the server."""

    session_id: str
    url: str


class OpencodeServer:
    """Manages an opencode serve process and provides HTTP client methods.

    Usage:
        server = OpencodeServer(working_dir=Path("/path/to/project"))
        server.start()
        server.wait_until_healthy()
        session = server.create_session()
        server.send_prompt(session.session_id, "implement feature X")
        server.wait_for_idle(session.session_id)
        server.stop()
    """

    def __init__(
        self,
        working_dir: Path,
        port: int | None = None,
        model: str = "",
        password: str = "",
        verbose: bool = False,
    ) -> None:
        self.working_dir = working_dir
        self.port = port or self._find_free_port()
        self.model = model
        self.password = password
        self.verbose = verbose
        self._process: subprocess.Popen[str] | None = None
        self._log = _get_logger()
        self._base_url = f"http://127.0.0.1:{self.port}"

    @property
    def pid(self) -> int | None:
        """PID of the opencode serve process, or None if not running."""
        if self._process is not None:
            return self._process.pid
        return None

    @property
    def is_running(self) -> bool:
        """Check if the server process is still running."""
        if self._process is None:
            return False
        return self._process.poll() is None

    @property
    def url(self) -> str:
        """The base URL of the running server."""
        return self._base_url

    def start(self) -> None:
        """Start the opencode serve process.

        Raises OpencodeServerError if the process fails to start.
        """
        if self._process is not None and self.is_running:
            raise OpencodeServerError("Server is already running")

        cmd = self._build_command()
        env = self._build_env()

        self._log.info(
            "Starting opencode serve: port=%d, cwd=%s, cmd=%s",
            self.port,
            self.working_dir,
            " ".join(cmd),
        )

        try:
            self._process = subprocess.Popen(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
                cwd=str(self.working_dir),
                # Start in new process group so we can kill it cleanly
                preexec_fn=os.setsid,
            )
            self._log.info("opencode serve started, pid=%d", self._process.pid)
        except OSError as e:
            raise OpencodeServerError(f"Failed to start opencode serve: {e}") from e

    def wait_until_healthy(self, timeout: float = HEALTH_CHECK_TIMEOUT) -> None:
        """Wait until the server responds to health checks.

        Polls GET /global/health until it returns 200, or raises
        OpencodeServerError if timeout is exceeded.
        """
        deadline = time.time() + timeout
        self._log.info("Waiting for health check (timeout=%.1fs)...", timeout)

        while time.time() < deadline:
            if not self.is_running:
                # Process died during startup
                stderr = ""
                if self._process is not None and self._process.stderr:
                    stderr = self._process.stderr.read()
                raise OpencodeServerError(
                    f"opencode serve died during startup. "
                    f"Exit code: {self._process.returncode if self._process else '?'}. "
                    f"Stderr: {stderr[:500]}"
                )

            if self._health_check():
                self._log.info("Health check passed")
                return

            time.sleep(HEALTH_CHECK_INTERVAL)

        raise OpencodeServerError(
            f"Health check timeout after {timeout}s. "
            f"Server at {self._base_url} not responding."
        )

    def create_session(self) -> OpencodeSession:
        """Create a new opencode session.

        Returns an OpencodeSession with the session ID.
        """
        url = f"{self._base_url}/session"
        self._log.info("Creating session: POST %s", url)

        response = self._http_post(url, {})
        session_id = response.get("id", "")
        if not session_id:
            raise OpencodeServerError(
                f"Failed to create session: no ID in response: {response}"
            )

        self._log.info("Session created: %s", session_id)
        return OpencodeSession(
            session_id=session_id,
            url=f"{self._base_url}/session/{session_id}",
        )

    def send_prompt(self, session_id: str, prompt: str) -> dict[str, Any]:
        """Send a prompt to a session synchronously.

        Uses POST /session/:id/message which blocks until the agent responds.
        Returns the response data.

        The opencode serve API expects a payload with a `parts` array:
        {"parts": [{"type": "text", "text": "..."}]}
        """
        url = f"{self._base_url}/session/{session_id}/message"
        self._log.info(
            "Sending prompt to session %s (length=%d)", session_id, len(prompt)
        )

        # OpenCode API expects parts array format
        payload = {"parts": [{"type": "text", "text": prompt}]}

        response = self._http_post(
            url,
            payload,
            timeout=None,  # No timeout for sync prompts
        )
        self._log.info("Prompt response received for session %s", session_id)
        return response

    def send_prompt_async(self, session_id: str, prompt: str) -> dict[str, Any]:
        """Send a prompt asynchronously (non-blocking).

        Uses POST /session/:id/prompt_async which returns immediately.
        Use wait_for_idle() to detect completion.

        The opencode serve API expects a payload with a `parts` array:
        {"parts": [{"type": "text", "text": "..."}]}
        """
        url = f"{self._base_url}/session/{session_id}/prompt_async"
        self._log.info(
            "Sending async prompt to session %s (length=%d)", session_id, len(prompt)
        )

        # OpenCode API expects parts array format
        payload = {"parts": [{"type": "text", "text": prompt}]}

        response = self._http_post(url, payload)
        self._log.info("Async prompt accepted for session %s", session_id)
        return response

    def wait_for_idle(
        self,
        session_id: str,
        timeout: float | None = None,
        check_interval: float = SSE_POLL_INTERVAL,
    ) -> bool:
        """Wait for a session to become idle via SSE events.

        Connects to GET /event and watches for session.idle events
        matching the given session_id.

        Args:
            session_id: The session to monitor.
            timeout: Maximum seconds to wait (None = no timeout).
            check_interval: Seconds between polling the stream.

        Returns:
            True if idle was detected, False if timeout/error.
        """
        url = f"{self._base_url}/event"
        self._log.info(
            "Waiting for session.idle: session=%s, timeout=%s",
            session_id,
            timeout,
        )

        deadline = time.time() + timeout if timeout else None

        try:
            req = self._build_request(url, method="GET")
            req.add_header("Accept", "text/event-stream")
            req.add_header("Cache-Control", "no-cache")

            with urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                # Read SSE stream line by line
                buffer = ""
                event_type = ""
                event_data = ""

                while True:
                    if deadline and time.time() > deadline:
                        self._log.warning("wait_for_idle: timeout reached")
                        return False

                    if not self.is_running:
                        self._log.error(
                            "wait_for_idle: server process died while waiting"
                        )
                        return False

                    # Read available data (non-blocking would be ideal but
                    # urllib doesn't support it well, so we use a short timeout)
                    try:
                        chunk = resp.read(4096)
                        if not chunk:
                            # Connection closed
                            self._log.warning("wait_for_idle: SSE connection closed")
                            return False
                        buffer += chunk.decode("utf-8", errors="replace")
                    except TimeoutError:
                        # No data available yet, continue polling
                        time.sleep(check_interval)
                        continue

                    # Parse SSE events from buffer
                    while "\n\n" in buffer:
                        event_block, buffer = buffer.split("\n\n", 1)
                        lines = event_block.strip().split("\n")

                        event_type = ""
                        event_data = ""
                        for line in lines:
                            if line.startswith("event:"):
                                event_type = line[6:].strip()
                            elif line.startswith("data:"):
                                event_data = line[5:].strip()

                        if event_type == "session.idle":
                            try:
                                data = json.loads(event_data) if event_data else {}
                                idle_session = data.get("sessionID", "")
                                if idle_session == session_id or not idle_session:
                                    self._log.info(
                                        "wait_for_idle: session.idle received "
                                        "for session %s",
                                        session_id,
                                    )
                                    return True
                            except json.JSONDecodeError:
                                # If we can't parse, treat any session.idle as ours
                                self._log.info(
                                    "wait_for_idle: session.idle received (unparsed)"
                                )
                                return True

        except (URLError, OSError, TimeoutError) as e:
            self._log.error("wait_for_idle: SSE connection error: %s", e)
            return False

    def abort_session(self, session_id: str) -> bool:
        """Abort a running session.

        Uses POST /session/:id/abort to stop processing.
        Returns True if successful.
        """
        url = f"{self._base_url}/session/{session_id}/abort"
        self._log.info("Aborting session: %s", session_id)

        try:
            self._http_post(url, {})
            self._log.info("Session %s aborted successfully", session_id)
            return True
        except OpencodeServerError as e:
            self._log.error("Failed to abort session %s: %s", session_id, e)
            return False

    def stop(self) -> None:
        """Stop the opencode serve process.

        Sends SIGTERM, waits briefly, then SIGKILL if needed.
        """
        if self._process is None:
            return

        if not self.is_running:
            self._log.info(
                "Server already stopped (exit_code=%s)", self._process.returncode
            )
            self._process = None
            return

        pid = self._process.pid
        self._log.info("Stopping opencode serve, pid=%d", pid)

        try:
            # Send SIGTERM to the process group
            os.killpg(os.getpgid(pid), signal.SIGTERM)
            try:
                self._process.wait(timeout=10)
                self._log.info("Server stopped cleanly")
            except subprocess.TimeoutExpired:
                self._log.warning("SIGTERM timeout, sending SIGKILL")
                os.killpg(os.getpgid(pid), signal.SIGKILL)
                self._process.wait(timeout=5)
        except (OSError, ProcessLookupError) as e:
            self._log.warning("Error stopping server: %s", e)

        self._process = None

    # --- Private Methods ---

    def _build_command(self) -> list[str]:
        """Build the opencode serve command."""
        cmd = [
            "opencode",
            "serve",
            "--port",
            str(self.port),
            "--log-level",
            "DEBUG",
        ]

        if self.model:
            cmd.extend(["--model", self.model])

        if self.verbose:
            cmd.append("--print-logs")

        return cmd

    def _build_env(self) -> dict[str, str]:
        """Build the environment for the opencode serve process."""
        env = os.environ.copy()

        if self.password:
            env["OPENCODE_SERVER_PASSWORD"] = self.password

        return env

    def _health_check(self) -> bool:
        """Perform a single health check. Returns True if healthy."""
        url = f"{self._base_url}/global/health"
        try:
            req = self._build_request(url, method="GET")
            with urlopen(req, timeout=2) as resp:
                return bool(resp.status == 200)
        except (URLError, OSError, TimeoutError):
            return False

    def _http_post(
        self, url: str, data: dict[str, Any], timeout: float | None = HTTP_TIMEOUT
    ) -> dict[str, Any]:
        """Make an HTTP POST request with JSON body.

        Returns the parsed JSON response.
        Raises OpencodeServerError on failure.
        """
        body = json.dumps(data).encode("utf-8")
        req = self._build_request(url, method="POST")
        req.add_header("Content-Type", "application/json")
        req.data = body

        try:
            with urlopen(req, timeout=timeout) as resp:
                resp_body = resp.read().decode("utf-8")
                if resp_body:
                    result: dict[str, Any] = json.loads(resp_body)
                    return result
                return {}
        except (URLError, OSError, TimeoutError) as e:
            raise OpencodeServerError(f"HTTP POST {url} failed: {e}") from e
        except json.JSONDecodeError as e:
            raise OpencodeServerError(f"Invalid JSON response from {url}: {e}") from e

    def _build_request(self, url: str, method: str = "GET") -> Request:
        """Build an HTTP request with optional auth headers."""
        req = Request(url, method=method)
        if self.password:
            import base64

            credentials = base64.b64encode(f":{self.password}".encode()).decode()
            req.add_header("Authorization", f"Basic {credentials}")
        return req

    @staticmethod
    def _find_free_port() -> int:
        """Find a free port in the configured range."""
        for port in range(PORT_RANGE_START, PORT_RANGE_END):
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.bind(("127.0.0.1", port))
                    return port
            except OSError:
                continue
        # Fallback: let OS assign
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            assigned_port: int = s.getsockname()[1]
            return assigned_port
