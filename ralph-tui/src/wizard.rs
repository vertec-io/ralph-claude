//! Loop Start Wizard - multi-step form for launching new ralph-uv loops.
//!
//! Accessible via hotkey 'w' from the TUI, this wizard guides the user through:
//! 1. Select task directory
//! 2. Configure base branch
//! 3. Set max iterations
//! 4. Select agent
//! 5. Confirm and launch

use std::path::PathBuf;
use std::process::Command;

use ratatui::{
    prelude::*,
    widgets::{Block, Borders, Clear, Paragraph},
};

use crate::theme::{
    BG_SECONDARY, BORDER_SUBTLE, CYAN_PRIMARY, GREEN_ACTIVE, GREEN_SUCCESS, RED_ERROR,
    ROUNDED_BORDERS, TEXT_MUTED, TEXT_PRIMARY, TEXT_SECONDARY,
};

/// Wizard step progression
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WizardStep {
    SelectTask,
    ConfigureBranch,
    SetIterations,
    SelectAgent,
    Confirm,
}

impl WizardStep {
    /// Get the step number (1-based)
    pub fn number(self) -> u8 {
        match self {
            Self::SelectTask => 1,
            Self::ConfigureBranch => 2,
            Self::SetIterations => 3,
            Self::SelectAgent => 4,
            Self::Confirm => 5,
        }
    }

    /// Get the step title
    pub fn title(self) -> &'static str {
        match self {
            Self::SelectTask => "Select Task",
            Self::ConfigureBranch => "Base Branch",
            Self::SetIterations => "Max Iterations",
            Self::SelectAgent => "Select Agent",
            Self::Confirm => "Confirm & Launch",
        }
    }

    /// Total number of steps
    pub const fn total() -> u8 {
        5
    }

    /// Move to next step
    pub fn next(self) -> Option<Self> {
        match self {
            Self::SelectTask => Some(Self::ConfigureBranch),
            Self::ConfigureBranch => Some(Self::SetIterations),
            Self::SetIterations => Some(Self::SelectAgent),
            Self::SelectAgent => Some(Self::Confirm),
            Self::Confirm => None,
        }
    }

    /// Move to previous step
    pub fn prev(self) -> Option<Self> {
        match self {
            Self::SelectTask => None,
            Self::ConfigureBranch => Some(Self::SelectTask),
            Self::SetIterations => Some(Self::ConfigureBranch),
            Self::SelectAgent => Some(Self::SetIterations),
            Self::Confirm => Some(Self::SelectAgent),
        }
    }
}

/// Task info for display in the wizard
#[derive(Debug, Clone)]
pub struct TaskInfo {
    pub path: PathBuf,
    pub name: String,
    pub description: String,
    pub completed: usize,
    pub total: usize,
    pub agent: Option<String>,
}

/// Wizard state containing all configuration being built
#[derive(Debug, Clone)]
pub struct WizardState {
    pub step: WizardStep,
    pub tasks: Vec<TaskInfo>,
    pub selected_task_index: usize,
    pub base_branch: String,
    pub branch_editing: bool,
    pub iterations_input: String,
    pub agent_index: usize, // 0 = claude, 1 = opencode
    pub error_message: Option<String>,
    pub launch_success: bool,
}

impl WizardState {
    /// Create a new wizard state, discovering available tasks
    pub fn new() -> Self {
        let tasks = discover_tasks();
        let current_branch = get_current_branch().unwrap_or_else(|| "main".to_string());

        Self {
            step: WizardStep::SelectTask,
            tasks,
            selected_task_index: 0,
            base_branch: current_branch,
            branch_editing: false,
            iterations_input: "50".to_string(),
            agent_index: 0,
            error_message: None,
            launch_success: false,
        }
    }

    /// Get the selected task info
    pub fn selected_task(&self) -> Option<&TaskInfo> {
        self.tasks.get(self.selected_task_index)
    }

