#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod job_store;
mod legacy_writer;
mod media_download;
mod process;
mod protocol;
mod subtitle;
mod youtube;

use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use subtitle::*;

type JobState = job_store::JobState;

#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    FindWindowW, IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE,
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const PROTOCOL_VERSION: u32 = 2;
const SUBTITLE_COMMAND_VERSION: u32 = 1;
const MAX_SUBTITLE_MESSAGE_BYTES: usize = 32 * 1024;
const MAX_SUBTITLE_TITLE_BYTES: usize = 512;
const MAX_SUBTITLE_METADATA_BYTES: usize = 128;
const MAX_COMPANION_SETTINGS_BYTES: usize = 16 * 1024;
const MAX_SUBTITLE_RESULT_BYTES: usize = 2 * 1024 * 1024;
const MAX_SUBTITLE_REMOTE_RESPONSE_BYTES: usize = MAX_SUBTITLE_RESULT_BYTES + 64 * 1024;
const MAX_SUBTITLE_PHASE_BYTES: usize = 128;
const SUBTITLE_WORKER_URL: &str = subtitle::WORKER_URL;
const SUBTITLE_POLL_INTERVAL: Duration = Duration::from_millis(1_200);
const SUBTITLE_MAX_RUNTIME: Duration = Duration::from_secs(30 * 60);
const SUBTITLE_ACTIVE_MAX_AGE_MS: u64 = 2 * 60 * 60 * 1000;
const MAX_SUBTITLE_AUDIO_BYTES: u64 = subtitle::MAX_AUDIO_BYTES;
static NEXT_SUBTITLE_JOB_ID: AtomicU64 = AtomicU64::new(1);
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Deserialize, Serialize)]
struct Request {
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "requestId", default)]
    request_id: String,
    #[serde(rename = "jobId", default)]
    job_id: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    filename: String,
    #[serde(default)]
    title: String,
    #[serde(rename = "protocolVersion", default)]
    protocol_version: u32,
    #[serde(rename = "candidateId", default)]
    candidate_id: String,
    #[serde(default)]
    referrer: Option<String>,
    #[serde(rename = "inputKind", default)]
    input_kind: String,
    #[serde(rename = "userAgent", default)]
    user_agent: String,
    #[serde(rename = "acceptLanguage", default)]
    accept_language: String,
    #[serde(default)]
    total: Option<u64>,
    #[serde(rename = "showUi", default)]
    show_ui: Option<bool>,
    #[serde(rename = "resumeFileName", default)]
    resume_file_name: String,
    #[serde(rename = "resumeFrom", default)]
    resume_from: Option<u64>,
    /// Absolute folder for `set-download-folder`.
    #[serde(default)]
    folder: String,
    #[serde(default)]
    data: String,
    #[serde(default = "default_quality")]
    quality: String,
    #[serde(default)]
    protocol: u32,
    #[serde(skip)]
    raw_message: Value,
    #[serde(skip)]
    message_bytes: usize,
}

type MediaDownloadCommand = media_download::Command;
type MediaDownloadValidationError = media_download::ValidationError;

fn valid_http_url(value: &str) -> bool {
    media_download::valid_http_url(value)
}

fn validate_media_download_command(
    raw: &Value,
    message_bytes: usize,
) -> Result<MediaDownloadCommand, MediaDownloadValidationError> {
    media_download::validate_command(raw, message_bytes)
}

#[cfg(test)]
fn parse_media_download_command_bytes(
    data: &[u8],
) -> Result<MediaDownloadCommand, MediaDownloadValidationError> {
    media_download::parse_command_bytes(data)
}

fn media_download_command_from_request(request: &Request) -> MediaDownloadCommand {
    MediaDownloadCommand {
        kind: request.kind.clone(),
        protocol_version: request.protocol_version,
        request_id: request.request_id.clone(),
        job_id: request.job_id.clone(),
        candidate_id: request.candidate_id.clone(),
        url: request.url.clone(),
        referrer: request.referrer.clone(),
        title: request.title.clone(),
        input_kind: request.input_kind.clone(),
        user_agent: request.user_agent.clone(),
        accept_language: request.accept_language.clone(),
    }
}

fn default_quality() -> String {
    "best".into()
}

fn valid_quality(value: &str) -> bool {
    youtube::valid_quality(value)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
fn parse_request_bytes(data: &[u8]) -> io::Result<Request> {
    let (mut request, raw_message) = protocol::parse_request_bytes::<Request>(data)?;
    request.raw_message = raw_message;
    request.message_bytes = data.len();
    Ok(request)
}

fn read_message() -> io::Result<Option<Request>> {
    let Some((mut request, raw_message, message_bytes)) =
        protocol::read_native_message::<Request>()?
    else {
        return Ok(None);
    };
    request.raw_message = raw_message;
    request.message_bytes = message_bytes;
    Ok(Some(request))
}

fn reply(request: &Request, body: Value) {
    let body = protocol::reply_body(&request.request_id, body);
    let _ = protocol::write_native_message(&body);
}

fn companion_root() -> io::Result<PathBuf> {
    job_store::companion_root()
}

fn jobs_dir() -> io::Result<PathBuf> {
    job_store::jobs_dir()
}

fn subtitle_request_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    job_store::subtitle_request_path_in(directory, job_id)
}

fn settings_path(root: &Path) -> PathBuf {
    job_store::settings_path(root)
}

fn valid_license_key(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 39
        && &bytes[..3] == b"AM-"
        && bytes[3..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(byte))
}

fn read_companion_license_key(root: &Path) -> Result<String, SubtitleRunError> {
    let bytes = fs::read(settings_path(root)).map_err(|_| SubtitleRunError {
        code: "pro-license-required",
        message: "a valid Companion Pro license is required",
    })?;
    if bytes.len() > MAX_COMPANION_SETTINGS_BYTES {
        return Err(SubtitleRunError {
            code: "pro-license-required",
            message: "a valid Companion Pro license is required",
        });
    }
    let settings: CompanionSettings =
        serde_json::from_slice(&bytes).map_err(|_| SubtitleRunError {
            code: "pro-license-required",
            message: "a valid Companion Pro license is required",
        })?;
    let key = settings.license_key.unwrap_or_default();
    let approved = settings.license_edition.as_deref() == Some("pro")
        && settings.license_status.as_deref() == Some("approved")
        && !settings
            .license_expires_at
            .is_some_and(|expires| expires > 0 && now_millis() > expires);
    if approved && valid_license_key(key.trim()) {
        Ok(key.trim().to_string())
    } else {
        Err(SubtitleRunError {
            code: "pro-license-required",
            message: "a valid Companion Pro license is required",
        })
    }
}

fn tools_dir() -> io::Result<PathBuf> {
    let executable = env::current_exe()?;
    Ok(executable.parent().unwrap_or(Path::new(".")).join("tools"))
}

fn downloads_dir() -> io::Result<PathBuf> {
    let home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "home directory is unavailable"))?;
    Ok(PathBuf::from(home).join("Downloads"))
}

fn aura_downloads_dir() -> io::Result<PathBuf> {
    let path = configured_download_dir()?;
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn default_download_dir() -> io::Result<PathBuf> {
    Ok(downloads_dir()?.join("Aura Media"))
}

/// A settings-supplied folder must be absolute and free of traversal segments.
/// Anything else falls back to the default rather than writing media somewhere
/// a malformed settings file happens to point at.
fn valid_download_folder(value: &str) -> Option<PathBuf> {
    job_store::valid_download_folder(value)
}

fn read_download_folder_setting(root: &Path) -> Option<PathBuf> {
    let bytes = fs::read(settings_path(root)).ok()?;
    if bytes.len() > MAX_COMPANION_SETTINGS_BYTES {
        return None;
    }
    let settings: CompanionSettings = serde_json::from_slice(&bytes).ok()?;
    settings
        .download_folder
        .as_deref()
        .and_then(valid_download_folder)
}

/// Resolves the media folder every writer must use. Both entry points read this
/// same value, so the extension and the manager window never diverge.
fn configured_download_dir() -> io::Result<PathBuf> {
    if let Ok(root) = companion_root() {
        if let Some(folder) = read_download_folder_setting(&root) {
            return Ok(folder);
        }
    }
    default_download_dir()
}

fn aura_subtitles_dir() -> io::Result<PathBuf> {
    let path = aura_downloads_dir()?.join("Subtitles");
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn safe_id(value: &str) -> Option<String> {
    job_store::safe_id(value)
}

fn job_state_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    job_store::state_path_in(directory, job_id)
}

fn job_cancel_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    job_store::cancel_path_in(directory, job_id)
}

fn job_cancel_path(job_id: &str) -> io::Result<PathBuf> {
    job_cancel_path_in(&jobs_dir()?, job_id)
}

/// Marker the running job runner polls to stop without discarding progress.
///
/// Separate from the cancel marker because the two outcomes differ: cancel is
/// terminal and drops the partial file's future, pause keeps yt-dlp's `.part`
/// so a later resume continues from the same byte.
fn job_pause_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    job_store::pause_path_in(directory, job_id)
}

fn job_pause_path(job_id: &str) -> io::Result<PathBuf> {
    job_pause_path_in(&jobs_dir()?, job_id)
}

/// Restarts a stopped job from its persisted request.
///
/// Used by both resume and retry: the difference is only which statuses are
/// allowed in, not the mechanism. The `.request.json` written at submit time is
/// the record, so no caller has to resupply the URL or quality.
fn restart_job(job_id: &str) -> io::Result<()> {
    let directory = jobs_dir()?;
    let request_path = job_store::request_path_in(&directory, job_id)?;
    let claim = job_store::reserve_runner_claim_in(&directory, job_id)?;
    let bytes = fs::read(&request_path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            io::Error::new(io::ErrorKind::NotFound, "job-request-missing")
        } else {
            error
        }
    })?;
    let request: Request = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    if request.job_id != job_id {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "job-request-id-mismatch",
        ));
    }

    // Clear both markers first. A leftover marker would make the fresh runner
    // stop again on its first loop iteration.
    if let Ok(path) = job_store::pause_path_in(&directory, job_id) {
        let _ = fs::remove_file(path);
    }
    if let Ok(path) = job_store::cancel_path_in(&directory, job_id) {
        let _ = fs::remove_file(path);
    }

    let mut state =
        read_job_state(&job_store::state_path_in(&directory, job_id)?).unwrap_or_else(|| {
            let mut fresh = initial_job_state(&request);
            fresh.job_id = job_id.to_string();
            fresh
        });
    state.status = "queued".into();
    state.status_text = "이어받기를 준비하는 중…".into();
    state.error = None;
    job_store::persist_job_state_in(&directory, &mut state, now_millis())?;
    match spawn_reserved_runner_with(&request_path, claim, process::spawn_detached) {
        Ok(()) => Ok(()),
        Err(error) => {
            state.status = "failed".into();
            state.status_text = "작업 실행기를 시작하지 못했습니다.".into();
            state.error = Some("job-start-failed".into());
            let _ = job_store::persist_job_state_in(&directory, &mut state, now_millis());
            Err(error)
        }
    }
}

