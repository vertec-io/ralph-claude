"""Git workspace management for the Ralph daemon.

Manages git repositories and worktrees for loop execution:
- Bare repository caching: ~/ralph-workspaces/{project}/bare.git
- Worktree isolation: ~/ralph-workspaces/{project}/checkouts/{task}-{uuid}
- Branch fetching and validation
- Cleanup of stale worktrees

Directory structure:
    ~/ralph-workspaces/
    ├── project-name/
    │   ├── bare.git/           # Bare clone of the origin
    │   └── checkouts/
    │       ├── task-abc123/    # Worktree for loop abc123
    │       └── task-def456/    # Worktree for loop def456
    └── another-project/
        └── ...
"""

from __future__ import annotations

import asyncio
import logging
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


class WorkspaceError(Exception):
    """Base exception for workspace operations."""

    pass


class OriginUnreachableError(WorkspaceError):
    """Origin URL could not be reached or cloned."""

    pass


class BranchNotFoundError(WorkspaceError):
    """Requested branch does not exist in the repository."""

    pass


class OriginMismatchError(WorkspaceError):
    """The provided origin URL doesn't match the existing repository's origin."""

    pass


class DiskFullError(WorkspaceError):
    """Insufficient disk space for the operation."""

    pass


@dataclass
class WorktreeInfo:
    """Information about a created worktree."""

    worktree_path: Path
    project_name: str
    branch: str
    worktree_id: str
    bare_repo_path: Path


def resolve_project_name(origin_url: str) -> str:
    """Extract project name from a git origin URL.

    Handles various URL formats:
    - https://github.com/user/repo.git -> repo
    - git@github.com:user/repo.git -> repo
    - https://github.com/user/repo -> repo
    - ssh://git@host/path/to/repo.git -> repo
    - /local/path/to/repo -> repo

    Args:
        origin_url: Git repository URL

    Returns:
        Project name (last path component without .git suffix)

    Raises:
        ValueError: If URL is empty or invalid
    """
    if not origin_url:
        raise ValueError("Empty origin URL")

    # Handle SSH URLs (git@host:path/to/repo.git)
    ssh_match = re.match(r"^[\w.-]+@[\w.-]+:(.+)$", origin_url)
    if ssh_match:
        path = ssh_match.group(1)
    else:
        # Try parsing as a regular URL
        parsed = urlparse(origin_url)
        if parsed.scheme in ("http", "https", "ssh", "git"):
            path = parsed.path
        elif parsed.scheme == "" and origin_url.startswith("/"):
            # Local path
            path = origin_url
        else:
            # Try treating as URL path anyway
            path = urlparse(origin_url).path or origin_url

    # Extract last path component and strip .git suffix
    path = path.rstrip("/")
    if not path:
        raise ValueError(f"Could not extract project name from: {origin_url}")

    name = path.rsplit("/", 1)[-1]

    # Strip .git suffix if present
    if name.endswith(".git"):
        name = name[:-4]

    if not name:
        raise ValueError(f"Could not extract project name from: {origin_url}")

    return name


async def _run_git_command(
    *args: str,
    cwd: Path | None = None,
    timeout: float = 300.0,
    log: logging.Logger | None = None,
) -> tuple[int, str, str]:
    """Run a git command and return (returncode, stdout, stderr).

    Args:
        *args: Git command arguments (without 'git' prefix)
        cwd: Working directory
        timeout: Command timeout in seconds
        log: Optional logger for debug output

    Returns:
        Tuple of (return_code, stdout, stderr)

    Raises:
        WorkspaceError: If timeout exceeded
    """
    cmd = ["git"] + list(args)
    if log:
        log.debug("Running: %s (cwd=%s)", " ".join(cmd), cwd)

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            proc.communicate(), timeout=timeout
        )
        stdout = stdout_bytes.decode(errors="replace")
        stderr = stderr_bytes.decode(errors="replace")

        if log:
            log.debug(
                "Git returned %d: stdout=%r stderr=%r",
                proc.returncode,
                stdout[:200],
                stderr[:200],
            )

        return proc.returncode or 0, stdout, stderr

    except TimeoutError as e:
        raise WorkspaceError(
            f"Git command timed out after {timeout}s: {' '.join(cmd)}"
        ) from e


