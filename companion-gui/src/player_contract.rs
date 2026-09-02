//! Shared contract between the embedded player backend and egui player view.
//!
//! Keep this module free of Win32, process, and egui types so the backend and
//! presentation can be tested independently.

use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ColorRangeMode {
    #[default]
    Auto,
    Limited,
    Full,
}

impl ColorRangeMode {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Auto => "자동",
            Self::Limited => "16–235",
            Self::Full => "0–255",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VideoFitMode {
    #[default]
    Fit,
    Fill,
    Stretch,
}

impl VideoFitMode {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Fit => "맞춤",
            Self::Fill => "채우기",
            Self::Stretch => "늘이기",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceColorRange {
    Limited,
    Full,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubtitleTrack {
    pub id: i64,
    pub title: String,
    pub language: Option<String>,
    pub selected: bool,
    pub external: bool,
}

impl SubtitleTrack {
    pub fn label(&self) -> String {
        if let Some(language) = self
            .language
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return language_display_name(language);
        }
        let title = self.title.trim();
        if title.is_empty() {
            "자막".to_string()
        } else {
            title.to_string()
        }
    }
}

/// Shows a track in its own language rather than a generic code, so the toggle
/// reads as the language the viewer will actually see.
pub fn language_display_name(code: &str) -> String {
    let normalized = code.trim().to_ascii_lowercase();
    let primary = normalized
        .split(['-', '_'])
        .next()
        .unwrap_or(normalized.as_str());
    match primary {
        "ko" | "kor" => "한국어",
        "en" | "eng" => "English",
        "ja" | "jpn" => "日本語",
        "zh" | "chi" | "zho" => "中文",
        "es" | "spa" => "Español",
        "fr" | "fra" | "fre" => "Français",
        "de" | "deu" | "ger" => "Deutsch",
        "ru" | "rus" => "Русский",
        "pt" | "por" => "Português",
        "it" | "ita" => "Italiano",
        "id" | "ind" => "Bahasa Indonesia",
        "th" | "tha" => "ไทย",
        "vi" | "vie" => "Tiếng Việt",
        "ar" | "ara" => "العربية",
        "hi" | "hin" => "हिन्दी",
        _ => return code.trim().to_uppercase(),
    }
    .to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PhysicalVideoRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl PhysicalVideoRect {
    pub fn visible(self) -> bool {
        self.width > 1 && self.height > 1
    }
}

#[derive(Debug, Clone)]
pub struct PlayerSnapshot {
    pub engine_available: bool,
    pub loaded_path: Option<PathBuf>,
    pub title: String,
    pub duration: f64,
    pub position: f64,
    pub paused: bool,
    pub volume: f64,
    pub muted: bool,
    pub speed: f64,
    pub subtitle_visible: bool,
    pub subtitle_delay: f64,
    pub subtitle_tracks: Vec<SubtitleTrack>,
    pub detected_color_range: Option<SourceColorRange>,
    pub color_range_mode: ColorRangeMode,
    pub video_fit_mode: VideoFitMode,
    pub loop_a: Option<f64>,
    pub loop_b: Option<f64>,
    pub seeking: bool,
    pub error: Option<String>,
}

impl Default for PlayerSnapshot {
    fn default() -> Self {
        Self {
            engine_available: false,
            loaded_path: None,
            title: String::new(),
            duration: 0.0,
            position: 0.0,
            paused: true,
            volume: 100.0,
            muted: false,
            speed: 1.0,
            subtitle_visible: true,
            subtitle_delay: 0.0,
            subtitle_tracks: Vec::new(),
            detected_color_range: None,
            color_range_mode: ColorRangeMode::Auto,
            video_fit_mode: VideoFitMode::Fit,
            loop_a: None,
            loop_b: None,
            seeking: false,
            error: None,
        }
    }
}

#[derive(Debug, Clone)]
pub enum PlayerCommand {
    SetVideoWindow(isize),
    SetFullscreenControls(bool),
    Load(PathBuf),
    TogglePause,
    SeekAbsolute(f64),
    SeekRelative(f64),
    SetVolume(f64),
    ToggleMute,
    SetSpeed(f64),
    SetSubtitleDelay(f64),
    ToggleSubtitles,
    SelectSubtitle(Option<i64>),
    SetColorRange(ColorRangeMode),
    SetVideoFitMode(VideoFitMode),
    SetLoopA(Option<f64>),
    SetLoopB(Option<f64>),
    ClearLoop,
    StepFrameForward,
    StepFrameBackward,
    Stop,
    Shutdown,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_range_labels_are_compact_states_not_explanations() {
        assert_eq!(ColorRangeMode::Auto.label(), "자동");
        assert_eq!(ColorRangeMode::Limited.label(), "16–235");
        assert_eq!(ColorRangeMode::Full.label(), "0–255");
    }

    #[test]
    fn video_fit_labels_are_short_control_states() {
        assert_eq!(VideoFitMode::Fit.label(), "맞춤");
        assert_eq!(VideoFitMode::Fill.label(), "채우기");
        assert_eq!(VideoFitMode::Stretch.label(), "늘이기");
    }

    #[test]
    fn subtitle_label_prefers_language_then_title() {
        let track = SubtitleTrack {
            id: 1,
            title: "Korean full".into(),
            language: Some("ko".into()),
            selected: true,
            external: true,
        };
        assert_eq!(track.label(), "한국어");
    }

    #[test]
    fn language_names_are_shown_in_their_own_language() {
        assert_eq!(language_display_name("ko"), "한국어");
        assert_eq!(language_display_name("KOR"), "한국어");
        assert_eq!(language_display_name("ja"), "日本語");
        assert_eq!(language_display_name("en-US"), "English");
        assert_eq!(language_display_name("pt_BR"), "Português");
        // Unknown codes stay recognizable instead of collapsing to "자막".
        assert_eq!(language_display_name("qqq"), "QQQ");
    }

    #[test]
    fn a_track_without_language_falls_back_to_its_title() {
        let track = SubtitleTrack {
            id: 2,
            title: "Signs & Songs".into(),
            language: None,
            selected: false,
            external: false,
        };
        assert_eq!(track.label(), "Signs & Songs");
    }
}
