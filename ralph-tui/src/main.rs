mod theme;

use theme::{
    get_pulse_color, BG_PRIMARY, BG_SECONDARY, BG_TERTIARY, BORDER_SUBTLE, CYAN_DIM, CYAN_PRIMARY,
    GREEN_ACTIVE, GREEN_SUCCESS, AMBER_WARNING, RED_ERROR, ROUNDED_BORDERS, TEXT_MUTED, TEXT_PRIMARY,
    TEXT_SECONDARY,
};

use std::io::{self, stdout, Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crossterm::{
    event::{self, Event, KeyCode, KeyModifiers},
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    ExecutableCommand,
};
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use ratatui::{
    prelude::*,
    widgets::{Block, Borders, Gauge, Paragraph},
};
use serde::Deserialize;

/// PRD user story
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct UserStory {
    id: String,
    title: String,
    #[allow(dead_code)]
    description: String,
    #[allow(dead_code)]
    acceptance_criteria: Vec<String>,
    priority: u32,
    passes: bool,
    #[allow(dead_code)]
    notes: String,
}

/// PRD document structure
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Prd {
    #[allow(dead_code)]
    project: String,
    #[allow(dead_code)]
    task_dir: String,
    branch_name: String,
    #[allow(dead_code)]
    #[serde(rename = "type")]
    prd_type: String,
    description: String,
    user_stories: Vec<UserStory>,
}

impl Prd {
    /// Load PRD from a JSON file
    fn load(path: &PathBuf) -> io::Result<Self> {
        let content = std::fs::read_to_string(path)?;
        serde_json::from_str(&content).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }

    /// Count completed stories
    fn completed_count(&self) -> usize {
        self.user_stories.iter().filter(|s| s.passes).count()
    }

    /// Get current story (first with passes: false, sorted by priority)
    fn current_story(&self) -> Option<&UserStory> {
        self.user_stories
            .iter()
            .filter(|s| !s.passes)
            .min_by_key(|s| s.priority)
    }
}

/// Mode for modal input system
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Ralph,  // Default mode - focus on left panel
    Claude, // Claude mode - focus on right panel, forward input to PTY
}

/// Claude pricing per million tokens (as of early 2025)
/// Claude 3.5 Sonnet: $3.00 input, $15.00 output
const PRICE_PER_M_INPUT: f64 = 3.00;
const PRICE_PER_M_OUTPUT: f64 = 15.00;

/// Token usage statistics
#[derive(Debug, Clone, Default)]
struct TokenStats {
    input_tokens: u64,
    output_tokens: u64,
}

impl TokenStats {
    /// Parse a number from text, handling commas
    fn parse_number(s: &str) -> Option<u64> {
        let cleaned: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
        cleaned.parse().ok()
    }

    /// Find a number after a pattern in text
    fn find_number_after(text: &str, pattern: &str) -> Option<u64> {
        let lower = text.to_lowercase();
        if let Some(pos) = lower.find(pattern) {
            let after = &text[pos + pattern.len()..];
            // Skip whitespace and colons
            let trimmed = after.trim_start_matches(|c: char| c.is_whitespace() || c == ':');
            // Extract digits (with potential commas)
            let num_str: String = trimmed.chars()
                .take_while(|c| c.is_ascii_digit() || *c == ',')
                .collect();
            if !num_str.is_empty() {
                return Self::parse_number(&num_str);
            }
        }
        None
    }

    /// Parse token usage from Claude output text
    /// Looks for patterns like "Input tokens: X" or "X input tokens"
    fn parse_from_output(text: &str) -> Option<TokenStats> {
        let mut input = None;
        let mut output = None;

        // Try various patterns for input tokens
        for pattern in ["input tokens", "input:", "in:"] {
            if input.is_none() {
                input = Self::find_number_after(text, pattern);
            }
        }

        // Try various patterns for output tokens
        for pattern in ["output tokens", "output:", "out:"] {
            if output.is_none() {
                output = Self::find_number_after(text, pattern);
            }
        }

        // Return stats if we found at least one value
        if input.is_some() || output.is_some() {
            Some(TokenStats {
                input_tokens: input.unwrap_or(0),
                output_tokens: output.unwrap_or(0),
            })
        } else {
            None
        }
    }

    /// Total tokens (input + output)
    fn total(&self) -> u64 {
        self.input_tokens + self.output_tokens
    }

    /// Add another TokenStats to this one
    fn add(&mut self, other: &TokenStats) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
    }

    /// Calculate cost in USD based on Claude Sonnet pricing
    fn calculate_cost(&self) -> f64 {
        let input_cost = (self.input_tokens as f64 / 1_000_000.0) * PRICE_PER_M_INPUT;
        let output_cost = (self.output_tokens as f64 / 1_000_000.0) * PRICE_PER_M_OUTPUT;
        input_cost + output_cost
    }

    /// Format cost as currency string (e.g., "$0.42" or "$1.23")
    fn format_cost(&self) -> String {
        let cost = self.calculate_cost();
        if cost < 0.01 {
            format!("${:.3}", cost)
        } else {
            format!("${:.2}", cost)
        }
    }
}

/// Recent activity from Claude Code (tool calls, actions)
#[derive(Debug, Clone)]
struct Activity {
    action_type: String,
    target: String,
}

impl Activity {
    fn new(action_type: &str, target: &str) -> Self {
        Self {
            action_type: action_type.to_string(),
            target: target.to_string(),
        }
    }

    /// Format for display (truncate target if too long)
    fn format(&self, max_width: usize) -> String {
        let prefix = format!("{}: ", self.action_type);
        let available = max_width.saturating_sub(prefix.len());
        let target = if self.target.len() > available {
            format!("...{}", &self.target[self.target.len().saturating_sub(available.saturating_sub(3))..])
        } else {
            self.target.clone()
        };
        format!("{}{}", prefix, target)
    }
}

/// Parse activities from Claude output
/// Looks for tool call patterns in the output
fn parse_activities(text: &str) -> Vec<Activity> {
    let mut activities = Vec::new();

    // Patterns to look for (case-insensitive matching in output)
    // Claude Code typically shows tool usage in various formats
    let patterns: &[(&str, &[&str])] = &[
        ("Read", &["reading ", "read file", "read("]),
        ("Edit", &["editing ", "edit file", "edit("]),
        ("Write", &["writing ", "write file", "write("]),
        ("Bash", &["running ", "$ ", "bash(", "executing "]),
        ("Grep", &["searching ", "grep(", "grep for"]),
        ("Glob", &["finding files", "glob(", "globbing"]),
        ("TodoWrite", &["updating todos", "todowrite(", "adding todo"]),
    ];

    for line in text.lines() {
        let line_lower = line.to_lowercase();

        for (action_type, prefixes) in patterns {
            for prefix in *prefixes {
                if let Some(pos) = line_lower.find(prefix) {
                    // Extract target (rest of line after pattern, cleaned up)
                    let after = &line[pos + prefix.len()..];
                    let target = after
                        .trim()
                        .trim_matches(|c: char| c == '"' || c == '\'' || c == '`')
                        .split(|c: char| c == '\n' || c == '\r')
                        .next()
                        .unwrap_or("")
                        .chars()
                        .take(100)  // Limit target length
                        .collect::<String>();

                    if !target.is_empty() {
                        let activity = Activity::new(action_type, &target);
                        // Avoid duplicates
                        if !activities.iter().any(|a: &Activity|
                            a.action_type == activity.action_type && a.target == activity.target
                        ) {
                            activities.push(activity);
                        }
                    }
                    break;  // Only match first pattern per line
                }
            }
        }
    }

    activities
}

/// Maximum number of activities to track
const MAX_ACTIVITIES: usize = 10;

/// Shared state for PTY with VT100 parser
struct PtyState {
    parser: vt100::Parser,
    child_exited: bool,
    /// Recent raw output for detecting completion signal
    recent_output: String,
    /// Token stats for current iteration
    iteration_tokens: TokenStats,
    /// Recent activities parsed from output
    activities: Vec<Activity>,
    /// Last parsed output position (to avoid re-parsing)
    last_activity_parse_pos: usize,
}

impl PtyState {
    fn new(rows: u16, cols: u16) -> Self {
        Self {
            parser: vt100::Parser::new(rows, cols, 1000), // 1000 lines of scrollback
            child_exited: false,
            recent_output: String::new(),
            iteration_tokens: TokenStats::default(),
            activities: Vec::new(),
            last_activity_parse_pos: 0,
        }
    }

    /// Append output and trim to last 10KB to prevent memory issues
    fn append_output(&mut self, data: &[u8]) {
        if let Ok(s) = std::str::from_utf8(data) {
            self.recent_output.push_str(s);
            // Keep only last 10KB to limit memory
            if self.recent_output.len() > 10 * 1024 {
                let target_start = self.recent_output.len() - 8 * 1024;
                // Find a valid UTF-8 character boundary
                let start = self
                    .recent_output
                    .char_indices()
                    .find(|(i, _)| *i >= target_start)
                    .map(|(i, _)| i)
                    .unwrap_or(target_start);
                self.recent_output = self.recent_output[start..].to_string();
            }
        }
    }

