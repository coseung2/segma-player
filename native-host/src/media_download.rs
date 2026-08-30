use crate::{job_store, youtube};
use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const COMMAND_VERSION: u32 = 1;
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024;
const MAX_URL_BYTES: usize = 4096;
const MAX_TITLE_BYTES: usize = 512;
const MAX_ID_BYTES: usize = 128;
const MAX_USER_AGENT_BYTES: usize = 512;
const MAX_ACCEPT_LANGUAGE_BYTES: usize = 256;
const MEDIA_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36";
const RANGE_MIN_CONCURRENCY: usize = 2;
const RANGE_INITIAL_CONCURRENCY: usize = 4;
const RANGE_MAX_CONCURRENCY: usize = 16;
const RANGE_CHUNK_BYTES: u64 = 2 * 1024 * 1024;
const RANGE_RETRIES: usize = 3;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    #[serde(rename = "requestId", default)]
    pub request_id: String,
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "candidateId")]
    pub candidate_id: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub referrer: Option<String>,
    pub title: String,
    #[serde(rename = "inputKind")]
    pub input_kind: String,
    #[serde(
        rename = "userAgent",
        default,
        skip_serializing_if = "String::is_empty"
    )]
    pub user_agent: String,
    #[serde(
        rename = "acceptLanguage",
        default,
        skip_serializing_if = "String::is_empty"
    )]
    pub accept_language: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ValidationError {
    pub code: &'static str,
    pub message: &'static str,
}

fn error(code: &'static str, message: &'static str) -> ValidationError {
    ValidationError { code, message }
}

fn sensitive_header_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    normalized.contains("cookie")
        || normalized.contains("authorization")
        || normalized.contains("header")
}

pub fn contains_sensitive_header(value: &Value) -> bool {
    match value {
        Value::Object(object) => object
            .iter()
            .any(|(key, child)| sensitive_header_key(key) || contains_sensitive_header(child)),
        Value::Array(values) => values.iter().any(contains_sensitive_header),
        _ => false,
    }
}

pub fn bounded_text(value: &str, maximum: usize) -> bool {
    value.len() <= maximum && !value.chars().any(|character| character.is_control())
}

fn valid_user_agent(value: &str) -> bool {
    value.len() <= MAX_USER_AGENT_BYTES
        && value
            .bytes()
            .all(|byte| byte == b' ' || byte.is_ascii_graphic())
}

fn valid_accept_language(value: &str) -> bool {
    value.len() <= MAX_ACCEPT_LANGUAGE_BYTES
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b',' | b'.' | b';' | b'=' | b'-' | b' ')
        })
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

