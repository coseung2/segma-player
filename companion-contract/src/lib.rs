//! Stable disk ABI shared by the native host and manager.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const MAX_JOB_STATES: usize = 100;

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
}
