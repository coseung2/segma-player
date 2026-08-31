//! Window state and view assembly.
//!
//! Job state is polled from disk on a fixed interval. The manager never talks
//! to the native messaging host process; the jobs folder is the interface.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use eframe::egui::{self, Color32, RichText, Vec2};

use crate::gif_export::{GifExportRequest, GifExportStatus};
use crate::icons::Icon;
use crate::jobs;
use crate::library_controller::{LibraryController, LibraryFilter, LibrarySort};
use crate::library_state::WatchState;
use crate::license_controller::{LicenseController, LicenseNotice};
use crate::manager_poll::{ManagerPoll, PollResult, POLL_INTERVAL};
use crate::model::{
    self, library_entries, missing_output_count, queue_summary, subtitle_summary, subtitle_views,
};
use crate::pip_controller::PipController;
use crate::player_contract::PlayerCommand;
use crate::player_session::PlayerSession;
use crate::player_surface::{PlayerSurface, SurfaceLayout};
use crate::player_ui::{self, PlayerUiInput};
use crate::queue_controller::QueueController;
use crate::shortcuts::{self, CaptureResult, PlayerShortcuts, ShortcutAction};
use crate::theme::{color, corner, hairline, margin_xy, metric, radius, space, text, Tone};
use crate::thumbnails::ThumbnailCoordinator;
use crate::widgets::{
    button, empty_state, icon_button, job_row, media_thumbnail, menu_row, nav_item, tile_menu,
    ButtonStyle, RowEvent, TileMenuEvent,
};

/// A notice stays long enough to read, then clears itself so a stale message
/// never looks like current state.
const NOTICE_LIFETIME: Duration = Duration::from_secs(6);
const RATING_STAR_HIT_SIZE: f32 = 26.0;
const RATING_STAR_ICON_SIZE: f32 = 14.0;
const BRAND_LOGO_SIZE: f32 = 32.0;

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    Queue,
    Library,
    Player,
    Subtitles,
    Settings,
}

impl View {
    pub const ALL: [View; 5] = [
        View::Queue,
        View::Library,
        View::Player,
        View::Subtitles,
        View::Settings,
    ];

    pub fn label(self) -> &'static str {
        match self {
            View::Queue => "다운로드",
            View::Library => "보관함",
            View::Player => "재생",
            View::Subtitles => "자막",
            View::Settings => "설정",
        }
    }

    pub fn title(self) -> &'static str {
        self.label()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NoticeTone {
    Info,
    Error,
}

struct Notice {
    text: String,
    tone: NoticeTone,
    shown_at: Instant,
}

pub struct ManagerApp {
    view: View,
    poll_state: ManagerPoll,
    queue: QueueController,
    library: LibraryController,
    notice: Option<Notice>,
    player_session: PlayerSession,
    player_surface: PlayerSurface,
    thumbnails: ThumbnailCoordinator,
    license: LicenseController,
    pip: PipController,
}

impl Default for ManagerApp {
    fn default() -> Self {
        Self {
            view: View::Queue,
            poll_state: ManagerPoll::default(),
            queue: QueueController::default(),
            library: LibraryController::default(),
            notice: None,
            player_session: PlayerSession::default(),
            player_surface: PlayerSurface::default(),
            thumbnails: ThumbnailCoordinator::default(),
            license: LicenseController::default(),
            pip: PipController::default(),
        }
    }
}

impl ManagerApp {
    pub fn new(context: &egui::Context) -> Self {
        install_fonts(context);
        install_style(context);
        crate::icons::install(context);
        let mut app = Self::default();
        app.poll(true);
        app
    }

    fn poll(&mut self, force: bool) {
        if self
            .poll_state
            .refresh(force, self.library.folder.as_deref())
            == PollResult::SelectedFolderMissing
        {
            self.library.folder = None;
            let _ = self.poll_state.refresh(true, None);
        }
    }

    fn sync_thumbnails(&mut self, context: &egui::Context) {
        self.thumbnails.sync(
            context,
            self.library.folder.as_deref(),
            &self.poll_state.media_files,
        );
    }

    fn notify(&mut self, text: impl Into<String>, tone: NoticeTone) {
        self.notice = Some(Notice {
            text: text.into(),
            tone,
            shown_at: Instant::now(),
        });
    }

    fn verify_license(&mut self, key: String) {
        if let Some(notice) = self.license.verify(key) {
            self.show_license_notice(notice);
        }
    }

    fn poll_license_result(&mut self) {
        for notice in self.license.poll() {
            self.show_license_notice(notice);
        }
    }

    fn remove_license(&mut self) {
        let notice = self.license.remove();
        self.show_license_notice(notice);
    }

    fn show_license_notice(&mut self, notice: LicenseNotice) {
        match notice {
            LicenseNotice::Info(message) => self.notify(message, NoticeTone::Info),
            LicenseNotice::Error(message) => self.notify(message, NoticeTone::Error),
        }
    }

    fn expire_notice(&mut self) {
        if self
            .notice
            .as_ref()
            .is_some_and(|notice| notice.shown_at.elapsed() > NOTICE_LIFETIME)
        {
            self.notice = None;
        }
    }

    fn handle(&mut self, event: RowEvent) {
        match event {
            RowEvent::Pause(job_id) => self.show_row_action_result(
                jobs::request_pause(&job_id),
                "일시정지를 요청했습니다.",
                "일시정지하지 못했습니다",
            ),
            RowEvent::Resume(job_id) => self.show_row_action_result(
                jobs::restart_job(&job_id, "resume"),
                "이어받기를 시작했습니다.",
                "이어받기를 시작하지 못했습니다",
            ),
            RowEvent::Retry(job_id) => self.show_row_action_result(
                jobs::restart_job(&job_id, "retry"),
                "다시 시도합니다.",
                "다시 시도하지 못했습니다",
            ),
            RowEvent::Play(job_id) => self.play(&job_id),
            RowEvent::Cancel(job_id) => self.show_row_action_result(
                jobs::request_cancel(&job_id),
                "취소를 요청했습니다.",
                "취소하지 못했습니다",
            ),
            RowEvent::OpenFolder => self.open_folder(),
        }
        self.poll(true);
    }

    fn show_row_action_result(
        &mut self,
        result: std::io::Result<()>,
        success: &str,
        failure: &str,
    ) {
        match result {
            Ok(()) => self.notify(success, NoticeTone::Info),
            Err(error) => self.notify(format!("{failure}: {error}"), NoticeTone::Error),
        }
    }

    /// Plays a job's recorded output. Resolves the file name from job state, so
    /// a job whose file is gone reports that instead of failing silently.
    fn play(&mut self, job_id: &str) {
        let file_name = self
            .poll_state
            .jobs
            .iter()
            .find(|job| job.job_id == job_id)
            .and_then(|job| job.file_name.clone());
        let Some(file_name) = file_name else {
            self.notify("재생할 파일 정보가 없습니다.", NoticeTone::Error);
            return;
        };
        self.play_file_in(None, &file_name);
    }

    /// Opens a file in the built-in player.
    fn generate_library_subtitle(&mut self, file_name: &str) {
        if !self.license.current.pro {
            self.view = View::Settings;
            self.license.focus_requested = true;
            self.notify(
                "AI 자막 생성은 앱 Pro 기능입니다. 설정에서 인증키를 등록해 주세요.",
                NoticeTone::Error,
            );
            return;
        }
        match jobs::start_library_subtitle_job(self.library.folder.as_deref(), file_name) {
            Ok(_) => {
                self.notify(
                    format!("{file_name} 자막 생성을 시작했습니다."),
                    NoticeTone::Info,
                );
                self.view = View::Subtitles;
                self.poll(true);
            }
            Err(error) => {
                self.notify(
                    format!("자막을 시작하지 못했습니다: {error}"),
                    NoticeTone::Error,
                );
            }
        }
    }

    fn play_file(&mut self, file_name: &str) {
        self.play_file_in(self.library.folder.clone(), file_name);
    }

    fn play_file_in(&mut self, folder: Option<String>, file_name: &str) {
        match jobs::media_path(folder.as_deref(), file_name) {
            Ok(path) => {
                self.save_playback_state(true);
                let media = jobs::read_media_files_in_folder(folder.as_deref())
                    .ok()
                    .and_then(|files| files.into_iter().find(|file| file.file_name == file_name));
                let resume_position = media.as_ref().and_then(|media| {
                    let metadata = self.library.state.metadata_or_default(media);
                    (metadata.watch_state() == WatchState::InProgress
                        && metadata.last_position.is_finite()
                        && metadata.last_position >= 5.0)
                        .then_some(metadata.last_position)
                });
                self.view = View::Player;
                self.pip.reset_for_load();
                self.player_session.load(
                    folder,
                    file_name.to_string(),
                    media,
                    resume_position,
                    path,
                );
            }
            Err(error) => self.notify(format!("재생하지 못했습니다: {error}"), NoticeTone::Error),
        }
    }

    fn save_library_state(&mut self) {
        if !self.library.state.is_dirty() {
            return;
        }
        if let Err(error) = self.library.state.persist() {
            self.notify(
                format!("보관함 정보를 저장하지 못했습니다: {error}"),
                NoticeTone::Error,
            );
        }
    }

    fn save_playback_state(&mut self, force: bool) {
        if !force && self.player_session.last_resume_save.elapsed() < Duration::from_secs(2) {
            return;
        }
        let Some(media) = self.player_session.media.as_ref() else {
            return;
        };
        let snapshot = self.player_session.controller.snapshot();
        if snapshot.loaded_path.is_none()
            || !snapshot.position.is_finite()
            || !snapshot.duration.is_finite()
            || snapshot.duration <= 0.0
        {
            return;
        }
        self.player_session.last_resume_save = Instant::now();
        if snapshot.position >= 5.0
            && self
                .library
                .state
                .metadata_or_default(media)
                .watched_override
                == Some(false)
        {
            self.library
                .state
                .set_watched_override(media, None, now_millis());
        }
        if self
            .library
            .state
            .set_resume(media, snapshot.position, snapshot.duration, now_millis())
        {
            self.save_library_state();
        }
    }

    fn start_gif_export(&mut self, snapshot: &crate::player_contract::PlayerSnapshot) {
        if self.player_session.gif_export.is_busy() {
            self.notify("GIF를 만드는 중입니다.", NoticeTone::Info);
            return;
        }
        let Some(source) = snapshot.loaded_path.clone() else {
            self.notify("GIF로 만들 영상이 없습니다.", NoticeTone::Error);
            return;
        };
        let (Some(start), Some(end)) = (snapshot.loop_a, snapshot.loop_b) else {
            self.notify("A와 B 구간을 먼저 지정해 주세요.", NoticeTone::Error);
            return;
        };
        let ffmpeg = match crate::thumbnails::ffmpeg_path() {
            Ok(path) => path,
            Err(error) => {
                self.notify(
                    format!("GIF 도구를 찾지 못했습니다: {error}"),
                    NoticeTone::Error,
                );
                return;
            }
        };
        let output = match jobs::library_dir(self.player_session.loaded_folder.as_deref()) {
            Ok(path) => path,
            Err(error) => {
                self.notify(
                    format!("저장 폴더를 열지 못했습니다: {error}"),
                    NoticeTone::Error,
                );
                return;
            }
        };
        let request = GifExportRequest::new(source, ffmpeg, output, start, end, 640, 15);
        match self.player_session.gif_export.submit(request) {
            Ok(()) => self.notify("GIF를 만드는 중입니다.", NoticeTone::Info),
            Err(error) => self.notify(
                format!("GIF를 만들지 못했습니다: {error}"),
                NoticeTone::Error,
            ),
        }
    }

    fn poll_gif_export(&mut self) {
        match self.player_session.gif_export.poll() {
            GifExportStatus::Completed(path) => {
                let name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("GIF");
                self.notify(format!("{name} 저장 완료"), NoticeTone::Info);
            }
            GifExportStatus::Failed(error) => {
                self.notify(
                    format!("GIF를 만들지 못했습니다: {error}"),
                    NoticeTone::Error,
                );
            }
            GifExportStatus::Idle | GifExportStatus::Running => {}
        }
    }

    /// Opens a native folder picker and writes the choice to the shared
    /// `settings.json`. The extension reads the same value, so both entry points
    /// stay on one folder rather than keeping separate destinations.
    fn choose_folder(&mut self) {
        let start = jobs::downloads_dir().ok();
        let mut dialog = rfd::FileDialog::new().set_title("다운로드 폴더 선택");
        if let Some(path) = start.as_ref().filter(|path| path.is_dir()) {
            dialog = dialog.set_directory(path);
        }
        let Some(chosen) = dialog.pick_folder() else {
            return;
        };
        match jobs::write_download_folder(&chosen) {
            Ok(path) => {
                self.poll_state.downloads_folder = Some(path.to_string_lossy().into_owned());
                self.notify(
                    "다운로드 폴더를 바꿨습니다. 확장에서도 이 폴더를 씁니다.",
                    NoticeTone::Info,
                );
            }
            Err(error) => self.notify(
                format!("폴더를 바꾸지 못했습니다: {error}"),
                NoticeTone::Error,
            ),
        }
    }

    fn open_folder(&mut self) {
        match jobs::open_downloads_folder() {
            Ok(()) => self.notify("다운로드 폴더를 열었습니다.", NoticeTone::Info),
            Err(error) => self.notify(
                format!("폴더를 열지 못했습니다: {error}"),
                NoticeTone::Error,
            ),
        }
    }

    fn open_library_folder(&mut self, folder: Option<String>) {
        match jobs::open_library_folder(folder.as_deref()) {
            Ok(()) => self.notify("폴더를 열었습니다.", NoticeTone::Info),
            Err(error) => self.notify(
                format!("폴더를 열지 못했습니다: {error}"),
                NoticeTone::Error,
            ),
        }
    }

