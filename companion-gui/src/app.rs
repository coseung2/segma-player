//! Window state and view assembly.
//!
//! Job state is polled from disk on a fixed interval. The manager never talks
//! to the native messaging host process; the jobs folder is the interface.

use std::time::{Duration, Instant};

use eframe::egui::{self, RichText, Vec2};

use crate::jobs::{self, JobState, MediaFile};
use crate::model::{
    self, library_entries, missing_output_count, queue_summary, queue_views, subtitle_summary,
    subtitle_views, JobView, RestartableJobs,
};
use crate::theme::{color, corner, hairline, margin, margin_xy, metric, radius, space, text, Tone};
use crate::widgets::{
    button, chip, empty_state, job_row, nav_item, setting_row, ButtonStyle, RowEvent,
};

const POLL_INTERVAL: Duration = Duration::from_millis(900);
/// A notice stays long enough to read, then clears itself so a stale message
/// never looks like current state.
const NOTICE_LIFETIME: Duration = Duration::from_secs(6);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    Queue,
    Library,
    Subtitles,
    Settings,
}

impl View {
    pub const ALL: [View; 4] = [View::Queue, View::Library, View::Subtitles, View::Settings];

    pub fn label(self) -> &'static str {
        match self {
            View::Queue => "다운로드",
            View::Library => "보관함",
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
    downloads_folder: Option<String>,
}

impl Default for ManagerApp {
    fn default() -> Self {
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
            downloads_folder: jobs::downloads_dir()
                .ok()
                .map(|path| path.to_string_lossy().into_owned()),
        }
    }
}

impl ManagerApp {
    pub fn new(context: &egui::Context) -> Self {
        install_fonts(context);
        install_style(context);
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
                self.restartable = jobs::restartable_ids(&jobs.iter().map(|job| job.job_id.clone()).collect::<Vec<_>>());
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
        self.media_files = jobs::read_media_files().unwrap_or_default();
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
            RowEvent::Pause(job_id) => match jobs::request_pause(&job_id) {
                Ok(()) => self.notify(
                    "일시정지를 요청했습니다. 받은 부분은 유지됩니다.",
                    NoticeTone::Info,
                ),
                Err(error) => self.notify(
                    format!("일시정지하지 못했습니다: {error}"),
                    NoticeTone::Error,
                ),
            },
            RowEvent::Resume(job_id) => {
                match jobs::restart_job(&job_id, "이어받기를 준비하는 중…") {
                    Ok(()) => self.notify("이어받기를 시작했습니다.", NoticeTone::Info),
                    Err(error) => self.notify(
                        format!("이어받기를 시작하지 못했습니다: {error}"),
                        NoticeTone::Error,
                    ),
                }
            }
            RowEvent::Retry(job_id) => {
                match jobs::restart_job(&job_id, "다시 시도하는 중…") {
                    Ok(()) => self.notify("다시 시도합니다.", NoticeTone::Info),
                    Err(error) => self.notify(
                        format!("다시 시도하지 못했습니다: {error}"),
                        NoticeTone::Error,
                    ),
                }
            }
            RowEvent::Play(job_id) => self.play(&job_id),
            RowEvent::Cancel(job_id) => match jobs::request_cancel(&job_id) {
                Ok(()) => self.notify("취소를 요청했습니다.", NoticeTone::Info),
                Err(error) => {
                    self.notify(format!("취소하지 못했습니다: {error}"), NoticeTone::Error)
                }
            },
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
        self.play_file(&file_name);
    }

    /// Plays a file by name from the download folder.
    fn play_file(&mut self, file_name: &str) {
        match jobs::play_file(file_name) {
            Ok(_) => self.notify(
                format!("{file_name} 재생을 시작했습니다."),
                NoticeTone::Info,
            ),
            Err(error) => {
                self.notify(format!("재생하지 못했습니다: {error}"), NoticeTone::Error)
            }
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
            Err(error) => self.notify(format!("폴더를 열지 못했습니다: {error}"), NoticeTone::Error),
        }
    }

