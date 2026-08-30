//! Manager-owned player session state.
//!
//! Playback commands, mpv integration, seek preview, and PiP geometry retain
//! their existing modules and UI-thread ownership. This type only makes their
//! shared lifetime explicit so `ManagerApp` is no longer the state bag for
//! every player subsystem.

use std::time::{Duration, Instant};

use eframe::egui::{self, Vec2};

use crate::gif_export::GifExportController;
use crate::jobs::{self, MediaFile};
use crate::player_backend::PlayerController;
use crate::player_contract::{PhysicalVideoRect, PlayerCommand, PlayerSnapshot};
use crate::seek_preview::SeekPreviewController;
use crate::shortcuts::{PlayerShortcuts, ShortcutAction};

pub(crate) struct PlayerSession {
    pub(crate) controller: PlayerController,
    pub(crate) gif_export: GifExportController,
    pub(crate) seek_preview: SeekPreviewController,
    pub(crate) parent_hwnd: isize,
    pub(crate) taskbar_icon_applied: bool,
    pub(crate) video_hwnd: isize,
    pub(crate) loaded_file: Option<String>,
    pub(crate) media: Option<MediaFile>,
    pub(crate) pending_resume_position: Option<f64>,
    pub(crate) last_resume_save: Instant,
    pub(crate) loaded_folder: Option<String>,
    pub(crate) last_video_rect: PhysicalVideoRect,
    pub(crate) last_video_logical_rect: egui::Rect,
    pub(crate) fullscreen: bool,
    pub(crate) shortcuts: PlayerShortcuts,
    pub(crate) shortcut_capture: Option<ShortcutAction>,
}

impl Default for PlayerSession {
    fn default() -> Self {
        Self {
            controller: PlayerController::new(),
            gif_export: GifExportController::new(),
            seek_preview: SeekPreviewController::new(),
            parent_hwnd: 0,
            taskbar_icon_applied: false,
            video_hwnd: 0,
            loaded_file: None,
            media: None,
            pending_resume_position: None,
            last_resume_save: Instant::now() - Duration::from_secs(3),
            loaded_folder: None,
            last_video_rect: PhysicalVideoRect::default(),
            last_video_logical_rect: egui::Rect::NOTHING,
            fullscreen: false,
            shortcuts: jobs::read_player_shortcuts(),
            shortcut_capture: None,
        }
    }
}

impl PlayerSession {
    pub(crate) fn load(
        &mut self,
        folder: Option<String>,
        file_name: String,
        media: Option<MediaFile>,
        resume_position: Option<f64>,
        path: std::path::PathBuf,
    ) {
        self.pending_resume_position = resume_position;
        self.seek_preview.media_changed();
        self.loaded_file = Some(file_name);
        self.loaded_folder = folder;
        self.media = media;
        let _ = self.controller.send(PlayerCommand::Load(path));
    }

    pub(crate) fn stop(&mut self) {
        let _ = self.controller.send(PlayerCommand::Stop);
        self.seek_preview.media_changed();
        self.loaded_file = None;
        self.loaded_folder = None;
        self.media = None;
        self.pending_resume_position = None;
    }

    pub(crate) fn apply_pending_resume(&mut self, snapshot: &PlayerSnapshot) {
        if snapshot.loaded_path.is_some() && snapshot.duration > 0.0 {
            if let Some(position) = self.pending_resume_position.take() {
                let _ = self.controller.send(PlayerCommand::SeekAbsolute(
                    position.min((snapshot.duration - 0.5).max(0.0)),
                ));
            }
        }
    }

    pub(crate) fn shutdown(&mut self) {
        self.seek_preview.shutdown();
        self.controller.shutdown();
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct PipSessionState<R> {
    pub(crate) armed: bool,
    pub(crate) dismissed: bool,
    pub(crate) position: Option<egui::Pos2>,
    pub(crate) width: f32,
    pub(crate) move_until: Option<Instant>,
    pub(crate) move_offset: Vec2,
    pub(crate) move_start: Option<egui::Pos2>,
    pub(crate) resize_drag: Option<R>,
}

impl<R> PipSessionState<R> {
    pub(crate) fn new(width: f32) -> Self {
        Self {
            armed: false,
            dismissed: false,
            position: None,
            width,
            move_until: None,
            move_offset: Vec2::ZERO,
            move_start: None,
            resize_drag: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pip_state_starts_inactive_without_geometry() {
        let state = PipSessionState::<()>::new(320.0);
        assert!(!state.armed);
        assert!(!state.dismissed);
        assert!(state.position.is_none());
        assert!(state.resize_drag.is_none());
        assert_eq!(state.move_offset, Vec2::ZERO);
    }
}