    /// Reveals one library file in Explorer with it selected.
    fn reveal_file(&mut self, file_name: &str) {
        match jobs::reveal_file(self.library.folder.as_deref(), file_name) {
            Ok(_) => self.notify(
                format!("{file_name} 파일을 폴더에서 선택했습니다."),
                NoticeTone::Info,
            ),
            Err(error) => self.notify(
                format!("파일을 폴더에서 찾지 못했습니다: {error}"),
                NoticeTone::Error,
            ),
        }
        self.poll(true);
    }

    /// Drops one file's cached thumbnail so a moved or deleted file cannot
    /// linger in the texture map.
    fn forget_thumbnail(&mut self, file_name: &str) {
        if let Some(file) = self
            .poll_state
            .media_files
            .iter()
            .find(|file| file.file_name == file_name)
        {
            self.thumbnails.forget(file);
        }
    }

    fn clear_thumbnail_cache(&mut self) {
        self.thumbnails.clear();
    }

    fn selection_contains(&self, file_name: &str) -> bool {
        self.library.selection_contains(file_name)
    }

    fn toggle_library_selection(&mut self, file_name: &str) {
        self.library.toggle_selection(file_name);
    }

    fn clear_library_selection(&mut self) {
        self.library.clear_selection();
    }

    fn retain_current_folder_selection(&mut self) {
        self.library.retain_current_folder_selection();
    }

