use crate::job_store::{self, JobState};
use crate::media_download::{safe_filename, unique_media_path};
use crate::Request;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const STATE_PERSIST_INTERVAL_MS: u64 = 750;
pub const STATE_PERSIST_BYTE_INTERVAL: u64 = 8 * 1024 * 1024;

pub(crate) struct MediaWriter {
    pub(crate) job_id: String,
    pub(crate) file: File,
    pub(crate) temporary_path: PathBuf,
    pub(crate) final_path: PathBuf,
    pub(crate) state: JobState,
    pub(crate) bytes_written: u64,
    last_state_persisted_at: u64,
    last_state_persisted_bytes: u64,
}

#[derive(Default)]
pub struct Session {
    writer: Option<MediaWriter>,
}

pub fn decode_chunk(value: &str) -> Result<Vec<u8>, base64::DecodeError> {
    BASE64.decode(value.as_bytes())
}

pub fn should_persist_state(
    now: u64,
    last_persisted_at: u64,
    bytes_written: u64,
    last_persisted_bytes: u64,
) -> bool {
    now.saturating_sub(last_persisted_at) >= STATE_PERSIST_INTERVAL_MS
        || bytes_written.saturating_sub(last_persisted_bytes) >= STATE_PERSIST_BYTE_INTERVAL
}

pub fn progress(bytes_written: u64, total: Option<u64>) -> Option<u8> {
    total.filter(|total| *total > 0).map(|total| {
        ((bytes_written as f64 / total as f64) * 100.0)
            .round()
            .clamp(0.0, 99.0) as u8
    })
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn persist_job_state_in(directory: &Path, state: &mut JobState, updated_at: u64) -> io::Result<()> {
    job_store::persist_job_state_in(directory, state, updated_at)
}

fn persist_job_state(state: &mut JobState) -> io::Result<()> {
    persist_job_state_in(&job_store::jobs_dir()?, state, now_millis())
}

pub(crate) fn open_media_writer_in(directory: &Path, request: &Request) -> io::Result<MediaWriter> {
    let (final_path, temporary_path, file, bytes_written) =
        if request.resume_file_name.trim().is_empty() {
            let filename = safe_filename(&request.filename);
            let final_path = unique_media_path(directory, &filename);
            let temporary_path = PathBuf::from(format!("{}.part", final_path.display()));
            let file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary_path)?;
            (final_path, temporary_path, file, 0)
        } else {
            let requested = request.resume_file_name.trim();
            let safe = safe_filename(requested);
            if safe != requested
                || Path::new(requested)
                    .file_name()
                    .and_then(|value| value.to_str())
                    != Some(requested)
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "invalid resume filename",
                ));
            }
            let final_path = directory.join(requested);
            let temporary_path = PathBuf::from(format!("{}.part", final_path.display()));
            if final_path.exists() {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "completed output already exists",
                ));
            }
            let mut file = OpenOptions::new()
                .write(true)
                .read(true)
                .open(&temporary_path)?;
            let mut bytes_written = file.metadata()?.len();
            if request
                .resume_from
                .is_some_and(|expected| expected > bytes_written)
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "resume checkpoint exceeds partial file",
                ));
            }
            if let Some(expected) = request
                .resume_from
                .filter(|expected| *expected < bytes_written)
            {
                file.set_len(expected)?;
                bytes_written = expected;
            }
            file.seek(SeekFrom::End(0))?;
            (final_path, temporary_path, file, bytes_written)
        };
    let now = now_millis();
    let state = initial_media_writer_state(request, &final_path, now, bytes_written);
    Ok(MediaWriter {
        job_id: request.job_id.clone(),
        file,
        temporary_path,
        final_path,
        state,
        bytes_written,
        last_state_persisted_at: now,
        last_state_persisted_bytes: bytes_written,
    })
}

pub(crate) fn initial_media_writer_state(
    request: &Request,
    final_path: &Path,
    now: u64,
    bytes_written: u64,
) -> JobState {
    JobState {
        job_id: request.job_id.clone(),
        job_type: None,
        request_id: (!request.request_id.is_empty()).then(|| request.request_id.clone()),
        candidate_id: None,
        source_language: None,
        target_language: None,
        input_kind: (!request.input_kind.trim().is_empty()).then(|| request.input_kind.clone()),
        output_format: None,
        execution_status: None,
        tab_id: None,
        frame_id: None,
        remote_job_id: None,
        phase: Some("receiving".into()),
        completed: Some(bytes_written),
        total: request.total.filter(|value| *value > 0),
        model: None,
        status: "running".into(),
        status_text: if bytes_written > 0 {
            format!(
                "브라우저 다운로드 이어받는 중… {} MB",
                bytes_written / 1_048_576
            )
        } else {
            "브라우저에서 미디어를 받는 중…".into()
        },
        title: (!request.title.trim().is_empty()).then(|| request.title.clone()),
        error: None,
        progress: progress(bytes_written, request.total),
        file_name: final_path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned()),
        created_at: now,
        updated_at: now,
    }
}

