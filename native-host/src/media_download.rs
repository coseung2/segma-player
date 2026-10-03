use crate::{job_store, youtube};
use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const COMMAND_VERSION: u32 = 1;
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024;
/// A command carrying a page-decoded HLS playlist may exceed the plain limit.
const MAX_KEYED_MESSAGE_BYTES: usize = MAX_MESSAGE_BYTES + 3 * MAX_HLS_PLAYLIST_BYTES;
const MAX_URL_BYTES: usize = 4096;
const MAX_TITLE_BYTES: usize = 512;
const MAX_ID_BYTES: usize = 128;
const MAX_USER_AGENT_BYTES: usize = 512;
const MAX_ACCEPT_LANGUAGE_BYTES: usize = 256;
const MAX_HLS_KEYS: usize = 16;
const MAX_HLS_PLAYLIST_BYTES: usize = 512 * 1024;
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
    /// AES-128 keys decoded by the source page player. Only accepted for HLS.
    #[serde(rename = "hlsKeys", default, skip_serializing_if = "Vec::is_empty")]
    pub hls_keys: Vec<HlsKey>,
    /// Exact media playlist text read by the page together with hls_keys.
    #[serde(
        rename = "hlsPlaylist",
        default,
        skip_serializing_if = "String::is_empty"
    )]
    pub hls_playlist: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HlsKey {
    pub uri: String,
    pub key: String,
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
    if command.hls_keys.is_empty() != command.hls_playlist.is_empty()
        || command.hls_playlist.len() > MAX_HLS_PLAYLIST_BYTES
        || command
            .hls_playlist
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
    {
        return Err(error(
            "invalid-media-download-hls-keys",
            "HLS keys and their playlist must be supplied together",
        ));
    }
    if !command.hls_keys.is_empty()
        && (!matches!(command.input_kind.as_str(), "HLS_MASTER" | "HLS_MEDIA")
            || command.hls_keys.len() > MAX_HLS_KEYS
            || command
                .hls_keys
                .iter()
                .any(|item| !valid_http_url(&item.uri) || decode_hls_key(&item.key).is_none()))
    {
        return Err(error(
            "invalid-media-download-hls-keys",
            "HLS keys must be bounded 16 or 32 byte values for public key URLs",
        ));
    }
    Ok(())
}

fn decode_hls_key(value: &str) -> Option<Vec<u8>> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    if value.len() > 64 {
        return None;
    }
    STANDARD
        .decode(value)
        .ok()
        .filter(|bytes| bytes.len() == 16 || bytes.len() == 32)
}

fn hls_attribute_uri(line: &str) -> Option<(usize, usize)> {
    let start = line.find("URI=\"")? + "URI=\"".len();
    let end = start + line[start..].find('"')?;
    Some((start, end))
}

/// Writes the page-decoded keys and a local copy of the media playlist whose
/// key URIs point at those files. Segment URIs become absolute so yt-dlp still
/// fetches them from the original server. Returns the local playlist URL.
fn prepare_keyed_playlist(command: &Command, workspace: &Path) -> Result<String, String> {
    // The page sends the exact playlist whose tokenized key URIs it decoded;
    // refetching would mint new key tokens the page never resolved.
    let base =
        reqwest::Url::parse(&command.url).map_err(|_| "invalid hls playlist URL".to_string())?;
    let text = command.hls_playlist.clone();
    if text.len() > MAX_HLS_PLAYLIST_BYTES
        || !text.starts_with("#EXTM3U")
        || text.contains("#EXT-X-STREAM-INF")
    {
        return Err("hls keys require a media playlist".into());
    }
    let key_directory = workspace.join(".keys");
    fs::create_dir_all(&key_directory).map_err(|error| error.to_string())?;
    let mut key_files = BTreeMap::new();
    for (index, item) in command.hls_keys.iter().enumerate() {
        let bytes = decode_hls_key(&item.key).ok_or("invalid hls key")?;
        let path = key_directory.join(format!("key-{index}.bin"));
        fs::write(&path, bytes).map_err(|error| error.to_string())?;
        let url =
            reqwest::Url::from_file_path(&path).map_err(|_| "invalid key path".to_string())?;
        key_files.insert(item.uri.clone(), url.to_string());
    }
    let mut output = String::with_capacity(text.len() + 256);
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("#EXT-X-KEY:") || trimmed.starts_with("#EXT-X-MAP:") {
            if let Some((start, end)) = hls_attribute_uri(trimmed) {
                let absolute = base
                    .join(&trimmed[start..end])
                    .map_err(|_| "invalid hls attribute URI".to_string())?;
                let replacement = if trimmed.starts_with("#EXT-X-KEY:") {
                    key_files
                        .get(absolute.as_str())
                        .cloned()
                        .ok_or_else(|| "hls key was not decoded by the page".to_string())?
                } else {
                    absolute.to_string()
                };
                output.push_str(&trimmed[..start]);
                output.push_str(&replacement);
                output.push_str(&trimmed[end..]);
                output.push('\n');
                continue;
            }
        } else if !trimmed.is_empty() && !trimmed.starts_with('#') {
            let absolute = base
                .join(trimmed)
                .map_err(|_| "invalid hls segment URI".to_string())?;
            if !valid_http_url(absolute.as_str()) {
                return Err("hls segment URL is not public".into());
            }
            output.push_str(absolute.as_str());
            output.push('\n');
            continue;
        }
        output.push_str(trimmed);
        output.push('\n');
    }
    let playlist = key_directory.join("playlist.m3u8");
    fs::write(&playlist, output).map_err(|error| error.to_string())?;
    reqwest::Url::from_file_path(&playlist)
        .map(|url| url.to_string())
        .map_err(|_| "invalid playlist path".to_string())
}

