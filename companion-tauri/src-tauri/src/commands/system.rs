use super::{dto::CommandError, jobs::JobIdRequest};
use crate::jobs;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolderRequest {
    pub folder: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealLibraryFileRequest {
    pub folder: Option<String>,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemOperationResponse {
    pub accepted: bool,
}

#[tauri::command]
pub async fn open_library_folder(
    request: LibraryFolderRequest,
) -> Result<SystemOperationResponse, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        jobs::open_library_folder(request.folder.as_deref()).map_err(CommandError::from_io)?;
        Ok(SystemOperationResponse { accepted: true })
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "폴더를 열지 못했습니다."))?
}

#[tauri::command]
pub async fn reveal_library_file(
    request: RevealLibraryFileRequest,
) -> Result<SystemOperationResponse, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        jobs::reveal_file(request.folder.as_deref(), &request.file_name)
            .map_err(CommandError::from_io)?;
        Ok(SystemOperationResponse { accepted: true })
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "파일 위치를 열지 못했습니다."))?
}

#[tauri::command]
pub async fn reveal_job_output(
    request: JobIdRequest,
) -> Result<SystemOperationResponse, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = jobs::downloads_dir().map_err(CommandError::from_io)?;
        let state = jobs::read_jobs()
            .map_err(CommandError::from_io)?
            .into_iter()
            .find(|job| job.job_id == request.job_id)
            .ok_or_else(|| CommandError::new("not-found", "작업을 찾지 못했습니다."))?;
        let output = jobs::resolve_job_output_in(&root, &state).map_err(CommandError::from_io)?;
        jobs::reveal_file(output.folder.as_deref(), &output.file_name)
            .map_err(CommandError::from_io)?;
        Ok(SystemOperationResponse { accepted: true })
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "작업 결과 위치를 열지 못했습니다."))?
}

#[tauri::command]
pub async fn recycle_library_file(
    request: RevealLibraryFileRequest,
) -> Result<SystemOperationResponse, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = jobs::downloads_dir().map_err(CommandError::from_io)?;
        jobs::delete_media_file_in(&root, request.folder.as_deref(), &request.file_name)
            .map_err(CommandError::from_io)?;
        Ok(SystemOperationResponse { accepted: true })
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "파일을 휴지통으로 보내지 못했습니다."))?
}
