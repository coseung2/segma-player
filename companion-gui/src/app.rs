//! Window state and view assembly.
//!
//! Job state is polled from disk on a fixed interval. The manager never talks
//! to the native messaging host process; the jobs folder is the interface.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender};
use std::time::{Duration, Instant};

use eframe::egui::{self, Color32, RichText, Vec2};

use crate::gif_export::{GifExportController, GifExportRequest, GifExportStatus};
use crate::icons::Icon;
use crate::jobs::{self, JobState, MediaFile};
use crate::library_state::{LibraryState, WatchState};
use crate::model::{
    self, library_entries, missing_output_count, queue_summary, queue_views, subtitle_summary,
    subtitle_views, JobView, RestartableJobs,
};
use crate::player_backend::PlayerController;
use crate::player_contract::{PhysicalVideoRect, PlayerCommand};
use crate::player_ui::{self, PlayerUiInput};
use crate::seek_preview::SeekPreviewController;
use crate::shortcuts::{self, CaptureResult, PlayerShortcuts, ShortcutAction};
use crate::theme::{color, corner, hairline, margin, margin_xy, metric, radius, space, text, Tone};
use crate::thumbnails::{ThumbnailRequest, ThumbnailResult};
use crate::widgets::{
    button, empty_state, icon_button, job_row, media_thumbnail, menu_row, nav_item, tile_menu,
    ButtonStyle, RowEvent, TileMenuEvent,
};

const POLL_INTERVAL: Duration = Duration::from_millis(900);
/// A notice stays long enough to read, then clears itself so a stale message
/// never looks like current state.
const NOTICE_LIFETIME: Duration = Duration::from_secs(6);
const RATING_STAR_HIT_SIZE: f32 = 26.0;
const RATING_STAR_ICON_SIZE: f32 = 14.0;

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
pub enum QueueFilter {
    All,
    Active,
    Paused,
    Complete,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LibraryFilter {
    All,
    Favorite,
    Unwatched,
    InProgress,
    Completed,
}

impl LibraryFilter {
    const ALL: [Self; 5] = [
        Self::All,
        Self::Favorite,
        Self::Unwatched,
        Self::InProgress,
        Self::Completed,
    ];

    fn label(self) -> &'static str {
        match self {
            Self::All => "전체",
            Self::Favorite => "찜",
            Self::Unwatched => "미시청",
            Self::InProgress => "보는 중",
            Self::Completed => "완료",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LibrarySort {
    Newest,
    Rating,
    Title,
}

impl LibrarySort {
    const ALL: [Self; 3] = [Self::Newest, Self::Rating, Self::Title];

    fn label(self) -> &'static str {
        match self {
            Self::Newest => "최신순",
            Self::Rating => "별점순",
            Self::Title => "제목순",
        }
    }
}

impl QueueFilter {
    pub const ALL: [QueueFilter; 5] = [
        QueueFilter::All,
        QueueFilter::Active,
        QueueFilter::Paused,
        QueueFilter::Complete,
        QueueFilter::Failed,
    ];

    pub fn label(self) -> &'static str {
        match self {
            QueueFilter::All => "전체",
            QueueFilter::Active => "진행 중",
            QueueFilter::Paused => "일시정지",
            QueueFilter::Complete => "완료",
            QueueFilter::Failed => "실패",
        }
    }

