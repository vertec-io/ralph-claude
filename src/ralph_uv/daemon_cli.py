"""Ralph Daemon CLI entrypoint (ralphd).

This provides the command-line interface for the Ralph daemon,
separate from the ralph-uv client CLI.
"""

from __future__ import annotations

import asyncio
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
      - Python version
      - Required tools (git)
      - Configuration files
      - Ziti identity (if configured)
      - API keys
      - Agent availability
      - Git authentication

    Exit code 0 if ready, non-zero if issues found.
    """
    # This will be fully implemented in US-011
    # For now, just validate config loading works

    import shutil
    import sys

    issues: list[str] = []
    warnings: list[str] = []

    click.echo("Ralph Daemon Readiness Check")
    click.echo("=" * 40)

    # Check Python version
    py_version = sys.version_info
    if py_version >= (3, 12):
        click.echo(f"  Python {py_version.major}.{py_version.minor}: OK")
    else:
        issues.append(
            f"Python 3.12+ required (found {py_version.major}.{py_version.minor})"
        )

    # Check git
    if shutil.which("git"):
        click.echo("  git: OK")
    else:
        issues.append("git not found in PATH")

    # Load config
    try:
        config = load_config(
            config_path=config_path,
            identity_override=identity,
        )
        click.echo("  Config loading: OK")
    except Exception as e:
        issues.append(f"Config loading failed: {e}")
        config = DaemonConfig()

    # Check workspace directory
    if config.workspace_dir.exists():
        if config.workspace_dir.is_dir():
            click.echo(f"  Workspace dir ({config.workspace_dir}): OK")
        else:
            issues.append(
                f"Workspace path exists but is not a directory: {config.workspace_dir}"
            )
    else:
        warnings.append(f"Workspace dir will be created: {config.workspace_dir}")

    # Check Ziti identity
    if config.ziti_identity_path:
        if config.ziti_identity_path.is_file():
            click.echo(f"  Ziti identity: OK ({config.ziti_identity_path})")
        else:
            issues.append(f"Ziti identity not found: {config.ziti_identity_path}")
    else:
        warnings.append("No Ziti identity configured (required for remote access)")

    # Check API keys
    import os

    if os.environ.get("ANTHROPIC_API_KEY") or config.env_vars.get("ANTHROPIC_API_KEY"):
        click.echo("  ANTHROPIC_API_KEY: OK")
    else:
        issues.append("ANTHROPIC_API_KEY not set")

    # Check agent availability
    agents_found: list[str] = []
    for agent in ["claude", "opencode"]:
        if shutil.which(agent):
            agents_found.append(agent)

    if agents_found:
        click.echo(f"  Agents available: {', '.join(agents_found)}")
    else:
        issues.append("No agents found (need claude or opencode)")

    # Print summary
    click.echo()
    if warnings:
        click.echo("Warnings:")
        for w in warnings:
            click.echo(f"  - {w}")
        click.echo()

    if issues:
        click.echo("Issues found:")
        for issue in issues:
            click.echo(f"  - {issue}")
        click.echo()
        click.echo("Status: NOT READY")
        raise SystemExit(1)
    else:
        click.echo("Status: READY")
        raise SystemExit(0)


if __name__ == "__main__":
    cli()