async def _check_disk_space(path: Path, min_bytes: int = 100 * 1024 * 1024) -> None:
    """Check if there's sufficient disk space.

    Args:
        path: Path to check (directory that should exist or be created)
        min_bytes: Minimum required bytes (default: 100MB)

    Raises:
        DiskFullError: If insufficient space
    """
    import shutil

    # Find existing parent directory
    check_path = path
    while not check_path.exists() and check_path != check_path.parent:
        check_path = check_path.parent

    if not check_path.exists():
        return  # Can't check, assume OK

    try:
        usage = shutil.disk_usage(check_path)
        if usage.free < min_bytes:
            raise DiskFullError(
                f"Insufficient disk space: {usage.free // 1024 // 1024}MB available, "
                f"need at least {min_bytes // 1024 // 1024}MB"
            )
    except OSError:
        pass  # Can't check, assume OK


async def _get_remote_url(
    bare_repo: Path, log: logging.Logger | None = None
) -> str | None:
    """Get the origin remote URL from an existing bare repository.

    Args:
        bare_repo: Path to bare git repository
        log: Optional logger

    Returns:
        Origin URL or None if not found
    """
    returncode, stdout, _ = await _run_git_command(
        "config",
        "--get",
        "remote.origin.url",
        cwd=bare_repo,
        timeout=10.0,
        log=log,
    )
    if returncode == 0:
        return stdout.strip()
    return None


async def _validate_origin_url(
    bare_repo: Path,
    expected_url: str,
    log: logging.Logger | None = None,
) -> None:
    """Validate that the bare repo's origin matches the expected URL.

    Args:
        bare_repo: Path to existing bare repository
        expected_url: Expected origin URL
        log: Optional logger

    Raises:
        OriginMismatchError: If URLs don't match
    """
    existing_url = await _get_remote_url(bare_repo, log)
    if existing_url is None:
        raise OriginMismatchError(
            f"Existing bare repo has no origin URL configured: {bare_repo}"
        )

    # Normalize URLs for comparison (strip .git suffix, trailing slashes)
    def normalize(url: str) -> str:
        url = url.rstrip("/")
        if url.endswith(".git"):
            url = url[:-4]
        return url.lower()

    if normalize(existing_url) != normalize(expected_url):
        raise OriginMismatchError(
            f"Origin URL mismatch for existing repository.\n"
            f"  Existing: {existing_url}\n"
            f"  Requested: {expected_url}\n"
            f"  Bare repo: {bare_repo}"
        )


async def _clone_bare(
    origin_url: str,
    bare_repo: Path,
    log: logging.Logger | None = None,
) -> None:
    """Clone a bare repository from the origin URL.

    Args:
        origin_url: Git origin URL
        bare_repo: Path where bare repo should be created
        log: Optional logger

    Raises:
        OriginUnreachableError: If clone fails
        DiskFullError: If insufficient disk space
    """
    await _check_disk_space(bare_repo.parent)

    # Ensure parent directory exists
    bare_repo.parent.mkdir(parents=True, exist_ok=True)

    returncode, stdout, stderr = await _run_git_command(
        "clone",
        "--bare",
        "--",
        origin_url,
        str(bare_repo),
        cwd=bare_repo.parent,
        timeout=600.0,  # Clone can take a while
        log=log,
    )

    if returncode != 0:
        # Check for common error patterns
        combined = stdout + stderr
        if "Could not resolve host" in combined or "unable to access" in combined:
            raise OriginUnreachableError(
                f"Cannot reach origin: {origin_url}\n{stderr.strip()}"
            )
        if "No space left" in combined:
            raise DiskFullError(f"Disk full during clone: {stderr.strip()}")
        if "Permission denied" in combined:
            raise OriginUnreachableError(
                f"Permission denied accessing: {origin_url}\n{stderr.strip()}"
            )
        if "not found" in combined.lower() or "does not exist" in combined.lower():
            raise OriginUnreachableError(
                f"Repository not found: {origin_url}\n{stderr.strip()}"
            )

        raise OriginUnreachableError(f"Failed to clone {origin_url}: {stderr.strip()}")


