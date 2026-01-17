//! Theme module for ralph-tui
//!
//! This module provides a centralized color palette and styling constants
//! for the "midnight developer cockpit" aesthetic.

use ratatui::style::Color;
use ratatui::symbols::border::Set;

// ============================================================================
// Background Colors - Deep Space Palette
// ============================================================================

/// Primary background color - deepest space black (#0a0e14)
pub const BG_PRIMARY: Color = Color::Rgb(10, 14, 20);

/// Secondary background color - slightly lighter (#12161c)
pub const BG_SECONDARY: Color = Color::Rgb(18, 22, 28);

/// Tertiary background color - for highlighted areas (#1a1f26)
pub const BG_TERTIARY: Color = Color::Rgb(26, 31, 38);

/// Subtle border color (#1e2530)
pub const BORDER_SUBTLE: Color = Color::Rgb(30, 37, 48);

// ============================================================================
// Accent Colors - Cyan/Teal Primary
// ============================================================================

/// Primary cyan accent color (#00d4aa)
pub const CYAN_PRIMARY: Color = Color::Rgb(0, 212, 170);

/// Dimmed cyan for secondary elements (#0a8a6e)
pub const CYAN_DIM: Color = Color::Rgb(10, 138, 110);

// ============================================================================
// Status Colors
// ============================================================================

/// Green success color (#4ade80)
pub const GREEN_SUCCESS: Color = Color::Rgb(74, 222, 128);

/// Green active/running indicator (#22c55e)
pub const GREEN_ACTIVE: Color = Color::Rgb(34, 197, 94);

/// Amber warning color (#fbbf24)
pub const AMBER_WARNING: Color = Color::Rgb(251, 191, 36);

/// Red error color (#f87171)
pub const RED_ERROR: Color = Color::Rgb(248, 113, 113);

// ============================================================================
// Text Colors
// ============================================================================

/// Primary text color - bright white (#e2e8f0)
pub const TEXT_PRIMARY: Color = Color::Rgb(226, 232, 240);

/// Secondary text color - muted gray (#94a3b8)
pub const TEXT_SECONDARY: Color = Color::Rgb(148, 163, 184);

/// Muted text color - for labels and hints (#64748b)
pub const TEXT_MUTED: Color = Color::Rgb(100, 116, 139);

// ============================================================================
// Border Sets
// ============================================================================

/// Rounded corner border set for modern card styling
///
/// ```text
/// ╭─────╮
/// │xxxxx│
/// │xxxxx│
/// ╰─────╯
/// ```
pub const ROUNDED_BORDERS: Set = Set {
    top_left: "╭",
    top_right: "╮",
    bottom_left: "╰",
    bottom_right: "╯",
    vertical_left: "│",
    vertical_right: "│",
    horizontal_top: "─",
    horizontal_bottom: "─",
};

// ============================================================================
// Layout Spacing Constants
// ============================================================================

/// Padding inside card widgets (in cells)
pub const CARD_PADDING: u16 = 1;

/// Gap between major sections (in cells)
pub const SECTION_GAP: u16 = 1;

/// Gap between card widgets (in cells)
pub const CARD_GAP: u16 = 1;
