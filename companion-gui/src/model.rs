//! View models: everything the window shows, derived from `JobState`.
//!
//! Kept free of egui so the mapping rules are testable without a window. This
//! mirrors the JS view-model layer that was written for the HTML prototype, so
//! both surfaces label the same state identically.

use crate::jobs::{JobState, MediaFile};
use crate::theme::Tone;

const TERMINAL: [&str; 3] = ["completed", "failed", "cancelled"];
const PREPARING: [&str; 3] = ["created", "preparing", "submitting"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobKind {
    Download,
    Subtitle,
}

/// Actions the protocol can actually perform.
///
/// There is no retry: the host has no retry command and re-sending a download
/// with a used job id is not a supported path. There is no pause either, only
/// cancel. Reveal is folder-level because the host has no per-file reveal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Pause,
    Resume,
    Retry,
    Play,
    Cancel,
    OpenFolder,
}

impl Action {
    pub fn label(self) -> &'static str {
        match self {
            Action::Pause => "일시정지",
            Action::Resume => "이어받기",
            Action::Retry => "다시 시도",
            Action::Play => "재생",
            Action::Cancel => "취소",
            Action::OpenFolder => "폴더 열기",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobView {
    pub id: String,
    pub kind: JobKind,
    pub title: String,
    pub status_label: &'static str,
    pub tone: Tone,
    pub detail: Option<String>,
    pub type_label: String,
    pub percent: Option<u8>,
    pub transfer: Option<String>,
    pub language: Option<String>,
    pub file_name: Option<String>,
    pub active: bool,
    pub paused: bool,
    pub actions: Vec<Action>,
    pub updated_at: u64,
}

pub fn job_kind(job: &JobState) -> JobKind {
    if job.job_type.as_deref() == Some("subtitle") {
        JobKind::Subtitle
    } else {
        JobKind::Download
    }
}

/// Paused is its own state: the runner has stopped but the partial file is kept,
/// so the job is neither transferring nor finished.
pub fn is_paused(job: &JobState) -> bool {
    job.status.eq_ignore_ascii_case("paused")
}

/// True only while the job is actually working. A paused job is excluded, so
/// the queue summary does not count it as in progress.
pub fn is_active(job: &JobState) -> bool {
    let status = job.status.to_ascii_lowercase();
    !status.is_empty() && !TERMINAL.contains(&status.as_str()) && status != "paused"
}

/// Anything that has stopped for good. Paused is not included: it can resume.
#[cfg(test)]
pub fn is_terminal(job: &JobState) -> bool {
    TERMINAL.contains(&job.status.to_ascii_lowercase().as_str())
}

/// Never claims success for a status it does not recognize.
pub fn status_view(job: &JobState) -> (&'static str, Tone) {
    let status = job.status.to_ascii_lowercase();
    let subtitle = job_kind(job) == JobKind::Subtitle;
    match status.as_str() {
        "completed" => ("완료", Tone::Success),
        "failed" => ("실패", Tone::Danger),
        "cancelled" => ("취소", Tone::Warning),
        "paused" => ("일시정지", Tone::Warning),
        "running" if subtitle => ("생성 중", Tone::Neutral),
        "running" => ("다운로드 중", Tone::Neutral),
        "queued" => ("대기", Tone::Neutral),
        other if PREPARING.contains(&other) => ("준비", Tone::Neutral),
        _ => ("알 수 없음", Tone::Neutral),
    }
}

/// Decimal units, matching what the host and the HTML prototype report. A
/// trailing `.0` is dropped so a round size reads `320 MB`, not `320.0 MB`.
pub fn format_bytes(value: Option<u64>) -> Option<String> {
    let value = value? as f64;
    if value < 1000.0 {
        return Some(format!("{} B", value.round() as u64));
    }
    let units = ["KB", "MB", "GB", "TB"];
    let mut scaled = value / 1000.0;
    let mut unit = 0;
    while scaled >= 1000.0 && unit < units.len() - 1 {
        scaled /= 1000.0;
        unit += 1;
    }
    let text = format!("{scaled:.1}");
    let trimmed = text.strip_suffix(".0").unwrap_or(&text).to_string();
    Some(format!("{trimmed} {}", units[unit]))
}

pub fn progress_percent(job: &JobState) -> Option<u8> {
    if let Some(progress) = job.progress {
        return Some(progress.min(100));
    }
    match (job.completed, job.total) {
        (Some(completed), Some(total)) if total > 0 => {
            let ratio = (completed as f64 / total as f64) * 100.0;
            Some(ratio.round().clamp(0.0, 100.0) as u8)
        }
        _ => None,
    }
}

pub fn transfer_label(job: &JobState) -> Option<String> {
    match (format_bytes(job.completed), format_bytes(job.total)) {
        (Some(done), Some(total)) => Some(format!("{done} / {total}")),
        (Some(done), None) => Some(done),
        _ => progress_percent(job).map(|percent| format!("{percent}%")),
    }
}

pub fn media_type_label(job: &JobState) -> String {
    if job_kind(job) == JobKind::Subtitle {
        return job
            .output_format
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("VTT")
            .to_ascii_uppercase();
    }
    if let Some(kind) = job
        .input_kind
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return kind.to_ascii_uppercase();
    }
    job.file_name
        .as_deref()
        .and_then(|name| name.rsplit_once('.'))
        .map(|(_, extension)| extension.to_ascii_uppercase())
        .unwrap_or_else(|| "MEDIA".to_string())
}

pub fn job_title(job: &JobState) -> String {
    if let Some(title) = job
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return title.to_string();
    }
    if let Some(name) = job
        .file_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return name.to_string();
    }
    "제목 확인 중".to_string()
}

