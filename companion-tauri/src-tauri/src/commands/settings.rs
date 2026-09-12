use super::dto::CommandError;
use crate::jobs;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDto {
    pub download_folder: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadFolderRequest {
    pub download_folder: String,
}

fn current_settings() -> Result<SettingsDto, CommandError> {
    let folder = jobs::downloads_dir().map_err(CommandError::from_io)?;
    Ok(SettingsDto {
        download_folder: folder.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn get_settings() -> Result<SettingsDto, CommandError> {
    tauri::async_runtime::spawn_blocking(current_settings)
        .await
        .map_err(|_| CommandError::new("operation-failed", "설정을 불러오지 못했습니다."))?
}

#[tauri::command]
pub async fn update_download_folder(
    request: UpdateDownloadFolderRequest,
) -> Result<SettingsDto, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = jobs::companion_root().map_err(CommandError::from_io)?;
        jobs::write_download_folder_in(&root, &PathBuf::from(request.download_folder))
            .map_err(CommandError::from_io)?;
        current_settings()
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "설정을 저장하지 못했습니다."))?
}
