"""Ralph Daemon CLI entrypoint (ralphd).

This provides the command-line interface for the Ralph daemon,
separate from the ralph-uv client CLI.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path

import click

from ralph_uv import __version__
from ralph_uv.daemon import (
    DEFAULT_CONFIG_DIR,
    Daemon,
    DaemonConfig,
    load_config,
    setup_logging,
)


@click.group()
@click.version_option(version=__version__, prog_name="ralphd")
def cli() -> None:
    """Ralph Daemon - Remote loop execution service."""
    pass


@cli.command()
@click.option(
    "--identity",
    type=click.Path(exists=True, path_type=Path),
    default=None,
    help="Path to Ziti identity JSON file.",
)
@click.option(
    "--workspace-dir",
    type=click.Path(path_type=Path),
    default=None,
    help="Directory for git workspaces (default: ~/ralph-workspaces).",
)
@click.option(
    "--config",
    "config_path",
    type=click.Path(exists=True, path_type=Path),
    default=None,
    help="Path to config file (default: ~/.config/ralph/daemon.toml).",
)
def start(
    identity: Path | None,
    workspace_dir: Path | None,
    config_path: Path | None,
) -> None:
    """Start the Ralph daemon.

    The daemon listens for loop requests over OpenZiti and executes them
    using the opencode serve HTTP API.

    Configuration is loaded from:
      - ~/.config/ralph/daemon.toml (TOML config)
      - ~/.config/ralph/env (environment variables)

    CLI flags override config file values.
    """
    # Load configuration
    config = load_config(
        config_path=config_path,
        identity_override=identity,
        workspace_override=workspace_dir,
    )

    # Set up logging
    logger = setup_logging(config)
    logger.info("Configuration loaded from %s", config_path or DEFAULT_CONFIG_DIR)

    # Log loaded environment variables (keys only, not values)
    if config.env_vars:
        logger.info(
            "Loaded %d environment variable(s): %s",
            len(config.env_vars),
            ", ".join(config.env_vars.keys()),
        )

    # Create and run daemon
    daemon = Daemon(config)

    try:
        asyncio.run(daemon.start())
    except KeyboardInterrupt:
        # Already handled by signal handler, but just in case
        logger.info("Interrupted")


@dataclass
class CheckResult:
    """Result of a validation check with fix instructions."""

    name: str
    passed: bool
    message: str
    fix: str | None = None


def _check_git_auth() -> CheckResult:
    """Check if git authentication is configured.

    Checks for:
    - SSH key in ~/.ssh/ with proper permissions
    - git credential helper configured

    Returns:
        CheckResult with status and fix instructions
    """
    import subprocess

    from pathlib import Path

    # Check for SSH key
    ssh_dir = Path.home() / ".ssh"
    ssh_key_found = False

    if ssh_dir.is_dir():
        # Look for common SSH key names
        key_names = ["id_ed25519", "id_rsa", "id_ecdsa", "id_dsa"]
        for key_name in key_names:
            key_path = ssh_dir / key_name
            if key_path.is_file():
                ssh_key_found = True
                break

    # Check for credential helper
    credential_helper = None
    try:
        result = subprocess.run(
            ["git", "config", "--get", "credential.helper"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            credential_helper = result.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass

    if ssh_key_found and credential_helper:
        return CheckResult(
            name="Git auth",
            passed=True,
            message=f"SSH key and credential helper ({credential_helper})",
        )
    elif ssh_key_found:
        return CheckResult(
            name="Git auth",
            passed=True,
            message="SSH key available",
        )
    elif credential_helper:
        return CheckResult(
            name="Git auth",
            passed=True,
            message=f"Credential helper: {credential_helper}",
        )
    else:
        return CheckResult(
            name="Git auth",
            passed=False,
            message="No SSH key or credential helper configured",
            fix=(
                "Set up git authentication:\n"
                "  - SSH: ssh-keygen -t ed25519 && ssh-add ~/.ssh/id_ed25519\n"
                "  - HTTPS: git config --global credential.helper store"
            ),
        )


def _check_workspace_writable(workspace_dir: Path) -> CheckResult:
    """Check if the workspace directory is writable.

    Returns:
        CheckResult with status and fix instructions
    """
    import tempfile

    if workspace_dir.exists():
        if not workspace_dir.is_dir():
            return CheckResult(
                name="Workspace dir",
                passed=False,
                message=f"Path exists but is not a directory: {workspace_dir}",
                fix=f"Remove the file: rm {workspace_dir}",
            )

        # Try to write a test file
        try:
            test_file = workspace_dir / ".ralph-write-test"
            test_file.write_text("test")
            test_file.unlink()
            return CheckResult(
                name="Workspace dir",
                passed=True,
                message=f"Writable ({workspace_dir})",
            )
        except PermissionError:
            return CheckResult(
                name="Workspace dir",
                passed=False,
                message=f"Not writable: {workspace_dir}",
                fix=f"Fix permissions: chmod u+w {workspace_dir}",
            )
        except OSError as e:
            return CheckResult(
                name="Workspace dir",
                passed=False,
                message=f"Error testing write: {e}",
                fix=f"Check disk space and permissions for {workspace_dir}",
            )
    else:
        # Check if we can create it by checking parent
        parent = workspace_dir.parent
        if parent.exists() and parent.is_dir():
            try:
                # Try to create and remove a test dir in parent
                test_dir = parent / ".ralph-create-test"
                test_dir.mkdir()
                test_dir.rmdir()
                return CheckResult(
                    name="Workspace dir",
                    passed=True,
                    message=f"Will be created ({workspace_dir})",
                )
            except PermissionError:
                return CheckResult(
                    name="Workspace dir",
                    passed=False,
                    message=f"Cannot create: {workspace_dir}",
                    fix=f"Create with proper permissions: mkdir -p {workspace_dir}",
                )
            except OSError as e:
                return CheckResult(
                    name="Workspace dir",
                    passed=False,
                    message=f"Error testing: {e}",
                    fix=f"Check disk space and permissions for {parent}",
                )
        else:
            return CheckResult(
                name="Workspace dir",
                passed=True,
                message=f"Will be created ({workspace_dir})",
            )


@cli.command()
@click.option(
    "--identity",
    type=click.Path(exists=True, path_type=Path),
    default=None,
    help="Path to Ziti identity JSON file to check.",
)
@click.option(
    "--config",
    "config_path",
    type=click.Path(exists=True, path_type=Path),
    default=None,
    help="Path to config file (default: ~/.config/ralph/daemon.toml).",
)
def check(
    identity: Path | None,
    config_path: Path | None,
) -> None:
    """Check if the daemon is ready to run.

    Validates:
      - Python version (3.12+)
      - Required tools (git)
      - Configuration files
      - Workspace directory (exists and writable)
      - Ziti identity (if configured)
      - API keys (ANTHROPIC_API_KEY)
      - Agent availability (claude or opencode)
      - Git authentication (SSH key or credential helper)

    Exit code 0 if ready, non-zero if issues found.
    """
    import os
    import shutil
    import sys

    results: list[CheckResult] = []

    click.echo("Ralph Daemon Readiness Check")
    click.echo("=" * 40)

    # Check Python version
    py_version = sys.version_info
    if py_version >= (3, 12):
        results.append(
            CheckResult(
                name="Python version",
                passed=True,
                message=f"{py_version.major}.{py_version.minor}",
            )
        )
    else:
        results.append(
            CheckResult(
                name="Python version",
                passed=False,
                message=f"{py_version.major}.{py_version.minor}",
                fix="Install Python 3.12+: https://www.python.org/downloads/",
            )
        )

    # Check git
    if shutil.which("git"):
        results.append(
            CheckResult(
                name="git",
                passed=True,
                message="Available",
            )
        )
    else:
        results.append(
            CheckResult(
                name="git",
                passed=False,
                message="Not found in PATH",
                fix="Install git: sudo apt install git (or equivalent for your OS)",
            )
        )

    # Load config
    config: DaemonConfig | None = None
    try:
        config = load_config(
            config_path=config_path,
            identity_override=identity,
        )
        results.append(
            CheckResult(
                name="Config loading",
                passed=True,
                message="OK",
            )
        )
    except Exception as e:
        results.append(
            CheckResult(
                name="Config loading",
                passed=False,
                message=str(e),
                fix=f"Create config file: mkdir -p {DEFAULT_CONFIG_DIR} && touch {DEFAULT_CONFIG_DIR}/daemon.toml",
            )
        )
        config = DaemonConfig()

    # Check workspace directory (exists and writable)
    results.append(_check_workspace_writable(config.workspace_dir))

    # Check Ziti SDK availability
    from ralph_uv.ziti import check_identity_valid, check_ziti_available

    if check_ziti_available():
        results.append(
            CheckResult(
                name="openziti SDK",
                passed=True,
                message="Installed",
            )
        )
    else:
        results.append(
            CheckResult(
                name="openziti SDK",
                passed=True,  # Warning, not failure
                message="Not installed (optional for remote access)",
                fix="Install with: pip install openziti",
            )
        )

    # Check Ziti identity
    if config.ziti_identity_path:
        if config.ziti_identity_path.is_file():
            if check_ziti_available():
                valid, msg = check_identity_valid(config.ziti_identity_path)
                if valid:
                    results.append(
                        CheckResult(
                            name="Ziti identity",
                            passed=True,
                            message=f"Valid ({config.ziti_identity_path.name})",
                        )
                    )
                else:
                    results.append(
                        CheckResult(
                            name="Ziti identity",
                            passed=False,
                            message=msg,
                            fix="Re-enroll the Ziti identity or generate a new one",
                        )
                    )
            else:
                results.append(
                    CheckResult(
                        name="Ziti identity",
                        passed=True,
                        message=f"File exists ({config.ziti_identity_path.name})",
                        fix="Install openziti to validate: pip install openziti",
                    )
                )
        else:
            results.append(
                CheckResult(
                    name="Ziti identity",
                    passed=False,
                    message=f"File not found: {config.ziti_identity_path}",
                    fix=f"Create or copy Ziti identity to: {config.ziti_identity_path}",
                )
            )
    else:
        results.append(
            CheckResult(
                name="Ziti identity",
                passed=True,  # Warning, not failure
                message="Not configured (optional for remote access)",
                fix=f"Add ziti_identity_path to {DEFAULT_CONFIG_DIR}/daemon.toml",
            )
        )

    # Check API keys
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY") or config.env_vars.get(
        "ANTHROPIC_API_KEY"
    )
    if anthropic_key:
        # Mask the key for display
        masked = anthropic_key[:8] + "..." if len(anthropic_key) > 8 else "***"
        results.append(
            CheckResult(
                name="ANTHROPIC_API_KEY",
                passed=True,
                message=f"Set ({masked})",
            )
        )
    else:
        results.append(
            CheckResult(
                name="ANTHROPIC_API_KEY",
                passed=False,
                message="Not set",
                fix=(
                    "Set the API key:\n"
                    f"  - In env file: echo 'ANTHROPIC_API_KEY=sk-...' >> {DEFAULT_CONFIG_DIR}/env\n"
                    "  - Or export: export ANTHROPIC_API_KEY=sk-..."
                ),
            )
        )

    # Check agent availability
    agents_found: list[str] = []
    for agent in ["claude", "opencode"]:
        if shutil.which(agent):
            agents_found.append(agent)

    if agents_found:
        results.append(
            CheckResult(
                name="Agent CLIs",
                passed=True,
                message=", ".join(agents_found),
            )
        )
    else:
        results.append(
            CheckResult(
                name="Agent CLIs",
                passed=False,
                message="None found (need claude or opencode)",
                fix=(
                    "Install an agent:\n"
                    "  - OpenCode: curl -fsSL https://opencode.ai/install | bash\n"
                    "  - Claude: npm install -g @anthropic-ai/claude-code"
                ),
            )
        )

    # Check git auth configuration
    results.append(_check_git_auth())

    # Print results
    click.echo()
    issues: list[CheckResult] = []
    warnings: list[CheckResult] = []

    for result in results:
        status = (
            click.style("OK", fg="green")
            if result.passed
            else click.style("FAIL", fg="red")
        )
        click.echo(f"  {result.name}: {status} - {result.message}")

        if not result.passed and result.fix:
            issues.append(result)
        elif result.passed and result.fix:
            # Passed but with a suggestion (warning)
            warnings.append(result)

    click.echo()

    # Print warnings
    if warnings:
        click.echo(click.style("Suggestions:", fg="yellow"))
        for w in warnings:
            click.echo(f"  {w.name}:")
            if w.fix:
                for line in w.fix.split("\n"):
                    click.echo(f"    {line}")
        click.echo()

    # Print issues with fix instructions
    if issues:
        click.echo(click.style("Issues found - how to fix:", fg="red"))
        for issue in issues:
            click.echo(f"  {issue.name}: {issue.message}")
            if issue.fix:
                for line in issue.fix.split("\n"):
                    click.echo(f"    {line}")
            click.echo()

        click.echo(click.style("Status: NOT READY", fg="red", bold=True))
        raise SystemExit(1)
    else:
        click.echo(click.style("Status: READY", fg="green", bold=True))
        raise SystemExit(0)


if __name__ == "__main__":
    cli()