    /// Get the selected agent name
    pub fn selected_agent(&self) -> &str {
        match self.agent_index {
            0 => "claude",
            1 => "opencode",
            _ => "claude",
        }
    }

    /// Get the iterations value (parsed or default)
    pub fn iterations(&self) -> u32 {
        self.iterations_input.parse().unwrap_or(50)
    }

    /// Advance to next step
    pub fn advance(&mut self) -> bool {
        if let Some(next) = self.step.next() {
            self.step = next;
            self.error_message = None;

            // When entering branch step, load agent from prd.json if available
            if next == WizardStep::SelectAgent {
                if let Some(task) = self.selected_task() {
                    if let Some(ref agent) = task.agent {
                        self.agent_index = match agent.as_str() {
                            "opencode" => 1,
                            _ => 0,
                        };
                    }
                }
            }
            true
        } else {
            false
        }
    }

    /// Go back to previous step
    pub fn go_back(&mut self) -> bool {
        if let Some(prev) = self.step.prev() {
            self.step = prev;
            self.error_message = None;
            true
        } else {
            false
        }
    }

    /// Launch the ralph-uv loop with current configuration
    pub fn launch(&mut self) -> bool {
        let task = match self.selected_task() {
            Some(t) => t.clone(),
            None => {
                self.error_message = Some("No task selected".to_string());
                return false;
            }
        };

        let iterations = self.iterations();
        let agent = self.selected_agent().to_string();
        let base_branch = self.base_branch.clone();

        // Build the ralph-uv run command
        let mut cmd = Command::new("ralph-uv");
        cmd.arg("run");
        cmd.arg(task.path.to_string_lossy().as_ref());
        cmd.arg("--max-iterations");
        cmd.arg(iterations.to_string());
        cmd.arg("--agent");
        cmd.arg(&agent);
        if !base_branch.is_empty() {
            cmd.arg("--base-branch");
            cmd.arg(&base_branch);
        }

        // Spawn as detached process (runs in background)
        match cmd
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(_) => {
                self.launch_success = true;
                self.error_message = None;
                true
            }
            Err(e) => {
                self.error_message = Some(format!("Failed to launch: {}", e));
                false
            }
        }
    }
}

/// Discover available tasks from the tasks/ directory
fn discover_tasks() -> Vec<TaskInfo> {
    let tasks_dir = PathBuf::from("tasks");
    if !tasks_dir.exists() {
        return Vec::new();
    }

    let mut tasks = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&tasks_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            // Skip archived directory
            if path.file_name().map_or(false, |n| n == "archived") {
                continue;
            }
            if path.is_dir() {
                let prd_path = path.join("prd.json");
                if prd_path.exists() {
                    if let Ok(content) = std::fs::read_to_string(&prd_path) {
                        if let Ok(prd) = serde_json::from_str::<serde_json::Value>(&content) {
                            let description = prd
                                .get("description")
                                .and_then(|v| v.as_str())
                                .unwrap_or("No description")
                                .chars()
                                .take(60)
                                .collect::<String>();

                            let total = prd
                                .get("userStories")
                                .and_then(|v| v.as_array())
                                .map(|arr| arr.len())
                                .unwrap_or(0);

                            let completed = prd
                                .get("userStories")
                                .and_then(|v| v.as_array())
                                .map(|arr| {
                                    arr.iter()
                                        .filter(|s| {
                                            s.get("passes")
                                                .and_then(|v| v.as_bool())
                                                .unwrap_or(false)
                                        })
                                        .count()
                                })
                                .unwrap_or(0);

                            let agent = prd
                                .get("agent")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());

                            let name = path
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("unknown")
                                .to_string();

                            tasks.push(TaskInfo {
                                path,
                                name,
                                description,
                                completed,
                                total,
                                agent,
                            });
                        }
                    }
                }
            }
        }
    }

    tasks.sort_by(|a, b| a.name.cmp(&b.name));
    tasks
}

/// Get the current git branch name
fn get_current_branch() -> Option<String> {
    Command::new("git")
        .args(["branch", "--show-current"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        })
}

