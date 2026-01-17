#!/bin/bash
# Ralph TUI Uninstaller
# Removes ralph-tui binary, config, and optionally skills

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_header() {
    echo ""
    echo -e "${BLUE}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║  Ralph TUI Uninstaller                                        ║${NC}"
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

# Installation paths
INSTALL_BIN="${HOME}/.local/bin"
INSTALL_CONFIG="${HOME}/.config/ralph"
INSTALL_SKILLS="${HOME}/.claude/skills"

print_header

echo "This will remove:"
echo "  - $INSTALL_BIN/ralph-tui"
echo "  - $INSTALL_CONFIG/ (prompt.md)"
echo ""

# Check what exists
BINARY_EXISTS=false
CONFIG_EXISTS=false
PRD_SKILL_EXISTS=false
RALPH_SKILL_EXISTS=false

[ -f "$INSTALL_BIN/ralph-tui" ] && BINARY_EXISTS=true
[ -d "$INSTALL_CONFIG" ] && CONFIG_EXISTS=true
[ -d "$INSTALL_SKILLS/prd" ] && PRD_SKILL_EXISTS=true
[ -d "$INSTALL_SKILLS/ralph" ] && RALPH_SKILL_EXISTS=true

if [ "$BINARY_EXISTS" = false ] && [ "$CONFIG_EXISTS" = false ]; then
    print_warning "Ralph TUI doesn't appear to be installed"
    exit 0
fi

# Confirm uninstall
read -p "Continue with uninstall? [y/N]: " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 0
fi

echo ""

# Remove binary
if [ "$BINARY_EXISTS" = true ]; then
    rm -f "$INSTALL_BIN/ralph-tui"
    print_success "Removed $INSTALL_BIN/ralph-tui"
else
    print_warning "Binary not found at $INSTALL_BIN/ralph-tui"
fi

# Remove config
if [ "$CONFIG_EXISTS" = true ]; then
    rm -rf "$INSTALL_CONFIG"
    print_success "Removed $INSTALL_CONFIG/"
else
    print_warning "Config not found at $INSTALL_CONFIG/"
fi

# Ask about skills
if [ "$PRD_SKILL_EXISTS" = true ] || [ "$RALPH_SKILL_EXISTS" = true ]; then
    echo ""
    echo "Claude Code skills found:"
    [ "$PRD_SKILL_EXISTS" = true ] && echo "  - $INSTALL_SKILLS/prd"
    [ "$RALPH_SKILL_EXISTS" = true ] && echo "  - $INSTALL_SKILLS/ralph"
    echo ""
    read -p "Remove skills too? [y/N]: " REMOVE_SKILLS

    if [[ "$REMOVE_SKILLS" =~ ^[Yy]$ ]]; then
        if [ "$PRD_SKILL_EXISTS" = true ]; then
            rm -rf "$INSTALL_SKILLS/prd"
            print_success "Removed prd skill"
        fi
        if [ "$RALPH_SKILL_EXISTS" = true ]; then
            rm -rf "$INSTALL_SKILLS/ralph"
            print_success "Removed ralph skill"
        fi
    else
        print_info "Keeping skills (you can still use /prd and /ralph in Claude Code)"
    fi
fi

echo ""
echo -e "${GREEN}Uninstall complete!${NC}"
echo ""
