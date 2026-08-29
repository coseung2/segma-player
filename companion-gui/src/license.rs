//! App-owned General/Pro entitlement state.
//!
//! The browser extension is a free detector. The installed app validates and
//! stores the Pro key in the Companion settings file used by the subtitle
//! runner. Browser storage is deliberately not inspected or imported.

use reqwest::blocking::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::hash_map::RandomState;
use std::fs;
use std::hash::{BuildHasher, Hash, Hasher};
use std::io;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::jobs;

const LICENSE_API_URL: &str = "https://aura.mdownloader.workers.dev/api/license";
const MAX_SETTINGS_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AppLicense {
    pub key: String,
    pub pro: bool,
    pub expires_at: Option<u64>,
    pub devices: Option<u32>,
    pub limit: Option<u32>,
}

impl AppLicense {
    pub fn masked_key(&self) -> String {
        if self.key.len() < 8 {
            return "등록된 키".into();
        }
        format!("AM-••••••••-{}", &self.key[self.key.len() - 4..])
    }

    pub fn days_remaining(&self) -> Option<u64> {
        let expires = self.expires_at?;
        Some(expires.saturating_sub(now_millis()) / 86_400_000)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LicenseError {
    InvalidKey,
    ServerUnreachable,
    DeviceLimit {
        devices: Option<u32>,
        limit: Option<u32>,
    },
    Pending,
    NotApproved,
    InvalidResponse,
    SaveFailed,
}

impl LicenseError {
    pub fn message(&self) -> String {
        match self {
            Self::InvalidKey => "인증키 형식을 확인해 주세요.".into(),
            Self::ServerUnreachable => "인증 서버에 연결하지 못했습니다.".into(),
            Self::DeviceLimit { devices, limit } => match (devices, limit) {
                (Some(devices), Some(limit)) => {
                    format!("등록 가능한 기기 수를 초과했습니다. ({devices}/{limit})")
                }
                _ => "등록 가능한 기기 수를 초과했습니다.".into(),
            },
            Self::Pending => "아직 승인 대기 중인 인증키입니다.".into(),
            Self::NotApproved => "승인된 Pro 인증키가 아닙니다.".into(),
            Self::InvalidResponse => "인증 서버 응답을 확인하지 못했습니다.".into(),
            Self::SaveFailed => "인증 정보를 앱에 저장하지 못했습니다.".into(),
        }
    }

    pub fn invalidates_existing_pro(&self) -> bool {
        matches!(
            self,
            Self::InvalidKey | Self::DeviceLimit { .. } | Self::Pending | Self::NotApproved
        )
    }
}

#[derive(Debug, Deserialize)]
struct LicenseResponse {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    edition: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(rename = "expiresAt", default)]
    expires_at: Option<u64>,
    #[serde(default)]
    devices: Option<u32>,
    #[serde(default)]
    limit: Option<u32>,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn normalize_key(value: &str) -> Option<String> {
    let key = value.trim().to_ascii_uppercase();
    let bytes = key.as_bytes();
    (bytes.len() == 39
        && &bytes[..3] == b"AM-"
        && bytes[3..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(byte)))
    .then_some(key)
}

fn read_document(root: &Path) -> Value {
    match fs::read(jobs::settings_path(root)) {
        Ok(bytes) if bytes.len() <= MAX_SETTINGS_BYTES => {
            serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}))
        }
        _ => json!({}),
    }
}

fn write_document(root: &Path, document: &Value) -> io::Result<()> {
    fs::create_dir_all(root)?;
    let file = jobs::settings_path(root);
    let temporary = file.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(document).map_err(io::Error::other)?,
    )?;
    fs::rename(temporary, file)
}

fn generated_device_id() -> String {
    let mut hasher = RandomState::new().build_hasher();
    now_millis().hash(&mut hasher);
    std::process::id().hash(&mut hasher);
    format!("segma-app-{:016x}", hasher.finish())
}

fn ensure_device_id(root: &Path) -> io::Result<String> {
    let mut document = read_document(root);
    if let Some(value) = document
        .get("licenseDeviceId")
        .and_then(Value::as_str)
        .filter(|value| {
            (8..=64).contains(&value.len())
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return Ok(value.to_string());
    }
    let device_id = generated_device_id();
    if !document.is_object() {
        document = json!({});
    }
    document["licenseDeviceId"] = Value::String(device_id.clone());
    write_document(root, &document)?;
    Ok(device_id)
}

pub fn load_in(root: &Path) -> AppLicense {
    let document = read_document(root);
    let key = document
        .get("licenseKey")
        .and_then(Value::as_str)
        .and_then(normalize_key)
        .unwrap_or_default();
    let expires_at = document.get("licenseExpiresAt").and_then(Value::as_u64);
    let approved = document.get("licenseEdition").and_then(Value::as_str) == Some("pro")
        && document.get("licenseStatus").and_then(Value::as_str) == Some("approved")
        && !key.is_empty()
        && !expires_at.is_some_and(|expires| expires > 0 && now_millis() > expires);
    AppLicense {
        key,
        pro: approved,
        expires_at,
        devices: document
            .get("licenseDevices")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok()),
        limit: document
            .get("licenseLimit")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok()),
    }
}

pub fn load() -> AppLicense {
    jobs::companion_root()
        .ok()
        .map(|root| load_in(&root))
        .unwrap_or_default()
}