pub fn language_pair(job: &JobState) -> Option<String> {
    let from = job.source_language.as_deref().unwrap_or_default();
    let to = job.target_language.as_deref().unwrap_or_default();
    match (from.is_empty(), to.is_empty()) {
        (false, false) if from != to => Some(format!("{from} → {to}")),
        (_, false) => Some(to.to_string()),
        (false, true) => Some(from.to_string()),
        _ => None,
    }
}

/// Collapses control characters and bounds the length so a long yt-dlp error
/// cannot stretch a row without limit.
pub fn single_line(value: &str, maximum: usize) -> String {
    let mut text = String::new();
    let mut space_pending = false;
    for character in value.chars() {
        if character.is_control() {
            space_pending = !text.is_empty();
            continue;
        }
        if space_pending {
            text.push(' ');
            space_pending = false;
        }
        text.push(character);
        if text.chars().count() >= maximum {
            text.push('…');
            break;
        }
    }
    text.trim().to_string()
}

/// Prefers the host's own text so the window never invents a reason the backend
/// did not report. The error only wins for a failed job, otherwise a stale
/// error string could leak into a running row.
pub fn detail_line(job: &JobState) -> Option<String> {
    let (_, tone) = status_view(job);
    if tone == Tone::Danger {
        if let Some(error) = job
            .error
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(single_line(error, 200));
        }
    }
    let status_text = job.status_text.trim();
    if !status_text.is_empty() {
        return Some(single_line(status_text, 200));
    }
    job.phase
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|phase| single_line(phase, 200))
}

/// Actions offered for a job, in the order they are drawn.
///
/// Two facts come from outside the job record because the record can be stale:
///
/// - `restartable`: the `.request.json` still exists, so resume and retry have
///   something to replay.
/// - `file_present`: the recorded output is still in the download folder, so
///   playing it will actually work.
///
/// A job that claims success but whose file was moved or deleted therefore shows
/// no play button rather than one that fails.
pub fn available_actions(job: &JobState, restartable: bool, file_present: bool) -> Vec<Action> {
    if is_paused(job) {
        let mut actions = Vec::new();
        if restartable {
            actions.push(Action::Resume);
        }
        actions.push(Action::Cancel);
        return actions;
    }

    if is_active(job) {
        // Pause only applies to a transfer in flight. A queued job has nothing
        // partial to keep, and subtitle work runs remotely with no resume point.
        let mut actions = Vec::new();
        if job.status.eq_ignore_ascii_case("running") && job_kind(job) == JobKind::Download {
            actions.push(Action::Pause);
        }
        actions.push(Action::Cancel);
        return actions;
    }

    let (_, tone) = status_view(job);
    if tone == Tone::Success && file_present {
        let mut actions = Vec::new();
        // A subtitle track is a text file, so playing it makes no sense.
        if job_kind(job) == JobKind::Download {
            actions.push(Action::Play);
        }
        actions.push(Action::OpenFolder);
        return actions;
    }

    // Failed or cancelled: offer another attempt when the record survives.
    if restartable && matches!(tone, Tone::Danger | Tone::Warning) {
        return vec![Action::Retry];
    }
    Vec::new()
}