/// Writes the shared download folder into `settings.json`.
///
/// Read-modify-write so the license key and any future setting survive. This is
/// the only writer of the folder value; both entry points read it back through
/// `configured_download_dir`.
fn write_download_folder(root: &Path, folder: &str) -> io::Result<PathBuf> {
    let path = valid_download_folder(folder)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid-download-folder"))?;
    if !path.is_dir() {
        fs::create_dir_all(&path)?;
    }

    aura_companion_contract::update_settings_document(root, |document| {
        document["downloadFolder"] = Value::String(path.to_string_lossy().into_owned());
        Ok(())
    })?;
    Ok(path)
}

/// Compatibility-only command for older extension callers.
///
/// Current Library playback is owned by the manager's embedded mpv surface.
/// Keep this frozen protocol command until all installed pre-manager clients
/// have aged out; new code must not route playback through the system default.
#[cfg(target_os = "windows")]
fn open_media_file(file_name: &str) -> io::Result<PathBuf> {
    let name = Path::new(file_name)
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid-file-name"))?;
    let path = aura_downloads_dir()?.join(name);
    if !path.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "media-file-missing",
        ));
    }
    let mut command = Command::new("cmd.exe");
    command
        .arg("/c")
        .arg("start")
        .arg("")
        .arg(&path)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.spawn()?;
    Ok(path)
}

#[cfg(not(target_os = "windows"))]
fn open_media_file(_file_name: &str) -> io::Result<PathBuf> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "opening media is Windows only",
    ))
}

fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    job_store::write_bytes_atomic(path, bytes)
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> io::Result<()> {
    job_store::write_json_atomic(path, value)
}

fn read_job_state(path: &Path) -> Option<JobState> {
    job_store::read_json(path)
}

fn list_job_states_in(directory: &Path) -> io::Result<Vec<JobState>> {
    job_store::list_job_states_in(directory)
}

fn list_job_states() -> io::Result<Vec<JobState>> {
    list_job_states_in(&jobs_dir()?)
}

fn persist_job_state_in(directory: &Path, state: &mut JobState, updated_at: u64) -> io::Result<()> {
    job_store::persist_job_state_in(directory, state, updated_at)
}

fn command_tools() -> io::Result<(PathBuf, PathBuf, PathBuf)> {
    youtube::command_tools(&tools_dir()?)
}

fn youtube_info(request: &Request) -> Result<Value, String> {
    let tools = command_tools().map_err(|error| error.to_string())?;
    youtube::info(&request.url, tools)
}

fn initial_job_state(request: &Request) -> JobState {
    let media_download = request.kind == "media-download";
    JobState {
        job_id: request.job_id.clone(),
        job_type: media_download.then(|| "media".into()),
        request_id: None,
        candidate_id: media_download.then(|| request.candidate_id.clone()),
        source_language: None,
        target_language: None,
        input_kind: media_download.then(|| request.input_kind.clone()),
        output_format: None,
        execution_status: None,
        tab_id: None,
        frame_id: None,
        remote_job_id: None,
        phase: None,
        completed: None,
        total: None,
        model: None,
        status: "queued".into(),
        status_text: if media_download {
            "Segma Player 미디어 다운로드 대기 중…".into()
        } else {
            "Aura Companion 대기 중…".into()
        },
        title: media_download
            .then(|| request.title.trim().to_string())
            .filter(|title| !title.is_empty()),
        error: None,
        progress: None,
        file_name: None,
        created_at: now_millis(),
        updated_at: now_millis(),
    }
}

fn execute_download<F>(request: Request, jobs_directory: &Path, notify: F) -> io::Result<()>
where
    F: Fn(&JobState),
{
    if request.kind == "media-download" {
        let command = media_download_command_from_request(&request);
        let context = media_download::ExecutionContext {
            downloads: || aura_downloads_dir().map_err(|error| error.to_string()),
            tools_directory: || tools_dir().map_err(|error| error.to_string()),
            cancel_path: job_cancel_path(&request.job_id).ok(),
            pause_path: job_pause_path(&request.job_id).ok(),
            jobs_directory: jobs_directory.to_path_buf(),
        };
        media_download::execute(command, context, notify)
    } else {
        let job_id = request.job_id.clone();
        let cancel_job_id = job_id.clone();
        let context = youtube::ExecutionContext {
            tools: || command_tools().map_err(|error| error.to_string()),
            downloads: || aura_downloads_dir().map_err(|error| error.to_string()),
            cancel_path: move || job_cancel_path(&cancel_job_id).ok(),
            pause_path: move || job_pause_path(&job_id).ok(),
            jobs_directory: jobs_directory.to_path_buf(),
        };
        youtube::execute(request, context, notify)
    }
}

fn spawn_reserved_runner_with<F>(
    request_path: &Path,
    claim: job_store::RunnerClaim,
    spawn: F,
) -> io::Result<()>
where
    F: FnOnce(&[&str]) -> io::Result<()>,
{
    let request_path_text = request_path.to_string_lossy().into_owned();
    let token = claim.token().to_string();
    spawn(&["--run-job", &request_path_text, "--claim-token", &token])?;
    claim.handoff();
    Ok(())
}

fn spawn_job_runner_in_with<F>(directory: &Path, request: &Request, spawn: F) -> io::Result<()>
where
    F: FnOnce(&[&str]) -> io::Result<()>,
{
    let claim = job_store::reserve_runner_claim_in(directory, &request.job_id)?;
    let request_path = job_store::request_path_in(directory, &request.job_id)?;
    job_store::write_json_atomic(&request_path, request)?;
    let mut state = initial_job_state(request);
    job_store::persist_job_state_in(directory, &mut state, now_millis())?;
    if let Ok(cancel_path) = job_store::cancel_path_in(directory, &request.job_id) {
        let _ = fs::remove_file(cancel_path);
    }
    match spawn_reserved_runner_with(&request_path, claim, spawn) {
        Ok(()) => Ok(()),
        Err(error) => {
            state.status = "failed".into();
            state.status_text = "작업 실행기를 시작하지 못했습니다.".into();
            state.error = Some("job-start-failed".into());
            let _ = job_store::persist_job_state_in(directory, &mut state, now_millis());
            Err(error)
        }
    }
}

fn spawn_job_runner_with<F>(request: &Request, spawn: F) -> io::Result<()>
where
    F: FnOnce(&[&str]) -> io::Result<()>,
{
    spawn_job_runner_in_with(&jobs_dir()?, request, spawn)
}

fn spawn_job_runner(request: &Request) -> io::Result<()> {
    spawn_job_runner_with(request, process::spawn_detached)
}

/// Name of the GUI binary that owns the manager window.
///
/// The window lives in a separate crate (`companion-gui`) so the native
/// messaging host stays a small stdio process with no GUI dependencies.
fn spawn_manager() -> io::Result<()> {
    #[cfg(target_os = "windows")]
    if focus_existing_manager() {
        return Ok(());
    }
    let mut command = Command::new(manager_executable()?);
    process::apply_detached_creation_flags(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.spawn()?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn focus_existing_manager() -> bool {
    let title: Vec<u16> = "Segma Player\0".encode_utf16().collect();
    // SAFETY: `title` is a live, null-terminated UTF-16 buffer and the HWND is
    // only passed back to Win32 window-management functions.
    let window = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
    if window.is_null() {
        return false;
    }
    unsafe {
        if IsIconic(window) != 0 {
            ShowWindow(window, SW_RESTORE);
        }
        SetForegroundWindow(window);
    }
    true
}

/// Resolves the manager binary beside this executable, which is how the
/// installer lays both out. Falls back to an explicit error rather than
/// silently launching this host again with an argument it no longer handles.
#[cfg(target_os = "windows")]
fn manager_executable() -> io::Result<PathBuf> {
    let directory = env::current_exe()?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no install directory"))?;
    process::manager_executable_in(&directory)
}

#[cfg(not(target_os = "windows"))]
fn manager_executable() -> io::Result<PathBuf> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "the manager window is Windows only",
    ))
}

fn open_download_folder() -> io::Result<()> {
    let folder = aura_downloads_dir()?;
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer.exe");
        command.arg(folder);
        command.creation_flags(CREATE_NO_WINDOW);
        command.spawn()?;
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = folder;
        Ok(())
    }
}

fn companion_capabilities() -> &'static [&'static str] {
    &[
        "youtube",
        "youtube-info",
        "persistent-jobs",
        "local-writer",
        "manager-ui",
        "open-folder",
        "cancel",
        "pause",
        "resume",
        "retry",
        "set-download-folder",
        "play-file",
        "subtitle-url-jobs",
        "entitlement-status",
        "media-download-v1",
    ]
}

fn hello_response() -> Value {
    json!({
        "ok": true,
        "protocol": PROTOCOL_VERSION,
        "version": env!("CARGO_PKG_VERSION"),
        "capabilities": companion_capabilities(),
    })
}

