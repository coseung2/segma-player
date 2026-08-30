//! Manager-owned player session state.
//!
//! Playback commands, mpv integration, and seek preview retain their existing
//! modules and UI-thread ownership. Native HWND lifetime and PiP geometry live
//! behind their dedicated controllers, so this type owns only playback state.

use std::time::{Duration, Instant};

use crate::gif_export::GifExportController;
use crate::jobs::{self, MediaFile};
use crate::player_backend::PlayerController;
use crate::player_contract::{PlayerCommand, PlayerSnapshot};
use crate::seek_preview::SeekPreviewController;
use crate::shortcuts::{PlayerShortcuts, ShortcutAction};

pub(crate) struct PlayerSession {
    pub(crate) controller: PlayerController,
    pub(crate) gif_export: GifExportController,
    pub(crate) seek_preview: SeekPreviewController,
    pub(crate) loaded_file: Option<String>,
    pub(crate) media: Option<MediaFile>,
    pub(crate) pending_resume_position: Option<f64>,
    pub(crate) last_resume_save: Instant,
    pub(crate) loaded_folder: Option<String>,
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
            loaded_file: None,
            media: None,
            pending_resume_position: None,
            last_resume_save: Instant::now() - Duration::from_secs(3),
            loaded_folder: None,
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