    fn select_visible_library_items<'a>(
        &mut self,
        entries: impl IntoIterator<Item = &'a model::LibraryEntry>,
    ) {
        self.library.select_visible(entries);
    }

    fn selected_library_size(&self) -> u64 {
        self.library.selected_size(&self.poll_state.media_files)
    }

    fn execute_batch_delete(&mut self) {
        let mut selected = self.library.selection.iter().cloned().collect::<Vec<_>>();
        selected.sort_by(|left, right| {
            left.folder
                .cmp(&right.folder)
                .then_with(|| left.file_name.cmp(&right.file_name))
        });
        for item in &selected {
            if self.player_session.loaded_folder == item.folder
                && self.player_session.loaded_file.as_deref() == Some(item.file_name.as_str())
            {
                self.stop_playback_session();
            }
            if item.folder == self.library.folder {
                self.forget_thumbnail(&item.file_name);
            }
        }
        match jobs::batch_recycle_media_files(&selected) {
            Ok(report) => {
                self.library.selection = report
                    .items
                    .iter()
                    .filter(|item| !item.outcome.is_success())
                    .map(|item| item.item.clone())
                    .collect();
                self.library.selection_mode = !self.library.selection.is_empty();
                self.notify(
                    if report.failed_count() == 0 {
                        format!(
                            "선택한 파일 {}개를 휴지통으로 보냈습니다.",
                            report.succeeded_count()
                        )
                    } else {
                        format!(
                            "{}개 삭제, {}개 실패했습니다. 실패한 파일은 선택 상태로 남겼습니다.",
                            report.succeeded_count(),
                            report.failed_count()
                        )
                    },
                    if report.failed_count() == 0 {
                        NoticeTone::Info
                    } else {
                        NoticeTone::Error
                    },
                );
            }
            Err(error) => self.notify(
                format!("선택 파일을 삭제하지 못했습니다: {error}"),
                NoticeTone::Error,
            ),
        }
        self.library.pending_batch_delete = false;
        self.poll(true);
    }

    fn preview_library_organization(&mut self) {
        match jobs::preview_library_organization() {
            Ok(plan) if plan.is_empty() => {
                self.notify("최상위에 자동 정리할 미디어가 없습니다.", NoticeTone::Info)
            }
            Ok(plan) => self.library.pending_organization = Some(plan),
            Err(error) => self.notify(
                format!("정리 계획을 만들지 못했습니다: {error}"),
                NoticeTone::Error,
            ),
        }
    }

    fn apply_library_organization(&mut self) {
        let Some(plan) = self.library.pending_organization.take() else {
            return;
        };
        let report = jobs::apply_library_organization(&plan);
        let succeeded = report.succeeded_count();
        let failed = report.failed_count();
        if !report.journal.is_empty() {
            self.library.organization_journal = Some(report.journal);
        }
        self.clear_thumbnail_cache();
        self.clear_library_selection();
        self.poll(true);
        self.notify(
            if failed == 0 {
                format!("미디어 {succeeded}개를 자동 정리했습니다.")
            } else {
                format!(
                    "{succeeded}개 정리, {failed}개 실패했습니다. 성공한 이동은 실행 취소할 수 있습니다."
                )
            },
            if failed == 0 {
                NoticeTone::Info
            } else {
                NoticeTone::Error
            },
        );
    }

    fn undo_library_organization(&mut self) {
        let Some(journal) = self.library.organization_journal.take() else {
            return;
        };
        let report = jobs::reverse_library_organization(&journal);
        let succeeded = report.succeeded_count();
        let failed = report.failed_count();
        if !report.remaining.is_empty() {
            self.library.organization_journal = Some(report.remaining);
        }
        self.clear_thumbnail_cache();
        self.poll(true);
        self.notify(
            if failed == 0 {
                format!("자동 정리 이동 {succeeded}개를 되돌렸습니다.")
            } else {
                format!(
                    "{succeeded}개 복원, {failed}개 실패했습니다. 실패한 이동은 다시 실행 취소할 수 있습니다."
                )
            },
            if failed == 0 {
                NoticeTone::Info
            } else {
                NoticeTone::Error
            },
        );
    }

    fn library_batch_delete_modal(&mut self, ui: &mut egui::Ui) {
        if !self.library.pending_batch_delete || self.library.pending_delete.is_some() {
            return;
        }
        let count = self.library.selection.len();
        if count == 0 {
            self.library.pending_batch_delete = false;
            return;
        }
        let size = model::media_usage_label(self.selected_library_size());
        let mut confirmed = false;
        let mut cancelled = false;
        let modal = egui::Modal::new(egui::Id::new("library-batch-delete-confirm")).show(
            ui.ctx(),
            |ui| {
                ui.set_width(380.0);
                ui.spacing_mut().item_spacing = Vec2::new(space::X12, space::X16);
                ui.label(
                    RichText::new("선택 파일 삭제")
                        .size(text::HEADING_SM)
                        .strong()
                        .color(color::TEXT_PRIMARY),
                );
                ui.label(
                    RichText::new(format!(
                        "선택한 파일 {count}개({size})를 휴지통으로 보낼까요? 휴지통에서 복원할 수 있습니다."
                    ))
                    .size(text::BODY_MD)
                    .color(color::TEXT_SECONDARY),
                );
                ui.horizontal(|ui| {
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if button(ui, "삭제", ButtonStyle::Danger, true).clicked() {
                            confirmed = true;
                        }
                        if button(ui, "취소", ButtonStyle::Secondary, true).clicked() {
                            cancelled = true;
                        }
                    });
                });
            },
        );
        if modal.backdrop_response.clicked() {
            cancelled = true;
        }
        if confirmed {
            self.execute_batch_delete();
        } else if cancelled {
            self.library.pending_batch_delete = false;
        }
    }

    fn library_organization_modal(&mut self, ui: &mut egui::Ui) {
        let Some(plan) = self.library.pending_organization.as_ref() else {
            return;
        };
        let items = plan.items().to_vec();
        let mut apply = false;
        let mut cancelled = false;
        let modal =
            egui::Modal::new(egui::Id::new("library-organization-preview")).show(ui.ctx(), |ui| {
                ui.set_width(540.0);
                ui.spacing_mut().item_spacing = Vec2::new(space::X8, space::X12);
                ui.label(
                    RichText::new("자동 정리 미리보기")
                        .size(text::HEADING_SM)
                        .strong()
                        .color(color::TEXT_PRIMARY),
                );
                ui.label(
                    RichText::new(format!(
                        "최상위 미디어 {}개를 확장자에 따라 Videos 또는 Audio 폴더로 이동합니다.",
                        items.len()
                    ))
                    .size(text::BODY_MD)
                    .color(color::TEXT_SECONDARY),
                );
                egui::ScrollArea::vertical()
                    .max_height(320.0)
                    .auto_shrink([false, true])
                    .show(ui, |ui| {
                        for item in &items {
                            egui::Frame::new()
                                .fill(color::BG_SUBTLE)
                                .corner_radius(corner(radius::MD))
                                .inner_margin(margin_xy(12.0, 9.0))
                                .show(ui, |ui| {
                                    ui.set_width(ui.available_width());
                                    ui.add(
                                        egui::Label::new(
                                            RichText::new(&item.source.file_name)
                                                .size(text::BODY_MD)
                                                .color(color::TEXT_PRIMARY),
                                        )
                                        .truncate(),
                                    );
                                    let destination =
                                        item.destination.folder.as_deref().map_or_else(
                                            || item.destination.file_name.clone(),
                                            |folder| {
                                                format!("{folder}\\{}", item.destination.file_name)
                                            },
                                        );
                                    ui.label(
                                        RichText::new(format!("→ {destination}"))
                                            .size(text::BODY_SM)
                                            .color(color::TEXT_MUTED),
                                    );
                                });
                        }
                    });
                ui.label(
                    RichText::new("적용 후 이 앱 세션에서 한 번에 실행 취소할 수 있습니다.")
                        .size(text::BODY_SM)
                        .color(color::TEXT_MUTED),
                );
                ui.horizontal(|ui| {
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if button(ui, "정리 적용", ButtonStyle::Primary, !items.is_empty())
                            .clicked()
                        {
                            apply = true;
                        }
                        if button(ui, "취소", ButtonStyle::Secondary, true).clicked() {
                            cancelled = true;
                        }
                    });
                });
            });
        if modal.backdrop_response.clicked() {
            cancelled = true;
        }
        if apply {
            self.apply_library_organization();
        } else if cancelled {
            self.library.pending_organization = None;
        }
    }

    /// Stops playback when the file being changed is the one currently loaded.
    fn release_if_playing(&mut self, file_name: &str) {
        if self.player_session.loaded_file.as_deref() == Some(file_name)
            && self.player_session.loaded_folder == self.library.folder
        {
            self.stop_playback_session();
        }
    }

    /// Ends playback and releases every app-owned reference to the active file.
    /// PiP close uses this path too: closing a playing surface must not leave an
    /// invisible mpv session running in the background.
    fn stop_playback_session(&mut self) {
        self.save_playback_state(true);
        self.player_session.stop();
        self.pip.stop();
    }

    fn create_library_folder(&mut self, name: &str) {
        match jobs::create_library_folder(name) {
            Ok(_) => self.notify(format!("{name} 폴더를 만들었습니다."), NoticeTone::Info),
            Err(error) => self.notify(
                format!("폴더를 만들지 못했습니다: {error}"),
                NoticeTone::Error,
            ),
        }
        self.poll(true);
    }

    fn rename_library_folder(&mut self, from: &str, to: &str) {
        match jobs::rename_library_folder(from, to) {
            Ok(_) => {
                if self.library.folder.as_deref() == Some(from) {
                    self.library.folder = Some(to.to_string());
                }
                if self.player_session.loaded_folder.as_deref() == Some(from) {
                    self.player_session.loaded_folder = Some(to.to_string());
                }
                self.notify(format!("{to}(으)로 이름을 바꿨습니다."), NoticeTone::Info);
            }
            Err(error) => self.notify(
                format!("폴더 이름을 바꾸지 못했습니다: {error}"),
                NoticeTone::Error,
            ),
        }
        self.poll(true);
    }

    fn move_library_file(&mut self, file_name: &str, destination: Option<&str>) {
        self.release_if_playing(file_name);
        self.forget_thumbnail(file_name);
        let source = self.library.folder.clone();
        match jobs::move_media_file(file_name, source.as_deref(), destination) {
            Ok(_) => self.notify(
                match destination {
                    Some(folder) => format!("{file_name} 파일을 {folder} 폴더로 옮겼습니다."),
                    None => format!("{file_name} 파일을 최상위로 옮겼습니다."),
                },
                NoticeTone::Info,
            ),
            Err(error) => self.notify(format!("옮기지 못했습니다: {error}"), NoticeTone::Error),
        }
        self.poll(true);
    }

    /// Deletes a library file after the confirmation modal. The cached
    /// thumbnail is dropped up front so the deleted file cannot linger in the
    /// texture map, and a re-downloaded file gets a fresh cache entry.
    fn delete_library_file(&mut self, file_name: &str) {
        self.release_if_playing(file_name);
        self.forget_thumbnail(file_name);
        match jobs::delete_media_file(self.library.folder.as_deref(), file_name) {
            Ok(_) => self.notify(
                format!("{file_name} 파일을 휴지통으로 보냈습니다."),
                NoticeTone::Info,
            ),
            Err(error) => self.notify(format!("삭제하지 못했습니다: {error}"), NoticeTone::Error),
        }
        self.poll(true);
    }

    /// Confirmation before anything leaves the library. Deleting is
    /// recoverable (Windows Recycle Bin), but the confirm still protects
    /// against a stray tap on the tile menu.
    fn library_delete_modal(&mut self, ui: &mut egui::Ui) {
        let Some(file_name) = self.library.pending_delete.clone() else {
            return;
        };
        let mut confirmed = false;
        let mut cancelled = false;
        let modal = egui::Modal::new(egui::Id::new("library-delete-confirm")).show(
            ui.ctx(),
            |ui| {
                ui.set_width(360.0);
                ui.spacing_mut().item_spacing = Vec2::new(space::X12, space::X16);
                ui.label(
                    RichText::new("파일 삭제")
                        .size(text::HEADING_SM)
                        .strong()
                        .color(color::TEXT_PRIMARY),
                );
                ui.label(
                    RichText::new(format!(
                        "{file_name} 파일을 휴지통으로 보낼까요? 보관함 목록에서 사라지고, 휴지통에서 되돌릴 수 있습니다."
                    ))
                    .size(text::BODY_MD)
                    .color(color::TEXT_SECONDARY),
                );
                ui.horizontal(|ui| {
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if button(ui, "삭제", ButtonStyle::Danger, true).clicked() {
                            confirmed = true;
                        }
                        if button(ui, "취소", ButtonStyle::Secondary, true).clicked() {
                            cancelled = true;
                        }
                    });
                });
            },
        );
        if modal.backdrop_response.clicked() {
            cancelled = true;
        }

        if confirmed {
            self.delete_library_file(&file_name);
            self.library.pending_delete = None;
        } else if cancelled {
            self.library.pending_delete = None;
        }
    }

    /// Destination chooser for a pending move. Rows are the existing folders
    /// plus the root, excluding wherever the file already is.
    fn library_move_modal(&mut self, ui: &mut egui::Ui) {
        let Some(file_name) = self.library.pending_move.clone() else {
            return;
        };
        let mut chosen: Option<Option<String>> = None;
        let mut cancelled = false;
        let folders = self.poll_state.library_folders.clone();
        let current = self.library.folder.clone();

        let modal = egui::Modal::new(egui::Id::new("library-move-target")).show(ui.ctx(), |ui| {
            ui.set_width(320.0);
            ui.spacing_mut().item_spacing = Vec2::new(space::X8, space::X12);
            ui.label(
                RichText::new(model::single_line(&file_name, 46))
                    .size(text::HEADING_SM)
                    .strong()
                    .color(color::TEXT_PRIMARY),
            );
            if current.is_some() && menu_row(ui, Icon::Back, "최상위", false).clicked() {
                chosen = Some(None);
            }
            for folder in &folders {
                if current.as_deref() == Some(folder.name.as_str()) {
                    continue;
                }
                if menu_row(ui, Icon::Folder, &folder.name, false).clicked() {
                    chosen = Some(Some(folder.name.clone()));
                }
            }
            ui.horizontal(|ui| {
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if button(ui, "취소", ButtonStyle::Secondary, true).clicked() {
                        cancelled = true;
                    }
                });
            });
        });
        if modal.backdrop_response.clicked() {
            cancelled = true;
        }

        if let Some(destination) = chosen {
            self.move_library_file(&file_name, destination.as_deref());
            self.library.pending_move = None;
        } else if cancelled {
            self.library.pending_move = None;
        }
    }

    /// New-folder prompt. The name is validated with the same rule the IO layer
    /// uses, so the confirm button cannot submit a name that would be rejected.
    fn library_folder_modal(&mut self, ui: &mut egui::Ui) {
        let Some(mut draft) = self.library.pending_folder_name.clone() else {
            return;
        };
        let mut confirmed = false;
        let mut cancelled = false;

        let modal = egui::Modal::new(egui::Id::new("library-new-folder")).show(ui.ctx(), |ui| {
            ui.set_width(320.0);
            ui.spacing_mut().item_spacing = Vec2::new(space::X8, space::X12);
            ui.label(
                RichText::new("새 폴더")
                    .size(text::HEADING_SM)
                    .strong()
                    .color(color::TEXT_PRIMARY),
            );
            let field = ui.add(
                egui::TextEdit::singleline(&mut draft)
                    .hint_text("폴더 이름")
                    .desired_width(f32::INFINITY),
            );
            field.request_focus();
            let valid = jobs::valid_folder_name(&draft).is_some();
            if valid && field.lost_focus() && ui.input(|input| input.key_pressed(egui::Key::Enter))
            {
                confirmed = true;
            }
            ui.horizontal(|ui| {
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if button(ui, "만들기", ButtonStyle::Primary, valid).clicked() {
                        confirmed = true;
                    }
                    if button(ui, "취소", ButtonStyle::Secondary, true).clicked() {
                        cancelled = true;
                    }
                });
            });
        });
        if modal.backdrop_response.clicked() {
            cancelled = true;
        }

        if confirmed {
            self.create_library_folder(&draft);
            self.library.pending_folder_name = None;
        } else if cancelled {
            self.library.pending_folder_name = None;
        } else {
            self.library.pending_folder_name = Some(draft);
        }
    }

    fn library_folder_rename_modal(&mut self, ui: &mut egui::Ui) {
        let Some((original, mut draft)) = self.library.pending_folder_rename.clone() else {
            return;
        };
        let mut confirmed = false;
        let mut cancelled = false;
        let modal = egui::Modal::new(egui::Id::new("library-rename-folder")).show(ui.ctx(), |ui| {
            ui.set_width(320.0);
            ui.spacing_mut().item_spacing = Vec2::new(space::X8, space::X12);
            ui.label(
                RichText::new("폴더 이름 변경")
                    .size(text::HEADING_SM)
                    .strong()
                    .color(color::TEXT_PRIMARY),
            );
            let field = ui.add(egui::TextEdit::singleline(&mut draft).desired_width(f32::INFINITY));
            if field.lost_focus() && ui.input(|input| input.key_pressed(egui::Key::Enter)) {
                confirmed = true;
            }
            let valid = draft != original && jobs::valid_folder_name(&draft).is_some();
            ui.horizontal(|ui| {
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if button(ui, "변경", ButtonStyle::Primary, valid).clicked() {
                        confirmed = true;
                    }
                    if button(ui, "취소", ButtonStyle::Secondary, true).clicked() {
                        cancelled = true;
                    }
                });
            });
        });
        if modal.backdrop_response.clicked() {
            cancelled = true;
        }

        let valid = draft != original && jobs::valid_folder_name(&draft).is_some();
        if confirmed && valid {
            self.rename_library_folder(&original, &draft);
            self.library.pending_folder_rename = None;
        } else if cancelled {
            self.library.pending_folder_rename = None;
        } else {
            self.library.pending_folder_rename = Some((original, draft));
        }
    }

    fn rail(&mut self, ui: &mut egui::Ui) {
        ui.spacing_mut().item_spacing = Vec2::new(0.0, space::X4);

        ui.add_space(space::X4);
        // The title block's real height depends on the installed Korean UI font,
        // so it is measured rather than assumed. Both blocks are then placed
        // against one shared row height instead of relying on cross-alignment.
        let title_block_height = brand_title_block_height(ui);
        let row_height = brand_row_height(BRAND_LOGO_SIZE, title_block_height);
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = space::X8;
            ui.allocate_ui_with_layout(
                Vec2::new(BRAND_LOGO_SIZE, row_height),
                egui::Layout::top_down(egui::Align::Min),
                |ui| {
                    ui.add_space(brand_logo_offset(BRAND_LOGO_SIZE, title_block_height));
                    ui.add(
                        egui::Image::new(egui::include_image!("../assets/segma-mark.png"))
                            .fit_to_exact_size(Vec2::splat(BRAND_LOGO_SIZE))
                            .sense(egui::Sense::hover()),
                    );
                },
            );
            let title_width = ui.available_width();
            ui.allocate_ui_with_layout(
                Vec2::new(title_width, row_height),
                egui::Layout::top_down(egui::Align::Min),
                |ui| {
                    ui.add_space(brand_title_offset(BRAND_LOGO_SIZE, title_block_height));
                    ui.spacing_mut().item_spacing.y = 0.0;
                    let origin = ui.cursor().min;
                    // Both lines are painted on their letterforms, so the only
                    // separation is one explicit optical gap. Nothing here goes
                    // through a Label, whose line box would reintroduce the
                    // font's ascent/descent between the two lines.
                    let segma = paint_brand_title_line(
                        ui,
                        origin,
                        "SEGMA",
                        text::HEADING_SM,
                        color::TEXT_PRIMARY,
                    );
                    let second_origin =
                        egui::Pos2::new(origin.x, segma.ink.bottom() + BRAND_TITLE_LINE_GAP);
                    let player = paint_brand_title_line(
                        ui,
                        second_origin,
                        "PLAYER",
                        text::LABEL_SM,
                        color::TEXT_SECONDARY,
                    );
                    let badge = if self.license.current.pro {
                        "PRO"
                    } else {
                        "일반"
                    };
                    // The badge shares PLAYER's baseline instead of its own ink
                    // top: Hangul rises above Latin caps, so ink-aligning it
                    // would visibly drop the badge.
                    paint_brand_title_run(
                        ui,
                        egui::Pos2::new(player.ink.right() + space::X4, player.box_top),
                        badge,
                        text::LABEL_SM,
                        if self.license.current.pro {
                            color::ACCENT
                        } else {
                            color::TEXT_MUTED
                        },
                    );
                    ui.advance_cursor_after_rect(egui::Rect::from_min_size(
                        origin,
                        egui::Vec2::new(ui.available_width(), title_block_height),
                    ));
                },
            );
        });
        ui.add_space(space::X16);

        for view in View::ALL {
            if nav_item(ui, view.label(), self.view == view).clicked() {
                if view == View::Player {
                    self.pip.return_to_player();
                }
                self.view = view;
            }
        }

        // Push the status block to the bottom the way the design does.
        let reserved = 74.0;
        let remaining = ui.available_height() - reserved;
        if remaining > 0.0 {
            ui.add_space(remaining);
        }

        let (title, detail, tone) = match &self.poll_state.read_error {
            None => {
                let path = self
                    .poll_state
                    .downloads_folder
                    .as_deref()
                    .map(|path| {
                        model::compact_home_path(
                            path,
                            std::env::var_os("USERPROFILE")
                                .as_ref()
                                .map(|value| value.to_string_lossy())
                                .as_deref(),
                        )
                    })
                    .filter(|path| !path.is_empty())
                    .unwrap_or_else(|| "경로 확인 불가".to_string());
                let usage = jobs::download_folder_media_bytes()
                    .ok()
                    .map(model::media_usage_label)
                    .unwrap_or_else(|| "용량 확인 불가".to_string());
                (path, usage, Tone::Neutral)
            }
            Some(error) => (
                "작업 폴더를 읽지 못함".to_string(),
                error.clone(),
                Tone::Danger,
            ),
        };

        egui::Frame::new()
            .fill(tone.background())
            .corner_radius(corner(radius::MD))
            .inner_margin(margin_xy(12.0, 10.0))
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.spacing_mut().item_spacing.y = space::X2;
                ui.add(
                    egui::Label::new(
                        RichText::new(title)
                            .size(text::LABEL_MD)
                            .color(tone.foreground()),
                    )
                    .truncate(),
                );
                ui.add(
                    egui::Label::new(
                        RichText::new(detail)
                            .size(text::BODY_SM)
                            .color(color::TEXT_MUTED),
                    )
                    .truncate(),
                );
            });
    }

    fn header(
        &mut self,
        ui: &mut egui::Ui,
        summary: String,
        actions: &[(Icon, &str)],
    ) -> Option<usize> {
        let mut clicked = None;
        ui.allocate_ui_with_layout(
            Vec2::new(ui.available_width(), player_ui::PAGE_HEADER_HEIGHT),
            egui::Layout::left_to_right(egui::Align::Min),
            |ui| {
                ui.vertical(|ui| {
                    ui.spacing_mut().item_spacing.y = space::X4;
                    ui.label(
                        RichText::new(self.view.title())
                            .size(text::HEADING_LG)
                            .strong()
                            .color(color::TEXT_PRIMARY),
                    );
                    if !summary.is_empty() {
                        ui.label(
                            RichText::new(summary)
                                .size(text::BODY_MD)
                                .color(color::TEXT_MUTED),
                        );
                    }
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
                    ui.spacing_mut().item_spacing.x = space::X8;
                    for (index, (icon, label)) in actions.iter().enumerate().rev() {
                        if player_ui::header_action(ui, *icon, label).clicked() {
                            clicked = Some(index);
                        }
                    }
                });
            },
        );
        clicked
    }

    fn filters(&mut self, ui: &mut egui::Ui) {
        self.queue.show_filters(ui);
    }

    fn queue_view(&mut self, ui: &mut egui::Ui) {
        let summary = queue_summary(&self.poll_state.jobs);
        let clicked = self.header(
            ui,
            summary,
            &[
                (Icon::Retry, "새로 고침"),
                (Icon::FolderOpen, "다운로드 폴더 변경"),
            ],
        );
        match clicked {
            Some(0) => self.poll(true),
            Some(1) => self.choose_folder(),
            _ => {}
        }

        let mut clear_history = false;
        ui.horizontal(|ui| {
            self.filters(ui);
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if button(ui, "이력 삭제", ButtonStyle::Quiet, true).clicked() {
                    clear_history = true;
                }
            });
        });
        if clear_history {
            match jobs::clear_terminal_history() {
                Ok(0) => {}
                Ok(count) => {
                    let _ = count;
                    self.poll(true);
                }
                Err(error) => self.notify(
                    format!("다운로드 이력을 삭제하지 못했습니다: {error}"),
                    NoticeTone::Error,
                ),
            }
        }

        let (views, total) = self.queue.rows(
            &self.poll_state.jobs,
            &self.poll_state.restartable,
            &self.poll_state.media_files,
        );

        if views.is_empty() {
            empty_state(
                ui,
                if total == 0 {
                    "다운로드 작업이 없습니다. 브라우저 확장에서 다운로드를 시작하세요."
                } else {
                    "이 조건에 맞는 작업이 없습니다."
                },
            );
            return;
        }

        let mut event = None;
        for view in &views {
            if let Some(row_event) = job_row(ui, view) {
                event = Some(row_event);
            }
        }
        if let Some(event) = event {
            self.handle(event);
        }
    }

    fn library_controls(&mut self, ui: &mut egui::Ui) {
        self.library.show_controls(ui);
    }

    /// Library is driven by the download folder, not by job history.
    ///
    /// A file the user moved or deleted disappears from the list, and a file
    /// dropped into the folder by hand shows up. Job state only supplies the
    /// title and media type when a record happens to match by file name.
    fn library_view(&mut self, ui: &mut egui::Ui) {
        let entries = library_entries(&self.poll_state.media_files, &self.poll_state.jobs);
        let missing = if self.library.folder.is_none() {
            missing_output_count(&self.poll_state.media_files, &self.poll_state.jobs)
        } else {
            0
        };

        let mut refresh = false;
        let mut choose_download_folder = false;
        let mut new_folder = false;
        let mut leave_folder = false;
        let mut toggle_selection_mode = false;
        let mut organize = false;
        let mut undo_organization = false;

        ui.allocate_ui_with_layout(
            Vec2::new(ui.available_width(), player_ui::PAGE_HEADER_HEIGHT),
            egui::Layout::left_to_right(egui::Align::Min),
            |ui| {
                ui.vertical(|ui| {
                    ui.spacing_mut().item_spacing.y = space::X4;
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = space::X8;
                        if let Some(folder) = self.library.folder.clone() {
                            if icon_button(
                                ui,
                                Icon::Back,
                                "보관함 최상위",
                                ButtonStyle::Quiet,
                                true,
                            )
                            .clicked()
                            {
                                leave_folder = true;
                            }
                            ui.label(
                                RichText::new(folder)
                                    .size(text::HEADING_LG)
                                    .strong()
                                    .color(color::TEXT_PRIMARY),
                            );
                        } else {
                            ui.label(
                                RichText::new(self.view.title())
                                    .size(text::HEADING_LG)
                                    .strong()
                                    .color(color::TEXT_PRIMARY),
                            );
                        }
                    });
                    let summary = if missing > 0 {
                        format!("파일 {}건 · 없는 완료 작업 {missing}건", entries.len())
                    } else {
                        format!("파일 {}건", entries.len())
                    };
                    ui.label(
                        RichText::new(summary)
                            .size(text::BODY_MD)
                            .color(color::TEXT_MUTED),
                    );
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
                    ui.spacing_mut().item_spacing.x = space::X8;
                    if player_ui::header_action(ui, Icon::FolderOpen, "다운로드 폴더 변경")
                        .clicked()
                    {
                        choose_download_folder = true;
                    }
                    if player_ui::header_action(ui, Icon::Retry, "새로 고침").clicked() {
                        refresh = true;
                    }
                    if self.library.folder.is_none()
                        && player_ui::header_action(ui, Icon::FolderPlus, "새 폴더").clicked()
                    {
                        new_folder = true;
                    }
                    if player_ui::header_action(
                        ui,
                        Icon::Trash,
                        if self.library.selection_mode {
                            "선택 종료"
                        } else {
                            "파일 선택"
                        },
                    )
                    .clicked()
                    {
                        toggle_selection_mode = true;
                    }
                });
            },
        );

        search_field(ui, &mut self.library.search);
        self.library_controls(ui);

        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing = Vec2::new(space::X8, space::X4);
            if self.library.selection_mode {
                let selected = self.library.selection.len();
                let size = model::media_usage_label(self.selected_library_size());
                ui.label(
                    RichText::new(format!("{selected}개 선택 · {size}"))
                        .size(text::BODY_MD)
                        .strong()
                        .color(color::TEXT_PRIMARY),
                );
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if self.library.organization_journal.is_some()
                    && button(ui, "정리 실행 취소", ButtonStyle::Secondary, true).clicked()
                {
                    undo_organization = true;
                }
                if self.library.folder.is_none()
                    && button(ui, "자동 정리", ButtonStyle::Secondary, true).clicked()
                {
                    organize = true;
                }
                if self.library.selection_mode {
                    if button(
                        ui,
                        "선택 삭제",
                        ButtonStyle::Danger,
                        !self.library.selection.is_empty(),
                    )
                    .clicked()
                    {
                        self.library.pending_batch_delete = true;
                    }
                    if button(ui, "선택 해제", ButtonStyle::Quiet, true).clicked() {
                        self.clear_library_selection();
                    }
                }
            });
        });

        if missing > 0 {
            // A completed job whose file left the folder is explained rather
            // than silently missing from the list.
            ui.label(
                RichText::new(format!("완료된 작업 {missing}건의 파일이 폴더에 없습니다."))
                    .size(text::BODY_SM)
                    .color(color::TEXT_WARNING),
            );
        }

        let mut enter_folder = None;
        let mut rename_folder = None;
        let mut drop_destination: Option<Option<String>> = None;
        let now = ui.input(|input| input.time);
        // A finished settle animation is dropped here, so the library keeps no
        // lingering "last dropped folder" highlight between frames.
        if !expire_drop_settle(&mut self.library.drop_settle, now)
            && self.library.drop_settle.is_some()
        {
            ui.ctx().request_repaint();
        }
        let dragging_file = self.library.dragged_file.is_some();
        let settle = self.library.drop_settle.clone();
        if !self.poll_state.library_folders.is_empty() || self.library.folder.is_some() {
            let folders = self.poll_state.library_folders.clone();
            ui.horizontal_wrapped(|ui| {
                ui.spacing_mut().item_spacing = Vec2::new(space::X8, space::X8);
                if self.library.folder.is_some() {
                    let response = folder_chip(
                        ui,
                        "최상위",
                        None,
                        FolderDropHint {
                            dragging: dragging_file,
                            settle: drop_settle_progress_for(&settle, None, now),
                        },
                    );
                    if response.clicked() {
                        leave_folder = true;
                    }
                    if self.library.dragged_file.is_some()
                        && response.hovered()
                        && ui.input(|input| input.pointer.any_released())
                    {
                        drop_destination = Some(None);
                    }
                }
                for folder in &folders {
                    if self.library.folder.as_deref() == Some(folder.name.as_str()) {
                        continue;
                    }
                    let response = folder_chip(
                        ui,
                        &folder.name,
                        Some(folder.media_count),
                        FolderDropHint {
                            dragging: dragging_file,
                            settle: drop_settle_progress_for(
                                &settle,
                                Some(folder.name.as_str()),
                                now,
                            ),
                        },
                    );
                    if response.clicked() {
                        enter_folder = Some(folder.name.clone());
                    }
                    if self.library.dragged_file.is_some()
                        && response.hovered()
                        && ui.input(|input| input.pointer.any_released())
                    {
                        drop_destination = Some(Some(folder.name.clone()));
                    }
                    response.context_menu(|ui| {
                        if menu_row(ui, Icon::Pencil, "이름 변경", false).clicked() {
                            rename_folder = Some(folder.name.clone());
                            ui.close();
                        }
                    });
                }
            });
        }

        let needle = self.library.search.trim().to_lowercase();
        let mut filtered: Vec<&model::LibraryEntry> = entries
            .iter()
            .filter(|entry| {
                let search_matches = needle.is_empty()
                    || entry.title.to_lowercase().contains(&needle)
                    || entry.file_name.to_lowercase().contains(&needle);
                let Some(media) = self
                    .poll_state
                    .media_files
                    .iter()
                    .find(|media| media.file_name == entry.file_name)
                else {
                    return false;
                };
                let metadata = self.library.state.metadata_or_default(media);
                let watch_state = self.library.state.watch_state_for(media);
                let state_matches = match self.library.filter {
                    LibraryFilter::All => true,
                    LibraryFilter::Favorite => metadata.favorite,
                    LibraryFilter::Unwatched => watch_state == WatchState::Unwatched,
                    LibraryFilter::InProgress => watch_state == WatchState::InProgress,
                    LibraryFilter::Completed => watch_state == WatchState::Completed,
                };
                search_matches && state_matches && metadata.rating >= self.library.min_rating
            })
            .collect();
        filtered.sort_by(|left, right| match self.library.sort {
            LibrarySort::Newest => right.modified_at.cmp(&left.modified_at),
            LibrarySort::Title => left.title.to_lowercase().cmp(&right.title.to_lowercase()),
            LibrarySort::Rating => {
                let rating = |entry: &model::LibraryEntry| {
                    self.poll_state
                        .media_files
                        .iter()
                        .find(|media| media.file_name == entry.file_name)
                        .map(|media| self.library.state.metadata_or_default(media).rating)
                        .unwrap_or_default()
                };
                rating(right)
                    .cmp(&rating(left))
                    .then_with(|| right.modified_at.cmp(&left.modified_at))
            }
        });

        let select_all_pressed = self.library.selection_mode
            && !ui.ctx().text_edit_focused()
            && !egui::Popup::is_any_open(ui.ctx())
            && ui.input_mut(|input| input.consume_key(egui::Modifiers::COMMAND, egui::Key::A));
        if select_all_pressed {
            self.select_visible_library_items(filtered.iter().copied());
        }
        let keyboard_actions_available = !ui.ctx().text_edit_focused()
            && !egui::Popup::is_any_open(ui.ctx())
            && self.library.pending_delete.is_none()
            && !self.library.pending_batch_delete
            && self.library.pending_organization.is_none()
            && self.library.pending_move.is_none()
            && self.library.pending_folder_name.is_none()
            && self.library.pending_folder_rename.is_none();
        let escape_pressed = self.library.selection_mode
            && keyboard_actions_available
            && ui.input_mut(|input| input.consume_key(egui::Modifiers::NONE, egui::Key::Escape));
        if escape_pressed {
            self.clear_library_selection();
        }
        let delete_pressed = self.library.selection_mode
            && !self.library.selection.is_empty()
            && keyboard_actions_available
            && ui.input_mut(|input| input.consume_key(egui::Modifiers::NONE, egui::Key::Delete));
        if delete_pressed {
            self.library.pending_batch_delete = true;
        }

        let mut play_target = None;
        let mut subtitle_target = None;
        let mut reveal_target = None;
        let mut move_target = None;
        let mut delete_target = None;
        let mut favorite_target = None;
        let mut rating_target = None;
        let mut watched_target = None;

        if filtered.is_empty() {
            empty_state(
                ui,
                if entries.is_empty() {
                    "미디어 파일이 없습니다."
                } else {
                    "검색 결과가 없습니다."
                },
            );
        } else {
            let gap = space::X16;
            let available = ui.available_width();
            let columns: usize = if available >= 880.0 {
                3
            } else if available >= 560.0 {
                2
            } else {
                1
            };
            let tile_width = ((available - gap * (columns.saturating_sub(1) as f32))
                / columns as f32)
                .max(220.0);
            let has_folders = !self.poll_state.library_folders.is_empty();
            for row in filtered.chunks(columns) {
                ui.horizontal_top(|ui| {
                    ui.spacing_mut().item_spacing.x = gap;
                    for entry in row {
                        let metadata = self
                            .poll_state
                            .media_files
                            .iter()
                            .find(|media| media.file_name == entry.file_name)
                            .map(|media| self.library.state.metadata_or_default(media))
                            .unwrap_or_default();
                        ui.allocate_ui_with_layout(
                            Vec2::new(tile_width, tile_width * 9.0 / 16.0 + 104.0),
                            egui::Layout::top_down(egui::Align::LEFT),
                            |ui| {
                                ui.set_width(tile_width);
                                ui.spacing_mut().item_spacing.y = space::X4;
                                let response = media_thumbnail(
                                    ui,
                                    self.thumbnails.texture(&entry.thumbnail_key),
                                    &entry.type_label,
                                    tile_width,
                                )
                                .on_hover_text(
                                    if self.library.selection_mode {
                                        "선택 전환"
                                    } else {
                                        "재생"
                                    },
                                );
                                if response.hovered() {
                                    ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
                                }
                                if response.clicked() {
                                    if self.library.selection_mode {
                                        self.toggle_library_selection(&entry.file_name);
                                    } else {
                                        play_target = Some(entry.file_name.clone());
                                    }
                                }
                                if !self.library.selection_mode && response.drag_started() {
                                    self.library.dragged_file = Some(entry.file_name.clone());
                                }
                                // Motion only: painted over the existing rect so
                                // the grid never reflows while dragging.
                                let lifted = self.library.dragged_file.as_deref()
                                    == Some(entry.file_name.as_str());
                                let lift = ui.ctx().animate_bool_with_time(
                                    response.id.with("library-drag-lift"),
                                    lifted,
                                    crate::widgets::DRAG_LIFT_MOTION_TIME,
                                );
                                crate::widgets::paint_drag_lift(ui, response.rect, lift);
                                if self.selection_contains(&entry.file_name) {
                                    ui.painter().rect_filled(
                                        response.rect,
                                        corner(radius::LG),
                                        color::ACCENT.gamma_multiply(0.18),
                                    );
                                    ui.painter().rect_stroke(
                                        response.rect,
                                        corner(radius::LG),
                                        egui::Stroke::new(3.0, color::ACCENT),
                                        egui::StrokeKind::Inside,
                                    );
                                    let badge = egui::Rect::from_center_size(
                                        response.rect.right_top() + Vec2::new(-18.0, 18.0),
                                        Vec2::splat(24.0),
                                    );
                                    ui.painter().circle_filled(
                                        badge.center(),
                                        badge.width() / 2.0,
                                        color::ACCENT,
                                    );
                                    ui.painter().text(
                                        badge.center(),
                                        egui::Align2::CENTER_CENTER,
                                        "✓",
                                        egui::FontId::proportional(text::LABEL_MD),
                                        color::TEXT_INVERSE,
                                    );
                                }

                                // The menu belongs on the title row, right-aligned,
                                // so it never covers the thumbnail image.
                                ui.horizontal(|ui| {
                                    ui.set_min_height(metric::CONTROL_HEIGHT);
                                    let menu_width = metric::CONTROL_HEIGHT + space::X4;
                                    ui.allocate_ui_with_layout(
                                        Vec2::new(
                                            (tile_width - menu_width).max(48.0),
                                            metric::CONTROL_HEIGHT,
                                        ),
                                        egui::Layout::left_to_right(egui::Align::Center),
                                        |ui| {
                                            ui.add(
                                                egui::Label::new(
                                                    RichText::new(&entry.title)
                                                        .size(text::HEADING_SM)
                                                        .strong()
                                                        .color(color::TEXT_PRIMARY),
                                                )
                                                .truncate(),
                                            );
                                        },
                                    );
                                    ui.with_layout(
                                        egui::Layout::right_to_left(egui::Align::Center),
                                        |ui| match tile_menu(ui, &entry.file_name, has_folders) {
                                            Some(TileMenuEvent::Play(file_name)) => {
                                                play_target = Some(file_name);
                                            }
                                            Some(TileMenuEvent::GenerateSubtitle(file_name)) => {
                                                subtitle_target = Some(file_name);
                                            }
                                            Some(TileMenuEvent::Reveal(file_name)) => {
                                                reveal_target = Some(file_name);
                                            }
                                            Some(TileMenuEvent::MoveTo(file_name)) => {
                                                move_target = Some(file_name);
                                            }
                                            Some(TileMenuEvent::Delete(file_name)) => {
                                                delete_target = Some(file_name);
                                            }
                                            None => {}
                                        },
                                    );
                                });
                                let meta = [Some(entry.type_label.clone()), entry.size.clone()]
                                    .into_iter()
                                    .flatten()
                                    .collect::<Vec<_>>()
                                    .join(" · ");
                                ui.label(
                                    RichText::new(meta)
                                        .size(text::BODY_SM)
                                        .color(color::TEXT_MUTED),
                                );
                                let progress = if metadata.duration > 0.0 {
                                    (metadata.last_position / metadata.duration).clamp(0.0, 1.0)
                                        as f32
                                } else {
                                    0.0
                                };
                                let (bar_rect, _) = ui.allocate_exact_size(
                                    Vec2::new(tile_width, 3.0),
                                    egui::Sense::hover(),
                                );
                                ui.painter()
                                    .rect_filled(bar_rect, corner(2), color::BORDER_SUBTLE);
                                if progress > 0.0 {
                                    ui.painter().rect_filled(
                                        egui::Rect::from_min_max(
                                            bar_rect.min,
                                            egui::pos2(
                                                bar_rect.left() + bar_rect.width() * progress,
                                                bar_rect.bottom(),
                                            ),
                                        ),
                                        corner(2),
                                        color::ACCENT,
                                    );
                                }
                                ui.horizontal(|ui| {
                                    if icon_button(
                                        ui,
                                        Icon::Heart,
                                        if metadata.favorite {
                                            "찜 해제"
                                        } else {
                                            "찜"
                                        },
                                        if metadata.favorite {
                                            ButtonStyle::Primary
                                        } else {
                                            ButtonStyle::Quiet
                                        },
                                        true,
                                    )
                                    .clicked()
                                    {
                                        favorite_target = Some(entry.file_name.clone());
                                    }
                                    ui.spacing_mut().item_spacing.x = 2.0;
                                    for rating in 1..=5 {
                                        if rating_star_button(ui, rating, rating <= metadata.rating)
                                            .clicked()
                                        {
                                            rating_target = Some((
                                                entry.file_name.clone(),
                                                if metadata.rating == rating { 0 } else { rating },
                                            ));
                                        }
                                    }
                                    ui.with_layout(
                                        egui::Layout::right_to_left(egui::Align::Center),
                                        |ui| {
                                            let state = match metadata.watch_state() {
                                                WatchState::Unwatched => "미시청".to_string(),
                                                WatchState::InProgress => {
                                                    format!(
                                                        "{}%",
                                                        (progress * 100.0).round() as u32
                                                    )
                                                }
                                                WatchState::Completed => "완료".to_string(),
                                            };
                                            if button(ui, &state, ButtonStyle::Quiet, true)
                                                .clicked()
                                            {
                                                watched_target = Some((
                                                    entry.file_name.clone(),
                                                    metadata.watch_state() != WatchState::Completed,
                                                ));
                                            }
                                        },
                                    );
                                });
                            },
                        );
                    }
                });
            }
        }

        if refresh {
            self.poll(true);
        }
        if toggle_selection_mode {
            if self.library.selection_mode {
                self.clear_library_selection();
            } else {
                self.library.selection_mode = true;
            }
        }
        if organize {
            self.preview_library_organization();
        }
        if undo_organization {
            self.undo_library_organization();
        }
        if choose_download_folder {
            self.choose_folder();
        }
        if new_folder {
            self.library.pending_folder_name = Some(String::new());
        }
        if leave_folder {
            self.library.folder = None;
            self.retain_current_folder_selection();
            self.poll(true);
        }
        if let Some(folder) = enter_folder {
            self.library.folder = Some(folder);
            self.retain_current_folder_selection();
            self.poll(true);
        }
        if let Some(folder) = rename_folder {
            self.library.pending_folder_rename = Some((folder.clone(), folder));
        }
        if let Some(destination) = drop_destination {
            if let Some(file_name) = self.library.dragged_file.take() {
                self.library.drop_settle =
                    Some((destination.clone(), now + crate::widgets::DROP_SETTLE_TIME));
                self.move_library_file(&file_name, destination.as_deref());
            }
        } else if ui.input(|input| input.pointer.any_released()) {
            self.library.dragged_file = None;
        }
        if let Some(file_name) = play_target {
            self.play_file(&file_name);
        }
        if let Some(file_name) = subtitle_target {
            self.generate_library_subtitle(&file_name);
        }
        if let Some(file_name) = reveal_target {
            self.reveal_file(&file_name);
        }
        if let Some(file_name) = move_target {
            self.library.pending_move = Some(file_name);
        }
        if let Some(file_name) = delete_target {
            if !self.library.pending_batch_delete {
                self.library.pending_delete = Some(file_name);
            }
        }
        if let Some(file_name) = favorite_target {
            if let Some(media) = self
                .poll_state
                .media_files
                .iter()
                .find(|media| media.file_name == file_name)
                .cloned()
            {
                self.library.state.toggle_favorite(&media, now_millis());
                self.save_library_state();
            }
        }
        if let Some((file_name, rating)) = rating_target {
            if let Some(media) = self
                .poll_state
                .media_files
                .iter()
                .find(|media| media.file_name == file_name)
                .cloned()
            {
                self.library.state.set_rating(&media, rating, now_millis());
                self.save_library_state();
            }
        }
        if let Some((file_name, watched)) = watched_target {
            if let Some(media) = self
                .poll_state
                .media_files
                .iter()
                .find(|media| media.file_name == file_name)
                .cloned()
            {
                self.library
                    .state
                    .set_watched_override(&media, Some(watched), now_millis());
                self.save_library_state();
            }
        }
        self.library_delete_modal(ui);
        self.library_batch_delete_modal(ui);
        self.library_organization_modal(ui);
        self.library_move_modal(ui);
        self.library_folder_modal(ui);
        self.library_folder_rename_modal(ui);
    }

    fn player_view(&mut self, ui: &mut egui::Ui) {
        self.player_surface.begin_player_frame();
        let snapshot = self.player_session.controller.snapshot();
        self.player_session.apply_pending_resume(&snapshot);
        let entries = library_entries(&self.poll_state.media_files, &self.poll_state.jobs);
        let up_next = entries
            .into_iter()
            .filter(|entry| {
                Some(entry.file_name.as_str()) != self.player_session.loaded_file.as_deref()
            })
            .collect::<Vec<_>>();
        let pose_markers = self
            .player_session
            .media
            .as_ref()
            .map(|media| self.library.state.metadata_or_default(media).pose_markers)
            .unwrap_or_default();
        let output = player_ui::player_view(
            ui,
            PlayerUiInput {
                snapshot: &snapshot,
                up_next: &up_next,
                thumbnail_textures: self.thumbnails.textures(),
                pose_markers: &pose_markers,
                fullscreen: self.player_session.fullscreen,
                shortcuts: self.player_session.shortcuts,
                pro: self.license.current.pro,
            },
        );

        self.player_surface.apply(SurfaceLayout::player(
            output.physical_video_rect,
            output.video_clip_height,
        ));
        if let Some(command) = output.command {
            if matches!(&command, PlayerCommand::Stop) {
                self.stop_playback_session();
            } else {
                let _ = self.player_session.controller.send(command);
            }
        }

        if output.gif_requested {
            self.start_gif_export(&snapshot);
        }

        if output.pose_marker_toggle_requested {
            if let Some(media) = self.player_session.media.clone() {
                let removing = pose_markers.iter().any(|marker| {
                    (*marker - snapshot.position).abs()
                        <= player_ui::POSE_MARKER_ACTIVE_TOLERANCE_SECONDS
                });
                if self.library.state.toggle_pose_marker(
                    &media,
                    snapshot.position,
                    snapshot.duration,
                    now_millis(),
                ) {
                    self.save_library_state();
                    self.notify(
                        if removing {
                            "현재 위치의 포즈 마킹을 지웠습니다."
                        } else {
                            "현재 위치를 포즈 시작점으로 마킹했습니다."
                        },
                        NoticeTone::Info,
                    );
                }
            }
        }

        if let Some(rating) = output.rating_requested {
            if let Some(media) = self.player_session.media.clone() {
                if self.library.state.set_rating(&media, rating, now_millis()) {
                    self.save_library_state();
                    self.notify(
                        if rating == 0 {
                            "별점을 지웠습니다.".to_string()
                        } else {
                            format!("별점 {rating}점을 저장했습니다.")
                        },
                        NoticeTone::Info,
                    );
                }
            }
        }

        if output.open_folder_requested {
            self.open_library_folder(self.player_session.loaded_folder.clone());
        }
        if output.fullscreen_requested {
            self.player_session.fullscreen = !self.player_session.fullscreen;
            ui.ctx()
                .send_viewport_cmd(egui::ViewportCommand::Fullscreen(
                    self.player_session.fullscreen,
                ));
        }

        if let Some(file_name) = output.selected_up_next_file {
            self.play_file(&file_name);
        }

        if let (Some(hover), Some(path)) = (output.hover_preview, snapshot.loaded_path.as_ref()) {
            let media_key = self
                .player_session
                .loaded_file
                .as_deref()
                .and_then(|name| {
                    self.poll_state
                        .media_files
                        .iter()
                        .find(|file| file.file_name == name)
                })
                .map(crate::thumbnails::key)
                .unwrap_or_else(|| path.to_string_lossy().into_owned());
            self.player_session.seek_preview.request(
                ui.ctx(),
                media_key,
                PathBuf::from(path),
                hover.target,
                snapshot.duration,
            );
            let visual = self.player_session.seek_preview.visual();
            player_ui::show_seek_preview_overlay(
                ui.ctx(),
                hover.placement,
                hover.size,
                visual.map(|visual| visual.texture),
                visual.map_or("00:00", |visual| visual.timecode),
            );
        } else {
            self.player_session.seek_preview.hide();
        }
    }

    fn subtitles_view(&mut self, ui: &mut egui::Ui) {
        let summary = subtitle_summary(&self.poll_state.jobs);
        if self.header(ui, summary, &[(Icon::Retry, "새로 고침")]) == Some(0) {
            self.poll(true);
        }

        let views = subtitle_views(&self.poll_state.jobs, &self.poll_state.restartable);
        if views.is_empty() {
            empty_state(
                ui,
                "보관함 메뉴 또는 브라우저 확장에서 자막을 시작합니다. 생성 결과와 실패 이유가 여기에 표시됩니다.",
            );
            return;
        }

        let mut event = None;
        for view in &views {
            if let Some(row_event) = job_row(ui, view) {
                event = Some(row_event);
            }
        }
        if let Some(event) = event {
            self.handle(event);
        }
    }

    fn settings_view(&mut self, ui: &mut egui::Ui) {
        self.handle_shortcut_capture(ui.ctx());
        if self.header(ui, String::new(), &[]) == Some(0) {
            self.open_folder();
        }
        ui.set_width(ui.available_width().min(760.0));

        let mut activate_license = false;
        let mut refresh_license = false;
        let mut remove_license = false;
        let license = self.license.current.clone();
        let checking = self.license.checking;
        Self::setting_group(ui, "이용 플랜", |ui| {
            egui::Frame::new()
                .fill(if license.pro {
                    color::BG_WARNING
                } else {
                    color::BG_SURFACE
                })
                .stroke(hairline(if license.pro {
                    color::ACCENT
                } else {
                    color::BORDER_SUBTLE
                }))
                .corner_radius(corner(radius::MD))
                .inner_margin(margin_xy(16.0, 14.0))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(
                            RichText::new(if license.pro { "PRO" } else { "일반" })
                                .strong()
                                .size(text::BODY_MD)
                                .color(if license.pro {
                                    color::ACCENT
                                } else {
                                    color::TEXT_PRIMARY
                                }),
                        );
                        ui.label(
                            RichText::new(if license.pro {
                                "AI 자막 생성을 사용할 수 있습니다."
                            } else {
                                "다운로드·재생·보관함은 무료로 사용할 수 있습니다."
                            })
                            .size(text::BODY_MD)
                            .color(color::TEXT_SECONDARY),
                        );
                    });
                    ui.add_space(space::X10);
                    if license.pro {
                        ui.horizontal(|ui| {
                            ui.label(
                                RichText::new(license.masked_key())
                                    .monospace()
                                    .color(color::TEXT_PRIMARY),
                            );
                            if let (Some(devices), Some(limit)) = (license.devices, license.limit) {
                                ui.label(
                                    RichText::new(format!("기기 {devices}/{limit}"))
                                        .color(color::TEXT_SECONDARY),
                                );
                            }
                            if let Some(days) = license.days_remaining() {
                                ui.label(
                                    RichText::new(format!("{days}일 남음"))
                                        .color(color::TEXT_SECONDARY),
                                );
                            }
                        });
                        ui.add_space(space::X8);
                        ui.horizontal(|ui| {
                            if button(
                                ui,
                                if checking {
                                    "확인 중…"
                                } else {
                                    "인증 다시 확인"
                                },
                                ButtonStyle::Secondary,
                                !checking,
                            )
                            .clicked()
                            {
                                refresh_license = true;
                            }
                            if button(ui, "인증 해제", ButtonStyle::Quiet, !checking).clicked()
                            {
                                remove_license = true;
                            }
                        });
                    } else {
                        ui.label(
                            RichText::new("Pro: AI 자막 생성")
                                .size(text::BODY_SM)
                                .color(color::TEXT_SECONDARY),
                        );
                        ui.add_space(space::X8);
                        ui.horizontal(|ui| {
                            let response = ui.add_enabled(
                                !checking,
                                egui::TextEdit::singleline(&mut self.license.key_input)
                                    .password(true)
                                    .hint_text("AM-…")
                                    .desired_width(360.0),
                            );
                            if self.license.focus_requested {
                                response.request_focus();
                                self.license.focus_requested = false;
                            }
                            let enter = response.lost_focus()
                                && ui.input(|input| input.key_pressed(egui::Key::Enter));
                            if button(
                                ui,
                                if checking {
                                    "확인 중…"
                                } else {
                                    "Pro 인증"
                                },
                                ButtonStyle::Primary,
                                !checking && !self.license.key_input.trim().is_empty(),
                            )
                            .clicked()
                                || enter
                            {
                                activate_license = true;
                            }
                        });
                    }
                });
        });
        if activate_license {
            self.verify_license(self.license.key_input.clone());
        }
        if refresh_license {
            self.verify_license(self.license.current.key.clone());
        }
        if remove_license {
            self.remove_license();
        }

        let folder = self
            .poll_state
            .downloads_folder
            .clone()
            .unwrap_or_else(|| "경로 확인 불가".to_string());

        let mut pick_folder = false;
        Self::setting_group(ui, "저장 폴더", |ui| {
            egui::Frame::new()
                .inner_margin(margin_xy(12.0, 8.0))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        let (icon_rect, _) = ui.allocate_exact_size(
                            Vec2::splat(metric::ICON_SM),
                            egui::Sense::hover(),
                        );
                        crate::icons::paint_centered(
                            ui,
                            Icon::Folder,
                            icon_rect,
                            metric::ICON_SM,
                            color::TEXT_SECONDARY,
                        );
                        ui.add(
                            egui::Label::new(
                                RichText::new(&folder)
                                    .size(text::MONO_SM)
                                    .color(color::TEXT_PRIMARY),
                            )
                            .truncate(),
                        );
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if icon_button(
                                ui,
                                Icon::FolderOpen,
                                "다운로드 폴더 변경",
                                ButtonStyle::Secondary,
                                true,
                            )
                            .clicked()
                            {
                                pick_folder = true;
                            }
                        });
                    });
                });
        });
        if pick_folder {
            self.choose_folder();
        }

        let shown_shortcuts = self.player_session.shortcuts;
        let capturing = self.player_session.shortcut_capture;
        let mut requested_capture = None;
        let mut reset_requested = false;
        for (id, title, actions) in [
            (
                "playback-shortcuts",
                "재생 단축키",
                ShortcutAction::PLAYBACK.as_slice(),
            ),
            (
                "editing-shortcuts",
                "마킹 · 구간",
                ShortcutAction::EDITING.as_slice(),
            ),
            (
                "rating-shortcuts",
                "별점 단축키",
                ShortcutAction::RATING.as_slice(),
            ),
        ] {
            if let Some(action) =
                shortcut_editor_group(ui, id, title, actions, shown_shortcuts, capturing)
            {
                requested_capture = Some(action);
            }
        }
        if !shown_shortcuts.is_default()
            && button(ui, "기본값 복원", ButtonStyle::Quiet, true).clicked()
        {
            reset_requested = true;
        }
        if let Some(action) = requested_capture {
            self.player_session.shortcut_capture = Some(action);
        }
        if reset_requested {
            self.replace_player_shortcuts(
                PlayerShortcuts::default(),
                "기본 단축키로 복원했습니다.",
            );
            self.player_session.shortcut_capture = None;
        }
    }

    fn handle_shortcut_capture(&mut self, context: &egui::Context) {
        let Some(action) = self.player_session.shortcut_capture else {
            return;
        };
        let captured = context.input(|input| shortcuts::capture_from_events(&input.events));
        match captured {
            Some(CaptureResult::Cancel) => self.player_session.shortcut_capture = None,
            Some(CaptureResult::Shortcut(shortcut)) => {
                let mut updated = self.player_session.shortcuts;
                let displaced = updated.assign_and_swap(action, shortcut);
                let message = displaced.map_or_else(
                    || format!("{} 단축키를 변경했습니다.", action.label()),
                    |other| {
                        format!(
                            "{}와 {} 단축키를 서로 바꿨습니다.",
                            action.label(),
                            other.label()
                        )
                    },
                );
                self.replace_player_shortcuts(updated, message);
                self.player_session.shortcut_capture = None;
            }
            None => {}
        }
    }

    fn replace_player_shortcuts(&mut self, updated: PlayerShortcuts, message: impl Into<String>) {
        match jobs::write_player_shortcuts(updated) {
            Ok(()) => {
                self.player_session.shortcuts = updated;
                self.notify(message, NoticeTone::Info);
            }
            Err(error) => self.notify(
                format!("단축키를 저장하지 못했습니다: {error}"),
                NoticeTone::Error,
            ),
        }
    }

    /// Flat setting section. A single divider separates adjacent regions;
    /// controls inside one region rely on spacing and alignment, not row lines.
    fn setting_group(ui: &mut egui::Ui, title: &str, contents: impl FnOnce(&mut egui::Ui)) {
        ui.add_space(space::X8);
        ui.separator();
        ui.add_space(space::X12);
        ui.label(
            RichText::new(title)
                .size(text::LABEL_MD)
                .strong()
                .color(color::TEXT_SECONDARY),
        );
        ui.add_space(space::X8);
        contents(ui);
        ui.add_space(space::X12);
    }

    fn notice_bar(&mut self, ui: &mut egui::Ui) {
        let Some(notice) = &self.notice else { return };
        let tone = match notice.tone {
            NoticeTone::Info => Tone::Neutral,
            NoticeTone::Error => Tone::Danger,
        };
        egui::Frame::new()
            .fill(tone.background())
            .corner_radius(corner(radius::MD))
            .inner_margin(margin_xy(16.0, 12.0))
            .show(ui, |ui| {
                ui.label(
                    RichText::new(&notice.text)
                        .size(text::BODY_MD)
                        .color(tone.foreground()),
                );
            });
    }
}