pub(crate) fn cancel_media_writer_in(
    mut active: MediaWriter,
    jobs_directory: &Path,
) -> io::Result<()> {
    active.state.status = "cancelled".into();
    active.state.status_text = "다운로드를 취소했습니다.".into();
    active.state.error = None;
    persist_job_state_in(jobs_directory, &mut active.state, now_millis())?;

    let temporary_path = active.temporary_path.clone();
    let cancel_path = job_store::cancel_path_in(jobs_directory, &active.job_id)?;
    let _ = active.file.flush();
    drop(active);
    match fs::remove_file(temporary_path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let _ = fs::remove_file(cancel_path);
    Ok(())
}

pub fn handle_request<F, M>(
    request: &Request,
    session: &mut Session,
    downloads: F,
    show_manager: M,
) -> Value
where
    F: FnOnce() -> io::Result<PathBuf>,
    M: FnOnce(),
{
    match request.kind.as_str() {
        "media-open" => match downloads().and_then(|path| open_media_writer_in(&path, request)) {
            Ok(mut opened) => {
                let file_name = opened
                    .final_path
                    .file_name()
                    .map(|value| value.to_string_lossy().into_owned());
                let bytes_written = opened.bytes_written;
                let _ = persist_job_state(&mut opened.state);
                if request.show_ui.unwrap_or(true) {
                    show_manager();
                }
                session.writer = Some(opened);
                json!({
                    "ok": true,
                    "jobId": request.job_id,
                    "status": "opened",
                    "statusText": "Downloads\\Aura Media 폴더에 저장을 시작합니다.",
                    "fileName": file_name,
                    "bytesWritten": bytes_written,
                })
            }
            Err(error) => json!({
                "ok": false,
                "jobId": request.job_id,
                "status": "failed",
                "statusText": "로컬 파일을 만들지 못했습니다.",
                "error": error.to_string(),
            }),
        },
        "media-chunk" => {
            let matching_writer = session
                .writer
                .as_ref()
                .is_some_and(|active| active.job_id == request.job_id);
            if !matching_writer {
                return json!({
                    "ok": false,
                    "jobId": request.job_id,
                    "status": "failed",
                    "errorCode": "media-writer-not-open",
                    "error": "열린 미디어 파일이 없습니다.",
                });
            }
            let jobs_directory = job_store::jobs_dir();
            let cancel_requested = jobs_directory
                .as_ref()
                .ok()
                .and_then(|directory| job_store::cancel_path_in(directory, &request.job_id).ok())
                .is_some_and(|path| path.exists());
            if cancel_requested {
                let result = jobs_directory.and_then(|directory| {
                    let active = session
                        .writer
                        .take()
                        .expect("matching writer checked above");
                    cancel_media_writer_in(active, &directory)
                });
                return json!({
                    "ok": false,
                    "jobId": request.job_id,
                    "status": "cancelled",
                    "errorCode": "download-cancelled",
                    "error": result.err().map_or_else(
                        || "다운로드를 취소했습니다.".to_string(),
                        |error| format!("다운로드 취소 정리 중 오류가 발생했습니다: {error}"),
                    ),
                });
            }
            let active = session
                .writer
                .as_mut()
                .expect("matching writer checked above");
            match decode_chunk(&request.data) {
                Ok(bytes) => match active.file.write_all(&bytes) {
                    Ok(()) => {
                        active.bytes_written =
                            active.bytes_written.saturating_add(bytes.len() as u64);
                        active.state.completed = Some(active.bytes_written);
                        active.state.progress = progress(active.bytes_written, active.state.total);
                        active.state.status_text = match active.state.progress {
                            Some(progress) => {
                                format!("브라우저에서 미디어를 받는 중… {progress}%")
                            }
                            None => format!(
                                "브라우저에서 미디어를 받는 중… {} MB",
                                active.bytes_written / 1_048_576
                            ),
                        };
                        let now = now_millis();
                        if should_persist_state(
                            now,
                            active.last_state_persisted_at,
                            active.bytes_written,
                            active.last_state_persisted_bytes,
                        ) {
                            let _ = persist_job_state(&mut active.state);
                            active.last_state_persisted_at = now;
                            active.last_state_persisted_bytes = active.bytes_written;
                        }
                        json!({
                            "ok": true,
                            "jobId": request.job_id,
                            "status": "chunk",
                            "bytes": bytes.len(),
                            "bytesWritten": active.bytes_written,
                        })
                    }
                    Err(error) => {
                        active.state.status = "failed".into();
                        active.state.status_text = "다운로드 파일을 쓰지 못했습니다.".into();
                        active.state.error = Some(error.to_string());
                        let _ = persist_job_state(&mut active.state);
                        json!({
                            "ok": false,
                            "jobId": request.job_id,
                            "status": "failed",
                            "error": error.to_string(),
                        })
                    }
                },
                Err(error) => json!({
                    "ok": false,
                    "jobId": request.job_id,
                    "status": "failed",
                    "errorCode": "invalid-media-data",
                    "error": error.to_string(),
                }),
            }
        }
        "media-close" => {
            let Some(mut active) = session
                .writer
                .take()
                .filter(|active| active.job_id == request.job_id)
            else {
                return json!({
                    "ok": false,
                    "jobId": request.job_id,
                    "status": "failed",
                    "errorCode": "media-writer-not-open",
                });
            };
            let result = active.file.flush().and_then(|_| active.file.sync_all());
            drop(active.file);
            match result.and_then(|_| fs::rename(&active.temporary_path, &active.final_path)) {
                Ok(()) => {
                    active.state.status = "completed".into();
                    active.state.status_text = "다운로드 폴더에 저장했습니다.".into();
                    active.state.phase = Some("completed".into());
                    active.state.completed = Some(active.bytes_written);
                    if active.state.total.is_none() {
                        active.state.total = Some(active.bytes_written);
                    }
                    active.state.progress = Some(100);
                    active.state.error = None;
                    let _ = persist_job_state(&mut active.state);
                    json!({
                        "ok": true,
                        "jobId": request.job_id,
                        "status": "closed",
                        "statusText": "Downloads\\Aura Media 폴더에 저장했습니다.",
                        "fileName": active.final_path.file_name().map(|value| value.to_string_lossy().into_owned()),
                    })
                }
                Err(error) => {
                    let _ = fs::remove_file(&active.temporary_path);
                    active.state.status = "failed".into();
                    active.state.status_text = "다운로드 파일을 마무리하지 못했습니다.".into();
                    active.state.error = Some(error.to_string());
                    let _ = persist_job_state(&mut active.state);
                    json!({
                        "ok": false,
                        "jobId": request.job_id,
                        "status": "failed",
                        "error": error.to_string(),
                    })
                }
            }
        }
        "media-abort" => {
            if let Some(mut active) = session.writer.take() {
                drop(active.file);
                let _ = fs::remove_file(active.temporary_path);
                active.state.status = "cancelled".into();
                active.state.status_text = "다운로드를 취소했습니다.".into();
                active.state.error = None;
                let _ = persist_job_state(&mut active.state);
            }
            json!({
                "ok": true,
                "jobId": request.job_id,
                "status": "aborted",
            })
        }
        "media-suspend" => {
            if let Some(mut active) = session.writer.take() {
                let _ = active.file.flush();
                let _ = active.file.sync_all();
                drop(active.file);
                active.state.status = "failed".into();
                active.state.status_text = "연결이 끊겨 이어받기 지점을 보존했습니다.".into();
                active.state.error = Some("download-interrupted-resumable".into());
                active.state.completed = Some(active.bytes_written);
                let _ = persist_job_state(&mut active.state);
                return json!({
                    "ok": true,
                    "jobId": request.job_id,
                    "status": "suspended",
                    "fileName": active.final_path.file_name().map(|value| value.to_string_lossy().into_owned()),
                    "bytesWritten": active.bytes_written,
                });
            }
            json!({
                "ok": true,
                "jobId": request.job_id,
                "status": "suspended",
                "bytesWritten": 0,
            })
        }
        _ => json!({
            "ok": false,
            "jobId": request.job_id,
            "status": "failed",
            "errorCode": "invalid-media-request",
        }),
    }
}

pub fn disconnect(session: &mut Session) {
    if let Some(mut active) = session.writer.take() {
        drop(active.file);
        let _ = fs::remove_file(active.temporary_path);
        if active.state.status == "running" {
            active.state.status = "failed".into();
            active.state.status_text = "브라우저와 Companion 연결이 끊겼습니다.".into();
            active.state.error = Some("media-companion-disconnected".into());
            let _ = persist_job_state(&mut active.state);
        }
    }
}