fn run_native_host() {
    if let Ok(directory) = jobs_dir() {
        let _ = cleanup_stale_subtitle_requests_in(&directory, now_millis());
    }
    let mut legacy_writer = legacy_writer::Session::default();
    while let Ok(Some(request)) = read_message() {
        match request.kind.as_str() {
            "hello" => reply(&request, hello_response()),
            "status" => {
                let subtitle_ready = companion_root()
                    .ok()
                    .is_some_and(|root| read_companion_license_key(&root).is_ok());
                reply(
                    &request,
                    json!({
                        "ok": true,
                        "protocol": PROTOCOL_VERSION,
                        "version": env!("CARGO_PKG_VERSION"),
                        "toolsReady": command_tools().is_ok(),
                        "downloadsFolder": aura_downloads_dir().ok().map(|path| path.to_string_lossy().into_owned()),
                        "entitlementOwner": "companion",
                        "licenseConfigured": subtitle_ready,
                        "capabilities": companion_capabilities(),
                    }),
                )
            }
            "subtitle.create" => reply(&request, subtitle_create_response(&request)),
            "youtube-info" => match youtube_info(&request) {
                Ok(info) => reply(
                    &request,
                    json!({ "ok": true, "title": info["title"], "qualities": info["qualities"] }),
                ),
                Err(error) => reply(
                    &request,
                    json!({ "ok": false, "error": error, "errorCode": "youtube-info-failed" }),
                ),
            },
            "youtube-download" => {
                if safe_id(&request.job_id).is_none() || !valid_quality(&request.quality) {
                    reply(
                        &request,
                        json!({ "ok": false, "errorCode": "invalid-request", "error": "올바른 다운로드 요청이 아닙니다." }),
                    );
                    continue;
                }
                match spawn_job_runner(&request) {
                    Ok(()) => reply(
                        &request,
                        json!({ "ok": true, "accepted": true, "jobId": request.job_id }),
                    ),
                    Err(error) => reply(
                        &request,
                        json!({ "ok": false, "errorCode": "job-start-failed", "error": error.to_string() }),
                    ),
                }
            }
            "media-download" => {
                match validate_media_download_command(&request.raw_message, request.message_bytes) {
                    Ok(_) => match spawn_job_runner(&request) {
                        Ok(()) => reply(
                            &request,
                            json!({ "ok": true, "accepted": true, "jobId": request.job_id }),
                        ),
                        Err(error) => reply(
                            &request,
                            json!({ "ok": false, "errorCode": "job-start-failed", "error": error.to_string() }),
                        ),
                    },
                    Err(error) => reply(
                        &request,
                        json!({ "ok": false, "errorCode": error.code, "error": error.message }),
                    ),
                }
            }
            "list-jobs" => match list_job_states() {
                Ok(jobs) => reply(&request, json!({ "ok": true, "jobs": jobs })),
                Err(error) => reply(
                    &request,
                    json!({ "ok": false, "errorCode": "job-list-failed", "error": error.to_string() }),
                ),
            },
            "clear-terminal-history" => match jobs_dir()
                .and_then(|directory| job_store::clear_terminal_history_in(&directory))
            {
                Ok(count) => reply(&request, json!({ "ok": true, "cleared": count })),
                Err(error) => reply(
                    &request,
                    json!({
                        "ok": false,
                        "errorCode": "history-clear-failed",
                        "error": error.to_string()
                    }),
                ),
            },
            "cancel-job" => match job_cancel_path(&request.job_id) {
                Ok(path) => match fs::write(path, b"cancel") {
                    Ok(()) => reply(&request, json!({ "ok": true, "jobId": request.job_id })),
                    Err(error) => {
                        reply(&request, json!({ "ok": false, "error": error.to_string() }))
                    }
                },
                Err(error) => reply(&request, json!({ "ok": false, "error": error.to_string() })),
            },
            "pause-job" => match job_pause_path(&request.job_id) {
                Ok(path) => match fs::write(path, b"pause") {
                    Ok(()) => reply(&request, json!({ "ok": true, "jobId": request.job_id })),
                    Err(error) => {
                        reply(&request, json!({ "ok": false, "error": error.to_string() }))
                    }
                },
                Err(error) => reply(&request, json!({ "ok": false, "error": error.to_string() })),
            },
            // Resume and retry share `restart_job`; they differ only in intent,
            // so the reply echoes which one ran for clearer diagnostics.
            "resume-job" | "retry-job" => match restart_job(&request.job_id) {
                Ok(()) => reply(
                    &request,
                    json!({ "ok": true, "jobId": request.job_id, "action": request.kind }),
                ),
                Err(error) => reply(
                    &request,
                    json!({
                        "ok": false,
                        "errorCode": "job-restart-failed",
                        "error": error.to_string()
                    }),
                ),
            },
            "set-download-folder" => match companion_root()
                .and_then(|root| write_download_folder(&root, &request.folder))
            {
                Ok(path) => reply(
                    &request,
                    json!({
                        "ok": true,
                        "downloadsFolder": path.to_string_lossy().into_owned()
                    }),
                ),
                Err(error) => reply(
                    &request,
                    json!({
                        "ok": false,
                        "errorCode": "download-folder-rejected",
                        "error": error.to_string()
                    }),
                ),
            },
            "play-file" => match open_media_file(&request.filename) {
                Ok(path) => reply(
                    &request,
                    json!({ "ok": true, "path": path.to_string_lossy().into_owned() }),
                ),
                Err(error) => reply(
                    &request,
                    json!({
                        "ok": false,
                        "errorCode": "play-failed",
                        "error": error.to_string()
                    }),
                ),
            },
            "show-ui" => match spawn_manager() {
                Ok(()) => reply(&request, json!({ "ok": true })),
                // A host-only install has no window binary. Report that
                // explicitly instead of letting the click do nothing.
                Err(error) if error.kind() == io::ErrorKind::NotFound => reply(
                    &request,
                    json!({
                        "ok": false,
                        "errorCode": "manager-not-installed",
                        "error": "Segma Player 창 실행 파일이 없습니다. 앱을 다시 설치하세요."
                    }),
                ),
                Err(error) => reply(
                    &request,
                    json!({
                        "ok": false,
                        "errorCode": "manager-launch-failed",
                        "error": error.to_string()
                    }),
                ),
            },
            "open-folder" => match open_download_folder() {
                Ok(()) => reply(&request, json!({ "ok": true })),
                Err(error) => reply(&request, json!({ "ok": false, "error": error.to_string() })),
            },
            kind if kind.starts_with("media-") => {
                let response = legacy_writer::handle_request(
                    &request,
                    &mut legacy_writer,
                    aura_downloads_dir,
                    || {
                        let _ = spawn_manager();
                    },
                );
                reply(&request, response);
            }
            _ => reply(
                &request,
                json!({ "ok": false, "errorCode": "unsupported-request", "error": "지원하지 않는 Aura Companion 요청입니다." }),
            ),
        }
    }
    legacy_writer::disconnect(&mut legacy_writer);
}

fn run_job_from_path(path: &Path, claim_token: Option<&str>) -> io::Result<()> {
    let directory = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "jobs directory is unavailable"))?;
    let path_job_id = request_job_id_from_path(path)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid request path"))?;
    let mut claim = match claim_token {
        Some(token) => Some(job_store::adopt_runner_claim_in(
            directory,
            &path_job_id,
            token,
        )?),
        None => None,
    };
    let request: Request = match fs::read(path)
        .and_then(|bytes| serde_json::from_slice(&bytes).map_err(io::Error::other))
    {
        Ok(request) => request,
        Err(error) => {
            mark_bootstrap_failure(path, "job-request-invalid")?;
            return Err(error);
        }
    };
    if request.job_id != path_job_id {
        mark_bootstrap_failure(path, "job-request-id-mismatch")?;
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "job-request-id-mismatch",
        ));
    }
    if claim.is_none() {
        claim = match job_store::acquire_runner_claim_in(directory, &request.job_id) {
            Ok(claim) => Some(claim),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(()),
            Err(error) => {
                mark_job_failed_in(directory, &request, "job-claim-failed")?;
                return Err(error);
            }
        }
    }
    let _claim = claim.expect("runner claim is present");
    execute_download(request, directory, |_| {})
}

fn request_job_id_from_path(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_suffix(".request.json"))
        .and_then(safe_id)
}

fn mark_bootstrap_failure(path: &Path, code: &str) -> io::Result<()> {
    let directory = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "jobs directory is unavailable"))?;
    let Some(job_id) = request_job_id_from_path(path) else {
        return Ok(());
    };
    let mut state = read_job_state(&job_state_path_in(directory, &job_id)?).unwrap_or_default();
    state.job_id = job_id;
    state.status = "failed".into();
    state.status_text = "저장된 작업 요청을 시작하지 못했습니다.".into();
    state.error = Some(code.into());
    job_store::persist_job_state_in(directory, &mut state, now_millis())
}

fn mark_job_failed_in(directory: &Path, request: &Request, code: &str) -> io::Result<()> {
    let mut state = read_job_state(&job_state_path_in(directory, &request.job_id)?)
        .unwrap_or_else(|| initial_job_state(request));
    state.status = "failed".into();
    state.status_text = "작업 상태를 준비하지 못했습니다.".into();
    state.error = Some(code.into());
    job_store::persist_job_state_in(directory, &mut state, now_millis())
}

fn record_runner_failure(path: &Path, claim_token: Option<&str>, error: &io::Error) {
    let Some(directory) = path.parent() else {
        return;
    };
    let Some(job_id) = request_job_id_from_path(path) else {
        return;
    };
    // Token-launched children must still own the reservation. A mismatch means
    // another runner owns the job and its state must remain untouched.
    if let Some(token) = claim_token {
        let Ok(claim) = job_store::adopt_runner_claim_in(directory, &job_id, token) else {
            return;
        };
        drop(claim);
    } else if job_store::runner_claim_path_in(directory, &job_id).is_ok_and(|path| path.exists()) {
        return;
    }
    let Ok(state_path) = job_state_path_in(directory, &job_id) else {
        return;
    };
    let mut state = read_job_state(&state_path).unwrap_or_default();
    state.job_id = job_id;
    state.status = "failed".into();
    state.status_text = "작업 상태를 저장하지 못해 실행을 중단했습니다.".into();
    state.error = Some(format!("job-state-persist-failed: {error}"));
    let _ = job_store::persist_job_state_in(directory, &mut state, now_millis());
}

fn run_subtitle_job_from_path(path: &Path) -> io::Result<()> {
    let directory = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "subtitle jobs directory is unavailable",
        )
    })?;
    let companion_root = directory
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Companion root is unavailable"))?;
    subtitle::run_from_path(
        path,
        subtitle::Context {
            jobs_directory: directory.to_path_buf(),
            companion_root: companion_root.to_path_buf(),
            output_directory: || {
                aura_subtitles_dir().map_err(|_| {
                    run_error("subtitle-save-failed", "subtitle file could not be saved")
                })
            },
        },
    )
}