    fn rail(&mut self, ui: &mut egui::Ui) {
        ui.spacing_mut().item_spacing = Vec2::new(0.0, space::X4);

        ui.add_space(space::X4);
        ui.label(
            RichText::new("Aura Media")
                .size(text::HEADING_SM)
                .strong()
                .color(color::TEXT_PRIMARY),
        );
        ui.label(
            RichText::new("Companion")
                .size(text::BODY_SM)
                .color(color::TEXT_MUTED),
        );
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
            None => (
                "작업 폴더 연결됨",
                self.downloads_folder
                    .clone()
                    .unwrap_or_else(|| "경로 확인 불가".to_string()),
                Tone::Neutral,
            ),
            Some(error) => ("작업 폴더를 읽지 못함", error.clone(), Tone::Danger),
        };

        egui::Frame::new()
            .fill(tone.background())
            .corner_radius(corner(radius::MD))
            .inner_margin(margin_xy(12.0, 10.0))
            .show(ui, |ui| {
                ui.spacing_mut().item_spacing.y = space::X2;
                ui.label(
                    RichText::new(title)
                        .size(text::LABEL_MD)
                        .color(tone.foreground()),
                );
                ui.label(
                    RichText::new(model::single_line(&detail, 90))
                        .size(text::BODY_SM)
                        .color(color::TEXT_MUTED),
                );
            });
    }

    fn header(&mut self, ui: &mut egui::Ui, summary: String, actions: &[(&str, ButtonStyle)]) -> Option<usize> {
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
                ui.label(
                    RichText::new(summary)
                        .size(text::BODY_MD)
                        .color(color::TEXT_MUTED),
                );
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                for (index, (label, style)) in actions.iter().enumerate().rev() {
                    if button(ui, label, *style, true).clicked() {
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
                            RichText::new(filter.label()).size(text::LABEL_MD).color(
                                if selected {
                                    color::TEXT_PRIMARY
                                } else {
                                    color::TEXT_SECONDARY
                                },
                            ),
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
            &[("새로 고침", ButtonStyle::Secondary), ("폴더 열기", ButtonStyle::Primary)],
        );
        match clicked {
            Some(0) => self.poll(true),
            Some(1) => self.open_folder(),
            _ => {}
        }

        self.filters(ui);

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

    /// Library is driven by the download folder, not by job history.
    ///
    /// A file the user moved or deleted disappears from the list, and a file
    /// dropped into the folder by hand shows up. Job state only supplies the
    /// title and media type when a record happens to match by file name.
    fn library_view(&mut self, ui: &mut egui::Ui) {
        let entries = library_entries(&self.media_files, &self.jobs);
        let missing = missing_output_count(&self.media_files, &self.jobs);

        let summary = if missing > 0 {
            format!("파일 {}건 · 폴더에 없는 완료 작업 {missing}건", entries.len())
        } else {
            format!("파일 {}건", entries.len())
        };
        let clicked = self.header(
            ui,
            summary,
            &[
                ("새로 고침", ButtonStyle::Secondary),
                ("폴더 열기", ButtonStyle::Primary),
            ],
        );
        match clicked {
            Some(0) => self.poll(true),
            Some(1) => self.open_folder(),
            _ => {}
        }

        let folder = self
            .downloads_folder
            .clone()
            .unwrap_or_else(|| "경로 확인 불가".to_string());
        ui.label(
            RichText::new(folder)
                .size(text::MONO_SM)
                .color(color::TEXT_MUTED),
        );

        ui.horizontal(|ui| {
            ui.label(
                RichText::new("검색")
                    .size(text::LABEL_SM)
                    .color(color::TEXT_MUTED),
            );
            ui.add(
                egui::TextEdit::singleline(&mut self.search)
                    .hint_text("제목 또는 파일명")
                    .desired_width(280.0),
            );
        });

        if missing > 0 {
            // Explain the gap rather than leaving a completed job unexplained.
            ui.label(
                RichText::new(format!(
                    "완료된 작업 {missing}건의 파일이 이 폴더에 없습니다. 옮겼거나 삭제된 것 같습니다."
                ))
                .size(text::BODY_SM)
                .color(color::TEXT_WARNING),
            );
        }

        let needle = self.search.trim().to_lowercase();
        let filtered: Vec<&model::LibraryEntry> = entries
            .iter()
            .filter(|entry| {
                needle.is_empty()
                    || entry.title.to_lowercase().contains(&needle)
                    || entry.file_name.to_lowercase().contains(&needle)
            })
            .collect();

        if filtered.is_empty() {
            empty_state(
                ui,
                if entries.is_empty() {
                    "다운로드 폴더에 미디어 파일이 없습니다."
                } else {
                    "검색 결과가 없습니다."
                },
            );
            return;
        }

        let mut play_target = None;
        let mut open_folder = false;
        for entry in filtered {
            egui::Frame::new()
                .fill(color::BG_SURFACE)
                .stroke(hairline(color::BORDER_SUBTLE))
                .corner_radius(corner(radius::LG))
                .inner_margin(margin_xy(16.0, 14.0))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.spacing_mut().item_spacing.y = space::X2;
                            ui.horizontal(|ui| {
                                ui.label(
                                    RichText::new(&entry.title)
                                        .size(text::HEADING_SM)
                                        .strong()
                                        .color(color::TEXT_PRIMARY),
                                );
                                chip(ui, &entry.type_label, Tone::Neutral, true);
                                if entry.job_id.is_none() {
                                    // Not from a companion download, so say so
                                    // instead of implying a job produced it.
                                    chip(ui, "기록 없음", Tone::Neutral, false);
                                }
                            });
                            let meta = [entry.size.clone(), Some(entry.file_name.clone())]
                                .into_iter()
                                .flatten()
                                .collect::<Vec<_>>()
                                .join(" · ");
                            ui.label(
                                RichText::new(meta)
                                    .size(text::BODY_SM)
                                    .color(color::TEXT_MUTED),
                            );
                        });
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if button(ui, "폴더 열기", ButtonStyle::Quiet, true).clicked() {
                                open_folder = true;
                            }
                            if button(ui, "재생", ButtonStyle::Secondary, true).clicked() {
                                play_target = Some(entry.file_name.clone());
                            }
                        });
                    });
                });
        }

        if let Some(file_name) = play_target {
            self.play_file(&file_name);
        }
        if open_folder {
            self.open_folder();
        }
    }

    fn subtitles_view(&mut self, ui: &mut egui::Ui) {
        let summary = subtitle_summary(&self.jobs);
        if self.header(ui, summary, &[("새로 고침", ButtonStyle::Secondary)]) == Some(0) {
            self.poll(true);
        }

        let views = subtitle_views(&self.jobs, &self.restartable);
        if views.is_empty() {
            empty_state(
                ui,
                "자막 작업은 브라우저 확장에서 시작합니다. 생성 결과와 실패 이유가 여기에 표시됩니다.",
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
        if self.header(ui, "컴패니언이 보고한 값".to_string(), &[("폴더 열기", ButtonStyle::Secondary)])
            == Some(0)
        {
            self.open_folder();
        }

        let jobs_path = jobs::jobs_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "경로 확인 불가".to_string());
        let folder = self
            .downloads_folder
            .clone()
            .unwrap_or_else(|| "경로 확인 불가".to_string());

        // Folders: the download folder is editable here, and the same value is
        // what the extension uses, so there is one destination rather than two.
        let mut pick_folder = false;
        Self::setting_group(ui, "폴더", |ui| {
            egui::Frame::new()
                .inner_margin(margin_xy(16.0, 14.0))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.spacing_mut().item_spacing.y = space::X2;
                            ui.label(
                                RichText::new("다운로드 폴더")
                                    .size(text::BODY_MD)
                                    .color(color::TEXT_PRIMARY),
                            );
                            ui.label(
                                RichText::new(&folder)
                                    .size(text::MONO_SM)
                                    .color(color::TEXT_MUTED),
                            );
                            ui.label(
                                RichText::new("확장과 앱이 같은 폴더를 씁니다.")
                                    .size(text::BODY_SM)
                                    .color(color::TEXT_MUTED),
                            );
                        });
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if button(ui, "변경", ButtonStyle::Secondary, true).clicked() {
                                pick_folder = true;
                            }
                        });
                    });
                });
            ui.add(egui::Separator::default().spacing(0.0));
            egui::Frame::new()
                .inner_margin(margin_xy(16.0, 14.0))
                .show(ui, |ui| {
                    setting_row(ui, "작업 상태 폴더", &jobs_path, true, None);
                });
        });
        if pick_folder {
            self.choose_folder();
        }

        Self::setting_group(ui, "동작 범위", |ui| {
            let rows: [(&str, &str, Option<(&str, Tone)>); 5] = [
                (
                    "일시정지 · 이어받기",
                    "받은 부분을 유지하고 같은 지점부터 계속합니다.",
                    Some(("사용 가능", Tone::Success)),
                ),
                (
                    "다시 시도",
                    "실패하거나 취소한 작업을 원래 요청으로 다시 실행합니다.",
                    Some(("사용 가능", Tone::Success)),
                ),
                (
                    "취소",
                    "진행 중이거나 일시정지한 작업을 정리합니다.",
                    Some(("사용 가능", Tone::Success)),
                ),
                (
                    "재생",
                    "완료된 파일을 시스템 기본 플레이어로 엽니다.",
                    Some(("외부 플레이어", Tone::Neutral)),
                ),
                (
                    "앱 내장 재생",
                    "창 안에서 바로 재생하는 엔진은 아직 붙지 않았습니다.",
                    Some(("준비 중", Tone::Warning)),
                ),
            ];
            for (index, (title, value, badge)) in rows.iter().enumerate() {
                if index > 0 {
                    ui.add(egui::Separator::default().spacing(0.0));
                }
                egui::Frame::new()
                    .inner_margin(margin_xy(16.0, 14.0))
                    .show(ui, |ui| {
                        setting_row(ui, title, value, false, *badge);
                    });
            }
        });
    }

    /// Card with a subtle caption header, matching the design's setting groups.
    fn setting_group(ui: &mut egui::Ui, title: &str, contents: impl FnOnce(&mut egui::Ui)) {
        egui::Frame::new()
            .fill(color::BG_SURFACE)
            .stroke(hairline(color::BORDER_SUBTLE))
            .corner_radius(corner(radius::LG))
            .show(ui, |ui| {
                egui::Frame::new()
                    .fill(color::BG_SUBTLE)
                    .inner_margin(margin_xy(16.0, 12.0))
                    .show(ui, |ui| {
                        ui.label(
                            RichText::new(title)
                                .size(text::LABEL_SM)
                                .color(color::TEXT_MUTED),
                        );
                    });
                contents(ui);
            });
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
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let context = ui.ctx().clone();
        self.poll(false);
        self.expire_notice();
        // Job state lives on disk and changes without user input, so the window
        // has to wake on its own rather than only on events.
        context.request_repaint_after(POLL_INTERVAL);

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

        egui::CentralPanel::default()
            .frame(
                egui::Frame::new()
                    .fill(color::BG_CANVAS)
                    .inner_margin(margin_xy(space::X28, space::X24)),
            )
            .show(ui, |ui| {
                ui.spacing_mut().item_spacing = Vec2::new(space::X12, space::X16);
                egui::ScrollArea::vertical()
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        ui.spacing_mut().item_spacing = Vec2::new(space::X12, space::X16);
                        self.notice_bar(ui);
                        match self.view {
                            View::Queue => self.queue_view(ui),
                            View::Library => self.library_view(ui),
                            View::Subtitles => self.subtitles_view(ui),
                            View::Settings => self.settings_view(ui),
                        }
                    });
            });
    }
}

/// Korean labels need a Korean-capable face. egui's bundled fonts do not cover
/// Hangul, so Malgun Gothic is loaded from the system and installed as a
/// fallback after the default proportional family.
fn install_fonts(context: &egui::Context) {
    use eframe::egui::{FontData, FontDefinitions, FontFamily};

    let candidates = [
        r"C:\Windows\Fonts\malgun.ttf",
        r"C:\Windows\Fonts\gulim.ttc",
    ];
    let Some(bytes) = candidates
        .iter()
        .find_map(|path| std::fs::read(path).ok())
    else {
        // Without a Korean face the labels would render as boxes. The window is
        // still usable, so this degrades rather than refusing to start.
        return;
    };

    let mut fonts = FontDefinitions::default();
    fonts.font_data.insert(
        "korean".to_owned(),
        std::sync::Arc::new(FontData::from_owned(bytes)),
    );
    for family in [FontFamily::Proportional, FontFamily::Monospace] {
        fonts
            .families
            .entry(family)
            .or_default()
            .push("korean".to_owned());
    }
    context.set_fonts(fonts);
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
}
