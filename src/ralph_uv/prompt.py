"""Prompt preprocessing for Ralph agent runner.

Handles template loading, variable substitution, and AGENTS.md injection.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class PromptContext:
    """Context variables available for template substitution."""

    task_dir: Path
    prd_file: Path
    progress_file: Path
    branch_name: str = ""
    agent: str = "claude"
    extra_vars: dict[str, str] = field(default_factory=dict)

    def to_vars(self) -> dict[str, str]:
        """Convert context to a variable dictionary for substitution."""
        variables: dict[str, str] = {
            "TASK_DIR": str(self.task_dir),
            "PRD_FILE": str(self.prd_file),
            "PROGRESS_FILE": str(self.progress_file),
            "BRANCH_NAME": self.branch_name,
            "AGENT": self.agent,
        }
        variables.update(self.extra_vars)
        return variables


def load_prompt_template(task_dir: Path) -> str:
    """Load prompt.md template from configured locations.

    Search order:
    1. Task directory (task_dir/prompt.md)
    2. User config (~/.config/ralph/prompt.md)
    3. Project root (task_dir/../../prompt.md, i.e., two levels up from tasks/foo/)
    4. Installed location (~/.local/share/ralph/prompt.md)
    5. Fallback: minimal default prompt

    Args:
        task_dir: Path to the task directory containing prd.json.

    Returns:
        The prompt template content as a string.
    """
    # 1. Task directory
    task_prompt = task_dir / "prompt.md"
    if task_prompt.is_file():
        return task_prompt.read_text()

    # 2. User config
    config_prompt = Path.home() / ".config" / "ralph" / "prompt.md"
    if config_prompt.is_file():
        return config_prompt.read_text()

    # 3. Project root (tasks/ is typically one level under project root)
    project_root = task_dir.parent.parent
    root_prompt = project_root / "prompt.md"
    if root_prompt.is_file():
        return root_prompt.read_text()

    # 4. Installed location
    installed_prompt = Path.home() / ".local" / "share" / "ralph" / "prompt.md"
    if installed_prompt.is_file():
        return installed_prompt.read_text()

    # 5. Fallback
    return "# No prompt template found\nImplement the next story from prd.json."


def substitute_variables(template: str, variables: dict[str, str]) -> str:
    """Apply {VARIABLE} substitution to a template string.

    Replaces occurrences of {VAR_NAME} in the template with the corresponding
    value from the variables dict. Unrecognized variables are left as-is.

    Args:
        template: The template string with {VARIABLE} placeholders.
        variables: Dictionary mapping variable names to their values.

    Returns:
        The template with variables substituted.
    """

    def replace_match(match: re.Match[str]) -> str:
        var_name = match.group(1)
        if var_name in variables:
            return variables[var_name]
        # Leave unrecognized variables unchanged
        return match.group(0)

    # Match {VARIABLE_NAME} but not {{escaped}} or JSON-like patterns
    # Only match uppercase letters, digits, and underscores
    return re.sub(r"\{([A-Z][A-Z0-9_]*)\}", replace_match, template)


def find_agents_md(task_dir: Path) -> str:
    """Find and load AGENTS.md content from the project.

    Searches for AGENTS.md files starting from the project root
    (two levels up from the task directory). Collects content from
    both the project-level AGENTS.md and any task-specific AGENTS.md.

    Args:
        task_dir: Path to the task directory.

    Returns:
        Combined AGENTS.md content, or empty string if none found.
    """
    content_parts: list[str] = []

    # Project root AGENTS.md
    project_root = task_dir.parent.parent
    root_agents = project_root / "AGENTS.md"
    if root_agents.is_file():
        content_parts.append(root_agents.read_text().strip())

    # Task-specific AGENTS.md
    task_agents = task_dir / "AGENTS.md"
    if task_agents.is_file():
        content_parts.append(task_agents.read_text().strip())

    return "\n\n".join(content_parts)


def preprocess_agent_sections(content: str, agent: str) -> str:
    """Filter agent-specific sections from prompt content.

    Handles conditional markers:
      <!-- agent:claude --> ... content for Claude only ... <!-- /agent:claude -->
      <!-- agent:opencode --> ... content for OpenCode only ... <!-- /agent:opencode -->

    Content outside agent markers is included for all agents.
    Content inside markers for the current agent is kept (markers removed).
    Content inside markers for other agents is removed entirely.

    Args:
        content: The raw prompt content.
        agent: The current agent name (e.g., "claude", "opencode").

    Returns:
        Processed content with agent-specific filtering applied.
    """
    all_agents = ["claude", "opencode"]

    result = content
    for a in all_agents:
        open_tag = f"<!-- agent:{a} -->"
        close_tag = f"<!-- /agent:{a} -->"

        if a == agent:
            # Keep content, just remove the markers
            result = result.replace(open_tag, "")
            result = result.replace(close_tag, "")
        else:
            # Remove markers and everything between them
            pattern = re.compile(
                re.escape(open_tag) + r".*?" + re.escape(close_tag),
                re.DOTALL,
            )
            result = pattern.sub("", result)

    return result


def build_prompt(context: PromptContext) -> str:
    """Build the complete prompt for an agent iteration.

    This is the main entry point for prompt construction. It:
    1. Loads the prompt.md template
    2. Preprocesses agent-specific sections
    3. Applies variable substitution
    4. Injects AGENTS.md content
    5. Prepends the task context header

    Args:
        context: The prompt context with task info and variables.

    Returns:
        The fully assembled prompt string ready for the agent.
    """
    # Load template
    template = load_prompt_template(context.task_dir)

    # Preprocess agent-specific sections
    template = preprocess_agent_sections(template, context.agent)

    # Apply variable substitution
    variables = context.to_vars()
    template = substitute_variables(template, variables)

    # Find and inject AGENTS.md content
    agents_md = find_agents_md(context.task_dir)

    # Build the final prompt with header
    task_dir_str = str(context.task_dir)
    header = (
        f"# Ralph Agent Instructions\n\n"
        f"Task Directory: {task_dir_str}\n"
        f"PRD File: {task_dir_str}/prd.json\n"
        f"Progress File: {task_dir_str}/progress.txt\n\n"
    )

    # Insert AGENTS.md before the main prompt content if present
    if agents_md:
        agents_section = (
            f"## Project Context (from AGENTS.md)\n\n{agents_md}\n\n---\n\n"
        )
    else:
        agents_section = ""

    return f"{header}{agents_section}{template}\n"
