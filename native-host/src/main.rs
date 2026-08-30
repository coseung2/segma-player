#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    FindWindowW, IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE,
};

#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const PROTOCOL_VERSION: u32 = 2;
const MAX_NATIVE_MESSAGE_BYTES: usize = 1024 * 1024;
const MEDIA_DOWNLOAD_COMMAND_VERSION: u32 = 1;
const MAX_MEDIA_DOWNLOAD_MESSAGE_BYTES: usize = 16 * 1024;
const MAX_MEDIA_DOWNLOAD_URL_BYTES: usize = 4096;
const MAX_MEDIA_DOWNLOAD_TITLE_BYTES: usize = 512;
const MAX_MEDIA_DOWNLOAD_ID_BYTES: usize = 128;
const MAX_MEDIA_DOWNLOAD_USER_AGENT_BYTES: usize = 512;
const MAX_MEDIA_DOWNLOAD_ACCEPT_LANGUAGE_BYTES: usize = 256;
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
const SUBTITLE_POLL_INTERVAL: Duration = Duration::from_millis(1_200);
const SUBTITLE_MAX_RUNTIME: Duration = Duration::from_secs(30 * 60);
const SUBTITLE_ACTIVE_MAX_AGE_MS: u64 = 2 * 60 * 60 * 1000;
const MAX_SUBTITLE_AUDIO_BYTES: u64 = 80 * 1024 * 1024;
const MAX_SUBTITLE_DURATION_SECONDS: u64 = 60 * 60;
const MEDIA_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36";
const PROGRESSIVE_RANGE_MIN_CONCURRENCY: usize = 2;
const PROGRESSIVE_RANGE_INITIAL_CONCURRENCY: usize = 4;
const PROGRESSIVE_RANGE_MAX_CONCURRENCY: usize = 16;
const PROGRESSIVE_RANGE_CHUNK_BYTES: u64 = 2 * 1024 * 1024;
const PROGRESSIVE_RANGE_RETRIES: usize = 3;
static NEXT_SUBTITLE_JOB_ID: AtomicU64 = AtomicU64::new(1);
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const YOUTUBE_OUTPUT_TEMPLATE: &str = "[%(height)sp] %(title).170B.%(ext)s";
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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct MediaDownloadCommand {
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "protocolVersion")]
    protocol_version: u32,
    #[serde(rename = "requestId", default)]
    request_id: String,
    #[serde(rename = "jobId")]
    job_id: String,
    #[serde(rename = "candidateId")]
    candidate_id: String,
    url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    referrer: Option<String>,
    title: String,
    #[serde(rename = "inputKind")]
    input_kind: String,
    #[serde(
        rename = "userAgent",
        default,
        skip_serializing_if = "String::is_empty"
    )]
    user_agent: String,
    #[serde(
        rename = "acceptLanguage",
        default,
        skip_serializing_if = "String::is_empty"
    )]
    accept_language: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MediaDownloadValidationError {
    code: &'static str,
    message: &'static str,
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
    #[serde(
        rename = "localFilePath",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    local_file_path: Option<String>,
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
    #[serde(rename = "licenseEdition", default)]
    license_edition: Option<String>,
    #[serde(rename = "licenseStatus", default)]
    license_status: Option<String>,
    #[serde(rename = "licenseExpiresAt", default)]
    license_expires_at: Option<u64>,
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

fn valid_user_agent(value: &str) -> bool {
    value.len() <= MAX_MEDIA_DOWNLOAD_USER_AGENT_BYTES
        && value
            .bytes()
            .all(|byte| byte == b' ' || byte.is_ascii_graphic())
}

fn valid_accept_language(value: &str) -> bool {
    value.len() <= MAX_MEDIA_DOWNLOAD_ACCEPT_LANGUAGE_BYTES
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b',' | b'.' | b';' | b'=' | b'-' | b' ')
        })
}

fn media_download_error(code: &'static str, message: &'static str) -> MediaDownloadValidationError {
    MediaDownloadValidationError { code, message }
}

