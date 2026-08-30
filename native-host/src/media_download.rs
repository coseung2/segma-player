use crate::job_store;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::net::IpAddr;

const COMMAND_VERSION: u32 = 1;
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024;
const MAX_URL_BYTES: usize = 4096;
const MAX_TITLE_BYTES: usize = 512;
const MAX_ID_BYTES: usize = 128;
const MAX_USER_AGENT_BYTES: usize = 512;
const MAX_ACCEPT_LANGUAGE_BYTES: usize = 256;

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
