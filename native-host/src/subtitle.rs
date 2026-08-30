use std::path::{Path, PathBuf};
use std::process::Command;

pub const WORKER_URL: &str = "https://aura.mdownloader.workers.dev/api/subtitles";
#[cfg(test)]
pub const MAX_URL_BYTES: usize = 4096;
pub const MAX_AUDIO_BYTES: u64 = 80 * 1024 * 1024;
pub const MAX_DURATION_SECONDS: u64 = 60 * 60;

pub fn valid_local_path(value: &Option<String>) -> bool {
    let Some(path) = value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    if path.chars().any(char::is_control) || path.len() > 32_767 {
        return false;
    }
    let path = Path::new(path);
    path.is_absolute()
        && !path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
}

pub fn valid_local_file(value: &Option<String>) -> bool {
    valid_local_path(value) && Path::new(value.as_deref().unwrap_or("")).is_file()
}

pub fn bundled_ffmpeg_executable(ffmpeg_directory: &Path) -> Option<PathBuf> {
    let ffmpeg = ffmpeg_directory.join("ffmpeg.exe");
    ffmpeg.is_file().then_some(ffmpeg)
}

pub fn configure_local_audio_command(command: &mut Command, source: &Path, output: &Path) {
    command
        .arg("-y")
        .arg("-i")
        .arg(source)
        .arg("-vn")
        .arg("-ac")
        .arg("1")
        .arg("-ar")
        .arg("16000")
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg("64k")
        .arg("-t")
        .arg(MAX_DURATION_SECONDS.to_string())
        .arg(output);
}