    pub fn matches(self, view: &JobView) -> bool {
        match self {
            QueueFilter::All => true,
            QueueFilter::Active => view.active,
            // Paused is neither active nor terminal, so it needs its own filter
            // or it would only ever appear under 전체.
            QueueFilter::Paused => view.paused,
            QueueFilter::Complete => view.tone == Tone::Success,
            QueueFilter::Failed => view.tone == Tone::Danger,
        }
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
    queue_filter: QueueFilter,
    jobs: Vec<JobState>,
    /// Media files actually present in the download folder. The library is built
    /// from this, not from job history, so a moved or deleted file disappears
    /// and a hand-placed file shows up.
    media_files: Vec<MediaFile>,
    /// Job ids whose `.request.json` still exists, refreshed with each poll.
    /// Resume and retry need that record, so a row without it shows no restart
    /// button instead of one that fails.
    restartable: RestartableJobs,
    /// Kept separate from `jobs` so a failed poll does not clear the list. An
    /// empty list would make a transient read error look like lost history.
    read_error: Option<String>,
    last_poll: Instant,
    notice: Option<Notice>,
    search: String,
    library_filter: LibraryFilter,
    library_sort: LibrarySort,
    library_min_rating: i32,
    library_state: LibraryState,
    /// File name waiting for the delete confirmation modal.
    pending_delete: Option<String>,
    /// `None` shows the download folder root; `Some(name)` shows one folder.
    library_folder: Option<String>,
    library_folders: Vec<jobs::LibraryFolder>,
    /// File name waiting for a move-destination choice.
    pending_move: Option<String>,
    /// Draft name for the create-folder modal; `Some` means the modal is open.
    pending_folder_name: Option<String>,
    /// Existing name and editable draft for the rename-folder modal.
    pending_folder_rename: Option<(String, String)>,
    /// File currently dragged from a library tile. Folder chips consume it on
    /// pointer release and the existing move routine performs the safe rename.
    dragged_library_file: Option<String>,
    player: PlayerController,
    gif_export: GifExportController,
    seek_preview: SeekPreviewController,
    player_parent_hwnd: isize,
    taskbar_icon_applied: bool,
    player_video_hwnd: isize,
    player_loaded_file: Option<String>,
    player_media: Option<MediaFile>,
    pending_resume_position: Option<f64>,
    last_resume_save: Instant,
    /// Folder the currently loaded file came from.
    player_loaded_folder: Option<String>,
    fullscreen: bool,
    downloads_folder: Option<String>,
    player_shortcuts: PlayerShortcuts,
    shortcut_capture: Option<ShortcutAction>,
    thumbnail_requests: Sender<ThumbnailRequest>,
    thumbnail_results: Receiver<ThumbnailResult>,
    thumbnail_textures: HashMap<String, egui::TextureHandle>,
    thumbnail_pending: HashSet<String>,
    thumbnail_unavailable: HashSet<String>,
}

impl Default for ManagerApp {
    fn default() -> Self {
        let thumbnails = crate::thumbnails::start_worker();
        Self {
            view: View::Queue,
            queue_filter: QueueFilter::All,
            jobs: Vec::new(),
            media_files: Vec::new(),
            restartable: RestartableJobs::new(),
            read_error: None,
            last_poll: Instant::now() - POLL_INTERVAL,
            notice: None,
            search: String::new(),
            library_filter: LibraryFilter::All,
            library_sort: LibrarySort::Newest,
            library_min_rating: 0,
            library_state: LibraryState::load().unwrap_or_default(),
            pending_delete: None,
            library_folder: None,
            library_folders: Vec::new(),
            pending_move: None,
            pending_folder_name: None,
            pending_folder_rename: None,
            dragged_library_file: None,
            player: PlayerController::new(),
            gif_export: GifExportController::new(),
            seek_preview: SeekPreviewController::new(),
            player_parent_hwnd: 0,
            taskbar_icon_applied: false,
            player_video_hwnd: 0,
            player_loaded_file: None,
            player_media: None,
            pending_resume_position: None,
            last_resume_save: Instant::now() - Duration::from_secs(3),
            player_loaded_folder: None,
            fullscreen: false,
            downloads_folder: jobs::downloads_dir()
                .ok()
                .map(|path| path.to_string_lossy().into_owned()),
            player_shortcuts: jobs::read_player_shortcuts(),
            shortcut_capture: None,
            thumbnail_requests: thumbnails.requests,
            thumbnail_results: thumbnails.results,
            thumbnail_textures: HashMap::new(),
            thumbnail_pending: HashSet::new(),
            thumbnail_unavailable: HashSet::new(),
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
        if !force && self.last_poll.elapsed() < POLL_INTERVAL {
            return;
        }
        self.last_poll = Instant::now();
        match jobs::read_jobs() {
            Ok(jobs) => {
                self.restartable = jobs::restartable_ids(
                    &jobs
                        .iter()
                        .map(|job| job.job_id.clone())
                        .collect::<Vec<_>>(),
                );
                self.jobs = jobs;
                self.read_error = None;
            }
            Err(error) => self.read_error = Some(error.to_string()),
        }
        // The folder can change from the extension side too, so re-read it
        // rather than trusting the value captured at startup.
        self.downloads_folder = jobs::downloads_dir()
            .ok()
            .map(|path| path.to_string_lossy().into_owned());
        // Read the folder every poll: a file can be deleted or moved outside the
        // app, and the library must reflect the folder rather than job history.
        self.library_folders = jobs::read_library_folders().unwrap_or_default();
        // A folder can disappear outside the app; fall back to the root instead
        // of showing an empty view for a path that no longer exists.
        if let Some(current) = self.library_folder.clone() {
            if !self
                .library_folders
                .iter()
                .any(|folder| folder.name == current)
            {
                self.library_folder = None;
            }
        }
        self.media_files =
            jobs::read_media_files_in_folder(self.library_folder.as_deref()).unwrap_or_default();
    }

    fn sync_thumbnails(&mut self, context: &egui::Context) {
        while let Ok(result) = self.thumbnail_results.try_recv() {
            self.thumbnail_pending.remove(&result.key);
            if let Some(image) = result.image {
                let color_image = egui::ColorImage::from_rgba_unmultiplied(image.size, &image.rgba);
                let texture = context.load_texture(
                    format!("library:{}", result.key),
                    color_image,
                    egui::TextureOptions::LINEAR,
                );
                self.thumbnail_textures.insert(result.key, texture);
            } else {
                self.thumbnail_unavailable.insert(result.key);
            }
        }

        let Ok(folder) = jobs::library_dir(self.library_folder.as_deref()) else {
            return;
        };
        for file in &self.media_files {
            let key = crate::thumbnails::key(file);
            if self.thumbnail_textures.contains_key(&key)
                || self.thumbnail_pending.contains(&key)
                || self.thumbnail_unavailable.contains(&key)
            {
                continue;
            }
            let request = ThumbnailRequest {
                key: key.clone(),
                media_path: folder.join(&file.file_name),
            };
            if self.thumbnail_requests.send(request).is_ok() {
                self.thumbnail_pending.insert(key);
            }
        }
    }

    fn notify(&mut self, text: impl Into<String>, tone: NoticeTone) {
        self.notice = Some(Notice {
            text: text.into(),
            tone,
            shown_at: Instant::now(),
        });
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
            RowEvent::Pause(job_id) => {
                if let Err(error) = jobs::request_pause(&job_id) {
                    let _ = jobs::set_job_status_text(
                        &job_id,
                        &format!("일시정지하지 못했습니다: {error}"),
                    );
                }
            }
            RowEvent::Resume(job_id) => {
                if let Err(error) = jobs::restart_job(&job_id, "이어받기를 준비하는 중…")
                {
                    let _ = jobs::set_job_status_text(
                        &job_id,
                        &format!("이어받기를 시작하지 못했습니다: {error}"),
                    );
                }
            }
            RowEvent::Retry(job_id) => {
                if let Err(error) = jobs::restart_job(&job_id, "다시 시도하는 중…") {
                    let _ = jobs::set_job_status_text(
                        &job_id,
                        &format!("다시 시도하지 못했습니다: {error}"),
                    );
                }
            }
            RowEvent::Play(job_id) => self.play(&job_id),
            RowEvent::Cancel(job_id) => {
                if let Err(error) = jobs::request_cancel(&job_id) {
                    let _ = jobs::set_job_status_text(
                        &job_id,
                        &format!("취소하지 못했습니다: {error}"),
                    );
                }
            }
            RowEvent::OpenFolder => self.open_folder(),
        }
        self.poll(true);
    }

