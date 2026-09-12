use super::dto::CommandError;
use crate::{jobs, license, media, subtitles};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOrGenerateSubtitleRequest {
    pub folder: Option<String>,
    pub file_name: String,
    pub source_language: String,
    pub target_language: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleJobResponse {
    pub job_id: String,
    pub status: String,
    pub source_language: String,
    pub target_language: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSubtitleRequest {
    pub folder: Option<String>,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSubtitleResponse {
    pub media_file_name: String,
    pub file_name: String,
    pub format: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSubtitleRequest {
    pub folder: Option<String>,
    pub file_name: String,
    pub subtitle_file_name: String,
    pub offset_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSubtitleResponse {
    pub media_file_name: String,
    pub file_name: String,
    pub format: String,
    pub offset_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportedSubtitleLanguageDto {
    pub code: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleCapabilitiesDto {
    pub source_languages: Vec<SupportedSubtitleLanguageDto>,
    pub target_languages: Vec<SupportedSubtitleLanguageDto>,
    pub formats: Vec<String>,
    pub max_audio_bytes: u64,
    pub max_result_bytes: u64,
    pub max_offset_seconds: f64,
}

fn current_media(
    folder: Option<&str>,
    file_name: &str,
) -> Result<media::ValidatedMedia, CommandError> {
    let root = jobs::downloads_dir().map_err(CommandError::from_io)?;
    media::validate_media_ref(&root, folder, file_name).map_err(CommandError::from_io)
}

#[tauri::command]
pub async fn list_subtitle_capabilities() -> Result<SubtitleCapabilitiesDto, CommandError> {
    Ok(SubtitleCapabilitiesDto {
        source_languages: vec![
            SupportedSubtitleLanguageDto {
                code: "ja".into(),
                label: "Japanese".into(),
            },
            SupportedSubtitleLanguageDto {
                code: "en".into(),
                label: "English".into(),
            },
        ],
        target_languages: vec![SupportedSubtitleLanguageDto {
            code: "ko".into(),
            label: "Korean".into(),
        }],
        formats: vec!["srt".into(), "vtt".into(), "ass".into()],
        max_audio_bytes: subtitles::MAX_AUDIO_UPLOAD_BYTES,
        max_result_bytes: subtitles::MAX_SIDECAR_SUBTITLE_BYTES,
        max_offset_seconds: subtitles::MAX_SYNC_OFFSET_SECONDS,
    })
}

#[tauri::command]
pub async fn start_or_generate_subtitle(
    request: StartOrGenerateSubtitleRequest,
) -> Result<SubtitleJobResponse, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let (source_language, target_language) =
            subtitles::validate_languages(&request.source_language, &request.target_language)
                .map_err(CommandError::from_io)?;
        let media = current_media(request.folder.as_deref(), &request.file_name)?;
        let root = jobs::companion_root().map_err(CommandError::from_io)?;
        let entitlement = license::load_in(&root);
        if !entitlement.pro || entitlement.key.is_empty() {
            return Err(CommandError::new(
                "pro-license-required",
                "a valid Companion Pro license is required",
            ));
        }
        let state =
            subtitles::start_subtitle_job(media, source_language.clone(), target_language.clone())
                .map_err(CommandError::from_io)?;
        Ok(SubtitleJobResponse {
            job_id: state.job_id,
            status: state.status,
            source_language,
            target_language,
        })
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "자막 작업을 시작하지 못했습니다."))?
}

#[tauri::command]
pub async fn import_subtitle(
    request: ImportSubtitleRequest,
) -> Result<ImportSubtitleResponse, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let media = current_media(request.folder.as_deref(), &request.file_name)?;
        let directory = media.path.parent().ok_or_else(|| {
            CommandError::new("invalid-request", "media directory is unavailable")
        })?;
        #[cfg(target_os = "windows")]
        {
            let mut dialog = rfd::FileDialog::new()
                .set_title("Import subtitle")
                .add_filter("Subtitle files", &["srt", "vtt", "ass"]);
            if directory.is_dir() {
                dialog = dialog.set_directory(directory);
            }
            let source = dialog
                .pick_file()
                .ok_or_else(|| CommandError::new("cancelled", "subtitle import was cancelled"))?;
            let media_file_name = media.file_name.clone();
            let (file_name, format) = subtitles::import_subtitle_from_path(&media, &source)
                .map_err(CommandError::from_io)?;
            return Ok(ImportSubtitleResponse {
                media_file_name,
                file_name,
                format: format.as_str().into(),
            });
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = directory;
            return Err(CommandError::from_io(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "subtitle import picker is supported on Windows only",
            )));
        }
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "자막을 가져오지 못했습니다."))?
}

#[tauri::command]
pub async fn sync_subtitle(
    request: SyncSubtitleRequest,
) -> Result<SyncSubtitleResponse, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let media = current_media(request.folder.as_deref(), &request.file_name)?;
        let media_file_name = media.file_name.clone();
        let (file_name, format) = subtitles::sync_subtitle_from_sidecar(
            &media,
            &request.subtitle_file_name,
            request.offset_seconds,
        )
        .map_err(CommandError::from_io)?;
        Ok(SyncSubtitleResponse {
            media_file_name,
            file_name,
            format: format.as_str().into(),
            offset_seconds: request.offset_seconds,
        })
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "자막 동기화에 실패했습니다."))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_and_command_dtos_use_camel_case_without_license_fields() {
        let dto = serde_json::to_value(SubtitleCapabilitiesDto {
            source_languages: vec![SupportedSubtitleLanguageDto {
                code: "ja".into(),
                label: "Japanese".into(),
            }],
            target_languages: vec![],
            formats: vec!["srt".into()],
            max_audio_bytes: 80,
            max_result_bytes: 2,
            max_offset_seconds: 10.0,
        })
        .unwrap();
        assert!(dto.get("sourceLanguages").is_some());
        assert!(dto.get("maxAudioBytes").is_some());
        assert!(dto.get("licenseKey").is_none());
        assert!(dto.get("source_languages").is_none());
    }

    #[test]
    fn request_shapes_do_not_offer_an_import_source_path() {
        let request = serde_json::to_value(ImportSubtitleRequest {
            folder: None,
            file_name: "clip.mp4".into(),
        })
        .unwrap();
        assert_eq!(request["fileName"], "clip.mp4");
        assert!(request.get("sourcePath").is_none());
        assert!(request.get("path").is_none());
    }
}
