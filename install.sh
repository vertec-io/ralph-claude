#!/bin/bash
# Ralph TUI Installer
# Installs ralph-tui binary and Claude Code skills

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_header() {
    echo ""
    echo -e "${BLUE}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║  Ralph TUI Installer                                          ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}!${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_info() {
    echo -e "${BLUE}→${NC} $1"
}

# Check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

print_header

# Determine install locations
INSTALL_BIN="${HOME}/.local/bin"
INSTALL_CONFIG="${HOME}/.config/ralph"
INSTALL_SKILLS="${HOME}/.claude/skills"

echo "Installation paths:"
echo "  Binary:  $INSTALL_BIN/ralph-tui"
echo "  Config:  $INSTALL_CONFIG/"
echo "  Skills:  $INSTALL_SKILLS/"
echo ""

# Check for Rust/Cargo
if ! command_exists cargo; then
    print_error "Cargo (Rust) not found!"
    echo ""
    echo "Options:"
    echo "  1. Install Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    echo "  2. Use cargo install: cargo install --git https://github.com/anthropics/ralph-claude ralph-tui"
    echo "  3. Download pre-built binary from releases (coming soon)"
    echo ""
    exit 1
fi

print_success "Found cargo: $(cargo --version)"

# Build ralph-tui
print_info "Building ralph-tui (release mode)..."
cd "$SCRIPT_DIR/ralph-tui"
cargo build --release

if [ ! -f "target/release/ralph-tui" ]; then
    print_error "Build failed - binary not found"
    exit 1
fi
print_success "Build complete"

# Create directories
print_info "Creating directories..."
mkdir -p "$INSTALL_BIN"
mkdir -p "$INSTALL_CONFIG"
mkdir -p "$INSTALL_SKILLS"
print_success "Directories created"

# Install binary
print_info "Installing binary..."
cp "target/release/ralph-tui" "$INSTALL_BIN/ralph-tui"
chmod +x "$INSTALL_BIN/ralph-tui"
print_success "Installed ralph-tui to $INSTALL_BIN/"

# Install prompt.md
print_info "Installing prompt.md..."
if [ -f "$INSTALL_CONFIG/prompt.md" ]; then
    print_warning "prompt.md already exists at $INSTALL_CONFIG/prompt.md - skipping"
else
    cp "$SCRIPT_DIR/prompt.md" "$INSTALL_CONFIG/prompt.md"
    print_success "Installed prompt.md to $INSTALL_CONFIG/"
fi

# Install skills
print_info "Installing Claude Code skills..."

if [ -d "$INSTALL_SKILLS/prd" ]; then
    print_warning "prd skill already exists - skipping"
else
    cp -r "$SCRIPT_DIR/skills/prd" "$INSTALL_SKILLS/"
    print_success "Installed /prd skill"
fi

if [ -d "$INSTALL_SKILLS/ralph" ]; then
    print_warning "ralph skill already exists - skipping"
else
    cp -r "$SCRIPT_DIR/skills/ralph" "$INSTALL_SKILLS/"
    print_success "Installed /ralph skill"
fi

# Check PATH
echo ""
if [[ ":$PATH:" != *":$INSTALL_BIN:"* ]]; then
    print_warning "$INSTALL_BIN is not in your PATH"
    echo ""
    echo "Add this to your shell config (~/.bashrc, ~/.zshrc, etc.):"
    echo ""
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""
    echo "Then restart your shell or run: source ~/.bashrc"
else
    print_success "$INSTALL_BIN is in PATH"
fi

echo ""
echo -e "${GREEN}Installation complete!${NC}"
echo ""
echo "Usage:"
echo "  ralph-tui                    # Interactive task selection"
echo "  ralph-tui tasks/my-feature   # Run specific task"
echo "  ralph-tui --help             # Show all options"
echo ""
echo "To create a new task:"
echo "  1. Use /prd in Claude Code to create a PRD"
echo "  2. Use /ralph to convert it to prd.json"
echo "  3. Run: ralph-tui"
echo ""
