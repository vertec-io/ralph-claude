#!/bin/bash
# Ralph Installation Script
# Installs skills, prompt.md, and hooks with version detection
# Usage: ./install.sh [--force]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Installation paths
SKILLS_INSTALL_DIR="$HOME/.claude/skills"
PROMPT_INSTALL_DIR="$HOME/.config/ralph"
BIN_INSTALL_DIR="$HOME/.local/bin"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse command line arguments
FORCE_UPGRADE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    -f|--force)
      FORCE_UPGRADE=true
      shift
      ;;
    -h|--help)
      echo "Usage: ./install.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  -f, --force    Skip version prompts and always upgrade"
      echo "  -h, --help     Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: ./install.sh [--force]"
      exit 1
      ;;
  esac
done

# Parse version from SKILL.md YAML frontmatter
# Looks for: version: "X.Y" or version: X.Y between --- delimiters
# Returns 0.0 if not found
parse_skill_version() {
  local skill_file="$1"

  if [ ! -f "$skill_file" ]; then
    echo "0.0"
    return
  fi

  # Extract YAML frontmatter (between first two ---) and find version field
  local version
  version=$(awk '
    BEGIN { in_frontmatter=0; found_start=0 }
    /^---$/ {
      if (!found_start) { found_start=1; in_frontmatter=1; next }
      else { exit }
    }
    in_frontmatter && /^version:/ {
      # Extract version value, handling quotes
      gsub(/version:[ \t]*/, "")
      gsub(/["'"'"']/, "")
      gsub(/[ \t\r\n]/, "")
      print
      exit
    }
  ' "$skill_file" 2>/dev/null)

  if [ -z "$version" ]; then
    echo "0.0"
  else
    echo "$version"
  fi
}

# Parse version from prompt.md HTML comment
# Looks for: <!-- version: X.Y -->
# Returns 0.0 if not found
parse_prompt_version() {
  local prompt_file="$1"

  if [ ! -f "$prompt_file" ]; then
    echo "0.0"
    return
  fi

  # Extract version from HTML comment
  local version
  version=$(grep -oP '<!--\s*version:\s*\K[0-9]+\.[0-9]+' "$prompt_file" 2>/dev/null | head -1)

  if [ -z "$version" ]; then
    echo "0.0"
  else
    echo "$version"
  fi
}

# Compare two version strings
# Returns: 0 if equal, 1 if v1 > v2, 2 if v1 < v2
compare_versions() {
  local v1="$1"
  local v2="$2"

  # Extract major and minor parts
  local v1_major="${v1%%.*}"
  local v1_minor="${v1#*.}"
  local v2_major="${v2%%.*}"
  local v2_minor="${v2#*.}"

  # Handle cases where there's no minor version
  [ -z "$v1_minor" ] || [ "$v1_minor" = "$v1" ] && v1_minor="0"
  [ -z "$v2_minor" ] || [ "$v2_minor" = "$v2" ] && v2_minor="0"

  # Compare major versions
  if [ "$v1_major" -gt "$v2_major" ] 2>/dev/null; then
    return 1
  elif [ "$v1_major" -lt "$v2_major" ] 2>/dev/null; then
    return 2
  fi

  # Major versions equal, compare minor
  if [ "$v1_minor" -gt "$v2_minor" ] 2>/dev/null; then
    return 1
  elif [ "$v1_minor" -lt "$v2_minor" ] 2>/dev/null; then
    return 2
  fi

  return 0
}

# Check if upgrade is needed and prompt user
# Returns 0 if should install, 1 if should skip
check_and_prompt_upgrade() {
  local name="$1"
  local installed_version="$2"
  local repo_version="$3"

  compare_versions "$installed_version" "$repo_version"
  local cmp_result=$?

  if [ $cmp_result -eq 0 ]; then
    # Versions match
    echo -e "${GREEN}✓${NC} $name is up to date (v$repo_version)"
    return 1
  elif [ $cmp_result -eq 1 ]; then
    # Installed is newer (shouldn't happen normally)
    echo -e "${YELLOW}⚠${NC} $name: installed (v$installed_version) is newer than repo (v$repo_version)"
    if [ "$FORCE_UPGRADE" = true ]; then
      return 0
    fi
    read -p "  Overwrite with repo version? [y/N] " -n 1 -r
    echo
    [[ $REPLY =~ ^[Yy]$ ]] && return 0 || return 1
  else
    # Repo is newer
    echo -e "${BLUE}↑${NC} $name: upgrade available (v$installed_version → v$repo_version)"
    if [ "$FORCE_UPGRADE" = true ]; then
      return 0
    fi
    read -p "  Upgrade? [Y/n] " -n 1 -r
    echo
    [[ ! $REPLY =~ ^[Nn]$ ]] && return 0 || return 1
  fi
}

# Create backup of a file
create_backup() {
  local file="$1"
  if [ -f "$file" ]; then
    local backup="${file}.backup-$(date +%Y%m%d-%H%M%S)"
    cp "$file" "$backup"
    echo -e "  ${YELLOW}Backed up to:${NC} $backup"
  fi
}

# Install a skill directory
install_skill() {
  local skill_name="$1"
  local repo_skill_dir="$SCRIPT_DIR/skills/$skill_name"
  local install_skill_dir="$SKILLS_INSTALL_DIR/$skill_name"

  if [ ! -d "$repo_skill_dir" ]; then
    echo -e "${RED}✗${NC} Skill '$skill_name' not found in repo"
    return 1
  fi

  local repo_version
  repo_version=$(parse_skill_version "$repo_skill_dir/SKILL.md")

  local installed_version="0.0"
  if [ -f "$install_skill_dir/SKILL.md" ]; then
    installed_version=$(parse_skill_version "$install_skill_dir/SKILL.md")
  fi

  if check_and_prompt_upgrade "Skill: $skill_name" "$installed_version" "$repo_version"; then
    # Create backup of existing skill
    if [ -d "$install_skill_dir" ]; then
      create_backup "$install_skill_dir/SKILL.md"
    fi

    # Install skill
    mkdir -p "$install_skill_dir"
    cp -r "$repo_skill_dir"/* "$install_skill_dir/"
    echo -e "  ${GREEN}Installed${NC} $skill_name to $install_skill_dir"
  fi
}

# Install prompt.md
install_prompt() {
  local repo_prompt="$SCRIPT_DIR/prompt.md"
  local install_prompt="$PROMPT_INSTALL_DIR/prompt.md"

  if [ ! -f "$repo_prompt" ]; then
    echo -e "${RED}✗${NC} prompt.md not found in repo"
    return 1
  fi

  local repo_version
  repo_version=$(parse_prompt_version "$repo_prompt")

  local installed_version="0.0"
  if [ -f "$install_prompt" ]; then
    installed_version=$(parse_prompt_version "$install_prompt")
  fi

  if check_and_prompt_upgrade "prompt.md" "$installed_version" "$repo_version"; then
    # Create backup
    create_backup "$install_prompt"

    # Install prompt
    mkdir -p "$PROMPT_INSTALL_DIR"
    cp "$repo_prompt" "$install_prompt"
    echo -e "  ${GREEN}Installed${NC} prompt.md to $install_prompt"
  fi
}

# Install hooks and settings for ralph-tui
install_hooks() {
  local hooks_dir="$PROMPT_INSTALL_DIR/hooks"
  local settings_file="$PROMPT_INSTALL_DIR/settings.json"

  echo "Installing hooks..."

  # Create hooks directory
  mkdir -p "$hooks_dir"

  # Install stop-iteration hook
  if [ -f "$SCRIPT_DIR/hooks/stop-iteration.sh" ]; then
    cp "$SCRIPT_DIR/hooks/stop-iteration.sh" "$hooks_dir/"
    chmod +x "$hooks_dir/stop-iteration.sh"
    echo -e "  ${GREEN}Installed${NC} stop-iteration.sh to $hooks_dir"
  fi

  # Install settings.json (always overwrite - it's generated, not user-customized)
  if [ -f "$SCRIPT_DIR/hooks/settings.json" ]; then
    cp "$SCRIPT_DIR/hooks/settings.json" "$settings_file"
    echo -e "  ${GREEN}Installed${NC} settings.json to $settings_file"
  fi
}

# Build and install ralph-tui binary
install_ralph_tui() {
  local tui_dir="$SCRIPT_DIR/ralph-tui"
  local binary_name="ralph-tui"
  local install_path="$BIN_INSTALL_DIR/$binary_name"

  echo "Building ralph-tui..."

  # Check if ralph-tui directory exists
  if [ ! -d "$tui_dir" ]; then
    echo -e "${RED}✗${NC} ralph-tui directory not found"
    return 1
  fi

  # Check if cargo is installed
  if ! command -v cargo &> /dev/null; then
    echo -e "${RED}✗${NC} cargo not found. Please install Rust: https://rustup.rs"
    return 1
  fi

  # Build release version
  echo -e "  ${BLUE}Building release binary...${NC}"
  if ! (cd "$tui_dir" && cargo build --release 2>&1 | tail -5); then
    echo -e "${RED}✗${NC} Build failed"
    return 1
  fi

  # Check if binary was created
  local built_binary="$tui_dir/target/release/$binary_name"
  if [ ! -f "$built_binary" ]; then
    echo -e "${RED}✗${NC} Binary not found after build"
    return 1
  fi

  # Create bin directory if needed
  mkdir -p "$BIN_INSTALL_DIR"

  # Copy binary
  cp "$built_binary" "$install_path"
  chmod +x "$install_path"
  echo -e "  ${GREEN}Installed${NC} $binary_name to $install_path"

  # Check if ~/.local/bin is in PATH
  if [[ ":$PATH:" != *":$BIN_INSTALL_DIR:"* ]]; then
    echo ""
    echo -e "  ${YELLOW}Note:${NC} $BIN_INSTALL_DIR is not in your PATH"
    echo -e "  Add this to your shell config (.bashrc, .zshrc, etc.):"
    echo -e "    export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
}

# Main installation
main() {
  echo ""
  echo "╔═══════════════════════════════════════════════════════════════╗"
  echo "║  Ralph Installation                                           ║"
  echo "╚═══════════════════════════════════════════════════════════════╝"
  echo ""

  # Create directories if needed
  mkdir -p "$SKILLS_INSTALL_DIR"
  mkdir -p "$PROMPT_INSTALL_DIR"
  mkdir -p "$BIN_INSTALL_DIR"

  # Build and install ralph-tui binary
  install_ralph_tui

  echo ""

  # Install skills
  echo "Installing skills to $SKILLS_INSTALL_DIR..."
  echo ""

  for skill_dir in "$SCRIPT_DIR/skills"/*/; do
    if [ -d "$skill_dir" ]; then
      skill_name=$(basename "$skill_dir")
      install_skill "$skill_name"
    fi
  done

  echo ""

  # Install prompt.md
  echo "Installing prompt.md to $PROMPT_INSTALL_DIR..."
  echo ""
  install_prompt

  echo ""

  # Install hooks
  install_hooks

  echo ""
  echo -e "${GREEN}Installation complete!${NC}"
  echo ""
  echo "Binary installed to:  $BIN_INSTALL_DIR/ralph-tui"
  echo "Skills installed to:  $SKILLS_INSTALL_DIR"
  echo "Prompt installed to:  $PROMPT_INSTALL_DIR/prompt.md"
  echo "Hooks installed to:   $PROMPT_INSTALL_DIR/hooks/"
}

main