impl eframe::App for ManagerApp {
    fn clear_color(&self, _visuals: &egui::Visuals) -> [f32; 4] {
        native_clear_color()
    }

    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        let context = ui.ctx().clone();
        if let Some(hwnd) = self.player_surface.ensure_attached(frame) {
            let _ = self
                .player_session
                .controller
                .send(PlayerCommand::SetVideoWindow(hwnd));
        }
        self.poll(false);
        self.poll_license_result();
        self.poll_gif_export();
        self.save_playback_state(false);
        self.sync_thumbnails(&context);
        self.player_session.seek_preview.poll(&context);
        self.expire_notice();
        // Job state lives on disk and changes without user input, so the window
        // has to wake on its own rather than only on events.
        context.request_repaint_after(POLL_INTERVAL);

        let fullscreen_player = self.player_session.fullscreen && self.view == View::Player;
        if !fullscreen_player {
            egui::Panel::left("rail")
                .exact_size(metric::RAIL_WIDTH)
                .resizable(false)
                .frame(
                    egui::Frame::new()
                        .fill(color::BG_SURFACE)
                        .stroke(hairline(color::BORDER_SUBTLE))
                        .inner_margin(margin_xy(16.0, 20.0)),
                )
                .show(ui, |ui| self.rail(ui));
        }