fn valid_local_subtitle_path(value: &Option<String>) -> bool {
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

fn valid_local_subtitle_file(value: &Option<String>) -> bool {
    valid_local_subtitle_path(value) && Path::new(value.as_deref().unwrap_or("")).is_file()
}

fn ffmpeg_executable() -> Result<PathBuf, SubtitleRunError> {
    let ffmpeg = command_tools()
        .map_err(|_| run_error("tools-not-installed", "ffmpeg is not installed"))?
        .2
        .join("ffmpeg.exe");
    if ffmpeg.is_file() {
        Ok(ffmpeg)
    } else {
        Err(run_error("tools-not-installed", "ffmpeg is not installed"))
    }
}

fn configure_local_subtitle_audio_command(command: &mut Command, source: &Path, output: &Path) {
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
        .arg(MAX_SUBTITLE_DURATION_SECONDS.to_string())
        .arg(output);
}

fn prepare_local_subtitle_audio(
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

fn submit_local_audio(
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

fn encode_subtitle_title(title: &str) -> String {
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

fn public_ipv4_address(address: std::net::Ipv4Addr) -> bool {
    let octets = address.octets();
    !matches!(
        octets,
        [0, ..]
            | [10, ..]
            | [100, 64..=127, ..]
            | [127, ..]
            | [169, 254, ..]
            | [172, 16..=31, ..]
            | [192, 0, 0, ..]
            | [192, 0, 2, ..]
            | [192, 168, ..]
            | [198, 18..=19, ..]
            | [198, 51, 100, ..]
            | [203, 0, 113, ..]
            | [224..=255, ..]
    )
}

fn public_ipv6_address(address: std::net::Ipv6Addr) -> bool {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return public_ipv4_address(mapped);
    }
    let segments = address.segments();
    !(address.is_loopback()
        || address.is_unspecified()
        || segments[0] & 0xfe00 == 0xfc00
        || segments[0] & 0xffc0 == 0xfe80
        || segments[0] & 0xff00 == 0xff00
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

fn public_dns_host(host: &str) -> bool {
    if host.ends_with('.') {
        return false;
    }
    let labels = host.split('.').collect::<Vec<_>>();
    if labels.len() < 2
        || labels.iter().any(|label| {
            label.is_empty()
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return false;
    }
    !["localhost", "local", "internal", "lan"]
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
        && host != "home.arpa"
        && !host.ends_with(".home.arpa")
}

fn valid_http_url(value: &str) -> bool {
    if !bounded_text(value, MAX_SUBTITLE_URL_BYTES)
        || value.is_empty()
        || value.chars().any(char::is_whitespace)
    {
        return false;
    }
    let Ok(parsed) = reqwest::Url::parse(value) else {
        return false;
    };
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
        || parsed.port() == Some(0)
    {
        return false;
    }
    let Some(host) = parsed.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => public_ipv4_address(address),
        Ok(IpAddr::V6(address)) => public_ipv6_address(address),
        Err(_) => public_dns_host(&host),
    }
}

fn validate_media_download_fields(
    command: &MediaDownloadCommand,
) -> Result<(), MediaDownloadValidationError> {
    if command.protocol_version != MEDIA_DOWNLOAD_COMMAND_VERSION {
        return Err(media_download_error(
            "media-download-protocol-unsupported",
            "media download protocol version is unsupported",
        ));
    }
    if command.kind != "media-download" {
        return Err(media_download_error(
            "invalid-media-download-command",
            "media download command type is invalid",
        ));
    }
    if safe_id(&command.job_id).is_none()
        || command.job_id.len() > MAX_MEDIA_DOWNLOAD_ID_BYTES
        || safe_id(&command.candidate_id).is_none()
        || command.candidate_id.len() > MAX_MEDIA_DOWNLOAD_ID_BYTES
    {
        return Err(media_download_error(
            "invalid-media-download-id",
            "job and candidate identifiers must be bounded local tokens",
        ));
    }
    if !bounded_text(&command.url, MAX_MEDIA_DOWNLOAD_URL_BYTES)
        || !valid_http_url(&command.url)
        || command.referrer.as_ref().is_some_and(|referrer| {
            !bounded_text(referrer, MAX_MEDIA_DOWNLOAD_URL_BYTES) || !valid_http_url(referrer)
        })
    {
        return Err(media_download_error(
            "invalid-media-download-url",
            "media URL and referrer must be public HTTP or HTTPS URLs",
        ));
    }
    if !bounded_text(&command.title, MAX_MEDIA_DOWNLOAD_TITLE_BYTES) {
        return Err(media_download_error(
            "invalid-media-download-title",
            "media title is invalid or oversized",
        ));
    }
    if !matches!(
        command.input_kind.as_str(),
        "PROGRESSIVE" | "HLS_MASTER" | "HLS_MEDIA" | "DASH"
    ) {
        return Err(media_download_error(
            "unsupported-media-download-kind",
            "media input kind is unsupported",
        ));
    }
    if (!command.user_agent.is_empty() && !valid_user_agent(&command.user_agent))
        || (!command.accept_language.is_empty() && !valid_accept_language(&command.accept_language))
    {
        return Err(media_download_error(
            "invalid-media-download-browser-context",
            "browser request metadata is invalid or oversized",
        ));
    }
    Ok(())
}

fn validate_media_download_command(
    raw: &Value,
    message_bytes: usize,
) -> Result<MediaDownloadCommand, MediaDownloadValidationError> {
    if message_bytes == 0 || message_bytes > MAX_MEDIA_DOWNLOAD_MESSAGE_BYTES {
        return Err(media_download_error(
            "media-download-payload-too-large",
            "media download command exceeds the local payload limit",
        ));
    }
    if contains_sensitive_header(raw) {
        return Err(media_download_error(
            "media-download-secret-rejected",
            "cookies, authorization, and arbitrary headers are not accepted",
        ));
    }
    let command: MediaDownloadCommand = serde_json::from_value(raw.clone()).map_err(|_| {
        media_download_error(
            "invalid-media-download-command",
            "media download command shape is invalid",
        )
    })?;
    validate_media_download_fields(&command)?;
    Ok(command)
}

#[cfg(test)]
fn parse_media_download_command_bytes(
    data: &[u8],
) -> Result<MediaDownloadCommand, MediaDownloadValidationError> {
    if data.len() > MAX_MEDIA_DOWNLOAD_MESSAGE_BYTES {
        return Err(media_download_error(
            "media-download-payload-too-large",
            "media download command exceeds the local payload limit",
        ));
    }
    let raw: Value = serde_json::from_slice(data).map_err(|_| {
        media_download_error(
            "invalid-media-download-command",
            "media download command is not valid JSON",
        )
    })?;
    validate_media_download_command(&raw, data.len())
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

fn known_remote_error(error: &str) -> Option<SubtitleRunError> {
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

fn response_error(status: StatusCode, body: &Value) -> SubtitleRunError {
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
        Err(response_error(status, body))
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
    state: JobState,
    bytes_written: u64,
    last_state_persisted_at: u64,
    last_state_persisted_bytes: u64,
}

const MEDIA_STATE_PERSIST_INTERVAL_MS: u64 = 750;
const MEDIA_STATE_PERSIST_BYTE_INTERVAL: u64 = 8 * 1024 * 1024;

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
    open_media_writer_in(&directory, request)
}

fn open_media_writer_in(directory: &Path, request: &Request) -> io::Result<MediaWriter> {
    let (final_path, temporary_path, file, bytes_written) =
        if request.resume_file_name.trim().is_empty() {
            let filename = safe_filename(&request.filename);
            let final_path = unique_media_path(&directory, &filename);
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

fn initial_media_writer_state(
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
        progress: request.total.filter(|total| *total > 0).map(|total| {
            ((bytes_written as f64 / total as f64) * 100.0)
                .round()
                .clamp(0.0, 99.0) as u8
        }),
        file_name: final_path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned()),
        created_at: now,
        updated_at: now,
    }
}

fn cancel_media_writer_in(mut active: MediaWriter, jobs_directory: &Path) -> io::Result<()> {
    active.state.status = "cancelled".into();
    active.state.status_text = "다운로드를 취소했습니다.".into();
    active.state.error = None;
    persist_job_state_in(jobs_directory, &mut active.state, now_millis())?;

    let temporary_path = active.temporary_path.clone();
    let cancel_path = job_cancel_path_in(jobs_directory, &active.job_id)?;
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

fn handle_media_request(request: &Request, writer: &mut Option<MediaWriter>) {
    match request.kind.as_str() {
        "media-open" => match open_media_writer(request) {
            Ok(mut opened) => {
                let file_name = opened
                    .final_path
                    .file_name()
                    .map(|value| value.to_string_lossy().into_owned());
                let bytes_written = opened.bytes_written;
                let _ = persist_job_state(&mut opened.state);
                if request.show_ui.unwrap_or(true) {
                    let _ = spawn_manager();
                }
                *writer = Some(opened);
                reply(
                    request,
                    json!({
                        "ok": true,
                        "jobId": request.job_id,
                        "status": "opened",
                        "statusText": "Downloads\\Aura Media 폴더에 저장을 시작합니다.",
                        "fileName": file_name,
                        "bytesWritten": bytes_written,
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
            let matching_writer = writer
                .as_ref()
                .is_some_and(|active| active.job_id == request.job_id);
            if !matching_writer {
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
            }
            let jobs_directory = jobs_dir();
            let cancel_requested = jobs_directory
                .as_ref()
                .ok()
                .and_then(|directory| job_cancel_path_in(directory, &request.job_id).ok())
                .is_some_and(|path| path.exists());
            if cancel_requested {
                let result = jobs_directory.and_then(|directory| {
                    let active = writer.take().expect("matching writer checked above");
                    cancel_media_writer_in(active, &directory)
                });
                reply(
                    request,
                    json!({
                        "ok": false,
                        "jobId": request.job_id,
                        "status": "cancelled",
                        "errorCode": "download-cancelled",
                        "error": result.err().map_or_else(
                            || "다운로드를 취소했습니다.".to_string(),
                            |error| format!("다운로드 취소 정리 중 오류가 발생했습니다: {error}"),
                        ),
                    }),
                );
                return;
            }
            let active = writer.as_mut().expect("matching writer checked above");
            match BASE64.decode(request.data.as_bytes()) {
                Ok(bytes) => match active.file.write_all(&bytes) {
                    Ok(()) => {
                        active.bytes_written =
                            active.bytes_written.saturating_add(bytes.len() as u64);
                        active.state.completed = Some(active.bytes_written);
                        active.state.progress =
                            active.state.total.filter(|total| *total > 0).map(|total| {
                                ((active.bytes_written as f64 / total as f64) * 100.0)
                                    .round()
                                    .clamp(0.0, 99.0) as u8
                            });
                        active.state.status_text = match active.state.progress {
                            Some(progress) => format!("브라우저에서 미디어를 받는 중… {progress}%"),
                            None => format!(
                                "브라우저에서 미디어를 받는 중… {} MB",
                                active.bytes_written / 1_048_576
                            ),
                        };
                        let now = now_millis();
                        if now.saturating_sub(active.last_state_persisted_at)
                            >= MEDIA_STATE_PERSIST_INTERVAL_MS
                            || active
                                .bytes_written
                                .saturating_sub(active.last_state_persisted_bytes)
                                >= MEDIA_STATE_PERSIST_BYTE_INTERVAL
                        {
                            let _ = persist_job_state(&mut active.state);
                            active.last_state_persisted_at = now;
                            active.last_state_persisted_bytes = active.bytes_written;
                        }
                        reply(
                            request,
                            json!({
                                "ok": true,
                                "jobId": request.job_id,
                                "status": "chunk",
                                "bytes": bytes.len(),
                                "bytesWritten": active.bytes_written,
                            }),
                        );
                    }
                    Err(error) => {
                        active.state.status = "failed".into();
                        active.state.status_text = "다운로드 파일을 쓰지 못했습니다.".into();
                        active.state.error = Some(error.to_string());
                        let _ = persist_job_state(&mut active.state);
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
                    reply(
                        request,
                        json!({
                            "ok": true,
                            "jobId": request.job_id,
                            "status": "closed",
                            "statusText": "Downloads\\Aura Media 폴더에 저장했습니다.",
                            "fileName": active.final_path.file_name().map(|value| value.to_string_lossy().into_owned()),
                        }),
                    );
                }
                Err(error) => {
                    let _ = fs::remove_file(&active.temporary_path);
                    active.state.status = "failed".into();
                    active.state.status_text = "다운로드 파일을 마무리하지 못했습니다.".into();
                    active.state.error = Some(error.to_string());
                    let _ = persist_job_state(&mut active.state);
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
            if let Some(mut active) = writer.take() {
                drop(active.file);
                let _ = fs::remove_file(active.temporary_path);
                active.state.status = "cancelled".into();
                active.state.status_text = "다운로드를 취소했습니다.".into();
                active.state.error = None;
                let _ = persist_job_state(&mut active.state);
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
        "media-suspend" => {
            if let Some(mut active) = writer.take() {
                let _ = active.file.flush();
                let _ = active.file.sync_all();
                drop(active.file);
                active.state.status = "failed".into();
                active.state.status_text = "연결이 끊겨 이어받기 지점을 보존했습니다.".into();
                active.state.error = Some("download-interrupted-resumable".into());
                active.state.completed = Some(active.bytes_written);
                let _ = persist_job_state(&mut active.state);
                reply(
                    request,
                    json!({
                        "ok": true,
                        "jobId": request.job_id,
                        "status": "suspended",
                        "fileName": active.final_path.file_name().map(|value| value.to_string_lossy().into_owned()),
                        "bytesWritten": active.bytes_written,
                    }),
                );
                return;
            }
            reply(
                request,
                json!({
                    "ok": true,
                    "jobId": request.job_id,
                    "status": "suspended",
                    "bytesWritten": 0,
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
    // The detached native host reads yt-dlp through UTF-8 Rust pipes. Windows
    // filename substitutions can include characters outside the active OEM
    // code page (for example `⧸`), which otherwise makes yt-dlp finish the
    // file and then exit with Errno 22 while printing AURA_FILE.
    command.arg("--encoding").arg("utf-8");
    // yt-dlp's Windows filename sanitizer maps `/` to `⧸`, a glyph absent
    // from the manager's Korean UI font. Normalize path separators in the
    // title before filename sanitization so both metadata and filenames use a
    // readable ASCII separator without stripping Korean text.
    command
        .arg("--replace-in-metadata")
        .arg("title")
        .arg(r"\s*[/\\]\s*")
        .arg(" - ");
    // YouTube media URLs are short-lived and occasionally return a transient
    // 403 even though a fresh extraction succeeds immediately. Let yt-dlp
    // retry bounded transport/extractor failures before surfacing the job as
    // failed; the manager's explicit Retry action remains the final fallback.
    command
        .arg("--retries")
        .arg("3")
        .arg("--fragment-retries")
        .arg("3")
        .arg("--extractor-retries")
        .arg("3")
        .arg("--retry-sleep")
        .arg("http:linear=1::2");
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

fn should_restart_youtube_download(error: &str, attempt: u8) -> bool {
    attempt < 2 && error.to_ascii_lowercase().contains("http error 403")
}

fn should_retry_media_download_with_impersonation(
    request: &Request,
    outcome: &DownloadAttemptResult,
) -> bool {
    if !matches!(
        request.input_kind.as_str(),
        "HLS_MASTER" | "HLS_MEDIA" | "DASH"
    ) {
        return false;
    }
    matches!(outcome, DownloadAttemptResult::Failed(error) if {
        let error = error.to_ascii_lowercase();
        error.contains("http error 403") && error.contains("cloudflare")
    })
}

enum DownloadAttemptResult {
    Completed,
    Failed(String),
    SpawnError(String),
    StatusError(String),
    Cancelled,
    Paused,
}

fn apply_download_outcome(state: &mut JobState, outcome: DownloadAttemptResult) {
    match outcome {
        DownloadAttemptResult::Completed => {
            state.status = "completed".into();
            state.status_text = "Companion 다운로드 폴더에 저장했습니다.".into();
            state.progress = Some(100);
            state.error = None;
        }
        DownloadAttemptResult::Failed(error) => {
            state.status = "failed".into();
            state.status_text = "미디어 다운로드에 실패했습니다.".into();
            state.error = Some(error);
        }
        DownloadAttemptResult::SpawnError(error) => {
            state.status = "failed".into();
            state.status_text = "미디어 도구를 실행하지 못했습니다.".into();
            state.error = Some(error);
        }
        DownloadAttemptResult::StatusError(error) => {
            state.status = "failed".into();
            state.status_text = "미디어 도구 종료 상태를 확인하지 못했습니다.".into();
            state.error = Some(error);
        }
        DownloadAttemptResult::Cancelled => {
            state.status = "cancelled".into();
            state.status_text = "다운로드를 취소했습니다.".into();
            state.error = None;
        }
        DownloadAttemptResult::Paused => {
            state.status = "paused".into();
            state.status_text = "일시정지했습니다. 이어받기를 누르면 계속합니다.".into();
            state.error = None;
        }
    }
}

fn media_output_template(request: &Request) -> String {
    let requested = request.title.trim();
    let requested = if requested.is_empty() {
        "Segma media"
    } else {
        requested
    };
    let base = safe_filename(requested)
        .replace('%', "_")
        .chars()
        .take(140)
        .collect::<String>();
    let candidate = request.candidate_id.chars().take(12).collect::<String>();
    format!("{base} [{candidate}].%(ext)s")
}

fn progressive_extension_hint(url: &str) -> &'static str {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return "mp4";
    };
    for segment in parsed.path_segments().into_iter().flatten().rev() {
        let extension = Path::new(segment)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        match extension.as_str() {
            "mp4" | "m4v" => return "mp4",
            "webm" => return "webm",
            "mp3" => return "mp3",
            "m4a" => return "m4a",
            _ => {}
        }
    }
    "mp4"
}

fn progressive_output_filename(request: &Request) -> String {
    let requested = request.title.trim();
    let requested = if requested.is_empty() {
        "Segma media"
    } else {
        requested
    };
    let base = safe_filename(requested)
        .chars()
        .take(140)
        .collect::<String>();
    let candidate = request.candidate_id.chars().take(12).collect::<String>();
    format!(
        "{base} [{candidate}].{}",
        progressive_extension_hint(&request.url)
    )
}

fn progressive_content_type_allowed(value: &str) -> bool {
    let mime = value
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    mime.starts_with("video/") || mime.starts_with("audio/") || mime == "application/octet-stream"
}

fn progressive_total_bytes(headers: &reqwest::header::HeaderMap, offset: u64) -> Option<u64> {
    if let Some(value) = headers
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.rsplit('/').next())
        .and_then(|value| value.parse::<u64>().ok())
    {
        return Some(value);
    }
    headers
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .map(|length| length.saturating_add(offset))
}

fn progressive_content_range(headers: &reqwest::header::HeaderMap) -> Option<(u64, u64, u64)> {
    let value = headers
        .get(reqwest::header::CONTENT_RANGE)?
        .to_str()
        .ok()?
        .trim();
    let value = value.strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let start = start.parse::<u64>().ok()?;
    let end = end.parse::<u64>().ok()?;
    let total = total.parse::<u64>().ok()?;
    (start <= end && end < total).then_some((start, end, total))
}

fn progressive_range_concurrency_limit() -> usize {
    thread::available_parallelism()
        .map(|parallelism| parallelism.get())
        .unwrap_or(PROGRESSIVE_RANGE_INITIAL_CONCURRENCY)
        .clamp(
            PROGRESSIVE_RANGE_MIN_CONCURRENCY,
            PROGRESSIVE_RANGE_MAX_CONCURRENCY,
        )
}

fn progressive_range_batch(start: u64, total: u64, concurrency: usize) -> Vec<(u64, u64)> {
    let mut ranges = Vec::new();
    let mut cursor = start;
    let concurrency = concurrency.clamp(
        PROGRESSIVE_RANGE_MIN_CONCURRENCY,
        PROGRESSIVE_RANGE_MAX_CONCURRENCY,
    );
    while cursor < total && ranges.len() < concurrency {
        let end = cursor
            .saturating_add(PROGRESSIVE_RANGE_CHUNK_BYTES - 1)
            .min(total - 1);
        ranges.push((cursor, end));
        cursor = end.saturating_add(1);
    }
    ranges
}

fn adaptive_progressive_range_concurrency(
    current: usize,
    limit: usize,
    previous_bytes_per_second: Option<f64>,
    bytes_per_second: f64,
) -> usize {
    let current = current.clamp(PROGRESSIVE_RANGE_MIN_CONCURRENCY, limit);
    let Some(previous) = previous_bytes_per_second.filter(|speed| *speed > 0.0) else {
        return (current + 1).min(limit);
    };
    if bytes_per_second >= previous * 0.92 {
        (current + 1).min(limit)
    } else if bytes_per_second < previous * 0.65 {
        current
            .saturating_sub(1)
            .max(PROGRESSIVE_RANGE_MIN_CONCURRENCY)
    } else {
        current
    }
}

fn direct_progressive_client() -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .redirect(Policy::custom(|attempt| {
            if attempt.previous().len() >= 10 {
                return attempt.stop();
            }
            if valid_http_url(attempt.url().as_str()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(60 * 60))
        .build()
        .map_err(|error| error.to_string())
}

fn request_origin(referrer: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(referrer).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return None;
    }
    Some(parsed.origin().ascii_serialization())
}

fn progressive_request(
    client: &Client,
    request: &Request,
    range: Option<(u64, Option<u64>)>,
) -> reqwest::blocking::RequestBuilder {
    let mut builder = client
        .get(&request.url)
        .header(
            reqwest::header::ACCEPT,
            "video/*,audio/*;q=0.9,application/octet-stream;q=0.8",
        )
        .header(
            reqwest::header::USER_AGENT,
            if request.user_agent.is_empty() {
                MEDIA_USER_AGENT
            } else {
                request.user_agent.as_str()
            },
        );
    if let Some(referrer) = request.referrer.as_deref() {
        builder = builder.header(reqwest::header::REFERER, referrer);
        if let Some(origin) = request_origin(referrer) {
            builder = builder.header(reqwest::header::ORIGIN, origin);
        }
    }
    if !request.accept_language.is_empty() {
        builder = builder.header(reqwest::header::ACCEPT_LANGUAGE, &request.accept_language);
    }
    if let Some((start, end)) = range {
        let value = end
            .map(|end| format!("bytes={start}-{end}"))
            .unwrap_or_else(|| format!("bytes={start}-"));
        builder = builder.header(reqwest::header::RANGE, value);
    }
    builder
}

fn progressive_content_type_from_response(
    response: &reqwest::blocking::Response,
) -> Result<(), String> {
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if progressive_content_type_allowed(content_type) {
        Ok(())
    } else {
        Err(format!(
            "progressive response is not media ({})",
            content_type.split(';').next().unwrap_or("unknown")
        ))
    }
}

fn fetch_progressive_range(
    client: Client,
    request: Request,
    start: u64,
    end: u64,
    expected_total: u64,
) -> Result<(u64, Vec<u8>), String> {
    let expected_length = end.saturating_sub(start).saturating_add(1);
    let mut last_error = String::new();
    for attempt in 0..PROGRESSIVE_RANGE_RETRIES {
        let response = progressive_request(&client, &request, Some((start, Some(end)))).send();
        let mut response = match response {
            Ok(response) => response,
            Err(error) => {
                last_error = error.to_string();
                if attempt + 1 < PROGRESSIVE_RANGE_RETRIES {
                    thread::sleep(Duration::from_millis(250 * (attempt as u64 + 1)));
                }
                continue;
            }
        };
        if response.status() != StatusCode::PARTIAL_CONTENT {
            last_error = format!("progressive range HTTP {}", response.status().as_u16());
            if attempt + 1 < PROGRESSIVE_RANGE_RETRIES {
                thread::sleep(Duration::from_millis(250 * (attempt as u64 + 1)));
            }
            continue;
        }
        progressive_content_type_from_response(&response)?;
        if progressive_content_range(response.headers()) != Some((start, end, expected_total)) {
            return Err("progressive range response does not match the requested bytes".into());
        }
        let mut bytes = Vec::with_capacity(expected_length.min(usize::MAX as u64) as usize);
        if let Err(error) = response
            .by_ref()
            .take(expected_length.saturating_add(1))
            .read_to_end(&mut bytes)
        {
            last_error = error.to_string();
            if attempt + 1 < PROGRESSIVE_RANGE_RETRIES {
                thread::sleep(Duration::from_millis(250 * (attempt as u64 + 1)));
            }
            continue;
        }
        if bytes.len() as u64 == expected_length {
            return Ok((start, bytes));
        }
        last_error = format!(
            "progressive range length mismatch: expected {expected_length}, received {}",
            bytes.len()
        );
    }
    Err(last_error)
}

fn update_progressive_transfer_state<F>(
    state: &mut JobState,
    notify: &F,
    written: u64,
    total: Option<u64>,
    started_at: Instant,
) where
    F: Fn(&JobState),
{
    state.completed = Some(written);
    state.progress =
        total.map(|total| ((written.saturating_mul(100) / total.max(1)).min(100)) as u8);
    let seconds = started_at.elapsed().as_secs_f64();
    let speed_mib = if seconds > 0.0 {
        written as f64 / 1_048_576.0 / seconds
    } else {
        0.0
    };
    state.status_text = match total {
        Some(total) => format!("다운로드 중 · {written} / {total} bytes · {speed_mib:.2} MB/s"),
        None => format!("다운로드 중 · {written} bytes · {speed_mib:.2} MB/s"),
    };
    update_state(state, notify);
}

fn execute_progressive_download<F>(
    request: &Request,
    downloads: &Path,
    state: &mut JobState,
    notify: &F,
    cancel_path: Option<&Path>,
    pause_path: Option<&Path>,
) -> DownloadAttemptResult
where
    F: Fn(&JobState),
{
    let filename = progressive_output_filename(request);
    let requested_final = downloads.join(&filename);
    let requested_part = PathBuf::from(format!("{}.part", requested_final.display()));
    let final_path = if requested_part.is_file() && !requested_final.exists() {
        requested_final
    } else {
        unique_media_path(downloads, &filename)
    };
    let part_path = PathBuf::from(format!("{}.part", final_path.display()));
    let mut offset = fs::metadata(&part_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);

    let client = match direct_progressive_client() {
        Ok(client) => client,
        Err(error) => return DownloadAttemptResult::SpawnError(error),
    };
    // A one-byte request proves that the exact authenticated URL honors byte
    // ranges. Googlevideo and other progressive CDNs commonly throttle one
    // long response; when the probe succeeds, receive six bounded ranges at a
    // time while committing them to the partial file in byte order.
    let mut response =
        match progressive_request(&client, request, Some((offset, Some(offset)))).send() {
            Ok(response) => response,
            Err(error) => return DownloadAttemptResult::Failed(error.to_string()),
        };
    if !response.status().is_success() {
        return DownloadAttemptResult::Failed(format!(
            "progressive HTTP {}",
            response.status().as_u16()
        ));
    }
    if let Err(error) = progressive_content_type_from_response(&response) {
        return DownloadAttemptResult::Failed(error);
    }
    let range = (response.status() == StatusCode::PARTIAL_CONTENT)
        .then(|| progressive_content_range(response.headers()))
        .flatten()
        .filter(|(start, end, total)| *start == offset && *end == offset && *total > offset);
    if offset > 0 && response.status() != StatusCode::PARTIAL_CONTENT {
        offset = 0;
    }
    let total = range
        .map(|(_, _, total)| total)
        .or_else(|| progressive_total_bytes(response.headers(), offset));
    let mut file = match OpenOptions::new()
        .create(true)
        .write(true)
        .append(offset > 0)
        .truncate(offset == 0)
        .open(&part_path)
    {
        Ok(file) => file,
        Err(error) => return DownloadAttemptResult::SpawnError(error.to_string()),
    };
    state.file_name = final_path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned());
    state.completed = Some(offset);
    state.total = total;
    state.status_text = "미디어를 직접 저장하는 중…".into();
    update_state(state, notify);

    let started_at = Instant::now();
    let mut written = offset;
    let mut last_reported = offset;
    if let Some((_, _, range_total)) = range {
        let mut probe = [0_u8; 1];
        if let Err(error) = response.read_exact(&mut probe) {
            return DownloadAttemptResult::Failed(error.to_string());
        }
        if let Err(error) = file.write_all(&probe) {
            return DownloadAttemptResult::Failed(error.to_string());
        }
        written = written.saturating_add(1);
        update_progressive_transfer_state(state, notify, written, Some(range_total), started_at);

        let concurrency_limit = progressive_range_concurrency_limit();
        let mut concurrency = PROGRESSIVE_RANGE_INITIAL_CONCURRENCY.min(concurrency_limit);
        let mut previous_batch_speed = None;
        while written < range_total {
            if cancel_path.is_some_and(Path::exists) {
                drop(file);
                let _ = fs::remove_file(&part_path);
                return DownloadAttemptResult::Cancelled;
            }
            if pause_path.is_some_and(Path::exists) {
                let _ = file.flush();
                let _ = file.sync_all();
                return DownloadAttemptResult::Paused;
            }
            let ranges = progressive_range_batch(written, range_total, concurrency);
            let batch_started_at = Instant::now();
            let batch_bytes = ranges
                .iter()
                .map(|(start, end)| end.saturating_sub(*start).saturating_add(1))
                .sum::<u64>();
            let (sender, receiver) = mpsc::channel();
            let mut workers = Vec::with_capacity(ranges.len());
            for (start, end) in ranges.iter().copied() {
                let sender = sender.clone();
                let client = client.clone();
                let request = request.clone();
                workers.push(thread::spawn(move || {
                    let _ = sender.send(fetch_progressive_range(
                        client,
                        request,
                        start,
                        end,
                        range_total,
                    ));
                }));
            }
            drop(sender);
            let mut chunks = std::collections::BTreeMap::new();
            let mut batch_error = None;
            for result in receiver {
                match result {
                    Ok((start, bytes)) => {
                        chunks.insert(start, bytes);
                    }
                    Err(error) => batch_error = Some(error),
                }
            }
            for worker in workers {
                if worker.join().is_err() && batch_error.is_none() {
                    batch_error = Some("progressive range worker stopped unexpectedly".into());
                }
            }
            if let Some(error) = batch_error {
                return DownloadAttemptResult::Failed(error);
            }
            for (start, end) in ranges {
                let Some(bytes) = chunks.remove(&start) else {
                    return DownloadAttemptResult::Failed(
                        "progressive range response is missing".into(),
                    );
                };
                if start != written || bytes.len() as u64 != end - start + 1 {
                    return DownloadAttemptResult::Failed(
                        "progressive range order is invalid".into(),
                    );
                }
                if let Err(error) = file.write_all(&bytes) {
                    return DownloadAttemptResult::Failed(error.to_string());
                }
                written = written.saturating_add(bytes.len() as u64);
                update_progressive_transfer_state(
                    state,
                    notify,
                    written,
                    Some(range_total),
                    started_at,
                );
            }
            let batch_seconds = batch_started_at.elapsed().as_secs_f64().max(0.001);
            let batch_speed = batch_bytes as f64 / batch_seconds;
            concurrency = adaptive_progressive_range_concurrency(
                concurrency,
                concurrency_limit,
                previous_batch_speed,
                batch_speed,
            );
            previous_batch_speed = Some(batch_speed);
        }
    } else {
        // The server ignored the probe Range and returned the complete body.
        // Preserve the single-stream path for servers that do not support
        // bounded reception.
        let mut buffer = [0_u8; 256 * 1024];
        loop {
            if cancel_path.is_some_and(Path::exists) {
                drop(file);
                let _ = fs::remove_file(&part_path);
                return DownloadAttemptResult::Cancelled;
            }
            if pause_path.is_some_and(Path::exists) {
                let _ = file.flush();
                let _ = file.sync_all();
                return DownloadAttemptResult::Paused;
            }
            let count = match response.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => count,
                Err(error) => return DownloadAttemptResult::Failed(error.to_string()),
            };
            if let Err(error) = file.write_all(&buffer[..count]) {
                return DownloadAttemptResult::Failed(error.to_string());
            }
            written = written.saturating_add(count as u64);
            if written.saturating_sub(last_reported) >= 1024 * 1024 {
                last_reported = written;
                update_progressive_transfer_state(state, notify, written, total, started_at);
            }
        }
    }
    if written == 0 {
        let _ = fs::remove_file(&part_path);
        return DownloadAttemptResult::Failed("empty progressive response".into());
    }
    if let Err(error) = file.flush().and_then(|_| file.sync_all()) {
        return DownloadAttemptResult::Failed(error.to_string());
    }
    drop(file);
    if let Err(error) = fs::rename(&part_path, &final_path) {
        return DownloadAttemptResult::Failed(error.to_string());
    }
    state.completed = Some(written);
    state.total = total.or(Some(written));
    DownloadAttemptResult::Completed
}

fn configure_media_download_command(
    command: &mut Command,
    request: &Request,
    downloads: &Path,
    node: &Path,
    ffmpeg: &Path,
    impersonate_browser: bool,
) {
    command
        .arg("--newline")
        .arg("--no-playlist")
        .arg("--windows-filenames")
        .arg("--continue")
        .arg("--merge-output-format")
        .arg("mp4")
        .arg("--paths")
        .arg(format!("home:{}", downloads.display()))
        .arg("--output")
        .arg(media_output_template(request))
        .arg("--print")
        .arg("after_move:AURA_FILE:%(filepath)s")
        .arg("--progress-template")
        .arg("download:AURA_PROGRESS:%(progress._percent_str)s %(progress._speed_str)s ETA %(progress._eta_str)s")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_ytdlp_runtime(command, node, ffmpeg);
    if let Some(referrer) = request.referrer.as_deref() {
        command.arg("--referer").arg(referrer);
    }
    if matches!(
        request.input_kind.as_str(),
        "HLS_MASTER" | "HLS_MEDIA" | "DASH"
    ) {
        if impersonate_browser {
            command.arg("--impersonate").arg("chrome");
        } else {
            let user_agent = if request.user_agent.is_empty() {
                MEDIA_USER_AGENT
            } else {
                request.user_agent.as_str()
            };
            command.arg("--user-agent").arg(user_agent);
        }
        command
            .arg("--add-headers")
            .arg("Accept:application/vnd.apple.mpegurl,application/x-mpegURL,*/*");
        if let Some(origin) = request.referrer.as_deref().and_then(request_origin) {
            command.arg("--add-headers").arg(format!("Origin:{origin}"));
        }
        if !request.accept_language.is_empty() {
            command
                .arg("--add-headers")
                .arg(format!("Accept-Language:{}", request.accept_language));
        }
    }
    command.arg(&request.url);
    apply_hidden_process(command);
}

fn execute_media_download_attempt<F>(request: Request, notify: F, impersonate_browser: bool)
where
    F: Fn(&JobState),
{
    let mut state = initial_job_state(&request);
    state.status = "running".into();
    state.status_text = "미디어 다운로드를 준비하는 중…".into();
    update_state(&mut state, &notify);

    let command = media_download_command_from_request(&request);
    if let Err(error) = validate_media_download_fields(&command) {
        state.status = "failed".into();
        state.status_text = "올바른 미디어 다운로드 요청이 아닙니다.".into();
        state.error = Some(error.code.into());
        update_state(&mut state, &notify);
        return;
    }

    let downloads = match aura_downloads_dir() {
        Ok(path) => path,
        Err(error) => {
            state.status = "failed".into();
            state.status_text = "Companion 다운로드 폴더를 준비하지 못했습니다.".into();
            state.error = Some(error.to_string());
            update_state(&mut state, &notify);
            return;
        }
    };

    let cancel_path = job_cancel_path(&request.job_id).ok();
    let pause_path = job_pause_path(&request.job_id).ok();
    if request.input_kind == "PROGRESSIVE" {
        let outcome = execute_progressive_download(
            &request,
            &downloads,
            &mut state,
            &notify,
            cancel_path.as_deref(),
            pause_path.as_deref(),
        );
        if let Some(path) = cancel_path {
            let _ = fs::remove_file(path);
        }
        apply_download_outcome(&mut state, outcome);
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
    let mut process = Command::new(yt_dlp);
    configure_media_download_command(
        &mut process,
        &request,
        &downloads,
        &node,
        &ffmpeg,
        impersonate_browser,
    );
    let outcome = match process.spawn() {
        Err(error) => DownloadAttemptResult::SpawnError(error.to_string()),
        Ok(mut child) => {
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

            state.status_text = "미디어를 저장하는 중…".into();
            update_state(&mut state, &notify);
            let mut last_error = String::new();
            let mut cancelled = false;
            let mut paused = false;
            loop {
                if cancel_path.as_ref().is_some_and(|path| path.exists()) {
                    let _ = child.kill();
                    cancelled = true;
                    break;
                }
                if pause_path.as_ref().is_some_and(|path| path.exists()) {
                    let _ = child.kill();
                    paused = true;
                    break;
                }
                match rx.recv_timeout(Duration::from_millis(250)) {
                    Ok(line) => {
                        if let Some(progress) = line.strip_prefix("AURA_PROGRESS:") {
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
            if cancelled {
                DownloadAttemptResult::Cancelled
            } else if paused {
                DownloadAttemptResult::Paused
            } else {
                match status {
                    Ok(status) if status.success() => DownloadAttemptResult::Completed,
                    Ok(status) => DownloadAttemptResult::Failed(if last_error.is_empty() {
                        format!("yt-dlp exit {status}")
                    } else {
                        last_error
                    }),
                    Err(error) => DownloadAttemptResult::StatusError(error.to_string()),
                }
            }
        }
    };
    if !impersonate_browser && should_retry_media_download_with_impersonation(&request, &outcome) {
        state.status_text = "Cloudflare 요청 검증을 다시 시도하는 중…".into();
        update_state(&mut state, &notify);
        execute_media_download_attempt(request, notify, true);
        return;
    }
    if let Some(path) = cancel_path {
        let _ = fs::remove_file(path);
    }

    apply_download_outcome(&mut state, outcome);
    update_state(&mut state, &notify);
}

fn execute_media_download<F>(request: Request, notify: F)
where
    F: Fn(&JobState),
{
    execute_media_download_attempt(request, notify, false);
}

fn execute_download<F>(request: Request, notify: F)
where
    F: Fn(&JobState),
{
    if request.kind == "media-download" {
        execute_media_download(request, notify);
    } else {
        execute_youtube_download(request, notify);
    }
}

fn execute_youtube_download<F>(request: Request, notify: F)
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

    let cancel_path = job_cancel_path(&request.job_id).ok();
    let pause_path = job_pause_path(&request.job_id).ok();
    let mut attempt = 0_u8;
    let outcome = loop {
        attempt += 1;
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
            .arg(YOUTUBE_OUTPUT_TEMPLATE)
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
            Err(error) => break DownloadAttemptResult::SpawnError(error.to_string()),
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
        if cancelled {
            break DownloadAttemptResult::Cancelled;
        }
        if paused {
            break DownloadAttemptResult::Paused;
        }
        match status {
            Ok(status) if status.success() => break DownloadAttemptResult::Completed,
            Ok(status) => {
                let error = if last_error.is_empty() {
                    format!("yt-dlp exit {status}")
                } else {
                    last_error
                };
                if should_restart_youtube_download(&error, attempt) {
                    state.progress = None;
                    state.status_text = "일시적인 403 오류입니다. 링크를 새로 확인하는 중…".into();
                    state.error = None;
                    update_state(&mut state, &notify);
                    thread::sleep(Duration::from_secs(1));
                    continue;
                }
                break DownloadAttemptResult::Failed(error);
            }
            Err(error) => break DownloadAttemptResult::StatusError(error.to_string()),
        }
    };
    if let Some(path) = cancel_path {
        let _ = fs::remove_file(path);
    }

    match outcome {
        DownloadAttemptResult::Completed => {
            state.status = "completed".into();
            state.status_text = "Downloads\\Aura Media 폴더에 저장했습니다.".into();
            state.progress = Some(100);
            state.error = None;
        }
        DownloadAttemptResult::Failed(error) => {
            state.status = "failed".into();
            state.status_text = "YouTube 다운로드에 실패했습니다.".into();
            state.error = Some(error);
        }
        DownloadAttemptResult::SpawnError(error) => {
            state.status = "failed".into();
            state.status_text = "yt-dlp를 실행하지 못했습니다.".into();
            state.error = Some(error);
        }
        DownloadAttemptResult::StatusError(error) => {
            state.status = "failed".into();
            state.status_text = "yt-dlp 종료 상태를 확인하지 못했습니다.".into();
            state.error = Some(error);
        }
        DownloadAttemptResult::Cancelled => {
            state.status = "cancelled".into();
            state.status_text = "다운로드를 취소했습니다.".into();
            state.error = None;
        }
        // The pause marker is deliberately left on disk: it is what tells the
        // manager window this job is paused rather than stopped, and `resume`
        // removes it.
        DownloadAttemptResult::Paused => {
            state.status = "paused".into();
            state.status_text = "일시정지했습니다. 이어받기를 누르면 계속합니다.".into();
            state.error = None;
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
    #[cfg(target_os = "windows")]
    if focus_existing_manager() {
        return Ok(());
    }
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
                    "capabilities": companion_capabilities(),
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
            kind if kind.starts_with("media-") => handle_media_request(&request, &mut writer),
            _ => reply(
                &request,
                json!({ "ok": false, "errorCode": "unsupported-request", "error": "지원하지 않는 Aura Companion 요청입니다." }),
            ),
        }
    }
    if let Some(active) = writer.take() {
        let mut active = active;
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

        let state = initial_media_writer_state(&request, Path::new("clip.mp4"), 123, 0);
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

        let oversized = vec![b'x'; MAX_MEDIA_DOWNLOAD_MESSAGE_BYTES + 1];
        assert_eq!(
            parse_media_download_command_bytes(&oversized)
                .expect_err("oversized payload is rejected")
                .code,
            "media-download-payload-too-large"
        );
    }

    #[test]
    fn progressive_php_redirect_keeps_the_media_extension_and_direct_contract() {
        let mut request: Request = serde_json::from_value(sample_media_download_command()).unwrap();
        request.url =
            "https://pimpbunny.example/get_file/26/token/479734/479734_720p.mp4/?token=redacted"
                .into();
        request.title = "Ivory Fox sample | PimpBunny".into();
        assert_eq!(progressive_extension_hint(&request.url), "mp4");
        assert!(progressive_output_filename(&request).ends_with(".mp4"));
        assert!(!progressive_output_filename(&request).ends_with(".php"));
        assert!(progressive_content_type_allowed("video/mp4"));
        assert!(!progressive_content_type_allowed(
            "text/html; charset=utf-8"
        ));
    }

    #[test]
    fn progressive_range_batches_honor_the_runtime_concurrency_window() {
        let ranges = progressive_range_batch(10, 20 * 1024 * 1024, 5);
        assert_eq!(ranges.len(), 5);
        assert_eq!(ranges[0], (10, 10 + PROGRESSIVE_RANGE_CHUNK_BYTES - 1));
        for pair in ranges.windows(2) {
            assert_eq!(pair[0].1 + 1, pair[1].0);
        }
        assert!(
            (PROGRESSIVE_RANGE_MIN_CONCURRENCY..=PROGRESSIVE_RANGE_MAX_CONCURRENCY)
                .contains(&progressive_range_concurrency_limit())
        );
    }

    #[test]
    fn progressive_range_concurrency_adapts_to_observed_throughput() {
        assert_eq!(adaptive_progressive_range_concurrency(4, 12, None, 10.0), 5);
        assert_eq!(
            adaptive_progressive_range_concurrency(5, 12, Some(10.0), 9.5),
            6
        );
        assert_eq!(
            adaptive_progressive_range_concurrency(6, 12, Some(10.0), 5.0),
            5
        );
        assert_eq!(
            adaptive_progressive_range_concurrency(12, 12, Some(10.0), 12.0),
            12
        );
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

        let mut process = Command::new("yt-dlp.exe");
        configure_media_download_command(
            &mut process,
            &request,
            Path::new("downloads"),
            Path::new("node.exe"),
            Path::new("ffmpeg"),
            false,
        );
        let arguments = process
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            arguments.iter().filter(|arg| *arg == "--referer").count(),
            1
        );
        assert!(arguments
            .windows(2)
            .any(|window| { window == ["--referer", "https://page.example/watch?id=7"] }));
        assert!(arguments
            .windows(2)
            .any(|window| { window == ["--user-agent", "Mozilla/5.0 TestBrowser/151.0"] }));
        assert!(arguments
            .windows(2)
            .any(|window| { window == ["--add-headers", "Origin:https://page.example"] }));
        assert!(arguments.windows(2).any(|window| {
            window == ["--add-headers", "Accept-Language:ko,en-US;q=0.9,en;q=0.8"]
        }));
        assert!(arguments.windows(2).any(|window| {
            window
                == [
                    "--add-headers",
                    "Accept:application/vnd.apple.mpegurl,application/x-mpegURL,*/*",
                ]
        }));
        for forbidden in [
            "--cookies",
            "--cookies-from-browser",
            "--paths-from-request",
        ] {
            assert!(!arguments.iter().any(|argument| argument == forbidden));
        }
        assert_eq!(
            arguments.last().map(String::as_str),
            Some(request.url.as_str())
        );

        let mut retry = Command::new("yt-dlp.exe");
        configure_media_download_command(
            &mut retry,
            &request,
            Path::new("downloads"),
            Path::new("node.exe"),
            Path::new("ffmpeg"),
            true,
        );
        let retry_arguments = retry
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(retry_arguments
            .windows(2)
            .any(|window| window == ["--impersonate", "chrome"]));
        assert!(!retry_arguments
            .iter()
            .any(|argument| argument == "--user-agent"));
        assert!(retry_arguments.windows(2).any(|window| {
            window == ["--add-headers", "Accept-Language:ko,en-US;q=0.9,en;q=0.8"]
        }));
        assert!(should_retry_media_download_with_impersonation(
            &request,
            &DownloadAttemptResult::Failed(
                "ERROR: [generic] HTTP Error 403 caused by Cloudflare anti-bot challenge".into()
            )
        ));
        assert!(!should_retry_media_download_with_impersonation(
            &request,
            &DownloadAttemptResult::Failed("ERROR: HTTP Error 403: token expired".into())
        ));
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

        let writer = open_media_writer_in(&directory, &request).expect("partial file reopens");
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

        let mut writer =
            open_media_writer_in(&media_directory, &request).expect("media writer opens");
        writer
            .file
            .write_all(b"partial bytes")
            .expect("partial writes");
        let partial_path = writer.temporary_path.clone();
        let cancel_path =
            job_cancel_path_in(&jobs_directory, &request.job_id).expect("cancel path resolves");
        fs::write(&cancel_path, b"cancel").expect("cancel marker writes");

        cancel_media_writer_in(writer, &jobs_directory).expect("writer cancels");

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
        assert_eq!(fixture["protocol"], PROTOCOL_VERSION);
        let expected = fixture["capabilities"]
            .as_array()
            .expect("capabilities are an array")
            .iter()
            .map(|value| value.as_str().expect("capability is text"))
            .collect::<Vec<_>>();
        assert_eq!(companion_capabilities(), expected.as_slice());
    }

    #[test]
    fn youtube_runtime_retries_transient_http_and_extractor_failures() {
        let mut command = Command::new("yt-dlp.exe");
        apply_ytdlp_runtime(&mut command, Path::new("node.exe"), Path::new("ffmpeg"));
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
        assert!(!YOUTUBE_OUTPUT_TEMPLATE.contains("%(id)"));
        assert_eq!(
            YOUTUBE_OUTPUT_TEMPLATE,
            "[%(height)sp] %(title).170B.%(ext)s"
        );
    }

    #[test]
    fn youtube_403_restarts_extraction_once_but_not_forever() {
        assert!(should_restart_youtube_download(
            "ERROR: unable to download video data: HTTP Error 403: Forbidden",
            1
        ));
        assert!(!should_restart_youtube_download(
            "ERROR: unable to download video data: HTTP Error 403: Forbidden",
            2
        ));
        assert!(!should_restart_youtube_download(
            "ERROR: Video unavailable",
            1
        ));
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
