use std::io::{self, stdout};

use crossterm::{
    event::{self, Event, KeyCode},
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    ExecutableCommand,
};
use ratatui::{
    prelude::*,
    widgets::{Block, Borders, Paragraph},
};

fn main() -> io::Result<()> {
    // Setup terminal
    enable_raw_mode()?;
    stdout().execute(EnterAlternateScreen)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout()))?;

    // Run the app
    let result = run(&mut terminal);

    // Restore terminal
    disable_raw_mode()?;
    stdout().execute(LeaveAlternateScreen)?;

    result
}

fn run(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>) -> io::Result<()> {
    loop {
        terminal.draw(|frame| {
            let area = frame.area();

            let block = Block::default()
                .title(" Ralph TUI ")
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::Cyan));

            let text = Paragraph::new("Hello Ralph!\n\nPress 'q' to quit.")
                .block(block)
                .alignment(Alignment::Center)
                .style(Style::default().fg(Color::White));

            frame.render_widget(text, area);
        })?;

        // Handle input
        if event::poll(std::time::Duration::from_millis(100))? {
            if let Event::Key(key) = event::read()? {
                if key.code == KeyCode::Char('q') {
                    break;
                }
            }
        }
    }

    Ok(())
}