/// Render the wizard modal overlay
pub fn render_wizard(frame: &mut Frame, area: Rect, state: &WizardState) {
    // Calculate modal dimensions (centered, 70% width, dynamic height)
    let modal_width = (area.width as f32 * 0.7).max(50.0).min(90.0) as u16;
    let modal_height = match state.step {
        WizardStep::SelectTask => {
            let task_count = state.tasks.len().min(8) as u16;
            (task_count + 8).max(12).min(area.height.saturating_sub(4))
        }
        WizardStep::Confirm => 14u16,
        _ => 10u16,
    };
    let modal_x = (area.width.saturating_sub(modal_width)) / 2;
    let modal_y = (area.height.saturating_sub(modal_height)) / 2;
    let modal_area = Rect::new(modal_x, modal_y, modal_width, modal_height);

    // Clear the modal area
    frame.render_widget(Clear, modal_area);

    // Build step indicator
    let step_num = state.step.number();
    let total_steps = WizardStep::total();
    let step_indicator = format!("Step {}/{}", step_num, total_steps);

    // Modal block with border
    let title = Line::from(vec![
        Span::styled(" ", Style::default()),
        Span::styled(
            "NEW LOOP",
            Style::default()
                .fg(CYAN_PRIMARY)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!(" - {} ", state.step.title()),
            Style::default().fg(TEXT_PRIMARY),
        ),
        Span::styled(
            format!("[{}] ", step_indicator),
            Style::default().fg(TEXT_MUTED),
        ),
    ]);

    let modal_block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_set(ROUNDED_BORDERS)
        .border_style(Style::default().fg(CYAN_PRIMARY))
        .style(Style::default().bg(BG_SECONDARY));

    let inner_area = modal_block.inner(modal_area);
    frame.render_widget(modal_block, modal_area);

    // Render step content
    match state.step {
        WizardStep::SelectTask => render_task_selection(frame, inner_area, state),
        WizardStep::ConfigureBranch => render_branch_config(frame, inner_area, state),
        WizardStep::SetIterations => render_iterations_config(frame, inner_area, state),
        WizardStep::SelectAgent => render_agent_selection(frame, inner_area, state),
        WizardStep::Confirm => render_confirmation(frame, inner_area, state),
    }
}

fn render_task_selection(frame: &mut Frame, area: Rect, state: &WizardState) {
    let layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // Instruction
            Constraint::Length(1), // Gap
            Constraint::Min(1),    // Task list
            Constraint::Length(1), // Gap
            Constraint::Length(1), // Hints
        ])
        .split(area);

    // Instruction
    let instruction = Paragraph::new(Line::from(vec![Span::styled(
        "Select a task directory:",
        Style::default().fg(TEXT_PRIMARY),
    )]));
    frame.render_widget(instruction, layout[0]);

    if state.tasks.is_empty() {
        let empty_msg = Paragraph::new(Line::from(vec![Span::styled(
            "  No tasks found in tasks/ directory",
            Style::default().fg(RED_ERROR),
        )]));
        frame.render_widget(empty_msg, layout[2]);
    } else {
        // Task list with selection
        let max_visible = layout[2].height as usize;
        let scroll_offset = state
            .selected_task_index
            .saturating_sub(max_visible.saturating_sub(1));

        let mut lines: Vec<Line> = Vec::new();
        for (idx, task) in state
            .tasks
            .iter()
            .enumerate()
            .skip(scroll_offset)
            .take(max_visible)
        {
            let is_selected = idx == state.selected_task_index;
            let prefix = if is_selected { "▸ " } else { "  " };
            let progress = format!("[{}/{}]", task.completed, task.total);

            let name_style = if is_selected {
                Style::default()
                    .fg(CYAN_PRIMARY)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(TEXT_PRIMARY)
            };

            let inner_width = area.width.saturating_sub(4) as usize;
            let name_width = task.name.chars().count();
            let progress_width = progress.chars().count();
            let desc_max =
                inner_width.saturating_sub(prefix.len() + name_width + 1 + progress_width + 1);
            let desc: String = task.description.chars().take(desc_max).collect();

            lines.push(Line::from(vec![
                Span::styled(
                    prefix,
                    if is_selected {
                        Style::default().fg(GREEN_ACTIVE)
                    } else {
                        Style::default().fg(TEXT_MUTED)
                    },
                ),
                Span::styled(task.name.clone(), name_style),
                Span::styled(format!(" {} ", progress), Style::default().fg(TEXT_MUTED)),
                Span::styled(desc, Style::default().fg(TEXT_SECONDARY)),
            ]));
        }
        let task_list = Paragraph::new(lines);
        frame.render_widget(task_list, layout[2]);
    }

    // Hints
    render_nav_hints(frame, layout[4], state);
}