pub fn to_view(job: &JobState, restartable: bool, file_present: bool) -> JobView {
    let (status_label, tone) = status_view(job);
    JobView {
        id: job.job_id.clone(),
        kind: job_kind(job),
        title: single_line(&job_title(job), 120),
        status_label,
        tone,
        detail: detail_line(job),
        type_label: media_type_label(job),
        percent: progress_percent(job),
        transfer: transfer_label(job),
        language: language_pair(job),
        file_name: job.file_name.clone(),
        active: is_active(job),
        paused: is_paused(job),
        actions: available_actions(job, restartable, file_present),
        updated_at: job.updated_at,
    }
}

/// Job ids whose `.request.json` still exists, so resume and retry can work.
pub type RestartableJobs = std::collections::HashSet<String>;

fn restartable(job: &JobState, restartable_ids: &RestartableJobs) -> bool {
    restartable_ids.contains(&job.job_id)
}

/// Whether a job's recorded output is present in the folder listing.
///
/// A job with no recorded file is treated as absent, which is what stops a
/// still-running job from offering playback.
fn output_present(job: &JobState, files: &[MediaFile]) -> bool {
    job.file_name
        .as_deref()
        .map(str::trim)
        .is_some_and(|name| !name.is_empty() && files.iter().any(|file| file.file_name == name))
}

pub fn queue_views(
    jobs: &[JobState],
    restartable_ids: &RestartableJobs,
    files: &[MediaFile],
) -> Vec<JobView> {
    jobs.iter()
        .filter(|job| job_kind(job) == JobKind::Download)
        .map(|job| {
            to_view(
                job,
                restartable(job, restartable_ids),
                output_present(job, files),
            )
        })
        .collect()
}

/// Subtitle output is a sidecar text file, not media, so the folder listing does
/// not apply. A recorded file name is treated as present: the Subtitles view
/// offers only cancel and folder actions, never playback.
pub fn subtitle_views(jobs: &[JobState], restartable_ids: &RestartableJobs) -> Vec<JobView> {
    jobs.iter()
        .filter(|job| job_kind(job) == JobKind::Subtitle)
        .map(|job| {
            let has_file = job
                .file_name
                .as_deref()
                .map(str::trim)
                .is_some_and(|name| !name.is_empty());
            to_view(job, restartable(job, restartable_ids), has_file)
        })
        .collect()
}


pub fn queue_summary(jobs: &[JobState]) -> String {
    let downloads: Vec<&JobState> = jobs
        .iter()
        .filter(|job| job_kind(job) == JobKind::Download)
        .collect();
    let active = downloads.iter().filter(|job| is_active(job)).count();
    let paused = downloads.iter().filter(|job| is_paused(job)).count();
    let failed = downloads
        .iter()
        .filter(|job| status_view(job).1 == Tone::Danger)
        .count();
    let mut parts = vec![format!("진행 {active}건")];
    if paused > 0 {
        parts.push(format!("일시정지 {paused}건"));
    }
    if failed > 0 {
        parts.push(format!("실패 {failed}건"));
    }
    parts.join(" · ")
}

pub fn subtitle_summary(jobs: &[JobState]) -> String {
    let list: Vec<&JobState> = jobs
        .iter()
        .filter(|job| job_kind(job) == JobKind::Subtitle)
        .collect();
    let running = list.iter().filter(|job| is_active(job)).count();
    let ready = list
        .iter()
        .filter(|job| status_view(job).1 == Tone::Success)
        .count();
    format!("생성 중 {running}건 · 완료 {ready}건")
}

/// One row in the library: a file that exists on disk, with the job that
/// produced it attached when one is known.
///
/// The folder is the source of truth. A job whose file was moved or deleted is
/// not listed, and a file the companion never recorded still is, because the
/// user can drop a file into the folder or keep one from an earlier install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryEntry {
    pub file_name: String,
    pub title: String,
    pub type_label: String,
    pub size: Option<String>,
    /// `None` when no job state matches the file.
    pub job_id: Option<String>,
    pub modified_at: u64,
}

