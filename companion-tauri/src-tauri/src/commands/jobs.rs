use super::dto::CommandError;
use crate::{jobs, model, subtitles};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobIdRequest {
    pub job_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDto {
    pub job_id: String,
    pub job_type: Option<String>,
    pub request_id: Option<String>,
    pub candidate_id: Option<String>,
    pub input_kind: Option<String>,
    pub output_format: Option<String>,
    pub status: String,
    pub status_text: String,
    pub status_label: &'static str,
    pub tone: model::Tone,
    pub title: String,
    pub detail: Option<String>,
    pub progress: Option<u8>,
    pub completed: Option<u64>,
    pub total: Option<u64>,
    pub transfer: Option<String>,
    pub language: Option<String>,
    pub file_name: Option<String>,
    pub active: bool,
    pub paused: bool,
    pub actions: Vec<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobsResponse {
    pub jobs: Vec<JobDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobActionResponse {
    pub job_id: String,
    pub accepted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobOutputDto {
    pub folder: Option<String>,
    pub file_name: String,
}

fn display_file_name(value: Option<String>) -> Option<String> {
    value.map(|value| {
        value
            .split(['/', '\\'])
            .next_back()
            .unwrap_or_default()
            .to_string()
    })
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn to_dto(job: &jobs::JobState, restartable: bool, files: &[jobs::MediaFile]) -> JobDto {
    let view = model::to_view(
        job,
        restartable,
        job.file_name
            .as_deref()
            .is_some_and(|name| files.iter().any(|file| file.file_name == name)),
    );
    JobDto {
        job_id: job.job_id.clone(),
        job_type: job.job_type.clone(),
        request_id: job.request_id.clone(),
        candidate_id: job.candidate_id.clone(),
        input_kind: job.input_kind.clone(),
        output_format: job.output_format.clone(),
        status: job.status.clone(),
        status_text: model::single_line(&job.status_text, 200),
        status_label: view.status_label,
        tone: view.tone,
        title: view.title,
        detail: view.detail,
        progress: view.percent,
        completed: job.completed,
        total: job.total,
        transfer: view.transfer,
        language: view.language,
        file_name: display_file_name(job.file_name.clone()),
        active: view.active,
        paused: view.paused,
        actions: view
            .actions
            .into_iter()
            .map(|action| action.code().to_string())
            .collect(),
        created_at: job.created_at,
        updated_at: job.updated_at,
    }
}

#[tauri::command]
pub async fn list_jobs() -> Result<JobsResponse, CommandError> {
    tauri::async_runtime::spawn_blocking(|| {
        let directory = jobs::jobs_dir().map_err(CommandError::from_io)?;
        let _ = subtitles::cleanup_stale_requests_in(&directory, now_millis());
        let jobs = jobs::read_jobs().map_err(CommandError::from_io)?;
        let files = jobs::downloads_dir()
            .ok()
            .and_then(|root| {
                jobs::read_library_media_records_in(&root)
                    .ok()
                    .map(|records| {
                        records
                            .into_iter()
                            .map(|record| record.media)
                            .collect::<Vec<_>>()
                    })
            })
            .unwrap_or_default();
        let ids = jobs
            .iter()
            .map(|job| job.job_id.clone())
            .collect::<Vec<_>>();
        let restartable = jobs::restartable_ids_in(&directory, &ids);
        Ok(JobsResponse {
            jobs: jobs
                .iter()
                .map(|job| to_dto(job, restartable.contains(&job.job_id), &files))
                .collect(),
        })
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "작업 목록을 불러오지 못했습니다."))?
}

#[tauri::command]
pub async fn cancel_job(request: JobIdRequest) -> Result<JobActionResponse, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        jobs::request_cancel(&request.job_id).map_err(CommandError::from_io)?;
        Ok(JobActionResponse {
            job_id: request.job_id,
            accepted: true,
        })
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "작업을 취소하지 못했습니다."))?
}

#[tauri::command]
pub async fn pause_job(request: JobIdRequest) -> Result<JobActionResponse, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        jobs::request_pause(&request.job_id).map_err(CommandError::from_io)?;
        Ok(JobActionResponse {
            job_id: request.job_id,
            accepted: true,
        })
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "작업을 일시정지하지 못했습니다."))?
}

#[tauri::command]
pub async fn resume_job(request: JobIdRequest) -> Result<JobActionResponse, CommandError> {
    restart_job_command(request, "resume", "작업을 재개하지 못했습니다.").await
}

#[tauri::command]
pub async fn retry_job(request: JobIdRequest) -> Result<JobActionResponse, CommandError> {
    restart_job_command(request, "retry", "작업을 다시 시작하지 못했습니다.").await
}

async fn restart_job_command(
    request: JobIdRequest,
    action: &'static str,
    join_error: &'static str,
) -> Result<JobActionResponse, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        jobs::restart_job(&request.job_id, action).map_err(CommandError::from_io)?;
        Ok(JobActionResponse {
            job_id: request.job_id,
            accepted: true,
        })
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", join_error))?
}

#[tauri::command]
pub async fn resolve_job_output(request: JobIdRequest) -> Result<JobOutputDto, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = jobs::downloads_dir().map_err(CommandError::from_io)?;
        let state = jobs::read_jobs()
            .map_err(CommandError::from_io)?
            .into_iter()
            .find(|job| job.job_id == request.job_id)
            .ok_or_else(|| CommandError::new("not-found", "작업을 찾지 못했습니다."))?;
        let output = jobs::resolve_job_output_in(&root, &state).map_err(CommandError::from_io)?;
        Ok(JobOutputDto {
            folder: output.folder,
            file_name: output.file_name,
        })
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "작업 결과를 확인하지 못했습니다."))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dto_conversion_formats_status_and_does_not_return_path_components() {
        let state = jobs::JobState {
            job_id: "job-1".into(),
            status: "completed".into(),
            title: Some("  Example\nTitle ".into()),
            file_name: Some(r"folder\clip.mp4".into()),
            ..jobs::JobState::default()
        };
        let dto = to_dto(&state, false, &[]);
        assert_eq!(dto.job_id, "job-1");
        assert_eq!(dto.status_label, "완료");
        assert_eq!(dto.file_name.as_deref(), Some("clip.mp4"));
        assert!(dto.actions.is_empty());
    }

    #[test]
    fn job_output_dto_serializes_only_library_relative_components() {
        let dto = serde_json::to_value(JobOutputDto {
            folder: Some("Videos".into()),
            file_name: "clip.mp4".into(),
        })
        .unwrap();
        assert_eq!(dto["folder"], "Videos");
        assert_eq!(dto["fileName"], "clip.mp4");
        assert!(dto.get("path").is_none());
    }
}