fn render_branch_config(frame: &mut Frame, area: Rect, state: &WizardState) {
    let layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // Instruction
            Constraint::Length(1), // Gap
            Constraint::Length(1), // Current branch display
            Constraint::Length(1), // Gap
            Constraint::Length(1), // Input field
            Constraint::Min(0),    // Spacer
            Constraint::Length(1), // Hints
        ])
        .split(area);

    let instruction = Paragraph::new(Line::from(vec![Span::styled(
        "Configure the base branch (branch to create task branch from):",
        Style::default().fg(TEXT_PRIMARY),
    )]));
    frame.render_widget(instruction, layout[0]);

    let current_info = Paragraph::new(Line::from(vec![
        Span::styled("  Current: ", Style::default().fg(TEXT_MUTED)),
        Span::styled(&state.base_branch, Style::default().fg(CYAN_PRIMARY)),
    ]));
    frame.render_widget(current_info, layout[2]);

    // Input field
    let input_style = if state.branch_editing {
        Style::default().fg(TEXT_PRIMARY)
    } else {
        Style::default().fg(TEXT_MUTED)
    };

    let cursor_indicator = if state.branch_editing { "█" } else { "" };
    let input_line = Line::from(vec![
        Span::styled(
            "  > ",
            if state.branch_editing {
                Style::default().fg(GREEN_ACTIVE)
            } else {
                Style::default().fg(BORDER_SUBTLE)
            },
        ),
        Span::styled(state.base_branch.clone(), input_style),
        Span::styled(cursor_indicator, Style::default().fg(TEXT_PRIMARY)),
    ]);
    let input = Paragraph::new(input_line);
    frame.render_widget(input, layout[4]);

    // Hints
    let hint_line = if state.branch_editing {
        Line::from(vec![
            Span::styled(
                "Enter",
                Style::default()
                    .fg(CYAN_PRIMARY)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" confirm  ", Style::default().fg(TEXT_MUTED)),
            Span::styled(
                "Esc",
                Style::default()
                    .fg(CYAN_PRIMARY)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" cancel edit", Style::default().fg(TEXT_MUTED)),
        ])
    } else {
        Line::from(vec![
            Span::styled(
                "e",
                Style::default()
                    .fg(CYAN_PRIMARY)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" edit  ", Style::default().fg(TEXT_MUTED)),
            Span::styled(
                "Enter",
                Style::default()
                    .fg(CYAN_PRIMARY)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" next  ", Style::default().fg(TEXT_MUTED)),
            Span::styled(
                "Esc",
                Style::default()
                    .fg(CYAN_PRIMARY)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" back", Style::default().fg(TEXT_MUTED)),
        ])
    };
    let hints = Paragraph::new(hint_line);
    frame.render_widget(hints, layout[6]);
}

