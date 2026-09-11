//! UI-neutral formatting derived from the shared host `JobState`.

use crate::jobs::{JobState, MediaFile};
use serde::Serialize;

const TERMINAL: [&str; 3] = ["completed", "failed", "cancelled"];
const PREPARING: [&str; 3] = ["created", "preparing", "submitting"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    Download,
    Subtitle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Pause,
    Resume,
    Retry,
    Play,
    Cancel,
    OpenFolder,
}

impl Action {
    pub fn code(self) -> &'static str {
        match self {
            Self::Pause => "pause",
            Self::Resume => "resume",
            Self::Retry => "retry",
            Self::Play => "play",
            Self::Cancel => "cancel",
            Self::OpenFolder => "openFolder",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    Neutral,
    Success,
    Danger,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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

pub fn is_paused(job: &JobState) -> bool {
    job.status.eq_ignore_ascii_case("paused")
}

pub fn is_active(job: &JobState) -> bool {
    let status = job.status.to_ascii_lowercase();
    !status.is_empty() && !TERMINAL.contains(&status.as_str()) && status != "paused"
}

pub fn is_terminal(job: &JobState) -> bool {
    TERMINAL.contains(&job.status.to_ascii_lowercase().as_str())
}

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
        value if PREPARING.contains(&value) => ("준비", Tone::Neutral),
        _ => ("알 수 없음", Tone::Neutral),
    }
}

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
    let trimmed = text.strip_suffix(".0").unwrap_or(&text);
    Some(format!("{trimmed} {}", units[unit]))
}

pub fn media_usage_label(bytes: u64) -> String {
    format_bytes(Some(bytes)).unwrap_or_else(|| "0 B".to_string())
}

pub fn compact_home_path(path: &str, home: Option<&str>) -> String {
    let normalized = path.replace('/', "\\");
    let Some(home) = home.filter(|value| !value.is_empty()) else {
        return normalized;
    };
    let home = home.replace('/', "\\").trim_end_matches('\\').to_string();
    if home.is_empty() {
        return normalized;
    }
    let stripped = normalized
        .strip_prefix(&home)
        .or_else(|| normalized.strip_prefix(&format!("{home}\\")));
    stripped.map_or_else(
        || normalized.clone(),
        |rest| rest.trim_start_matches('\\').to_string(),
    )
}

pub fn progress_percent(job: &JobState) -> Option<u8> {
    if let Some(progress) = job.progress {
        return Some(progress.min(100));
    }
    match (job.completed, job.total) {
        (Some(completed), Some(total)) if total > 0 => Some(
            ((completed as f64 / total as f64) * 100.0)
                .round()
                .clamp(0.0, 100.0) as u8,
        ),
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

pub fn single_line(value: &str, maximum: usize) -> String {
    if maximum == 0 {
        return String::new();
    }
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
        let mut actions = Vec::new();
        if restartable
            && job.status.eq_ignore_ascii_case("running")
            && job_kind(job) == JobKind::Download
        {
            actions.push(Action::Pause);
        }
        actions.push(Action::Cancel);
        return actions;
    }
    let (_, tone) = status_view(job);
    if tone == Tone::Success && file_present {
        let mut actions = Vec::new();
        if job_kind(job) == JobKind::Download {
            actions.push(Action::Play);
        }
        actions.push(Action::OpenFolder);
        return actions;
    }
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

pub type RestartableJobs = std::collections::HashSet<String>;

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
                restartable_ids.contains(&job.job_id),
                output_present(job, files),
            )
        })
        .collect()
}

pub fn subtitle_views(jobs: &[JobState], restartable_ids: &RestartableJobs) -> Vec<JobView> {
    jobs.iter()
        .filter(|job| job_kind(job) == JobKind::Subtitle)
        .map(|job| {
            let has_file = job
                .file_name
                .as_deref()
                .map(str::trim)
                .is_some_and(|name| !name.is_empty());
            to_view(job, restartable_ids.contains(&job.job_id), has_file)
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub file_name: String,
    pub title: String,
    pub type_label: String,
    pub size: Option<String>,
    pub job_id: Option<String>,
    pub thumbnail_key: String,
    pub modified_at: u64,
}

pub fn library_entries(files: &[MediaFile], jobs: &[JobState]) -> Vec<LibraryEntry> {
    files
        .iter()
        .map(|file| {
            let job = jobs.iter().find(|job| {
                job.file_name.as_deref().map(str::trim) == Some(file.file_name.as_str())
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
                    .unwrap_or_else(|| {
                        file.file_name
                            .rsplit_once('.')
                            .map(|(_, extension)| extension.to_ascii_uppercase())
                            .unwrap_or_else(|| "MEDIA".to_string())
                    }),
                size: format_bytes(Some(file.size)),
                job_id: job.map(|job| job.job_id.clone()),
                thumbnail_key: format!("{}:{}:{}", file.file_name, file.size, file.modified_at),
                modified_at: file.modified_at,
            }
        })
        .collect()
}

pub fn missing_output_count(files: &[MediaFile], jobs: &[JobState]) -> usize {
    jobs.iter()
        .filter(|job| {
            job_kind(job) == JobKind::Download
                && job.status.eq_ignore_ascii_case("completed")
                && job.file_name.as_deref().map(str::trim).is_some_and(|name| {
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
            job_id: id.into(),
            status: status.into(),
            ..JobState::default()
        }
    }

    #[test]
    fn formatting_preserves_behavior_needed_by_rows_and_dtos() {
        assert_eq!(status_view(&job("a", "completed")), ("완료", Tone::Success));
        assert_eq!(status_view(&job("a", "unknown")).0, "알 수 없음");
        assert_eq!(format_bytes(Some(38_100_000)).as_deref(), Some("38.1 MB"));
        assert_eq!(format_bytes(Some(320_000_000)).as_deref(), Some("320 MB"));
        assert_eq!(
            single_line("line one\r\nline two", 200),
            "line one line two"
        );
    }

    #[test]
    fn dto_view_does_not_offer_playback_for_missing_files() {
        let mut done = job("done", "completed");
        done.file_name = Some("clip.mp4".into());
        let view = to_view(&done, false, false);
        assert!(view.actions.is_empty());
    }
}