fn main() {
    let args = env::args_os().collect::<Vec<_>>();
    if args.get(1).and_then(|value| value.to_str()) == Some("--run-job") {
        if let Some(path) = args.get(2) {
            let claim_token = (args.get(3).and_then(|value| value.to_str())
                == Some("--claim-token"))
            .then(|| args.get(4).and_then(|value| value.to_str()))
            .flatten();
            let path = Path::new(path);
            if let Err(error) = run_job_from_path(path, claim_token) {
                record_runner_failure(path, claim_token, &error);
            }
        }
        return;
    }
    if args.get(1).and_then(|value| value.to_str()) == Some("--run-subtitle-job") {
        if let Some(path) = args.get(2) {
            let _ = run_subtitle_job_from_path(Path::new(path));
        }
        return;
    }
    if args.get(1).and_then(|value| value.to_str()) == Some("--manager") {
        // The manager window moved to the `companion-gui` crate. Keep this arm
        // so an old Start Menu shortcut still opens the window instead of
        // silently starting a stdio host with no browser attached.
        let _ = spawn_manager();
        return;
    }
    run_native_host();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::collections::VecDeque;
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex;

    fn sample_command() -> Value {
        json!({
            "protocolVersion": 1,
            "type": "subtitle.create",
            "requestId": "request-123",
            "candidateId": "candidate-123",
            "sourceLanguage": "ja",
            "targetLanguage": "ko",
            "mode": "generate",
            "media": {
                "type": "hls",
                "title": "Sample video",
                "pageUrl": "https://page.example/video",
                "resourceUrl": "https://media.example/master.m3u8",
                "audioRenditionUrl": "https://media.example/audio.m3u8"
            },
            "sourceContext": {
                "tabId": 123,
                "frameId": 7,
                "contextLeaseId": "lease-123"
            }
        })
    }

    fn sample_request() -> Request {
        let bytes = serde_json::to_vec(&sample_command()).expect("sample command serializes");
        parse_request_bytes(&bytes).expect("sample command parses")
    }

    fn test_directory() -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "aura-subtitle-test-{}-{}",
            std::process::id(),
            NEXT_SUBTITLE_JOB_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&directory).expect("test directory creates");
        directory
    }

    struct FakeSubtitleTransport {
        submit_result: Result<SubtitleSubmitResult, SubtitleRunError>,
        polls: Mutex<VecDeque<Result<SubtitlePollResult, SubtitleRunError>>>,
        submit_calls: AtomicUsize,
        cancel_calls: Mutex<Vec<(String, String)>>,
        cancel_result: Result<SubtitleCancelStatus, SubtitleRunError>,
        cancel_marker_on_poll: Option<PathBuf>,
    }

    impl FakeSubtitleTransport {
        fn new(
            submit_result: Result<SubtitleSubmitResult, SubtitleRunError>,
            polls: Vec<Result<SubtitlePollResult, SubtitleRunError>>,
        ) -> Self {
            Self {
                submit_result,
                polls: Mutex::new(VecDeque::from(polls)),
                submit_calls: AtomicUsize::new(0),
                cancel_calls: Mutex::new(Vec::new()),
                cancel_result: Ok(SubtitleCancelStatus::Cancelled),
                cancel_marker_on_poll: None,
            }
        }
    }

    impl SubtitleTransport for FakeSubtitleTransport {
        fn submit(
            &self,
            _envelope: &SubtitleRequestEnvelope,
            _license_key: &str,
            _audio_path: Option<&Path>,
        ) -> Result<SubtitleSubmitResult, SubtitleRunError> {
            self.submit_calls.fetch_add(1, Ordering::Relaxed);
            self.submit_result.clone()
        }

        fn poll(
            &self,
            _remote_job_id: &str,
            _license_key: &str,
        ) -> Result<SubtitlePollResult, SubtitleRunError> {
            if let Some(path) = self.cancel_marker_on_poll.as_ref() {
                fs::write(path, b"cancel").expect("cancel marker writes");
            }
            self.polls
                .lock()
                .expect("poll queue locks")
                .pop_front()
                .unwrap_or_else(|| {
                    Err(run_error(
                        "subtitle-test-poll-exhausted",
                        "subtitle test poll queue exhausted",
                    ))
                })
        }

        fn cancel(
            &self,
            remote_job_id: &str,
            license_key: &str,
        ) -> Result<SubtitleCancelStatus, SubtitleRunError> {
            self.cancel_calls
                .lock()
                .expect("cancel calls lock")
                .push((remote_job_id.to_string(), license_key.to_string()));
            self.cancel_result
        }
    }

    fn running_poll(progress: u8) -> SubtitlePollResult {
        SubtitlePollResult {
            status: "running".into(),
            phase: Some("transcribing".into()),
            progress: Some(progress),
            completed: Some(1),
            total: Some(2),
            result: None,
        }
    }

    fn completed_poll(vtt: String) -> SubtitlePollResult {
        SubtitlePollResult {
            status: "completed".into(),
            phase: Some("finalizing".into()),
            progress: Some(100),
            completed: Some(2),
            total: Some(2),
            result: Some(SubtitleResult {
                vtt,
                model: Some("test-model".into()),
            }),
        }
    }

    fn subtitle_run_fixture(
        with_license: bool,
    ) -> (PathBuf, PathBuf, PathBuf, SubtitleRequestEnvelope) {
        let root = test_directory();
        let jobs = root.join("jobs");
        let output = root.join("output");
        fs::create_dir_all(&jobs).expect("jobs directory creates");
        if with_license {
            fs::write(
                settings_path(&root),
                serde_json::to_vec(&json!({
                    "licenseKey": format!("AM-{}", "A".repeat(36)),
                    "licenseEdition": "pro",
                    "licenseStatus": "approved"
                }))
                .expect("settings serialize"),
            )
            .expect("settings write");
        }
        let command = parse_subtitle_command_bytes(
            &serde_json::to_vec(&sample_command()).expect("command serializes"),
        )
        .expect("command parses");
        let state = start_subtitle_job_in(&jobs, &command, 10, |_| Ok(()))
            .expect("subtitle fixture starts");
        let request_path = subtitle_request_path_in(&jobs, &state.job_id).expect("request path");
        let envelope = serde_json::from_slice(&fs::read(request_path).expect("request reads"))
            .expect("request parses");
        (root, jobs, output, envelope)
    }

    fn test_run_policy() -> SubtitleRunPolicy {
        SubtitleRunPolicy {
            poll_interval: Duration::ZERO,
            max_runtime: Duration::from_secs(1),
            max_polls: Some(8),
        }
    }

    #[test]
    fn validates_supported_quality_caps() {
        assert_eq!(youtube::quality_height("4320"), Some(4320));
        assert_eq!(youtube::quality_height("1080"), Some(1080));
        assert_eq!(youtube::quality_height("best"), None);
        assert!(valid_quality("best"));
        assert!(valid_quality("144"));
        assert!(!valid_quality("123"));
    }

    #[test]
    fn validates_job_ids() {
        assert_eq!(safe_id("abc-123_xyz").as_deref(), Some("abc-123_xyz"));
        assert!(safe_id("../escape").is_none());
        assert!(safe_id("").is_none());
    }

    #[test]
    fn parses_progress_lines() {
        assert_eq!(
            youtube::parse_progress(" 72.4% 12.0MiB/s ETA 00:12"),
            Some(72)
        );
        assert_eq!(youtube::parse_progress("unknown"), None);
    }

    #[test]
    fn accepts_valid_subtitle_command_and_persists_pending_boundary() {
        let request = sample_request();
        let command = parse_subtitle_command_bytes(
            serde_json::to_vec(&request.raw_message)
                .expect("request message serializes")
                .as_slice(),
        )
        .expect("valid subtitle command accepts");
        assert_eq!(command.source_language, "ja");

        let directory = test_directory();
        let response = subtitle_create_response_in(&request, &directory, 100);
        assert_eq!(response["ok"], true);
        assert_eq!(response["accepted"], true);
        assert_eq!(response["status"], "preparing");
        assert_eq!(response["executionStatus"], "started");
        let job_id = response["jobId"].as_str().expect("job id in response");
        let state = read_job_state(&job_state_path_in(&directory, job_id).expect("safe job path"))
            .expect("created state is readable");
        assert_eq!(state.job_type.as_deref(), Some("subtitle"));
        assert_eq!(state.status, "preparing");
        assert_eq!(state.execution_status.as_deref(), Some("started"));
        let request_path = subtitle_request_path_in(&directory, job_id).expect("request path");
        let envelope = fs::read_to_string(request_path).expect("active envelope is readable");
        assert!(envelope.contains("https://media.example/master.m3u8"));
        assert!(!envelope.contains("licenseKey"));
        fs::remove_dir_all(directory).expect("test directory removes");
    }

    #[test]
    fn rejects_subtitle_protocol_version_and_language() {
        let mut wrong_version = sample_command();
        wrong_version["protocolVersion"] = json!(2);
        let version_error = parse_subtitle_command_bytes(
            serde_json::to_vec(&wrong_version)
                .expect("version command serializes")
                .as_slice(),
        )
        .expect_err("wrong version rejects");
        assert_eq!(version_error.code, "subtitle-protocol-version-unsupported");

        let mut wrong_language = sample_command();
        wrong_language["sourceLanguage"] = json!("fr");
        let language_error = parse_subtitle_command_bytes(
            serde_json::to_vec(&wrong_language)
                .expect("language command serializes")
                .as_slice(),
        )
        .expect_err("wrong language rejects");
        assert_eq!(language_error.code, "unsupported-subtitle-language");

        let mut missing_request_id = sample_command();
        missing_request_id["requestId"] = json!("");
        let request_id_error = parse_subtitle_command_bytes(
            serde_json::to_vec(&missing_request_id)
                .expect("request id command serializes")
                .as_slice(),
        )
        .expect_err("missing request id rejects");
        assert_eq!(request_id_error.code, "invalid-subtitle-request-id");
    }

    #[test]
    fn rejects_sensitive_headers_and_oversized_payloads() {
        let mut sensitive = sample_command();
        sensitive["media"]["headers"] = json!({ "Authorization": "Bearer secret" });
        let sensitive_error = parse_subtitle_command_bytes(
            serde_json::to_vec(&sensitive)
                .expect("sensitive command serializes")
                .as_slice(),
        )
        .expect_err("sensitive headers reject");
        assert_eq!(sensitive_error.code, "sensitive-header-rejected");

        let mut oversized = sample_command();
        oversized["media"]["title"] = Value::String("x".repeat(MAX_SUBTITLE_MESSAGE_BYTES));
        let oversized_error = parse_subtitle_command_bytes(
            serde_json::to_vec(&oversized)
                .expect("oversized command serializes")
                .as_slice(),
        )
        .expect_err("oversized payload rejects");
        assert_eq!(oversized_error.code, "subtitle-payload-too-large");

        let mut oversized_url = sample_command();
        oversized_url["media"]["resourceUrl"] = Value::String(format!(
            "https://media.example/{}",
            "x".repeat(subtitle::MAX_URL_BYTES)
        ));
        let url_error = parse_subtitle_command_bytes(
            serde_json::to_vec(&oversized_url)
                .expect("oversized URL command serializes")
                .as_slice(),
        )
        .expect_err("oversized URL rejects");
        assert_eq!(url_error.code, "invalid-subtitle-media");

        let mut oversized_title = sample_command();
        oversized_title["media"]["title"] = Value::String("x".repeat(MAX_SUBTITLE_TITLE_BYTES + 1));
        let title_error = parse_subtitle_command_bytes(
            serde_json::to_vec(&oversized_title)
                .expect("oversized title command serializes")
                .as_slice(),
        )
        .expect_err("oversized title rejects");
        assert_eq!(title_error.code, "invalid-subtitle-media");

        for unsafe_url in [
            "http://127.0.0.1/private",
            "http://192.168.1.20/private",
            "https://user:pass@media.example/video",
            "https://media.example/video#secret",
            "https://localhost/video",
        ] {
            let mut unsafe_command = sample_command();
            unsafe_command["media"]["resourceUrl"] = json!(unsafe_url);
            let error = parse_subtitle_command_bytes(
                &serde_json::to_vec(&unsafe_command).expect("unsafe URL command serializes"),
            )
            .expect_err("unsafe URL rejects");
            assert_eq!(error.code, "invalid-subtitle-media", "{unsafe_url}");
        }
    }

    #[test]
    fn persists_state_transitions_and_reads_after_restart() {
        let directory = test_directory();
        let command = parse_subtitle_command_bytes(
            serde_json::to_vec(&sample_command())
                .expect("command serializes")
                .as_slice(),
        )
        .expect("command parses");
        let mut completed =
            create_subtitle_job_in(&directory, &command, "subtitle-complete".into(), 10)
                .expect("created state persists");
        for (status, timestamp) in [
            ("preparing", 20),
            ("submitting", 30),
            ("running", 40),
            ("completed", 50),
        ] {
            transition_subtitle_job_state_in(&directory, &mut completed, status, status, timestamp)
                .expect("valid state transition persists");
            let on_disk = read_job_state(
                &job_state_path_in(&directory, &completed.job_id).expect("safe state path"),
            )
            .expect("state remains readable");
            assert_eq!(on_disk.status, status);
            assert_eq!(on_disk.updated_at, timestamp);
        }
        drop(completed);
        let restarted = list_job_states_in(&directory).expect("restart state listing succeeds");
        assert_eq!(restarted[0].status, "completed");

        let mut failed = create_subtitle_job_in(&directory, &command, "subtitle-failed".into(), 60)
            .expect("failed state creates");
        transition_subtitle_job_state_in(&directory, &mut failed, "failed", "failed", 70)
            .expect("failed transition persists");
        let mut cancelled =
            create_subtitle_job_in(&directory, &command, "subtitle-cancelled".into(), 80)
                .expect("cancelled state creates");
        transition_subtitle_job_state_in(&directory, &mut cancelled, "cancelled", "cancelled", 90)
            .expect("cancelled transition persists");
        let states = list_job_states_in(&directory).expect("all states list");
        assert!(states.iter().any(|state| state.status == "failed"));
        assert!(states.iter().any(|state| state.status == "cancelled"));
        fs::remove_dir_all(directory).expect("test directory removes");
    }

    #[test]
    fn legacy_youtube_job_state_without_subtitle_fields_remains_readable() {
        let directory = test_directory();
        fs::write(
            directory.join("youtube-legacy.state.json"),
            serde_json::to_vec(&json!({
                "jobId": "youtube-legacy",
                "status": "completed",
                "statusText": "done",
                "updatedAt": 42,
                "title": "Legacy",
                "fileName": "legacy.mp4"
            }))
            .expect("legacy state serializes"),
        )
        .expect("legacy state writes");
        let states = list_job_states_in(&directory).expect("legacy state lists");
        assert_eq!(states.len(), 1);
        assert_eq!(states[0].job_id, "youtube-legacy");
        assert_eq!(states[0].status, "completed");
        assert!(states[0].job_type.is_none());
        fs::remove_dir_all(directory).expect("test directory removes");
    }

    #[test]
    fn subtitle_runner_submits_polls_normalizes_and_saves_vtt() {
        let (root, jobs, output, envelope) = subtitle_run_fixture(true);
        let transport = FakeSubtitleTransport::new(
            Ok(SubtitleSubmitResult {
                remote_job_id: "modal-job-1".into(),
            }),
            vec![
                Ok(running_poll(55)),
                Ok(completed_poll(
                    "\u{feff}WEBVTT\r\n\r\n00:00.000 --> 00:01.000\r\nHello\r\n".into(),
                )),
            ],
        );

        run_subtitle_job_with_transport(
            &transport,
            &envelope,
            &root,
            &jobs,
            &output,
            test_run_policy(),
        )
        .expect("subtitle run succeeds");

        assert_eq!(transport.submit_calls.load(Ordering::Relaxed), 1);
        assert!(transport
            .cancel_calls
            .lock()
            .expect("cancel calls lock")
            .is_empty());
        let state =
            read_job_state(&job_state_path_in(&jobs, &envelope.job_id).expect("state path"))
                .expect("completed state reads");
        assert_eq!(state.status, "completed");
        assert_eq!(state.remote_job_id.as_deref(), Some("modal-job-1"));
        assert_eq!(state.model.as_deref(), Some("test-model"));
        assert_eq!(state.progress, Some(100));
        let saved = fs::read_to_string(output.join(state.file_name.expect("file name")))
            .expect("saved VTT reads");
        assert_eq!(saved, "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n");
        assert!(!subtitle_request_path_in(&jobs, &envelope.job_id)
            .expect("request path")
            .exists());
        fs::remove_dir_all(root).expect("test root removes");
    }

    #[test]
    fn local_subtitle_audio_extraction_matches_modal_duration_limit() {
        let mut command = Command::new("ffmpeg.exe");
        configure_local_subtitle_audio_command(
            &mut command,
            Path::new("input.mp4"),
            Path::new("output.m4a"),
        );
        let arguments = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let duration_index = arguments
            .iter()
            .position(|argument| argument == "-t")
            .expect("subtitle extraction has a duration limit");
        assert_eq!(
            arguments.get(duration_index + 1).map(String::as_str),
            Some("3600")
        );
        assert_eq!(arguments.last().map(String::as_str), Some("output.m4a"));
    }

    #[test]
    fn subtitle_submit_preserves_server_error_code_and_safe_persisted_text() {
        let error = parse_submit_response(
            StatusCode::BAD_REQUEST,
            json!({ "ok": false, "error": "audio-size-mismatch" }),
        )
        .expect_err("server rejection is returned");
        assert_eq!(error.code, "audio-size-mismatch");
        assert_eq!(error.message, "subtitle audio upload size did not match");

        let (root, jobs, output, envelope) = subtitle_run_fixture(true);
        let transport = FakeSubtitleTransport::new(Err(error), vec![]);
        let run_error = run_subtitle_job_with_transport(
            &transport,
            &envelope,
            &root,
            &jobs,
            &output,
            test_run_policy(),
        )
        .expect_err("rejected upload fails the job");
        assert_eq!(run_error.code, "audio-size-mismatch");
        let state_path = job_state_path_in(&jobs, &envelope.job_id).expect("state path");
        let state = read_job_state(&state_path).expect("failed state reads");
        assert_eq!(state.status, "failed");
        assert_eq!(state.error.as_deref(), Some("audio-size-mismatch"));
        assert_eq!(
            state.status_text,
            "subtitle audio upload size did not match"
        );
        let serialized = fs::read_to_string(state_path).expect("state JSON reads");
        assert!(!serialized.contains("https://"));
        assert!(!serialized.contains("AM-"));
        fs::remove_dir_all(root).expect("test root removes");
    }

    #[test]
    fn subtitle_http_boundaries_preserve_known_server_error_codes() {
        for (status, code) in [
            (StatusCode::UNAUTHORIZED, "unauthorized"),
            (StatusCode::TOO_MANY_REQUESTS, "rate-limited"),
            (StatusCode::SERVICE_UNAVAILABLE, "asr-not-configured"),
            (StatusCode::BAD_GATEWAY, "asr-upstream-unreachable"),
            (StatusCode::INTERNAL_SERVER_ERROR, "job-failed"),
        ] {
            let error = parse_submit_response(status, json!({ "ok": false, "error": code }))
                .expect_err("known server error rejects");
            assert_eq!(error.code, code, "server code {code} must survive");
            assert!(!error.message.contains("http"));
            assert!(!error.message.contains("AM-"));
        }
    }

    #[test]
    fn completed_poll_preserves_nested_modal_error() {
        let error = parse_poll_response(
            StatusCode::OK,
            json!({
                "ok": true,
                "status": "completed",
                "result": { "ok": false, "error": "audio-input-missing" }
            }),
        )
        .expect_err("failed Modal result rejects instead of becoming invalid VTT");
        assert_eq!(error.code, "audio-input-missing");
        assert_eq!(error.message, "subtitle audio input was missing");

        let (root, jobs, output, envelope) = subtitle_run_fixture(true);
        let transport = FakeSubtitleTransport::new(
            Ok(SubtitleSubmitResult {
                remote_job_id: "modal-job-nested-error".into(),
            }),
            vec![Err(error)],
        );
        let run_error = run_subtitle_job_with_transport(
            &transport,
            &envelope,
            &root,
            &jobs,
            &output,
            test_run_policy(),
        )
        .expect_err("nested Modal failure reaches the runner");
        assert_eq!(run_error.code, "audio-input-missing");
        let state_path = job_state_path_in(&jobs, &envelope.job_id).expect("state path");
        let state = read_job_state(&state_path).expect("failed state reads");
        assert_eq!(state.status, "failed");
        assert_eq!(state.error.as_deref(), Some("audio-input-missing"));
        assert_eq!(state.status_text, "subtitle audio input was missing");
        let serialized = fs::read_to_string(state_path).expect("state JSON reads");
        assert!(!serialized.contains("https://"));
        assert!(!serialized.contains("AM-"));
        fs::remove_dir_all(root).expect("test root removes");
    }

    #[test]
    fn subtitle_runner_requires_companion_entitlement_and_redacts_failures() {
        let (root, jobs, output, envelope) = subtitle_run_fixture(false);
        let transport = FakeSubtitleTransport::new(
            Ok(SubtitleSubmitResult {
                remote_job_id: "unused".into(),
            }),
            vec![],
        );
        let error = run_subtitle_job_with_transport(
            &transport,
            &envelope,
            &root,
            &jobs,
            &output,
            test_run_policy(),
        )
        .expect_err("missing license rejects");
        assert_eq!(error.code, "pro-license-required");
        assert_eq!(transport.submit_calls.load(Ordering::Relaxed), 0);
        let state_path = job_state_path_in(&jobs, &envelope.job_id).expect("state path");
        let state = read_job_state(&state_path).expect("failed state reads");
        assert_eq!(state.status, "failed");
        assert_eq!(state.error.as_deref(), Some("pro-license-required"));
        let serialized = fs::read_to_string(state_path).expect("state JSON reads");
        assert!(!serialized.contains("media.example"));
        assert!(!serialized.contains("AM-"));
        assert!(!subtitle_request_path_in(&jobs, &envelope.job_id)
            .expect("request path")
            .exists());
        fs::remove_dir_all(root).expect("test root removes");
    }

    #[test]
    fn subtitle_runner_normalizes_service_failures_without_leaking_input() {
        let (root, jobs, output, envelope) = subtitle_run_fixture(true);
        let transport = FakeSubtitleTransport::new(
            Err(run_error(
                "subtitle-service-unavailable",
                "subtitle service is unavailable",
            )),
            vec![],
        );
        let error = run_subtitle_job_with_transport(
            &transport,
            &envelope,
            &root,
            &jobs,
            &output,
            test_run_policy(),
        )
        .expect_err("service failure rejects");
        assert_eq!(error.code, "subtitle-service-unavailable");
        let state_path = job_state_path_in(&jobs, &envelope.job_id).expect("state path");
        let serialized = fs::read_to_string(state_path).expect("state JSON reads");
        assert!(!serialized.contains("https://"));
        assert!(!serialized.contains("AM-"));
        assert!(!subtitle_request_path_in(&jobs, &envelope.job_id)
            .expect("request path")
            .exists());
        fs::remove_dir_all(root).expect("test root removes");
    }

    #[test]
    fn subtitle_runner_cancels_remote_compute_and_cleans_active_request() {
        let (root, jobs, output, envelope) = subtitle_run_fixture(true);
        let cancel_path = job_cancel_path_in(&jobs, &envelope.job_id).expect("cancel path");
        let mut transport = FakeSubtitleTransport::new(
            Ok(SubtitleSubmitResult {
                remote_job_id: "modal-job-cancel".into(),
            }),
            vec![Ok(running_poll(25))],
        );
        transport.cancel_marker_on_poll = Some(cancel_path);

        run_subtitle_job_with_transport(
            &transport,
            &envelope,
            &root,
            &jobs,
            &output,
            test_run_policy(),
        )
        .expect("cancellation is terminal success");
        let calls = transport.cancel_calls.lock().expect("cancel calls lock");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "modal-job-cancel");
        assert!(valid_license_key(&calls[0].1));
        drop(calls);
        let state =
            read_job_state(&job_state_path_in(&jobs, &envelope.job_id).expect("state path"))
                .expect("cancelled state reads");
        assert_eq!(state.status, "cancelled");
        assert!(!subtitle_request_path_in(&jobs, &envelope.job_id)
            .expect("request path")
            .exists());
        assert!(!job_cancel_path_in(&jobs, &envelope.job_id)
            .expect("cancel path")
            .exists());
        fs::remove_dir_all(root).expect("test root removes");
    }

    #[test]
    fn subtitle_runner_reports_remote_cancel_failure_instead_of_false_success() {
        let (root, jobs, output, envelope) = subtitle_run_fixture(true);
        let cancel_path = job_cancel_path_in(&jobs, &envelope.job_id).expect("cancel path");
        let mut transport = FakeSubtitleTransport::new(
            Ok(SubtitleSubmitResult {
                remote_job_id: "modal-job-cancel-failure".into(),
            }),
            vec![Ok(running_poll(25))],
        );
        transport.cancel_marker_on_poll = Some(cancel_path);
        transport.cancel_result = Err(run_error(
            "subtitle-service-unavailable",
            "subtitle service is unavailable",
        ));

        let error = run_subtitle_job_with_transport(
            &transport,
            &envelope,
            &root,
            &jobs,
            &output,
            test_run_policy(),
        )
        .expect_err("cancel failure is reported");
        assert_eq!(error.code, "subtitle-cancel-failed");
        let state =
            read_job_state(&job_state_path_in(&jobs, &envelope.job_id).expect("state path"))
                .expect("failed state reads");
        assert_eq!(state.status, "failed");
        assert_eq!(state.error.as_deref(), Some("subtitle-cancel-failed"));
        fs::remove_dir_all(root).expect("test root removes");
    }

    #[test]
    fn completed_poll_wins_a_simultaneous_cancel_race() {
        let (root, jobs, output, envelope) = subtitle_run_fixture(true);
        let cancel_path = job_cancel_path_in(&jobs, &envelope.job_id).expect("cancel path");
        let mut transport = FakeSubtitleTransport::new(
            Ok(SubtitleSubmitResult {
                remote_job_id: "modal-job-completed-race".into(),
            }),
            vec![Ok(completed_poll(
                "WEBVTT\n\n00:00.000 --> 00:01.000\nDone\n".into(),
            ))],
        );
        transport.cancel_marker_on_poll = Some(cancel_path);

        run_subtitle_job_with_transport(
            &transport,
            &envelope,
            &root,
            &jobs,
            &output,
            test_run_policy(),
        )
        .expect("completed result is saved");
        assert!(transport
            .cancel_calls
            .lock()
            .expect("cancel calls lock")
            .is_empty());
        let state =
            read_job_state(&job_state_path_in(&jobs, &envelope.job_id).expect("state path"))
                .expect("completed state reads");
        assert_eq!(state.status, "completed");
        assert!(output.join(state.file_name.expect("file name")).exists());
        fs::remove_dir_all(root).expect("test root removes");
    }

    #[test]
    fn subtitle_runner_honors_local_cancel_before_reading_entitlement() {
        let (root, jobs, output, envelope) = subtitle_run_fixture(false);
        fs::write(
            job_cancel_path_in(&jobs, &envelope.job_id).expect("cancel path"),
            b"cancel",
        )
        .expect("cancel marker writes");
        let transport = FakeSubtitleTransport::new(
            Ok(SubtitleSubmitResult {
                remote_job_id: "unused".into(),
            }),
            vec![],
        );
        run_subtitle_job_with_transport(
            &transport,
            &envelope,
            &root,
            &jobs,
            &output,
            test_run_policy(),
        )
        .expect("pre-submit cancellation succeeds");
        assert_eq!(transport.submit_calls.load(Ordering::Relaxed), 0);
        assert!(transport
            .cancel_calls
            .lock()
            .expect("cancel calls lock")
            .is_empty());
        let state =
            read_job_state(&job_state_path_in(&jobs, &envelope.job_id).expect("state path"))
                .expect("cancelled state reads");
        assert_eq!(state.status, "cancelled");
        assert!(!subtitle_request_path_in(&jobs, &envelope.job_id)
            .expect("request path")
            .exists());
        fs::remove_dir_all(root).expect("test root removes");
    }

    #[test]
    fn stale_subtitle_request_files_are_removed_after_the_crash_retention_window() {
        let (root, jobs, _output, envelope) = subtitle_run_fixture(true);
        let state_path = job_state_path_in(&jobs, &envelope.job_id).expect("state path");
        let mut state = read_job_state(&state_path).expect("state reads");
        state.updated_at = 1;
        persist_job_state_in(&jobs, &mut state, 1).expect("old state persists");
        assert!(subtitle_request_path_in(&jobs, &envelope.job_id)
            .expect("request path")
            .exists());
        cleanup_stale_subtitle_requests_in(&jobs, SUBTITLE_ACTIVE_MAX_AGE_MS + 2)
            .expect("stale request cleanup succeeds");
        assert!(!subtitle_request_path_in(&jobs, &envelope.job_id)
            .expect("request path")
            .exists());
        let state = read_job_state(&state_path).expect("expired state reads");
        assert_eq!(state.status, "failed");
        assert_eq!(state.error.as_deref(), Some("subtitle-interrupted"));
        fs::remove_dir_all(root).expect("test root removes");
    }

    #[test]
    fn subtitle_vtt_validation_rejects_malformed_and_oversized_results() {
        let directory = test_directory();
        for vtt in [
            "WEBVTT\n\nnot a cue".to_string(),
            "WEBVTT\n\n00:02.000 --> 00:01.000\nbackwards".to_string(),
            "WEBVTT\n\n00:00.000 --> 00:01.000\n".to_string(),
            "WEBVTT\n\n18446744073709551615:59:59.999 --> 18446744073709551615:59:59.999\nlarge"
                .to_string(),
            format!(
                "WEBVTT\n\n00:00.000 --> 00:01.000\n{}",
                "x".repeat(MAX_SUBTITLE_RESULT_BYTES)
            ),
        ] {
            let error =
                save_subtitle_result_in(&directory, "test", &vtt).expect_err("invalid VTT rejects");
            assert_eq!(error.code, "subtitle-invalid-vtt");
        }
        assert!(fs::read_dir(&directory)
            .expect("test directory lists")
            .next()
            .is_none());
        fs::remove_dir_all(directory).expect("test directory removes");
    }

    #[test]
    fn subtitle_output_allocation_keeps_same_title_results_separate() {
        let directory = test_directory();
        let vtt = "WEBVTT\n\n00:00.000 --> 00:01.000\nText\n";
        let first =
            save_subtitle_result_in(&directory, "Same title", vtt).expect("first subtitle saves");
        let second =
            save_subtitle_result_in(&directory, "Same title", vtt).expect("second subtitle saves");
        assert_ne!(first, second);
        assert!(directory.join(first).exists());
        assert!(directory.join(second).exists());
        fs::remove_dir_all(directory).expect("test directory removes");
    }

    #[test]
    fn cancel_marker_uses_the_path_the_download_loop_polls() {
        let directory = test_directory();
        fs::create_dir_all(&directory).expect("jobs directory creates");
        let path = job_cancel_path_in(&directory, "job-abc").expect("cancel path resolves");
        fs::write(&path, b"cancel").expect("cancel marker writes");
        assert!(path.exists());
        assert_eq!(
            path.file_name().and_then(|value| value.to_str()),
            Some("job-abc.cancel")
        );
        fs::remove_dir_all(directory).expect("test directory removes");
    }

    #[test]
    fn cancel_marker_rejects_an_unsafe_job_id() {
        let directory = test_directory();
        assert!(job_cancel_path_in(&directory, "../escape").is_err());
        assert!(job_cancel_path_in(&directory, "").is_err());
    }

    #[test]
    fn pause_and_cancel_use_distinct_markers() {
        let directory = test_directory();
        fs::create_dir_all(&directory).expect("jobs directory creates");
        let pause = job_pause_path_in(&directory, "job-abc").expect("pause path resolves");
        let cancel = job_cancel_path_in(&directory, "job-abc").expect("cancel path resolves");
        assert_ne!(pause, cancel);
        assert_eq!(
            pause.file_name().and_then(|value| value.to_str()),
            Some("job-abc.pause")
        );
        fs::remove_dir_all(directory).expect("test directory removes");
    }

    #[test]
    fn pause_marker_rejects_an_unsafe_job_id() {
        let directory = test_directory();
        for bad in ["../escape", "a/b", "a\\b", ""] {
            assert!(
                job_pause_path_in(&directory, bad).is_err(),
                "job id {bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn a_settings_download_folder_must_be_absolute_and_traversal_free() {
        assert!(valid_download_folder("relative\\path").is_none());
        assert!(valid_download_folder("").is_none());
        assert!(valid_download_folder("   ").is_none());
        assert!(valid_download_folder("C:\\Media\\..\\Windows").is_none());
        assert!(valid_download_folder("C:\\Media\\Aura\u{0}").is_none());

        let accepted = valid_download_folder("C:\\Media\\Aura").expect("absolute path is accepted");
        assert_eq!(accepted, PathBuf::from("C:\\Media\\Aura"));
        assert_eq!(
            valid_download_folder("  C:\\Media\\Aura  "),
            Some(PathBuf::from("C:\\Media\\Aura"))
        );
    }

    #[test]
    fn writing_the_download_folder_preserves_other_settings() {
        let root = test_directory();
        fs::create_dir_all(&root).expect("root creates");
        fs::write(
            settings_path(&root),
            br#"{"licenseKey":"AM-0123456789ABCDEF0123456789ABCDEF012","other":7}"#,
        )
        .expect("existing settings write");

        let target = root.join("media");
        let written = write_download_folder(&root, &target.to_string_lossy())
            .expect("download folder writes");
        assert_eq!(written, target);
        assert!(target.is_dir(), "the folder is created if missing");

        let document: Value =
            serde_json::from_slice(&fs::read(settings_path(&root)).expect("settings read"))
                .expect("settings parse");
        assert_eq!(
            document["downloadFolder"].as_str(),
            Some(target.to_string_lossy().as_ref())
        );
        assert_eq!(
            document["licenseKey"].as_str(),
            Some("AM-0123456789ABCDEF0123456789ABCDEF012"),
            "the license key must survive a folder change"
        );
        assert_eq!(document["other"].as_u64(), Some(7));

        fs::remove_dir_all(root).expect("test directory removes");
    }

    #[test]
    fn subtitle_entitlement_requires_app_approved_pro_metadata() {
        let root = test_directory();
        fs::create_dir_all(&root).expect("root creates");
        let key = "AM-0123456789ABCDEF0123456789ABCDEF0123";
        fs::write(
            settings_path(&root),
            serde_json::to_vec(&json!({ "licenseKey": key })).unwrap(),
        )
        .unwrap();
        assert_eq!(
            read_companion_license_key(&root).unwrap_err().code,
            "pro-license-required"
        );
        fs::write(
            settings_path(&root),
            serde_json::to_vec(&json!({
                "licenseKey": key,
                "licenseEdition": "pro",
                "licenseStatus": "approved",
                "licenseExpiresAt": now_millis() + 60_000
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(read_companion_license_key(&root).unwrap(), key);
        fs::remove_dir_all(root).expect("root removes");
    }

    #[test]
    fn the_configured_folder_is_read_back_from_settings() {
        let root = test_directory();
        fs::create_dir_all(&root).expect("root creates");
        let target = root.join("chosen");
        write_download_folder(&root, &target.to_string_lossy()).expect("folder writes");

        assert_eq!(read_download_folder_setting(&root), Some(target));

        // A malformed value falls back rather than writing media to a bad path.
        fs::write(
            settings_path(&root),
            br#"{"downloadFolder":"not-absolute"}"#,
        )
        .expect("settings write");
        assert_eq!(read_download_folder_setting(&root), None);

        fs::write(settings_path(&root), b"{ not json").expect("settings write");
        assert_eq!(read_download_folder_setting(&root), None);

        fs::remove_dir_all(root).expect("test directory removes");
    }

    #[test]
    fn writing_the_download_folder_rejects_a_relative_path() {
        let root = test_directory();
        fs::create_dir_all(&root).expect("root creates");
        assert!(write_download_folder(&root, "relative\\media").is_err());
        assert!(
            !settings_path(&root).exists(),
            "nothing is written on refusal"
        );
        fs::remove_dir_all(root).expect("test directory removes");
    }

    #[test]
    fn restarting_a_job_without_a_persisted_request_reports_the_missing_record() {
        let directory = test_directory();
        fs::create_dir_all(&directory).expect("jobs directory creates");
        // `restart_job` resolves paths through the real companion root, so this
        // only asserts the id guard, which runs before any file access.
        assert!(restart_job("../escape").is_err());
        assert!(restart_job("").is_err());
        fs::remove_dir_all(directory).expect("test directory removes");
    }

    #[test]
    fn spawn_failure_marks_the_job_failed_and_releases_the_reservation() {
        let directory = test_directory();
        let request = sample_download_request("job-spawn-failure");
        let error = spawn_job_runner_in_with(&directory, &request, |_| {
            Err(io::Error::new(io::ErrorKind::NotFound, "runner missing"))
        })
        .expect_err("spawn fails");
        assert_eq!(error.kind(), io::ErrorKind::NotFound);

        let state = read_job_state(&job_state_path_in(&directory, &request.job_id).unwrap())
            .expect("failed state persists");
        assert_eq!(state.status, "failed");
        assert_eq!(state.error.as_deref(), Some("job-start-failed"));
        assert!(
            !job_store::runner_claim_path_in(&directory, &request.job_id)
                .unwrap()
                .exists()
        );
        fs::remove_dir_all(directory).expect("test directory removes");
    }

    #[test]
    fn parent_reservation_blocks_a_second_submit_before_the_child_starts() {
        let directory = test_directory();
        let request = sample_download_request("job-single-flight");
        let request_path = job_store::request_path_in(&directory, &request.job_id).unwrap();
        job_store::write_json_atomic(&request_path, &request).expect("request writes");
        let reservation = job_store::reserve_runner_claim_in(&directory, &request.job_id)
            .expect("parent reserves");
        let original = fs::read(&request_path).expect("request reads");

        let mut replacement = request.clone();
        replacement.url = "https://example.invalid/replacement".into();
        let error = spawn_job_runner_in_with(&directory, &replacement, |_| Ok(()))
            .expect_err("second submit rejects");
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&request_path).expect("request rereads"), original);
        assert!(!job_state_path_in(&directory, &request.job_id)
            .unwrap()
            .exists());
        drop(reservation);
        fs::remove_dir_all(directory).expect("test directory removes");
    }

    #[test]
    fn malformed_persisted_request_becomes_a_failed_bootstrap_state() {
        let directory = test_directory();
        let path = directory.join("job-malformed.request.json");
        fs::write(&path, b"{ not json").expect("malformed request writes");

        assert!(run_job_from_path(&path, None).is_err());
        let state = read_job_state(&job_state_path_in(&directory, "job-malformed").unwrap())
            .expect("bootstrap state persists");
        assert_eq!(state.status, "failed");
        assert_eq!(state.error.as_deref(), Some("job-request-invalid"));
        fs::remove_dir_all(directory).expect("test directory removes");
    }

    #[test]
    fn malformed_reserved_request_releases_the_parent_claim_and_marks_failure() {
        let directory = test_directory();
        let path = directory.join("job-reserved-malformed.request.json");
        fs::write(&path, b"{ not json").expect("malformed request writes");
        let claim = job_store::reserve_runner_claim_in(&directory, "job-reserved-malformed")
            .expect("claim reserves");
        let token = claim.token().to_string();
        claim.handoff();

        assert!(run_job_from_path(&path, Some(&token)).is_err());
        assert!(
            !job_store::runner_claim_path_in(&directory, "job-reserved-malformed")
                .unwrap()
                .exists()
        );
        let state =
            read_job_state(&job_state_path_in(&directory, "job-reserved-malformed").unwrap())
                .expect("bootstrap state persists");
        assert_eq!(state.status, "failed");
        assert_eq!(state.error.as_deref(), Some("job-request-invalid"));
        fs::remove_dir_all(directory).expect("test directory removes");
    }

    #[test]
    fn mismatched_child_token_never_overwrites_the_reserved_job_state() {
        let directory = test_directory();
        let request = sample_download_request("job-token-mismatch");
        let request_path = job_store::request_path_in(&directory, &request.job_id).unwrap();
        job_store::write_json_atomic(&request_path, &request).expect("request writes");
        let original_state = br#"{"jobId":"job-token-mismatch","status":"running","statusText":"owned","updatedAt":9}"#;
        fs::write(
            job_state_path_in(&directory, &request.job_id).unwrap(),
            original_state,
        )
        .expect("state writes");
        let claim = job_store::reserve_runner_claim_in(&directory, &request.job_id)
            .expect("claim reserves");
        let token = claim.token().to_string();
        claim.handoff();

        let error = run_job_from_path(&request_path, Some("wrong-token"))
            .expect_err("mismatched child rejects");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(
            fs::read(job_state_path_in(&directory, &request.job_id).unwrap())
                .expect("state rereads"),
            original_state
        );
        let adopted = job_store::adopt_runner_claim_in(&directory, &request.job_id, &token)
            .expect("real child can still adopt");
        drop(adopted);
        fs::remove_dir_all(directory).expect("test directory removes");
    }

    #[test]
    fn runner_failure_fallback_does_not_overwrite_an_unowned_reservation() {
        let directory = test_directory();
        let request = sample_download_request("job-fallback-token");
        let request_path = job_store::request_path_in(&directory, &request.job_id).unwrap();
        job_store::write_json_atomic(&request_path, &request).expect("request writes");
        let original_state = br#"{"jobId":"job-fallback-token","status":"running","statusText":"owned","updatedAt":9}"#;
        fs::write(
            job_state_path_in(&directory, &request.job_id).unwrap(),
            original_state,
        )
        .expect("state writes");
        let claim = job_store::reserve_runner_claim_in(&directory, &request.job_id)
            .expect("claim reserves");
        let token = claim.token().to_string();
        claim.handoff();

        record_runner_failure(
            &request_path,
            Some("wrong-token"),
            &io::Error::other("persist failed"),
        );
        assert_eq!(
            fs::read(job_state_path_in(&directory, &request.job_id).unwrap())
                .expect("state rereads"),
            original_state
        );

        record_runner_failure(
            &request_path,
            Some(&token),
            &io::Error::other("persist failed"),
        );
        let state = read_job_state(&job_state_path_in(&directory, &request.job_id).unwrap())
            .expect("fallback state persists");
        assert_eq!(state.status, "failed");
        assert!(state
            .error
            .as_deref()
            .is_some_and(|error| error.starts_with("job-state-persist-failed:")));
        assert!(
            !job_store::runner_claim_path_in(&directory, &request.job_id)
                .unwrap()
                .exists()
        );
        fs::remove_dir_all(directory).expect("test directory removes");
    }

    #[test]
    fn a_paused_job_state_survives_a_round_trip() {
        let directory = test_directory();
        let mut state = initial_job_state(&sample_download_request("job-paused"));
        state.status = "paused".into();
        state.status_text = "일시정지했습니다.".into();
        state.progress = Some(42);
        persist_job_state_in(&directory, &mut state, 1).expect("state persists");

        let restored = read_job_state(&job_state_path_in(&directory, "job-paused").unwrap())
            .expect("state reads back");
        assert_eq!(restored.status, "paused");
        assert_eq!(restored.progress, Some(42));

        fs::remove_dir_all(directory).expect("test directory removes");
    }

    #[test]
    fn native_writer_state_uses_the_extension_job_metadata() {
        let mut request = sample_download_request("extension-job-42");
        request.kind = "media-open".into();
        request.request_id = "native-request-7".into();
        request.filename = "clip.mp4".into();
        request.title = "Playmogo clip".into();
        request.input_kind = "PROGRESSIVE".into();
        request.total = Some(1_234_567);

        let state =
            legacy_writer::initial_media_writer_state(&request, Path::new("clip.mp4"), 123, 0);
        assert_eq!(state.job_id, "extension-job-42");
        assert_eq!(state.request_id.as_deref(), Some("native-request-7"));
        assert_eq!(state.title.as_deref(), Some("Playmogo clip"));
        assert_eq!(state.input_kind.as_deref(), Some("PROGRESSIVE"));
        assert_eq!(state.total, Some(1_234_567));
        assert_eq!(state.status, "running");
        assert_eq!(state.progress, Some(0));
        assert_eq!(state.file_name.as_deref(), Some("clip.mp4"));
    }

    fn sample_download_request(job_id: &str) -> Request {
        Request {
            kind: "youtube-download".into(),
            request_id: String::new(),
            job_id: job_id.into(),
            url: "https://youtu.be/abc".into(),
            filename: String::new(),
            title: String::new(),
            protocol_version: 0,
            candidate_id: String::new(),
            referrer: None,
            input_kind: String::new(),
            user_agent: String::new(),
            accept_language: String::new(),
            total: None,
            resume_file_name: String::new(),
            resume_from: None,
            show_ui: None,
            folder: String::new(),
            data: String::new(),
            quality: default_quality(),
            protocol: PROTOCOL_VERSION,
            raw_message: Value::Null,
            message_bytes: 0,
        }
    }

    fn sample_media_download_command() -> Value {
        serde_json::from_str(include_str!(
            "../../test-fixtures/companion/media-download-v1.json"
        ))
        .expect("shared media-download fixture parses")
    }

    fn shared_fixture(name: &str) -> Value {
        let source = match name {
            "status" => include_str!("../../test-fixtures/companion/status-v2.json"),
            "media-rejections" => {
                include_str!("../../test-fixtures/companion/media-download-v1-rejections.json")
            }
            "download-folder" => {
                include_str!("../../test-fixtures/companion/download-folder-v1.json")
            }
            _ => panic!("unknown shared fixture: {name}"),
        };
        serde_json::from_str(source).expect("shared fixture parses")
    }

    #[test]
    fn status_fixture_matches_the_native_status_projection() {
        let expected = shared_fixture("status");
        assert_eq!(expected["protocol"], json!(PROTOCOL_VERSION));
        assert_eq!(expected["version"], json!(env!("CARGO_PKG_VERSION")));
        assert_eq!(expected["entitlementOwner"], json!("companion"));
        assert_eq!(expected["capabilities"], json!(companion_capabilities()));
        assert_eq!(expected["requestId"], json!("fixture-status-request-123"));
    }

    #[test]
    fn shared_media_rejection_fixture_matches_host_validation_codes() {
        let contracts = shared_fixture("media-rejections");
        let cases = contracts.as_array().expect("rejection cases are an array");
        let mut secret = sample_media_download_command();
        secret["headers"] = json!({ "authorization": "Bearer secret" });
        let mut private_url = sample_media_download_command();
        private_url["url"] = json!("http://127.0.0.1/video.mp4");
        let mut unsupported = sample_media_download_command();
        unsupported["inputKind"] = json!("HLS_WITH_HEADERS");
        for (contract, raw) in cases.iter().zip([secret, private_url, unsupported]) {
            let encoded = serde_json::to_vec(&raw).expect("command serializes");
            let error = parse_media_download_command_bytes(&encoded)
                .expect_err("fixture command must reject");
            assert_eq!(contract["response"]["errorCode"], json!(error.code));
            assert_eq!(contract["response"]["error"], json!(error.message));
        }
    }

    #[test]
    fn shared_download_folder_fixture_matches_host_validation() {
        let contracts = shared_fixture("download-folder");
        for contract in contracts["accepted"]
            .as_array()
            .expect("accepted cases are an array")
        {
            let folder = contract["folder"].as_str().expect("folder exists");
            let path = valid_download_folder(folder).expect("folder accepts");
            assert_eq!(
                contract["response"]["downloadsFolder"],
                json!(path.to_string_lossy())
            );
        }
        for contract in contracts["rejected"]
            .as_array()
            .expect("rejected cases are an array")
        {
            let folder = contract["folder"].as_str().expect("folder exists");
            assert!(valid_download_folder(folder).is_none());
            assert_eq!(
                contract["response"]["errorCode"],
                json!("download-folder-rejected")
            );
        }
    }

    #[test]
    fn media_download_v1_accepts_only_the_bounded_public_contract() {
        let bytes = serde_json::to_vec(&sample_media_download_command()).unwrap();
        let command = parse_media_download_command_bytes(&bytes).expect("valid command parses");
        assert_eq!(command.job_id, "job-123");
        assert_eq!(command.request_id, "fixture-request-123");
        assert_eq!(command.input_kind, "HLS_MASTER");
        assert_eq!(command.accept_language, "ko,en-US;q=0.9,en;q=0.8");

        for (field, value) in [
            ("url", "https://user:secret@cdn.example.com/video.mp4"),
            ("url", "https://cdn.example.com/video.mp4#fragment"),
            ("url", "http://127.0.0.1/video.mp4"),
            ("url", "http://192.168.1.20/video.mp4"),
            ("url", "http://media.local/video.mp4"),
            ("url", "https://cdn.example.com:99999/video.mp4"),
            ("referrer", "http://[::1]/watch"),
            ("inputKind", "HLS_WITH_HEADERS"),
            ("userAgent", "bad\r\nInjected: yes"),
            ("acceptLanguage", "ko,*;q=0.9"),
        ] {
            let mut raw = sample_media_download_command();
            raw[field] = Value::String(value.into());
            let encoded = serde_json::to_vec(&raw).unwrap();
            assert!(
                parse_media_download_command_bytes(&encoded).is_err(),
                "{field}={value} must be rejected"
            );
        }

        for forbidden in ["headers", "cookies", "authorization", "path"] {
            let mut raw = sample_media_download_command();
            raw[forbidden] = Value::String("secret".into());
            let encoded = serde_json::to_vec(&raw).unwrap();
            assert!(parse_media_download_command_bytes(&encoded).is_err());
        }

        let oversized = vec![b'x'; media_download::MAX_MESSAGE_BYTES + 1];
        assert_eq!(
            parse_media_download_command_bytes(&oversized)
                .expect_err("oversized payload is rejected")
                .code,
            "media-download-payload-too-large"
        );
    }

    #[test]
    fn progressive_php_redirect_keeps_the_media_extension_and_direct_contract() {
        let command = media_download::parse_command_bytes(
            &serde_json::to_vec(&sample_media_download_command()).unwrap(),
        )
        .expect("media command parses");
        assert_eq!(command.input_kind, "HLS_MASTER");
    }

    #[test]
    fn media_job_state_and_command_keep_only_candidate_metadata_and_referer() {
        let raw = sample_media_download_command();
        let bytes = serde_json::to_vec(&raw).unwrap();
        let request = parse_request_bytes(&bytes).expect("request parses");
        validate_media_download_command(&request.raw_message, request.message_bytes)
            .expect("request validates");
        let state = initial_job_state(&request);
        assert_eq!(state.job_type.as_deref(), Some("media"));
        assert_eq!(state.candidate_id.as_deref(), Some("candidate-123"));
        assert_eq!(state.input_kind.as_deref(), Some("HLS_MASTER"));
        assert_eq!(state.title.as_deref(), Some("Sample video"));

        let command = media_download_command_from_request(&request);
        assert_eq!(
            command.referrer.as_deref(),
            Some("https://page.example/watch?id=7")
        );
        assert_eq!(command.user_agent, "Mozilla/5.0 TestBrowser/151.0");
        assert_eq!(command.accept_language, "ko,en-US;q=0.9,en;q=0.8");
    }

    #[test]
    fn media_writer_resumes_the_exact_partial_file_at_the_checkpoint() {
        let directory = test_directory();
        let final_path = directory.join("clip.mp4");
        let partial_path = PathBuf::from(format!("{}.part", final_path.display()));
        fs::write(&partial_path, vec![7_u8; 4_096]).expect("partial file writes");

        let mut request = sample_download_request("extension-job-resume");
        request.kind = "media-open".into();
        request.filename = "clip.mp4".into();
        request.resume_file_name = "clip.mp4".into();
        request.resume_from = Some(2_048);

        let writer = legacy_writer::open_media_writer_in(&directory, &request)
            .expect("partial file reopens");
        assert_eq!(writer.bytes_written, 2_048);
        assert_eq!(writer.state.completed, Some(2_048));
        assert_eq!(writer.temporary_path, partial_path);
        assert_eq!(writer.file.metadata().expect("metadata reads").len(), 2_048);

        drop(writer);
        fs::remove_dir_all(directory).expect("test directory removes");
    }

    #[test]
    fn cancelling_an_open_media_writer_closes_and_removes_its_partial() {
        let media_directory = test_directory();
        let jobs_directory = test_directory();
        let mut request = sample_download_request("extension-job-cancel");
        request.kind = "media-open".into();
        request.filename = "cancelled.mp4".into();

        let mut writer = legacy_writer::open_media_writer_in(&media_directory, &request)
            .expect("media writer opens");
        writer
            .file
            .write_all(b"partial bytes")
            .expect("partial writes");
        let partial_path = writer.temporary_path.clone();
        let cancel_path =
            job_cancel_path_in(&jobs_directory, &request.job_id).expect("cancel path resolves");
        fs::write(&cancel_path, b"cancel").expect("cancel marker writes");

        legacy_writer::cancel_media_writer_in(writer, &jobs_directory).expect("writer cancels");

        assert!(
            !partial_path.exists(),
            "cancel must remove the partial file"
        );
        assert!(!cancel_path.exists(), "handled marker must be removed");
        let state = fs::read_to_string(
            job_state_path_in(&jobs_directory, &request.job_id).expect("state path resolves"),
        )
        .expect("state reads");
        assert!(state.contains("\"status\":\"cancelled\""));

        fs::remove_dir_all(media_directory).expect("media directory removes");
        fs::remove_dir_all(jobs_directory).expect("jobs directory removes");
    }

    #[test]
    fn the_hello_reply_advertises_the_new_commands() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../test-fixtures/companion/hello-v2.json"))
                .expect("shared hello fixture parses");
        let mut actual = hello_response();
        actual
            .as_object_mut()
            .expect("hello response is an object")
            .remove("version");
        assert_eq!(actual["ok"], true);
        actual
            .as_object_mut()
            .expect("hello response is an object")
            .remove("ok");
        assert_eq!(actual, fixture);

        let correlated = protocol::reply_body("hello-request-123", hello_response());
        assert_eq!(correlated["requestId"], "hello-request-123");
        assert_eq!(correlated["protocol"], fixture["protocol"]);
        assert_eq!(correlated["capabilities"], fixture["capabilities"]);
    }

    #[test]
    fn shared_job_state_fixtures_preserve_current_and_legacy_disk_json() {
        let current_json: Value = serde_json::from_str(include_str!(
            "../../test-fixtures/companion/job-state-v1.json"
        ))
        .expect("current state fixture parses");
        let current: JobState =
            serde_json::from_value(current_json.clone()).expect("current state loads");
        assert_eq!(current.job_id, "job-state-fixture");
        assert_eq!(current.execution_status.as_deref(), Some("running"));
        assert_eq!(current.progress, Some(42));

        let serialized = serde_json::to_value(&current).expect("current state serializes");
        for key in [
            "jobId",
            "jobType",
            "requestId",
            "candidateId",
            "inputKind",
            "executionStatus",
            "status",
            "statusText",
            "title",
            "progress",
            "fileName",
            "createdAt",
            "updatedAt",
        ] {
            assert_eq!(serialized[key], current_json[key], "field drifted: {key}");
        }
        assert!(serialized.get("futureField").is_none());

        let legacy_json: Value = serde_json::from_str(include_str!(
            "../../test-fixtures/companion/job-state-legacy-v1.json"
        ))
        .expect("legacy state fixture parses");
        let legacy: JobState =
            serde_json::from_value(legacy_json.clone()).expect("legacy state loads");
        assert_eq!(legacy.job_id, legacy_json["jobId"]);
        assert_eq!(legacy.status, legacy_json["status"]);
        assert_eq!(
            legacy.file_name.as_deref(),
            legacy_json["fileName"].as_str()
        );
        assert_eq!(legacy.created_at, 0);
    }

    #[test]
    fn youtube_runtime_retries_transient_http_and_extractor_failures() {
        let mut command = Command::new("yt-dlp.exe");
        youtube::apply_runtime(&mut command, Path::new("node.exe"), Path::new("ffmpeg"));
        let arguments = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        for pair in [
            ["--encoding", "utf-8"],
            ["--retries", "3"],
            ["--fragment-retries", "3"],
            ["--extractor-retries", "3"],
            ["--retry-sleep", "http:linear=1::2"],
        ] {
            assert!(
                arguments.windows(2).any(|window| window == pair),
                "missing yt-dlp retry arguments: {pair:?}"
            );
        }
        assert!(arguments
            .windows(4)
            .any(|window| { window == ["--replace-in-metadata", "title", r"\s*[/\\]\s*", " - "] }));
        assert!(!youtube::OUTPUT_TEMPLATE.contains("%(id)"));
        assert_eq!(
            youtube::OUTPUT_TEMPLATE,
            "[%(height)sp] %(title).170B.%(ext)s"
        );
    }

    #[test]
    fn youtube_403_restarts_extraction_once_but_not_forever() {
        assert!(youtube::should_restart(
            "ERROR: unable to download video data: HTTP Error 403: Forbidden",
            1
        ));
        assert!(!youtube::should_restart(
            "ERROR: unable to download video data: HTTP Error 403: Forbidden",
            2
        ));
        assert!(!youtube::should_restart("ERROR: Video unavailable", 1));
    }
}