fn render_iterations_config(frame: &mut Frame, area: Rect, state: &WizardState) {
    let layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // Instruction
            Constraint::Length(1), // Gap
            Constraint::Length(1), // Input field
            Constraint::Length(1), // Gap
            Constraint::Length(1), // Validation
            Constraint::Min(0),    // Spacer
            Constraint::Length(1), // Hints
        ])
        .split(area);

    let instruction = Paragraph::new(Line::from(vec![Span::styled(
        "Set maximum iterations (how many agent cycles to run):",
        Style::default().fg(TEXT_PRIMARY),
    )]));
    frame.render_widget(instruction, layout[0]);

    // Input field (always editable in this step)
    let input_line = Line::from(vec![
        Span::styled("  > ", Style::default().fg(GREEN_ACTIVE)),
        Span::styled(
            state.iterations_input.clone(),
            Style::default().fg(TEXT_PRIMARY),
        ),
        Span::styled("█", Style::default().fg(TEXT_PRIMARY)),
    ]);
    let input = Paragraph::new(input_line);
    frame.render_widget(input, layout[2]);

    // Validation feedback
    let validation_line = match state.iterations_input.parse::<u32>() {
        Ok(n) if n > 0 && n <= 1000 => Line::from(vec![Span::styled(
            format!("  ✓ {} iterations", n),
            Style::default().fg(GREEN_SUCCESS),
        )]),
        Ok(n) if n == 0 => Line::from(vec![Span::styled(
            "  ✗ Must be at least 1",
            Style::default().fg(RED_ERROR),
        )]),
        Ok(_) => Line::from(vec![Span::styled(
            "  ✗ Maximum 1000 iterations",
            Style::default().fg(RED_ERROR),
        )]),
        Err(_) => Line::from(vec![Span::styled(
            "  ✗ Enter a valid number",
            Style::default().fg(RED_ERROR),
        )]),
    };
    let validation = Paragraph::new(validation_line);
    frame.render_widget(validation, layout[4]);

    // Hints
    render_nav_hints(frame, layout[6], state);
}

fn render_agent_selection(frame: &mut Frame, area: Rect, state: &WizardState) {
    let layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // Instruction
            Constraint::Length(1), // Gap
            Constraint::Length(1), // Claude option
            Constraint::Length(1), // Opencode option
            Constraint::Length(1), // Gap
            Constraint::Length(1), // Source info
            Constraint::Min(0),    // Spacer
            Constraint::Length(1), // Hints
        ])
        .split(area);

    let instruction = Paragraph::new(Line::from(vec![Span::styled(
        "Select the coding agent to use:",
        Style::default().fg(TEXT_PRIMARY),
    )]));
    frame.render_widget(instruction, layout[0]);

    // Agent options
    let agents = [
        ("claude", "Claude Code (Anthropic CLI)"),
        ("opencode", "OpenCode / Crush (Go-based agent)"),
    ];

    for (i, (name, desc)) in agents.iter().enumerate() {
        let is_selected = i == state.agent_index;
        let prefix = if is_selected { "● " } else { "○ " };
        let line = Line::from(vec![
            Span::styled(
                format!("  {} ", prefix),
                if is_selected {
                    Style::default().fg(GREEN_ACTIVE)
                } else {
                    Style::default().fg(TEXT_MUTED)
                },
            ),
            Span::styled(
                name.to_string(),
                if is_selected {
                    Style::default()
                        .fg(CYAN_PRIMARY)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(TEXT_PRIMARY)
                },
            ),
            Span::styled(format!("  {}", desc), Style::default().fg(TEXT_SECONDARY)),
        ]);
        let paragraph = Paragraph::new(line);
        frame.render_widget(paragraph, layout[2 + i]);
    }

    // Show source info if agent was pre-selected from prd.json
    if let Some(task) = state.selected_task() {
        if let Some(ref agent) = task.agent {
            let source_line = Line::from(vec![
                Span::styled(
                    "  (default from prd.json: ",
                    Style::default().fg(TEXT_MUTED),
                ),
                Span::styled(agent.clone(), Style::default().fg(CYAN_PRIMARY)),
                Span::styled(")", Style::default().fg(TEXT_MUTED)),
            ]);
            let source = Paragraph::new(source_line);
            frame.render_widget(source, layout[5]);
        }
    }

    // Hints
    render_nav_hints(frame, layout[7], state);
}

