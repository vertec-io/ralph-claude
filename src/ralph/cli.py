"""Ralph CLI entrypoint."""

import argparse
import sys
from pathlib import Path

from ralph import __version__
from ralph.loop import LoopConfig, LoopRunner


def create_parser() -> argparse.ArgumentParser:
    """Create the argument parser for the ralph CLI."""
    parser = argparse.ArgumentParser(
        prog="ralph",
        description="Ralph - Autonomous AI agent loop runner",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"ralph {__version__}",
    )

    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # run command
    run_parser = subparsers.add_parser("run", help="Run the agent loop for a task")
    run_parser.add_argument(
        "task_dir",
        help="Path to the task directory containing prd.json",
    )
    run_parser.add_argument(
        "--max-iterations",
        type=int,
        default=50,
        help="Maximum number of iterations (default: 50)",
    )
    run_parser.add_argument(
        "--agent",
        choices=["claude", "opencode"],
        default=None,
        help="Agent to use (default: from prd.json or claude)",
    )
    run_parser.add_argument(
        "--base-branch",
        default=None,
        help="Base branch to start from (default: current branch)",
    )

    # status command
    subparsers.add_parser("status", help="Show status of running sessions")

    # stop command
    stop_parser = subparsers.add_parser("stop", help="Stop a running session")
    stop_parser.add_argument("task", help="Task name to stop")

    # checkpoint command
    checkpoint_parser = subparsers.add_parser(
        "checkpoint", help="Checkpoint a running session"
    )
    checkpoint_parser.add_argument("task", help="Task name to checkpoint")

    # attach command
    attach_parser = subparsers.add_parser("attach", help="Attach to a running session")
    attach_parser.add_argument("task", help="Task name to attach to")

    return parser


def _cmd_run(args: argparse.Namespace) -> int:
    """Execute the run command."""
    task_dir = Path(args.task_dir).resolve()

    # Determine agent (CLI flag > prd.json > default)
    agent = args.agent or "claude"
    if args.agent is None:
        # Try to read from prd.json
        prd_file = task_dir / "prd.json"
        if prd_file.is_file():
            import json

            try:
                prd = json.loads(prd_file.read_text())
                prd_agent = prd.get("agent", "")
                if prd_agent:
                    agent = prd_agent
            except (json.JSONDecodeError, OSError):
                pass

    config = LoopConfig(
        task_dir=task_dir,
        max_iterations=args.max_iterations,
        agent=agent,
    )
    runner = LoopRunner(config)
    return runner.run()


def main() -> int:
    """Main entry point for the ralph CLI."""
    parser = create_parser()
    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        return 0

    match args.command:
        case "run":
            return _cmd_run(args)
        case "status":
            print("No running sessions.")
        case "stop":
            print(f"Would stop task: {args.task}")
        case "checkpoint":
            print(f"Would checkpoint task: {args.task}")
        case "attach":
            print(f"Would attach to task: {args.task}")

    return 0


def cli() -> None:
    """CLI wrapper that calls main() and exits with its return code."""
    sys.exit(main())


if __name__ == "__main__":
    cli()
