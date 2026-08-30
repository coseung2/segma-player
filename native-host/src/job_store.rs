use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;

static NEXT_ATOMIC_FILE_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Deserialize, Serialize)]
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
    pub status: String,
    #[serde(rename = "statusText")]
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
    #[serde(rename = "updatedAt")]
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
    let path = companion_root()?.join("jobs");
    fs::create_dir_all(&path)?;
    Ok(path)
}

pub fn settings_path(root: &Path) -> PathBuf {
    root.join("settings.json")
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

pub fn subtitle_request_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    path_for(directory, job_id, ".subtitle.request.json")
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

pub fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temporary = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        NEXT_ATOMIC_FILE_ID.fetch_add(1, Ordering::Relaxed)
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

pub fn write_json_atomic(path: &Path, value: &impl Serialize) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    write_bytes_atomic(path, &bytes)
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
    states.truncate(100);
    Ok(states)
}

pub fn list_job_states_in(directory: &Path) -> io::Result<Vec<JobState>> {
    list_states_in(directory, |state: &JobState| state.updated_at)
}

pub fn persist_job_state_in(
    directory: &Path,
    state: &mut JobState,
    updated_at: u64,
) -> io::Result<()> {
    fs::create_dir_all(directory)?;
    state.updated_at = updated_at;
    write_json_atomic(&state_path_in(directory, &state.job_id)?, state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn test_directory() -> PathBuf {
        let directory = env::temp_dir().join(format!(
            "segma-job-store-test-{}-{}",
            std::process::id(),
            NEXT_ATOMIC_FILE_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&directory).expect("directory creates");
        directory
    }

    #[test]
    fn shared_disk_abi_fixture_matches_all_paths() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../test-fixtures/companion/disk-abi-v1.json"
        ))
        .expect("fixture parses");
        let directory = test_directory();
        let job_id = fixture["jobId"].as_str().expect("job id exists");
        for (key, path) in [
            ("request", request_path_in(&directory, job_id).unwrap()),
            ("state", state_path_in(&directory, job_id).unwrap()),
            ("cancel", cancel_path_in(&directory, job_id).unwrap()),
            ("pause", pause_path_in(&directory, job_id).unwrap()),
            (
                "subtitleRequest",
                subtitle_request_path_in(&directory, job_id).unwrap(),
            ),
        ] {
            assert_eq!(
                path.file_name().and_then(|value| value.to_str()),
                fixture[key].as_str()
            );
        }
        assert_eq!(
            settings_path(&directory)
                .file_name()
                .and_then(|value| value.to_str()),
            fixture["settings"].as_str()
        );
        fs::remove_dir_all(directory).expect("directory removes");
    }

    #[test]
    fn atomic_json_round_trips() {
        let directory = test_directory();
        let path = directory.join("state.json");
        write_json_atomic(&path, &json!({ "ok": true })).expect("JSON writes");
        assert_eq!(read_json::<Value>(&path), Some(json!({ "ok": true })));
        fs::remove_dir_all(directory).expect("directory removes");
    }

    #[test]
    fn unsafe_ids_and_folders_fail_closed() {
        let directory = test_directory();
        for id in ["", "../escape", "a/b", "a\\b"] {
            assert!(state_path_in(&directory, id).is_err());
        }
        assert!(valid_download_folder("relative\\path").is_none());
        assert!(valid_download_folder("C:\\Media\\..\\Windows").is_none());
        fs::remove_dir_all(directory).expect("directory removes");
    }
}
