"""OpenZiti integration for the Ralph daemon.

This module provides:
- Ziti identity loading and context management
- Control service binding for receiving RPC requests
- Connection handling for concurrent clients
- Graceful teardown on shutdown
"""

from __future__ import annotations

import asyncio
import logging
import socket
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

# Try to import openziti, track availability
try:
    import openziti  # type: ignore[import-untyped]

    ZITI_AVAILABLE = True
except ImportError:
    openziti = None
    ZITI_AVAILABLE = False


@runtime_checkable
class ConnectionHandler(Protocol):
    """Protocol for handling incoming connections."""

    async def handle_connection(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        """Handle an incoming connection.

        Args:
            reader: Stream reader for receiving data
            writer: Stream writer for sending data
        """
        ...


class ZitiService:
    """Manages a Ziti service binding.

    Handles:
    - Loading Ziti identity
    - Binding to a service
    - Accepting multiple concurrent connections
    - Graceful shutdown
    """

    def __init__(
        self,
        identity_path: Path,
        service_name: str,
        handler: ConnectionHandler,
        hostname: str,
    ) -> None:
        """Initialize the Ziti service.

        Args:
            identity_path: Path to Ziti identity JSON file
            service_name: Name of the Ziti service to bind to
            handler: Connection handler for incoming connections
            hostname: Hostname for logging/identification
        """
        self.identity_path = identity_path
        self.service_name = service_name
        self.handler = handler
        self.hostname = hostname

        self._log = logging.getLogger("ralphd.ziti")
        self._context: Any = None  # openziti.context.ZitiContext when loaded
        self._server_socket: socket.socket | None = None
        self._accept_task: asyncio.Task[None] | None = None
        self._active_connections: set[asyncio.Task[None]] = set()
        self._shutdown_event = asyncio.Event()
        self._bound = False

    @property
    def is_bound(self) -> bool:
        """Return True if the service is currently bound."""
        return self._bound

    def load_identity(self) -> bool:
        """Load the Ziti identity from file.

        Returns:
            True if identity loaded successfully, False otherwise
        """
        if not ZITI_AVAILABLE or openziti is None:
            self._log.error("openziti package not installed")
            return False

        if not self.identity_path.is_file():
            self._log.error("Ziti identity file not found: %s", self.identity_path)
            return False

        try:
            self._log.info("Loading Ziti identity from %s", self.identity_path)
            self._context, err = openziti.load(str(self.identity_path))

            if err != 0:
                self._log.error("Failed to load Ziti identity: error code %d", err)
                return False

            self._log.info("Ziti identity loaded successfully")
            return True

        except Exception as e:
            self._log.exception("Exception loading Ziti identity: %s", e)
            return False

    def bind(self) -> bool:
        """Bind to the Ziti service.

        Returns:
            True if bound successfully, False otherwise
        """
        if not ZITI_AVAILABLE:
            self._log.error("openziti package not installed")
            return False

        if self._context is None:
            self._log.error("No Ziti context loaded - call load_identity() first")
            return False

        try:
            self._log.info("Binding to Ziti service: %s", self.service_name)
            self._server_socket = self._context.bind(self.service_name)
            if self._server_socket is not None:
                self._server_socket.listen(5)
            self._bound = True
            self._log.info(
                "Successfully bound to service %s on %s",
                self.service_name,
                self.hostname,
            )
            return True

        except Exception as e:
            self._log.exception("Failed to bind to Ziti service: %s", e)
            return False

    async def start_accepting(self) -> None:
        """Start accepting connections in the background.

        This runs in a loop until shutdown is requested.
        """
        if not self._bound or self._server_socket is None:
            self._log.error("Cannot accept connections - service not bound")
            return

        self._log.info("Starting to accept connections on %s", self.service_name)

        loop = asyncio.get_running_loop()

        while not self._shutdown_event.is_set():
            try:
                # Use run_in_executor since accept() is blocking
                conn, peer = await loop.run_in_executor(None, self._accept_connection)

                if conn is None:
                    # Socket was closed or error occurred, check if we should continue
                    if self._shutdown_event.is_set():
                        break
                    continue

                self._log.info("Accepted connection from peer: %s", peer)

                # Create a task to handle this connection
                task = asyncio.create_task(self._handle_connection_wrapper(conn, peer))
                self._active_connections.add(task)
                task.add_done_callback(self._active_connections.discard)

            except Exception as e:
                if self._shutdown_event.is_set():
                    break
                self._log.exception("Error accepting connection: %s", e)
                # Small delay to prevent tight loop on repeated errors
                await asyncio.sleep(0.1)

        self._log.info("Stopped accepting connections")

    def _accept_connection(self) -> tuple[socket.socket | None, Any]:
        """Accept a connection (blocking call for run_in_executor).

        Returns:
            Tuple of (connection socket, peer info) or (None, None) on error
        """
        if self._server_socket is None:
            return None, None

        try:
            # Set a timeout so we can check shutdown periodically
            self._server_socket.settimeout(1.0)
            return self._server_socket.accept()
        except socket.timeout:
            return None, None
        except OSError as e:
            # Socket was likely closed
            if not self._shutdown_event.is_set():
                self._log.debug("Accept error (socket may be closed): %s", e)
            return None, None

    async def _handle_connection_wrapper(self, conn: socket.socket, peer: Any) -> None:
        """Wrap a socket connection in asyncio streams and handle it.

        Args:
            conn: The connected socket
            peer: Peer identification info
        """
        try:
            # Wrap the socket in asyncio streams
            loop = asyncio.get_running_loop()
            reader = asyncio.StreamReader()
            protocol = asyncio.StreamReaderProtocol(reader)

            # Create transport from the socket
            transport, _ = await loop.create_connection(lambda: protocol, sock=conn)
            writer = asyncio.StreamWriter(transport, protocol, reader, loop)

            # Call the handler
            await self.handler.handle_connection(reader, writer)

        except Exception as e:
            self._log.exception("Error handling connection from %s: %s", peer, e)

        finally:
            try:
                conn.close()
            except Exception:
                pass
            self._log.debug("Connection closed for peer: %s", peer)

    async def shutdown(self) -> None:
        """Gracefully shutdown the Ziti service.

        This will:
        1. Stop accepting new connections
        2. Wait for active connections to complete (with timeout)
        3. Close the server socket
        4. Clean up the Ziti context
        """
        self._log.info("Shutting down Ziti service: %s", self.service_name)

        # Signal shutdown
        self._shutdown_event.set()

        # Cancel the accept task if running
        if self._accept_task is not None and not self._accept_task.done():
            self._accept_task.cancel()
            try:
                await self._accept_task
            except asyncio.CancelledError:
                pass

        # Wait for active connections to complete (with timeout)
        if self._active_connections:
            self._log.info(
                "Waiting for %d active connection(s) to complete...",
                len(self._active_connections),
            )
            done, pending = await asyncio.wait(self._active_connections, timeout=5.0)
            if pending:
                self._log.warning("Forcefully closing %d connection(s)", len(pending))
                for task in pending:
                    task.cancel()

        # Close the server socket
        if self._server_socket is not None:
            try:
                self._server_socket.close()
            except Exception as e:
                self._log.debug("Error closing server socket: %s", e)
            self._server_socket = None

        self._bound = False
        self._log.info("Ziti service shutdown complete")


class ZitiControlService:
    """Control service for the Ralph daemon.

    Manages the main control service that clients connect to for
    starting/stopping loops and querying status.
    """

    def __init__(
        self,
        identity_path: Path,
        hostname: str,
        handler: ConnectionHandler,
    ) -> None:
        """Initialize the control service.

        Args:
            identity_path: Path to Ziti identity JSON file
            hostname: Hostname used for service naming
            handler: Handler for incoming RPC connections
        """
        self.identity_path = identity_path
        self.hostname = hostname
        self.handler = handler

        self._log = logging.getLogger("ralphd.ziti.control")
        self._service: ZitiService | None = None

    @property
    def service_name(self) -> str:
        """Return the control service name."""
        return f"ralph-control-{self.hostname}"

    @property
    def is_bound(self) -> bool:
        """Return True if the control service is bound."""
        return self._service is not None and self._service.is_bound

    async def start(self) -> bool:
        """Start the control service.

        Returns:
            True if started successfully, False otherwise
        """
        if not ZITI_AVAILABLE:
            self._log.error(
                "Cannot start control service: openziti package not installed"
            )
            return False

        self._log.info("Starting control service: %s", self.service_name)

        # Create the Ziti service
        self._service = ZitiService(
            identity_path=self.identity_path,
            service_name=self.service_name,
            handler=self.handler,
            hostname=self.hostname,
        )

        # Load identity
        if not self._service.load_identity():
            self._log.error("Failed to load Ziti identity")
            return False

        # Bind to service
        if not self._service.bind():
            self._log.error("Failed to bind to control service")
            return False

        # Start accepting connections in the background
        self._service._accept_task = asyncio.create_task(
            self._service.start_accepting()
        )

        self._log.info("Control service started successfully")
        return True

    async def shutdown(self) -> None:
        """Shutdown the control service."""
        if self._service is not None:
            await self._service.shutdown()
            self._service = None


def check_ziti_available() -> bool:
    """Check if the openziti package is available.

    Returns:
        True if openziti is available, False otherwise
    """
    return ZITI_AVAILABLE


def check_identity_valid(identity_path: Path) -> tuple[bool, str]:
    """Check if a Ziti identity file is valid.

    Args:
        identity_path: Path to the identity file

    Returns:
        Tuple of (is_valid, message)
    """
    if not ZITI_AVAILABLE or openziti is None:
        return False, "openziti package not installed"

    if not identity_path.exists():
        return False, f"Identity file not found: {identity_path}"

    if not identity_path.is_file():
        return False, f"Identity path is not a file: {identity_path}"

    # Try to load the identity to validate it
    try:
        ctx, err = openziti.load(str(identity_path))
        if err != 0:
            return False, f"Failed to load identity: error code {err}"
        return True, "Identity valid"
    except Exception as e:
        return False, f"Exception loading identity: {e}"