        egui::CentralPanel::default()
            .frame(if fullscreen_player {
                egui::Frame::new().fill(Color32::BLACK)
            } else {
                egui::Frame::new()
                    .fill(color::BG_CANVAS)
                    .inner_margin(egui::Margin {
                        left: space::X28 as i8,
                        right: 0,
                        top: space::X24 as i8,
                        bottom: space::X24 as i8,
                    })
            })
            .show(ui, |ui| {
                if fullscreen_player {
                    self.player_view(ui);
                } else {
                    ui.spacing_mut().item_spacing = Vec2::new(space::X12, space::X16);
                    egui::ScrollArea::vertical()
                        .auto_shrink([false, false])
                        .show(ui, |ui| {
                            egui::Frame::new()
                                .inner_margin(egui::Margin {
                                    left: 0,
                                    right: space::X28 as i8,
                                    top: 0,
                                    bottom: 0,
                                })
                                .show(ui, |ui| {
                                    ui.set_width(ui.available_width());
                                    ui.spacing_mut().item_spacing =
                                        Vec2::new(space::X12, space::X16);
                                    self.notice_bar(ui);
                                    match self.view {
                                        View::Queue => self.queue_view(ui),
                                        View::Library => self.library_view(ui),
                                        View::Player => self.player_view(ui),
                                        View::Subtitles => self.subtitles_view(ui),
                                        View::Settings => self.settings_view(ui),
                                    }
                                });
                        });
                }
            });
        let snapshot = self.player_session.controller.snapshot();
        if self.pip.should_show(self.view == View::Player, &snapshot) {
            let output = self.pip.render(
                &context,
                &snapshot,
                self.player_session.loaded_file.as_deref(),
                &self.poll_state.media_files,
                &mut self.player_session.seek_preview,
            );
            self.player_surface
                .apply(SurfaceLayout::pip(output.video_rect));
            if output.close_requested {
                self.stop_playback_session();
            }
            if output.return_to_player_requested {
                self.player_surface.clear_clip();
                self.view = View::Player;
                self.pip.return_to_player();
            }
            if let Some(command) = output.command {
                let _ = self.player_session.controller.send(command);
            }
        } else if self.view != View::Player {
            self.player_session.seek_preview.hide();
            self.player_surface.hide();
        }
    }
}