fn approved_from_response(
    key: String,
    response: LicenseResponse,
) -> Result<AppLicense, LicenseError> {
    if response.error.as_deref() == Some("device-limit-reached") {
        return Err(LicenseError::DeviceLimit {
            devices: response.devices,
            limit: response.limit,
        });
    }
    if response.status.as_deref() == Some("pending") {
        return Err(LicenseError::Pending);
    }
    if !response.ok
        || response.edition.as_deref() != Some("pro")
        || response.status.as_deref() != Some("approved")
    {
        return Err(if response.error.as_deref() == Some("invalid-key") {
            LicenseError::InvalidKey
        } else {
            LicenseError::NotApproved
        });
    }
    Ok(AppLicense {
        key,
        pro: true,
        expires_at: response.expires_at,
        devices: response.devices,
        limit: response.limit,
    })
}

pub fn verify(raw_key: &str) -> Result<AppLicense, LicenseError> {
    let key = normalize_key(raw_key).ok_or(LicenseError::InvalidKey)?;
    let root = jobs::companion_root().map_err(|_| LicenseError::SaveFailed)?;
    let device_id = ensure_device_id(&root).map_err(|_| LicenseError::SaveFailed)?;
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| LicenseError::ServerUnreachable)?;
    let response = client
        .get(LICENSE_API_URL)
        .query(&[("key", key.as_str()), ("deviceId", device_id.as_str())])
        .send()
        .map_err(|_| LicenseError::ServerUnreachable)?;
    let body = response
        .json::<LicenseResponse>()
        .map_err(|_| LicenseError::InvalidResponse)?;
    approved_from_response(key, body)
}

pub fn save_approved_in(root: &Path, license: &AppLicense) -> io::Result<()> {
    let key = normalize_key(&license.key)
        .filter(|_| license.pro)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid Pro license"))?;
    let mut document = read_document(root);
    if !document.is_object() {
        document = json!({});
    }
    document["licenseKey"] = Value::String(key);
    document["licenseEdition"] = Value::String("pro".into());
    document["licenseStatus"] = Value::String("approved".into());
    document["licenseExpiresAt"] = license.expires_at.map_or(Value::Null, Value::from);
    document["licenseDevices"] = license.devices.map_or(Value::Null, Value::from);
    document["licenseLimit"] = license.limit.map_or(Value::Null, Value::from);
    write_document(root, &document)
}

pub fn save_approved(license: &AppLicense) -> io::Result<()> {
    save_approved_in(&jobs::companion_root()?, license)
}

pub fn remove_in(root: &Path) -> io::Result<()> {
    let mut document = read_document(root);
    if let Some(object) = document.as_object_mut() {
        for key in [
            "licenseKey",
            "licenseEdition",
            "licenseStatus",
            "licenseExpiresAt",
            "licenseDevices",
            "licenseLimit",
        ] {
            object.remove(key);
        }
    }
    write_document(root, &document)
}

pub fn remove() -> io::Result<()> {
    remove_in(&jobs::companion_root()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("segma-license-test-{}", now_millis()))
    }

    #[test]
    fn key_contract_matches_the_worker_and_native_host() {
        assert_eq!(
            normalize_key("am-0123456789abcdef0123456789abcdef0123"),
            Some("AM-0123456789ABCDEF0123456789ABCDEF0123".into())
        );
        assert_eq!(normalize_key("AM-short"), None);
        assert_eq!(
            normalize_key("AM-0123456789ABCDEF0123456789ABCDEF012G"),
            None
        );
    }

    #[test]
    fn approved_license_round_trip_preserves_unrelated_settings() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            jobs::settings_path(&root),
            br#"{"downloadFolder":"C:\\Media"}"#,
        )
        .unwrap();
        let license = AppLicense {
            key: "AM-0123456789ABCDEF0123456789ABCDEF0123".into(),
            pro: true,
            expires_at: Some(now_millis() + 86_400_000),
            devices: Some(1),
            limit: Some(3),
        };
        save_approved_in(&root, &license).unwrap();
        let loaded = load_in(&root);
        assert!(loaded.pro);
        assert_eq!(loaded.devices, Some(1));
        let document: Value =
            serde_json::from_slice(&fs::read(jobs::settings_path(&root)).unwrap()).unwrap();
        assert_eq!(document["downloadFolder"], "C:\\Media");
        remove_in(&root).unwrap();
        assert!(!load_in(&root).pro);
        let document: Value =
            serde_json::from_slice(&fs::read(jobs::settings_path(&root)).unwrap()).unwrap();
        assert_eq!(document["downloadFolder"], "C:\\Media");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn server_response_only_unlocks_an_approved_pro_record() {
        let key = "AM-0123456789ABCDEF0123456789ABCDEF0123".to_string();
        let approved = approved_from_response(
            key.clone(),
            LicenseResponse {
                ok: true,
                error: None,
                edition: Some("pro".into()),
                status: Some("approved".into()),
                expires_at: None,
                devices: Some(1),
                limit: Some(3),
            },
        )
        .unwrap();
        assert!(approved.pro);
        assert_eq!(approved.key, key);

        let pending = approved_from_response(
            approved.key,
            LicenseResponse {
                ok: true,
                error: None,
                edition: Some("free".into()),
                status: Some("pending".into()),
                expires_at: None,
                devices: None,
                limit: None,
            },
        );
        assert_eq!(pending, Err(LicenseError::Pending));
        assert!(LicenseError::Pending.invalidates_existing_pro());
        assert!(!LicenseError::ServerUnreachable.invalidates_existing_pro());
    }
}
