//! Design tokens ported from the Figma file `hHbERxUjJeaWJ3eYFM1UlA`.
//!
//! Values mirror `design-system/tokens/tokens.json` exactly. Keep this module
//! as the only place raw colors and metrics appear, the same rule the exported
//! CSS follows, so a token change stays a one-file edit.

use eframe::egui::{Color32, CornerRadius, Margin, Stroke};

/// `#RRGGBB` from the token export, opaque.
const fn hex(value: u32) -> Color32 {
    Color32::from_rgb(
        ((value >> 16) & 0xff) as u8,
        ((value >> 8) & 0xff) as u8,
        (value & 0xff) as u8,
    )
}

/// Primitives. Never used directly by a view; semantics below alias them.
mod primitive {
    use super::hex;
    use eframe::egui::Color32;

    pub const WHITE: Color32 = hex(0xFFFFFF);
    pub const GRAY_50: Color32 = hex(0xF7F8F9);
    pub const GRAY_100: Color32 = hex(0xF0F1F3);
    pub const GRAY_200: Color32 = hex(0xE4E6EA);
    pub const GRAY_300: Color32 = hex(0xD2D5DB);
    pub const GRAY_500: Color32 = hex(0x787D86);
    pub const GRAY_600: Color32 = hex(0x5A5F67);
    pub const GRAY_900: Color32 = hex(0x17191D);
    pub const GREEN_50: Color32 = hex(0xEAF6EF);
    pub const GREEN_600: Color32 = hex(0x1F7A4C);
    pub const AMBER_50: Color32 = hex(0xFBF2E3);
    pub const AMBER_600: Color32 = hex(0x9A6206);
    pub const ORANGE_500: Color32 = hex(0xFFA31A);
    pub const RED_50: Color32 = hex(0xFBECEC);
    pub const RED_600: Color32 = hex(0xB32B32);
}

pub mod color {
    use super::primitive;
    use eframe::egui::Color32;

    pub const BG_CANVAS: Color32 = primitive::GRAY_50;
    pub const BG_SURFACE: Color32 = primitive::WHITE;
    pub const BG_SUBTLE: Color32 = primitive::GRAY_100;
    pub const BG_SELECTED: Color32 = primitive::GRAY_100;
    pub const BG_INVERSE: Color32 = primitive::GRAY_900;
    pub const BG_TRACK: Color32 = primitive::GRAY_200;
    pub const BG_SUCCESS: Color32 = primitive::GREEN_50;
    pub const BG_WARNING: Color32 = primitive::AMBER_50;
    pub const BG_DANGER: Color32 = primitive::RED_50;

    pub const TEXT_PRIMARY: Color32 = primitive::GRAY_900;
    pub const TEXT_SECONDARY: Color32 = primitive::GRAY_600;
    pub const TEXT_MUTED: Color32 = primitive::GRAY_500;
    pub const TEXT_INVERSE: Color32 = primitive::WHITE;
    pub const TEXT_SUCCESS: Color32 = primitive::GREEN_600;
    pub const TEXT_WARNING: Color32 = primitive::AMBER_600;
    pub const TEXT_DANGER: Color32 = primitive::RED_600;
    pub const ACCENT: Color32 = primitive::ORANGE_500;

    pub const BORDER_SUBTLE: Color32 = primitive::GRAY_200;
    pub const BORDER_DEFAULT: Color32 = primitive::GRAY_300;
    pub const BORDER_STRONG: Color32 = primitive::GRAY_900;
}

pub mod space {
    pub const X2: f32 = 2.0;
    pub const X4: f32 = 4.0;
    pub const X8: f32 = 8.0;
    pub const X10: f32 = 10.0;
    pub const X12: f32 = 12.0;
    pub const X16: f32 = 16.0;
    pub const X24: f32 = 24.0;
    pub const X28: f32 = 28.0;
}

pub mod radius {
    pub const MD: u8 = 8;
    pub const LG: u8 = 12;
    pub const FULL: u8 = 255;
}

/// Type ramp. Figma renders in Inter; on Windows the product font is Segoe UI,
/// so sizes and line heights carry over but glyph metrics differ slightly.
pub mod text {
    pub const HEADING_LG: f32 = 24.0;
    pub const HEADING_SM: f32 = 14.0;
    pub const BODY_MD: f32 = 13.0;
    pub const BODY_SM: f32 = 12.0;
    pub const LABEL_MD: f32 = 12.0;
    pub const LABEL_SM: f32 = 11.0;
    pub const MONO_SM: f32 = 11.0;
}