impl Drop for ManagerApp {
    fn drop(&mut self) {
        self.save_playback_state(true);
        let _ = self.library.state.persist();
        self.player_session.shutdown();
        self.player_surface.shutdown();
    }
}

fn native_clear_color() -> [f32; 4] {
    // The main viewport is not a transparent overlay. Clearing it with alpha 0
    // can expose whatever window is behind Segma between GL presents or while
    // the native video child is being resized. An opaque canvas makes Player,
    // PiP, and Library transitions visually atomic.
    color::BG_CANVAS.to_normalized_gamma_f32()
}

fn shortcut_editor_group(
    ui: &mut egui::Ui,
    id: &'static str,
    title: &str,
    actions: &[ShortcutAction],
    shortcuts: PlayerShortcuts,
    capturing: Option<ShortcutAction>,
) -> Option<ShortcutAction> {
    let mut requested = None;
    ManagerApp::setting_group(ui, title, |ui| {
        let gap = space::X8;
        let cell_width = ((ui.available_width() - gap) / 2.0).max(220.0);
        for (row_index, row) in actions.chunks(2).enumerate() {
            if row_index > 0 {
                ui.add_space(space::X4);
            }
            ui.push_id((id, row_index), |ui| {
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = gap;
                    for action in row {
                        ui.allocate_ui_with_layout(
                            Vec2::new(cell_width, metric::CONTROL_HEIGHT + 12.0),
                            egui::Layout::left_to_right(egui::Align::Center),
                            |ui| {
                                ui.set_width(cell_width);
                                ui.add_space(space::X8);
                                ui.label(
                                    RichText::new(action.label())
                                        .size(text::BODY_SM)
                                        .color(color::TEXT_PRIMARY),
                                );
                                ui.with_layout(
                                    egui::Layout::right_to_left(egui::Align::Center),
                                    |ui| {
                                        ui.add_space(space::X8);
                                        let active = capturing == Some(*action);
                                        let label = if active {
                                            "키 입력…".to_string()
                                        } else {
                                            ui.ctx().format_shortcut(&shortcuts.get(*action))
                                        };
                                        if button(
                                            ui,
                                            &label,
                                            if active {
                                                ButtonStyle::Primary
                                            } else {
                                                ButtonStyle::Secondary
                                            },
                                            true,
                                        )
                                        .clicked()
                                        {
                                            requested = Some(*action);
                                        }
                                    },
                                );
                            },
                        );
                    }
                });
            });
        }
    });
    requested
}

fn rating_star_button(ui: &mut egui::Ui, rating: i32, selected: bool) -> egui::Response {
    let response = ui.allocate_response(Vec2::splat(RATING_STAR_HIT_SIZE), egui::Sense::click());
    if response.hovered() {
        ui.painter()
            .rect_filled(response.rect, corner(radius::MD), color::BG_SUBTLE);
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    crate::icons::paint_centered(
        ui,
        Icon::Star,
        response.rect,
        RATING_STAR_ICON_SIZE,
        if selected {
            color::ACCENT
        } else {
            color::TEXT_MUTED
        },
    );
    response.widget_info(|| {
        egui::WidgetInfo::selected(
            egui::WidgetType::Button,
            true,
            selected,
            format!("별점 {rating}점"),
        )
    });
    response
}

/// Search input with a leading icon and no separate caption label.
fn search_field(ui: &mut egui::Ui, query: &mut String) {
    egui::Frame::new()
        .fill(color::BG_SURFACE)
        .stroke(hairline(color::BORDER_DEFAULT))
        .corner_radius(corner(radius::MD))
        .inner_margin(margin_xy(space::X8, 0.0))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.set_min_height(metric::CONTROL_HEIGHT);
                ui.spacing_mut().item_spacing.x = space::X4;
                let (icon_rect, _) =
                    ui.allocate_exact_size(Vec2::splat(metric::ICON_SM), egui::Sense::hover());
                crate::icons::paint_centered(
                    ui,
                    Icon::Search,
                    icon_rect,
                    metric::ICON_SM,
                    color::TEXT_MUTED,
                );
                ui.add(
                    egui::TextEdit::singleline(query)
                        .frame(egui::Frame::NONE)
                        .hint_text("제목 또는 파일명")
                        .desired_width(260.0),
                );
            });
        });
}

/// Folder that received a dropped file and the time its settle ring ends.
type DropSettle = Option<(Option<String>, f64)>;

/// Drops a settle record whose animation window has passed, so the library
/// never keeps a permanent "last dropped folder" highlight.
fn expire_drop_settle(settle: &mut DropSettle, now: f64) -> bool {
    match settle {
        Some((_, until)) if now >= *until => {
            *settle = None;
            true
        }
        _ => false,
    }
}

/// Settle strength for one folder chip; `0.0` for every other chip.
fn drop_settle_progress_for(settle: &DropSettle, folder: Option<&str>, now: f64) -> f32 {
    match settle {
        Some((target, until)) if target.as_deref() == folder => {
            crate::widgets::drop_settle_progress(now, *until, crate::widgets::DROP_SETTLE_TIME)
        }
        _ => 0.0,
    }
}

/// Drag feedback a folder chip should paint this frame.
#[derive(Debug, Clone, Copy, Default)]
struct FolderDropHint {
    /// A library file is currently being dragged.
    dragging: bool,
    /// Remaining settle progress after this folder received a file.
    settle: f32,
}

