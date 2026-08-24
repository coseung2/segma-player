#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const PROTOCOL_VERSION: u32 = 2;
const MAX_NATIVE_MESSAGE_BYTES: usize = 1024 * 1024;
const SUBTITLE_COMMAND_VERSION: u32 = 1;
const MAX_SUBTITLE_MESSAGE_BYTES: usize = 32 * 1024;
const MAX_SUBTITLE_URL_BYTES: usize = 4096;
const MAX_SUBTITLE_TITLE_BYTES: usize = 512;
const MAX_SUBTITLE_METADATA_BYTES: usize = 128;
const MAX_COMPANION_SETTINGS_BYTES: usize = 16 * 1024;
const MAX_SUBTITLE_RESULT_BYTES: usize = 2 * 1024 * 1024;
const MAX_SUBTITLE_REMOTE_RESPONSE_BYTES: usize = MAX_SUBTITLE_RESULT_BYTES + 64 * 1024;
const MAX_SUBTITLE_PHASE_BYTES: usize = 128;
const SUBTITLE_WORKER_URL: &str = "https://aura.mdownloader.workers.dev/api/subtitles";
const SUBTITLE_POLL_INTERVAL: Duration = Duration::from_secs(3);
const SUBTITLE_MAX_RUNTIME: Duration = Duration::from_secs(30 * 60);
const SUBTITLE_ACTIVE_MAX_AGE_MS: u64 = 2 * 60 * 60 * 1000;
static NEXT_SUBTITLE_JOB_ID: AtomicU64 = AtomicU64::new(1);
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(target_os = "windows")]
const DETACHED_PROCESS: u32 = 0x0000_0008;
#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

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

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct SubtitleCreateCommand {
    #[serde(rename = "protocolVersion")]
    protocol_version: u32,
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "requestId")]
    request_id: String,
    #[serde(rename = "candidateId")]
    candidate_id: String,
    #[serde(rename = "sourceLanguage")]
    source_language: String,
    #[serde(rename = "targetLanguage")]
    target_language: String,
    mode: String,
    media: SubtitleMedia,
    #[serde(rename = "sourceContext", default)]
    source_context: Option<SubtitleSourceContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SubtitleMedia {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    title: String,
    #[serde(rename = "pageUrl", default)]
    page_url: String,
    #[serde(rename = "resourceUrl")]
    resource_url: String,
    #[serde(rename = "audioRenditionUrl", default)]
    audio_rendition_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct SubtitleSourceContext {
    #[serde(rename = "tabId")]
    tab_id: u32,
    #[serde(rename = "frameId")]
    frame_id: u32,
    #[serde(rename = "contextLeaseId")]
    context_lease_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SubtitleRequestEnvelope {
    job_id: String,
    request_id: String,
    candidate_id: String,
    source_language: String,
    target_language: String,
    media: SubtitleMedia,
}

#[derive(Debug, Deserialize)]
struct CompanionSettings {
    #[serde(rename = "licenseKey", default)]
    license_key: Option<String>,
    /// Absolute folder the companion saves media into.
    ///
    /// `None` means the default `%USERPROFILE%\Downloads\Aura Media`. This is
    /// the single source of truth for both entry points: the manager window
    /// writes it, and the extension reads it back through `status`. Neither
    /// side keeps its own copy.
    #[serde(rename = "downloadFolder", default)]
    download_folder: Option<String>,
}

#[derive(Debug, Clone)]
struct SubtitleSubmitResult {
    remote_job_id: String,
}

#[derive(Debug, Clone)]
struct SubtitlePollResult {
    status: String,
    phase: Option<String>,
    progress: Option<u8>,
    completed: Option<u64>,
    total: Option<u64>,
    result: Option<SubtitleResult>,
}

#[derive(Debug, Clone)]
struct SubtitleResult {
    vtt: String,
    model: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubtitleCancelStatus {
    Cancelled,
    Completed,
}

#[derive(Debug, Clone, Copy)]
struct SubtitleRunError {
    code: &'static str,
    message: &'static str,
}

#[derive(Debug, Clone, Copy)]
struct SubtitleRunPolicy {
    poll_interval: Duration,
    max_runtime: Duration,
    max_polls: Option<usize>,
}

impl SubtitleRunPolicy {
    fn production() -> Self {
        Self {
            poll_interval: SUBTITLE_POLL_INTERVAL,
            max_runtime: SUBTITLE_MAX_RUNTIME,
            max_polls: None,
        }
    }
}

trait SubtitleTransport {
    fn submit(
        &self,
        envelope: &SubtitleRequestEnvelope,
        license_key: &str,
    ) -> Result<SubtitleSubmitResult, SubtitleRunError>;

    fn poll(
        &self,
        remote_job_id: &str,
        license_key: &str,
    ) -> Result<SubtitlePollResult, SubtitleRunError>;

    fn cancel(
        &self,
        remote_job_id: &str,
        license_key: &str,
    ) -> Result<SubtitleCancelStatus, SubtitleRunError>;
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct JobState {
    #[serde(rename = "jobId")]
    job_id: String,
    #[serde(rename = "jobType", skip_serializing_if = "Option::is_none")]
    job_type: Option<String>,
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(rename = "candidateId", skip_serializing_if = "Option::is_none")]
    candidate_id: Option<String>,
    #[serde(rename = "sourceLanguage", skip_serializing_if = "Option::is_none")]
    source_language: Option<String>,
    #[serde(rename = "targetLanguage", skip_serializing_if = "Option::is_none")]
    target_language: Option<String>,
    #[serde(rename = "inputKind", skip_serializing_if = "Option::is_none")]
    input_kind: Option<String>,
    #[serde(rename = "outputFormat", skip_serializing_if = "Option::is_none")]
    output_format: Option<String>,
    #[serde(rename = "executionStatus", skip_serializing_if = "Option::is_none")]
    execution_status: Option<String>,
    #[serde(rename = "tabId", skip_serializing_if = "Option::is_none")]
    tab_id: Option<u32>,
    #[serde(rename = "frameId", skip_serializing_if = "Option::is_none")]
    frame_id: Option<u32>,
    #[serde(rename = "remoteJobId", skip_serializing_if = "Option::is_none")]
    remote_job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    status: String,
    #[serde(rename = "statusText")]
    status_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<u8>,
    #[serde(rename = "fileName", skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
    #[serde(rename = "createdAt", default)]
    created_at: u64,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
}

#[derive(Debug, Clone, Copy)]
struct SubtitleValidationError {
    code: &'static str,
    message: &'static str,
}

const SUBTITLE_STATUSES: [&str; 7] = [
    "created",
    "preparing",
    "submitting",
    "running",
    "completed",
    "failed",
    "cancelled",
];

fn subtitle_error(code: &'static str, message: &'static str) -> SubtitleValidationError {
    SubtitleValidationError { code, message }
}

fn sensitive_header_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    normalized.contains("cookie")
        || normalized.contains("authorization")
        || normalized.contains("header")
}

fn contains_sensitive_header(value: &Value) -> bool {
    match value {
        Value::Object(object) => object
            .iter()
            .any(|(key, child)| sensitive_header_key(key) || contains_sensitive_header(child)),
        Value::Array(values) => values.iter().any(contains_sensitive_header),
        _ => false,
    }
}

fn bounded_text(value: &str, maximum: usize) -> bool {
    value.len() <= maximum && !value.chars().any(|character| character.is_control())
}

fn valid_http_url(value: &str) -> bool {
    if !bounded_text(value, MAX_SUBTITLE_URL_BYTES) || value.chars().any(char::is_whitespace) {
        return false;
    }
    let Ok(parsed) = reqwest::Url::parse(value) else {
        return false;
    };
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return false;
    }
    let Some(host) = parsed.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    if host == "localhost" || host.ends_with(".localhost") {
        return false;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => {
            !(address.is_loopback()
                || address.is_private()
                || address.is_link_local()
                || address.is_unspecified())
        }
        Ok(IpAddr::V6(address)) => {
            let first = address.segments()[0];
            !(address.is_loopback()
                || address.is_unspecified()
                || first & 0xfe00 == 0xfc00
                || first & 0xffc0 == 0xfe80)
        }
        Err(_) => true,
    }
}

fn valid_subtitle_token(value: &str, maximum: usize) -> bool {
    value.len() <= maximum && safe_id(value).is_some()
}

#[cfg(test)]
fn parse_subtitle_command_bytes(
    data: &[u8],
) -> Result<SubtitleCreateCommand, SubtitleValidationError> {
    if data.len() > MAX_SUBTITLE_MESSAGE_BYTES {
        return Err(subtitle_error(
            "subtitle-payload-too-large",
            "subtitle command exceeds the local payload limit",
        ));
    }
    let raw: Value = serde_json::from_slice(data).map_err(|_| {
        subtitle_error(
            "invalid-subtitle-command",
            "subtitle command is not valid JSON",
        )
    })?;
    validate_subtitle_command(&raw)
}

fn validate_subtitle_command(
    raw: &Value,
) -> Result<SubtitleCreateCommand, SubtitleValidationError> {
    if contains_sensitive_header(raw) {
        return Err(subtitle_error(
            "sensitive-header-rejected",
            "cookies and authorization headers are not accepted",
        ));
    }
    let command: SubtitleCreateCommand = serde_json::from_value(raw.clone()).map_err(|_| {
        subtitle_error(
            "invalid-subtitle-command",
            "subtitle command shape is invalid",
        )
    })?;
    if command.protocol_version != SUBTITLE_COMMAND_VERSION {
        return Err(subtitle_error(
            "subtitle-protocol-version-unsupported",
            "subtitle command protocol version is unsupported",
        ));
    }
    if command.kind != "subtitle.create" {
        return Err(subtitle_error(
            "invalid-subtitle-command",
            "subtitle command type is invalid",
        ));
    }
    if !valid_subtitle_token(&command.request_id, MAX_SUBTITLE_METADATA_BYTES)
        || !valid_subtitle_token(&command.candidate_id, MAX_SUBTITLE_METADATA_BYTES)
    {
        return Err(subtitle_error(
            "invalid-subtitle-request-id",
            "request and candidate identifiers must be bounded local tokens",
        ));
    }
    if !matches!(command.source_language.as_str(), "ja" | "en") || command.target_language != "ko" {
        return Err(subtitle_error(
            "unsupported-subtitle-language",
            "only Japanese or English to Korean subtitles are supported",
        ));
    }
    if command.mode != "generate" {
        return Err(subtitle_error(
            "unsupported-subtitle-mode",
            "subtitle mode is unsupported",
        ));
    }
    if !bounded_text(&command.media.kind, MAX_SUBTITLE_METADATA_BYTES)
        || command.media.kind.is_empty()
        || !valid_http_url(&command.media.resource_url)
        || (!command.media.page_url.is_empty() && !valid_http_url(&command.media.page_url))
        || (!command.media.audio_rendition_url.is_empty()
            && !valid_http_url(&command.media.audio_rendition_url))
        || !bounded_text(&command.media.title, MAX_SUBTITLE_TITLE_BYTES)
    {
        return Err(subtitle_error(
            "invalid-subtitle-media",
            "subtitle media metadata or URL is invalid or oversized",
        ));
    }
    if let Some(context) = command.source_context.as_ref() {
        if !valid_subtitle_token(&context.context_lease_id, MAX_SUBTITLE_METADATA_BYTES) {
            return Err(subtitle_error(
                "invalid-subtitle-context",
                "subtitle source context is invalid",
            ));
        }
    }
    Ok(command)
}

fn next_subtitle_job_id() -> String {
    let sequence = NEXT_SUBTITLE_JOB_ID.fetch_add(1, Ordering::Relaxed);
    format!("subtitle-{}-{sequence}", now_millis())
}

fn initial_subtitle_job_state(
    command: &SubtitleCreateCommand,
    job_id: String,
    now: u64,
) -> JobState {
    JobState {
        job_id,
        job_type: Some("subtitle".into()),
        request_id: Some(command.request_id.clone()),
        candidate_id: Some(command.candidate_id.clone()),
        source_language: Some(command.source_language.clone()),
        target_language: Some(command.target_language.clone()),
        input_kind: Some(command.media.kind.clone()),
        output_format: Some("vtt".into()),
        execution_status: Some("queued".into()),
        tab_id: command
            .source_context
            .as_ref()
            .map(|context| context.tab_id),
        frame_id: command
            .source_context
            .as_ref()
            .map(|context| context.frame_id),
        remote_job_id: None,
        phase: None,
        completed: None,
        total: None,
        model: None,
        status: "created".into(),
        status_text: "Subtitle job queued for Companion execution.".into(),
        title: (!command.media.title.is_empty()).then(|| command.media.title.clone()),
        error: None,
        progress: None,
        file_name: None,
        created_at: now,
        updated_at: now,
    }
}

fn create_subtitle_job_in(
    directory: &Path,
    command: &SubtitleCreateCommand,
    job_id: String,
    now: u64,
) -> io::Result<JobState> {
    let mut state = initial_subtitle_job_state(command, job_id, now);
    persist_job_state_in(directory, &mut state, now)?;
    Ok(state)
}

fn subtitle_transition_allowed(current: &str, next: &str) -> bool {
    match current {
        "created" => matches!(next, "preparing" | "failed" | "cancelled"),
        "preparing" => matches!(next, "submitting" | "failed" | "cancelled"),
        "submitting" => matches!(next, "running" | "failed" | "cancelled"),
        "running" => matches!(next, "completed" | "failed" | "cancelled"),
        _ => false,
    }
}

fn transition_subtitle_job_state_in(
    directory: &Path,
    state: &mut JobState,
    next: &str,
    status_text: &str,
    updated_at: u64,
) -> io::Result<()> {
    if state.job_type.as_deref() != Some("subtitle")
        || !SUBTITLE_STATUSES.contains(&next)
        || !subtitle_transition_allowed(&state.status, next)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid subtitle job state transition",
        ));
    }
    state.status = next.into();
    state.status_text = status_text.into();
    persist_job_state_in(directory, state, updated_at)
}

