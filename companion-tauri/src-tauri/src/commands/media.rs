use super::dto::CommandError;
use crate::{jobs, media, subtitles};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::Manager;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFileRequest {
    pub folder: Option<String>,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareMediaSourceResponse {
    /// An absolute path intended only for `convertFileSrc`; operations still
    /// accept the library-relative request above.
    pub path: String,
    pub mime_type: String,
    pub title: String,
    pub folder: Option<String>,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemuxTsToMp4Response {
    pub path: String,
    pub folder: Option<String>,
    pub file_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeekPreviewRequest {
    pub folder: Option<String>,
    pub file_name: String,
    pub timestamp_seconds: f64,
    pub duration_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeekPreviewResponse {
    pub path: String,
    pub mime_type: String,
    pub title: String,
    pub timestamp_seconds: f64,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailResponse {
    pub path: String,
    pub mime_type: String,
    pub title: String,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarSubtitleDto {
    pub file_name: String,
    pub title: String,
    pub format: String,
    pub language: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarSubtitlesResponse {
    pub file_name: String,
    pub subtitles: Vec<SidecarSubtitleDto>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GifExportRequest {
    pub folder: Option<String>,
    pub file_name: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub width: u32,
    pub fps: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GifExportResponse {
    pub path: String,
    pub folder: Option<String>,
    pub file_name: String,
}

fn invalid_media_request() -> CommandError {
    CommandError::invalid_request("미디어 요청을 확인해 주세요.")
}

fn allow_asset_file<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    path: &Path,
) -> Result<(), CommandError> {
    app.asset_protocol_scope().allow_file(path).map_err(|_| {
        CommandError::new("asset-scope-failed", "미디어 리소스를 준비하지 못했습니다.")
    })
}

fn current_media(request: &MediaFileRequest) -> Result<media::ValidatedMedia, CommandError> {
    let root = jobs::downloads_dir().map_err(CommandError::from_io)?;
    media::validate_media_ref(&root, request.folder.as_deref(), &request.file_name)
        .map_err(CommandError::from_io)
}

fn source_response(selected: &media::ValidatedMedia) -> PrepareMediaSourceResponse {
    PrepareMediaSourceResponse {
        path: selected.path.to_string_lossy().into_owned(),
        mime_type: selected.mime_type().to_string(),
        title: selected.title(),
        folder: selected.folder.clone(),
        file_name: selected.file_name.clone(),
    }
}

#[tauri::command]
pub async fn prepare_media_source(
    app: tauri::AppHandle,
    request: MediaFileRequest,
) -> Result<PrepareMediaSourceResponse, CommandError> {
    let selected = tauri::async_runtime::spawn_blocking(move || current_media(&request))
        .await
        .map_err(|_| CommandError::new("operation-failed", "미디어를 준비하지 못했습니다."))??;
    allow_asset_file(&app, &selected.path)?;
    Ok(source_response(&selected))
}

#[tauri::command]
pub async fn open_media_externally(
    request: MediaFileRequest,
) -> Result<super::system::SystemOperationResponse, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let selected = current_media(&request)?;
        media::open_media_externally(&selected).map_err(CommandError::from_io)?;
        Ok(super::system::SystemOperationResponse { accepted: true })
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "외부 플레이어를 열지 못했습니다."))?
}

#[tauri::command]
pub async fn remux_ts_to_mp4(
    request: MediaFileRequest,
) -> Result<RemuxTsToMp4Response, CommandError> {
    let folder = request.folder.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        let selected = current_media(&request)?;
        let ffmpeg = media::bundled_ffmpeg_path().map_err(CommandError::from_io)?;
        media::remux_ts_to_mp4(&selected, &ffmpeg).map_err(CommandError::from_io)
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "미디어 변환을 완료하지 못했습니다."))??;
    Ok(RemuxTsToMp4Response {
        path: path.to_string_lossy().into_owned(),
        folder,
        file_name: path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(invalid_media_request)?
            .to_string(),
    })
}

#[tauri::command]
pub async fn generate_seek_preview(
    app: tauri::AppHandle,
    request: SeekPreviewRequest,
) -> Result<SeekPreviewResponse, CommandError> {
    let file_name = request.file_name.clone();
    let (path, timestamp_millis, title) = tauri::async_runtime::spawn_blocking(move || {
        let media_request = MediaFileRequest {
            folder: request.folder,
            file_name: request.file_name.clone(),
        };
        let selected = current_media(&media_request)?;
        if !media::is_video_file_name(&selected.file_name) {
            return Err(invalid_media_request());
        }
        let title = selected.title();
        let cache_root = jobs::companion_root().map_err(CommandError::from_io)?;
        let ffmpeg = media::bundled_ffmpeg_path().map_err(CommandError::from_io)?;
        let (path, timestamp_millis) = media::generate_seek_preview(
            &selected,
            request.timestamp_seconds,
            request.duration_seconds,
            &cache_root,
            &ffmpeg,
        )
        .map_err(CommandError::from_io)?;
        Ok((path, timestamp_millis, title))
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "미리보기를 준비하지 못했습니다."))??;
    allow_asset_file(&app, &path)?;
    Ok(SeekPreviewResponse {
        path: path.to_string_lossy().into_owned(),
        mime_type: "image/jpeg".to_string(),
        title,
        timestamp_seconds: timestamp_millis as f64 / 1_000.0,
        file_name,
    })
}

#[tauri::command]
pub async fn generate_thumbnail(
    app: tauri::AppHandle,
    request: MediaFileRequest,
) -> Result<ThumbnailResponse, CommandError> {
    let (path, title, file_name) = tauri::async_runtime::spawn_blocking(move || {
        let selected = current_media(&request)?;
        if !media::is_video_file_name(&selected.file_name) {
            return Err(invalid_media_request());
        }
        let cache_root = jobs::companion_root().map_err(CommandError::from_io)?;
        let ffmpeg = media::bundled_ffmpeg_path().map_err(CommandError::from_io)?;
        let title = selected.title();
        let file_name = selected.file_name.clone();
        let path = media::generate_thumbnail(&selected, &cache_root, &ffmpeg)
            .map_err(CommandError::from_io)?;
        Ok((path, title, file_name))
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "썸네일을 준비하지 못했습니다."))??;
    allow_asset_file(&app, &path)?;
    Ok(ThumbnailResponse {
        path: path.to_string_lossy().into_owned(),
        mime_type: "image/jpeg".to_string(),
        title,
        file_name,
    })
}

#[tauri::command]
pub async fn load_sidecar_subtitles(
    request: MediaFileRequest,
) -> Result<SidecarSubtitlesResponse, CommandError> {
    let (file_name, discovered) = tauri::async_runtime::spawn_blocking(
        move || -> Result<(String, Vec<subtitles::SidecarSubtitle>), CommandError> {
            let selected = current_media(&request)?;
            let file_name = selected.file_name.clone();
            let subtitles =
                subtitles::discover_sidecar_subtitles(&selected).map_err(CommandError::from_io)?;
            Ok((file_name, subtitles))
        },
    )
    .await
    .map_err(|_| CommandError::new("operation-failed", "자막을 읽지 못했습니다."))??;
    let subtitles = discovered
        .into_iter()
        .map(|subtitle| {
            let title = std::path::Path::new(&subtitle.file_name)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(&subtitle.file_name)
                .to_string();
            SidecarSubtitleDto {
                file_name: subtitle.file_name,
                title,
                format: subtitle.format,
                language: subtitle.language,
                text: subtitle.text,
            }
        })
        .collect();
    Ok(SidecarSubtitlesResponse {
        file_name,
        subtitles,
    })
}

#[tauri::command]
pub async fn export_gif(
    app: tauri::AppHandle,
    request: GifExportRequest,
) -> Result<GifExportResponse, CommandError> {
    let folder = request.folder.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        let selected = current_media(&MediaFileRequest {
            folder: request.folder,
            file_name: request.file_name,
        })?;
        let normalized = media::validate_gif_request(
            request.start_seconds,
            request.end_seconds,
            request.width,
            request.fps,
        )
        .map_err(CommandError::from_io)?;
        let ffmpeg = media::bundled_ffmpeg_path().map_err(CommandError::from_io)?;
        media::export_gif(&selected, &normalized, &ffmpeg).map_err(CommandError::from_io)
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "GIF를 만들지 못했습니다."))??;
    allow_asset_file(&app, &path)?;
    Ok(GifExportResponse {
        path: path.to_string_lossy().into_owned(),
        folder,
        file_name: path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(invalid_media_request)?
            .to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dto_serialization_uses_frontend_camel_case_names() {
        let dto = serde_json::to_value(SeekPreviewResponse {
            path: "C:\\cache\\frame.jpg".into(),
            mime_type: "image/jpeg".into(),
            title: "clip".into(),
            timestamp_seconds: 1.5,
            file_name: "clip.mp4".into(),
        })
        .unwrap();
        assert_eq!(dto["mimeType"], "image/jpeg");
        assert_eq!(dto["timestampSeconds"], 1.5);
        assert!(dto.get("mime_type").is_none());
    }

    #[test]
    fn subtitle_dto_serialization_keeps_text_and_language_metadata() {
        let dto = serde_json::to_value(SidecarSubtitleDto {
            file_name: "clip.ko.srt".into(),
            title: "clip.ko".into(),
            format: "srt".into(),
            language: Some("ko".into()),
            text: "1\ntext".into(),
        })
        .unwrap();
        assert_eq!(dto["fileName"], "clip.ko.srt");
        assert_eq!(dto["language"], "ko");
        assert_eq!(dto["text"], "1\ntext");
    }
}