/// Folder row in the library grid header. Count is the file total inside it.
fn folder_chip(
    ui: &mut egui::Ui,
    name: &str,
    media_count: Option<usize>,
    drop_hint: FolderDropHint,
) -> egui::Response {
    let font = egui::FontId::proportional(text::BODY_MD);
    let label = media_count
        .map(|count| format!("{name}  {count}"))
        .unwrap_or_else(|| name.to_string());
    let label_width = ui
        .painter()
        .layout_no_wrap(label.clone(), font.clone(), color::TEXT_PRIMARY)
        .rect
        .width();
    let response = ui.allocate_response(
        Vec2::new(
            label_width + metric::ICON_SM + space::X8 * 3.0,
            metric::CONTROL_HEIGHT,
        ),
        egui::Sense::click(),
    );
    // Emphasis is animated but painted outside the allocated rect, so the chip
    // row keeps identical geometry whether or not a drag is in flight.
    let targeted = drop_hint.dragging && response.hovered();
    let target_progress = ui.ctx().animate_bool_with_time(
        response.id.with("folder-drop-target"),
        targeted,
        crate::widgets::DROP_TARGET_MOTION_TIME,
    );
    crate::widgets::paint_drop_target_emphasis(ui, response.rect, target_progress);
    crate::widgets::paint_drop_settle(ui, response.rect, drop_hint.settle);
    let fill = if response.hovered() {
        color::BG_SELECTED
    } else {
        color::BG_SUBTLE
    };
    ui.painter()
        .rect_filled(response.rect, corner(radius::MD), fill);
    let icon_rect = egui::Rect::from_min_size(
        egui::pos2(response.rect.left() + space::X8, response.rect.top()),
        Vec2::new(metric::ICON_SM, response.rect.height()),
    );
    crate::icons::paint_centered(
        ui,
        Icon::Folder,
        icon_rect,
        metric::ICON_SM,
        color::TEXT_PRIMARY,
    );
    ui.painter().text(
        egui::pos2(icon_rect.right() + space::X8, response.rect.center().y),
        egui::Align2::LEFT_CENTER,
        label,
        font,
        color::TEXT_PRIMARY,
    );
    if response.hovered() {
        ui.ctx().set_cursor_icon(if drop_hint.dragging {
            egui::CursorIcon::Copy
        } else {
            egui::CursorIcon::PointingHand
        });
    }
    if targeted || drop_hint.settle > 0.0 {
        ui.ctx().request_repaint();
    }
    response.widget_info(|| {
        egui::WidgetInfo::labeled(
            egui::WidgetType::Button,
            true,
            if targeted {
                format!("{name} 폴더로 이동")
            } else {
                format!("{name} 폴더 열기")
            },
        )
    });
    response
}

/// Korean labels need a Korean-capable face. Use Malgun Gothic as the primary
/// proportional face so Hangul, Latin, numbers, and punctuation share metrics
/// inside one label. Keep egui's monospace face first for code/path values and
/// use Korean only as its Hangul fallback.
fn install_fonts(context: &egui::Context) {
    use eframe::egui::{FontData, FontDefinitions};

    let candidates = [
        r"C:\Windows\Fonts\malgun.ttf",
        r"C:\Windows\Fonts\gulim.ttc",
    ];
    let Some(bytes) = candidates.iter().find_map(|path| std::fs::read(path).ok()) else {
        // Without a Korean face the labels would render as boxes. The window is
        // still usable, so this degrades rather than refusing to start.
        return;
    };

    let mut fonts = FontDefinitions::default();
    fonts.font_data.insert(
        "korean".to_owned(),
        std::sync::Arc::new(FontData::from_owned(bytes)),
    );
    prefer_korean_ui_font(&mut fonts);
    context.set_fonts(fonts);
}

fn prefer_korean_ui_font(fonts: &mut eframe::egui::FontDefinitions) {
    use eframe::egui::FontFamily;

    let proportional = fonts.families.entry(FontFamily::Proportional).or_default();
    proportional.retain(|name| name != "korean");
    proportional.insert(0, "korean".to_owned());

    let monospace = fonts.families.entry(FontFamily::Monospace).or_default();
    if !monospace.iter().any(|name| name == "korean") {
        monospace.push("korean".to_owned());
    }
}