fn render_confirmation(frame: &mut Frame, area: Rect, state: &WizardState) {
    let layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // Title
            Constraint::Length(1), // Gap
            Constraint::Length(1), // Task
            Constraint::Length(1), // Branch
            Constraint::Length(1), // Iterations
            Constraint::Length(1), // Agent
            Constraint::Length(1), // Gap
            Constraint::Length(1), // Error or success
            Constraint::Min(0),    // Spacer
            Constraint::Length(1), // Hints
        ])
        .split(area);

    let title = Paragraph::new(Line::from(vec![Span::styled(
        "Review configuration:",
        Style::default()
            .fg(TEXT_PRIMARY)
            .add_modifier(Modifier::BOLD),
    )]));
    frame.render_widget(title, layout[0]);

    // Config summary
    let task_name = state
        .selected_task()
        .map(|t| t.name.as_str())
        .unwrap_or("(none)");
    let summary_lines = [
        ("Task:", task_name),
        ("Branch:", &state.base_branch),
        ("Iterations:", &state.iterations_input),
        ("Agent:", state.selected_agent()),
    ];

    for (i, (label, value)) in summary_lines.iter().enumerate() {
        let line = Line::from(vec![
            Span::styled(format!("  {:<12}", label), Style::default().fg(TEXT_MUTED)),
            Span::styled(
                value.to_string(),
                Style::default()
                    .fg(CYAN_PRIMARY)
                    .add_modifier(Modifier::BOLD),
            ),
        ]);
        let paragraph = Paragraph::new(line);
        frame.render_widget(paragraph, layout[2 + i]);
    }

    // Error or success message
    if let Some(ref error) = state.error_message {
        let error_line = Line::from(vec![Span::styled(
            format!("  ✗ {}", error),
            Style::default().fg(RED_ERROR),
        )]);
        let error_paragraph = Paragraph::new(error_line);
        frame.render_widget(error_paragraph, layout[7]);
    } else if state.launch_success {
        let success_line = Line::from(vec![Span::styled(
            "  ✓ Loop launched successfully!",
            Style::default()
                .fg(GREEN_SUCCESS)
                .add_modifier(Modifier::BOLD),
        )]);
        let success_paragraph = Paragraph::new(success_line);
        frame.render_widget(success_paragraph, layout[7]);
    }

    // Hints
    let hint_line = if state.launch_success {
        Line::from(vec![
            Span::styled(
                "Esc",
                Style::default()
                    .fg(CYAN_PRIMARY)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" close wizard", Style::default().fg(TEXT_MUTED)),
        ])
    } else {
        Line::from(vec![
            Span::styled(
                "Enter",
                Style::default()
                    .fg(GREEN_ACTIVE)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" launch  ", Style::default().fg(TEXT_MUTED)),
            Span::styled(
                "Esc",
                Style::default()
                    .fg(CYAN_PRIMARY)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" back", Style::default().fg(TEXT_MUTED)),
        ])
    };
    let hints = Paragraph::new(hint_line);
    frame.render_widget(hints, layout[9]);
}

/// Render standard navigation hints at the bottom
fn render_nav_hints(frame: &mut Frame, area: Rect, state: &WizardState) {
    let has_next = state.step.next().is_some();
    let has_prev = state.step.prev().is_some();

    let mut spans: Vec<Span> = Vec::new();

    if matches!(state.step, WizardStep::SelectTask | WizardStep::SelectAgent) {
        spans.push(Span::styled(
            "↑↓",
            Style::default()
                .fg(CYAN_PRIMARY)
                .add_modifier(Modifier::BOLD),
        ));
        spans.push(Span::styled(" select  ", Style::default().fg(TEXT_MUTED)));
    }

    if has_next {
        spans.push(Span::styled(
            "Enter",
            Style::default()
                .fg(CYAN_PRIMARY)
                .add_modifier(Modifier::BOLD),
        ));
        spans.push(Span::styled(" next  ", Style::default().fg(TEXT_MUTED)));
    }

    if has_prev {
        spans.push(Span::styled(
            "Esc",
            Style::default()
                .fg(CYAN_PRIMARY)
                .add_modifier(Modifier::BOLD),
        ));
        spans.push(Span::styled(" back  ", Style::default().fg(TEXT_MUTED)));
    } else {
        spans.push(Span::styled(
            "Esc",
            Style::default()
                .fg(CYAN_PRIMARY)
                .add_modifier(Modifier::BOLD),
        ));
        spans.push(Span::styled(" cancel", Style::default().fg(TEXT_MUTED)));
    }

    let hint_line = Line::from(spans);
    let hints = Paragraph::new(hint_line);
    frame.render_widget(hints, area);
}