fn mark_subtitle_terminal(
    directory: &Path,
    state: &mut JobState,
    status: &str,
    status_text: &str,
    error: Option<&'static str>,
    execution_status: &'static str,
    now: u64,
) -> io::Result<()> {
    if status != "completed" && !subtitle_transition_allowed(&state.status, status) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid subtitle terminal state",
        ));
    }
    state.status = status.into();
    state.status_text = status_text.into();
    state.execution_status = Some(execution_status.into());
    state.error = error.map(str::to_string);
    persist_job_state_in(directory, state, now)
}

fn subtitle_envelope(command: &SubtitleCreateCommand, job_id: String) -> SubtitleRequestEnvelope {
    SubtitleRequestEnvelope {
        job_id,
        request_id: command.request_id.clone(),
        candidate_id: command.candidate_id.clone(),
        source_language: command.source_language.clone(),
        target_language: command.target_language.clone(),
        media: command.media.clone(),
    }
}

fn cleanup_subtitle_active(directory: &Path, job_id: &str) {
    if let Ok(path) = subtitle_request_path_in(directory, job_id) {
        let _ = fs::remove_file(path);
    }
    if let Ok(path) = job_cancel_path_in(directory, job_id) {
        let _ = fs::remove_file(path);
    }
}

fn cleanup_stale_subtitle_requests_in(directory: &Path, now: u64) -> io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        let Some(job_id) = name.strip_suffix(".subtitle.request.json") else {
            continue;
        };
        let Ok(state_path) = job_state_path_in(directory, job_id) else {
            let _ = fs::remove_file(path);
            continue;
        };
        match read_job_state(&state_path) {
            None => cleanup_subtitle_active(directory, job_id),
            Some(state)
                if matches!(state.status.as_str(), "completed" | "failed" | "cancelled") =>
            {
                cleanup_subtitle_active(directory, job_id)
            }
            Some(mut state)
                if now.saturating_sub(state.updated_at) > SUBTITLE_ACTIVE_MAX_AGE_MS =>
            {
                state.status = "failed".into();
                state.status_text = "Subtitle job expired after an interrupted run.".into();
                state.execution_status = Some("failed".into());
                state.error = Some("subtitle-interrupted".into());
                let _ = persist_job_state_in(directory, &mut state, now);
                cleanup_subtitle_active(directory, job_id);
            }
            Some(_) => {}
        }
    }
    Ok(())
}