async def _fetch_branch(
    bare_repo: Path,
    branch: str,
    log: logging.Logger | None = None,
) -> None:
    """Fetch a branch from origin into the bare repository.

    Args:
        bare_repo: Path to bare git repository
        branch: Branch name to fetch
        log: Optional logger

    Raises:
        OriginUnreachableError: If fetch fails due to network issues
        BranchNotFoundError: If the branch doesn't exist
    """
    returncode, stdout, stderr = await _run_git_command(
        "fetch",
        "origin",
        f"{branch}:{branch}",
        cwd=bare_repo,
        timeout=300.0,
        log=log,
    )

    if returncode != 0:
        combined = stdout + stderr

        # Check for branch not found
        if (
            "couldn't find remote ref" in combined.lower()
            or "not found" in combined.lower()
        ):
            raise BranchNotFoundError(f"Branch not found: {branch}\n{stderr.strip()}")

        # Check for network issues
        if "Could not resolve host" in combined or "unable to access" in combined:
            raise OriginUnreachableError(
                f"Cannot reach origin during fetch\n{stderr.strip()}"
            )

        # Non-fatal: branch might already be up to date
        if "non-fast-forward" not in combined.lower():
            if log:
                log.warning(
                    "Fetch returned %d but may be OK: %s", returncode, stderr.strip()
                )


async def _create_worktree(
    bare_repo: Path,
    checkouts_dir: Path,
    branch: str,
    task_name: str,
    log: logging.Logger | None = None,
) -> WorktreeInfo:
    """Create a new worktree from the bare repository.

    Args:
        bare_repo: Path to bare git repository
        checkouts_dir: Directory for worktrees
        branch: Branch to checkout
        task_name: Task name (for directory naming)
        log: Optional logger

    Returns:
        WorktreeInfo with the created worktree details

    Raises:
        BranchNotFoundError: If branch doesn't exist
        DiskFullError: If insufficient disk space
        WorkspaceError: If worktree creation fails
    """
    await _check_disk_space(checkouts_dir)

    # Generate unique worktree ID
    worktree_id = uuid.uuid4().hex[:8]
    worktree_name = f"{task_name}-{worktree_id}"
    worktree_path = checkouts_dir / worktree_name

    # Ensure checkouts directory exists
    checkouts_dir.mkdir(parents=True, exist_ok=True)

    # Create worktree
    returncode, stdout, stderr = await _run_git_command(
        "worktree",
        "add",
        str(worktree_path),
        branch,
        cwd=bare_repo,
        timeout=120.0,
        log=log,
    )

    if returncode != 0:
        combined = stdout + stderr

        # Check for branch not found
        if (
            "invalid reference" in combined.lower()
            or "not a valid object" in combined.lower()
        ):
            raise BranchNotFoundError(f"Branch not found for worktree: {branch}")

        if "No space left" in combined:
            raise DiskFullError(f"Disk full during worktree creation: {stderr.strip()}")

        raise WorkspaceError(f"Failed to create worktree: {stderr.strip()}")

    # Verify worktree was created
    if not worktree_path.exists():
        raise WorkspaceError(f"Worktree path not created: {worktree_path}")

    project_name = bare_repo.parent.name

    return WorktreeInfo(
        worktree_path=worktree_path,
        project_name=project_name,
        branch=branch,
        worktree_id=worktree_id,
        bare_repo_path=bare_repo,
    )


async def prune_worktrees(
    workspace_dir: Path,
    log: logging.Logger | None = None,
) -> int:
    """Prune stale worktrees in all projects.

    Runs `git worktree prune` on all bare repositories in the workspace.

    Args:
        workspace_dir: Root workspace directory (e.g., ~/ralph-workspaces)
        log: Optional logger

    Returns:
        Number of projects pruned
    """
    if not workspace_dir.exists():
        return 0

    pruned = 0
    for project_dir in workspace_dir.iterdir():
        if not project_dir.is_dir():
            continue

        bare_repo = project_dir / "bare.git"
        if not bare_repo.exists():
            continue

        if log:
            log.debug("Pruning worktrees in %s", bare_repo)

        returncode, _, stderr = await _run_git_command(
            "worktree",
            "prune",
            cwd=bare_repo,
            timeout=30.0,
            log=log,
        )

        if returncode == 0:
            pruned += 1
        elif log:
            log.warning(
                "Failed to prune worktrees in %s: %s", bare_repo, stderr.strip()
            )

    return pruned