/// Handle keyboard input for the wizard.
/// Returns: None = continue, Some(true) = wizard complete/closed, Some(false) = wizard cancelled
pub fn handle_wizard_input(
    state: &mut WizardState,
    key_code: crossterm::event::KeyCode,
    _modifiers: crossterm::event::KeyModifiers,
) -> Option<bool> {
    use crossterm::event::KeyCode;

    match state.step {
        WizardStep::SelectTask => match key_code {
            KeyCode::Up | KeyCode::Char('k') => {
                if state.selected_task_index > 0 {
                    state.selected_task_index -= 1;
                }
                None
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if state.selected_task_index + 1 < state.tasks.len() {
                    state.selected_task_index += 1;
                }
                None
            }
            KeyCode::Enter => {
                if state.tasks.is_empty() {
                    state.error_message = Some("No tasks available".to_string());
                } else {
                    state.advance();
                }
                None
            }
            KeyCode::Esc => Some(false), // Cancel wizard
            _ => None,
        },

        WizardStep::ConfigureBranch => {
            if state.branch_editing {
                match key_code {
                    KeyCode::Enter => {
                        state.branch_editing = false;
                        None
                    }
                    KeyCode::Esc => {
                        state.branch_editing = false;
                        None
                    }
                    KeyCode::Char(c) => {
                        state.base_branch.push(c);
                        None
                    }
                    KeyCode::Backspace => {
                        state.base_branch.pop();
                        None
                    }
                    _ => None,
                }
            } else {
                match key_code {
                    KeyCode::Char('e') => {
                        state.branch_editing = true;
                        None
                    }
                    KeyCode::Enter => {
                        state.advance();
                        None
                    }
                    KeyCode::Esc => {
                        state.go_back();
                        None
                    }
                    _ => None,
                }
            }
        }

        WizardStep::SetIterations => match key_code {
            KeyCode::Char(c) if c.is_ascii_digit() => {
                state.iterations_input.push(c);
                None
            }
            KeyCode::Backspace => {
                state.iterations_input.pop();
                None
            }
            KeyCode::Enter => {
                // Validate before advancing
                match state.iterations_input.parse::<u32>() {
                    Ok(n) if n > 0 && n <= 1000 => {
                        state.advance();
                    }
                    _ => {
                        state.error_message = Some("Enter a valid number (1-1000)".to_string());
                    }
                }
                None
            }
            KeyCode::Esc => {
                state.go_back();
                None
            }
            _ => None,
        },

        WizardStep::SelectAgent => match key_code {
            KeyCode::Up | KeyCode::Char('k') => {
                if state.agent_index > 0 {
                    state.agent_index -= 1;
                }
                None
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if state.agent_index < 1 {
                    state.agent_index += 1;
                }
                None
            }
            KeyCode::Enter => {
                state.advance();
                None
            }
            KeyCode::Esc => {
                state.go_back();
                None
            }
            _ => None,
        },

        WizardStep::Confirm => match key_code {
            KeyCode::Enter => {
                if state.launch_success {
                    Some(true) // Close wizard after successful launch
                } else {
                    state.launch();
                    None
                }
            }
            KeyCode::Esc => {
                if state.launch_success {
                    Some(true) // Close wizard
                } else {
                    state.go_back();
                    None
                }
            }
            _ => None,
        },
    }
}