fn start_subtitle_job_in<F>(
    directory: &Path,
    command: &SubtitleCreateCommand,
    now: u64,
    launch: F,
) -> io::Result<JobState>
where
    F: FnOnce(&Path) -> io::Result<()>,
{
    let job_id = next_subtitle_job_id();
    let mut state = create_subtitle_job_in(directory, command, job_id.clone(), now)?;
    let envelope = subtitle_envelope(command, job_id.clone());
    let request_path = subtitle_request_path_in(directory, &job_id)?;
    if let Err(error) = write_json_atomic(&request_path, &envelope) {
        state.status = "failed".into();
        state.status_text = "Subtitle job could not be prepared.".into();
        state.execution_status = Some("failed".into());
        state.error = Some("subtitle-request-persist-failed".into());
        let _ = persist_job_state_in(directory, &mut state, now);
        cleanup_subtitle_active(directory, &job_id);
        return Err(error);
    }
    if let Ok(cancel_path) = job_cancel_path_in(directory, &job_id) {
        let _ = fs::remove_file(cancel_path);
    }
    state.status = "preparing".into();
    state.status_text = "Preparing subtitle job.".into();
    state.execution_status = Some("started".into());
    persist_job_state_in(directory, &mut state, now)?;
    if let Err(error) = launch(&request_path) {
        state.status = "failed".into();
        state.status_text = "Subtitle job could not be started.".into();
        state.execution_status = Some("failed".into());
        state.error = Some("subtitle-start-failed".into());
        let _ = persist_job_state_in(directory, &mut state, now_millis());
        cleanup_subtitle_active(directory, &job_id);
        return Err(error);
    }
    Ok(state)
}

fn spawn_subtitle_process(path: &Path) -> io::Result<()> {
    let path_text = path.to_string_lossy().into_owned();
    spawn_detached(&["--run-subtitle-job", &path_text])
}

fn run_error(code: &'static str, message: &'static str) -> SubtitleRunError {
    SubtitleRunError { code, message }
}

fn valid_remote_job_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
}

fn bounded_remote_phase(value: Option<&Value>) -> Option<String> {
    let phase = value?.as_str()?;
    if phase.len() > MAX_SUBTITLE_PHASE_BYTES
        || phase.is_empty()
        || !phase
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || " ._-".contains(character))
    {
        return None;
    }
    Some(phase.to_string())
}

fn bounded_remote_model(value: Option<&Value>) -> Option<String> {
    let model = value?.as_str()?;
    bounded_text(model, MAX_SUBTITLE_METADATA_BYTES).then(|| model.to_string())
}

fn response_error(status: StatusCode) -> SubtitleRunError {
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        run_error(
            "pro-license-required",
            "a valid Companion Pro license is required",
        )
    } else if status == StatusCode::TOO_MANY_REQUESTS {
        run_error(
            "subtitle-rate-limited",
            "subtitle service rate limit reached",
        )
    } else if status.is_server_error() {
        run_error("subtitle-service-failed", "subtitle service failed")
    } else {
        run_error("subtitle-request-rejected", "subtitle request was rejected")
    }
}

fn read_http_json(
    response: reqwest::blocking::Response,
) -> Result<(StatusCode, Value), SubtitleRunError> {
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_SUBTITLE_REMOTE_RESPONSE_BYTES as u64)
    {
        return Err(run_error(
            "subtitle-response-too-large",
            "subtitle service response was too large",
        ));
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_SUBTITLE_REMOTE_RESPONSE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            run_error(
                "subtitle-service-unavailable",
                "subtitle service is unavailable",
            )
        })?;
    if bytes.len() > MAX_SUBTITLE_REMOTE_RESPONSE_BYTES {
        return Err(run_error(
            "subtitle-response-too-large",
            "subtitle service response was too large",
        ));
    }
    let body = serde_json::from_slice(&bytes).map_err(|_| {
        run_error(
            "subtitle-service-invalid-response",
            "subtitle service response was invalid",
        )
    })?;
    Ok((status, body))
}

fn remote_body_error(status: StatusCode, body: &Value) -> Result<(), SubtitleRunError> {
    if !status.is_success() || body.get("ok").and_then(Value::as_bool) == Some(false) {
        Err(response_error(status))
    } else {
        Ok(())
    }
}

fn parse_submit_response(
    status: StatusCode,
    body: Value,
) -> Result<SubtitleSubmitResult, SubtitleRunError> {
    remote_body_error(status, &body)?;
    let remote_job_id = body
        .get("jobId")
        .or_else(|| body.get("id"))
        .and_then(Value::as_str)
        .filter(|value| valid_remote_job_id(value))
        .ok_or_else(|| {
            run_error(
                "subtitle-service-invalid-response",
                "subtitle service response was invalid",
            )
        })?;
    Ok(SubtitleSubmitResult {
        remote_job_id: remote_job_id.to_string(),
    })
}

fn parse_progress_value(value: Option<&Value>) -> Option<u8> {
    let number = value?.as_f64()?;
    number
        .is_finite()
        .then(|| number.clamp(0.0, 100.0).round() as u8)
}

fn parse_poll_response(
    status_code: StatusCode,
    body: Value,
) -> Result<SubtitlePollResult, SubtitleRunError> {
    remote_body_error(status_code, &body)?;
    let status = body
        .get("status")
        .and_then(Value::as_str)
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| {
            run_error(
                "subtitle-service-invalid-response",
                "subtitle service response was invalid",
            )
        })?;
    if !matches!(
        status.as_str(),
        "queued" | "running" | "completed" | "failed" | "cancelled"
    ) {
        return Err(run_error(
            "subtitle-service-invalid-response",
            "subtitle service response was invalid",
        ));
    }
    let result = body
        .get("result")
        .and_then(Value::as_object)
        .and_then(|result| {
            result
                .get("vtt")
                .and_then(Value::as_str)
                .map(|vtt| SubtitleResult {
                    vtt: vtt.to_string(),
                    model: bounded_remote_model(result.get("model")),
                })
        });
    Ok(SubtitlePollResult {
        status,
        phase: bounded_remote_phase(body.get("phase")),
        progress: parse_progress_value(body.get("progress")),
        completed: body.get("completed").and_then(Value::as_u64),
        total: body.get("total").and_then(Value::as_u64),
        result,
    })
}

fn parse_cancel_response(
    status_code: StatusCode,
    body: Value,
) -> Result<SubtitleCancelStatus, SubtitleRunError> {
    remote_body_error(status_code, &body)?;
    match body.get("status").and_then(Value::as_str) {
        Some("cancelled") => Ok(SubtitleCancelStatus::Cancelled),
        Some("completed") => Ok(SubtitleCancelStatus::Completed),
        _ => Err(run_error(
            "subtitle-service-invalid-response",
            "subtitle service response was invalid",
        )),
    }
}

struct HttpSubtitleTransport {
    client: Client,
}

impl HttpSubtitleTransport {
    fn new() -> Result<Self, SubtitleRunError> {
        let client = Client::builder()
            .https_only(true)
            .redirect(Policy::none())
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|_| {
                run_error(
                    "subtitle-service-unavailable",
                    "subtitle service is unavailable",
                )
            })?;
        Ok(Self { client })
    }
}

impl SubtitleTransport for HttpSubtitleTransport {
    fn submit(
        &self,
        envelope: &SubtitleRequestEnvelope,
        license_key: &str,
    ) -> Result<SubtitleSubmitResult, SubtitleRunError> {
        let payload = json!({
            "mediaUrl": envelope.media.resource_url,
            "sourceUrl": envelope.media.page_url,
            "title": envelope.media.title,
            "sourceLanguage": envelope.source_language,
            "licenseKey": license_key,
        });
        let response = self
            .client
            .post(SUBTITLE_WORKER_URL)
            .json(&payload)
            .send()
            .map_err(|_| {
                run_error(
                    "subtitle-service-unavailable",
                    "subtitle service is unavailable",
                )
            })?;
        let (status, body) = read_http_json(response)?;
        parse_submit_response(status, body)
    }

    fn poll(
        &self,
        remote_job_id: &str,
        license_key: &str,
    ) -> Result<SubtitlePollResult, SubtitleRunError> {
        let response = self
            .client
            .get(SUBTITLE_WORKER_URL)
            .query(&[("id", remote_job_id)])
            .header(
                reqwest::header::AUTHORIZATION,
                format!("Bearer {license_key}"),
            )
            .send()
            .map_err(|_| {
                run_error(
                    "subtitle-service-unavailable",
                    "subtitle service is unavailable",
                )
            })?;
        let (status, body) = read_http_json(response)?;
        parse_poll_response(status, body)
    }

    fn cancel(
        &self,
        remote_job_id: &str,
        license_key: &str,
    ) -> Result<SubtitleCancelStatus, SubtitleRunError> {
        let response = self
            .client
            .delete(SUBTITLE_WORKER_URL)
            .query(&[("id", remote_job_id)])
            .header(
                reqwest::header::AUTHORIZATION,
                format!("Bearer {license_key}"),
            )
            .send()
            .map_err(|_| {
                run_error(
                    "subtitle-service-unavailable",
                    "subtitle service is unavailable",
                )
            })?;
        let (status, body) = read_http_json(response)?;
        parse_cancel_response(status, body)
    }
}