pub fn valid_http_url(value: &str) -> bool {
    if !bounded_text(value, MAX_URL_BYTES)
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

pub fn validate_fields(command: &Command) -> Result<(), ValidationError> {
    if command.protocol_version != COMMAND_VERSION {
        return Err(error(
            "media-download-protocol-unsupported",
            "media download protocol version is unsupported",
        ));
    }
    if command.kind != "media-download" {
        return Err(error(
            "invalid-media-download-command",
            "media download command type is invalid",
        ));
    }
    if job_store::safe_id(&command.job_id).is_none()
        || command.job_id.len() > MAX_ID_BYTES
        || job_store::safe_id(&command.candidate_id).is_none()
        || command.candidate_id.len() > MAX_ID_BYTES
    {
        return Err(error(
            "invalid-media-download-id",
            "job and candidate identifiers must be bounded local tokens",
        ));
    }
    if !bounded_text(&command.url, MAX_URL_BYTES)
        || !valid_http_url(&command.url)
        || command.referrer.as_ref().is_some_and(|referrer| {
            !bounded_text(referrer, MAX_URL_BYTES) || !valid_http_url(referrer)
        })
    {
        return Err(error(
            "invalid-media-download-url",
            "media URL and referrer must be public HTTP or HTTPS URLs",
        ));
    }
    if !bounded_text(&command.title, MAX_TITLE_BYTES) {
        return Err(error(
            "invalid-media-download-title",
            "media title is invalid or oversized",
        ));
    }
    if !matches!(
        command.input_kind.as_str(),
        "PROGRESSIVE" | "HLS_MASTER" | "HLS_MEDIA" | "DASH"
    ) {
        return Err(error(
            "unsupported-media-download-kind",
            "media input kind is unsupported",
        ));
    }
    if (!command.user_agent.is_empty() && !valid_user_agent(&command.user_agent))
        || (!command.accept_language.is_empty() && !valid_accept_language(&command.accept_language))
    {
        return Err(error(
            "invalid-media-download-browser-context",
            "browser request metadata is invalid or oversized",
        ));
    }
    Ok(())
}

pub fn validate_command(raw: &Value, message_bytes: usize) -> Result<Command, ValidationError> {
    if message_bytes == 0 || message_bytes > MAX_MESSAGE_BYTES {
        return Err(error(
            "media-download-payload-too-large",
            "media download command exceeds the local payload limit",
        ));
    }
    if contains_sensitive_header(raw) {
        return Err(error(
            "media-download-secret-rejected",
            "cookies, authorization, and arbitrary headers are not accepted",
        ));
    }
    let command: Command = serde_json::from_value(raw.clone()).map_err(|_| {
        error(
            "invalid-media-download-command",
            "media download command shape is invalid",
        )
    })?;
    validate_fields(&command)?;
    Ok(command)
}

#[cfg(test)]
pub fn parse_command_bytes(data: &[u8]) -> Result<Command, ValidationError> {
    if data.len() > MAX_MESSAGE_BYTES {
        return Err(error(
            "media-download-payload-too-large",
            "media download command exceeds the local payload limit",
        ));
    }
    let raw: Value = serde_json::from_slice(data).map_err(|_| {
        error(
            "invalid-media-download-command",
            "media download command is not valid JSON",
        )
    })?;
    validate_command(&raw, data.len())
}

#[derive(Debug)]
pub struct ExecutionContext {
    pub downloads: fn() -> Result<PathBuf, String>,
    pub tools_directory: fn() -> Result<PathBuf, String>,
    pub cancel_path: Option<PathBuf>,
    pub pause_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DownloadAttemptResult {
    Completed,
    Failed(String),
    SpawnError(String),
    StatusError(String),
    Cancelled,
    Paused,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn initial_job_state(command: &Command) -> job_store::JobState {
    job_store::JobState {
        job_id: command.job_id.clone(),
        job_type: Some("media".into()),
        request_id: None,
        candidate_id: Some(command.candidate_id.clone()),
        source_language: None,
        target_language: None,
        input_kind: Some(command.input_kind.clone()),
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
        status_text: "Segma Player 미디어 다운로드 대기 중…".into(),
        title: (!command.title.trim().is_empty()).then(|| command.title.trim().to_string()),
        error: None,
        progress: None,
        file_name: None,
        created_at: now_millis(),
        updated_at: now_millis(),
    }
}

fn update_state<F>(state: &mut job_store::JobState, notify: &F)
where
    F: Fn(&job_store::JobState),
{
    if let Ok(directory) = job_store::jobs_dir() {
        let _ = job_store::persist_job_state_in(&directory, state, now_millis());
    }
    notify(state);
}

fn parse_progress(value: &str) -> Option<u8> {
    let token = value
        .split_whitespace()
        .find(|part| part.trim_end_matches('%').parse::<f32>().is_ok())?;
    let number = token.trim_end_matches('%').parse::<f32>().ok()?;
    Some(number.clamp(0.0, 100.0).round() as u8)
}

fn apply_download_outcome(state: &mut job_store::JobState, outcome: DownloadAttemptResult) {
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

pub fn safe_filename(value: &str) -> String {
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

pub fn unique_media_path(directory: &Path, filename: &str) -> PathBuf {
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

fn output_template(command: &Command) -> String {
    let requested = if command.title.trim().is_empty() {
        "Segma media"
    } else {
        command.title.trim()
    };
    let base = safe_filename(requested)
        .replace('%', "_")
        .chars()
        .take(140)
        .collect::<String>();
    let candidate = command.candidate_id.chars().take(12).collect::<String>();
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

fn progressive_output_filename(command: &Command) -> String {
    let requested = if command.title.trim().is_empty() {
        "Segma media"
    } else {
        command.title.trim()
    };
    let base = safe_filename(requested)
        .chars()
        .take(140)
        .collect::<String>();
    let candidate = command.candidate_id.chars().take(12).collect::<String>();
    format!(
        "{base} [{candidate}].{}",
        progressive_extension_hint(&command.url)
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

fn range_concurrency_limit() -> usize {
    thread::available_parallelism()
        .map(|parallelism| parallelism.get())
        .unwrap_or(RANGE_INITIAL_CONCURRENCY)
        .clamp(RANGE_MIN_CONCURRENCY, RANGE_MAX_CONCURRENCY)
}

fn range_batch(start: u64, total: u64, concurrency: usize) -> Vec<(u64, u64)> {
    let mut ranges = Vec::new();
    let mut cursor = start;
    let concurrency = concurrency.clamp(RANGE_MIN_CONCURRENCY, RANGE_MAX_CONCURRENCY);
    while cursor < total && ranges.len() < concurrency {
        let end = cursor.saturating_add(RANGE_CHUNK_BYTES - 1).min(total - 1);
        ranges.push((cursor, end));
        cursor = end.saturating_add(1);
    }
    ranges
}

fn adaptive_range_concurrency(
    current: usize,
    limit: usize,
    previous_bytes_per_second: Option<f64>,
    bytes_per_second: f64,
) -> usize {
    let current = current.clamp(RANGE_MIN_CONCURRENCY, limit);
    let Some(previous) = previous_bytes_per_second.filter(|speed| *speed > 0.0) else {
        return (current + 1).min(limit);
    };
    if bytes_per_second >= previous * 0.92 {
        (current + 1).min(limit)
    } else if bytes_per_second < previous * 0.65 {
        current.saturating_sub(1).max(RANGE_MIN_CONCURRENCY)
    } else {
        current
    }
}

fn direct_client() -> Result<Client, String> {
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
    command: &Command,
    range: Option<(u64, Option<u64>)>,
) -> reqwest::blocking::RequestBuilder {
    let mut builder = client
        .get(&command.url)
        .header(
            reqwest::header::ACCEPT,
            "video/*,audio/*;q=0.9,application/octet-stream;q=0.8",
        )
        .header(
            reqwest::header::USER_AGENT,
            if command.user_agent.is_empty() {
                MEDIA_USER_AGENT
            } else {
                command.user_agent.as_str()
            },
        );
    if let Some(referrer) = command.referrer.as_deref() {
        builder = builder.header(reqwest::header::REFERER, referrer);
        if let Some(origin) = request_origin(referrer) {
            builder = builder.header(reqwest::header::ORIGIN, origin);
        }
    }
    if !command.accept_language.is_empty() {
        builder = builder.header(reqwest::header::ACCEPT_LANGUAGE, &command.accept_language);
    }
    if let Some((start, end)) = range {
        let value = end
            .map(|end| format!("bytes={start}-{end}"))
            .unwrap_or_else(|| format!("bytes={start}-"));
        builder = builder.header(reqwest::header::RANGE, value);
    }
    builder
}

fn validate_response_content_type(response: &reqwest::blocking::Response) -> Result<(), String> {
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

fn fetch_range(
    client: Client,
    command: Command,
    start: u64,
    end: u64,
    expected_total: u64,
) -> Result<(u64, Vec<u8>), String> {
    let expected_length = end.saturating_sub(start).saturating_add(1);
    let mut last_error = String::new();
    for attempt in 0..RANGE_RETRIES {
        let response = progressive_request(&client, &command, Some((start, Some(end)))).send();
        let mut response = match response {
            Ok(response) => response,
            Err(error) => {
                last_error = error.to_string();
                if attempt + 1 < RANGE_RETRIES {
                    thread::sleep(Duration::from_millis(250 * (attempt as u64 + 1)));
                }
                continue;
            }
        };
        if response.status() != StatusCode::PARTIAL_CONTENT {
            last_error = format!("progressive range HTTP {}", response.status().as_u16());
            if attempt + 1 < RANGE_RETRIES {
                thread::sleep(Duration::from_millis(250 * (attempt as u64 + 1)));
            }
            continue;
        }
        validate_response_content_type(&response)?;
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
            if attempt + 1 < RANGE_RETRIES {
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

fn update_transfer_state<F>(
    state: &mut job_store::JobState,
    notify: &F,
    written: u64,
    total: Option<u64>,
    started_at: Instant,
) where
    F: Fn(&job_store::JobState),
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

fn execute_progressive<F>(
    command: &Command,
    downloads: &Path,
    state: &mut job_store::JobState,
    notify: &F,
    cancel_path: Option<&Path>,
    pause_path: Option<&Path>,
) -> DownloadAttemptResult
where
    F: Fn(&job_store::JobState),
{
    let filename = progressive_output_filename(command);
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
    let client = match direct_client() {
        Ok(client) => client,
        Err(error) => return DownloadAttemptResult::SpawnError(error),
    };
    let mut response =
        match progressive_request(&client, command, Some((offset, Some(offset)))).send() {
            Ok(response) => response,
            Err(error) => return DownloadAttemptResult::Failed(error.to_string()),
        };
    if !response.status().is_success() {
        return DownloadAttemptResult::Failed(format!(
            "progressive HTTP {}",
            response.status().as_u16()
        ));
    }
    if let Err(error) = validate_response_content_type(&response) {
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
        update_transfer_state(state, notify, written, Some(range_total), started_at);

        let concurrency_limit = range_concurrency_limit();
        let mut concurrency = RANGE_INITIAL_CONCURRENCY.min(concurrency_limit);
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
            let ranges = range_batch(written, range_total, concurrency);
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
                let command = command.clone();
                workers.push(thread::spawn(move || {
                    let _ = sender.send(fetch_range(client, command, start, end, range_total));
                }));
            }
            drop(sender);
            let mut chunks = BTreeMap::new();
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
                update_transfer_state(state, notify, written, Some(range_total), started_at);
            }
            let batch_seconds = batch_started_at.elapsed().as_secs_f64().max(0.001);
            let batch_speed = batch_bytes as f64 / batch_seconds;
            concurrency = adaptive_range_concurrency(
                concurrency,
                concurrency_limit,
                previous_batch_speed,
                batch_speed,
            );
            previous_batch_speed = Some(batch_speed);
        }
    } else {
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
                update_transfer_state(state, notify, written, total, started_at);
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

fn configure_process(
    process: &mut ProcessCommand,
    command: &Command,
    downloads: &Path,
    node: &Path,
    ffmpeg: &Path,
    impersonate_browser: bool,
) {
    process
        .arg("--newline")
        .arg("--no-playlist")
        .arg("--windows-filenames")
        .arg("--continue")
        .arg("--merge-output-format")
        .arg("mp4")
        .arg("--paths")
        .arg(format!("home:{}", downloads.display()))
        .arg("--output")
        .arg(output_template(command))
        .arg("--print")
        .arg("after_move:AURA_FILE:%(filepath)s")
        .arg("--progress-template")
        .arg("download:AURA_PROGRESS:%(progress._percent_str)s %(progress._speed_str)s ETA %(progress._eta_str)s")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    youtube::apply_runtime(process, node, ffmpeg);
    if let Some(referrer) = command.referrer.as_deref() {
        process.arg("--referer").arg(referrer);
    }
    if matches!(
        command.input_kind.as_str(),
        "HLS_MASTER" | "HLS_MEDIA" | "DASH"
    ) {
        if impersonate_browser {
            process.arg("--impersonate").arg("chrome");
        } else {
            let user_agent = if command.user_agent.is_empty() {
                MEDIA_USER_AGENT
            } else {
                command.user_agent.as_str()
            };
            process.arg("--user-agent").arg(user_agent);
        }
        process
            .arg("--add-headers")
            .arg("Accept:application/vnd.apple.mpegurl,application/x-mpegURL,*/*");
        if let Some(origin) = command.referrer.as_deref().and_then(request_origin) {
            process.arg("--add-headers").arg(format!("Origin:{origin}"));
        }
        if !command.accept_language.is_empty() {
            process
                .arg("--add-headers")
                .arg(format!("Accept-Language:{}", command.accept_language));
        }
    }
    process.arg(&command.url);
    youtube::apply_hidden_process(process);
}

fn should_retry_with_impersonation(command: &Command, outcome: &DownloadAttemptResult) -> bool {
    if !matches!(
        command.input_kind.as_str(),
        "HLS_MASTER" | "HLS_MEDIA" | "DASH"
    ) {
        return false;
    }
    matches!(outcome, DownloadAttemptResult::Failed(error) if {
        let error = error.to_ascii_lowercase();
        error.contains("http error 403") && error.contains("cloudflare")
    })
}

fn execute_attempt<F>(
    command: Command,
    context: &ExecutionContext,
    notify: &F,
    impersonate_browser: bool,
) where
    F: Fn(&job_store::JobState),
{
    let mut state = initial_job_state(&command);
    state.status = "running".into();
    state.status_text = "미디어 다운로드를 준비하는 중…".into();
    update_state(&mut state, notify);

    if let Err(error) = validate_fields(&command) {
        state.status = "failed".into();
        state.status_text = "올바른 미디어 다운로드 요청이 아닙니다.".into();
        state.error = Some(error.code.into());
        update_state(&mut state, notify);
        return;
    }
    let downloads = match (context.downloads)() {
        Ok(path) => path,
        Err(error) => {
            state.status = "failed".into();
            state.status_text = "Companion 다운로드 폴더를 준비하지 못했습니다.".into();
            state.error = Some(error);
            update_state(&mut state, notify);
            return;
        }
    };
    if command.input_kind == "PROGRESSIVE" {
        let outcome = execute_progressive(
            &command,
            &downloads,
            &mut state,
            notify,
            context.cancel_path.as_deref(),
            context.pause_path.as_deref(),
        );
        if let Some(path) = &context.cancel_path {
            let _ = fs::remove_file(path);
        }
        apply_download_outcome(&mut state, outcome);
        update_state(&mut state, notify);
        return;
    }
    let tools_directory = match (context.tools_directory)() {
        Ok(path) => path,
        Err(error) => {
            state.status = "failed".into();
            state.status_text = "미디어 도구가 설치되지 않았습니다.".into();
            state.error = Some(error);
            update_state(&mut state, notify);
            return;
        }
    };
    let (yt_dlp, node, ffmpeg) = match youtube::command_tools(&tools_directory) {
        Ok(tools) => tools,
        Err(error) => {
            state.status = "failed".into();
            state.status_text = "미디어 도구가 설치되지 않았습니다.".into();
            state.error = Some(error.to_string());
            update_state(&mut state, notify);
            return;
        }
    };
    let mut process = ProcessCommand::new(yt_dlp);
    configure_process(
        &mut process,
        &command,
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
            update_state(&mut state, notify);
            let mut last_error = String::new();
            let mut cancelled = false;
            let mut paused = false;
            loop {
                if context
                    .cancel_path
                    .as_ref()
                    .is_some_and(|path| path.exists())
                {
                    let _ = child.kill();
                    cancelled = true;
                    break;
                }
                if context
                    .pause_path
                    .as_ref()
                    .is_some_and(|path| path.exists())
                {
                    let _ = child.kill();
                    paused = true;
                    break;
                }
                match rx.recv_timeout(Duration::from_millis(250)) {
                    Ok(line) => {
                        if let Some(progress) = line.strip_prefix("AURA_PROGRESS:") {
                            state.progress = parse_progress(progress);
                            state.status_text = format!("다운로드 중 · {}", progress.trim());
                            update_state(&mut state, notify);
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
    if !impersonate_browser && should_retry_with_impersonation(&command, &outcome) {
        state.status_text = "Cloudflare 요청 검증을 다시 시도하는 중…".into();
        update_state(&mut state, notify);
        execute_attempt(command, context, notify, true);
        return;
    }
    if let Some(path) = &context.cancel_path {
        let _ = fs::remove_file(path);
    }
    apply_download_outcome(&mut state, outcome);
    update_state(&mut state, notify);
}

pub fn execute<F>(command: Command, context: ExecutionContext, notify: F)
where
    F: Fn(&job_store::JobState),
{
    execute_attempt(command, &context, &notify, false);
}

#[cfg(test)]
mod execution_tests {
    use super::*;
    use serde_json::json;

    fn command() -> Command {
        serde_json::from_value(json!({
            "type": "media-download",
            "protocolVersion": 1,
            "requestId": "request-123",
            "jobId": "job-123",
            "candidateId": "candidate-123",
            "url": "https://cdn.example/video.mp4",
            "referrer": "https://page.example/watch?id=7",
            "title": "Sample video",
            "inputKind": "PROGRESSIVE",
            "userAgent": "Mozilla/5.0 TestBrowser/151.0",
            "acceptLanguage": "ko,en-US;q=0.9,en;q=0.8"
        }))
        .expect("command parses")
    }

    #[test]
    fn progressive_range_batches_are_contiguous_and_bounded() {
        let ranges = range_batch(10, 20 * 1024 * 1024, 5);
        assert_eq!(ranges.len(), 5);
        assert_eq!(ranges[0], (10, 10 + RANGE_CHUNK_BYTES - 1));
        for pair in ranges.windows(2) {
            assert_eq!(pair[0].1 + 1, pair[1].0);
        }
        assert!(
            (RANGE_MIN_CONCURRENCY..=RANGE_MAX_CONCURRENCY).contains(&range_concurrency_limit())
        );
    }

    #[test]
    fn progressive_range_concurrency_tracks_throughput() {
        assert_eq!(adaptive_range_concurrency(4, 12, None, 10.0), 5);
        assert_eq!(adaptive_range_concurrency(5, 12, Some(10.0), 9.5), 6);
        assert_eq!(adaptive_range_concurrency(6, 12, Some(10.0), 5.0), 5);
        assert_eq!(adaptive_range_concurrency(12, 12, Some(10.0), 12.0), 12);
    }

    #[test]
    fn progressive_filename_and_content_type_preserve_direct_media_contract() {
        let mut command = command();
        command.url =
            "https://pimpbunny.example/get_file/26/token/479734/479734_720p.mp4/?token=redacted"
                .into();
        command.title = "Ivory Fox sample | PimpBunny".into();
        assert_eq!(progressive_extension_hint(&command.url), "mp4");
        assert!(progressive_output_filename(&command).ends_with(".mp4"));
        assert!(!progressive_output_filename(&command).ends_with(".php"));
        assert!(progressive_content_type_allowed("video/mp4"));
        assert!(!progressive_content_type_allowed(
            "text/html; charset=utf-8"
        ));
    }

    #[test]
    fn media_process_preserves_browser_context_without_secrets() {
        let mut command = command();
        command.input_kind = "HLS_MASTER".into();
        let mut process = ProcessCommand::new("yt-dlp.exe");
        configure_process(
            &mut process,
            &command,
            Path::new("downloads"),
            Path::new("node.exe"),
            Path::new("ffmpeg"),
            false,
        );
        let arguments = process
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(arguments
            .windows(2)
            .any(|window| { window == ["--referer", "https://page.example/watch?id=7"] }));
        assert!(arguments
            .windows(2)
            .any(|window| { window == ["--user-agent", "Mozilla/5.0 TestBrowser/151.0"] }));
        assert!(arguments
            .windows(2)
            .any(|window| { window == ["--add-headers", "Origin:https://page.example"] }));
        assert!(!arguments.iter().any(|argument| argument == "--cookies"));

        let outcome = DownloadAttemptResult::Failed(
            "ERROR: [generic] HTTP Error 403 caused by Cloudflare anti-bot challenge".into(),
        );
        assert!(should_retry_with_impersonation(&command, &outcome));
    }
}