    /// Plays a job's recorded output. Resolves the file name from job state, so
    /// a job whose file is gone reports that instead of failing silently.
    fn play(&mut self, job_id: &str) {
        let file_name = self
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
        match jobs::start_library_subtitle_job(self.library_folder.as_deref(), file_name) {
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

        self.play_file_in(self.library_folder.clone(), file_name);
    }

    fn play_file_in(&mut self, folder: Option<String>, file_name: &str) {
        match jobs::media_path(folder.as_deref(), file_name) {
            Ok(path) => {
                self.save_playback_state(true);
                let media = jobs::read_media_files_in_folder(folder.as_deref())
                    .ok()
                    .and_then(|files| files.into_iter().find(|file| file.file_name == file_name));
                self.pending_resume_position = media.as_ref().and_then(|media| {
                    let metadata = self.library_state.metadata_or_default(media);
                    (metadata.watch_state() == WatchState::InProgress
                        && metadata.last_position.is_finite()
                        && metadata.last_position >= 5.0)
                        .then_some(metadata.last_position)
                });
                self.seek_preview.media_changed();
                self.player_loaded_file = Some(file_name.to_string());
                self.player_loaded_folder = folder;
                self.player_media = media;
                self.view = View::Player;
                let _ = self.player.send(PlayerCommand::Load(path));
            }
            Err(error) => self.notify(format!("재생하지 못했습니다: {error}"), NoticeTone::Error),
        }
    }

    fn save_library_state(&mut self) {
        if !self.library_state.is_dirty() {
            return;
        }
        if let Err(error) = self.library_state.persist() {
            self.notify(
                format!("보관함 정보를 저장하지 못했습니다: {error}"),
                NoticeTone::Error,
            );
        }
    }

    fn save_playback_state(&mut self, force: bool) {
        if !force && self.last_resume_save.elapsed() < Duration::from_secs(2) {
            return;
        }
        let Some(media) = self.player_media.as_ref() else {
            return;
        };
        let snapshot = self.player.snapshot();
        if snapshot.loaded_path.is_none()
            || !snapshot.position.is_finite()
            || !snapshot.duration.is_finite()
            || snapshot.duration <= 0.0
        {
            return;
        }
        self.last_resume_save = Instant::now();
        if snapshot.position >= 5.0
            && self
                .library_state
                .metadata_or_default(media)
                .watched_override
                == Some(false)
        {
            self.library_state
                .set_watched_override(media, None, now_millis());
        }
        if self
            .library_state
            .set_resume(media, snapshot.position, snapshot.duration, now_millis())
        {
            self.save_library_state();
        }
    }

    fn start_gif_export(&mut self, snapshot: &crate::player_contract::PlayerSnapshot) {
        if self.gif_export.is_busy() {
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
        let output = match jobs::library_dir(self.player_loaded_folder.as_deref()) {
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
        match self.gif_export.submit(request) {
            Ok(()) => self.notify("GIF를 만드는 중입니다.", NoticeTone::Info),
            Err(error) => self.notify(
                format!("GIF를 만들지 못했습니다: {error}"),
                NoticeTone::Error,
            ),
        }
    }

    fn poll_gif_export(&mut self) {
        match self.gif_export.poll() {
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
                self.downloads_folder = Some(path.to_string_lossy().into_owned());
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
        match jobs::reveal_file(self.library_folder.as_deref(), file_name) {
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
            .media_files
            .iter()
            .find(|file| file.file_name == file_name)
        {
            let key = crate::thumbnails::key(file);
            self.thumbnail_textures.remove(&key);
            self.thumbnail_pending.remove(&key);
            self.thumbnail_unavailable.remove(&key);
        }
    }

    /// Stops playback when the file being changed is the one currently loaded.
    fn release_if_playing(&mut self, file_name: &str) {
        if self.player_loaded_file.as_deref() == Some(file_name)
            && self.player_loaded_folder == self.library_folder
        {
            let _ = self.player.send(PlayerCommand::Stop);
            self.seek_preview.media_changed();
            self.player_loaded_file = None;
            self.player_loaded_folder = None;
            self.player_media = None;
            self.pending_resume_position = None;
        }
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
                if self.library_folder.as_deref() == Some(from) {
                    self.library_folder = Some(to.to_string());
                }
                if self.player_loaded_folder.as_deref() == Some(from) {
                    self.player_loaded_folder = Some(to.to_string());
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
        let source = self.library_folder.clone();
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
        match jobs::delete_media_file(self.library_folder.as_deref(), file_name) {
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
        let Some(file_name) = self.pending_delete.clone() else {
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
            self.pending_delete = None;
        } else if cancelled {
            self.pending_delete = None;
        }
    }

    /// Destination chooser for a pending move. Rows are the existing folders
    /// plus the root, excluding wherever the file already is.
    fn library_move_modal(&mut self, ui: &mut egui::Ui) {
        let Some(file_name) = self.pending_move.clone() else {
            return;
        };
        let mut chosen: Option<Option<String>> = None;
        let mut cancelled = false;
        let folders = self.library_folders.clone();
        let current = self.library_folder.clone();

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
            self.pending_move = None;
        } else if cancelled {
            self.pending_move = None;
        }
    }

    /// New-folder prompt. The name is validated with the same rule the IO layer
    /// uses, so the confirm button cannot submit a name that would be rejected.
    fn library_folder_modal(&mut self, ui: &mut egui::Ui) {
        let Some(mut draft) = self.pending_folder_name.clone() else {
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
            self.pending_folder_name = None;
        } else if cancelled {
            self.pending_folder_name = None;
        } else {
            self.pending_folder_name = Some(draft);
        }
    }

    fn library_folder_rename_modal(&mut self, ui: &mut egui::Ui) {
        let Some((original, mut draft)) = self.pending_folder_rename.clone() else {
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
            self.pending_folder_rename = None;
        } else if cancelled {
            self.pending_folder_rename = None;
        } else {
            self.pending_folder_rename = Some((original, draft));
        }
    }

    fn rail(&mut self, ui: &mut egui::Ui) {
        ui.spacing_mut().item_spacing = Vec2::new(0.0, space::X4);

        ui.add_space(space::X4);
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = space::X8;
            ui.add(
                egui::Image::new(egui::include_image!("../assets/segma-mark.png"))
                    .fit_to_exact_size(Vec2::splat(32.0))
                    .sense(egui::Sense::hover()),
            );
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 0.0;
                ui.label(
                    RichText::new("SEGMA")
                        .size(text::HEADING_SM)
                        .strong()
                        .color(color::TEXT_PRIMARY),
                );
                ui.label(
                    RichText::new("PLAYER")
                        .size(text::LABEL_SM)
                        .strong()
                        .color(color::TEXT_SECONDARY),
                );
            });
        });
        ui.add_space(space::X16);

        for view in View::ALL {
            if nav_item(ui, view.label(), self.view == view).clicked() {
                self.view = view;
            }
        }

        // Push the status block to the bottom the way the design does.
        let reserved = 74.0;
        let remaining = ui.available_height() - reserved;
        if remaining > 0.0 {
            ui.add_space(remaining);
        }

        let (title, detail, tone) = match &self.read_error {
            None => {
                let path = self
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
            Some(error) => ("작업 폴더를 읽지 못함".to_string(), error.clone(), Tone::Danger),
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
        actions: &[(Icon, &str, ButtonStyle)],
    ) -> Option<usize> {
        let mut clicked = None;
        ui.horizontal(|ui| {
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
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                for (index, (icon, label, style)) in actions.iter().enumerate().rev() {
                    if icon_button(ui, *icon, label, *style, true).clicked() {
                        clicked = Some(index);
                    }
                }
            });
        });
        clicked
    }

    fn filters(&mut self, ui: &mut egui::Ui) {
        egui::Frame::new()
            .fill(color::BG_SUBTLE)
            .corner_radius(corner(radius::MD))
            .inner_margin(margin(4.0))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = space::X4;
                    for filter in QueueFilter::ALL {
                        let selected = self.queue_filter == filter;
                        let widget = egui::Button::new(
                            RichText::new(filter.label())
                                .size(text::LABEL_MD)
                                .color(if selected {
                                    color::TEXT_PRIMARY
                                } else {
                                    color::TEXT_SECONDARY
                                }),
                        )
                        .fill(if selected {
                            color::BG_SURFACE
                        } else {
                            egui::Color32::TRANSPARENT
                        })
                        .stroke(egui::Stroke::NONE)
                        .corner_radius(corner(radius::MD));
                        if ui.add(widget).clicked() {
                            self.queue_filter = filter;
                        }
                    }
                });
            });
    }

