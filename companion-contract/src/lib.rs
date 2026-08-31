//! Stable disk ABI shared by the native host and manager.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub const MAX_JOB_STATES: usize = 100;
pub const MAX_SETTINGS_BYTES: usize = 16 * 1024;
static NEXT_ATOMIC_FILE_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct JobState {
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "jobType", skip_serializing_if = "Option::is_none")]
    pub job_type: Option<String>,
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(rename = "candidateId", skip_serializing_if = "Option::is_none")]
    pub candidate_id: Option<String>,
    #[serde(rename = "sourceLanguage", skip_serializing_if = "Option::is_none")]
    pub source_language: Option<String>,
    #[serde(rename = "targetLanguage", skip_serializing_if = "Option::is_none")]
    pub target_language: Option<String>,
    #[serde(rename = "inputKind", skip_serializing_if = "Option::is_none")]
    pub input_kind: Option<String>,
    #[serde(rename = "outputFormat", skip_serializing_if = "Option::is_none")]
    pub output_format: Option<String>,
    #[serde(rename = "executionStatus", skip_serializing_if = "Option::is_none")]
    pub execution_status: Option<String>,
    #[serde(rename = "tabId", skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<u32>,
    #[serde(rename = "frameId", skip_serializing_if = "Option::is_none")]
    pub frame_id: Option<u32>,
    #[serde(rename = "remoteJobId", skip_serializing_if = "Option::is_none")]
    pub remote_job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(rename = "statusText", default)]
    pub status_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
    #[serde(rename = "fileName", skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(rename = "createdAt", default)]
    pub created_at: u64,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: u64,
}

pub fn companion_root() -> io::Result<PathBuf> {
    if let Some(local) = env::var_os("LOCALAPPDATA") {
        return Ok(PathBuf::from(local).join("Aura Media").join("Companion"));
    }
    let executable = env::current_exe()?;
    Ok(executable.parent().unwrap_or(Path::new(".")).to_path_buf())
}

pub fn jobs_dir() -> io::Result<PathBuf> {
    Ok(companion_root()?.join("jobs"))
}

pub fn settings_path(root: &Path) -> PathBuf {
    root.join("settings.json")
}

fn settings_lock_path(root: &Path) -> PathBuf {
    root.join("settings.lock")
}

fn unique_temporary_path(path: &Path) -> PathBuf {
    PathBuf::from(format!(
        "{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        NEXT_ATOMIC_FILE_ID.fetch_add(1, Ordering::Relaxed)
    ))
}

fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temporary = unique_temporary_path(path);
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

#[cfg(target_os = "windows")]
fn replace_file_atomic(temporary: &Path, path: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }

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
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn replace_file_atomic(temporary: &Path, path: &Path) -> io::Result<()> {
    fs::rename(temporary, path)
}

struct SettingsLock {
    file: File,
}

impl Drop for SettingsLock {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.file);
    }
}

fn lock_settings(root: &Path) -> io::Result<SettingsLock> {
    fs::create_dir_all(root)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(settings_lock_path(root))?;
    fs2::FileExt::lock_exclusive(&file)?;
    Ok(SettingsLock { file })
}

pub fn read_settings_document(root: &Path) -> serde_json::Value {
    match fs::read(settings_path(root)) {
        Ok(bytes) if bytes.len() <= MAX_SETTINGS_BYTES => {
            serde_json::from_slice(&bytes).unwrap_or_else(|_| serde_json::json!({}))
        }
        _ => serde_json::json!({}),
    }
}

pub fn update_settings_document<F>(root: &Path, update: F) -> io::Result<serde_json::Value>
where
    F: FnOnce(&mut serde_json::Value) -> io::Result<()>,
{
    let _lock = lock_settings(root)?;
    let mut document = read_settings_document(root);
    if !document.is_object() {
        document = serde_json::json!({});
    }
    update(&mut document)?;
    let bytes = serde_json::to_vec_pretty(&document).map_err(io::Error::other)?;
    if bytes.len() > MAX_SETTINGS_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "settings document is too large",
        ));
    }
    write_bytes_atomic(&settings_path(root), &bytes)?;
    Ok(document)
}