fn extension_label(file_name: &str) -> String {
    file_name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_uppercase())
        .unwrap_or_else(|| "MEDIA".to_string())
}

/// Joins the download folder listing with job state.
///
/// Matching is by file name because that is the only identifier the host records
/// for output. The on-disk size wins over the job's byte count: the file is the
/// artifact, and a mismatch means the job record is stale.
pub fn library_entries(files: &[MediaFile], jobs: &[JobState]) -> Vec<LibraryEntry> {
    files
        .iter()
        .map(|file| {
            let job = jobs.iter().find(|job| {
                job.file_name
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|name| name == file.file_name)
            });
            LibraryEntry {
                file_name: file.file_name.clone(),
                title: job
                    .map(job_title)
                    .filter(|title| title != "제목 확인 중")
                    .unwrap_or_else(|| file.file_name.clone()),
                type_label: job
                    .map(media_type_label)
                    .filter(|label| label != "MEDIA")
                    .unwrap_or_else(|| extension_label(&file.file_name)),
                size: format_bytes(Some(file.size)),
                job_id: job.map(|job| job.job_id.clone()),
                modified_at: file.modified_at,
            }
        })
        .collect()
}

/// Completed jobs whose output is no longer in the folder.
///
/// Surfaced so a moved or deleted file is explained rather than silently absent
/// from a list the user expects it in.
pub fn missing_output_count(files: &[MediaFile], jobs: &[JobState]) -> usize {
    jobs.iter()
        .filter(|job| {
            job_kind(job) == JobKind::Download
                && job.status.eq_ignore_ascii_case("completed")
                && job
                    .file_name
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|name| {
                        !name.is_empty() && !files.iter().any(|file| file.file_name == name)
                    })
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(id: &str, status: &str) -> JobState {
        JobState {
            job_id: id.to_string(),
            status: status.to_string(),
            ..JobState::default()
        }
    }

    #[test]
    fn every_host_status_maps_to_a_tone() {
        assert_eq!(status_view(&job("a", "queued")).1, Tone::Neutral);
        assert_eq!(status_view(&job("a", "running")).1, Tone::Neutral);
        assert_eq!(status_view(&job("a", "completed")).1, Tone::Success);
        assert_eq!(status_view(&job("a", "failed")).1, Tone::Danger);
        assert_eq!(status_view(&job("a", "cancelled")).1, Tone::Warning);
        for status in ["created", "preparing", "submitting"] {
            assert_eq!(status_view(&job("a", status)).0, "준비");
        }
    }

    #[test]
    fn an_unknown_status_never_reads_as_success() {
        let view = status_view(&job("a", "teleporting"));
        assert_eq!(view.0, "알 수 없음");
        assert_eq!(view.1, Tone::Neutral);
        assert_eq!(status_view(&job("a", "")).1, Tone::Neutral);
    }

    #[test]
    fn a_running_subtitle_job_reads_as_generating() {
        let mut state = job("a", "running");
        state.job_type = Some("subtitle".into());
        assert_eq!(status_view(&state).0, "생성 중");
    }

    #[test]
    fn byte_formatting_uses_decimal_units_and_drops_a_trailing_zero() {
        assert_eq!(format_bytes(Some(0)).as_deref(), Some("0 B"));
        assert_eq!(format_bytes(Some(999)).as_deref(), Some("999 B"));
        assert_eq!(format_bytes(Some(1000)).as_deref(), Some("1 KB"));
        assert_eq!(format_bytes(Some(38_100_000)).as_deref(), Some("38.1 MB"));
        assert_eq!(format_bytes(Some(320_000_000)).as_deref(), Some("320 MB"));
        assert_eq!(format_bytes(Some(1_400_000_000)).as_deref(), Some("1.4 GB"));
        assert_eq!(format_bytes(None), None);
    }

    #[test]
    fn progress_prefers_the_host_percentage_then_falls_back_to_bytes() {
        let mut state = job("a", "running");
        state.progress = Some(38);
        assert_eq!(progress_percent(&state), Some(38));

        let mut bytes = job("b", "running");
        bytes.completed = Some(50);
        bytes.total = Some(200);
        assert_eq!(progress_percent(&bytes), Some(25));

        let mut zero = job("c", "running");
        zero.completed = Some(50);
        zero.total = Some(0);
        assert_eq!(progress_percent(&zero), None);

        assert_eq!(progress_percent(&job("d", "running")), None);

        let mut over = job("e", "running");
        over.progress = Some(250);
        assert_eq!(progress_percent(&over), Some(100));
    }

    #[test]
    fn only_unfinished_jobs_offer_cancel() {
        // A running download can pause; a queued one has nothing partial to keep.
        assert_eq!(
            available_actions(&job("a", "running"), true, false),
            vec![Action::Pause, Action::Cancel]
        );
        assert_eq!(
            available_actions(&job("a", "queued"), true, false),
            vec![Action::Cancel]
        );

        let mut done = job("a", "completed");
        done.file_name = Some("clip.mp4".into());
        assert_eq!(
            available_actions(&done, false, true),
            vec![Action::Play, Action::OpenFolder]
        );

        assert!(available_actions(&job("a", "completed"), true, false).is_empty());
    }

    #[test]
    fn a_completed_job_whose_file_left_the_folder_offers_nothing() {
        // The record says success, but the artifact is gone, so playing it would
        // fail. Better to offer nothing than a button that cannot work.
        let mut done = job("a", "completed");
        done.file_name = Some("moved-away.mp4".into());
        assert!(available_actions(&done, true, false).is_empty());
    }

    #[test]
    fn a_paused_job_offers_resume_then_cancel() {
        let paused = job("a", "paused");
        assert!(is_paused(&paused));
        assert!(!is_active(&paused), "paused must not count as in progress");
        assert!(!is_terminal(&paused), "paused can still resume");
        assert_eq!(status_view(&paused), ("일시정지", Tone::Warning));
        assert_eq!(
            available_actions(&paused, true, false),
            vec![Action::Resume, Action::Cancel]
        );
    }

    #[test]
    fn a_failed_or_cancelled_job_offers_retry_only_when_the_record_survives() {
        for status in ["failed", "cancelled"] {
            assert_eq!(
                available_actions(&job("a", status), true, false),
                vec![Action::Retry],
                "status {status} should offer retry"
            );
            assert!(
                available_actions(&job("a", status), false, false).is_empty(),
                "status {status} must not offer retry without a request record"
            );
        }
    }

    #[test]
    fn a_paused_job_without_its_record_still_offers_cancel() {
        // Losing the request record removes the restart path, not the ability to
        // give up on the job.
        assert_eq!(
            available_actions(&job("a", "paused"), false, false),
            vec![Action::Cancel]
        );
    }

    #[test]
    fn a_subtitle_job_offers_neither_pause_nor_play() {
        let mut running = job("s", "running");
        running.job_type = Some("subtitle".into());
        assert_eq!(available_actions(&running, true, false), vec![Action::Cancel]);

        let mut done = job("s2", "completed");
        done.job_type = Some("subtitle".into());
        done.file_name = Some("clip.ko.vtt".into());
        assert_eq!(available_actions(&done, false, true), vec![Action::OpenFolder]);
    }

    #[test]
    fn every_action_has_a_korean_label() {
        for action in [
            Action::Pause,
            Action::Resume,
            Action::Retry,
            Action::Play,
            Action::Cancel,
            Action::OpenFolder,
        ] {
            assert!(action.label().chars().any(|c| !c.is_ascii()));
        }
    }

    #[test]
    fn a_stale_error_never_leaks_into_a_running_row() {
        let mut running = job("a", "running");
        running.status_text = "다운로드 중".into();
        running.error = Some("이전 실패".into());
        assert_eq!(detail_line(&running).as_deref(), Some("다운로드 중"));

        let mut failed = job("b", "failed");
        failed.status_text = "실패했습니다".into();
        failed.error = Some("yt-dlp exit 1".into());
        assert_eq!(detail_line(&failed).as_deref(), Some("yt-dlp exit 1"));
    }

    #[test]
    fn detail_falls_back_to_phase_then_nothing() {
        let mut phase = job("a", "running");
        phase.phase = Some("transcribe".into());
        assert_eq!(detail_line(&phase).as_deref(), Some("transcribe"));
        assert_eq!(detail_line(&job("b", "running")), None);
    }

    #[test]
    fn text_is_collapsed_to_one_line_and_bounded() {
        assert_eq!(single_line("line one\r\nline two", 200), "line one line two");
        let long = single_line(&"x".repeat(400), 50);
        assert!(long.chars().count() <= 51, "length {}", long.chars().count());
        assert!(long.ends_with('…'));
    }

    #[test]
    fn title_falls_back_through_file_name_to_a_placeholder() {
        let mut titled = job("a", "running");
        titled.title = Some("  ticket show ".into());
        assert_eq!(job_title(&titled), "ticket show");

        let mut named = job("b", "completed");
        named.file_name = Some("clip.mp4".into());
        assert_eq!(job_title(&named), "clip.mp4");

        assert_eq!(job_title(&job("c", "queued")), "제목 확인 중");
    }

    #[test]
    fn media_type_prefers_host_fields_over_the_file_extension() {
        let mut hls = job("a", "running");
        hls.input_kind = Some("hls".into());
        assert_eq!(media_type_label(&hls), "HLS");

        let mut named = job("b", "completed");
        named.file_name = Some("clip.mp4".into());
        assert_eq!(media_type_label(&named), "MP4");

        assert_eq!(media_type_label(&job("c", "queued")), "MEDIA");

        let mut subtitle = job("d", "running");
        subtitle.job_type = Some("subtitle".into());
        assert_eq!(media_type_label(&subtitle), "VTT");
    }

    #[test]
    fn language_pair_collapses_when_source_matches_target() {
        let mut pair = job("a", "running");
        pair.source_language = Some("en".into());
        pair.target_language = Some("ko".into());
        assert_eq!(language_pair(&pair).as_deref(), Some("en → ko"));

        let mut same = job("b", "running");
        same.source_language = Some("ko".into());
        same.target_language = Some("ko".into());
        assert_eq!(language_pair(&same).as_deref(), Some("ko"));

        assert_eq!(language_pair(&job("c", "running")), None);
    }

    #[test]
    fn the_library_lists_what_is_in_the_folder_not_what_jobs_claim() {
        let files = vec![
            MediaFile {
                file_name: "recorded.mp4".into(),
                size: 320_000_000,
                modified_at: 20,
            },
            MediaFile {
                file_name: "dropped-by-hand.mkv".into(),
                size: 1_000,
                modified_at: 10,
            },
        ];

        let mut recorded = job("a", "completed");
        recorded.file_name = Some("recorded.mp4".into());
        recorded.title = Some("ticket show".into());
        recorded.input_kind = Some("hls".into());

        // Completed, but its file is not in the folder any more.
        let mut moved_away = job("b", "completed");
        moved_away.file_name = Some("gone.mp4".into());

        let jobs = vec![recorded, moved_away];
        let entries = library_entries(&files, &jobs);

        assert_eq!(entries.len(), 2, "the folder decides the list");
        assert_eq!(entries[0].file_name, "recorded.mp4");
        assert_eq!(entries[0].title, "ticket show", "job title is used when known");
        assert_eq!(entries[0].type_label, "HLS");
        assert_eq!(entries[0].job_id.as_deref(), Some("a"));
        assert_eq!(entries[0].size.as_deref(), Some("320 MB"));

        // A file with no matching job still appears, labelled from its name.
        assert_eq!(entries[1].file_name, "dropped-by-hand.mkv");
        assert_eq!(entries[1].title, "dropped-by-hand.mkv");
        assert_eq!(entries[1].type_label, "MKV");
        assert_eq!(entries[1].job_id, None);

        assert!(
            !entries.iter().any(|entry| entry.file_name == "gone.mp4"),
            "a job whose file left the folder must not be listed"
        );
    }

    #[test]
    fn the_on_disk_size_wins_over_a_stale_job_byte_count() {
        let files = vec![MediaFile {
            file_name: "clip.mp4".into(),
            size: 1_000,
            modified_at: 5,
        }];
        let mut stale = job("a", "completed");
        stale.file_name = Some("clip.mp4".into());
        stale.total = Some(999_000_000);

        let entries = library_entries(&files, &[stale]);
        assert_eq!(entries[0].size.as_deref(), Some("1 KB"));
    }

    #[test]
    fn missing_output_counts_only_completed_downloads_whose_file_is_gone() {
        let files = vec![MediaFile {
            file_name: "here.mp4".into(),
            size: 10,
            modified_at: 1,
        }];

        let mut present = job("a", "completed");
        present.file_name = Some("here.mp4".into());

        let mut gone = job("b", "completed");
        gone.file_name = Some("gone.mp4".into());

        // Not counted: still running, no file recorded, or a subtitle track.
        let mut running = job("c", "running");
        running.file_name = Some("partial.mp4".into());
        let no_file = job("d", "completed");
        let mut subtitle = job("e", "completed");
        subtitle.job_type = Some("subtitle".into());
        subtitle.file_name = Some("clip.ko.vtt".into());

        let jobs = vec![present, gone, running, no_file, subtitle];
        assert_eq!(missing_output_count(&files, &jobs), 1);
        assert_eq!(missing_output_count(&files, &[]), 0);
    }

    #[test]
    fn an_empty_folder_yields_an_empty_library_even_with_completed_jobs() {
        let mut done = job("a", "completed");
        done.file_name = Some("clip.mp4".into());
        assert!(library_entries(&[], &[done.clone()]).is_empty());
        assert_eq!(missing_output_count(&[], &[done]), 1);
    }

    #[test]
    fn summaries_count_download_and_subtitle_jobs_separately() {
        let mut running = job("a", "running");
        running.status_text = "x".into();
        let failed = job("b", "failed");
        let mut subtitle_running = job("c", "running");
        subtitle_running.job_type = Some("subtitle".into());
        let mut subtitle_done = job("d", "completed");
        subtitle_done.job_type = Some("subtitle".into());

        let jobs = vec![running, failed, subtitle_running, subtitle_done];
        assert_eq!(queue_summary(&jobs), "진행 1건 · 실패 1건");
        assert_eq!(subtitle_summary(&jobs), "생성 중 1건 · 완료 1건");
        assert_eq!(queue_summary(&[]), "진행 0건");
    }

    #[test]
    fn the_summary_reports_paused_jobs_separately_from_active_ones() {
        let jobs = vec![job("a", "running"), job("b", "paused"), job("c", "failed")];
        assert_eq!(queue_summary(&jobs), "진행 1건 · 일시정지 1건 · 실패 1건");

        // A paused job must not inflate the active count.
        assert_eq!(queue_summary(&[job("only", "paused")]), "진행 0건 · 일시정지 1건");
    }

    #[test]
    fn queue_and_subtitle_views_partition_the_list() {
        let mut subtitle = job("s", "running");
        subtitle.job_type = Some("subtitle".into());
        let jobs = vec![job("d", "running"), subtitle];
        let none = RestartableJobs::new();
        assert_eq!(queue_views(&jobs, &none, &[]).len(), 1);
        assert_eq!(subtitle_views(&jobs, &none).len(), 1);
        assert_eq!(
            queue_views(&jobs, &none, &[]).len() + subtitle_views(&jobs, &none).len(),
            jobs.len()
        );
    }

    #[test]
    fn only_jobs_with_a_surviving_record_get_a_restart_button() {
        let jobs = vec![job("keeps-record", "failed"), job("lost-record", "failed")];
        let mut restartable = RestartableJobs::new();
        restartable.insert("keeps-record".to_string());

        let views = queue_views(&jobs, &restartable, &[]);
        let with_record = views.iter().find(|view| view.id == "keeps-record").unwrap();
        let without = views.iter().find(|view| view.id == "lost-record").unwrap();
        assert_eq!(with_record.actions, vec![Action::Retry]);
        assert!(without.actions.is_empty());
    }

    #[test]
    fn playback_appears_only_when_the_file_is_in_the_folder() {
        let mut done = job("done", "completed");
        done.file_name = Some("clip.mp4".into());
        let jobs = vec![done];
        let none = RestartableJobs::new();

        let present = vec![MediaFile {
            file_name: "clip.mp4".into(),
            size: 10,
            modified_at: 1,
        }];
        assert_eq!(
            queue_views(&jobs, &none, &present)[0].actions,
            vec![Action::Play, Action::OpenFolder]
        );

        // Same job record, file no longer on disk.
        assert!(queue_views(&jobs, &none, &[])[0].actions.is_empty());
    }
}