    /// Check if completion signal is present in recent output
    fn has_completion_signal(&self) -> bool {
        self.recent_output.contains("<promise>COMPLETE</promise>")
    }

    /// Clear recent output (called when starting new iteration)
    fn clear_recent_output(&mut self) {
        self.recent_output.clear();
        self.iteration_tokens = TokenStats::default();
        self.activities.clear();
        self.last_activity_parse_pos = 0;
    }

    /// Parse tokens from recent output and update iteration stats
    fn update_tokens(&mut self) {
        if let Some(stats) = TokenStats::parse_from_output(&self.recent_output) {
            // Only update if we found new data
            if stats.input_tokens > 0 || stats.output_tokens > 0 {
                self.iteration_tokens = stats;
            }
        }
    }

    /// Get current iteration token stats
    fn get_iteration_tokens(&self) -> TokenStats {
        self.iteration_tokens.clone()
    }

    /// Parse activities from new output since last parse
    fn update_activities(&mut self) {
        if self.recent_output.len() <= self.last_activity_parse_pos {
            return;
        }

        // Parse only the new portion of output
        let new_output = &self.recent_output[self.last_activity_parse_pos..];
        let new_activities = parse_activities(new_output);

        // Add new activities, avoiding duplicates
        for activity in new_activities {
            if !self.activities.iter().any(|a|
                a.action_type == activity.action_type && a.target == activity.target
            ) {
                self.activities.push(activity);
            }
        }

        // Keep only the last MAX_ACTIVITIES
        if self.activities.len() > MAX_ACTIVITIES {
            let remove_count = self.activities.len() - MAX_ACTIVITIES;
            self.activities.drain(0..remove_count);
        }

        self.last_activity_parse_pos = self.recent_output.len();
    }

    /// Get recent activities (newest first)
    fn get_activities(&self) -> Vec<Activity> {
        self.activities.iter().rev().cloned().collect()
    }
}

/// Iteration state for tracking progress across Claude restarts
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IterationState {
    Running,       // Claude is currently running
    Completed,     // All stories complete (<promise>COMPLETE</promise> found)
    NeedsRestart,  // Iteration finished but more work remains
    WaitingDelay,  // Waiting before starting next iteration
}

/// Application state
struct App {
    pty_state: Arc<Mutex<PtyState>>,
    master_pty: Option<Box<dyn portable_pty::MasterPty + Send>>,
    pty_writer: Option<Box<dyn Write + Send>>,
    mode: Mode,
    task_dir: PathBuf,
    prd_path: PathBuf,
    prd: Option<Prd>,
    prd_needs_reload: Arc<Mutex<bool>>,
    // Iteration loop state
    current_iteration: u32,
    max_iterations: u32,
    iteration_state: IterationState,
    delay_start: Option<Instant>,
    // Elapsed time tracking
    session_start: Instant,
    iteration_start: Instant,
    // Token usage tracking
    session_tokens: TokenStats,
    // Progress rotation
    rotate_threshold: u32,
    #[allow(dead_code)]
    skip_prompts: bool,
    // Animation state
    animation_tick: u64,
    last_animation_update: Instant,
}

impl App {
    fn new(rows: u16, cols: u16, config: CliConfig) -> Self {
        let prd_path = config.task_dir.join("prd.json");
        let prd = Prd::load(&prd_path).ok();
        let now = Instant::now();

        Self {
            pty_state: Arc::new(Mutex::new(PtyState::new(rows, cols))),
            master_pty: None,
            pty_writer: None,
            mode: Mode::Ralph, // Default to Ralph mode
            task_dir: config.task_dir,
            prd_path,
            prd,
            prd_needs_reload: Arc::new(Mutex::new(false)),
            current_iteration: 1,
            max_iterations: config.max_iterations,
            iteration_state: IterationState::Running,
            delay_start: None,
            session_start: now,
            iteration_start: now,
            session_tokens: TokenStats::default(),
            rotate_threshold: config.rotate_threshold,
            skip_prompts: config.skip_prompts,
            animation_tick: 0,
            last_animation_update: now,
        }
    }

    /// Reload PRD from disk if flagged
    fn reload_prd_if_needed(&mut self) {
        let needs_reload = {
            let Ok(mut flag) = self.prd_needs_reload.lock() else {
                return;
            };
            if *flag {
                *flag = false;
                true
            } else {
                false
            }
        };

        if needs_reload {
            if let Ok(prd) = Prd::load(&self.prd_path) {
                self.prd = Some(prd);
            }
        }
    }

    /// Write bytes to the PTY stdin
    fn write_to_pty(&mut self, data: &[u8]) {
        if let Some(ref mut writer) = self.pty_writer {
            let _ = writer.write_all(data);
            let _ = writer.flush();
        }
    }

    /// Resize the PTY to match the given dimensions
    fn resize_pty(&self, cols: u16, rows: u16) {
        if let Some(ref master) = self.master_pty {
            let _ = master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
        // Also resize the VT100 parser's screen
        if let Ok(mut state) = self.pty_state.lock() {
            state.parser.screen_mut().set_size(rows, cols);
        }
    }
}

/// Simple text wrapping helper
fn wrap_text(text: &str, max_width: usize) -> Vec<String> {
    if max_width == 0 {
        return vec![text.to_string()];
    }

    let mut lines = Vec::new();
    let mut current_line = String::new();

    for word in text.split_whitespace() {
        if current_line.is_empty() {
            current_line = word.to_string();
        } else if current_line.len() + 1 + word.len() <= max_width {
            current_line.push(' ');
            current_line.push_str(word);
        } else {
            lines.push(current_line);
            current_line = word.to_string();
        }
    }

    if !current_line.is_empty() {
        lines.push(current_line);
    }

    if lines.is_empty() {
        lines.push(String::new());
    }

    lines
}

/// Format duration as MM:SS
fn format_duration(duration: Duration) -> String {
    let total_secs = duration.as_secs();
    let mins = total_secs / 60;
    let secs = total_secs % 60;
    format!("{:02}:{:02}", mins, secs)
}

/// Render iteration and completion stat cards in a given area
/// Returns the widgets to be rendered: (left_card, right_card)
fn render_stat_cards(
    area: Rect,
    current_iteration: u32,
    max_iterations: u32,
    completed: usize,
    total: usize,
    frame: &mut Frame,
) {
    // Split area horizontally for two cards with a small gap
    let card_layout = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(50),
            Constraint::Percentage(50),
        ])
        .split(area);

    // Left card: Iterations
    let iter_block = Block::default()
        .borders(Borders::ALL)
        .border_set(ROUNDED_BORDERS)
        .border_style(Style::default().fg(BORDER_SUBTLE))
        .style(Style::default().bg(BG_SECONDARY));

    let iter_content = vec![
        Line::from(vec![
            Span::styled("⏱ ", Style::default().fg(CYAN_PRIMARY)),
            Span::styled(
                format!("{}/{}", current_iteration, max_iterations),
                Style::default().fg(CYAN_PRIMARY).add_modifier(Modifier::BOLD),
            ),
        ]),
        Line::from(vec![
            Span::styled("ITERATIONS", Style::default().fg(TEXT_MUTED)),
        ]),
    ];

    let iter_paragraph = Paragraph::new(iter_content)
        .block(iter_block)
        .alignment(Alignment::Center);

    frame.render_widget(iter_paragraph, card_layout[0]);

    // Right card: Completed
    let comp_block = Block::default()
        .borders(Borders::ALL)
        .border_set(ROUNDED_BORDERS)
        .border_style(Style::default().fg(BORDER_SUBTLE))
        .style(Style::default().bg(BG_SECONDARY));

    let comp_content = vec![
        Line::from(vec![
            Span::styled("◎ ", Style::default().fg(CYAN_PRIMARY)),
            Span::styled(
                format!("{}/{}", completed, total),
                Style::default().fg(CYAN_PRIMARY).add_modifier(Modifier::BOLD),
            ),
        ]),
        Line::from(vec![
            Span::styled("COMPLETED", Style::default().fg(TEXT_MUTED)),
        ]),
    ];

    let comp_paragraph = Paragraph::new(comp_content)
        .block(comp_block)
        .alignment(Alignment::Center);

    frame.render_widget(comp_paragraph, card_layout[1]);
}

/// Story state for rendering
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StoryState {
    Completed,
    Active,
    #[allow(dead_code)]
    Pending,
}

