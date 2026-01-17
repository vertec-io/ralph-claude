use std::io::{self, stdout, Read};
use std::sync::{Arc, Mutex};
use std::thread;

use crossterm::{
    event::{self, Event, KeyCode},
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    ExecutableCommand,
};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use ratatui::{
    prelude::*,
    widgets::{Block, Borders, Paragraph},
};

/// Mode for modal input system
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Ralph,  // Default mode - focus on left panel
    Claude, // Claude mode - focus on right panel, forward input to PTY
}

/// Shared state for PTY with VT100 parser
struct PtyState {
    parser: vt100::Parser,
    child_exited: bool,
}

impl PtyState {
    fn new(rows: u16, cols: u16) -> Self {
        Self {
            parser: vt100::Parser::new(rows, cols, 1000), // 1000 lines of scrollback
            child_exited: false,
        }
    }
}

/// Application state
struct App {
    pty_state: Arc<Mutex<PtyState>>,
    master_pty: Option<Box<dyn portable_pty::MasterPty + Send>>,
    mode: Mode,
}

impl App {
    fn new(rows: u16, cols: u16) -> Self {
        Self {
            pty_state: Arc::new(Mutex::new(PtyState::new(rows, cols))),
            master_pty: None,
            mode: Mode::Ralph, // Default to Ralph mode
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
        let mut state = self.pty_state.lock().unwrap();
        state.parser.screen_mut().set_size(rows, cols);
    }
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

fn main() -> io::Result<()> {
    // Setup terminal
    enable_raw_mode()?;
    stdout().execute(EnterAlternateScreen)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout()))?;

    // Get initial terminal size for PTY
    let initial_size = terminal.size()?;
    // Calculate right panel size (70% of width, minus borders)
    let pty_cols = (initial_size.width as f32 * 0.70) as u16 - 2;
    let pty_rows = initial_size.height - 3; // Account for bottom bar and borders

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

    // Spawn bash as proof of concept
    let cmd = CommandBuilder::new("bash");
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

    // Drop slave after spawning (important for proper cleanup)
    drop(pair.slave);

    // Create app state with VT100 parser sized to PTY dimensions
    let mut app = App::new(pty_rows, pty_cols);
    app.master_pty = Some(pair.master);

    // Clone reader for background thread
    let mut reader = app
        .master_pty
        .as_ref()
        .unwrap()
        .try_clone_reader()
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

    // Spawn thread to read PTY output and feed to VT100 parser
    let pty_state = Arc::clone(&app.pty_state);
    let reader_thread = thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    // EOF - child process has exited
                    let mut state = pty_state.lock().unwrap();
                    state.child_exited = true;
                    break;
                }
                Ok(n) => {
                    // Feed raw bytes to VT100 parser - it handles escape sequences
                    let mut state = pty_state.lock().unwrap();
                    state.parser.process(&buf[..n]);
                }
                Err(_) => {
                    let mut state = pty_state.lock().unwrap();
                    state.child_exited = true;
                    break;
                }
            }
        }
    });

    // Track last known size for resize detection
    let mut last_cols = pty_cols;
    let mut last_rows = pty_rows;

    // Run the app
    let result = run(&mut terminal, &mut app, &mut last_cols, &mut last_rows);

    // Wait for child process to exit
    let _ = child.wait();

    // Drop master PTY to signal EOF to reader thread
    drop(app.master_pty.take());

    // Wait for reader thread to finish
    let _ = reader_thread.join();

    // Restore terminal
    disable_raw_mode()?;
    stdout().execute(LeaveAlternateScreen)?;

    result
}

fn run(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut App,
    last_cols: &mut u16,
    last_rows: &mut u16,
) -> io::Result<()> {
    loop {
        terminal.draw(|frame| {
            let area = frame.area();

            // Check for terminal resize
            let new_pty_cols = (area.width as f32 * 0.70) as u16 - 2;
            let new_pty_rows = area.height.saturating_sub(3);

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
                    Style::default().fg(Color::Green).add_modifier(Modifier::BOLD),
                    Style::default().fg(Color::DarkGray),
                ),
                Mode::Claude => (
                    Style::default().fg(Color::DarkGray),
                    Style::default().fg(Color::Green).add_modifier(Modifier::BOLD),
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
                .border_style(left_border_style);

            // Get PTY state for display
            let state = app.pty_state.lock().unwrap();
            let status_text = if state.child_exited {
                "PTY: Child process exited"
            } else {
                "PTY: Running bash (proof of concept)"
            };

            let left_content = Paragraph::new(status_text)
                .block(left_block)
                .style(Style::default().fg(Color::White));

            frame.render_widget(left_content, left_panel_area);

            // Right panel: Claude Code (PTY output with VT100 rendering)
            let right_title = match app.mode {
                Mode::Claude => " Claude Code [ACTIVE] ",
                Mode::Ralph => " Claude Code ",
            };
            let right_block = Block::default()
                .title(right_title)
                .borders(Borders::ALL)
                .border_style(right_border_style);

            // Render VT100 screen content with proper ANSI colors
            // The screen already shows the most recent content (auto-scroll behavior
            // is handled by the terminal emulator when new content is written)
            let screen = state.parser.screen();
            let lines = render_vt100_screen(screen);

            let right_content = Paragraph::new(lines).block(right_block);

            frame.render_widget(right_content, right_panel_area);

            // Bottom bar with keybinding hints (mode-specific)
            let keybindings_text = match app.mode {
                Mode::Ralph => " q: Quit | i/Tab: Enter Claude Mode ",
                Mode::Claude => " Press Esc to return to Ralph ",
            };
            let keybindings = Paragraph::new(keybindings_text)
                .style(Style::default().fg(Color::Black).bg(Color::Cyan));

            frame.render_widget(keybindings, bottom_bar_area);
        })?;

        // Check if child exited
        {
            let state = app.pty_state.lock().unwrap();
            if state.child_exited {
                // Wait a moment before exiting so user can see final output
                drop(state);
                std::thread::sleep(std::time::Duration::from_millis(500));
                break;
            }
        }

        // Handle input based on current mode
        if event::poll(std::time::Duration::from_millis(50))? {
            if let Event::Key(key) = event::read()? {
                match app.mode {
                    Mode::Ralph => {
                        // In Ralph mode: handle TUI controls
                        match key.code {
                            KeyCode::Char('q') => break,
                            KeyCode::Char('i') | KeyCode::Tab => {
                                app.mode = Mode::Claude;
                            }
                            _ => {}
                        }
                    }
                    Mode::Claude => {
                        // In Claude mode: Escape returns to Ralph mode
                        // (Other keys will be forwarded to PTY in US-007)
                        if key.code == KeyCode::Esc {
                            app.mode = Mode::Ralph;
                        }
                    }
                }
            }
        }
    }

    Ok(())
}
