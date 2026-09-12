use super::dto::CommandError;
use crate::{jobs, library_state, model};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LibraryListRequest {
    pub folder: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryMetadataDto {
    pub rating: i32,
    pub favorite: bool,
    pub watched_override: Option<bool>,
    pub last_position: f64,
    pub duration: f64,
    pub updated_at: u64,
    pub pose_markers: Vec<f64>,
    pub watch_state: library_state::WatchState,
}

impl LibraryMetadataDto {
    fn from_metadata(metadata: library_state::LibraryMetadata) -> Self {
        let metadata = metadata.normalized();
        let watch_state = metadata.watch_state();
        Self {
            rating: metadata.rating,
            favorite: metadata.favorite,
            watched_override: metadata.watched_override,
            last_position: metadata.last_position,
            duration: metadata.duration,
            updated_at: metadata.updated_at,
            pose_markers: metadata.pose_markers,
            watch_state,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntryDto {
    pub file_name: String,
    pub title: String,
    pub type_label: String,
    pub size: Option<String>,
    pub job_id: Option<String>,
    pub thumbnail_key: String,
    pub modified_at: u64,
    pub metadata: LibraryMetadataDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolderDto {
    pub name: String,
    pub media_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryListResponse {
    pub folder: Option<String>,
    pub folders: Vec<LibraryFolderDto>,
    pub entries: Vec<LibraryEntryDto>,
    pub missing_output_count: usize,
    pub usage_bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataUpdateRequest {
    pub folder: Option<String>,
    pub file_name: String,
    pub rating: Option<i32>,
    pub favorite: Option<bool>,
    /// `None` means omitted; `Some(None)` means clear the explicit override.
    pub watched_override: Option<Option<bool>>,
    pub last_position: Option<f64>,
    pub duration: Option<f64>,
    pub pose_markers: Option<Vec<f64>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataUpdateResponse {
    pub changed: bool,
    pub persisted: bool,
    pub file_name: String,
    pub metadata: LibraryMetadataDto,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveLibraryFileRequest {
    pub source_folder: Option<String>,
    pub file_name: String,
    pub destination_folder: Option<String>,
    pub destination_file_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveLibraryFileResponse {
    pub folder: Option<String>,
    pub file_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteLibraryFileRequest {
    pub folder: Option<String>,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteLibraryFileResponse {
    pub folder: Option<String>,
    pub file_name: String,
    pub recycled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteLibraryFilesRequest {
    pub items: Vec<jobs::LibraryFileRef>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteLibraryItemResult {
    pub item: jobs::LibraryFileRef,
    pub recycled: bool,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteLibraryFilesResponse {
    pub items: Vec<DeleteLibraryItemResult>,
    pub succeeded: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AutoOrganizeRequest {
    #[serde(default)]
    pub apply: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationFileRefDto {
    pub folder: Option<String>,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationPlanItemDto {
    pub source: OrganizationFileRefDto,
    pub destination: OrganizationFileRefDto,
    pub rule: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationResultItemDto {
    pub source: OrganizationFileRefDto,
    pub destination: OrganizationFileRefDto,
    pub succeeded: bool,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoOrganizeResponse {
    pub applied: bool,
    pub items: Vec<OrganizationResultItemDto>,
    pub succeeded: usize,
    pub failed: usize,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn operation_error_code(kind: std::io::ErrorKind) -> String {
    match kind {
        std::io::ErrorKind::InvalidInput => "invalid-request",
        std::io::ErrorKind::NotFound => "not-found",
        std::io::ErrorKind::AlreadyExists => "already-exists",
        std::io::ErrorKind::PermissionDenied => "permission-denied",
        std::io::ErrorKind::InvalidData => "invalid-data",
        std::io::ErrorKind::Unsupported => "unsupported",
        _ => "operation-failed",
    }
    .to_string()
}

fn file_ref_dto(value: &jobs::LibraryFileRef) -> OrganizationFileRefDto {
    OrganizationFileRefDto {
        folder: value.folder.clone(),
        file_name: value.file_name.clone(),
    }
}

fn organization_rule_name(rule: jobs::LibraryOrganizationRule) -> String {
    match rule {
        jobs::LibraryOrganizationRule::VideoExtension => "videoExtension",
        jobs::LibraryOrganizationRule::AudioExtension => "audioExtension",
    }
    .to_string()
}

#[tauri::command]
pub async fn list_library(
    request: LibraryListRequest,
) -> Result<LibraryListResponse, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = jobs::downloads_dir().map_err(CommandError::from_io)?;
        let directory = jobs::library_dir_in(&root, request.folder.as_deref())
            .map_err(CommandError::from_io)?;
        let files = jobs::read_media_files_in(&directory).map_err(CommandError::from_io)?;
        let all_jobs = jobs::read_jobs().map_err(CommandError::from_io)?;
        let entries = model::library_entries(&files, &all_jobs);
        let state_root = jobs::companion_root().map_err(CommandError::from_io)?;
        let state =
            library_state::LibraryState::load_in(&state_root).map_err(CommandError::from_io)?;
        let entries = entries
            .into_iter()
            .zip(files.iter())
            .map(|(entry, media)| LibraryEntryDto {
                file_name: entry.file_name,
                title: entry.title,
                type_label: entry.type_label,
                size: entry.size,
                job_id: entry.job_id,
                thumbnail_key: entry.thumbnail_key,
                modified_at: entry.modified_at,
                metadata: LibraryMetadataDto::from_metadata(state.metadata_or_default(media)),
            })
            .collect();
        let folders = jobs::read_library_folders_in(&root)
            .map_err(CommandError::from_io)?
            .into_iter()
            .map(|folder| LibraryFolderDto {
                name: folder.name,
                media_count: folder.media_count,
            })
            .collect();
        let root_files = jobs::read_media_files_in(&root).map_err(CommandError::from_io)?;
        Ok(LibraryListResponse {
            folder: request.folder,
            folders,
            entries,
            missing_output_count: model::missing_output_count(&root_files, &all_jobs),
            usage_bytes: root_files.iter().map(|file| file.size).sum(),
        })
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "보관함을 불러오지 못했습니다."))?
}

#[tauri::command]
pub async fn update_library_metadata(
    request: MetadataUpdateRequest,
) -> Result<MetadataUpdateResponse, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let library_root = jobs::downloads_dir().map_err(CommandError::from_io)?;
        let (_, media) =
            jobs::media_file_in(&library_root, request.folder.as_deref(), &request.file_name)
                .map_err(CommandError::from_io)?;
        let state_root = jobs::companion_root().map_err(CommandError::from_io)?;
        let mut state =
            library_state::LibraryState::load_in(&state_root).map_err(CommandError::from_io)?;
        let changed = state.update_media(&media, now_millis(), |metadata| {
            if let Some(rating) = request.rating {
                metadata.rating = rating;
            }
            if let Some(favorite) = request.favorite {
                metadata.favorite = favorite;
            }
            if let Some(watched) = request.watched_override {
                metadata.watched_override = watched;
            }
            if let Some(position) = request.last_position {
                metadata.last_position = position;
            }
            if let Some(duration) = request.duration {
                metadata.duration = duration;
            }
            if let Some(markers) = request.pose_markers.clone() {
                metadata.pose_markers = markers;
            }
        });
        let persisted = state
            .persist_in(&state_root)
            .map_err(CommandError::from_io)?;
        let metadata = state.metadata_or_default(&media);
        Ok(MetadataUpdateResponse {
            changed,
            persisted,
            file_name: request.file_name,
            metadata: LibraryMetadataDto::from_metadata(metadata),
        })
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "보관함 정보를 저장하지 못했습니다."))?
}

#[tauri::command]
pub async fn move_library_file(
    request: MoveLibraryFileRequest,
) -> Result<MoveLibraryFileResponse, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = jobs::downloads_dir().map_err(CommandError::from_io)?;
        let destination_file_name = request
            .destination_file_name
            .as_deref()
            .unwrap_or(&request.file_name);
        jobs::move_library_file_in(
            &root,
            request.source_folder.as_deref(),
            &request.file_name,
            request.destination_folder.as_deref(),
            destination_file_name,
        )
        .map_err(CommandError::from_io)?;
        Ok(MoveLibraryFileResponse {
            folder: request.destination_folder,
            file_name: destination_file_name.to_string(),
        })
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "파일을 이동하지 못했습니다."))?
}

#[tauri::command]
pub async fn delete_library_file(
    request: DeleteLibraryFileRequest,
) -> Result<DeleteLibraryFileResponse, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = jobs::downloads_dir().map_err(CommandError::from_io)?;
        jobs::delete_media_file_in(&root, request.folder.as_deref(), &request.file_name)
            .map_err(CommandError::from_io)?;
        Ok(DeleteLibraryFileResponse {
            folder: request.folder,
            file_name: request.file_name,
            recycled: true,
        })
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "파일을 휴지통으로 보내지 못했습니다."))?
}

#[tauri::command]
pub async fn delete_library_files(
    request: DeleteLibraryFilesRequest,
) -> Result<DeleteLibraryFilesResponse, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = jobs::downloads_dir().map_err(CommandError::from_io)?;
        let report = jobs::batch_recycle_media_files_in(&root, &request.items);
        let succeeded = report.succeeded_count();
        let failed = report.failed_count();
        let items = report
            .items
            .into_iter()
            .map(|result| {
                let error_code = result
                    .outcome
                    .failure()
                    .map(|failure| operation_error_code(failure.kind));
                DeleteLibraryItemResult {
                    item: result.item,
                    recycled: error_code.is_none(),
                    error_code,
                }
            })
            .collect();
        Ok(DeleteLibraryFilesResponse {
            items,
            succeeded,
            failed,
        })
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "파일을 휴지통으로 보내지 못했습니다."))?
}

#[tauri::command]
pub async fn auto_organize_library(
    request: AutoOrganizeRequest,
) -> Result<AutoOrganizeResponse, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = jobs::downloads_dir().map_err(CommandError::from_io)?;
        let plan = jobs::preview_library_organization_in(&root).map_err(CommandError::from_io)?;
        if !request.apply {
            let items = plan
                .items()
                .iter()
                .map(|item| OrganizationResultItemDto {
                    source: file_ref_dto(&item.source),
                    destination: file_ref_dto(&item.destination),
                    succeeded: false,
                    error_code: None,
                })
                .collect::<Vec<_>>();
            return Ok(AutoOrganizeResponse {
                applied: false,
                succeeded: 0,
                failed: 0,
                items,
            });
        }
        let report = jobs::apply_library_organization(&plan);
        let succeeded = report.succeeded_count();
        let failed = report.failed_count();
        let items = report
            .items
            .into_iter()
            .map(|result| OrganizationResultItemDto {
                source: file_ref_dto(&result.item.source),
                destination: file_ref_dto(&result.item.destination),
                succeeded: result.outcome.is_success(),
                error_code: result
                    .outcome
                    .failure()
                    .map(|failure| operation_error_code(failure.kind)),
            })
            .collect();
        Ok(AutoOrganizeResponse {
            applied: true,
            succeeded,
            failed,
            items,
        })
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "보관함을 정리하지 못했습니다."))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_dto_normalizes_values_and_exposes_watch_state() {
        let dto = LibraryMetadataDto::from_metadata(library_state::LibraryMetadata {
            rating: 99,
            duration: 100.0,
            last_position: 95.0,
            ..Default::default()
        });
        assert_eq!(dto.rating, 5);
        assert_eq!(dto.watch_state, library_state::WatchState::Completed);
    }

    #[test]
    fn organization_rule_dto_uses_stable_non_path_values() {
        assert_eq!(
            organization_rule_name(jobs::LibraryOrganizationRule::VideoExtension),
            "videoExtension"
        );
    }
}