/// Render a single user story card
/// Returns the height of the card:
/// - Completed/Pending: 3 lines (border + content + border)
/// - Active: 5 lines (border + title + progress bar + percentage + border)
fn render_story_card(
    area: Rect,
    story_id: &str,
    story_title: &str,
    state: StoryState,
    tick: u64,
    progress_percent: u16,
    frame: &mut Frame,
) {
    // Determine colors based on state
    // For active state, use pulsing indicator color
    let (indicator, indicator_color, text_color, bg_color) = match state {
        StoryState::Completed => ("●", GREEN_SUCCESS, CYAN_PRIMARY, BG_SECONDARY),
        StoryState::Active => {
            let pulse_color = get_pulse_color(tick, GREEN_ACTIVE, CYAN_DIM);
            ("●", pulse_color, CYAN_PRIMARY, BG_TERTIARY)
        }
        StoryState::Pending => ("○", TEXT_MUTED, TEXT_SECONDARY, BG_SECONDARY),
    };

    // Create card block with rounded borders
    let card_block = Block::default()
        .borders(Borders::ALL)
        .border_set(ROUNDED_BORDERS)
        .border_style(Style::default().fg(BORDER_SUBTLE))
        .style(Style::default().bg(bg_color));

    // Format story ID as #XX (extract numeric part)
    let story_num = story_id.trim_start_matches(|c: char| !c.is_ascii_digit());
    let formatted_id = format!("#{}", story_num);

    // Build card content - single line with indicator, ID, and truncated title
    let inner_width = area.width.saturating_sub(4) as usize; // Account for borders and padding
    let prefix = format!("{} {} ", indicator, formatted_id);
    let prefix_len = prefix.chars().count();
    let available_title_width = inner_width.saturating_sub(prefix_len);

    let truncated_title = if story_title.len() > available_title_width {
        format!("{}...", &story_title[..available_title_width.saturating_sub(3)])
    } else {
        story_title.to_string()
    };

    let title_line = Line::from(vec![
        Span::styled(format!("{} ", indicator), Style::default().fg(indicator_color)),
        Span::styled(format!("{} ", formatted_id), Style::default().fg(text_color).add_modifier(Modifier::BOLD)),
        Span::styled(truncated_title, Style::default().fg(text_color)),
    ]);

    // For active state, show progress bar and percentage
    if state == StoryState::Active {
        // Render block first to get inner area
        let inner_area = card_block.inner(area);
        frame.render_widget(card_block, area);

        // Split inner area: title (1 line), progress bar (1 line), percentage (1 line)
        let inner_layout = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(1), // Title line
                Constraint::Length(1), // Progress bar
                Constraint::Length(1), // Percentage
            ])
            .split(inner_area);

        // Render title
        let title_paragraph = Paragraph::new(vec![title_line]);
        frame.render_widget(title_paragraph, inner_layout[0]);

        // Render progress bar (Gauge widget)
        let gauge = Gauge::default()
            .gauge_style(Style::default().fg(CYAN_PRIMARY).bg(BG_SECONDARY))
            .percent(progress_percent)
            .label(""); // No label on the gauge itself
        frame.render_widget(gauge, inner_layout[1]);

        // Render percentage text below the progress bar
        let percent_text = format!("{}%", progress_percent);
        let percent_line = Line::from(Span::styled(
            percent_text,
            Style::default().fg(TEXT_MUTED),
        ));
        let percent_paragraph = Paragraph::new(vec![percent_line]);
        frame.render_widget(percent_paragraph, inner_layout[2]);
    } else {
        // Completed and Pending states - simple single line card
        let paragraph = Paragraph::new(vec![title_line])
            .block(card_block);
        frame.render_widget(paragraph, area);
    }
}

/// Render token usage and cost stat cards in a given area
fn render_token_cost_cards(
    area: Rect,
    iter_tokens: &TokenStats,
    session_tokens: &TokenStats,
    frame: &mut Frame,
) {
    // Split area horizontally for two cards
    let card_layout = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(50),
            Constraint::Percentage(50),
        ])
        .split(area);

    // Left card: Token usage (iteration)
    let token_block = Block::default()
        .borders(Borders::ALL)
        .border_set(ROUNDED_BORDERS)
        .border_style(Style::default().fg(BORDER_SUBTLE))
        .style(Style::default().bg(BG_SECONDARY));

    // Format token display - show input/output counts
    let token_display = if iter_tokens.total() > 0 {
        format!("{}↓ {}↑", iter_tokens.input_tokens, iter_tokens.output_tokens)
    } else {
        "0↓ 0↑".to_string()
    };

    let token_content = vec![
        Line::from(vec![
            Span::styled("⟠ ", Style::default().fg(CYAN_PRIMARY)),
            Span::styled(
                token_display,
                Style::default().fg(CYAN_PRIMARY).add_modifier(Modifier::BOLD),
            ),
        ]),
        Line::from(vec![
            Span::styled("TOKENS", Style::default().fg(TEXT_MUTED)),
        ]),
    ];

    let token_paragraph = Paragraph::new(token_content)
        .block(token_block)
        .alignment(Alignment::Center);

    frame.render_widget(token_paragraph, card_layout[0]);

    // Right card: Cost (session total)
    let cost_block = Block::default()
        .borders(Borders::ALL)
        .border_set(ROUNDED_BORDERS)
        .border_style(Style::default().fg(BORDER_SUBTLE))
        .style(Style::default().bg(BG_SECONDARY));

    // Use session tokens for total cost display
    let cost_display = session_tokens.format_cost();

    let cost_content = vec![
        Line::from(vec![
            Span::styled("◇ ", Style::default().fg(GREEN_SUCCESS)),
            Span::styled(
                cost_display,
                Style::default().fg(GREEN_SUCCESS).add_modifier(Modifier::BOLD),
            ),
        ]),
        Line::from(vec![
            Span::styled("COST", Style::default().fg(TEXT_MUTED)),
        ]),
    ];

    let cost_paragraph = Paragraph::new(cost_content)
        .block(cost_block)
        .alignment(Alignment::Center);

    frame.render_widget(cost_paragraph, card_layout[1]);
}

/// Build the Ralph prompt from task directory and prompt.md
/// Returns the full prompt string to be piped to Claude Code stdin
/// Embedded default prompt.md as fallback
const EMBEDDED_PROMPT: &str = include_str!("../../prompt.md");

/// Find prompt.md in order of priority:
/// 1. ./ralph/prompt.md (local project customization)
/// 2. ~/.config/ralph/prompt.md (global user config)
/// 3. Embedded fallback (with warning)
fn find_prompt_content() -> (String, Option<String>) {
    // 1. Check local ./ralph/prompt.md
    let local_path = PathBuf::from("ralph/prompt.md");
    if local_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&local_path) {
            return (content, Some(local_path.display().to_string()));
        }
    }

    // 2. Check global ~/.config/ralph/prompt.md
    if let Some(home) = std::env::var_os("HOME") {
        let global_path = PathBuf::from(home).join(".config/ralph/prompt.md");
        if global_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&global_path) {
                return (content, Some(global_path.display().to_string()));
            }
        }
    }

    // 3. Fall back to embedded prompt
    eprintln!("Warning: No prompt.md found in ./ralph/ or ~/.config/ralph/, using embedded default");
    (EMBEDDED_PROMPT.to_string(), None)
}

fn build_ralph_prompt(task_dir: &PathBuf) -> io::Result<String> {
    let (prompt_content, _source) = find_prompt_content();

    // Build the full prompt matching ralph.sh format
    let prompt = format!(
        "# Ralph Agent Instructions\n\n\
         Task Directory: {task_dir}\n\
         PRD File: {task_dir}/prd.json\n\
         Progress File: {task_dir}/progress.txt\n\n\
         {prompt_content}",
        task_dir = task_dir.display(),
        prompt_content = prompt_content,
    );

    Ok(prompt)
}

/// Convert vt100::Color to ratatui::Color
fn vt100_to_ratatui_color(color: vt100::Color) -> Color {
    match color {
        vt100::Color::Default => Color::Reset,
        vt100::Color::Idx(idx) => Color::Indexed(idx),
        vt100::Color::Rgb(r, g, b) => Color::Rgb(r, g, b),
    }
}

/// Render the VT100 screen to a Vec of ratatui Lines (styled text)
/// This function renders the visible content of the terminal emulator
fn render_vt100_screen(screen: &vt100::Screen) -> Vec<Line<'static>> {
    let (rows, cols) = screen.size();
    let mut lines = Vec::with_capacity(rows as usize);

    // Render each visible row
    for row in 0..rows {
        let mut spans = Vec::new();
        let mut col = 0u16;

        while col < cols {
            if let Some(cell) = screen.cell(row, col) {
                let contents = cell.contents();

                // Skip wide character continuations
                if cell.is_wide_continuation() {
                    col += 1;
                    continue;
                }

                let display_str = if contents.is_empty() {
                    " ".to_string()
                } else {
                    contents.to_string()
                };

                let mut style = Style::default();
                style = style.fg(vt100_to_ratatui_color(cell.fgcolor()));
                style = style.bg(vt100_to_ratatui_color(cell.bgcolor()));

                if cell.bold() {
                    style = style.add_modifier(Modifier::BOLD);
                }
                if cell.italic() {
                    style = style.add_modifier(Modifier::ITALIC);
                }
                if cell.underline() {
                    style = style.add_modifier(Modifier::UNDERLINED);
                }
                if cell.inverse() {
                    style = style.add_modifier(Modifier::REVERSED);
                }

                spans.push(Span::styled(display_str, style));

                // Wide characters take 2 columns
                if cell.is_wide() {
                    col += 2;
                } else {
                    col += 1;
                }
            } else {
                spans.push(Span::raw(" "));
                col += 1;
            }
        }
        lines.push(Line::from(spans));
    }

    lines
}