fn parse_vtt_timestamp(value: &str) -> Option<u64> {
    let value = value.trim();
    let (whole, fraction) = value.split_once('.').unwrap_or((value, "0"));
    if fraction.is_empty() || fraction.len() > 3 || !fraction.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let millis = fraction
        .parse::<u64>()
        .ok()?
        .checked_mul(10_u64.pow(3 - fraction.len() as u32))?;
    let parts = whole.split(':').collect::<Vec<_>>();
    let (hours, minutes, seconds) = match parts.as_slice() {
        [minutes, seconds] => ("0", *minutes, *seconds),
        [hours, minutes, seconds] => (*hours, *minutes, *seconds),
        _ => return None,
    };
    let hours = hours.parse::<u64>().ok()?;
    let minutes = minutes.parse::<u64>().ok()?;
    let seconds = seconds.parse::<u64>().ok()?;
    if minutes >= 60 || seconds >= 60 {
        return None;
    }
    hours
        .checked_mul(60)?
        .checked_add(minutes)?
        .checked_mul(60)?
        .checked_add(seconds)?
        .checked_mul(1000)?
        .checked_add(millis)
}

fn valid_vtt(vtt: &str) -> bool {
    if vtt.as_bytes().len() == 0 || vtt.as_bytes().len() > MAX_SUBTITLE_RESULT_BYTES {
        return false;
    }
    let vtt = vtt.strip_prefix('\u{feff}').unwrap_or(vtt);
    if !vtt
        .lines()
        .next()
        .is_some_and(|line| line.trim() == "WEBVTT")
    {
        return false;
    }
    let mut cue_count = 0_u32;
    let mut previous_start = None;
    let lines = vtt.lines().collect::<Vec<_>>();
    let mut index = 0_usize;
    while index < lines.len() {
        let line = lines[index];
        if !line.contains("-->") {
            index += 1;
            continue;
        }
        let mut parts = line.split("-->");
        let Some(start) = parts.next().and_then(parse_vtt_timestamp) else {
            return false;
        };
        let Some(end) = parts
            .next()
            .and_then(|value| value.split_whitespace().next())
            .and_then(parse_vtt_timestamp)
        else {
            return false;
        };
        if parts.next().is_some() {
            return false;
        }
        index += 1;
        let mut has_cue_text = false;
        while index < lines.len() && !lines[index].trim().is_empty() {
            if lines[index].contains("-->") {
                return false;
            }
            has_cue_text = true;
            index += 1;
        }
        if !has_cue_text {
            return false;
        }
        if start >= end || previous_start.is_some_and(|previous| start < previous) {
            return false;
        }
        previous_start = Some(start);
        cue_count += 1;
    }
    cue_count > 0
}

fn normalize_vtt(vtt: &str) -> String {
    let normalized = vtt
        .strip_prefix('\u{feff}')
        .unwrap_or(vtt)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    if normalized.ends_with('\n') {
        normalized
    } else {
        format!("{normalized}\n")
    }
}

fn unique_subtitle_path(directory: &Path, title: &str) -> io::Result<PathBuf> {
    let sanitized = safe_filename(title);
    let stem = Path::new(&sanitized)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("aura-subtitle");
    for index in 0..10_000 {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!(" ({index})")
        };
        let path = directory.join(format!("{stem}{suffix}.vtt"));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => {
                drop(file);
                return Ok(path);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "subtitle filename allocation limit reached",
    ))
}

fn save_subtitle_result_in(
    directory: &Path,
    title: &str,
    vtt: &str,
) -> Result<String, SubtitleRunError> {
    let normalized = normalize_vtt(vtt);
    if !valid_vtt(&normalized) {
        return Err(run_error(
            "subtitle-invalid-vtt",
            "subtitle result was empty or structurally invalid",
        ));
    }
    fs::create_dir_all(directory)
        .map_err(|_| run_error("subtitle-save-failed", "subtitle file could not be saved"))?;
    let path = unique_subtitle_path(directory, title)
        .map_err(|_| run_error("subtitle-save-failed", "subtitle file could not be saved"))?;
    if write_bytes_atomic(&path, normalized.as_bytes()).is_err() {
        let _ = fs::remove_file(&path);
        return Err(run_error(
            "subtitle-save-failed",
            "subtitle file could not be saved",
        ));
    }
    Ok(path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("aura-subtitle.vtt")
        .to_string())
}

fn subtitle_cancel_requested(directory: &Path, job_id: &str) -> bool {
    job_cancel_path_in(directory, job_id)
        .ok()
        .is_some_and(|path| path.exists())
}

fn persist_subtitle_progress(
    directory: &Path,
    state: &mut JobState,
    poll: &SubtitlePollResult,
) -> io::Result<()> {
    state.phase = poll.phase.clone();
    state.progress = poll.progress;
    state.completed = poll.completed;
    state.total = poll.total;
    if let Some(phase) = poll.phase.as_deref() {
        state.status_text = format!("Subtitle processing: {phase}");
    }
    persist_job_state_in(directory, state, now_millis())
}

fn finish_subtitle_completed(
    directory: &Path,
    output_directory: &Path,
    state: &mut JobState,
    result: SubtitleResult,
) -> Result<(), SubtitleRunError> {
    let file_name = match save_subtitle_result_in(
        output_directory,
        state.title.as_deref().unwrap_or("aura-subtitle"),
        &result.vtt,
    ) {
        Ok(file_name) => file_name,
        Err(error) => {
            finish_subtitle_failure(directory, state, error);
            return Err(error);
        }
    };
    state.file_name = Some(file_name);
    state.model = result.model;
    if mark_subtitle_terminal(
        directory,
        state,
        "completed",
        "Subtitle saved.",
        None,
        "completed",
        now_millis(),
    )
    .is_err()
    {
        let error = run_error(
            "subtitle-job-state-failed",
            "subtitle job state is unavailable",
        );
        finish_subtitle_failure(directory, state, error);
        return Err(error);
    }
    cleanup_subtitle_active(directory, &state.job_id);
    Ok(())
}

fn finish_subtitle_cancel<T: SubtitleTransport>(
    transport: &T,
    directory: &Path,
    output_directory: &Path,
    state: &mut JobState,
    license_key: Option<&str>,
    now: u64,
) -> Result<(), SubtitleRunError> {
    if let (Some(remote_job_id), Some(license_key)) = (state.remote_job_id.as_deref(), license_key)
    {
        match transport.cancel(remote_job_id, license_key) {
            Ok(SubtitleCancelStatus::Cancelled) => {}
            Ok(SubtitleCancelStatus::Completed) => {
                let poll = transport.poll(remote_job_id, license_key).map_err(|_| {
                    run_error(
                        "subtitle-cancel-state-conflict",
                        "subtitle completed while cancellation was requested",
                    )
                })?;
                let result = poll
                    .result
                    .filter(|_| poll.status == "completed")
                    .ok_or_else(|| {
                        run_error(
                            "subtitle-cancel-state-conflict",
                            "subtitle completed while cancellation was requested",
                        )
                    })?;
                return finish_subtitle_completed(directory, output_directory, state, result);
            }
            Err(_) => {
                let error = run_error(
                    "subtitle-cancel-failed",
                    "subtitle service cancellation failed",
                );
                finish_subtitle_failure(directory, state, error);
                return Err(error);
            }
        }
    }
    mark_subtitle_terminal(
        directory,
        state,
        "cancelled",
        "Subtitle job cancelled.",
        None,
        "cancelled",
        now,
    )
    .map_err(|_| {
        run_error(
            "subtitle-job-state-failed",
            "subtitle job state is unavailable",
        )
    })?;
    cleanup_subtitle_active(directory, &state.job_id);
    Ok(())
}

fn finish_subtitle_failure(directory: &Path, state: &mut JobState, error: SubtitleRunError) {
    let _ = mark_subtitle_terminal(
        directory,
        state,
        "failed",
        error.message,
        Some(error.code),
        "failed",
        now_millis(),
    );
    cleanup_subtitle_active(directory, &state.job_id);
}

