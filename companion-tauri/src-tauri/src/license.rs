//! App-owned entitlement state and the real license verification seam.
//!
//! Only normalized Pro keys are stored. The command layer exposes a masked
//! key, while `verify` performs the actual network request used in production.

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hash, Hasher};
use std::io;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::jobs;

const LICENSE_API_URL: &str = "https://aura.mdownloader.workers.dev/api/license";

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
            return "AM-••••".into();
        }
        format!("AM-••••••••{}", &self.key[self.key.len() - 4..])
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
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidKey => "invalid-key",
            Self::ServerUnreachable => "license-server-unreachable",
            Self::DeviceLimit { .. } => "device-limit-reached",
            Self::Pending => "license-pending",
            Self::NotApproved => "license-not-approved",
            Self::InvalidResponse => "invalid-license-response",
            Self::SaveFailed => "license-save-failed",
        }
    }

    pub fn message(&self) -> &'static str {
        match self {
            Self::InvalidKey => "인증키 형식을 확인해 주세요.",
            Self::ServerUnreachable => "인증 서버에 연결하지 못했습니다.",
            Self::DeviceLimit { .. } => "등록 가능한 기기 수를 초과했습니다.",
            Self::Pending => "아직 승인 대기 중인 인증키입니다.",
            Self::NotApproved => "승인된 Pro 인증키가 아닙니다.",
            Self::InvalidResponse => "인증 서버 응답을 확인하지 못했습니다.",
            Self::SaveFailed => "인증 정보를 저장하지 못했습니다.",
        }
    }

    pub fn invalidates_existing_pro(&self) -> bool {
        matches!(
            self,
            Self::InvalidKey | Self::DeviceLimit { .. } | Self::Pending | Self::NotApproved
        )
    }
}

/// Public only so deterministic tests can exercise response handling without
/// contacting the network. Production uses the same type from `verify`.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct LicenseVerificationResponse {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub edition: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(rename = "expiresAt", default)]
    pub expires_at: Option<u64>,
    #[serde(default)]
    pub devices: Option<u32>,
    #[serde(default)]
    pub limit: Option<u32>,
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
    aura_companion_contract::read_settings_document(root)
}

fn update_document<F>(root: &Path, update: F) -> io::Result<()>
where
    F: FnOnce(&mut Value),
{
    aura_companion_contract::update_settings_document(root, |document| {
        update(document);
        Ok(())
    })?;
    Ok(())
}

fn generated_device_id() -> String {
    let mut hasher = RandomState::new().build_hasher();
    now_millis().hash(&mut hasher);
    std::process::id().hash(&mut hasher);
    format!("segma-app-{:016x}", hasher.finish())
}

fn ensure_device_id(root: &Path) -> io::Result<String> {
    let document = read_document(root);
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
    update_document(root, |document| {
        document["licenseDeviceId"] = Value::String(device_id.clone())
    })?;
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
    response: LicenseVerificationResponse,
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

/// Testable response/storage seam. The closure receives only the normalized
/// key and opaque device id; it cannot access filesystem paths or raw secrets.
pub fn verify_in_with<F>(raw_key: &str, root: &Path, fetch: F) -> Result<AppLicense, LicenseError>
where
    F: FnOnce(&str, &str) -> Result<LicenseVerificationResponse, LicenseError>,
{
    let key = normalize_key(raw_key).ok_or(LicenseError::InvalidKey)?;
    let device_id = ensure_device_id(root).map_err(|_| LicenseError::SaveFailed)?;
    fetch(&key, &device_id).and_then(|response| approved_from_response(key, response))
}

/// Production verification. This is deliberately not a stub: commands that
/// call it contact the configured license endpoint with bounded timeouts.
pub fn verify(raw_key: &str) -> Result<AppLicense, LicenseError> {
    let root = jobs::companion_root().map_err(|_| LicenseError::SaveFailed)?;
    verify_in_with(raw_key, &root, |key, device_id| {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(12))
            .build()
            .map_err(|_| LicenseError::ServerUnreachable)?;
        client
            .get(LICENSE_API_URL)
            .query(&[("key", key), ("deviceId", device_id)])
            .send()
            .map_err(|_| LicenseError::ServerUnreachable)?
            .json::<LicenseVerificationResponse>()
            .map_err(|_| LicenseError::InvalidResponse)
    })
}

pub fn save_approved_in(root: &Path, license: &AppLicense) -> io::Result<()> {
    let key = normalize_key(&license.key)
        .filter(|_| license.pro)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid Pro license"))?;
    update_document(root, |document| {
        document["licenseKey"] = Value::String(key);
        document["licenseEdition"] = Value::String("pro".into());
        document["licenseStatus"] = Value::String("approved".into());
        document["licenseExpiresAt"] = license.expires_at.map_or(Value::Null, Value::from);
        document["licenseDevices"] = license.devices.map_or(Value::Null, Value::from);
        document["licenseLimit"] = license.limit.map_or(Value::Null, Value::from);
    })
}

pub fn save_approved(license: &AppLicense) -> io::Result<()> {
    save_approved_in(&jobs::companion_root()?, license)
}

pub fn remove_in(root: &Path) -> io::Result<()> {
    update_document(root, |document| {
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
    })
}

pub fn remove() -> io::Result<()> {
    remove_in(&jobs::companion_root()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn root(label: &str) -> std::path::PathBuf {
        let root =
            std::env::temp_dir().join(format!("segma-tauri-license-{label}-{}", now_millis()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn normalization_matches_the_worker_contract() {
        assert_eq!(
            normalize_key(" am-0123456789abcdef0123456789abcdef0123 "),
            Some("AM-0123456789ABCDEF0123456789ABCDEF0123".into())
        );
        assert!(normalize_key("AM-short").is_none());
        assert!(normalize_key("AM-0123456789ABCDEF0123456789ABCDEF012G").is_none());
    }

    #[test]
    fn verification_seam_stores_approved_license_and_preserves_settings() {
        let root = root("storage");
        fs::write(
            jobs::settings_path(&root),
            br#"{"downloadFolder":"C:\\Media"}"#,
        )
        .unwrap();
        let key = "AM-0123456789ABCDEF0123456789ABCDEF0123";
        let approved = verify_in_with(key, &root, |normalized, device| {
            assert_eq!(normalized, key);
            assert!(device.starts_with("segma-app-"));
            Ok(LicenseVerificationResponse {
                ok: true,
                edition: Some("pro".into()),
                status: Some("approved".into()),
                devices: Some(1),
                limit: Some(3),
                ..Default::default()
            })
        })
        .unwrap();
        save_approved_in(&root, &approved).unwrap();
        assert!(load_in(&root).pro);
        assert_eq!(read_document(&root)["downloadFolder"], "C:\\Media");
        remove_in(&root).unwrap();
        assert!(!load_in(&root).pro);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pending_response_does_not_unlock_pro() {
        let root = root("pending");
        let result = verify_in_with("AM-0123456789ABCDEF0123456789ABCDEF0123", &root, |_, _| {
            Ok(LicenseVerificationResponse {
                ok: true,
                status: Some("pending".into()),
                ..Default::default()
            })
        });
        assert_eq!(result, Err(LicenseError::Pending));
        fs::remove_dir_all(root).unwrap();
    }
}