fn install_style(context: &egui::Context) {
    // Applied to every theme so a light window never inherits a dark default.
    context.all_styles_mut(|style| {
        style.visuals.panel_fill = color::BG_CANVAS;
        style.visuals.window_fill = color::BG_SURFACE;
        style.visuals.override_text_color = Some(color::TEXT_PRIMARY);
        style.visuals.widgets.noninteractive.bg_stroke = hairline(color::BORDER_SUBTLE);
        style.visuals.selection.bg_fill = color::BG_SELECTED;
        style.visuals.selection.stroke = hairline(color::BORDER_STRONG);
        style.spacing.item_spacing = Vec2::new(space::X8, space::X10);
        style.spacing.button_padding = Vec2::new(14.0, 8.0);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::JobState;
    use crate::model::JobView;
    use crate::queue_controller::QueueFilter;

    fn view_for(status: &str) -> JobView {
        model::to_view(
            &JobState {
                job_id: "job".into(),
                status: status.into(),
                ..JobState::default()
            },
            true,
            false,
        )
    }

    #[test]
    fn queue_filters_select_the_expected_rows() {
        let running = view_for("running");
        let done = view_for("completed");
        let failed = view_for("failed");

        assert!(QueueFilter::All.matches(&running));
        assert!(QueueFilter::All.matches(&done));

        assert!(QueueFilter::Active.matches(&running));
        assert!(!QueueFilter::Active.matches(&done));

        assert!(QueueFilter::Complete.matches(&done));
        assert!(!QueueFilter::Complete.matches(&running));

        assert!(QueueFilter::Failed.matches(&failed));
        assert!(!QueueFilter::Failed.matches(&done));
    }

    #[test]
    fn a_paused_job_is_reachable_only_through_all_and_paused() {
        let paused = view_for("paused");
        assert!(QueueFilter::All.matches(&paused));
        assert!(QueueFilter::Paused.matches(&paused));
        // Paused sits between active and terminal, so no other filter claims it.
        assert!(!QueueFilter::Active.matches(&paused));
        assert!(!QueueFilter::Complete.matches(&paused));
        assert!(!QueueFilter::Failed.matches(&paused));
    }

    #[test]
    fn no_running_job_leaks_into_the_paused_filter() {
        for status in ["running", "queued", "completed", "failed", "cancelled"] {
            assert!(
                !QueueFilter::Paused.matches(&view_for(status)),
                "status {status} must not match the paused filter"
            );
        }
    }

    #[test]
    fn every_queue_filter_has_a_korean_label() {
        for filter in QueueFilter::ALL {
            assert!(filter.label().chars().any(|c| !c.is_ascii()));
        }
    }

    #[test]
    fn a_cancelled_job_is_not_counted_as_complete_or_failed() {
        let cancelled = view_for("cancelled");
        assert!(!QueueFilter::Complete.matches(&cancelled));
        assert!(!QueueFilter::Failed.matches(&cancelled));
        assert!(!QueueFilter::Active.matches(&cancelled));
        assert!(QueueFilter::All.matches(&cancelled));
    }

    #[test]
    fn row_action_errors_are_transient_notices_and_preserve_host_state_bytes() {
        let directory = std::env::temp_dir().join(format!(
            "aura-manager-app-notice-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).expect("temp directory creates");
        let state_path = directory.join("job-abc.state.json");
        let original =
            br#"{ "jobId":"job-abc", "status":"failed", "error":"host-owned", "updatedAt":41 }"#;
        std::fs::write(&state_path, original).expect("state writes");

        let mut app = ManagerApp::default();
        app.show_row_action_result(
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "marker denied",
            )),
            "unused",
            "취소하지 못했습니다",
        );

        let notice = app.notice.as_ref().expect("error is visible immediately");
        assert_eq!(notice.tone, NoticeTone::Error);
        assert!(notice.text.contains("취소하지 못했습니다"));
        assert!(notice.text.contains("marker denied"));
        assert_eq!(
            std::fs::read(&state_path).expect("state reads"),
            original,
            "UI feedback must not overwrite host-owned JobState"
        );
        std::fs::remove_dir_all(directory).expect("temp directory removes");
    }

    #[test]
    fn every_view_has_a_korean_label() {
        for view in View::ALL {
            assert!(!view.label().is_empty());
            assert!(view.label().chars().any(|c| !c.is_ascii()));
        }
    }

    #[test]
    fn korean_ui_font_is_primary_only_for_proportional_text() {
        let mut fonts = eframe::egui::FontDefinitions::default();
        prefer_korean_ui_font(&mut fonts);

        let proportional = &fonts.families[&eframe::egui::FontFamily::Proportional];
        let monospace = &fonts.families[&eframe::egui::FontFamily::Monospace];
        assert_eq!(proportional.first().map(String::as_str), Some("korean"));
        assert_ne!(monospace.first().map(String::as_str), Some("korean"));
        assert_eq!(monospace.last().map(String::as_str), Some("korean"));
    }

    #[test]
    fn library_rating_stars_are_visually_compact() {
        assert!(RATING_STAR_ICON_SIZE < metric::ICON_SM);
        assert!(RATING_STAR_HIT_SIZE < metric::CONTROL_HEIGHT);
        let compact_row = RATING_STAR_HIT_SIZE * 5.0 + 2.0 * 4.0;
        assert!(compact_row < metric::CONTROL_HEIGHT * 5.0);
    }

    #[test]
    fn rail_brand_uses_the_store_ko_name() {
        let source = include_str!("app.rs");
        assert!(source.contains("SEGMA"));
        assert!(source.contains("PLAYER"));
        assert!(!source.contains("RichText::new(\"Aura Media\")"));
        assert!(!source.contains("RichText::new(\"Companion\")"));
        assert!(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("assets/segma-mark.png")
            .is_file());
    }

    #[test]
    fn png_loader_is_enabled_for_the_figma_brand_asset() {
        let manifest = include_str!("../Cargo.toml");
        assert!(manifest.contains("features = [\"image\", \"svg\"]"));
    }
    #[test]
    fn taskbar_icon_uses_embedded_win32_resource() {
        assert!(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("assets/segma-player.ico")
            .is_file());
        let main = include_str!("main.rs");
        assert!(!main.contains("with_icon(window_icon())"));
        assert!(main.contains("SHCNE_ASSOCCHANGED"));
        assert!(main.contains("refresh_shell_icon_cache();"));
    }

    #[test]
    fn library_thumbnail_uses_one_click_and_drag_interaction() {
        let app = include_str!("app.rs");
        let widgets = include_str!("widgets.rs");
        let forbidden_overlay = ["response.id.with(\"library", "-drag\")"].concat();
        assert!(!app.contains(&forbidden_overlay));
        assert!(widgets.contains("sense(Sense::click_and_drag())"));
        assert!(app.contains("if response.clicked()"));
        assert!(app.contains("if response.drag_started()"));
    }

    #[test]
    fn a_finished_drop_settle_leaves_no_permanent_library_state() {
        let mut settle: DropSettle = Some((Some("보관".to_string()), 5.0));
        // Mid-animation the record survives and still paints.
        assert!(!expire_drop_settle(
            &mut settle,
            5.0 - crate::widgets::DROP_SETTLE_TIME / 2.0
        ));
        assert!(
            drop_settle_progress_for(
                &settle,
                Some("보관"),
                5.0 - crate::widgets::DROP_SETTLE_TIME / 2.0
            ) > 0.0
        );
        // Past the deadline the record is released and contributes nothing.
        assert!(expire_drop_settle(&mut settle, 5.0));
        assert!(settle.is_none());
        assert_eq!(drop_settle_progress_for(&settle, Some("보관"), 5.0), 0.0);
        assert!(!expire_drop_settle(&mut settle, 99.0));
    }

    #[test]
    fn a_drop_arms_the_settle_animation_only_for_its_own_destination() {
        let start = 9.0 - crate::widgets::DROP_SETTLE_TIME;
        let folder: DropSettle = Some((Some("보관".to_string()), 9.0));
        assert!(drop_settle_progress_for(&folder, Some("보관"), start) > 0.0);
        assert_eq!(drop_settle_progress_for(&folder, Some("기타"), start), 0.0);
        assert_eq!(drop_settle_progress_for(&folder, None, start), 0.0);

        // A drop onto the root chip highlights the root chip only.
        let root: DropSettle = Some((None, 9.0));
        assert!(drop_settle_progress_for(&root, None, start) > 0.0);
        assert_eq!(drop_settle_progress_for(&root, Some("보관"), start), 0.0);
        assert_eq!(drop_settle_progress_for(&None, None, start), 0.0);
    }

    #[test]
    fn drag_feedback_is_paint_only_and_keeps_click_playback() {
        let source = include_str!("app.rs");
        let library_start = source.find("fn library_view").unwrap();
        let chip_start = source.find("fn folder_chip").unwrap();
        let library = &source[library_start..chip_start];
        // Click-to-play stays the primary interaction on the thumbnail.
        assert!(library.contains("play_target = Some(entry.file_name.clone());"));
        assert!(library.contains("paint_drag_lift(ui, response.rect, lift)"));
        // Emphasis must not allocate space or change tile geometry.
        assert!(!library.contains("paint_drag_lift(ui, response.rect.expand"));
        let chip = &source[chip_start..];
        assert!(chip.contains("paint_drop_target_emphasis"));
        assert!(chip.contains("paint_drop_settle"));
        assert!(chip.contains("폴더 열기"));
        assert!(chip.contains("폴더로 이동"));
        assert!(chip.contains("egui::Sense::click()"));
    }

    #[test]
    fn native_main_viewport_clear_is_opaque() {
        let clear = native_clear_color();
        assert_eq!(clear[3], 1.0);
        assert_eq!(clear, color::BG_CANVAS.to_normalized_gamma_f32());
    }

    #[test]
    fn library_batch_actions_have_guarded_keyboard_contracts() {
        let source = include_str!("app.rs");
        let library = &source
            [source.find("fn library_view").unwrap()..source.find("fn folder_chip").unwrap()];
        assert!(library.contains("egui::Modifiers::COMMAND, egui::Key::A"));
        assert!(library.contains("egui::Modifiers::NONE, egui::Key::Escape"));
        assert!(library.contains("egui::Modifiers::NONE, egui::Key::Delete"));
        assert!(library.contains("!ui.ctx().text_edit_focused()"));
        assert!(library.contains("!egui::Popup::is_any_open(ui.ctx())"));
        assert!(library.contains("self.library.pending_batch_delete = true"));
        assert!(library.contains("self.clear_library_selection()"));
        assert!(library.contains("자동 정리"));
        assert!(library.contains("정리 실행 취소"));
    }

    #[test]
    fn shared_page_chrome_has_one_header_footprint() {
        assert_eq!(player_ui::PAGE_HEADER_HEIGHT, 64.0);
        let source = include_str!("app.rs");
        assert!(source.contains("player_ui::PAGE_HEADER_HEIGHT"));
        assert!(source.contains("brand_title_offset"));
    }

    #[test]
    fn brand_title_block_uses_glyph_bounds_not_line_boxes() {
        let source = include_str!("app.rs");
        let helper_start = source.find("fn brand_title_galley").unwrap();
        let helper = &source[helper_start..];
        assert!(helper.contains("fn brand_title_block_height"));
        assert!(helper.contains("brand_title_glyph_height"));
        assert!(helper.contains("mesh_bounds"));
        assert!(helper.contains("paint_brand_title_line"));
        let rail = &source[source.find("fn rail(").unwrap()..source.find("fn header(").unwrap()];
        let title = &rail[..rail.find("for view in View::ALL").unwrap()];
        assert!(title.contains("item_spacing.y = 0.0"));
        assert!(title.contains("paint_brand_title_line"));
        assert!(!title.contains("egui::Label::new("));
        assert!(title.contains("brand_title_block_height(ui)"));
        // The rail stacks the two lines with the same single gap the measured
        // block height accounts for, so the probe below mirrors real placement.
        assert_eq!(title.matches("BRAND_TITLE_LINE_GAP").count(), 1);
        // The badge rides PLAYER's baseline rather than its own ink top.
        assert!(title.contains("player.box_top"));
    }

    /// One live layout pass over the real font set. Both the naive line-box sum
    /// (the previous formula) and the packed block are read from the same
    /// galleys, so the comparison cannot drift with the installed font.
    struct BrandTitleProbe {
        line_box_sum: f32,
        packed: f32,
        segma: BrandRun,
        player: BrandRun,
        badge: BrandRun,
    }

    fn measure_brand_title() -> BrandTitleProbe {
        let context = egui::Context::default();
        install_fonts(&context);
        let mut probe = None;
        let output = context.run_ui(Default::default(), |ui| {
            let line_box_sum =
                brand_title_galley(ui, "SEGMA", text::HEADING_SM, color::TEXT_PRIMARY)
                    .rect
                    .height()
                    + brand_title_galley(ui, "PLAYER", text::LABEL_SM, color::TEXT_PRIMARY)
                        .rect
                        .height();
            // Same placement arithmetic the rail uses.
            let origin = egui::Pos2::ZERO;
            let segma =
                paint_brand_title_line(ui, origin, "SEGMA", text::HEADING_SM, color::TEXT_PRIMARY);
            let player = paint_brand_title_line(
                ui,
                egui::Pos2::new(origin.x, segma.ink.bottom() + BRAND_TITLE_LINE_GAP),
                "PLAYER",
                text::LABEL_SM,
                color::TEXT_SECONDARY,
            );
            let badge = paint_brand_title_run(
                ui,
                egui::Pos2::new(player.ink.right() + space::X4, player.box_top),
                "일반",
                text::LABEL_SM,
                color::TEXT_MUTED,
            );
            probe = Some(BrandTitleProbe {
                line_box_sum,
                packed: brand_title_block_height(ui),
                segma,
                player,
                badge,
            });
        });
        output.drop_without_applying_deltas();
        probe.expect("the brand title is laid out once per pass")
    }

    #[test]
    fn packed_brand_title_is_shorter_than_stacked_line_boxes() {
        let probe = measure_brand_title();
        println!(
            "TEMPPROBE segma={:?} player={:?} badge={:?} packed={} sum={}",
            probe.segma.ink, probe.player.ink, probe.badge.ink, probe.packed, probe.line_box_sum
        );

        // The previous formula was exactly this sum of `Galley::rect` heights,
        // which carries the font's ascent and descent on both lines. That
        // leading is the space the user still saw between SEGMA and PLAYER.
        assert!(
            probe.packed < probe.line_box_sum,
            "packed {} should be tighter than the line-box sum {}",
            probe.packed,
            probe.line_box_sum
        );
        // The saving is a real line's worth of leading, not a rounding artifact.
        assert!(probe.line_box_sum - probe.packed >= BRAND_TITLE_LINE_GAP * 2.0);

        // PLAYER sits directly under SEGMA's ink, separated only by the one
        // optical gap, and the measured block is exactly that stack.
        assert_eq!(
            probe.player.ink.top() - probe.segma.ink.bottom(),
            BRAND_TITLE_LINE_GAP
        );
        assert_eq!(
            probe.player.ink.bottom() - probe.segma.ink.top(),
            probe.packed
        );
        assert_eq!(
            probe.segma.ink.height() + BRAND_TITLE_LINE_GAP + probe.player.ink.height(),
            probe.packed
        );
        // Both lines share the block's left edge.
        assert_eq!(probe.segma.ink.left(), probe.player.ink.left());
        // Ink heights stay below their own line boxes, so nothing was measured
        // from a default line metric.
        assert!(probe.segma.ink.height() < text::HEADING_SM * 1.5);
        assert!(probe.player.ink.height() < text::LABEL_SM * 1.5);
    }

    #[test]
    fn the_edition_badge_keeps_players_baseline_after_ink_packing() {
        let probe = measure_brand_title();

        // Hangul ink starts higher than Latin caps, so ink-aligning the badge
        // would drop it below PLAYER. Sharing one layout-box top keeps the two
        // runs on the same baseline while the block stays ink-packed.
        assert!(probe.badge.ink.top() < probe.player.ink.top());
        assert_eq!(probe.badge.box_top, probe.player.box_top);
        // The badge follows PLAYER horizontally with one gap between them.
        assert_eq!(probe.badge.ink.left() - probe.player.ink.right(), space::X4);
    }

    #[test]
    fn the_rail_row_is_sized_from_the_packed_title_block() {
        let probe = measure_brand_title();

        // The shared row and both optical offsets are derived from the packed
        // height, so the mark cannot be centered against a phantom line box.
        let row = brand_row_height(BRAND_LOGO_SIZE, probe.packed);
        assert_eq!(row, BRAND_LOGO_SIZE.max(probe.packed));
        assert!(row < brand_row_height(BRAND_LOGO_SIZE, probe.line_box_sum));

        let title_top = brand_title_offset(BRAND_LOGO_SIZE, probe.packed);
        assert!(title_top + probe.packed <= row);
        // The title's optical center still tracks the mark's perceived center.
        assert_eq!(
            title_top + (probe.packed / 2.0).round(),
            (BRAND_LOGO_SIZE / 2.0 - BRAND_LOGO_OPTICAL_BIAS).round()
        );
    }

    #[test]
    fn brand_title_alignment_uses_the_logo_perceived_center() {
        // Title shorter than the mark: its center lands on the mark's perceived
        // center, one point above the geometric midpoint.
        assert_eq!(brand_row_height(32.0, 26.0), 32.0);
        assert_eq!(brand_logo_offset(32.0, 26.0), 0.0);
        assert_eq!(brand_title_offset(32.0, 26.0), 1.0);
        assert_eq!(
            brand_title_offset(32.0, 26.0) + 26.0 / 2.0,
            32.0 / 2.0 - BRAND_LOGO_OPTICAL_BIAS
        );

        // Title taller than the mark: the mark is the block that gets centered,
        // and the title still starts at the top of the shared row.
        assert_eq!(brand_row_height(24.0, 40.0), 40.0);
        assert_eq!(brand_logo_offset(24.0, 40.0), 8.0);
        assert_eq!(brand_title_offset(24.0, 40.0), 0.0);
        // The title cannot move above the shared row, so the optical lift is
        // clamped and the two centers are not forced equal in this case.
        assert_eq!(brand_title_offset(24.0, 40.0) + 40.0 / 2.0, 20.0);

        // Whenever the mark is centered in the row, the title carries exactly the
        // optical bias, and no input can push a block above the row's top edge.
        assert_eq!(brand_title_offset(32.0, 32.0), 0.0);
        assert_eq!(brand_title_offset(16.0, 64.0), 0.0);
        for (logo, title) in [(32.0, 26.0), (24.0, 40.0), (32.0, 32.0), (0.0, 0.0)] {
            assert!(brand_logo_offset(logo, title) >= 0.0);
            assert!(brand_title_offset(logo, title) >= 0.0);
            assert!(brand_row_height(logo, title) >= logo.max(title));
        }
    }
}

/// The title block's visual mass sits slightly below its geometric midpoint, so
/// aligning it to the mark requires a one-point upward correction.
const BRAND_LOGO_OPTICAL_BIAS: f32 = 2.0;

/// Shared row height for the mark and the title block. Whichever block is
/// shorter is centered inside it, so neither one can pull the row taller.
fn brand_row_height(logo_height: f32, title_block_height: f32) -> f32 {
    logo_height.max(title_block_height)
}

/// Top inset for the mark when the title block is the taller of the two.
fn brand_logo_offset(logo_height: f32, title_block_height: f32) -> f32 {
    ((title_block_height - logo_height).max(0.0) / 2.0).round()
}

/// Top inset that puts the title block's center on the mark's perceived center.
fn brand_title_offset(logo_height: f32, title_block_height: f32) -> f32 {
    let logo_top = brand_logo_offset(logo_height, title_block_height);
    let perceived_center = logo_top + logo_height / 2.0 - BRAND_LOGO_OPTICAL_BIAS;
    (perceived_center - title_block_height / 2.0)
        .max(0.0)
        .round()
}

/// Optical gap between the two stacked brand lines. The lines are placed on
/// their letterforms, so the default ascent/descent leading is gone and this is
/// the only separation left; it keeps `PLAYER` from touching `SEGMA`.
const BRAND_TITLE_LINE_GAP: f32 = space::X2;

/// One laid-out brand line. The Korean UI font decides the real metrics, so the
/// block is measured from the live font set rather than assumed from the ramp.
fn brand_title_galley(
    ui: &egui::Ui,
    text_value: &str,
    size: f32,
    color: Color32,
) -> std::sync::Arc<egui::Galley> {
    ui.painter().layout_no_wrap(
        text_value.to_owned(),
        egui::FontId::proportional(size),
        color,
    )
}

/// Tight bounds of a line's ink. `Galley::rect` is the default line box and
/// carries the font's ascent/descent, which is exactly the leftover space
/// between the two title lines; `mesh_bounds` is the tessellated glyph extent.
/// A face that produced no mesh falls back to the line box so the block never
/// collapses to nothing.
fn brand_title_ink(galley: &egui::Galley) -> egui::Rect {
    if galley.mesh_bounds.is_positive() {
        galley.mesh_bounds
    } else {
        galley.rect
    }
}

fn brand_title_glyph_height(ui: &egui::Ui, text_value: &str, size: f32) -> f32 {
    let galley = brand_title_galley(ui, text_value, size, color::TEXT_PRIMARY);
    brand_title_ink(&galley).height().max(1.0)
}

/// A painted brand run: the ink it actually covers, plus the layout-box top it
/// was drawn from. Runs that share a `box_top` share a baseline, which is how
/// the edition badge stays level with `PLAYER` even though Hangul ink starts
/// higher than Latin caps.
#[derive(Clone, Copy)]
struct BrandRun {
    ink: egui::Rect,
    box_top: f32,
}

/// Paint an already laid-out line so its ink's left edge lands on
/// `ink_left`, from the given layout-box top.
fn paint_brand_galley(
    ui: &egui::Ui,
    ink_left: f32,
    box_top: f32,
    galley: std::sync::Arc<egui::Galley>,
    color: Color32,
) -> BrandRun {
    let ink = brand_title_ink(&galley);
    ui.painter().galley(
        egui::Pos2::new(ink_left - ink.left(), box_top),
        galley,
        color,
    );
    BrandRun {
        ink: egui::Rect::from_min_size(
            egui::Pos2::new(ink_left, box_top + ink.top()),
            egui::Vec2::new(ink.width(), ink.height().max(1.0)),
        ),
        box_top,
    }
}

/// Paint one brand run on an existing baseline, given that baseline's
/// layout-box top.
fn paint_brand_title_run(
    ui: &egui::Ui,
    box_left_top: egui::Pos2,
    text_value: &str,
    size: f32,
    color: Color32,
) -> BrandRun {
    let galley = brand_title_galley(ui, text_value, size, color);
    paint_brand_galley(ui, box_left_top.x, box_left_top.y, galley, color)
}

/// Paint one brand line so its ink, not its line box, starts at `ink_origin`.
/// This is what packs SEGMA and PLAYER: the font's ascent and descent no longer
/// separate the two lines.
fn paint_brand_title_line(
    ui: &egui::Ui,
    ink_origin: egui::Pos2,
    text_value: &str,
    size: f32,
    color: Color32,
) -> BrandRun {
    let galley = brand_title_galley(ui, text_value, size, color);
    let box_top = ink_origin.y - brand_title_ink(&galley).top();
    paint_brand_galley(ui, ink_origin.x, box_top, galley, color)
}

/// Packed height of the two-line block: glyph ink plus the single optical gap.
fn brand_title_block_height(ui: &egui::Ui) -> f32 {
    brand_title_glyph_height(ui, "SEGMA", text::HEADING_SM)
        + BRAND_TITLE_LINE_GAP
        + brand_title_glyph_height(ui, "PLAYER", text::LABEL_SM)
}