pub fn validate_command(raw: &Value, message_bytes: usize) -> Result<Command, ValidationError> {
    let keyed = raw.get("hlsPlaylist").is_some_and(Value::is_string);
    let limit = if keyed {
        MAX_KEYED_MESSAGE_BYTES
    } else {
        MAX_MESSAGE_BYTES
    };
    if message_bytes == 0 || message_bytes > limit {
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
    pub jobs_directory: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
enum DownloadAttemptResult {
    Completed,
    Failed(String),
    SpawnError(String),
    StatusError(String),
    StateError(String),
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

fn update_state<F>(
    jobs_directory: &Path,
    state: &mut job_store::JobState,
    notify: &F,
) -> io::Result<()>
where
    F: Fn(&job_store::JobState),
{
    job_store::persist_job_state_in(jobs_directory, state, now_millis())?;
    notify(state);
    Ok(())
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
        DownloadAttemptResult::StateError(error) => {
            state.status = "failed".into();
            state.status_text = "다운로드 상태를 저장하지 못했습니다.".into();
            state.error = Some(format!("job-state-persist-failed: {error}"));
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
    // One range at a time is allowed after a server has limited requests.
    let concurrency = concurrency.clamp(1, RANGE_MAX_CONCURRENCY);
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
    let floor = RANGE_MIN_CONCURRENCY.min(limit.max(1));
    let limit = limit.max(floor);
    let current = current.clamp(floor, limit);
    let Some(previous) = previous_bytes_per_second.filter(|speed| *speed > 0.0) else {
        return (current + 1).min(limit);
    };
    if bytes_per_second >= previous * 0.92 {
        (current + 1).min(limit)
    } else if bytes_per_second < previous * 0.65 {
        current.saturating_sub(1).max(floor)
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

/// HTTP 429/503 on a parallel range means the server wants fewer concurrent
/// requests. The batch controller pauses, halves concurrency and retries the
/// same bytes instead of failing the whole download.
const RANGE_THROTTLE_RETRIES: usize = 8;
const RANGE_THROTTLE_MAX_WAIT: Duration = Duration::from_secs(30);

#[derive(Debug, PartialEq)]
enum RangeError {
    Throttled(Option<Duration>),
    Failed(String),
}

/// Range requests follow the public URL that served the first response, so a
/// one-shot token redirect (Streamtape /get_video) is not replayed per range.
fn pinned_range_command(command: &Command, served_url: &str) -> Command {
    let mut pinned = command.clone();
    if served_url != command.url && valid_http_url(served_url) {
        pinned.url = served_url.to_string();
    }
    pinned
}

fn advertised_retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|seconds| Duration::from_secs(seconds).min(RANGE_THROTTLE_MAX_WAIT))
}

fn throttle_backoff(advertised: Option<Duration>, attempt: usize) -> Duration {
    let backoff = Duration::from_millis(1_000u64.saturating_mul(1 << attempt.min(5)));
    advertised.unwrap_or(backoff).min(RANGE_THROTTLE_MAX_WAIT)
}

fn fetch_range(
    client: Client,
    command: Command,
    start: u64,
    end: u64,
    expected_total: u64,
) -> Result<(u64, Vec<u8>), RangeError> {
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
        let status = response.status();
        if status == StatusCode::TOO_MANY_REQUESTS || status == StatusCode::SERVICE_UNAVAILABLE {
            return Err(RangeError::Throttled(advertised_retry_after(
                response.headers(),
            )));
        }
        if status != StatusCode::PARTIAL_CONTENT {
            last_error = format!("progressive range HTTP {}", status.as_u16());
            if attempt + 1 < RANGE_RETRIES {
                thread::sleep(Duration::from_millis(250 * (attempt as u64 + 1)));
            }
            continue;
        }
        validate_response_content_type(&response).map_err(RangeError::Failed)?;
        if progressive_content_range(response.headers()) != Some((start, end, expected_total)) {
            return Err(RangeError::Failed(
                "progressive range response does not match the requested bytes".into(),
            ));
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
    Err(RangeError::Failed(last_error))
}

fn update_transfer_state<F>(
    jobs_directory: &Path,
    state: &mut job_store::JobState,
    notify: &F,
    written: u64,
    total: Option<u64>,
    started_at: Instant,
) -> io::Result<()>
where
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
    update_state(jobs_directory, state, notify)
}

fn execute_progressive_body<F>(
    command: &Command,
    downloads: &Path,
    state: &mut job_store::JobState,
    notify: &F,
    jobs_directory: &Path,
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
    // Hosts such as Streamtape answer a short-lived token URL with a redirect
    // to the real file; repeating the token URL for each range fails. Pin the
    // ranges to the validated public URL that actually served the media.
    let range_command = pinned_range_command(command, response.url().as_str());
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
    if let Err(error) = update_state(jobs_directory, state, notify) {
        return DownloadAttemptResult::StateError(error.to_string());
    }

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
        if let Err(error) = update_transfer_state(
            jobs_directory,
            state,
            notify,
            written,
            Some(range_total),
            started_at,
        ) {
            return DownloadAttemptResult::StateError(error.to_string());
        }

        let mut concurrency_limit = range_concurrency_limit();
        let mut concurrency = RANGE_INITIAL_CONCURRENCY.min(concurrency_limit);
        let mut previous_batch_speed = None;
        let mut throttle_attempts = 0_usize;
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
                let command = range_command.clone();
                workers.push(thread::spawn(move || {
                    let _ = sender.send(fetch_range(client, command, start, end, range_total));
                }));
            }
            drop(sender);
            let mut chunks = BTreeMap::new();
            let mut batch_error = None;
            let mut throttled = None;
            for result in receiver {
                match result {
                    Ok((start, bytes)) => {
                        chunks.insert(start, bytes);
                    }
                    Err(RangeError::Throttled(wait)) => {
                        throttled = Some(throttled.flatten().max(wait));
                    }
                    Err(RangeError::Failed(error)) => batch_error = Some(error),
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
            if let Some(advertised) = throttled {
                if throttle_attempts >= RANGE_THROTTLE_RETRIES {
                    return DownloadAttemptResult::Failed(
                        "progressive range HTTP 429: server kept limiting requests".into(),
                    );
                }
                // Keep the contiguous prefix that arrived, then slow down.
                for (start, end) in ranges.iter().copied() {
                    let Some(bytes) = chunks.remove(&start) else {
                        break;
                    };
                    if start != written || bytes.len() as u64 != end - start + 1 {
                        break;
                    }
                    if let Err(error) = file.write_all(&bytes) {
                        return DownloadAttemptResult::Failed(error.to_string());
                    }
                    written = written.saturating_add(bytes.len() as u64);
                }
                concurrency = (concurrency / 2).max(1);
                // Never ramp back above the level the server rejected.
                concurrency_limit = concurrency;
                state.status_text = "서버 요청 제한으로 잠시 기다리는 중…".into();
                if let Err(error) = update_state(jobs_directory, state, notify) {
                    return DownloadAttemptResult::StateError(error.to_string());
                }
                let wait = throttle_backoff(advertised, throttle_attempts);
                throttle_attempts += 1;
                let resume_at = Instant::now() + wait;
                while Instant::now() < resume_at {
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
                    thread::sleep(Duration::from_millis(100));
                }
                previous_batch_speed = None;
                continue;
            }
            throttle_attempts = 0;
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
                if let Err(error) = update_transfer_state(
                    jobs_directory,
                    state,
                    notify,
                    written,
                    Some(range_total),
                    started_at,
                ) {
                    return DownloadAttemptResult::StateError(error.to_string());
                }
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
                if let Err(error) =
                    update_transfer_state(jobs_directory, state, notify, written, total, started_at)
                {
                    return DownloadAttemptResult::StateError(error.to_string());
                }
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

#[derive(Serialize, Deserialize)]
struct ProgressiveWorker {
    command: Command,
    downloads: PathBuf,
    jobs: PathBuf,
}

pub fn run_progressive_worker(path: &Path) -> io::Result<()> {
    let worker: ProgressiveWorker =
        serde_json::from_slice(&fs::read(path)?).map_err(io::Error::other)?;
    let mut state = initial_job_state(&worker.command);
    state.status = "running".into();
    let outcome = execute_progressive_body(
        &worker.command,
        &worker.downloads,
        &mut state,
        &|_| {},
        &worker.jobs,
        None,
        None,
    );
    job_store::write_json_atomic(&path.with_extension("result.json"), &(outcome, state))
}

fn execute_progressive<F>(
    command: &Command,
    downloads: &Path,
    state: &mut job_store::JobState,
    _notify: &F,
    jobs: &Path,
    cancel: Option<&Path>,
    pause: Option<&Path>,
) -> DownloadAttemptResult
where
    F: Fn(&job_store::JobState),
{
    let path = downloads.join(".http-worker.json");
    let spec = ProgressiveWorker {
        command: command.clone(),
        downloads: downloads.into(),
        jobs: jobs.into(),
    };
    if let Err(error) = job_store::write_json_atomic(&path, &spec) {
        return DownloadAttemptResult::SpawnError(error.to_string());
    }
    let mut process = ProcessCommand::new(std::env::current_exe().unwrap_or_default());
    #[cfg(not(test))]
    process.arg("--run-progressive-worker").arg(&path);
    #[cfg(test)]
    process
        .args([
            "--exact",
            "media_download::execution_tests::progressive_worker_entry",
            "--ignored",
        ])
        .env("SEGMA_PROGRESSIVE_TEST_SPEC", &path);
    process.stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = match youtube::OwnedProcess::spawn(&mut process) {
        Ok(child) => child,
        Err(error) => return DownloadAttemptResult::SpawnError(error.to_string()),
    };
    loop {
        let stopped = if cancel.is_some_and(Path::exists) {
            Some(DownloadAttemptResult::Cancelled)
        } else if pause.is_some_and(Path::exists) {
            Some(DownloadAttemptResult::Paused)
        } else {
            None
        };
        if let Some(outcome) = stopped {
            return match child.finish(true) {
                Ok(_) => outcome,
                Err(error) => DownloadAttemptResult::StatusError(error.to_string()),
            };
        }
        match child.child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => return DownloadAttemptResult::StatusError(error.to_string()),
        }
    }
    if let Err(error) = child.finish(false) {
        return DownloadAttemptResult::StatusError(error.to_string());
    }
    match job_store::read_json::<(DownloadAttemptResult, job_store::JobState)>(
        &path.with_extension("result.json"),
    ) {
        Some((outcome, result)) => {
            *state = result;
            outcome
        }
        None => DownloadAttemptResult::StatusError("progressive-worker-result-missing".into()),
    }
}

fn execute_supervised_progressive<F>(
    command: &Command,
    downloads: &Path,
    state: &mut job_store::JobState,
    notify: &F,
    jobs: &Path,
    cancel: Option<&Path>,
    pause: Option<&Path>,
) -> io::Result<()>
where
    F: Fn(&job_store::JobState),
{
    let workspace = job_store::DownloadWorkspace::prepare(jobs, downloads, &command.job_id)?;
    let outcome = execute_progressive(command, &workspace.path, state, notify, jobs, cancel, pause);
    let outcome = match job_store::finish_download_output_in(
        jobs,
        state,
        &workspace,
        matches!(outcome, DownloadAttemptResult::Completed),
        matches!(outcome, DownloadAttemptResult::Paused),
    ) {
        Ok(()) => outcome,
        Err(error) => DownloadAttemptResult::Failed(error.to_string()),
    };
    let outcome = if matches!(
        outcome,
        DownloadAttemptResult::Completed | DownloadAttemptResult::Cancelled
    ) {
        match job_store::clear_cancel_marker_in(jobs, &command.job_id) {
            Ok(()) => outcome,
            Err(error) => {
                DownloadAttemptResult::Failed(format!("download-cleanup-failed: {error}"))
            }
        }
    } else {
        outcome
    };
    apply_download_outcome(state, outcome);
    return update_state(jobs, state, notify);
}

pub fn run_supervised_progressive_worker(path: &Path) -> io::Result<()> {
    let worker: ProgressiveWorker =
        serde_json::from_slice(&fs::read(path)?).map_err(io::Error::other)?;
    let _claim = job_store::acquire_runner_claim_in(&worker.jobs, &worker.command.job_id)?;
    let mut state = initial_job_state(&worker.command);
    state.status = "running".into();
    update_state(&worker.jobs, &mut state, &|_| {})?;
    let cancel = job_store::cancel_path_in(&worker.jobs, &worker.command.job_id)?;
    let pause = job_store::pause_path_in(&worker.jobs, &worker.command.job_id)?;
    execute_supervised_progressive(
        &worker.command,
        &worker.downloads,
        &mut state,
        &|_| {},
        &worker.jobs,
        Some(&cancel),
        Some(&pause),
    )
}

fn configure_process(
    process: &mut ProcessCommand,
    command: &Command,
    downloads: &Path,
    node: &Path,
    ffmpeg: &Path,
    impersonate_browser: bool,
    keyed_playlist: Option<&str>,
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
        // --print implies --quiet, which hides progress; --progress restores it.
        .arg("--progress")
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
    match keyed_playlist {
        // Only our own workspace playlist is read from disk; segments remain
        // public HTTP URLs validated while the playlist was rewritten.
        Some(local) => {
            process.arg("--enable-file-urls").arg(local);
        }
        None => {
            process.arg(&command.url);
        }
    }
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
) -> io::Result<()>
where
    F: Fn(&job_store::JobState),
{
    let mut state = initial_job_state(&command);
    state.status = "running".into();
    state.status_text = "미디어 다운로드를 준비하는 중…".into();
    update_state(&context.jobs_directory, &mut state, notify)?;

    if let Err(error) = validate_fields(&command) {
        state.status = "failed".into();
        state.status_text = "올바른 미디어 다운로드 요청이 아닙니다.".into();
        state.error = Some(error.code.into());
        return update_state(&context.jobs_directory, &mut state, notify);
    }
    let downloads = match (context.downloads)() {
        Ok(path) => path,
        Err(error) => {
            state.status = "failed".into();
            state.status_text = "Companion 다운로드 폴더를 준비하지 못했습니다.".into();
            state.error = Some(error);
            return update_state(&context.jobs_directory, &mut state, notify);
        }
    };
    if command.input_kind == "PROGRESSIVE" {
        return execute_supervised_progressive(
            &command,
            &downloads,
            &mut state,
            notify,
            &context.jobs_directory,
            context.cancel_path.as_deref(),
            context.pause_path.as_deref(),
        );
    }
    let tools_directory = match (context.tools_directory)() {
        Ok(path) => path,
        Err(error) => {
            state.status = "failed".into();
            state.status_text = "미디어 도구가 설치되지 않았습니다.".into();
            state.error = Some(error);
            return update_state(&context.jobs_directory, &mut state, notify);
        }
    };
    let (yt_dlp, node, ffmpeg) = match youtube::command_tools(&tools_directory) {
        Ok(tools) => tools,
        Err(error) => {
            state.status = "failed".into();
            state.status_text = "미디어 도구가 설치되지 않았습니다.".into();
            state.error = Some(error.to_string());
            return update_state(&context.jobs_directory, &mut state, notify);
        }
    };
    let workspace = job_store::DownloadWorkspace::prepare(
        &context.jobs_directory,
        &downloads,
        &command.job_id,
    )?;
    let mut process = ProcessCommand::new(yt_dlp);
    let keyed_playlist = if command.hls_keys.is_empty() {
        None
    } else {
        match prepare_keyed_playlist(&command, &workspace.path) {
            Ok(url) => Some(url),
            Err(error) => {
                let _ = job_store::cleanup_download_workspace_in(
                    &context.jobs_directory,
                    &command.job_id,
                );
                state.status = "failed".into();
                state.status_text = "보호된 영상 목록을 준비하지 못했습니다.".into();
                state.error = Some(format!("hls-key-playlist-failed: {error}"));
                return update_state(&context.jobs_directory, &mut state, notify);
            }
        }
    };
    configure_process(
        &mut process,
        &command,
        &workspace.path,
        &node,
        &ffmpeg,
        impersonate_browser,
        keyed_playlist.as_deref(),
    );
    let outcome = match youtube::run_owned_download(
        &mut process,
        context.cancel_path.as_deref(),
        context.pause_path.as_deref(),
        |line| {
            if let Some(progress) = line.strip_prefix("AURA_PROGRESS:") {
                state.progress = parse_progress(progress);
                state.status_text = format!("다운로드 중 · {}", progress.trim());
                update_state(&context.jobs_directory, &mut state, notify)?;
            } else if let Some(path) = line.strip_prefix("AURA_FILE:") {
                state.file_name = Path::new(path.trim())
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned());
            }
            Ok(())
        },
    ) {
        Ok(youtube::ProcessOutcome::Completed) => DownloadAttemptResult::Completed,
        Ok(youtube::ProcessOutcome::Cancelled) => DownloadAttemptResult::Cancelled,
        Ok(youtube::ProcessOutcome::Paused) => DownloadAttemptResult::Paused,
        Ok(youtube::ProcessOutcome::Failed(error)) => DownloadAttemptResult::Failed(error),
        Err(error) => {
            state.status = "failed".into();
            state.status_text = "다운로드 실행기 종료를 확인하지 못했습니다.".into();
            state.error = Some(format!("download-stop-failed: {error}"));
            return update_state(&context.jobs_directory, &mut state, notify);
        }
    };
    if !impersonate_browser && should_retry_with_impersonation(&command, &outcome) {
        state.status_text = "Cloudflare 요청 검증을 다시 시도하는 중…".into();
        update_state(&context.jobs_directory, &mut state, notify)?;
        return execute_attempt(command, context, notify, true);
    }
    let outcome = match job_store::finish_download_output_in(
        &context.jobs_directory,
        &mut state,
        &workspace,
        matches!(outcome, DownloadAttemptResult::Completed),
        matches!(outcome, DownloadAttemptResult::Paused),
    ) {
        Ok(()) => outcome,
        Err(error) => DownloadAttemptResult::Failed(error.to_string()),
    };
    let outcome = if matches!(
        outcome,
        DownloadAttemptResult::Completed | DownloadAttemptResult::Cancelled
    ) {
        match job_store::clear_cancel_marker_in(&context.jobs_directory, &command.job_id) {
            Ok(()) => outcome,
            Err(error) => {
                DownloadAttemptResult::Failed(format!("download-cleanup-failed: {error}"))
            }
        }
    } else {
        outcome
    };
    apply_download_outcome(&mut state, outcome);
    update_state(&context.jobs_directory, &mut state, notify)
}

pub fn execute<F>(command: Command, context: ExecutionContext, notify: F) -> io::Result<()>
where
    F: Fn(&job_store::JobState),
{
    execute_attempt(command, &context, &notify, false)
}

#[cfg(test)]
mod execution_tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(1);

    fn test_directory(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "segma-media-download-{tag}-{}-{}",
            std::process::id(),
            NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).expect("test directory creates");
        path
    }

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
    #[ignore = "entry point for isolated HTTP fixture process"]
    fn progressive_worker_entry() {
        let path = std::env::var_os("SEGMA_PROGRESSIVE_TEST_SPEC").expect("fixture spec");
        run_progressive_worker(Path::new(&path)).unwrap();
    }

    #[test]
    fn state_publication_error_is_not_reported_as_media_process_exit() {
        let mut state = initial_job_state(&command());
        apply_download_outcome(
            &mut state,
            DownloadAttemptResult::StateError("Access is denied. (os error 5)".into()),
        );
        assert_eq!(state.status, "failed");
        assert_eq!(state.status_text, "다운로드 상태를 저장하지 못했습니다.");
        assert!(state
            .error
            .unwrap()
            .starts_with("job-state-persist-failed:"));
    }

    #[test]
    fn stalled_http_range_cancellation_is_prompt_and_removes_owned_partial() {
        use std::net::TcpListener;
        for mode in ["headers", "body", "ranges", "pause"] {
            let root = test_directory(mode);
            let downloads = root.join("downloads");
            let jobs = root.join("jobs");
            fs::create_dir_all(&downloads).unwrap();
            fs::create_dir_all(&jobs).unwrap();
            fs::write(downloads.join("preexisting.mp4"), b"prior completed output").unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let mut command = command();
            command.url = format!("http://{}/video.mp4", listener.local_addr().unwrap());
            let (ready_tx, ready_rx) = mpsc::channel();
            let server = thread::spawn(move || {
                let mut until = Instant::now() + Duration::from_secs(20);
                let mut ready = false;
                let mut connections = Vec::new();
                while Instant::now() < until {
                    if let Ok((mut stream, _)) = listener.accept() {
                        let mut request = [0; 4096];
                        // Accepted sockets inherit the listener's nonblocking
                        // mode on Windows; the read timeout below needs blocking.
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(1)))
                            .unwrap();
                        let mut headers = Vec::new();
                        while !headers.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                            match stream.read(&mut request) {
                                Ok(0) | Err(_) => break,
                                Ok(count) => headers.extend_from_slice(&request[..count]),
                            }
                        }
                        if !headers.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                            continue;
                        }
                        if mode == "headers" {
                            let _ = ready_tx.send(());
                        } else if mode == "body" {
                            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 1048576\r\n\r\nx").unwrap();
                            let _ = ready_tx.send(());
                        } else if connections.is_empty() {
                            stream.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nContent-Range: bytes 0-0/4194305\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx").unwrap();
                        } else {
                            // Send valid range headers then keep the body open.
                            let text = String::from_utf8_lossy(&headers);
                            let range = text
                                .lines()
                                .find_map(|line| {
                                    line.to_ascii_lowercase()
                                        .strip_prefix("range: bytes=")
                                        .map(str::to_owned)
                                })
                                .unwrap();
                            let (start, end) = range.trim().split_once('-').unwrap();
                            let start: u64 = start.parse().unwrap();
                            let end: u64 = end.parse().unwrap();
                            write!(stream, "HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nContent-Range: bytes {start}-{end}/4194305\r\nContent-Length: {}\r\n\r\n", end-start+1).unwrap();
                            let _ = ready_tx.send(());
                        }
                        if !ready
                            && (mode == "headers" || mode == "body" || !connections.is_empty())
                        {
                            ready = true;
                            until = Instant::now() + Duration::from_secs(1);
                        }
                        connections.push(stream);
                    }
                    thread::sleep(Duration::from_millis(5));
                }
            });
            let cancel = jobs.join("job-123.cancel");
            let runner_cancel = cancel.clone();
            let pause = jobs.join("job-123.pause");
            let runner_pause = pause.clone();
            let runner_jobs = jobs.clone();
            let runner_downloads = downloads.clone();
            let runner = thread::spawn(move || {
                let workspace = job_store::DownloadWorkspace::prepare(
                    &runner_jobs,
                    &runner_downloads,
                    &command.job_id,
                )
                .unwrap();
                let mut state = initial_job_state(&command);
                let outcome = execute_progressive(
                    &command,
                    &workspace.path,
                    &mut state,
                    &|_| {},
                    &runner_jobs,
                    Some(&runner_cancel),
                    Some(&runner_pause),
                );
                job_store::finish_download_output_in(
                    &runner_jobs,
                    &mut state,
                    &workspace,
                    matches!(outcome, DownloadAttemptResult::Completed),
                    matches!(outcome, DownloadAttemptResult::Paused),
                )
                .unwrap();
                if matches!(outcome, DownloadAttemptResult::Paused) {
                    state.status = "paused".into();
                    job_store::persist_job_state_in(&runner_jobs, &mut state, now_millis())
                        .unwrap();
                }
                outcome
            });
            ready_rx
                .recv_timeout(Duration::from_secs(10))
                .unwrap_or_else(|error| panic!("{mode} fixture was not reached: {error:?}"));
            let cancelled_at = Instant::now();
            fs::write(if mode == "pause" { pause } else { cancel }, b"stop").unwrap();
            let outcome = runner.join().unwrap();
            let elapsed = cancelled_at.elapsed();
            server.join().unwrap();
            assert_eq!(
                outcome,
                if mode == "pause" {
                    DownloadAttemptResult::Paused
                } else {
                    DownloadAttemptResult::Cancelled
                }
            );
            assert!(
                elapsed < Duration::from_millis(900),
                "cancellation blocked for {elapsed:?}"
            );
            assert_eq!(
                fs::read(downloads.join("preexisting.mp4")).unwrap(),
                b"prior completed output"
            );
            if mode == "pause" {
                assert!(jobs.join("job-123.outputs.json").is_file());
                job_store::request_cancel_in(&jobs, "job-123", now_millis()).unwrap();
                assert_eq!(
                    job_store::read_json::<job_store::JobState>(&jobs.join("job-123.state.json"))
                        .unwrap()
                        .status,
                    "cancelled"
                );
            }
            assert_eq!(fs::read_dir(&downloads).unwrap().count(), 1);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn supervised_progressive_completion_preserves_bytes_and_existing_output() {
        use std::net::TcpListener;
        let root = test_directory("complete-http");
        let downloads = root.join("downloads");
        let jobs = root.join("jobs");
        fs::create_dir_all(&downloads).unwrap();
        fs::create_dir_all(&jobs).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut command = command();
        command.url = format!("http://{}/video.mp4", listener.local_addr().unwrap());
        let prior = downloads.join(progressive_output_filename(&command));
        fs::write(&prior, b"prior completed output").unwrap();
        let server = thread::spawn(move || {
            for index in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                stream.read(&mut request).unwrap();
                let (start, end, bytes) = if index == 0 {
                    (0, 0, vec![b'x'])
                } else {
                    (1, 1048575, vec![b'a'; 1048575])
                };
                write!(stream, "HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nContent-Range: bytes {start}-{end}/1048576\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len()).unwrap();
                stream.write_all(&bytes).unwrap();
            }
        });
        let workspace =
            job_store::DownloadWorkspace::prepare(&jobs, &downloads, &command.job_id).unwrap();
        let mut state = initial_job_state(&command);
        let outcome = execute_progressive(
            &command,
            &workspace.path,
            &mut state,
            &|_| {},
            &jobs,
            None,
            None,
        );
        server.join().unwrap();
        assert_eq!(outcome, DownloadAttemptResult::Completed);
        job_store::finish_download_output_in(&jobs, &mut state, &workspace, true, false).unwrap();
        assert_eq!(fs::read(&prior).unwrap(), b"prior completed output");
        let bytes = fs::read(downloads.join(state.file_name.unwrap())).unwrap();
        assert_eq!(bytes.len(), 1048576);
        assert_eq!(bytes[0], b'x');
        assert!(bytes[1..].iter().all(|byte| *byte == b'a'));
        assert!(!workspace.path.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn throttled_parallel_ranges_slow_down_and_complete_intact() {
        use std::net::TcpListener;
        use std::sync::atomic::AtomicUsize;
        use std::sync::Arc;
        let root = test_directory("throttle-http");
        let jobs = root.join("jobs");
        fs::create_dir_all(&jobs).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut command = command();
        command.url = format!("http://{}/video.mp4", listener.local_addr().unwrap());
        let total = 3 * RANGE_CHUNK_BYTES + 7;
        let in_flight = Arc::new(AtomicUsize::new(0));
        let throttled = Arc::new(AtomicUsize::new(0));
        let (counter, rejected) = (in_flight.clone(), throttled.clone());
        let server = thread::spawn(move || {
            listener.set_nonblocking(false).unwrap();
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let (counter, rejected) = (counter.clone(), rejected.clone());
                thread::spawn(move || {
                    let mut request = [0; 4096];
                    let read = stream.read(&mut request).unwrap_or(0);
                    let text = String::from_utf8_lossy(&request[..read]);
                    if text.contains("X-Stop: 1") {
                        return;
                    }
                    let range = text
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("range: bytes=")
                                .map(str::to_string)
                        })
                        .unwrap();
                    let (start, end) = range.trim().split_once('-').unwrap();
                    let start: u64 = start.parse().unwrap();
                    let end: u64 = end.parse().unwrap();
                    let active = counter.fetch_add(1, Ordering::SeqCst) + 1;
                    thread::sleep(Duration::from_millis(30));
                    if active > 1 {
                        rejected.fetch_add(1, Ordering::SeqCst);
                        let _ = write!(stream, "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 0\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    } else {
                        let body: Vec<u8> =
                            (start..=end).map(|index| (index % 251) as u8).collect();
                        let _ = write!(stream, "HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nContent-Range: bytes {start}-{end}/{total}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                        let _ = stream.write_all(&body);
                    }
                    counter.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        let mut state = initial_job_state(&command);
        let outcome =
            execute_progressive_body(&command, &root, &mut state, &|_| {}, &jobs, None, None);
        assert_eq!(outcome, DownloadAttemptResult::Completed);
        assert!(
            throttled.load(Ordering::SeqCst) > 0,
            "fixture must exercise 429"
        );
        let bytes = fs::read(root.join(state.file_name.clone().unwrap())).unwrap();
        assert_eq!(bytes.len() as u64, total);
        assert!(bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| *byte == (index as u64 % 251) as u8));
        drop(server);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn progressive_ranges_follow_the_served_public_url() {
        let mut command = command();
        command.url = "https://streamtape.com/get_video?id=x&token=once".into();
        let served = "https://123.tapecontent.net/radosgw/x/file.mp4?stream=1";
        assert_eq!(pinned_range_command(&command, served).url, served);
        assert_eq!(
            pinned_range_command(&command, &command.url.clone()).url,
            command.url
        );
        assert_eq!(
            pinned_range_command(&command, "http://127.0.0.1/private.mp4").url,
            command.url,
            "private redirect targets are never pinned"
        );
    }

    #[test]
    fn progressive_range_batches_are_contiguous_and_bounded() {
        assert_eq!(range_batch(0, 10 * RANGE_CHUNK_BYTES, 1).len(), 1);
        assert_eq!(adaptive_range_concurrency(1, 1, Some(10.0), 20.0), 1);
        assert_eq!(
            throttle_backoff(Some(Duration::from_secs(3)), 0),
            Duration::from_secs(3)
        );
        assert_eq!(throttle_backoff(None, 10), RANGE_THROTTLE_MAX_WAIT);
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
            None,
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
        // `--print` makes yt-dlp quiet; without `--progress` HLS jobs show no
        // progress at all until they finish (seen on a 930 MB MissAV job).
        assert!(arguments.iter().any(|argument| argument == "--progress"));

        let outcome = DownloadAttemptResult::Failed(
            "ERROR: [generic] HTTP Error 403 caused by Cloudflare anti-bot challenge".into(),
        );
        assert!(should_retry_with_impersonation(&command, &outcome));
    }

    #[test]
    fn hls_keys_accept_only_bounded_aes_values_for_hls() {
        let mut command = command();
        command.input_kind = "HLS_MEDIA".into();
        command.hls_keys = vec![HlsKey {
            uri: "https://keys.example/v/session".into(),
            key: "AQIDBAUGBwgJCgsMDQ4PEA==".into(),
        }];
        command.hls_playlist = "#EXTM3U\n".into();
        assert!(validate_fields(&command).is_ok());
        command.hls_keys[0].key = "AQID".into();
        assert_eq!(
            validate_fields(&command).unwrap_err().code,
            "invalid-media-download-hls-keys"
        );
        command.hls_keys[0].key = "AQIDBAUGBwgJCgsMDQ4PEA==".into();
        command.input_kind = "PROGRESSIVE".into();
        assert!(validate_fields(&command).is_err());
    }

    #[test]
    fn keyed_playlist_replaces_only_decoded_key_uris() {
        let root = test_directory("keyed-playlist");
        let mut command = command();
        command.input_kind = "HLS_MEDIA".into();
        command.url = "https://k.example/cast/abc/v.html?t=1".into();
        // The page resolved these exact tokenized key URIs; a refetched
        // playlist would carry different tokens.
        command.hls_playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://k.example/v/session?tok=a1\",IV=0x01\n#EXTINF:6.0,\nseg/0.ts\n#EXT-X-KEY:METHOD=AES-128,URI=\"/v/session?tok=b2\"\n#EXTINF:6.0,\nhttps://cdn.example/seg/1.ts\n#EXT-X-ENDLIST\n".into();
        command.hls_keys = vec![
            HlsKey {
                uri: "https://k.example/v/session?tok=a1".into(),
                key: "AQIDBAUGBwgJCgsMDQ4PEA==".into(),
            },
            HlsKey {
                uri: "https://k.example/v/session?tok=b2".into(),
                key: "EA8ODQwLCgkIBwYFBAMCAQ==".into(),
            },
        ];
        assert!(validate_fields(&command).is_ok());
        let local = prepare_keyed_playlist(&command, &root).expect("playlist rewrites");
        let path = reqwest::Url::parse(&local).unwrap().to_file_path().unwrap();
        let text = fs::read_to_string(path).unwrap();
        assert_eq!(text.matches("URI=\"file:///").count(), 2, "{text}");
        assert!(!text.contains("/v/session"), "{text}");
        assert!(
            text.contains("https://k.example/cast/abc/seg/0.ts"),
            "{text}"
        );
        assert!(text.contains("https://cdn.example/seg/1.ts"), "{text}");
        assert_eq!(
            fs::read(root.join(".keys").join("key-0.bin")).unwrap(),
            (1..=16).collect::<Vec<u8>>()
        );

        command.hls_keys.pop();
        assert!(prepare_keyed_playlist(&command, &root)
            .unwrap_err()
            .contains("not decoded"));
        command.hls_playlist.clear();
        assert!(
            validate_fields(&command).is_err(),
            "keys require their playlist"
        );
        fs::remove_dir_all(root).unwrap();
    }
    /// End-to-end with the installed tools: an AES-128 stream whose key
    /// endpoint is unusable must still be decrypted with the page key.
    #[test]
    fn keyed_playlist_decrypts_with_installed_tools() {
        let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") else {
            return;
        };
        let tools = PathBuf::from(local_app_data).join("Aura Media\\Companion\\tools");
        let Ok((yt_dlp, node, ffmpeg)) = youtube::command_tools(&tools) else {
            return;
        };
        let root = test_directory("keyed-decrypt");
        let key: Vec<u8> = (1..=16).collect();
        fs::write(root.join("k.bin"), &key).unwrap();
        fs::write(
            root.join("keyinfo.txt"),
            format!(
                "https://keys.example/v/session?tok=a1\n{}\n",
                root.join("k.bin").display()
            ),
        )
        .unwrap();
        let status = ProcessCommand::new(ffmpeg.join("ffmpeg.exe"))
            .current_dir(&root)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=4:size=160x120:rate=25",
            ])
            .args([
                "-c:v",
                "libx264",
                "-hls_time",
                "2",
                "-hls_key_info_file",
                "keyinfo.txt",
                "-hls_playlist_type",
                "vod",
                "-y",
                "index.m3u8",
            ])
            .status()
            .unwrap();
        assert!(status.success());
        fs::remove_file(root.join("k.bin")).unwrap();
        // Segments stay local here only because no public server exists in a
        // unit test; production rewriting requires public HTTP segments.
        let playlist = fs::read_to_string(root.join("index.m3u8"))
            .unwrap()
            .lines()
            .map(|line| {
                if line.ends_with(".ts") {
                    reqwest::Url::from_file_path(root.join(line))
                        .unwrap()
                        .to_string()
                } else {
                    line.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        let workspace = root.join("work");
        fs::create_dir_all(&workspace).unwrap();
        let key_directory = workspace.join(".keys");
        fs::create_dir_all(&key_directory).unwrap();
        fs::write(key_directory.join("key-0.bin"), &key).unwrap();
        let key_url = reqwest::Url::from_file_path(key_directory.join("key-0.bin")).unwrap();
        let local_playlist = key_directory.join("playlist.m3u8");
        fs::write(
            &local_playlist,
            playlist.replace("https://keys.example/v/session?tok=a1", key_url.as_str()),
        )
        .unwrap();
        let mut command = command();
        command.input_kind = "HLS_MEDIA".into();
        command.title = "keyed".into();
        let mut process = ProcessCommand::new(yt_dlp);
        configure_process(
            &mut process,
            &command,
            &workspace,
            &node,
            &ffmpeg,
            false,
            Some(
                reqwest::Url::from_file_path(&local_playlist)
                    .unwrap()
                    .as_str(),
            ),
        );
        let output = process.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let saved = fs::read_dir(&workspace)
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| entry.path().extension().is_some_and(|ext| ext == "mp4"))
            .expect("decrypted mp4 saved");
        let probe = ProcessCommand::new(ffmpeg.join("ffmpeg.exe"))
            .args(["-v", "error", "-i"])
            .arg(saved.path())
            .args(["-f", "null", "-"])
            .output()
            .unwrap();
        assert!(
            probe.status.success() && probe.stderr.is_empty(),
            "{}",
            String::from_utf8_lossy(&probe.stderr)
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn initial_persistence_failure_stops_before_media_setup_or_network() {
        let root = test_directory("state-failure");
        let blocked = root.join("not-a-directory");
        fs::write(&blocked, b"blocked").expect("blocking file writes");
        let context = ExecutionContext {
            downloads: || panic!("downloads must not resolve after state failure"),
            tools_directory: || panic!("tools must not resolve after state failure"),
            cancel_path: None,
            pause_path: None,
            jobs_directory: blocked,
        };

        assert!(execute(command(), context, |_| {}).is_err());
        fs::remove_dir_all(root).expect("test directory removes");
    }
}