pub fn encode_title(title: &str) -> String {
    let clipped: String = title.chars().take(240).collect();
    let mut encoded = String::new();
    for byte in clipped.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

use crate::*;

pub(crate) struct Context {
    pub(crate) jobs_directory: PathBuf,
    pub(crate) companion_root: PathBuf,
    pub(crate) output_directory: fn() -> Result<PathBuf, SubtitleRunError>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SubtitleCreateCommand {
    #[serde(rename = "protocolVersion")]
    protocol_version: u32,
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "requestId")]
    request_id: String,
    #[serde(rename = "candidateId")]
    candidate_id: String,
    #[serde(rename = "sourceLanguage")]
    pub(crate) source_language: String,
    #[serde(rename = "targetLanguage")]
    target_language: String,
    mode: String,
    media: SubtitleMedia,
    #[serde(rename = "sourceContext", default)]
    source_context: Option<SubtitleSourceContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SubtitleMedia {
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
    #[serde(
        rename = "localFilePath",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    local_file_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SubtitleSourceContext {
    #[serde(rename = "tabId")]
    tab_id: u32,
    #[serde(rename = "frameId")]
    frame_id: u32,
    #[serde(rename = "contextLeaseId")]
    context_lease_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SubtitleRequestEnvelope {
    pub(crate) job_id: String,
    request_id: String,
    candidate_id: String,
    source_language: String,
    target_language: String,
    media: SubtitleMedia,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CompanionSettings {
    #[serde(rename = "licenseKey", default)]
    pub(crate) license_key: Option<String>,
    #[serde(rename = "licenseEdition", default)]
    pub(crate) license_edition: Option<String>,
    #[serde(rename = "licenseStatus", default)]
    pub(crate) license_status: Option<String>,
    #[serde(rename = "licenseExpiresAt", default)]
    pub(crate) license_expires_at: Option<u64>,
    /// Absolute folder the companion saves media into.
    ///
    /// `None` means the default `%USERPROFILE%\Downloads\Aura Media`. This is
    /// the single source of truth for both entry points: the manager window
    /// writes it, and the extension reads it back through `status`. Neither
    /// side keeps its own copy.
    #[serde(rename = "downloadFolder", default)]
    pub(crate) download_folder: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct SubtitleSubmitResult {
    pub(crate) remote_job_id: String,
}

#[derive(Debug, Clone)]
pub(crate) struct SubtitlePollResult {
    pub(crate) status: String,
    pub(crate) phase: Option<String>,
    pub(crate) progress: Option<u8>,
    pub(crate) completed: Option<u64>,
    pub(crate) total: Option<u64>,
    pub(crate) result: Option<SubtitleResult>,
}

#[derive(Debug, Clone)]
pub(crate) struct SubtitleResult {
    pub(crate) vtt: String,
    pub(crate) model: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SubtitleCancelStatus {
    Cancelled,
    Completed,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct SubtitleRunError {
    pub(crate) code: &'static str,
    pub(crate) message: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct SubtitleRunPolicy {
    pub(crate) poll_interval: Duration,
    pub(crate) max_runtime: Duration,
    pub(crate) max_polls: Option<usize>,
}

impl SubtitleRunPolicy {
    pub(crate) fn production() -> Self {
        Self {
            poll_interval: SUBTITLE_POLL_INTERVAL,
            max_runtime: SUBTITLE_MAX_RUNTIME,
            max_polls: None,
        }
    }
}

pub(crate) trait SubtitleTransport {
    fn submit(
        &self,
        envelope: &SubtitleRequestEnvelope,
        license_key: &str,
        audio_path: Option<&Path>,
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

type JobState = job_store::JobState;

#[derive(Debug, Clone, Copy)]
pub(crate) struct SubtitleValidationError {
    pub(crate) code: &'static str,
    pub(crate) message: &'static str,
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

pub(crate) fn subtitle_error(code: &'static str, message: &'static str) -> SubtitleValidationError {
    SubtitleValidationError { code, message }
}

pub(crate) fn contains_sensitive_header(value: &Value) -> bool {
    media_download::contains_sensitive_header(value)
}

pub(crate) fn bounded_text(value: &str, maximum: usize) -> bool {
    media_download::bounded_text(value, maximum)
}

pub(crate) fn valid_local_subtitle_path(value: &Option<String>) -> bool {
    subtitle::valid_local_path(value)
}

pub(crate) fn valid_local_subtitle_file(value: &Option<String>) -> bool {
    subtitle::valid_local_file(value)
}

pub(crate) fn ffmpeg_executable() -> Result<PathBuf, SubtitleRunError> {
    let ffmpeg_directory = command_tools()
        .map_err(|_| run_error("tools-not-installed", "ffmpeg is not installed"))?
        .2;
    bundled_ffmpeg_executable(&ffmpeg_directory)
        .ok_or_else(|| run_error("tools-not-installed", "ffmpeg is not installed"))
}

pub(crate) fn configure_local_subtitle_audio_command(
    command: &mut Command,
    source: &Path,
    output: &Path,
) {
    subtitle::configure_local_audio_command(command, source, output);
}

pub(crate) fn prepare_local_subtitle_audio(
    envelope: &SubtitleRequestEnvelope,
) -> Result<Option<PathBuf>, SubtitleRunError> {
    let Some(path) = envelope
        .media
        .local_file_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let source = PathBuf::from(path);
    if !valid_local_subtitle_file(&Some(source.to_string_lossy().into_owned())) {
        return Err(run_error(
            "invalid-subtitle-media",
            "local subtitle media file is invalid",
        ));
    }
    let ffmpeg = ffmpeg_executable()?;
    let output = env::temp_dir().join(format!("{}.m4a", envelope.job_id));
    let mut command = Command::new(ffmpeg);
    apply_hidden_process(&mut command);
    configure_local_subtitle_audio_command(&mut command, &source, &output);
    let status = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| {
            run_error(
                "subtitle-audio-extract-failed",
                "audio could not be extracted",
            )
        })?;
    if !status.success() || !output.is_file() {
        let _ = fs::remove_file(&output);
        return Err(run_error(
            "subtitle-audio-extract-failed",
            "audio could not be extracted",
        ));
    }
    let bytes = fs::metadata(&output)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if bytes == 0 || bytes > MAX_SUBTITLE_AUDIO_BYTES {
        let _ = fs::remove_file(&output);
        return Err(run_error(
            "subtitle-audio-too-large",
            "extracted audio is empty or too large",
        ));
    }
    Ok(Some(output))
}

pub(crate) fn submit_local_audio(
    transport: &HttpSubtitleTransport,
    envelope: &SubtitleRequestEnvelope,
    license_key: &str,
    audio_path: &Path,
) -> Result<SubtitleSubmitResult, SubtitleRunError> {
    let bytes = fs::read(audio_path).map_err(|_| {
        run_error(
            "subtitle-audio-extract-failed",
            "extracted audio could not be read",
        )
    })?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_SUBTITLE_AUDIO_BYTES {
        return Err(run_error(
            "subtitle-audio-too-large",
            "extracted audio is empty or too large",
        ));
    }
    let title = encode_subtitle_title(&envelope.media.title);
    let response = transport
        .client
        .post(SUBTITLE_WORKER_URL)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {license_key}"),
        )
        .header(reqwest::header::CONTENT_TYPE, "audio/mp4")
        .header("x-aura-audio-upload", "1")
        .header("x-aura-audio-bytes", bytes.len().to_string())
        .header("x-aura-audio-source", "library-file")
        .header("x-aura-source-language", envelope.source_language.as_str())
        .header("x-aura-title", title)
        .body(bytes)
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

pub(crate) fn encode_subtitle_title(title: &str) -> String {
    subtitle::encode_title(title)
}

pub(crate) fn valid_subtitle_token(value: &str, maximum: usize) -> bool {
    value.len() <= maximum && safe_id(value).is_some()
}

#[cfg(test)]
pub(crate) fn parse_subtitle_command_bytes(
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
        || !(valid_http_url(&command.media.resource_url)
            || valid_local_subtitle_path(&command.media.local_file_path))
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

pub(crate) fn next_subtitle_job_id() -> String {
    let sequence = NEXT_SUBTITLE_JOB_ID.fetch_add(1, Ordering::Relaxed);
    format!("subtitle-{}-{sequence}", now_millis())
}

pub(crate) fn initial_subtitle_job_state(
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

pub(crate) fn create_subtitle_job_in(
    directory: &Path,
    command: &SubtitleCreateCommand,
    job_id: String,
    now: u64,
) -> io::Result<JobState> {
    let mut state = initial_subtitle_job_state(command, job_id, now);
    persist_job_state_in(directory, &mut state, now)?;
    Ok(state)
}

pub(crate) fn subtitle_transition_allowed(current: &str, next: &str) -> bool {
    match current {
        "created" => matches!(next, "preparing" | "failed" | "cancelled"),
        "preparing" => matches!(next, "submitting" | "failed" | "cancelled"),
        "submitting" => matches!(next, "running" | "failed" | "cancelled"),
        "running" => matches!(next, "completed" | "failed" | "cancelled"),
        _ => false,
    }
}

pub(crate) fn transition_subtitle_job_state_in(
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

pub(crate) fn mark_subtitle_terminal(
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

pub(crate) fn subtitle_envelope(
    command: &SubtitleCreateCommand,
    job_id: String,
) -> SubtitleRequestEnvelope {
    SubtitleRequestEnvelope {
        job_id,
        request_id: command.request_id.clone(),
        candidate_id: command.candidate_id.clone(),
        source_language: command.source_language.clone(),
        target_language: command.target_language.clone(),
        media: command.media.clone(),
    }
}

pub(crate) fn cleanup_subtitle_active(directory: &Path, job_id: &str) {
    if let Ok(path) = subtitle_request_path_in(directory, job_id) {
        let _ = fs::remove_file(path);
    }
    if let Ok(path) = job_cancel_path_in(directory, job_id) {
        let _ = fs::remove_file(path);
    }
}

pub(crate) fn cleanup_stale_subtitle_requests_in(directory: &Path, now: u64) -> io::Result<()> {
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

pub(crate) fn start_subtitle_job_in<F>(
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

pub(crate) fn spawn_subtitle_process(path: &Path) -> io::Result<()> {
    let path_text = path.to_string_lossy().into_owned();
    process::spawn_detached(&["--run-subtitle-job", &path_text])
}

pub(crate) fn run_error(code: &'static str, message: &'static str) -> SubtitleRunError {
    SubtitleRunError { code, message }
}

pub(crate) fn valid_remote_job_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
}

pub(crate) fn bounded_remote_phase(value: Option<&Value>) -> Option<String> {
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

pub(crate) fn bounded_remote_model(value: Option<&Value>) -> Option<String> {
    let model = value?.as_str()?;
    bounded_text(model, MAX_SUBTITLE_METADATA_BYTES).then(|| model.to_string())
}

pub(crate) fn known_remote_error(error: &str) -> Option<SubtitleRunError> {
    match error {
        "subtitle-audio-too-large" => Some(run_error(
            "subtitle-audio-too-large",
            "extracted audio exceeds the subtitle upload limit",
        )),
        "audio-size-mismatch" => Some(run_error(
            "audio-size-mismatch",
            "subtitle audio upload size did not match",
        )),
        "invalid-audio-upload" => Some(run_error(
            "invalid-audio-upload",
            "subtitle audio upload was invalid",
        )),
        "invalid-audio-content-type" => Some(run_error(
            "invalid-audio-content-type",
            "subtitle audio type was rejected",
        )),
        "invalid-source-language" => Some(run_error(
            "invalid-source-language",
            "subtitle source language was rejected",
        )),
        "invalid-title" => Some(run_error(
            "invalid-title",
            "subtitle title metadata was rejected",
        )),
        "pro-license-required" => Some(run_error(
            "pro-license-required",
            "a valid Companion Pro license is required",
        )),
        "unauthorized" => Some(run_error(
            "unauthorized",
            "subtitle service authorization was rejected",
        )),
        "rate-limited" => Some(run_error(
            "rate-limited",
            "subtitle service rate limit reached",
        )),
        "asr-not-configured" => Some(run_error(
            "asr-not-configured",
            "subtitle service is not configured",
        )),
        "asr-upstream-unreachable" => Some(run_error(
            "asr-upstream-unreachable",
            "subtitle service upstream is unreachable",
        )),
        "invalid-media-url" => Some(run_error(
            "invalid-media-url",
            "subtitle media URL was rejected",
        )),
        "invalid-modal-response" => Some(run_error(
            "invalid-modal-response",
            "subtitle service returned an invalid response",
        )),
        "modal-request-failed" => Some(run_error(
            "modal-request-failed",
            "subtitle service request failed",
        )),
        "asr-job-owner-unavailable" => Some(run_error(
            "asr-job-owner-unavailable",
            "subtitle job ownership could not be recorded",
        )),
        "subtitle-job-not-owned" => Some(run_error(
            "subtitle-job-not-owned",
            "subtitle job is not owned by this license",
        )),
        "invalid-job-id" => Some(run_error(
            "invalid-job-id",
            "subtitle job identifier was rejected",
        )),
        "job-cancellation-failed" => Some(run_error(
            "job-cancellation-failed",
            "subtitle job cancellation failed",
        )),
        "job-failed" => Some(run_error("job-failed", "subtitle service job failed")),
        "invalid-request" => Some(run_error(
            "invalid-request",
            "subtitle service request was invalid",
        )),
        "invalid-progress-key" => Some(run_error(
            "invalid-progress-key",
            "subtitle progress identifier was invalid",
        )),
        "invalid-audio-path" => Some(run_error(
            "invalid-audio-path",
            "subtitle audio path was invalid",
        )),
        "audio-input-missing" => Some(run_error(
            "audio-input-missing",
            "subtitle audio input was missing",
        )),
        "media-source-access-denied" => Some(run_error(
            "media-source-access-denied",
            "subtitle media source denied access",
        )),
        "media-source-unavailable" => Some(run_error(
            "media-source-unavailable",
            "subtitle media source was unavailable",
        )),
        "subtitle-too-large" => Some(run_error(
            "subtitle-too-large",
            "subtitle result exceeded the service limit",
        )),
        _ => None,
    }
}

pub(crate) fn response_error(status: StatusCode, body: &Value) -> SubtitleRunError {
    if let Some(error) = body
        .get("error")
        .and_then(Value::as_str)
        .and_then(known_remote_error)
    {
        return error;
    }
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

pub(crate) fn read_http_json(
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

pub(crate) fn remote_body_error(status: StatusCode, body: &Value) -> Result<(), SubtitleRunError> {
    if !status.is_success() || body.get("ok").and_then(Value::as_bool) == Some(false) {
        Err(response_error(status, body))
    } else {
        Ok(())
    }
}

pub(crate) fn parse_submit_response(
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

pub(crate) fn parse_progress_value(value: Option<&Value>) -> Option<u8> {
    let number = value?.as_f64()?;
    number
        .is_finite()
        .then(|| number.clamp(0.0, 100.0).round() as u8)
}

pub(crate) fn parse_poll_response(
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
    let result_body = body.get("result").and_then(Value::as_object);
    if let Some(error) = result_body
        .and_then(|result| result.get("error"))
        .and_then(Value::as_str)
    {
        return Err(known_remote_error(error).unwrap_or_else(|| {
            run_error(
                "subtitle-remote-failed",
                "subtitle service failed to process the job",
            )
        }));
    }
    let result = result_body.and_then(|result| {
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

pub(crate) fn parse_cancel_response(
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

pub(crate) struct HttpSubtitleTransport {
    client: Client,
}

impl HttpSubtitleTransport {
    pub(crate) fn new() -> Result<Self, SubtitleRunError> {
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
        audio_path: Option<&Path>,
    ) -> Result<SubtitleSubmitResult, SubtitleRunError> {
        if let Some(path) = audio_path {
            return submit_local_audio(self, envelope, license_key, path);
        }
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

pub(crate) fn parse_vtt_timestamp(value: &str) -> Option<u64> {
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

pub(crate) fn valid_vtt(vtt: &str) -> bool {
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

pub(crate) fn normalize_vtt(vtt: &str) -> String {
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

pub(crate) fn unique_subtitle_path(directory: &Path, title: &str) -> io::Result<PathBuf> {
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

pub(crate) fn save_subtitle_result_in(
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

pub(crate) fn subtitle_cancel_requested(directory: &Path, job_id: &str) -> bool {
    job_cancel_path_in(directory, job_id)
        .ok()
        .is_some_and(|path| path.exists())
}

pub(crate) fn persist_subtitle_progress(
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

pub(crate) fn finish_subtitle_completed(
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

pub(crate) fn finish_subtitle_cancel<T: SubtitleTransport>(
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

pub(crate) fn finish_subtitle_failure(
    directory: &Path,
    state: &mut JobState,
    error: SubtitleRunError,
) {
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

pub(crate) fn run_subtitle_job_with_transport<T: SubtitleTransport>(
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
    let prepared_audio = match prepare_local_subtitle_audio(envelope) {
        Ok(path) => path,
        Err(error) => {
            finish_subtitle_failure(directory, &mut state, error);
            return Err(error);
        }
    };
    if prepared_audio.is_some() {
        state.status_text = "오디오를 추출해 자막 서비스로 보내는 중…".into();
        state.phase = Some("extracting-audio".into());
        let _ = persist_job_state_in(directory, &mut state, now_millis());
    }
    let submitted = match transport.submit(envelope, &license_key, prepared_audio.as_deref()) {
        Ok(value) => value,
        Err(error) => {
            if let Some(path) = &prepared_audio {
                let _ = fs::remove_file(path);
            }
            finish_subtitle_failure(directory, &mut state, error);
            return Err(error);
        }
    };
    if let Some(path) = &prepared_audio {
        let _ = fs::remove_file(path);
    }
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

pub(crate) fn run_from_path(path: &Path, context: Context) -> io::Result<()> {
    let envelope: SubtitleRequestEnvelope =
        serde_json::from_slice(&fs::read(path)?).map_err(io::Error::other)?;
    let Context {
        jobs_directory,
        companion_root,
        output_directory,
    } = context;
    let output_directory = match output_directory() {
        Ok(directory) => directory,
        Err(error) => {
            if let Ok(state_path) = job_state_path_in(&jobs_directory, &envelope.job_id) {
                if let Some(mut state) = read_job_state(&state_path) {
                    finish_subtitle_failure(&jobs_directory, &mut state, error);
                }
            }
            return Ok(());
        }
    };
    let transport = match HttpSubtitleTransport::new() {
        Ok(transport) => transport,
        Err(error) => {
            if let Ok(state_path) = job_state_path_in(&jobs_directory, &envelope.job_id) {
                if let Some(mut state) = read_job_state(&state_path) {
                    finish_subtitle_failure(&jobs_directory, &mut state, error);
                }
            }
            return Ok(());
        }
    };
    let _ = run_subtitle_job_with_transport(
        &transport,
        &envelope,
        &companion_root,
        &jobs_directory,
        &output_directory,
        SubtitleRunPolicy::production(),
    );
    Ok(())
}

pub(crate) fn subtitle_create_response_with_launcher<F>(
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
pub(crate) fn subtitle_create_response_in(request: &Request, directory: &Path, now: u64) -> Value {
    subtitle_create_response_with_launcher(request, directory, now, |_| Ok(()))
}

pub(crate) fn subtitle_create_response(request: &Request) -> Value {
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