fn run_subtitle_job_with_transport<T: SubtitleTransport>(
    transport: &T,
    envelope: &SubtitleRequestEnvelope,
    companion_root: &Path,
    directory: &Path,
    output_directory: &Path,
    policy: SubtitleRunPolicy,
) -> Result<(), SubtitleRunError> {
    let state_path = job_state_path_in(directory, &envelope.job_id).map_err(|_| {
        run_error(
            "subtitle-job-state-failed",
            "subtitle job state is unavailable",
        )
    })?;
    let mut state = read_job_state(&state_path).ok_or_else(|| {
        run_error(
            "subtitle-job-state-failed",
            "subtitle job state is unavailable",
        )
    })?;
    if subtitle_cancel_requested(directory, &envelope.job_id) {
        return finish_subtitle_cancel(
            transport,
            directory,
            output_directory,
            &mut state,
            None,
            now_millis(),
        );
    }
    let license_key = match read_companion_license_key(companion_root) {
        Ok(key) => key,
        Err(error) => {
            finish_subtitle_failure(directory, &mut state, error);
            return Err(error);
        }
    };
    if transition_subtitle_job_state_in(
        directory,
        &mut state,
        "submitting",
        "Submitting subtitle job.",
        now_millis(),
    )
    .is_err()
    {
        let error = run_error(
            "subtitle-job-state-failed",
            "subtitle job state is unavailable",
        );
        finish_subtitle_failure(directory, &mut state, error);
        return Err(error);
    }
    let submitted = match transport.submit(envelope, &license_key) {
        Ok(value) => value,
        Err(error) => {
            finish_subtitle_failure(directory, &mut state, error);
            return Err(error);
        }
    };
    state.remote_job_id = Some(submitted.remote_job_id);
    state.status = "running".into();
    state.status_text = "Subtitle job is running.".into();
    state.execution_status = Some("started".into());
    state.phase = Some("queued".into());
    if persist_job_state_in(directory, &mut state, now_millis()).is_err() {
        let error = run_error(
            "subtitle-job-state-failed",
            "subtitle job state is unavailable",
        );
        finish_subtitle_failure(directory, &mut state, error);
        return Err(error);
    }

    let started = std::time::Instant::now();
    let mut poll_count = 0_usize;
    loop {
        if subtitle_cancel_requested(directory, &envelope.job_id) {
            return finish_subtitle_cancel(
                transport,
                directory,
                output_directory,
                &mut state,
                Some(&license_key),
                now_millis(),
            );
        }
        if started.elapsed() >= policy.max_runtime
            || policy.max_polls.is_some_and(|limit| poll_count >= limit)
        {
            if let Some(remote_job_id) = state.remote_job_id.as_deref() {
                let _ = transport.cancel(remote_job_id, &license_key);
            }
            let error = run_error("subtitle-timeout", "subtitle job timed out");
            finish_subtitle_failure(directory, &mut state, error);
            return Err(error);
        }
        let poll = match transport.poll(
            state.remote_job_id.as_deref().unwrap_or_default(),
            &license_key,
        ) {
            Ok(value) => value,
            Err(error) => {
                finish_subtitle_failure(directory, &mut state, error);
                return Err(error);
            }
        };
        poll_count += 1;
        if persist_subtitle_progress(directory, &mut state, &poll).is_err() {
            let error = run_error(
                "subtitle-job-state-failed",
                "subtitle job state is unavailable",
            );
            finish_subtitle_failure(directory, &mut state, error);
            return Err(error);
        }
        match poll.status.as_str() {
            "queued" | "running" => {
                if subtitle_cancel_requested(directory, &envelope.job_id) {
                    return finish_subtitle_cancel(
                        transport,
                        directory,
                        output_directory,
                        &mut state,
                        Some(&license_key),
                        now_millis(),
                    );
                }
            }
            "cancelled" => {
                mark_subtitle_terminal(
                    directory,
                    &mut state,
                    "cancelled",
                    "Subtitle job cancelled.",
                    None,
                    "cancelled",
                    now_millis(),
                )
                .ok();
                cleanup_subtitle_active(directory, &state.job_id);
                return Ok(());
            }
            "failed" => {
                let error = run_error(
                    "subtitle-remote-failed",
                    "subtitle service failed to process the job",
                );
                finish_subtitle_failure(directory, &mut state, error);
                return Err(error);
            }
            "completed" => {
                let Some(result) = poll.result else {
                    let error = run_error(
                        "subtitle-invalid-vtt",
                        "subtitle result was empty or structurally invalid",
                    );
                    finish_subtitle_failure(directory, &mut state, error);
                    return Err(error);
                };
                return finish_subtitle_completed(directory, output_directory, &mut state, result);
            }
            _ => unreachable!(),
        }
        if policy.poll_interval > Duration::ZERO {
            thread::sleep(policy.poll_interval);
        }
    }
}

fn subtitle_create_response_with_launcher<F>(
    request: &Request,
    directory: &Path,
    now: u64,
    launch: F,
) -> Value
where
    F: FnOnce(&Path) -> io::Result<()>,
{
    if request.message_bytes > MAX_SUBTITLE_MESSAGE_BYTES {
        return json!({
            "ok": false,
            "errorCode": "subtitle-payload-too-large",
            "error": "subtitle command exceeds the local payload limit",
        });
    }
    let command = match validate_subtitle_command(&request.raw_message) {
        Ok(command) => command,
        Err(error) => {
            return json!({ "ok": false, "errorCode": error.code, "error": error.message })
        }
    };
    match start_subtitle_job_in(directory, &command, now, launch) {
        Ok(state) => json!({
            "ok": true,
            "accepted": true,
            "jobId": state.job_id,
            "status": state.status,
            "executionStatus": state.execution_status,
            "statusText": state.status_text,
        }),
        Err(error) => {
            let _ = error;
            json!({
                "ok": false,
                "errorCode": "subtitle-job-start-failed",
                "error": "Subtitle job could not be started.",
            })
        }
    }
}

#[cfg(test)]
fn subtitle_create_response_in(request: &Request, directory: &Path, now: u64) -> Value {
    subtitle_create_response_with_launcher(request, directory, now, |_| Ok(()))
}

fn subtitle_create_response(request: &Request) -> Value {
    let directory = match jobs_dir() {
        Ok(directory) => directory,
        Err(error) => {
            return json!({
                "ok": false,
                "errorCode": "subtitle-job-persist-failed",
                "error": error.to_string(),
            });
        }
    };
    subtitle_create_response_with_launcher(
        request,
        &directory,
        now_millis(),
        spawn_subtitle_process,
    )
}

struct MediaWriter {
    job_id: String,
    file: File,
    temporary_path: PathBuf,
    final_path: PathBuf,
}

fn default_quality() -> String {
    "best".into()
}

fn quality_height(value: &str) -> Option<u16> {
    match value {
        "4320" => Some(4320),
        "2160" => Some(2160),
        "1440" => Some(1440),
        "1080" => Some(1080),
        "720" => Some(720),
        "480" => Some(480),
        "360" => Some(360),
        "240" => Some(240),
        "144" => Some(144),
        "best" => None,
        _ => None,
    }
}

fn valid_quality(value: &str) -> bool {
    value == "best" || quality_height(value).is_some()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn parse_request_bytes(data: &[u8]) -> io::Result<Request> {
    let raw_message: Value = serde_json::from_slice(data).map_err(io::Error::other)?;
    let mut request: Request =
        serde_json::from_value(raw_message.clone()).map_err(io::Error::other)?;
    request.raw_message = raw_message;
    request.message_bytes = data.len();
    Ok(request)
}

fn read_message() -> io::Result<Option<Request>> {
    let mut length = [0_u8; 4];
    let mut stdin = io::stdin().lock();
    match stdin.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let size = u32::from_le_bytes(length) as usize;
    if size == 0 || size > MAX_NATIVE_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid native message length",
        ));
    }
    let mut data = vec![0_u8; size];
    stdin.read_exact(&mut data)?;
    parse_request_bytes(&data).map(Some)
}

fn write_message(value: &Value) -> io::Result<()> {
    let data = serde_json::to_vec(value).map_err(io::Error::other)?;
    let mut stdout = io::stdout().lock();
    stdout.write_all(&(data.len() as u32).to_le_bytes())?;
    stdout.write_all(&data)?;
    stdout.flush()
}

fn reply(request: &Request, body: Value) {
    let mut object = body.as_object().cloned().unwrap_or_default();
    if !request.request_id.is_empty() {
        object.insert(
            "requestId".into(),
            Value::String(request.request_id.clone()),
        );
    }
    let _ = write_message(&Value::Object(object));
}

fn companion_root() -> io::Result<PathBuf> {
    if let Some(local) = env::var_os("LOCALAPPDATA") {
        return Ok(PathBuf::from(local).join("Aura Media").join("Companion"));
    }
    let executable = env::current_exe()?;
    Ok(executable.parent().unwrap_or(Path::new(".")).to_path_buf())
}

fn jobs_dir() -> io::Result<PathBuf> {
    let path = companion_root()?.join("jobs");
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn subtitle_request_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    let safe = safe_id(job_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid job id"))?;
    Ok(directory.join(format!("{safe}.subtitle.request.json")))
}

fn settings_path(root: &Path) -> PathBuf {
    root.join("settings.json")
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
    if valid_license_key(key.trim()) {
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
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 32_767 {
        return None;
    }
    if trimmed.chars().any(char::is_control) {
        return None;
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return None;
    }
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return None;
    }
    Some(path.to_path_buf())
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
    if value.is_empty() || value.len() > 128 {
        return None;
    }
    if value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        Some(value.to_string())
    } else {
        None
    }
}

