//! Lucide icon set rendered through egui's SVG image loader.
//!
//! Icons ship as Lucide SVG source under `assets/icons`, so a control never
//! falls back to a text glyph whose metrics differ from the design. The stroke
//! color in the source files is white, which lets `Image::tint` reproduce any
//! semantic token exactly.

use eframe::egui::{self, Color32, ImageSource, Rect, Ui, Vec2};

/// Every icon the window uses. Kept explicit so an unused asset cannot drift
/// into the binary and a missing one fails at compile time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Icon {
    Play,
    Pause,
    Resume,
    Retry,
    Cancel,
    VolumeOn,
    VolumeOff,
    CaptionsOn,
    CaptionsOff,
    Fullscreen,
    Film,
    Bookmark,
    StepBackward,
    StepForward,
    Speed,
    Contrast,
    Folder,
    FolderPlus,
    FolderOpen,
    FolderMove,
    Pencil,
    Star,
    Heart,
    MoreVertical,
    Trash,
    Back,
    Search,
}

impl Icon {
    pub fn source(self) -> ImageSource<'static> {
        match self {
            Self::Play => egui::include_image!("../assets/icons/play.svg"),
            Self::Pause => egui::include_image!("../assets/icons/pause.svg"),
            Self::Resume => egui::include_image!("../assets/icons/download.svg"),
            Self::Retry => egui::include_image!("../assets/icons/rotate-ccw.svg"),
            Self::Cancel => egui::include_image!("../assets/icons/x.svg"),
            Self::VolumeOn => egui::include_image!("../assets/icons/volume-2.svg"),
            Self::VolumeOff => egui::include_image!("../assets/icons/volume-x.svg"),
            Self::CaptionsOn => egui::include_image!("../assets/icons/captions.svg"),
            Self::CaptionsOff => egui::include_image!("../assets/icons/captions-off.svg"),
            Self::Fullscreen => egui::include_image!("../assets/icons/maximize.svg"),
            Self::Film => egui::include_image!("../assets/icons/film.svg"),
            Self::Bookmark => egui::include_image!("../assets/icons/bookmark.svg"),
            Self::StepBackward => egui::include_image!("../assets/icons/step-back.svg"),
            Self::StepForward => egui::include_image!("../assets/icons/step-forward.svg"),
            Self::Speed => egui::include_image!("../assets/icons/gauge.svg"),
            Self::Contrast => egui::include_image!("../assets/icons/contrast.svg"),
            Self::Folder => egui::include_image!("../assets/icons/folder.svg"),
            Self::FolderPlus => egui::include_image!("../assets/icons/folder-plus.svg"),
            Self::FolderOpen => egui::include_image!("../assets/icons/folder-open.svg"),
            Self::FolderMove => egui::include_image!("../assets/icons/folder-input.svg"),
            Self::Pencil => egui::include_image!("../assets/icons/pencil.svg"),
            Self::Star => egui::include_image!("../assets/icons/star.svg"),
            Self::Heart => egui::include_image!("../assets/icons/heart.svg"),
            Self::MoreVertical => egui::include_image!("../assets/icons/ellipsis-vertical.svg"),
            Self::Trash => egui::include_image!("../assets/icons/trash-2.svg"),
            Self::Back => egui::include_image!("../assets/icons/corner-up-left.svg"),
            Self::Search => egui::include_image!("../assets/icons/search.svg"),
        }
    }
}

/// Loads the SVG decoder once per context.
pub fn install(context: &egui::Context) {
    egui_extras::install_image_loaders(context);
}

/// Paints an icon centered in a caller-owned rect, which keeps a control's hit
/// area and its glyph box independent.
pub fn paint_centered(ui: &Ui, icon: Icon, rect: Rect, size: f32, tint: Color32) {
    egui::Image::new(icon.source())
        .tint(tint)
        .paint_at(ui, Rect::from_center_size(rect.center(), Vec2::splat(size)));
}