pub fn valid_download_folder(value: &str) -> Option<PathBuf> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 32_767 || trimmed.chars().any(char::is_control) {
        return None;
    }
    let path = Path::new(trimmed);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return None;
    }
    Some(path.to_path_buf())
}

pub fn safe_id(value: &str) -> Option<String> {
    if value.is_empty() || value.len() > 128 {
        return None;
    }
    value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .then(|| value.to_string())
}

fn path_for(directory: &Path, job_id: &str, suffix: &str) -> io::Result<PathBuf> {
    let safe = safe_id(job_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid job id"))?;
    Ok(directory.join(format!("{safe}{suffix}")))
}

pub fn request_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    path_for(directory, job_id, ".request.json")
}

pub fn state_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    path_for(directory, job_id, ".state.json")
}

pub fn cancel_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    path_for(directory, job_id, ".cancel")
}

pub fn pause_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    path_for(directory, job_id, ".pause")
}

pub fn runner_claim_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    path_for(directory, job_id, ".runner.lock")
}

pub fn subtitle_request_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    path_for(directory, job_id, ".subtitle.request.json")
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn list_states_in<T, F>(directory: &Path, updated_at: F) -> io::Result<Vec<T>>
where
    T: DeserializeOwned,
    F: Fn(&T) -> u64,
{
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
        if name.ends_with(".state.json") {
            if let Some(state) = read_json(&path) {
                states.push(state);
            }
        }
    }
    states.sort_by_key(|right| std::cmp::Reverse(updated_at(right)));
    states.truncate(MAX_JOB_STATES);
    Ok(states)
}

pub fn list_job_states_in(directory: &Path) -> io::Result<Vec<JobState>> {
    let mut states = list_states_in(directory, |state: &JobState| state.updated_at)?;
    states.retain(|state| !state.job_id.is_empty());
    Ok(states)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn shared_fixtures_cover_forward_and_legacy_compatibility() {
        let current: JobState = serde_json::from_str(include_str!(
            "../../test-fixtures/companion/job-state-v1.json"
        ))
        .expect("current fixture loads");
        let legacy: JobState = serde_json::from_str(include_str!(
            "../../test-fixtures/companion/job-state-legacy-v1.json"
        ))
        .expect("legacy fixture loads");
        assert_eq!(current.execution_status.as_deref(), Some("running"));
        assert_eq!(legacy.created_at, 0);
    }

    #[test]
    fn disk_abi_fixture_matches_every_path() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../test-fixtures/companion/disk-abi-v1.json"
        ))
        .expect("fixture parses");
        let directory = Path::new("jobs");
        let job_id = fixture["jobId"].as_str().expect("job id exists");
        for (key, path) in [
            ("request", request_path_in(directory, job_id).unwrap()),
            ("state", state_path_in(directory, job_id).unwrap()),
            ("cancel", cancel_path_in(directory, job_id).unwrap()),
            ("pause", pause_path_in(directory, job_id).unwrap()),
            (
                "subtitleRequest",
                subtitle_request_path_in(directory, job_id).unwrap(),
            ),
        ] {
            assert_eq!(
                path.file_name().and_then(|value| value.to_str()),
                fixture[key].as_str()
            );
        }
        assert_eq!(
            settings_path(directory)
                .file_name()
                .and_then(|value| value.to_str()),
            fixture["settings"].as_str()
        );
    }

    #[test]
    fn settings_updates_merge_from_the_latest_document_and_preserve_fields() {
        let root = env::temp_dir().join(format!(
            "segma-settings-contract-{}-{}",
            std::process::id(),
            NEXT_ATOMIC_FILE_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("settings root creates");
        update_settings_document(&root, |document| {
            document["licenseKey"] = serde_json::json!("keep");
            Ok(())
        })
        .expect("license field writes");
        update_settings_document(&root, |document| {
            document["downloadFolder"] = serde_json::json!("C:\\Media");
            Ok(())
        })
        .expect("folder field writes");
        assert_eq!(
            read_settings_document(&root),
            serde_json::json!({
                "licenseKey": "keep",
                "downloadFolder": "C:\\Media"
            })
        );
        fs::remove_dir_all(root).expect("settings root removes");
    }
}