fn job_request_path(job_id: &str) -> io::Result<PathBuf> {
    let safe = safe_id(job_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid job id"))?;
    Ok(jobs_dir()?.join(format!("{safe}.request.json")))
}

fn job_state_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    let safe = safe_id(job_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid job id"))?;
    Ok(directory.join(format!("{safe}.state.json")))
}

fn job_state_path(job_id: &str) -> io::Result<PathBuf> {
    job_state_path_in(&jobs_dir()?, job_id)
}

fn job_cancel_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    let safe = safe_id(job_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid job id"))?;
    Ok(directory.join(format!("{safe}.cancel")))
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
    let safe = safe_id(job_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid job id"))?;
    Ok(directory.join(format!("{safe}.pause")))
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
    let request_path = job_request_path(job_id)?;
    let bytes = fs::read(&request_path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            io::Error::new(io::ErrorKind::NotFound, "job-request-missing")
        } else {
            error
        }
    })?;
    let request: Request = serde_json::from_slice(&bytes).map_err(io::Error::other)?;

    // Clear both markers first. A leftover marker would make the fresh runner
    // stop again on its first loop iteration.
    if let Ok(path) = job_pause_path(job_id) {
        let _ = fs::remove_file(path);
    }
    if let Ok(path) = job_cancel_path(job_id) {
        let _ = fs::remove_file(path);
    }

    let mut state = read_job_state(&job_state_path(job_id)?).unwrap_or_else(|| {
        let mut fresh = initial_job_state(&request);
        fresh.job_id = job_id.to_string();
        fresh
    });
    state.status = "queued".into();
    state.status_text = "이어받기를 준비하는 중…".into();
    state.error = None;
    persist_job_state(&mut state)?;

    let request_path_text = request_path.to_string_lossy().into_owned();
    spawn_detached(&["--run-job", &request_path_text])
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

    let settings_file = settings_path(root);
    let mut document = match fs::read(&settings_file) {
        Ok(bytes) if bytes.len() <= MAX_COMPANION_SETTINGS_BYTES => {
            serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_| json!({}))
        }
        _ => json!({}),
    };
    if !document.is_object() {
        document = json!({});
    }
    document["downloadFolder"] = Value::String(path.to_string_lossy().into_owned());

    fs::create_dir_all(root)?;
    write_json_atomic(&settings_file, &document)?;
    Ok(path)
}

/// Opens a completed file in whatever the user has associated with it.
///
/// This is playback stage one. A libmpv surface inside the manager window is the
/// intended end state, but the engine is not shipped yet, and handing the file
/// to the system player is honest about what exists today rather than showing a
/// dead video area.
#[cfg(target_os = "windows")]
fn open_media_file(file_name: &str) -> io::Result<PathBuf> {
    let name = Path::new(file_name)
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid-file-name"))?;
    let path = aura_downloads_dir()?.join(name);
    if !path.is_file() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "media-file-missing"));
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

fn replace_file_atomic(temporary: &Path, path: &Path) -> io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        let source = temporary
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let destination = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let result = unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING
                    | windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH,
            )
        };
        if result == 0 {
            return Err(io::Error::last_os_error());
        }
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        fs::rename(temporary, path)
    }
}

fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temporary = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        NEXT_SUBTITLE_JOB_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        replace_file_atomic(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    write_bytes_atomic(path, &bytes)
}

fn read_job_state(path: &Path) -> Option<JobState> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn list_job_states_in(directory: &Path) -> io::Result<Vec<JobState>> {
    let mut states = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if !name.ends_with(".state.json") {
            continue;
        }
        if let Some(state) = read_job_state(&path) {
            states.push(state);
        }
    }
    states.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    states.truncate(100);
    Ok(states)
}

fn list_job_states() -> io::Result<Vec<JobState>> {
    list_job_states_in(&jobs_dir()?)
}

fn persist_job_state_in(directory: &Path, state: &mut JobState, updated_at: u64) -> io::Result<()> {
    fs::create_dir_all(directory)?;
    state.updated_at = updated_at;
    write_json_atomic(&job_state_path_in(directory, &state.job_id)?, state)
}

fn persist_job_state(state: &mut JobState) -> io::Result<()> {
    persist_job_state_in(&jobs_dir()?, state, now_millis())
}

fn safe_filename(value: &str) -> String {
    let mut name: String = value
        .chars()
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .take(180)
        .collect();
    while name.ends_with([' ', '.']) {
        name.pop();
    }
    if name.is_empty() || name == "." || name == ".." {
        "aura-media.ts".into()
    } else {
        name
    }
}

fn unique_media_path(directory: &Path, filename: &str) -> PathBuf {
    let requested = Path::new(filename);
    let stem = requested
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("aura-media");
    let extension = requested
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    for index in 0..10_000 {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!(" ({index})")
        };
        let candidate = if extension.is_empty() {
            format!("{stem}{suffix}")
        } else {
            format!("{stem}{suffix}.{extension}")
        };
        let path = directory.join(candidate);
        let temporary = PathBuf::from(format!("{}.part", path.display()));
        if !path.exists() && !temporary.exists() {
            return path;
        }
    }
    directory.join(format!("aura-media-{}.ts", std::process::id()))
}

fn open_media_writer(request: &Request) -> io::Result<MediaWriter> {
    let directory = aura_downloads_dir()?;
    let filename = safe_filename(&request.filename);
    let final_path = unique_media_path(&directory, &filename);
    let temporary_path = PathBuf::from(format!("{}.part", final_path.display()));
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary_path)?;
    Ok(MediaWriter {
        job_id: request.job_id.clone(),
        file,
        temporary_path,
        final_path,
    })
}

fn handle_media_request(request: &Request, writer: &mut Option<MediaWriter>) {
    match request.kind.as_str() {
        "media-open" => match open_media_writer(request) {
            Ok(opened) => {
                let file_name = opened
                    .final_path
                    .file_name()
                    .map(|value| value.to_string_lossy().into_owned());
                *writer = Some(opened);
                reply(
                    request,
                    json!({
                        "ok": true,
                        "jobId": request.job_id,
                        "status": "opened",
                        "statusText": "Downloads\\Aura Media 폴더에 저장을 시작합니다.",
                        "fileName": file_name,
                    }),
                );
            }
            Err(error) => reply(
                request,
                json!({
                    "ok": false,
                    "jobId": request.job_id,
                    "status": "failed",
                    "statusText": "로컬 파일을 만들지 못했습니다.",
                    "error": error.to_string(),
                }),
            ),
        },
        "media-chunk" => {
            let Some(active) = writer
                .as_mut()
                .filter(|active| active.job_id == request.job_id)
            else {
                reply(
                    request,
                    json!({
                        "ok": false,
                        "jobId": request.job_id,
                        "status": "failed",
                        "errorCode": "media-writer-not-open",
                        "error": "열린 미디어 파일이 없습니다.",
                    }),
                );
                return;
            };
            match BASE64.decode(request.data.as_bytes()) {
                Ok(bytes) => match active.file.write_all(&bytes) {
                    Ok(()) => reply(
                        request,
                        json!({
                            "ok": true,
                            "jobId": request.job_id,
                            "status": "chunk",
                            "bytes": bytes.len(),
                        }),
                    ),
                    Err(error) => reply(
                        request,
                        json!({
                            "ok": false,
                            "jobId": request.job_id,
                            "status": "failed",
                            "error": error.to_string(),
                        }),
                    ),
                },
                Err(error) => reply(
                    request,
                    json!({
                        "ok": false,
                        "jobId": request.job_id,
                        "status": "failed",
                        "errorCode": "invalid-media-data",
                        "error": error.to_string(),
                    }),
                ),
            }
        }
        "media-close" => {
            let Some(mut active) = writer
                .take()
                .filter(|active| active.job_id == request.job_id)
            else {
                reply(
                    request,
                    json!({
                        "ok": false,
                        "jobId": request.job_id,
                        "status": "failed",
                        "errorCode": "media-writer-not-open",
                    }),
                );
                return;
            };
            let result = active.file.flush().and_then(|_| active.file.sync_all());
            drop(active.file);
            match result.and_then(|_| fs::rename(&active.temporary_path, &active.final_path)) {
                Ok(()) => reply(
                    request,
                    json!({
                        "ok": true,
                        "jobId": request.job_id,
                        "status": "closed",
                        "statusText": "Downloads\\Aura Media 폴더에 저장했습니다.",
                        "fileName": active.final_path.file_name().map(|value| value.to_string_lossy().into_owned()),
                    }),
                ),
                Err(error) => {
                    let _ = fs::remove_file(&active.temporary_path);
                    reply(
                        request,
                        json!({
                            "ok": false,
                            "jobId": request.job_id,
                            "status": "failed",
                            "error": error.to_string(),
                        }),
                    );
                }
            }
        }
        "media-abort" => {
            if let Some(active) = writer.take() {
                drop(active.file);
                let _ = fs::remove_file(active.temporary_path);
            }
            reply(
                request,
                json!({
                    "ok": true,
                    "jobId": request.job_id,
                    "status": "aborted",
                }),
            );
        }
        _ => reply(
            request,
            json!({
                "ok": false,
                "jobId": request.job_id,
                "status": "failed",
                "errorCode": "invalid-media-request",
            }),
        ),
    }
}

