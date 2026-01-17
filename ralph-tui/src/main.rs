use std::io::{self, stdout, Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use crossterm::{
    event::{self, Event, KeyCode, KeyModifiers},
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
    pty_writer: Option<Box<dyn Write + Send>>,
    mode: Mode,
}

impl App {
    fn new(rows: u16, cols: u16) -> Self {
        Self {
            pty_state: Arc::new(Mutex::new(PtyState::new(rows, cols))),
            master_pty: None,
            pty_writer: None,
            mode: Mode::Ralph, // Default to Ralph mode
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

    // Create app state with VT100 parser sized to PTY dimensions
    let mut app = App::new(pty_rows, pty_cols);
    app.master_pty = Some(pair.master);
    app.pty_writer = Some(pty_writer);

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