/// Fixed metrics taken from the Figma frames.
pub mod metric {
    use eframe::egui::Vec2;

    pub const RAIL_WIDTH: f32 = 232.0;
    pub const NAV_ITEM_HEIGHT: f32 = 38.0;
    pub const CONTROL_HEIGHT: f32 = 32.0;
    /// Icon box inside a control. Lucide is drawn on a 24px grid; 16px keeps
    /// the stroke optically equal to 12–13px label text.
    pub const ICON_SM: f32 = 16.0;
    pub const PROGRESS_HEIGHT: f32 = 6.0;
    pub const NAV_DOT_RADIUS: f32 = 3.0;
    pub const WINDOW_MIN: Vec2 = Vec2::new(880.0, 560.0);
    pub const WINDOW_DEFAULT: Vec2 = Vec2::new(1280.0, 860.0);
}

/// Tone shared by status chips, mapped from the Figma Status components.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Neutral,
    Success,
    Warning,
    Danger,
}

impl Tone {
    pub fn background(self) -> Color32 {
        match self {
            Tone::Neutral => color::BG_SUBTLE,
            Tone::Success => color::BG_SUCCESS,
            Tone::Warning => color::BG_WARNING,
            Tone::Danger => color::BG_DANGER,
        }
    }

    pub fn foreground(self) -> Color32 {
        match self {
            Tone::Neutral => color::TEXT_SECONDARY,
            Tone::Success => color::TEXT_SUCCESS,
            Tone::Warning => color::TEXT_WARNING,
            Tone::Danger => color::TEXT_DANGER,
        }
    }
}

pub fn corner(value: u8) -> CornerRadius {
    CornerRadius::same(value)
}

pub fn hairline(color: Color32) -> Stroke {
    Stroke::new(1.0, color)
}

pub fn margin(all: f32) -> Margin {
    Margin::same(all as i8)
}

pub fn margin_xy(x: f32, y: f32) -> Margin {
    Margin::symmetric(x as i8, y as i8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_match_the_exported_design_system_values() {
        // Spot check the values the design depends on most; a silent drift here
        // would make the native window stop matching the Figma frames.
        assert_eq!(color::BG_CANVAS, Color32::from_rgb(0xF7, 0xF8, 0xF9));
        assert_eq!(color::BG_SURFACE, Color32::from_rgb(0xFF, 0xFF, 0xFF));
        assert_eq!(color::BG_INVERSE, Color32::from_rgb(0x17, 0x19, 0x1D));
        assert_eq!(color::TEXT_PRIMARY, Color32::from_rgb(0x17, 0x19, 0x1D));
        assert_eq!(color::TEXT_MUTED, Color32::from_rgb(0x78, 0x7D, 0x86));
        assert_eq!(color::BORDER_SUBTLE, Color32::from_rgb(0xE4, 0xE6, 0xEA));
        assert_eq!(color::ACCENT, Color32::from_rgb(0xFF, 0xA3, 0x1A));
    }

    #[test]
    fn no_status_tone_reuses_another_tone_foreground() {
        let tones = [Tone::Neutral, Tone::Success, Tone::Warning, Tone::Danger];
        for (index, tone) in tones.iter().enumerate() {
            for other in &tones[index + 1..] {
                assert_ne!(
                    tone.foreground(),
                    other.foreground(),
                    "status tones must stay visually distinct"
                );
            }
        }
    }

    #[test]
    fn the_palette_carries_no_blue_accent() {
        // The user rejected the dark navy and blue direction. Emphasis comes
        // from near-black ink, so no token may be blue-dominant.
        for color in [
            color::BG_INVERSE,
            color::TEXT_PRIMARY,
            color::BORDER_STRONG,
            color::BG_SELECTED,
            color::ACCENT,
        ] {
            let (r, g, b) = (color.r() as i32, color.g() as i32, color.b() as i32);
            assert!(
                b - r < 24 && b - g < 24,
                "token {color:?} leans blue: r={r} g={g} b={b}"
            );
        }
    }
}