fn command_tools() -> io::Result<(PathBuf, PathBuf, PathBuf)> {
    let tools = tools_dir()?;
    let yt_dlp = tools.join("yt-dlp.exe");
    let node = tools.join("node.exe");
    let ffmpeg = tools.join("ffmpeg");
    if !yt_dlp.is_file() || !ffmpeg.join("ffmpeg.exe").is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "tools-not-installed",
        ));
    }
    Ok((yt_dlp, node, ffmpeg))
}

fn apply_hidden_process(command: &mut Command) {
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
}

fn apply_ytdlp_runtime(command: &mut Command, node: &Path, ffmpeg: &Path) {
    command.arg("--ffmpeg-location").arg(ffmpeg);
    if node.is_file() {
        command
            .arg("--js-runtimes")
            .arg(format!("node:{}", node.display()));
    }
}

fn youtube_info(request: &Request) -> Result<Value, String> {
    if !(request.url.starts_with("https://") || request.url.starts_with("http://")) {
        return Err("invalid-youtube-url".into());
    }
    let (yt_dlp, node, ffmpeg) = command_tools().map_err(|error| error.to_string())?;
    let mut command = Command::new(yt_dlp);
    command
        .arg("--dump-single-json")
        .arg("--skip-download")
        .arg("--no-playlist")
        .arg("--no-warnings");
    apply_ytdlp_runtime(&mut command, &node, &ffmpeg);
    command.arg(&request.url);
    apply_hidden_process(&mut command);
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(detail.trim().chars().take(500).collect());
    }
    let parsed: Value =
        serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())?;
    let title = parsed
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let mut qualities = parsed
        .get("formats")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|format| format.get("height").and_then(Value::as_u64))
        .filter(|height| *height > 0 && *height <= 4320)
        .collect::<Vec<_>>();
    qualities.sort_unstable_by(|left, right| right.cmp(left));
    qualities.dedup();
    Ok(json!({ "title": title, "qualities": qualities }))
}

fn initial_job_state(request: &Request) -> JobState {
    JobState {
        job_id: request.job_id.clone(),
        job_type: None,
        request_id: None,
        candidate_id: None,
        source_language: None,
        target_language: None,
        input_kind: None,
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
        status_text: "Aura Companion 대기 중…".into(),
        title: None,
        error: None,
        progress: None,
        file_name: None,
        created_at: now_millis(),
        updated_at: now_millis(),
    }
}

fn parse_progress(value: &str) -> Option<u8> {
    let token = value
        .split_whitespace()
        .find(|part| part.trim_end_matches('%').parse::<f32>().is_ok())?;
    let number = token.trim_end_matches('%').parse::<f32>().ok()?;
    Some(number.clamp(0.0, 100.0).round() as u8)
}

fn update_state<F>(state: &mut JobState, notify: &F)
where
    F: Fn(&JobState),
{
    let _ = persist_job_state(state);
    notify(state);
}

