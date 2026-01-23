"""Branch management for Ralph agent runner."""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from typing import Any


class BranchError(Exception):
    """Raised when a branch operation fails."""


@dataclass
class BranchConfig:
    """Configuration for branch management."""

    branch_name: str  # From prd.json branchName
    base_branch: str | None = None  # From --base-branch CLI arg
    merge_target: str | None = None  # From prd.json mergeTarget
    auto_merge: bool = False  # From prd.json autoMerge


def _run_git(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    """Run a git command and return the result."""
    cmd = ["git"] + list(args)
    try:
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=check,
        )
    except subprocess.CalledProcessError as e:
        raise BranchError(f"git {' '.join(args)} failed: {e.stderr.strip()}") from e


def get_current_branch() -> str:
    """Get the current git branch name."""
    result = _run_git("branch", "--show-current")
    branch = result.stdout.strip()
    if not branch:
        raise BranchError("Not on any branch (detached HEAD state)")
    return branch


def is_working_tree_clean() -> bool:
    """Check if the working tree is clean (no uncommitted changes)."""
    result = _run_git("status", "--porcelain")
    return result.stdout.strip() == ""


def branch_exists(branch: str) -> bool:
    """Check if a branch exists locally."""
    result = _run_git("rev-parse", "--verify", branch, check=False)
    return result.returncode == 0


def checkout_branch(branch: str) -> None:
    """Checkout an existing branch."""
    _run_git("checkout", branch)


def create_and_checkout_branch(branch: str, base: str) -> None:
    """Create a new branch from base and check it out."""
    _run_git("checkout", "-b", branch, base)


def validate_branch_state() -> None:
    """Validate that the working tree is clean before starting.

    Raises BranchError if the working tree has uncommitted changes.
    """
    if not is_working_tree_clean():
        raise BranchError(
            "Working tree has uncommitted changes. "
            "Please commit or stash changes before running ralph-uv."
        )


def setup_branch(config: BranchConfig) -> None:
    """Set up the task branch based on configuration.

    Logic:
    1. If already on the task branch, proceed (allow dirty tree)
    2. If switching branches, require clean working tree
    3. If task branch exists, check it out
    4. If task branch doesn't exist, create it from base
    """
    current = get_current_branch()
    task_branch = config.branch_name

    # Already on the task branch — no checkout needed, allow dirty tree
    if current == task_branch:
        print(f"  Already on branch: {task_branch}")
        return

    # Switching branches requires a clean working tree
    validate_branch_state()

    base = config.base_branch if config.base_branch else current

    if branch_exists(task_branch):
        # Task branch exists, check it out
        print(f"  Checking out existing branch: {task_branch}")
        checkout_branch(task_branch)
    else:
        # Create task branch from base
        print(f"  Creating branch: {task_branch} (from {base})")
        if not branch_exists(base):
            raise BranchError(
                f"Base branch '{base}' does not exist. "
                f"Please specify a valid base branch."
            )
        create_and_checkout_branch(task_branch, base)


def handle_completion(config: BranchConfig) -> None:
    """Handle branch operations at loop completion.

    Logic:
    - If mergeTarget is set and autoMerge is true: create PR and merge
    - If mergeTarget is set and autoMerge is false: create PR only
    - If no mergeTarget: do nothing (branch left as-is)
    """
    if not config.merge_target:
        return

    task_branch = config.branch_name
    target = config.merge_target

    # Push the branch first
    print(f"\n  Pushing branch {task_branch}...")
    _run_git("push", "-u", "origin", task_branch)

    if config.auto_merge:
        print(f"  Creating PR and merging into {target}...")
        _create_and_merge_pr(task_branch, target)
    else:
        print(f"  Creating PR targeting {target}...")
        _create_pr(task_branch, target)


def _create_pr(branch: str, target: str) -> str:
    """Create a pull request using gh CLI. Returns the PR URL."""
    try:
        result = subprocess.run(
            [
                "gh",
                "pr",
                "create",
                "--base",
                target,
                "--head",
                branch,
                "--title",
                f"Ralph: {branch}",
                "--body",
                f"Automated PR from Ralph agent loop.\n\nBranch: {branch}\nTarget: {target}",
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        url = result.stdout.strip()
        print(f"  PR created: {url}")
        return url
    except FileNotFoundError:
        print("  Warning: 'gh' CLI not found. Cannot create PR.", file=sys.stderr)
        return ""
    except subprocess.CalledProcessError as e:
        # PR might already exist
        if "already exists" in e.stderr:
            print(f"  PR already exists for {branch}")
            return ""
        print(f"  Warning: Failed to create PR: {e.stderr.strip()}", file=sys.stderr)
        return ""


def _create_and_merge_pr(branch: str, target: str) -> None:
    """Create a PR and merge it."""
    url = _create_pr(branch, target)
    if not url:
        return

    try:
        subprocess.run(
            ["gh", "pr", "merge", url, "--merge", "--delete-branch"],
            capture_output=True,
            text=True,
            check=True,
        )
        print(f"  PR merged into {target}")
    except FileNotFoundError:
        print("  Warning: 'gh' CLI not found. Cannot merge PR.", file=sys.stderr)
    except subprocess.CalledProcessError as e:
        print(f"  Warning: Failed to merge PR: {e.stderr.strip()}", file=sys.stderr)


def create_branch_config(
    prd: dict[str, Any], base_branch: str | None = None
) -> BranchConfig:
    """Create a BranchConfig from prd.json data and CLI args."""
    branch_name = prd.get("branchName", "")
    if not branch_name:
        raise BranchError("prd.json must specify 'branchName'")

    return BranchConfig(
        branch_name=branch_name,
        base_branch=base_branch,
        merge_target=prd.get("mergeTarget"),
        auto_merge=prd.get("autoMerge", False),
    )