    fn queue_view(&mut self, ui: &mut egui::Ui) {
        let summary = queue_summary(&self.jobs);
        let clicked = self.header(
            ui,
            summary,
            &[
                (Icon::Retry, "새로 고침", ButtonStyle::Secondary),
                (Icon::FolderOpen, "폴더 열기", ButtonStyle::Primary),
            ],
        );
        match clicked {
            Some(0) => self.poll(true),
            Some(1) => self.open_folder(),
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

        let views: Vec<JobView> = queue_views(&self.jobs, &self.restartable, &self.media_files)
            .into_iter()
            .filter(|view| self.queue_filter.matches(view))
            .collect();
        let total = queue_views(&self.jobs, &self.restartable, &self.media_files).len();

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
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing = Vec2::new(space::X4, space::X4);
            for filter in LibraryFilter::ALL {
                let style = if self.library_filter == filter {
                    ButtonStyle::Inverse
                } else {
                    ButtonStyle::Quiet
                };
                if button(ui, filter.label(), style, true).clicked() {
                    self.library_filter = filter;
                }
            }
            ui.add_space(space::X8);
            for rating in 1..=5 {
                let selected = rating <= self.library_min_rating;
                if icon_button(
                    ui,
                    Icon::Star,
                    &format!("별점 {rating}점 이상"),
                    if selected {
                        ButtonStyle::Primary
                    } else {
                        ButtonStyle::Quiet
                    },
                    true,
                )
                .clicked()
                {
                    self.library_min_rating = if self.library_min_rating == rating {
                        0
                    } else {
                        rating
                    };
                }
            }
            ui.add_space(space::X8);
            for sort in LibrarySort::ALL {
                let style = if self.library_sort == sort {
                    ButtonStyle::Secondary
                } else {
                    ButtonStyle::Quiet
                };
                if button(ui, sort.label(), style, true).clicked() {
                    self.library_sort = sort;
                }
            }
        });
    }

    /// Library is driven by the download folder, not by job history.
    ///
    /// A file the user moved or deleted disappears from the list, and a file
    /// dropped into the folder by hand shows up. Job state only supplies the
    /// title and media type when a record happens to match by file name.
    fn library_view(&mut self, ui: &mut egui::Ui) {
        let entries = library_entries(&self.media_files, &self.jobs);
        let missing = if self.library_folder.is_none() {
            missing_output_count(&self.media_files, &self.jobs)
        } else {
            0
        };

        let mut refresh = false;
        let mut open_folder = false;
        let mut new_folder = false;
        let mut leave_folder = false;

        ui.horizontal(|ui| {
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = space::X4;
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = space::X8;
                    if let Some(folder) = self.library_folder.clone() {
                        if icon_button(ui, Icon::Back, "보관함 최상위", ButtonStyle::Quiet, true)
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
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.spacing_mut().item_spacing.x = space::X8;
                if icon_button(
                    ui,
                    Icon::FolderOpen,
                    "폴더 열기",
                    ButtonStyle::Secondary,
                    true,
                )
                .clicked()
                {
                    open_folder = true;
                }
                if icon_button(ui, Icon::Retry, "새로 고침", ButtonStyle::Quiet, true).clicked()
                {
                    refresh = true;
                }
                if self.library_folder.is_none()
                    && icon_button(ui, Icon::FolderPlus, "새 폴더", ButtonStyle::Quiet, true)
                        .clicked()
                {
                    new_folder = true;
                }
            });
        });

        search_field(ui, &mut self.search);
        self.library_controls(ui);

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
        if !self.library_folders.is_empty() || self.library_folder.is_some() {
            let folders = self.library_folders.clone();
            ui.horizontal_wrapped(|ui| {
                ui.spacing_mut().item_spacing = Vec2::new(space::X8, space::X8);
                if self.library_folder.is_some() {
                    let response = folder_chip(ui, "최상위", None);
                    if response.clicked() {
                        leave_folder = true;
                    }
                    if self.dragged_library_file.is_some()
                        && response.hovered()
                        && ui.input(|input| input.pointer.any_released())
                    {
                        drop_destination = Some(None);
                    }
                }
                for folder in &folders {
                    if self.library_folder.as_deref() == Some(folder.name.as_str()) {
                        continue;
                    }
                    let response = folder_chip(ui, &folder.name, Some(folder.media_count));
                    if response.clicked() {
                        enter_folder = Some(folder.name.clone());
                    }
                    if self.dragged_library_file.is_some()
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

        let needle = self.search.trim().to_lowercase();
        let mut filtered: Vec<&model::LibraryEntry> = entries
            .iter()
            .filter(|entry| {
                let search_matches = needle.is_empty()
                    || entry.title.to_lowercase().contains(&needle)
                    || entry.file_name.to_lowercase().contains(&needle);
                let Some(media) = self
                    .media_files
                    .iter()
                    .find(|media| media.file_name == entry.file_name)
                else {
                    return false;
                };
                let metadata = self.library_state.metadata_or_default(media);
                let watch_state = self.library_state.watch_state_for(media);
                let state_matches = match self.library_filter {
                    LibraryFilter::All => true,
                    LibraryFilter::Favorite => metadata.favorite,
                    LibraryFilter::Unwatched => watch_state == WatchState::Unwatched,
                    LibraryFilter::InProgress => watch_state == WatchState::InProgress,
                    LibraryFilter::Completed => watch_state == WatchState::Completed,
                };
                search_matches && state_matches && metadata.rating >= self.library_min_rating
            })
            .collect();
        filtered.sort_by(|left, right| match self.library_sort {
            LibrarySort::Newest => right.modified_at.cmp(&left.modified_at),
            LibrarySort::Title => left.title.to_lowercase().cmp(&right.title.to_lowercase()),
            LibrarySort::Rating => {
                let rating = |entry: &model::LibraryEntry| {
                    self.media_files
                        .iter()
                        .find(|media| media.file_name == entry.file_name)
                        .map(|media| self.library_state.metadata_or_default(media).rating)
                        .unwrap_or_default()
                };
                rating(right)
                    .cmp(&rating(left))
                    .then_with(|| right.modified_at.cmp(&left.modified_at))
            }
        });

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
            let has_folders = !self.library_folders.is_empty();
            for row in filtered.chunks(columns) {
                ui.horizontal_top(|ui| {
                    ui.spacing_mut().item_spacing.x = gap;
                    for entry in row {
                        let metadata = self
                            .media_files
                            .iter()
                            .find(|media| media.file_name == entry.file_name)
                            .map(|media| self.library_state.metadata_or_default(media))
                            .unwrap_or_default();
                        ui.allocate_ui_with_layout(
                            Vec2::new(tile_width, tile_width * 9.0 / 16.0 + 104.0),
                            egui::Layout::top_down(egui::Align::LEFT),
                            |ui| {
                                ui.set_width(tile_width);
                                ui.spacing_mut().item_spacing.y = space::X4;
                                let response = media_thumbnail(
                                    ui,
                                    self.thumbnail_textures.get(&entry.thumbnail_key),
                                    &entry.type_label,
                                    tile_width,
                                );
                                if response.hovered() {
                                    ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
                                }
                                if response.clicked() {
                                    play_target = Some(entry.file_name.clone());
                                }
                                let drag = ui.interact(
                                    response.rect,
                                    response.id.with("library-drag"),
                                    egui::Sense::drag(),
                                );
                                if drag.drag_started() {
                                    self.dragged_library_file = Some(entry.file_name.clone());
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
        if open_folder {
            self.open_library_folder(self.library_folder.clone());
        }
        if new_folder {
            self.pending_folder_name = Some(String::new());
        }
        if leave_folder {
            self.library_folder = None;
            self.poll(true);
        }
        if let Some(folder) = enter_folder {
            self.library_folder = Some(folder);
            self.poll(true);
        }
        if let Some(folder) = rename_folder {
            self.pending_folder_rename = Some((folder.clone(), folder));
        }
        if let Some(destination) = drop_destination {
            if let Some(file_name) = self.dragged_library_file.take() {
                self.move_library_file(&file_name, destination.as_deref());
            }
        } else if ui.input(|input| input.pointer.any_released()) {
            self.dragged_library_file = None;
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
            self.pending_move = Some(file_name);
        }
        if let Some(file_name) = delete_target {
            self.pending_delete = Some(file_name);
        }
        if let Some(file_name) = favorite_target {
            if let Some(media) = self
                .media_files
                .iter()
                .find(|media| media.file_name == file_name)
                .cloned()
            {
                self.library_state.toggle_favorite(&media, now_millis());
                self.save_library_state();
            }
        }
        if let Some((file_name, rating)) = rating_target {
            if let Some(media) = self
                .media_files
                .iter()
                .find(|media| media.file_name == file_name)
                .cloned()
            {
                self.library_state.set_rating(&media, rating, now_millis());
                self.save_library_state();
            }
        }
        if let Some((file_name, watched)) = watched_target {
            if let Some(media) = self
                .media_files
                .iter()
                .find(|media| media.file_name == file_name)
                .cloned()
            {
                self.library_state
                    .set_watched_override(&media, Some(watched), now_millis());
                self.save_library_state();
            }
        }
        self.library_delete_modal(ui);
        self.library_move_modal(ui);
        self.library_folder_modal(ui);
        self.library_folder_rename_modal(ui);
    }

    fn player_view(&mut self, ui: &mut egui::Ui) {
        let snapshot = self.player.snapshot();
        if snapshot.loaded_path.is_some() && snapshot.duration > 0.0 {
            if let Some(position) = self.pending_resume_position.take() {
                let _ = self.player.send(PlayerCommand::SeekAbsolute(
                    position.min((snapshot.duration - 0.5).max(0.0)),
                ));
            }
        }
        let entries = library_entries(&self.media_files, &self.jobs);
        let up_next = entries
            .into_iter()
            .filter(|entry| Some(entry.file_name.as_str()) != self.player_loaded_file.as_deref())
            .collect::<Vec<_>>();
        let pose_markers = self
            .player_media
            .as_ref()
            .map(|media| self.library_state.metadata_or_default(media).pose_markers)
            .unwrap_or_default();
        let output = player_ui::player_view(
            ui,
            PlayerUiInput {
                snapshot: &snapshot,
                up_next: &up_next,
                thumbnail_textures: &self.thumbnail_textures,
                pose_markers: &pose_markers,
                fullscreen: self.fullscreen,
                shortcuts: self.player_shortcuts,
            },
        );

        layout_video_window(self.player_video_hwnd, output.physical_video_rect, true);
        if let Some(command) = output.command {
            if matches!(&command, PlayerCommand::Stop) {
                self.save_playback_state(true);
            }
            let _ = self.player.send(command);
        }

        if output.gif_requested {
            self.start_gif_export(&snapshot);
        }

        if output.pose_marker_toggle_requested {
            if let Some(media) = self.player_media.clone() {
                let removing = pose_markers.iter().any(|marker| {
                    (*marker - snapshot.position).abs()
                        <= player_ui::POSE_MARKER_ACTIVE_TOLERANCE_SECONDS
                });
                if self.library_state.toggle_pose_marker(
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
            if let Some(media) = self.player_media.clone() {
                if self.library_state.set_rating(&media, rating, now_millis()) {
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
            self.open_library_folder(self.player_loaded_folder.clone());
        }
        if output.fullscreen_requested {
            self.fullscreen = !self.fullscreen;
            ui.ctx()
                .send_viewport_cmd(egui::ViewportCommand::Fullscreen(self.fullscreen));
        }

        if let Some(file_name) = output.selected_up_next_file {
            self.play_file(&file_name);
        }

        if let (Some(hover), Some(path)) = (output.hover_preview, snapshot.loaded_path.as_ref()) {
            let scale = ui.ctx().pixels_per_point();
            let overlay = PhysicalVideoRect {
                x: (hover.placement.x * scale).round() as i32,
                y: (hover.placement.y * scale).round() as i32,
                width: (192.0 * scale).round() as i32,
                height: (136.0 * scale).round() as i32,
            };
            let media_key = self
                .player_loaded_file
                .as_deref()
                .and_then(|name| self.media_files.iter().find(|file| file.file_name == name))
                .map(crate::thumbnails::key)
                .unwrap_or_else(|| path.to_string_lossy().into_owned());
            self.seek_preview.request(
                media_key,
                PathBuf::from(path),
                hover.target,
                snapshot.duration,
                self.player_parent_hwnd,
                overlay,
            );
        } else {
            self.seek_preview.hide();
        }
        self.seek_preview.poll();
    }

    fn subtitles_view(&mut self, ui: &mut egui::Ui) {
        let summary = subtitle_summary(&self.jobs);
        if self.header(
            ui,
            summary,
            &[(Icon::Retry, "새로 고침", ButtonStyle::Secondary)],
        ) == Some(0)
        {
            self.poll(true);
        }

        let views = subtitle_views(&self.jobs, &self.restartable);
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

        let folder = self
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

        let shown_shortcuts = self.player_shortcuts;
        let capturing = self.shortcut_capture;
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
            self.shortcut_capture = Some(action);
        }
        if reset_requested {
            self.replace_player_shortcuts(
                PlayerShortcuts::default(),
                "기본 단축키로 복원했습니다.",
            );
            self.shortcut_capture = None;
        }
    }

    fn handle_shortcut_capture(&mut self, context: &egui::Context) {
        let Some(action) = self.shortcut_capture else {
            return;
        };
        let captured = context.input(|input| shortcuts::capture_from_events(&input.events));
        match captured {
            Some(CaptureResult::Cancel) => self.shortcut_capture = None,
            Some(CaptureResult::Shortcut(shortcut)) => {
                let mut updated = self.player_shortcuts;
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
                self.shortcut_capture = None;
            }
            None => {}
        }
    }

    fn replace_player_shortcuts(&mut self, updated: PlayerShortcuts, message: impl Into<String>) {
        match jobs::write_player_shortcuts(updated) {
            Ok(()) => {
                self.player_shortcuts = updated;
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
        Color32::TRANSPARENT.to_normalized_gamma_f32()
    }

    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        let context = ui.ctx().clone();
        if let Some(hwnd) = frame_hwnd(frame) {
            if !self.taskbar_icon_applied {
                self.taskbar_icon_applied = apply_taskbar_icon(hwnd);
            }
            if self.player_parent_hwnd == 0 {
                self.player_parent_hwnd = hwnd;
                self.player_video_hwnd = create_video_window(hwnd).unwrap_or(0);
                if self.player_video_hwnd != 0 {
                    let _ = self
                        .player
                        .send(PlayerCommand::SetVideoWindow(self.player_video_hwnd));
                }
            }
        }
        self.poll(false);
        self.poll_gif_export();
        self.save_playback_state(false);
        self.sync_thumbnails(&context);
        self.expire_notice();
        if self.view != View::Player {
            layout_video_window(self.player_video_hwnd, PhysicalVideoRect::default(), false);
            self.seek_preview.hide();
        }
        // Job state lives on disk and changes without user input, so the window
        // has to wake on its own rather than only on events.
        context.request_repaint_after(POLL_INTERVAL);

        let fullscreen_player = self.fullscreen && self.view == View::Player;
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
                    .inner_margin(margin_xy(space::X28, space::X24))
            })
            .show(ui, |ui| {
                if fullscreen_player {
                    self.player_view(ui);
                } else {
                    ui.spacing_mut().item_spacing = Vec2::new(space::X12, space::X16);
                    egui::ScrollArea::vertical()
                        .auto_shrink([false, false])
                        .show(ui, |ui| {
                            ui.spacing_mut().item_spacing = Vec2::new(space::X12, space::X16);
                            self.notice_bar(ui);
                            match self.view {
                                View::Queue => self.queue_view(ui),
                                View::Library => self.library_view(ui),
                                View::Player => self.player_view(ui),
                                View::Subtitles => self.subtitles_view(ui),
                                View::Settings => self.settings_view(ui),
                            }
                        });
                }
            });
    }
}

impl Drop for ManagerApp {
    fn drop(&mut self) {
        self.save_playback_state(true);
        let _ = self.library_state.persist();
        self.seek_preview.shutdown();
        self.player.shutdown();
        destroy_video_window(self.player_video_hwnd);
        self.player_video_hwnd = 0;
    }
}

#[cfg(target_os = "windows")]
fn create_video_window(parent: isize) -> windows::core::Result<isize> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, WINDOW_EX_STYLE, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
    };

    // SAFETY: called on eframe's UI thread; STATIC is a predefined class and
    // the supplied parent is the live viewport HWND.
    let window = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("STATIC"),
            PCWSTR::null(),
            WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
            0,
            0,
            1,
            1,
            Some(HWND(parent as *mut core::ffi::c_void)),
            None,
            None,
            None,
        )?
    };
    Ok(window.0 as isize)
}

#[cfg(not(target_os = "windows"))]
fn create_video_window(_parent: isize) -> Result<isize, ()> {
    Err(())
}

#[cfg(target_os = "windows")]
fn layout_video_window(window: isize, rect: PhysicalVideoRect, visible: bool) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, ShowWindow, SWP_NOACTIVATE, SWP_NOZORDER, SW_HIDE, SW_SHOWNA,
    };

    if window == 0 {
        return;
    }
    let window = HWND(window as *mut core::ffi::c_void);
    if visible && rect.visible() {
        let positioned = unsafe {
            SetWindowPos(
                window,
                None,
                rect.x,
                rect.y,
                rect.width,
                rect.height,
                SWP_NOZORDER | SWP_NOACTIVATE,
            )
        };
        if positioned.is_ok() {
            let _ = unsafe { ShowWindow(window, SW_SHOWNA) };
        }
    } else {
        let _ = unsafe { ShowWindow(window, SW_HIDE) };
    }
}

#[cfg(not(target_os = "windows"))]
fn layout_video_window(_window: isize, _rect: PhysicalVideoRect, _visible: bool) {}

#[cfg(target_os = "windows")]
fn destroy_video_window(window: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::DestroyWindow;

    if window != 0 {
        let _ = unsafe { DestroyWindow(HWND(window as *mut core::ffi::c_void)) };
    }
}

#[cfg(not(target_os = "windows"))]
fn destroy_video_window(_window: isize) {}

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

/// Folder row in the library grid header. Count is the file total inside it.
fn folder_chip(ui: &mut egui::Ui, name: &str, media_count: Option<usize>) -> egui::Response {
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
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    response.widget_info(|| {
        egui::WidgetInfo::labeled(egui::WidgetType::Button, true, format!("{name} 폴더 열기"))
    });
    response
}

#[cfg(target_os = "windows")]
fn frame_hwnd(frame: &eframe::Frame) -> Option<isize> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    match frame.window_handle().ok()?.as_raw() {
        RawWindowHandle::Win32(handle) => Some(handle.hwnd.get()),
        _ => None,
    }
}

#[cfg(not(target_os = "windows"))]
fn frame_hwnd(_frame: &eframe::Frame) -> Option<isize> {
    None
}

#[cfg(target_os = "windows")]
fn apply_taskbar_icon(window: isize) -> bool {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        LoadImageW, SendMessageW, SetClassLongPtrW, GCLP_HICON, GCLP_HICONSM, HICON, ICON_BIG,
        ICON_SMALL, IMAGE_ICON, WM_SETICON,
    };

    let hwnd = HWND(window as *mut core::ffi::c_void);
    let Ok(module) = (unsafe { GetModuleHandleW(None) }) else {
        return false;
    };
    let load = |cx: i32, cy: i32| unsafe {
        LoadImageW(
            Some(module.into()),
            windows::core::w!( "#1" ),
            IMAGE_ICON,
            cx,
            cy,
            windows::Win32::UI::WindowsAndMessaging::LR_DEFAULTCOLOR,
        )
        .ok()
        .map(|image| HICON(image.0))
    };
    let Some(small) = load(16, 16) else {
        return false;
    };
    let Some(big) = load(32, 32).or_else(|| load(256, 256)) else {
        return false;
    };
    unsafe {
        let _ = SendMessageW(hwnd, WM_SETICON, Some(WPARAM(ICON_SMALL as usize)), Some(LPARAM(small.0 as isize)));
        let _ = SendMessageW(hwnd, WM_SETICON, Some(WPARAM(ICON_BIG as usize)), Some(LPARAM(big.0 as isize)));
        let _ = SetClassLongPtrW(hwnd, GCLP_HICONSM, small.0 as isize);
        let _ = SetClassLongPtrW(hwnd, GCLP_HICON, big.0 as isize);
    }
    true
}
#[cfg(not(target_os = "windows"))]
fn apply_taskbar_icon(_window: isize) -> bool {
    true
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
        let source = include_str!("app.rs");
        assert!(source.contains("apply_taskbar_icon"));
        assert!(source.contains("WM_SETICON"));
        assert!(source.contains("ICON_SMALL"));
        assert!(source.contains("load(16, 16)"));
        assert!(source.contains("load(32, 32)"));
        assert!(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("assets/segma-player.ico")
            .is_file());
        let main = include_str!("main.rs");
        assert!(!main.contains("with_icon(window_icon())"));
        assert!(main.contains("SHCNE_ASSOCCHANGED"));
        assert!(main.contains("refresh_shell_icon_cache();"));
    }

}