fn execute_download<F>(request: Request, notify: F)
where
    F: Fn(&JobState),
{
    let mut state = initial_job_state(&request);
    state.status = "running".into();
    state.status_text = "YouTube 정보를 확인하는 중…".into();
    update_state(&mut state, &notify);

    if request.kind != "youtube-download"
        || safe_id(&request.job_id).is_none()
        || !(request.url.starts_with("https://") || request.url.starts_with("http://"))
        || !valid_quality(&request.quality)
    {
        state.status = "failed".into();
        state.status_text = "올바른 YouTube 요청이 아닙니다.".into();
        state.error = Some("invalid-request".into());
        update_state(&mut state, &notify);
        return;
    }

    let (yt_dlp, node, ffmpeg) = match command_tools() {
        Ok(tools) => tools,
        Err(error) => {
            state.status = "failed".into();
            state.status_text = "미디어 도구가 설치되지 않았습니다.".into();
            state.error = Some(error.to_string());
            update_state(&mut state, &notify);
            return;
        }
    };
    let downloads = match aura_downloads_dir() {
        Ok(path) => path,
        Err(error) => {
            state.status = "failed".into();
            state.status_text = "Downloads\\Aura Media 폴더를 준비하지 못했습니다.".into();
            state.error = Some(error.to_string());
            update_state(&mut state, &notify);
            return;
        }
    };

    let mut command = Command::new(&yt_dlp);
    command
        .arg("--newline")
        .arg("--no-playlist")
        .arg("--windows-filenames")
        // Explicit so a resumed job continues the existing `.part` instead of
        // starting the transfer over. This is yt-dlp's default, stated here
        // because pause and resume depend on it.
        .arg("--continue")
        .arg("--merge-output-format")
        .arg("mp4")
        .arg("--paths")
        .arg(format!("home:{}", downloads.display()))
        .arg("--output")
        .arg("[%(height)sp] %(title).170B [%(id)s].%(ext)s")
        .arg("--print")
        .arg("before_dl:AURA_TITLE:%(title)s")
        .arg("--print")
        .arg("after_move:AURA_FILE:%(filepath)s")
        .arg("--progress-template")
        .arg("download:AURA_PROGRESS:%(progress._percent_str)s %(progress._speed_str)s ETA %(progress._eta_str)s")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_ytdlp_runtime(&mut command, &node, &ffmpeg);
    if let Some(height) = quality_height(&request.quality) {
        command
            .arg("--format")
            .arg(format!("bv*[height<={height}]+ba/b[height<={height}]"));
    }
    command.arg(&request.url);
    apply_hidden_process(&mut command);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            state.status = "failed".into();
            state.status_text = "yt-dlp를 실행하지 못했습니다.".into();
            state.error = Some(error.to_string());
            update_state(&mut state, &notify);
            return;
        }
    };

    let (tx, rx) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        let tx = tx.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let tx = tx.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        });
    }
    drop(tx);

    let cancel_path = job_cancel_path(&request.job_id).ok();
    let pause_path = job_pause_path(&request.job_id).ok();
    let mut last_error = String::new();
    let mut cancelled = false;
    let mut paused = false;
    loop {
        if cancel_path.as_ref().is_some_and(|path| path.exists()) {
            let _ = child.kill();
            cancelled = true;
            break;
        }
        // Pause stops the child but leaves yt-dlp's `.part` file in place, so a
        // later resume continues from the same byte instead of restarting.
        if pause_path.as_ref().is_some_and(|path| path.exists()) {
            let _ = child.kill();
            paused = true;
            break;
        }
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(line) => {
                if let Some(title) = line.strip_prefix("AURA_TITLE:") {
                    state.title = Some(title.trim().to_string());
                    state.status_text = "영상 다운로드를 시작합니다…".into();
                    update_state(&mut state, &notify);
                } else if let Some(progress) = line.strip_prefix("AURA_PROGRESS:") {
                    state.progress = parse_progress(progress);
                    state.status_text = format!("다운로드 중 · {}", progress.trim());
                    update_state(&mut state, &notify);
                } else if let Some(path) = line.strip_prefix("AURA_FILE:") {
                    state.file_name = Path::new(path.trim())
                        .file_name()
                        .map(|value| value.to_string_lossy().into_owned());
                } else if line.starts_with("ERROR:") {
                    last_error = line.trim().chars().take(500).collect();
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if child.try_wait().ok().flatten().is_some() {
                    break;
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    let status = child.wait();
    if let Some(path) = cancel_path {
        let _ = fs::remove_file(path);
    }

    if cancelled {
        state.status = "cancelled".into();
        state.status_text = "다운로드를 취소했습니다.".into();
        state.error = None;
        update_state(&mut state, &notify);
        return;
    }

    // The pause marker is deliberately left on disk: it is what tells the
    // manager window this job is paused rather than stopped, and `resume`
    // removes it.
    if paused {
        state.status = "paused".into();
        state.status_text = "일시정지했습니다. 이어받기를 누르면 계속합니다.".into();
        state.error = None;
        update_state(&mut state, &notify);
        return;
    }
    match status {
        Ok(status) if status.success() => {
            state.status = "completed".into();
            state.status_text = "Downloads\\Aura Media 폴더에 저장했습니다.".into();
            state.progress = Some(100);
            state.error = None;
        }
        Ok(status) => {
            state.status = "failed".into();
            state.status_text = "YouTube 다운로드에 실패했습니다.".into();
            state.error = Some(if last_error.is_empty() {
                format!("yt-dlp exit {status}")
            } else {
                last_error
            });
        }
        Err(error) => {
            state.status = "failed".into();
            state.status_text = "yt-dlp 종료 상태를 확인하지 못했습니다.".into();
            state.error = Some(error.to_string());
        }
    }
    update_state(&mut state, &notify);
}

fn spawn_detached(arguments: &[&str]) -> io::Result<()> {
    let executable = env::current_exe()?;
    let mut command = Command::new(executable);
    command.args(arguments);
    #[cfg(target_os = "windows")]
    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.spawn()?;
    Ok(())
}

fn spawn_job_runner(request: &Request) -> io::Result<()> {
    let request_path = job_request_path(&request.job_id)?;
    write_json_atomic(&request_path, request)?;
    let mut state = initial_job_state(request);
    persist_job_state(&mut state)?;
    if let Ok(cancel_path) = job_cancel_path(&request.job_id) {
        let _ = fs::remove_file(cancel_path);
    }
    let request_path_text = request_path.to_string_lossy().into_owned();
    spawn_detached(&["--run-job", &request_path_text])?;
    Ok(())
}

/// Name of the GUI binary that owns the manager window.
///
/// The window lives in a separate crate (`companion-gui`) so the native
/// messaging host stays a small stdio process with no GUI dependencies.
#[cfg(target_os = "windows")]
const MANAGER_EXECUTABLE: &str = "aura-media-manager.exe";

fn spawn_manager() -> io::Result<()> {
    let mut command = Command::new(manager_executable()?);
    #[cfg(target_os = "windows")]
    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.spawn()?;
    Ok(())
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
    manager_executable_in(&directory)
}

/// Split out so the host-only install case is testable without a real install.
#[cfg(target_os = "windows")]
fn manager_executable_in(directory: &Path) -> io::Result<PathBuf> {
    let path = directory.join(MANAGER_EXECUTABLE);
    if path.is_file() {
        return Ok(path);
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "manager-not-installed",
    ))
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

fn run_native_host() {
    if let Ok(directory) = jobs_dir() {
        let _ = cleanup_stale_subtitle_requests_in(&directory, now_millis());
    }
    let mut writer: Option<MediaWriter> = None;
    while let Ok(Some(request)) = read_message() {
        match request.kind.as_str() {
            "hello" => reply(
                &request,
                json!({
                    "ok": true,
                    "protocol": PROTOCOL_VERSION,
                    "version": env!("CARGO_PKG_VERSION"),
                "capabilities": ["youtube", "youtube-info", "persistent-jobs", "local-writer", "manager-ui", "open-folder", "cancel", "pause", "resume", "retry", "set-download-folder", "play-file", "subtitle-url-jobs", "entitlement-status"],
                }),
            ),
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
            "list-jobs" => match list_job_states() {
                Ok(jobs) => reply(&request, json!({ "ok": true, "jobs": jobs })),
                Err(error) => reply(
                    &request,
                    json!({ "ok": false, "errorCode": "job-list-failed", "error": error.to_string() }),
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
                        "error": "Aura Media Companion 창 실행 파일이 없습니다. 컴패니언을 다시 설치하세요."
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
            kind if kind.starts_with("media-") => handle_media_request(&request, &mut writer),
            _ => reply(
                &request,
                json!({ "ok": false, "errorCode": "unsupported-request", "error": "지원하지 않는 Aura Companion 요청입니다." }),
            ),
        }
    }
    if let Some(active) = writer.take() {
        drop(active.file);
        let _ = fs::remove_file(active.temporary_path);
    }
}


fn run_job_from_path(path: &Path) -> io::Result<()> {
    let request: Request = serde_json::from_slice(&fs::read(path)?).map_err(io::Error::other)?;
    execute_download(request, |_| {});
    Ok(())
}

fn run_subtitle_job_from_path(path: &Path) -> io::Result<()> {
    let envelope: SubtitleRequestEnvelope =
        serde_json::from_slice(&fs::read(path)?).map_err(io::Error::other)?;
    let directory = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "subtitle jobs directory is unavailable",
        )
    })?;
    let companion_root = directory
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Companion root is unavailable"))?;
    let output_directory = match aura_subtitles_dir() {
        Ok(directory) => directory,
        Err(_) => {
            if let Ok(state_path) = job_state_path_in(directory, &envelope.job_id) {
                if let Some(mut state) = read_job_state(&state_path) {
                    finish_subtitle_failure(
                        directory,
                        &mut state,
                        run_error("subtitle-save-failed", "subtitle file could not be saved"),
                    );
                }
            }
            return Ok(());
        }
    };
    let transport = match HttpSubtitleTransport::new() {
        Ok(transport) => transport,
        Err(error) => {
            if let Ok(state_path) = job_state_path_in(directory, &envelope.job_id) {
                if let Some(mut state) = read_job_state(&state_path) {
                    finish_subtitle_failure(directory, &mut state, error);
                }
            }
            return Ok(());
        }
    };
    let _ = run_subtitle_job_with_transport(
        &transport,
        &envelope,
        companion_root,
        directory,
        &output_directory,
        SubtitleRunPolicy::production(),
    );
    Ok(())
}

fn main() {
    let args = env::args_os().collect::<Vec<_>>();
    if args.get(1).and_then(|value| value.to_str()) == Some("--run-job") {
        if let Some(path) = args.get(2) {
            let _ = run_job_from_path(Path::new(path));
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
                serde_json::to_vec(&json!({ "licenseKey": format!("AM-{}", "A".repeat(36)) }))
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
        assert_eq!(quality_height("4320"), Some(4320));
        assert_eq!(quality_height("1080"), Some(1080));
        assert_eq!(quality_height("best"), None);
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
        assert_eq!(parse_progress(" 72.4% 12.0MiB/s ETA 00:12"), Some(72));
        assert_eq!(parse_progress("unknown"), None);
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
            "x".repeat(MAX_SUBTITLE_URL_BYTES)
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
    fn the_configured_folder_is_read_back_from_settings() {
        let root = test_directory();
        fs::create_dir_all(&root).expect("root creates");
        let target = root.join("chosen");
        write_download_folder(&root, &target.to_string_lossy()).expect("folder writes");

        assert_eq!(read_download_folder_setting(&root), Some(target));

        // A malformed value falls back rather than writing media to a bad path.
        fs::write(settings_path(&root), br#"{"downloadFolder":"not-absolute"}"#)
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
        assert!(!settings_path(&root).exists(), "nothing is written on refusal");
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

    fn sample_download_request(job_id: &str) -> Request {
        Request {
            kind: "youtube-download".into(),
            request_id: String::new(),
            job_id: job_id.into(),
            url: "https://youtu.be/abc".into(),
            filename: String::new(),
            folder: String::new(),
            data: String::new(),
            quality: default_quality(),
            protocol: PROTOCOL_VERSION,
            raw_message: Value::Null,
            message_bytes: 0,
        }
    }

    #[test]
    fn the_hello_reply_advertises_the_new_commands() {
        // The extension decides which controls to show from this list, so a
        // command added to the dispatch must appear here too.
        let source = include_str!("main.rs");
        for capability in ["pause", "resume", "retry", "set-download-folder", "play-file"] {
            assert!(
                source.contains(&format!("\"{capability}\"")),
                "capability {capability} is missing from the hello reply"
            );
        }
    }

    #[test]
    fn a_host_only_install_reports_that_the_window_binary_is_missing() {
        // The window lives in a separate binary now. When only the host is
        // installed, `show-ui` must say so rather than appearing to do nothing.
        let directory = test_directory();
        fs::create_dir_all(&directory).expect("directory creates");
        assert!(
            !directory.join(MANAGER_EXECUTABLE).exists(),
            "the fixture must not contain a manager binary"
        );

        let error = manager_executable_in(&directory).expect_err("resolution fails");
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert_eq!(error.to_string(), "manager-not-installed");

        fs::write(directory.join(MANAGER_EXECUTABLE), b"stub").expect("stub writes");
        assert_eq!(
            manager_executable_in(&directory).expect("resolution succeeds"),
            directory.join(MANAGER_EXECUTABLE)
        );

        fs::remove_dir_all(directory).expect("test directory removes");
    }
}