/// Forward a key event to the PTY
/// Converts crossterm key events to the appropriate byte sequences for the terminal
fn forward_key_to_pty(app: &mut App, key_code: KeyCode, modifiers: KeyModifiers) {
    let bytes: Vec<u8> = match key_code {
        // Printable characters
        KeyCode::Char(c) => {
            if modifiers.contains(KeyModifiers::CONTROL) {
                // Handle Ctrl+key combinations
                // Ctrl+A = 0x01, Ctrl+B = 0x02, ..., Ctrl+Z = 0x1A
                // Ctrl+C = 0x03 (interrupt)
                if c.is_ascii_alphabetic() {
                    let ctrl_char = (c.to_ascii_lowercase() as u8) - b'a' + 1;
                    vec![ctrl_char]
                } else if c == '[' {
                    vec![0x1b] // Escape
                } else if c == '\\' {
                    vec![0x1c] // File separator (Ctrl+\)
                } else if c == ']' {
                    vec![0x1d] // Group separator (Ctrl+])
                } else if c == '^' {
                    vec![0x1e] // Record separator (Ctrl+^)
                } else if c == '_' {
                    vec![0x1f] // Unit separator (Ctrl+_)
                } else {
                    // Just send the character for other Ctrl combinations
                    c.to_string().into_bytes()
                }
            } else if modifiers.contains(KeyModifiers::ALT) {
                // Alt+key sends ESC followed by the character
                let mut bytes = vec![0x1b]; // ESC
                bytes.extend(c.to_string().into_bytes());
                bytes
            } else {
                // Regular character
                c.to_string().into_bytes()
            }
        }

        // Special keys
        KeyCode::Enter => vec![b'\r'],     // Carriage return
        KeyCode::Backspace => vec![0x7f],  // DEL character (most terminals)
        KeyCode::Delete => vec![0x1b, b'[', b'3', b'~'], // ANSI escape sequence
        KeyCode::Tab => vec![b'\t'],       // Tab character

        // Arrow keys (ANSI escape sequences)
        KeyCode::Up => vec![0x1b, b'[', b'A'],
        KeyCode::Down => vec![0x1b, b'[', b'B'],
        KeyCode::Right => vec![0x1b, b'[', b'C'],
        KeyCode::Left => vec![0x1b, b'[', b'D'],

        // Home/End keys
        KeyCode::Home => vec![0x1b, b'[', b'H'],
        KeyCode::End => vec![0x1b, b'[', b'F'],

        // Page Up/Down
        KeyCode::PageUp => vec![0x1b, b'[', b'5', b'~'],
        KeyCode::PageDown => vec![0x1b, b'[', b'6', b'~'],

        // Insert key
        KeyCode::Insert => vec![0x1b, b'[', b'2', b'~'],

        // Function keys
        KeyCode::F(1) => vec![0x1b, b'O', b'P'],
        KeyCode::F(2) => vec![0x1b, b'O', b'Q'],
        KeyCode::F(3) => vec![0x1b, b'O', b'R'],
        KeyCode::F(4) => vec![0x1b, b'O', b'S'],
        KeyCode::F(5) => vec![0x1b, b'[', b'1', b'5', b'~'],
        KeyCode::F(6) => vec![0x1b, b'[', b'1', b'7', b'~'],
        KeyCode::F(7) => vec![0x1b, b'[', b'1', b'8', b'~'],
        KeyCode::F(8) => vec![0x1b, b'[', b'1', b'9', b'~'],
        KeyCode::F(9) => vec![0x1b, b'[', b'2', b'0', b'~'],
        KeyCode::F(10) => vec![0x1b, b'[', b'2', b'1', b'~'],
        KeyCode::F(11) => vec![0x1b, b'[', b'2', b'3', b'~'],
        KeyCode::F(12) => vec![0x1b, b'[', b'2', b'4', b'~'],
        KeyCode::F(_) => return, // Unsupported function keys

        // Other keys we don't handle
        _ => return,
    };

    app.write_to_pty(&bytes);
}

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn print_usage() {
    eprintln!("Ralph TUI - Interactive terminal interface for Ralph agent");
    eprintln!();
    eprintln!("Usage: ralph-tui [task-directory] [OPTIONS]");
    eprintln!();
    eprintln!("Arguments:");
    eprintln!("  [task-directory]  Path to the task directory containing prd.json");
    eprintln!("                    If omitted, prompts for task selection");
    eprintln!();
    eprintln!("Options:");
    eprintln!("  -i, --iterations <N>   Maximum iterations to run (default: 10)");
    eprintln!("  --rotate-at <N>        Rotate progress file at N lines (default: 300)");
    eprintln!("  -y, --yes              Skip confirmation prompts");
    eprintln!("  -h, --help             Show this help message");
    eprintln!("  -V, --version          Show version");
    eprintln!();
    eprintln!("Examples:");
    eprintln!("  ralph-tui                          # Interactive task selection");
    eprintln!("  ralph-tui tasks/my-feature         # Run specific task");
    eprintln!("  ralph-tui tasks/my-feature -i 5    # Run with 5 iterations");
}

/// Configuration from CLI arguments
struct CliConfig {
    task_dir: PathBuf,
    max_iterations: u32,
    rotate_threshold: u32,
    skip_prompts: bool,
}

/// Find active tasks (directories with prd.json, excluding archived)
fn find_active_tasks() -> Vec<PathBuf> {
    let tasks_dir = PathBuf::from("tasks");
    if !tasks_dir.exists() {
        return Vec::new();
    }

    let mut tasks = Vec::new();

    // Look for prd.json files in tasks/ subdirectories
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
                    tasks.push(path);
                }
            }
        }
    }

    tasks.sort();
    tasks
}

/// Get task info for display
fn get_task_info(task_dir: &PathBuf) -> (String, usize, usize, String) {
    let prd_path = task_dir.join("prd.json");
    let content = std::fs::read_to_string(&prd_path).unwrap_or_default();

    // Parse JSON to get info
    if let Ok(prd) = serde_json::from_str::<serde_json::Value>(&content) {
        let description = prd.get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("No description")
            .chars()
            .take(50)
            .collect::<String>();

        let stories = prd.get("userStories")
            .and_then(|v| v.as_array())
            .map(|arr| arr.len())
            .unwrap_or(0);

        let completed = prd.get("userStories")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter(|s| {
                s.get("passes").and_then(|v| v.as_bool()).unwrap_or(false)
            }).count())
            .unwrap_or(0);

        let prd_type = prd.get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("feature")
            .to_string();

        (description, completed, stories, prd_type)
    } else {
        ("Unable to parse prd.json".to_string(), 0, 0, "unknown".to_string())
    }
}

/// Display task selection prompt and return selected task
fn prompt_task_selection(tasks: &[PathBuf]) -> io::Result<PathBuf> {
    println!();
    println!("╔═══════════════════════════════════════════════════════════════╗");
    println!("║  Ralph TUI - Select a Task                                    ║");
    println!("╚═══════════════════════════════════════════════════════════════╝");
    println!();
    println!("Active tasks:");
    println!();

    for (i, task) in tasks.iter().enumerate() {
        let (desc, completed, total, prd_type) = get_task_info(task);
        let task_name = task.display().to_string();
        println!(
            "  {}) {:35} [{}/{}] ({})",
            i + 1,
            task_name,
            completed,
            total,
            prd_type
        );
        if !desc.is_empty() {
            println!("     {}", desc);
        }
    }

    println!();
    print!("Select task [1-{}]: ", tasks.len());
    io::stdout().flush()?;

    let mut input = String::new();
    io::stdin().read_line(&mut input)?;

    let selection: usize = input.trim().parse().map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidInput, "Invalid selection")
    })?;

    if selection < 1 || selection > tasks.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Selection out of range",
        ));
    }

    println!();
    println!("Selected: {}", tasks[selection - 1].display());
    println!();

    Ok(tasks[selection - 1].clone())
}

/// Prompt for iterations if not provided
fn prompt_iterations() -> io::Result<u32> {
    print!("Max iterations [10]: ");
    io::stdout().flush()?;

    let mut input = String::new();
    io::stdin().read_line(&mut input)?;

    let input = input.trim();
    if input.is_empty() {
        return Ok(10);
    }

    input.parse().map_err(|_| {
        eprintln!("Invalid number. Using default of 10.");
        io::Error::new(io::ErrorKind::InvalidInput, "Invalid number")
    }).or(Ok(10))
}

/// Prompt for rotation threshold
fn prompt_rotation_threshold(current: u32, progress_lines: usize) -> io::Result<u32> {
    println!();
    println!("Progress file has {} lines (rotation threshold: {})", progress_lines, current);
    print!("Rotation threshold [{}]: ", current);
    io::stdout().flush()?;

    let mut input = String::new();
    io::stdin().read_line(&mut input)?;

    let input = input.trim();
    if input.is_empty() {
        return Ok(current);
    }

    input.parse().map_err(|_| {
        eprintln!("Invalid number. Using default of {}.", current);
        io::Error::new(io::ErrorKind::InvalidInput, "Invalid number")
    }).or(Ok(current))
}