async def cleanup_worktree(
    worktree_info: WorktreeInfo,
    log: logging.Logger | None = None,
) -> bool:
    """Clean up a worktree after loop completion.

    Args:
        worktree_info: The worktree to clean up
        log: Optional logger

    Returns:
        True if cleanup succeeded
    """
    if not worktree_info.worktree_path.exists():
        return True  # Already gone

    # Remove worktree via git
    returncode, _, stderr = await _run_git_command(
        "worktree",
        "remove",
        "--force",
        str(worktree_info.worktree_path),
        cwd=worktree_info.bare_repo_path,
        timeout=60.0,
        log=log,
    )

    if returncode != 0:
        if log:
            log.warning(
                "Failed to remove worktree %s: %s",
                worktree_info.worktree_path,
                stderr.strip(),
            )
        # Try manual removal as fallback
        import shutil

        try:
            shutil.rmtree(worktree_info.worktree_path)
        except OSError as e:
            if log:
                log.error("Manual worktree removal failed: %s", e)
            return False

    return True


class WorkspaceManager:
    """Manages git workspaces for loop execution.

    Provides high-level operations for:
    - Setting up workspaces for new loops (clone/fetch/worktree)
    - Cleaning up after loops complete
    - Pruning stale worktrees on startup
    """

    def __init__(self, workspace_dir: Path) -> None:
        """Initialize the workspace manager.

        Args:
            workspace_dir: Root directory for workspaces (e.g., ~/ralph-workspaces)
        """
        self.workspace_dir = workspace_dir
        self._log = logging.getLogger("ralphd.workspace")

    async def prune_stale_worktrees(self) -> int:
        """Prune stale worktrees in all projects.

        Should be called on daemon startup.

        Returns:
            Number of projects pruned
        """
        self._log.info("Pruning stale worktrees in %s", self.workspace_dir)
        count = await prune_worktrees(self.workspace_dir, self._log)
        if count > 0:
            self._log.info("Pruned worktrees in %d project(s)", count)
        return count

    async def setup_workspace(
        self,
        origin_url: str,
        branch: str,
        task_name: str,
    ) -> WorktreeInfo:
        """Set up a workspace for a new loop.

        This method:
        1. Resolves the project name from the origin URL
        2. Creates or validates the bare repository
        3. Fetches the requested branch
        4. Creates an isolated worktree

        Args:
            origin_url: Git origin URL
            branch: Branch to checkout
            task_name: Task name (for worktree naming)

        Returns:
            WorktreeInfo with the created worktree

        Raises:
            ValueError: If origin URL is invalid
            OriginUnreachableError: If origin cannot be reached
            BranchNotFoundError: If branch doesn't exist
            OriginMismatchError: If existing repo has different origin
            DiskFullError: If insufficient disk space
            WorkspaceError: For other git errors
        """
        # Resolve project name
        project_name = resolve_project_name(origin_url)
        self._log.info(
            "Setting up workspace for project=%s branch=%s task=%s",
            project_name,
            branch,
            task_name,
        )

        # Paths
        project_dir = self.workspace_dir / project_name
        bare_repo = project_dir / "bare.git"
        checkouts_dir = project_dir / "checkouts"

        # Ensure workspace directory exists
        self.workspace_dir.mkdir(parents=True, exist_ok=True)

        # Clone or validate bare repository
        if bare_repo.exists():
            self._log.debug("Bare repo exists, validating origin URL")
            await _validate_origin_url(bare_repo, origin_url, self._log)
        else:
            self._log.info("Creating bare clone from %s", origin_url)
            await _clone_bare(origin_url, bare_repo, self._log)

        # Fetch the requested branch
        self._log.info("Fetching branch %s", branch)
        await _fetch_branch(bare_repo, branch, self._log)

        # Create worktree
        self._log.info("Creating worktree for task %s", task_name)
        worktree_info = await _create_worktree(
            bare_repo, checkouts_dir, branch, task_name, self._log
        )

        self._log.info("Workspace ready: %s", worktree_info.worktree_path)
        return worktree_info

    async def cleanup_workspace(self, worktree_info: WorktreeInfo) -> bool:
        """Clean up a worktree after loop completion.

        Args:
            worktree_info: The worktree to clean up

        Returns:
            True if cleanup succeeded
        """
        self._log.info("Cleaning up worktree: %s", worktree_info.worktree_path)
        return await cleanup_worktree(worktree_info, self._log)

    def get_worktree_path(
        self,
        project_name: str,
        worktree_id: str,
        task_name: str,
    ) -> Path:
        """Get the path to an existing worktree.

        Args:
            project_name: Project name
            worktree_id: Worktree UUID suffix
            task_name: Task name

        Returns:
            Path to the worktree directory
        """
        return (
            self.workspace_dir
            / project_name
            / "checkouts"
            / f"{task_name}-{worktree_id}"
        )