/// Parse CLI arguments and return configuration
fn parse_args() -> io::Result<CliConfig> {
    let args: Vec<String> = std::env::args().collect();
    let mut task_dir: Option<PathBuf> = None;
    let mut max_iterations: Option<u32> = None;
    let mut rotate_threshold: u32 = 300;
    let mut skip_prompts = false;

    let mut i = 1;
    while i < args.len() {
        let arg = &args[i];
        if arg == "-h" || arg == "--help" {
            print_usage();
            std::process::exit(0);
        } else if arg == "-V" || arg == "--version" {
            println!("ralph-tui {}", VERSION);
            std::process::exit(0);
        } else if arg == "-y" || arg == "--yes" {
            skip_prompts = true;
            i += 1;
        } else if arg == "-i" || arg == "--iterations" {
            i += 1;
            if i >= args.len() {
                print_usage();
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Missing value for --iterations",
                ));
            }
            max_iterations = Some(args[i].parse().map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("Invalid iterations value: {}", args[i]),
                )
            })?);
            i += 1;
        } else if arg == "--rotate-at" {
            i += 1;
            if i >= args.len() {
                print_usage();
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Missing value for --rotate-at",
                ));
            }
            rotate_threshold = args[i].parse().map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("Invalid rotate-at value: {}", args[i]),
                )
            })?;
            i += 1;
        } else if !arg.starts_with('-') {
            task_dir = Some(PathBuf::from(arg));
            i += 1;
        } else {
            print_usage();
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("Unknown argument: {}", arg),
            ));
        }
    }

    // If no task directory provided, find and prompt
    let task_dir = if let Some(dir) = task_dir {
        dir
    } else {
        let tasks = find_active_tasks();
        if tasks.is_empty() {
            println!("No active tasks found.");
            println!();
            println!("To create a new task:");
            println!("  1. Use /prd to create a PRD in tasks/{{effort-name}}/");
            println!("  2. Use /ralph to convert it to prd.json");
            println!("  3. Run: ralph-tui tasks/{{effort-name}}");
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "No active tasks found",
            ));
        } else if tasks.len() == 1 {
            println!("Found one active task: {}", tasks[0].display());
            println!();
            tasks[0].clone()
        } else {
            prompt_task_selection(&tasks)?
        }
    };

    // Prompt for iterations if not provided and not skipping prompts
    let max_iterations = if let Some(iters) = max_iterations {
        iters
    } else if skip_prompts {
        10
    } else {
        prompt_iterations().unwrap_or(10)
    };

    // Check progress file for rotation threshold prompt
    let progress_path = task_dir.join("progress.txt");
    if progress_path.exists() && !skip_prompts {
        if let Ok(content) = std::fs::read_to_string(&progress_path) {
            let lines = content.lines().count();
            // Prompt if within 50 lines of threshold or has prior rotations
            let has_prior_rotation = task_dir.join("progress-1.txt").exists();
            if lines > rotate_threshold.saturating_sub(50) as usize || has_prior_rotation {
                rotate_threshold = prompt_rotation_threshold(rotate_threshold, lines)
                    .unwrap_or(rotate_threshold);
            }
        }
    }

    Ok(CliConfig {
        task_dir,
        max_iterations,
        rotate_threshold,
        skip_prompts,
    })
}

/// Spawn Claude Code process and return (child, reader_thread)
/// Returns None if spawning fails
fn spawn_claude(
    app: &mut App,
    pty_rows: u16,
    pty_cols: u16,
) -> io::Result<(Box<dyn portable_pty::Child + Send + Sync>, thread::JoinHandle<()>)> {
    // Build the Ralph prompt
    let ralph_prompt = build_ralph_prompt(&app.task_dir)?;

    // Write prompt to a temp file for safe handling of special characters
    let prompt_temp_file = std::env::temp_dir().join(format!(
        "ralph_prompt_{}_{}.txt",
        std::process::id(),
        app.current_iteration
    ));
    std::fs::write(&prompt_temp_file, &ralph_prompt)?;

    // Create PTY
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: pty_rows,
            cols: pty_cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

    // Spawn Claude Code interactively with the prompt as a positional argument
    // This runs Claude in full interactive mode with the Ralph prompt
    let mut cmd = CommandBuilder::new("claude");

    // Set working directory to current directory (where ralph-tui was invoked)
    if let Ok(cwd) = std::env::current_dir() {
        cmd.cwd(&cwd);
    }

    // Set TERM environment variable for proper terminal handling
    cmd.env("TERM", "xterm-256color");
    // Force color output
    cmd.env("FORCE_COLOR", "1");
    cmd.env("COLORTERM", "truecolor");
    // Disable cursor visibility queries that might cause issues
    cmd.env("NO_COLOR", "0");

    cmd.arg("--dangerously-skip-permissions");
    // Prompt is passed as the last positional argument
    let prompt_content = std::fs::read_to_string(&prompt_temp_file)?;
    cmd.arg(&prompt_content);

    // Clean up temp file
    let _ = std::fs::remove_file(&prompt_temp_file);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

    // Drop slave after spawning (important for proper cleanup)
    drop(pair.slave);

    // Clone reader for background thread (must be done before take_writer)
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

    // Get writer for sending input to PTY
    let pty_writer = pair
        .master
        .take_writer()
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

    // Update app state
    app.master_pty = Some(pair.master);
    app.pty_writer = Some(pty_writer);

    // Reset PTY state for new iteration
    {
        let mut state = app.pty_state.lock().map_err(|_| {
            io::Error::new(io::ErrorKind::Other, "Failed to lock PTY state")
        })?;
        state.child_exited = false;
        state.clear_recent_output();
        // Re-initialize parser to clear screen
        state.parser = vt100::Parser::new(pty_rows, pty_cols, 1000);
    }

    // Spawn thread to read PTY output and feed to VT100 parser
    let pty_state = Arc::clone(&app.pty_state);
    let reader_thread = thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    // EOF - child process has exited
                    if let Ok(mut state) = pty_state.lock() {
                        state.child_exited = true;
                    }
                    break;
                }
                Ok(n) => {
                    // Feed raw bytes to VT100 parser and track for completion detection
                    if let Ok(mut state) = pty_state.lock() {
                        state.parser.process(&buf[..n]);
                        state.append_output(&buf[..n]);
                    }
                }
                Err(_) => {
                    if let Ok(mut state) = pty_state.lock() {
                        state.child_exited = true;
                    }
                    break;
                }
            }
        }
    });

    app.iteration_state = IterationState::Running;

    Ok((child, reader_thread))
}

fn main() -> io::Result<()> {
    // Set up panic hook to restore terminal state before panicking
    let default_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Restore terminal state
        let _ = disable_raw_mode();
        let _ = stdout().execute(LeaveAlternateScreen);
        // Call the default panic handler
        default_panic(info);
    }));

    // Parse CLI arguments (includes interactive prompts if needed)
    let config = parse_args()?;

    // Validate task directory exists
    if !config.task_dir.exists() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("Task directory not found: {}", config.task_dir.display()),
        ));
    }

    // Validate prd.json exists
    let prd_path = config.task_dir.join("prd.json");
    if !prd_path.exists() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("prd.json not found in: {}", config.task_dir.display()),
        ));
    }

    // Show startup banner
    println!();
    println!("╔═══════════════════════════════════════════════════════════════╗");
    println!("║  Ralph TUI - Autonomous Agent Loop                            ║");
    println!("╚═══════════════════════════════════════════════════════════════╝");
    println!();
    println!("  Task:       {}", config.task_dir.display());
    println!("  Max iters:  {}", config.max_iterations);
    println!();
    println!("Starting TUI...");
    println!();

    // Setup terminal
    enable_raw_mode()?;
    stdout().execute(EnterAlternateScreen)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout()))?;

    // Get initial terminal size for PTY
    let initial_size = terminal.size()?;
    // Calculate right panel size (70% of width, minus borders)
    // Ensure minimum sizes to prevent issues
    let pty_cols = ((initial_size.width as f32 * 0.70) as u16).saturating_sub(2).max(40);
    let pty_rows = initial_size.height.saturating_sub(3).max(10);

    // Create app state with VT100 parser sized to PTY dimensions
    let mut app = App::new(pty_rows, pty_cols, config);

    // Set up file watcher for prd.json
    let prd_needs_reload = Arc::clone(&app.prd_needs_reload);
    let prd_path_for_watcher = app.prd_path.clone();
    let _watcher = setup_prd_watcher(prd_path_for_watcher, prd_needs_reload);

    // Track last known size for resize detection
    let mut last_cols = pty_cols;
    let mut last_rows = pty_rows;

    // Spawn initial Claude process
    let (mut child, mut reader_thread) = spawn_claude(&mut app, pty_rows, pty_cols)?;

    // Run the main loop
    let result = loop {
        // Run the UI loop for current iteration
        let run_result = run(&mut terminal, &mut app, &mut last_cols, &mut last_rows);

        // Clean up current iteration - kill the child process first to avoid blocking
        let _ = child.kill();
        let _ = child.wait();
        drop(app.master_pty.take());
        drop(app.pty_writer.take());
        let _ = reader_thread.join();

        // Check iteration state
        match app.iteration_state {
            IterationState::Completed => {
                // All done!
                break run_result;
            }
            IterationState::NeedsRestart => {
                // Check if we have more iterations
                if app.current_iteration >= app.max_iterations {
                    break run_result;
                }

                // Start delay period
                app.iteration_state = IterationState::WaitingDelay;
                app.delay_start = Some(std::time::Instant::now());

                // Wait for 2 seconds (with UI updates)
                let delay_result = run_delay(&mut terminal, &mut app, &mut last_cols, &mut last_rows);
                if let Err(e) = delay_result {
                    break Err(e);
                }

                // Check if user quit during delay
                if matches!(app.iteration_state, IterationState::Completed) {
                    break Ok(());
                }

                // Start next iteration
                app.current_iteration += 1;
                app.iteration_start = Instant::now();
                app.delay_start = None;

                // Reload PRD to get latest state
                if let Ok(prd) = Prd::load(&app.prd_path) {
                    app.prd = Some(prd);
                }

                // Spawn new Claude process
                match spawn_claude(&mut app, last_rows, last_cols) {
                    Ok((new_child, new_thread)) => {
                        child = new_child;
                        reader_thread = new_thread;
                    }
                    Err(e) => {
                        break Err(e);
                    }
                }
            }
            _ => {
                // Running or WaitingDelay - shouldn't reach here normally
                break run_result;
            }
        }
    };

    // Always restore terminal, regardless of any errors
    let _ = disable_raw_mode();
    let _ = stdout().execute(LeaveAlternateScreen);

    result
}

/// Set up a file watcher for prd.json changes
fn setup_prd_watcher(
    prd_path: PathBuf,
    needs_reload: Arc<Mutex<bool>>,
) -> Option<RecommendedWatcher> {
    let config = Config::default().with_poll_interval(Duration::from_secs(1));

    let prd_path_clone = prd_path.clone();
    let watcher_result = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                // Check if the event is for our file
                if event.paths.iter().any(|p| p == &prd_path_clone) {
                    if let Ok(mut flag) = needs_reload.lock() {
                        *flag = true;
                    }
                }
            }
        },
        config,
    );

    match watcher_result {
        Ok(mut watcher) => {
            // Watch the parent directory since some editors replace files
            if let Some(parent) = prd_path.parent() {
                let _ = watcher.watch(parent, RecursiveMode::NonRecursive);
            }
            Some(watcher)
        }
        Err(_) => None,
    }
}

fn run(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut App,
    last_cols: &mut u16,
    last_rows: &mut u16,
) -> io::Result<()> {
    loop {
        // Check if PRD needs reloading (file changed on disk)
        app.reload_prd_if_needed();

        // Update animation tick every 100ms
        if app.last_animation_update.elapsed() >= Duration::from_millis(100) {
            app.animation_tick = app.animation_tick.wrapping_add(1);
            app.last_animation_update = Instant::now();
        }

        terminal.draw(|frame| {
            let area = frame.area();

            // Check for terminal resize
            let new_pty_cols = ((area.width as f32 * 0.70) as u16).saturating_sub(2).max(40);
            let new_pty_rows = area.height.saturating_sub(3).max(10);

            if new_pty_cols != *last_cols || new_pty_rows != *last_rows {
                *last_cols = new_pty_cols;
                *last_rows = new_pty_rows;
                app.resize_pty(new_pty_cols, new_pty_rows);
            }

            // Create main layout: content area + bottom bar
            let main_layout = Layout::default()
                .direction(Direction::Vertical)
                .constraints([
                    Constraint::Min(3),    // Main content area
                    Constraint::Length(1), // Bottom bar (single line)
                ])
                .split(area);

            let content_area = main_layout[0];
            let bottom_bar_area = main_layout[1];

            // Create horizontal split: 30% left panel, 70% right panel
            let panels = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([
                    Constraint::Percentage(30), // Ralph Status panel
                    Constraint::Percentage(70), // Claude Code panel
                ])
                .split(content_area);

            let left_panel_area = panels[0];
            let right_panel_area = panels[1];

            // Determine border styles based on current mode
            let (left_border_style, right_border_style) = match app.mode {
                Mode::Ralph => (
                    Style::default().fg(CYAN_PRIMARY).add_modifier(Modifier::BOLD),
                    Style::default().fg(BORDER_SUBTLE),
                ),
                Mode::Claude => (
                    Style::default().fg(BORDER_SUBTLE),
                    Style::default().fg(CYAN_PRIMARY).add_modifier(Modifier::BOLD),
                ),
            };

            // Left panel: Ralph Status
            let left_title = match app.mode {
                Mode::Ralph => " Ralph Status [ACTIVE] ",
                Mode::Claude => " Ralph Status ",
            };
            let left_block = Block::default()
                .title(left_title)
                .borders(Borders::ALL)
                .border_style(left_border_style)
                .style(Style::default().bg(BG_PRIMARY));

            // Render the outer block first to get the inner area
            let left_inner = left_block.inner(left_panel_area);
            frame.render_widget(left_block, left_panel_area);

            // Get PRD data for stats
            let (completed, total) = if let Some(ref prd) = app.prd {
                (prd.completed_count(), prd.user_stories.len())
            } else {
                (0, 0)
            };

            // Get PTY state for display (use default values if mutex is poisoned)
            let mut pty_state_guard = app.pty_state.lock().ok();

            // Split inner area: header (3 lines), stat cards (8 lines for 2 rows), rest
            let inner_layout = Layout::default()
                .direction(Direction::Vertical)
                .constraints([
                    Constraint::Length(3), // Header
                    Constraint::Length(8), // Two stat card rows (4 lines each)
                    Constraint::Min(0),    // Rest of content
                ])
                .split(left_inner);

            let header_area = inner_layout[0];
            let cards_area = inner_layout[1];
            let content_area_inner = inner_layout[2];

            // Header: Ralph branding
            let header_lines = vec![
                Line::from(vec![
                    Span::styled("● ", Style::default().fg(GREEN_ACTIVE)),
                    Span::styled("RALPH LOOP", Style::default().fg(TEXT_PRIMARY).add_modifier(Modifier::BOLD)),
                ]),
                Line::from(vec![
                    Span::styled(format!("Terminal v{}", VERSION), Style::default().fg(CYAN_PRIMARY)),
                ]),
                Line::from(""), // Gap after header
            ];
            let header = Paragraph::new(header_lines);
            frame.render_widget(header, header_area);

            // Split cards area into two rows
            let cards_layout = Layout::default()
                .direction(Direction::Vertical)
                .constraints([
                    Constraint::Length(4), // First row: iteration/completed
                    Constraint::Length(4), // Second row: tokens/cost
                ])
                .split(cards_area);

            // Render iteration/completion stat cards (first row)
            render_stat_cards(
                cards_layout[0],
                app.current_iteration,
                app.max_iterations,
                completed,
                total,
                frame,
            );

            // Get token stats for second row of cards
            let iter_tokens_for_cards = if let Some(ref guard) = pty_state_guard {
                guard.get_iteration_tokens()
            } else {
                TokenStats::default()
            };

            // Render token/cost stat cards (second row)
            render_token_cost_cards(
                cards_layout[1],
                &iter_tokens_for_cards,
                &app.session_tokens,
                frame,
            );

            // Build remaining status content
            let mut status_lines: Vec<Line> = Vec::new();
            status_lines.push(Line::from("")); // Gap after cards

            // Active Phase section
            let session_elapsed = app.session_start.elapsed();
            status_lines.push(Line::from(vec![
                Span::styled("✦ ACTIVE PHASE", Style::default().fg(TEXT_MUTED)),
            ]));
            // Determine current phase name based on iteration state
            let phase_name = match app.iteration_state {
                IterationState::Running => "Execute Iteration Cycle",
                IterationState::Completed => "All Stories Complete",
                IterationState::NeedsRestart => "Preparing Next Iteration",
                IterationState::WaitingDelay => "Waiting for Delay",
            };
            status_lines.push(Line::from(vec![
                Span::styled(
                    phase_name,
                    Style::default().fg(TEXT_PRIMARY).add_modifier(Modifier::BOLD),
                ),
            ]));
            status_lines.push(Line::from(vec![
                Span::styled(
                    format!("⏱ Uptime: {}", format_duration(session_elapsed)),
                    Style::default().fg(TEXT_MUTED),
                ),
            ]));
            status_lines.push(Line::from("")); // Gap after active phase

            // Elapsed time (iteration-specific)
            let iteration_elapsed = app.iteration_start.elapsed();
            status_lines.push(Line::from(vec![
                Span::styled("Session: ", Style::default().fg(CYAN_PRIMARY).add_modifier(Modifier::BOLD)),
                Span::styled(
                    format_duration(session_elapsed),
                    Style::default().fg(TEXT_PRIMARY),
                ),
                Span::raw("  "),
                Span::styled("Iter: ", Style::default().fg(CYAN_PRIMARY).add_modifier(Modifier::BOLD)),
                Span::styled(
                    format_duration(iteration_elapsed),
                    Style::default().fg(TEXT_PRIMARY),
                ),
            ]));
            status_lines.push(Line::from(""));

            // Token usage and activities - update from PTY output first
            let (iter_tokens, activities) = if let Some(ref mut guard) = pty_state_guard {
                guard.update_tokens();
                guard.update_activities();
                (guard.get_iteration_tokens(), guard.get_activities())
            } else {
                (TokenStats::default(), Vec::new())
            };
            let session_tokens = &app.session_tokens;

            // Only show tokens section if we have any data
            if iter_tokens.total() > 0 || session_tokens.total() > 0 {
                status_lines.push(Line::from(vec![
                    Span::styled("Tokens: ", Style::default().fg(CYAN_PRIMARY).add_modifier(Modifier::BOLD)),
                    Span::styled(
                        format!("{}↓ {}↑",
                            iter_tokens.input_tokens,
                            iter_tokens.output_tokens,
                        ),
                        Style::default().fg(TEXT_PRIMARY),
                    ),
                    Span::raw("  "),
                    Span::styled(
                        iter_tokens.format_cost(),
                        Style::default().fg(GREEN_SUCCESS),
                    ),
                ]));
                if session_tokens.total() > 0 {
                    status_lines.push(Line::from(vec![
                        Span::styled("Session: ", Style::default().fg(CYAN_PRIMARY)),
                        Span::styled(
                            format!("{} tokens", session_tokens.total()),
                            Style::default().fg(CYAN_PRIMARY),
                        ),
                        Span::raw("  "),
                        Span::styled(
                            session_tokens.format_cost(),
                            Style::default().fg(GREEN_SUCCESS),
                        ),
                    ]));
                }
                status_lines.push(Line::from(""));
            }

            // Recent activities section
            if !activities.is_empty() {
                status_lines.push(Line::from(vec![
                    Span::styled("Recent Activity:", Style::default().fg(CYAN_PRIMARY).add_modifier(Modifier::BOLD)),
                ]));
                let max_activity_width = left_panel_area.width.saturating_sub(6) as usize;
                for activity in activities.iter().take(5) {
                    status_lines.push(Line::from(vec![
                        Span::styled("  • ", Style::default().fg(TEXT_MUTED)),
                        Span::styled(
                            activity.format(max_activity_width),
                            Style::default().fg(TEXT_PRIMARY),
                        ),
                    ]));
                }
                status_lines.push(Line::from(""));
            }

            // PRD information
            if let Some(ref prd) = app.prd {
                // Description
                status_lines.push(Line::from(vec![
                    Span::styled("Task: ", Style::default().fg(CYAN_PRIMARY).add_modifier(Modifier::BOLD)),
                ]));
                // Wrap description to fit panel
                for line in wrap_text(&prd.description, left_panel_area.width.saturating_sub(4) as usize) {
                    status_lines.push(Line::from(Span::raw(format!("  {}", line))));
                }
                status_lines.push(Line::from(""));

                // Branch
                status_lines.push(Line::from(vec![
                    Span::styled("Branch: ", Style::default().fg(CYAN_PRIMARY).add_modifier(Modifier::BOLD)),
                    Span::raw(&prd.branch_name),
                ]));
                status_lines.push(Line::from(""));

                // Progress (text display - cards show the numbers)
                let progress_pct = if total > 0 {
                    (completed as f32 / total as f32 * 100.0) as u8
                } else {
                    0
                };
                status_lines.push(Line::from(vec![
                    Span::styled("Progress: ", Style::default().fg(CYAN_PRIMARY).add_modifier(Modifier::BOLD)),
                    Span::styled(
                        format!("{}%", progress_pct),
                        if completed == total {
                            Style::default().fg(GREEN_SUCCESS).add_modifier(Modifier::BOLD)
                        } else {
                            Style::default().fg(CYAN_PRIMARY)
                        },
                    ),
                ]));
                status_lines.push(Line::from(""));

                // User Stories section header
                status_lines.push(Line::from(vec![
                    Span::styled("↳ USER STORIES / PHASES", Style::default().fg(TEXT_MUTED)),
                ]));
            } else {
                status_lines.push(Line::from(vec![
                    Span::styled("Error: ", Style::default().fg(RED_ERROR).add_modifier(Modifier::BOLD)),
                    Span::raw("Failed to load prd.json"),
                ]));
            }

            // Calculate lines for status content
            let status_line_count = status_lines.len() as u16;

            // Split content area: status text at top, story cards below
            let content_split = Layout::default()
                .direction(Direction::Vertical)
                .constraints([
                    Constraint::Length(status_line_count),
                    Constraint::Min(0), // Story cards area
                ])
                .split(content_area_inner);

            let status_area = content_split[0];
            let stories_area = content_split[1];

            let left_content = Paragraph::new(status_lines)
                .style(Style::default().fg(TEXT_PRIMARY));

            frame.render_widget(left_content, status_area);

            // Render story cards if we have a PRD
            if let Some(ref prd) = app.prd {
                // Calculate progress percent for active story based on iterations
                let progress_percent = if app.max_iterations > 0 {
                    ((app.current_iteration as f32 / app.max_iterations as f32) * 100.0) as u16
                } else {
                    0
                };

                // Get stories sorted by priority
                let mut stories: Vec<_> = prd.user_stories.iter().collect();
                stories.sort_by_key(|s| s.priority);

                // Find current story for state comparison
                let current_story = prd.current_story();

                // Card heights: active = 5 lines, others = 3 lines
                let active_card_height = 5u16;
                let normal_card_height = 3u16;

                // Calculate total height needed and visible stories
                let mut y_offset = 0u16;

                for story in stories.iter() {
                    // Determine story state
                    let state = if story.passes {
                        StoryState::Completed
                    } else if Some(*story) == current_story {
                        StoryState::Active
                    } else {
                        StoryState::Pending
                    };

                    let card_height = if state == StoryState::Active {
                        active_card_height
                    } else {
                        normal_card_height
                    };

                    // Check if card fits in available space
                    if y_offset + card_height > stories_area.height {
                        break;
                    }

                    let card_area = Rect {
                        x: stories_area.x,
                        y: stories_area.y + y_offset,
                        width: stories_area.width,
                        height: card_height,
                    };

                    render_story_card(
                        card_area,
                        &story.id,
                        &story.title,
                        state,
                        app.animation_tick,
                        progress_percent,
                        frame,
                    );

                    y_offset += card_height;
                }
            }

            // Right panel: Claude Code (PTY output with VT100 rendering)
            let right_title = match app.mode {
                Mode::Claude => " Claude Code [ACTIVE] ",
                Mode::Ralph => " Claude Code ",
            };
            let right_block = Block::default()
                .title(right_title)
                .borders(Borders::ALL)
                .border_style(right_border_style)
                .style(Style::default().bg(BG_PRIMARY));

            // Render VT100 screen content with proper ANSI colors
            // The screen already shows the most recent content (auto-scroll behavior
            // is handled by the terminal emulator when new content is written)
            let lines = if let Some(ref pty_state) = pty_state_guard {
                let screen = pty_state.parser.screen();
                render_vt100_screen(screen)
            } else {
                vec![Line::from(Span::styled(
                    "Error: Failed to access PTY state",
                    Style::default().fg(RED_ERROR),
                ))]
            };

            let right_content = Paragraph::new(lines).block(right_block);

            frame.render_widget(right_content, right_panel_area);

            // Bottom bar with keybinding hints (mode-specific)
            let keybindings_text = match app.mode {
                Mode::Ralph => " q/Ctrl+C: Quit | i/Tab: Claude Mode ",
                Mode::Claude => " Esc: Ralph Mode | Ctrl+C: Quit ",
            };
            let keybindings = Paragraph::new(keybindings_text)
                .style(Style::default().fg(BG_PRIMARY).bg(BG_TERTIARY));

            frame.render_widget(keybindings, bottom_bar_area);
        })?;

        // Check if child exited
        {
            let state_result = app.pty_state.lock();
            let (child_exited, is_complete, iter_tokens) = match state_result {
                Ok(mut state) => {
                    // Update tokens and activities one final time before checking exit
                    state.update_tokens();
                    state.update_activities();
                    let tokens = state.get_iteration_tokens();
                    (state.child_exited, state.has_completion_signal(), tokens)
                }
                Err(_) => (true, false, TokenStats::default()), // Treat poisoned mutex as child exited
            };
            if child_exited {
                // Accumulate iteration tokens into session totals
                app.session_tokens.add(&iter_tokens);

                // Wait a moment before proceeding so user can see final output
                std::thread::sleep(std::time::Duration::from_millis(500));

                // Set iteration state based on output
                if is_complete {
                    app.iteration_state = IterationState::Completed;
                } else {
                    app.iteration_state = IterationState::NeedsRestart;
                }
                break;
            }
        }

        // Handle input based on current mode
        if event::poll(std::time::Duration::from_millis(50))? {
            if let Event::Key(key) = event::read()? {
                // Universal quit: Ctrl+C or Ctrl+Q in any mode
                if key.modifiers.contains(KeyModifiers::CONTROL) {
                    match key.code {
                        KeyCode::Char('c') | KeyCode::Char('q') => {
                            app.iteration_state = IterationState::Completed;
                            break;
                        }
                        _ => {}
                    }
                }

                match app.mode {
                    Mode::Ralph => {
                        // In Ralph mode: handle TUI controls
                        match key.code {
                            KeyCode::Char('q') => {
                                app.iteration_state = IterationState::Completed;
                                break;
                            }
                            KeyCode::Char('i') | KeyCode::Tab => {
                                app.mode = Mode::Claude;
                            }
                            _ => {}
                        }
                    }
                    Mode::Claude => {
                        // In Claude mode: Escape returns to Ralph mode
                        // All other keys are forwarded to PTY
                        if key.code == KeyCode::Esc {
                            app.mode = Mode::Ralph;
                        } else {
                            // Forward key to PTY
                            forward_key_to_pty(app, key.code, key.modifiers);
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

/// Run the delay loop between iterations (2 seconds)
/// Shows countdown in UI and allows user to quit
fn run_delay(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut App,
    last_cols: &mut u16,
    last_rows: &mut u16,
) -> io::Result<()> {
    const DELAY_SECS: u64 = 2;

    loop {
        // Check if delay is complete
        if let Some(start) = app.delay_start {
            if start.elapsed() >= Duration::from_secs(DELAY_SECS) {
                break;
            }
        } else {
            break;
        }

        // Reload PRD if needed
        app.reload_prd_if_needed();

        terminal.draw(|frame| {
            let area = frame.area();

            // Check for terminal resize
            let new_pty_cols = ((area.width as f32 * 0.70) as u16).saturating_sub(2).max(40);
            let new_pty_rows = area.height.saturating_sub(3).max(10);

            if new_pty_cols != *last_cols || new_pty_rows != *last_rows {
                *last_cols = new_pty_cols;
                *last_rows = new_pty_rows;
            }

            // Create main layout: content area + bottom bar
            let main_layout = Layout::default()
                .direction(Direction::Vertical)
                .constraints([
                    Constraint::Min(3),
                    Constraint::Length(1),
                ])
                .split(area);

            let content_area = main_layout[0];
            let bottom_bar_area = main_layout[1];

            // Create horizontal split
            let panels = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([
                    Constraint::Percentage(30),
                    Constraint::Percentage(70),
                ])
                .split(content_area);

            let left_panel_area = panels[0];
            let right_panel_area = panels[1];

            // Left panel with delay message
            let left_block = Block::default()
                .title(" Ralph Status [ACTIVE] ")
                .borders(Borders::ALL)
                .border_style(Style::default().fg(CYAN_PRIMARY).add_modifier(Modifier::BOLD))
                .style(Style::default().bg(BG_PRIMARY));

            // Render the outer block first to get the inner area
            let left_inner = left_block.inner(left_panel_area);
            frame.render_widget(left_block, left_panel_area);

            // Get PRD data for stats
            let (completed, total) = if let Some(ref prd) = app.prd {
                (prd.completed_count(), prd.user_stories.len())
            } else {
                (0, 0)
            };

            // Split inner area: header (3 lines), stat cards (8 lines for 2 rows), rest
            let inner_layout = Layout::default()
                .direction(Direction::Vertical)
                .constraints([
                    Constraint::Length(3), // Header
                    Constraint::Length(8), // Two stat card rows (4 lines each)
                    Constraint::Min(0),    // Rest of content
                ])
                .split(left_inner);

            let header_area = inner_layout[0];
            let cards_area = inner_layout[1];
            let content_area_inner = inner_layout[2];

            // Header: Ralph branding
            let header_lines = vec![
                Line::from(vec![
                    Span::styled("● ", Style::default().fg(GREEN_ACTIVE)),
                    Span::styled("RALPH LOOP", Style::default().fg(TEXT_PRIMARY).add_modifier(Modifier::BOLD)),
                ]),
                Line::from(vec![
                    Span::styled(format!("Terminal v{}", VERSION), Style::default().fg(CYAN_PRIMARY)),
                ]),
                Line::from(""), // Gap after header
            ];
            let header = Paragraph::new(header_lines);
            frame.render_widget(header, header_area);

            // Split cards area into two rows
            let cards_layout = Layout::default()
                .direction(Direction::Vertical)
                .constraints([
                    Constraint::Length(4), // First row: iteration/completed
                    Constraint::Length(4), // Second row: tokens/cost
                ])
                .split(cards_area);

            // Render iteration/completion stat cards (first row)
            render_stat_cards(
                cards_layout[0],
                app.current_iteration,
                app.max_iterations,
                completed,
                total,
                frame,
            );

            // Get token stats for second row of cards (use last known values during delay)
            let iter_tokens_for_cards = if let Ok(guard) = app.pty_state.lock() {
                guard.get_iteration_tokens()
            } else {
                TokenStats::default()
            };

            // Render token/cost stat cards (second row)
            render_token_cost_cards(
                cards_layout[1],
                &iter_tokens_for_cards,
                &app.session_tokens,
                frame,
            );

            // Build remaining content
            let mut status_lines: Vec<Line> = Vec::new();
            status_lines.push(Line::from("")); // Gap after cards

            // Active Phase section
            let session_elapsed = app.session_start.elapsed();
            status_lines.push(Line::from(vec![
                Span::styled("✦ ACTIVE PHASE", Style::default().fg(TEXT_MUTED)),
            ]));
            // During delay, we're waiting for the next iteration
            let phase_name = "Preparing Next Iteration";
            status_lines.push(Line::from(vec![
                Span::styled(
                    phase_name,
                    Style::default().fg(TEXT_PRIMARY).add_modifier(Modifier::BOLD),
                ),
            ]));
            status_lines.push(Line::from(vec![
                Span::styled(
                    format!("⏱ Uptime: {}", format_duration(session_elapsed)),
                    Style::default().fg(TEXT_MUTED),
                ),
            ]));
            status_lines.push(Line::from("")); // Gap after active phase

            // Elapsed time (iteration-specific)
            let iteration_elapsed = app.iteration_start.elapsed();
            status_lines.push(Line::from(vec![
                Span::styled("Session: ", Style::default().fg(CYAN_PRIMARY).add_modifier(Modifier::BOLD)),
                Span::styled(
                    format_duration(session_elapsed),
                    Style::default().fg(TEXT_PRIMARY),
                ),
                Span::raw("  "),
                Span::styled("Iter: ", Style::default().fg(CYAN_PRIMARY).add_modifier(Modifier::BOLD)),
                Span::styled(
                    format_duration(iteration_elapsed),
                    Style::default().fg(TEXT_PRIMARY),
                ),
            ]));
            status_lines.push(Line::from(""));

            // Delay countdown
            let remaining = if let Some(start) = app.delay_start {
                DELAY_SECS.saturating_sub(start.elapsed().as_secs())
            } else {
                0
            };
            status_lines.push(Line::from(vec![
                Span::styled(
                    format!("Starting next iteration in {}s...", remaining),
                    Style::default().fg(AMBER_WARNING).add_modifier(Modifier::BOLD),
                ),
            ]));
            status_lines.push(Line::from(""));

            // PRD info
            if let Some(ref prd) = app.prd {
                status_lines.push(Line::from(vec![
                    Span::styled("Task: ", Style::default().fg(CYAN_PRIMARY).add_modifier(Modifier::BOLD)),
                ]));
                for line in wrap_text(&prd.description, left_panel_area.width.saturating_sub(4) as usize) {
                    status_lines.push(Line::from(Span::raw(format!("  {}", line))));
                }
                status_lines.push(Line::from(""));

                let progress_pct = if total > 0 {
                    (completed as f32 / total as f32 * 100.0) as u8
                } else {
                    0
                };
                status_lines.push(Line::from(vec![
                    Span::styled("Progress: ", Style::default().fg(CYAN_PRIMARY).add_modifier(Modifier::BOLD)),
                    Span::styled(
                        format!("{}%", progress_pct),
                        Style::default().fg(CYAN_PRIMARY),
                    ),
                ]));
            }

            let left_content = Paragraph::new(status_lines)
                .style(Style::default().fg(TEXT_PRIMARY));

            frame.render_widget(left_content, content_area_inner);

            // Right panel - show last output
            let right_block = Block::default()
                .title(" Claude Code ")
                .borders(Borders::ALL)
                .border_style(Style::default().fg(BORDER_SUBTLE))
                .style(Style::default().bg(BG_PRIMARY));

            let lines = if let Ok(pty_state) = app.pty_state.lock() {
                let screen = pty_state.parser.screen();
                render_vt100_screen(screen)
            } else {
                vec![Line::from(Span::styled(
                    "Error: Failed to access PTY state",
                    Style::default().fg(RED_ERROR),
                ))]
            };

            let right_content = Paragraph::new(lines).block(right_block);
            frame.render_widget(right_content, right_panel_area);

            // Bottom bar
            let keybindings = Paragraph::new(" q: Quit | Waiting for next iteration... ")
                .style(Style::default().fg(BG_PRIMARY).bg(BG_TERTIARY));
            frame.render_widget(keybindings, bottom_bar_area);
        })?;

        // Handle input - allow quit during delay
        if event::poll(std::time::Duration::from_millis(100))? {
            if let Event::Key(key) = event::read()? {
                // q or Ctrl+C to quit
                if key.code == KeyCode::Char('q')
                    || (key.modifiers.contains(KeyModifiers::CONTROL)
                        && matches!(key.code, KeyCode::Char('c') | KeyCode::Char('q')))
                {
                    app.iteration_state = IterationState::Completed;
                    break;
                }
            }
        }
    }

    Ok(())
}
