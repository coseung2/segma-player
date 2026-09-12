use serde::{Deserialize, Serialize};
use std::fs;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub const CLOUD_JOB_SCHEMA_VERSION: u32 = 1;
pub const CLOUD_JOB_CAPABILITY: &str = "cloud-job-v1";
static NEXT_CLOUD_RUNNER_TOKEN_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloudProvider {
    #[default]
    Mock,
    Telegram,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloudOperation {
    #[default]
    Upload,
    Download,
    Delete,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct CloudJobRequest {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub provider: CloudProvider,
    pub operation: CloudOperation,
    #[serde(rename = "itemId")]
    pub item_id: String,
    #[serde(rename = "folderId", skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    #[serde(rename = "localPath", skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
    #[serde(rename = "fileName", skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(rename = "createdAt", default)]
    pub created_at: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct CloudJobState {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub provider: CloudProvider,
    pub operation: CloudOperation,
    #[serde(rename = "itemId")]
    pub item_id: String,
    #[serde(default)]
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
    #[serde(rename = "fileName", skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(rename = "createdAt", default)]
    pub created_at: u64,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: u64,
}

impl CloudJobState {
    pub fn queued(request: &CloudJobRequest, now: u64) -> Self {
        Self {
            schema_version: CLOUD_JOB_SCHEMA_VERSION,
            job_id: request.job_id.clone(),
            provider: request.provider,
            operation: request.operation,
            item_id: request.item_id.clone(),
            status: "queued".into(),
            phase: Some("queued".into()),
            file_name: request.file_name.clone().or_else(|| {
                request
                    .local_path
                    .as_deref()
                    .and_then(|value| Path::new(value).file_name())
                    .and_then(|value| value.to_str())
                    .map(str::to_owned)
            }),
            created_at: if request.created_at == 0 {
                now
            } else {
                request.created_at
            },
            updated_at: now,
            ..Self::default()
        }
    }
}

pub fn cloud_jobs_dir() -> io::Result<PathBuf> {
    Ok(super::companion_root()?.join("cloud-jobs"))
}

pub fn cloud_request_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    super::request_path_in(directory, job_id)
}

pub fn cloud_state_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    super::state_path_in(directory, job_id)
}

pub fn cloud_cancel_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    super::cancel_path_in(directory, job_id)
}

pub fn cloud_runner_claim_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    super::runner_claim_path_in(directory, job_id)
}

#[derive(Debug)]
pub struct CloudRunnerClaim {
    path: Option<PathBuf>,
    token: String,
}

impl Drop for CloudRunnerClaim {
    fn drop(&mut self) {
        if let Some(path) = &self.path {
            let _ = fs::remove_file(path);
        }
    }
}

impl CloudRunnerClaim {
    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn handoff(mut self) {
        self.path.take();
    }
}

fn cloud_runner_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{:x}-{:x}-{:x}",
        std::process::id(),
        nanos,
        NEXT_CLOUD_RUNNER_TOKEN_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn valid_cloud_runner_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

pub fn reserve_cloud_runner_claim_in(
    directory: &Path,
    job_id: &str,
) -> io::Result<CloudRunnerClaim> {
    fs::create_dir_all(directory)?;
    let path = cloud_runner_claim_path_in(directory, job_id)?;
    let token = cloud_runner_token();
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                io::Error::new(io::ErrorKind::AlreadyExists, "job-already-running")
            } else {
                error
            }
        })?;
    if let Err(error) = writeln!(file, "{token}").and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    Ok(CloudRunnerClaim {
        path: Some(path),
        token,
    })
}

pub fn adopt_cloud_runner_claim_in(
    directory: &Path,
    job_id: &str,
    expected_token: &str,
) -> io::Result<CloudRunnerClaim> {
    if !valid_cloud_runner_token(expected_token) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid-runner-token",
        ));
    }
    let path = cloud_runner_claim_path_in(directory, job_id)?;
    let bytes = fs::read(&path)?;
    if bytes.len() > 256 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "runner-token-too-large",
        ));
    }
    let actual = std::str::from_utf8(&bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid-runner-token"))?
        .trim();
    if actual != expected_token {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "job-runner-token-mismatch",
        ));
    }
    Ok(CloudRunnerClaim {
        path: Some(path),
        token: expected_token.to_string(),
    })
}

pub fn write_cloud_request_in(directory: &Path, request: &CloudJobRequest) -> io::Result<PathBuf> {
    validate_cloud_job_request(request)?;
    fs::create_dir_all(directory)?;
    let path = cloud_request_path_in(directory, &request.job_id)?;
    let bytes = serde_json::to_vec_pretty(request).map_err(io::Error::other)?;
    super::write_bytes_atomic(&path, &bytes)?;
    Ok(path)
}

pub fn write_cloud_state_in(directory: &Path, state: &CloudJobState) -> io::Result<PathBuf> {
    if state.schema_version != CLOUD_JOB_SCHEMA_VERSION || super::safe_id(&state.job_id).is_none() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid cloud job state",
        ));
    }
    fs::create_dir_all(directory)?;
    let path = cloud_state_path_in(directory, &state.job_id)?;
    let bytes = serde_json::to_vec_pretty(state).map_err(io::Error::other)?;
    super::write_bytes_atomic(&path, &bytes)?;
    Ok(path)
}

pub fn read_cloud_request_in(directory: &Path, job_id: &str) -> io::Result<CloudJobRequest> {
    let path = cloud_request_path_in(directory, job_id)?;
    let request = super::read_json::<CloudJobRequest>(&path)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid cloud job request"))?;
    validate_cloud_job_request(&request)?;
    Ok(request)
}

pub fn list_cloud_job_states_in(directory: &Path) -> io::Result<Vec<CloudJobState>> {
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut states = super::list_states_in(directory, |state: &CloudJobState| state.updated_at)?;
    states.retain(|state| {
        state.schema_version == CLOUD_JOB_SCHEMA_VERSION && super::safe_id(&state.job_id).is_some()
    });
    Ok(states)
}

pub fn validate_cloud_job_request(request: &CloudJobRequest) -> io::Result<()> {
    if request.schema_version != CLOUD_JOB_SCHEMA_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "unsupported cloud job schema",
        ));
    }
    if super::safe_id(&request.job_id).is_none() || super::safe_id(&request.item_id).is_none() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid cloud job or item id",
        ));
    }
    if request
        .folder_id
        .as_deref()
        .is_some_and(|value| super::safe_id(value).is_none())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid cloud folder id",
        ));
    }

    let path_required = matches!(
        request.operation,
        CloudOperation::Upload | CloudOperation::Download
    );
    if path_required {
        let value = request.local_path.as_deref().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "cloud job requires localPath")
        })?;
        if super::valid_download_folder(value).is_none() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid cloud localPath",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn request(operation: CloudOperation) -> CloudJobRequest {
        CloudJobRequest {
            schema_version: CLOUD_JOB_SCHEMA_VERSION,
            job_id: "job-1".into(),
            provider: CloudProvider::Mock,
            operation,
            item_id: "item-1".into(),
            folder_id: Some("folder-1".into()),
            local_path: Some(if cfg!(windows) {
                r"C:\Media\clip.mp4".into()
            } else {
                "/tmp/clip.mp4".into()
            }),
            file_name: Some("clip.mp4".into()),
            created_at: 10,
        }
    }

    fn temp_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        env::temp_dir().join(format!(
            "segma-cloud-contract-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn request_round_trip_and_paths_are_stable() {
        let directory = temp_dir();
        let request = request(CloudOperation::Upload);
        let path = write_cloud_request_in(&directory, &request).expect("request writes");
        assert_eq!(
            path.file_name().and_then(|value| value.to_str()),
            Some("job-1.request.json")
        );
        assert_eq!(read_cloud_request_in(&directory, "job-1").unwrap(), request);
        assert_eq!(
            cloud_state_path_in(&directory, "job-1")
                .unwrap()
                .file_name()
                .and_then(|value| value.to_str()),
            Some("job-1.state.json")
        );
        fs::remove_dir_all(directory).expect("test directory removes");
    }

    #[test]
    fn validation_rejects_unknown_schema_and_traversal() {
        let mut bad_schema = request(CloudOperation::Upload);
        bad_schema.schema_version = 99;
        assert!(validate_cloud_job_request(&bad_schema).is_err());

        let mut traversal = request(CloudOperation::Upload);
        traversal.local_path = Some(if cfg!(windows) {
            r"C:\Media\..\secret.mp4".into()
        } else {
            "/tmp/../secret.mp4".into()
        });
        assert!(validate_cloud_job_request(&traversal).is_err());
    }

    #[test]
    fn delete_does_not_require_a_local_path() {
        let mut delete = request(CloudOperation::Delete);
        delete.local_path = None;
        assert!(validate_cloud_job_request(&delete).is_ok());
    }

    #[test]
    fn state_write_and_listing_keep_valid_entries() {
        let directory = temp_dir();
        let request = request(CloudOperation::Upload);
        let mut state = CloudJobState::queued(&request, 20);
        state.status = "running".into();
        state.updated_at = 21;
        write_cloud_state_in(&directory, &state).expect("state writes");
        assert_eq!(list_cloud_job_states_in(&directory).unwrap(), vec![state]);
        fs::remove_dir_all(directory).expect("test directory removes");
    }

    #[test]
    fn runner_claim_requires_the_reserved_token_and_blocks_concurrency() {
        let directory = temp_dir();
        let reservation =
            reserve_cloud_runner_claim_in(&directory, "job-1").expect("claim reserves");
        let token = reservation.token().to_string();
        assert_eq!(
            reserve_cloud_runner_claim_in(&directory, "job-1")
                .expect_err("concurrent claim rejects")
                .kind(),
            io::ErrorKind::AlreadyExists
        );
        reservation.handoff();
        assert_eq!(
            adopt_cloud_runner_claim_in(&directory, "job-1", "wrong-token")
                .expect_err("wrong token rejects")
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        let adopted = adopt_cloud_runner_claim_in(&directory, "job-1", &token)
            .expect("reserved token adopts");
        drop(adopted);
        assert!(!cloud_runner_claim_path_in(&directory, "job-1")
            .unwrap()
            .exists());
        fs::remove_dir_all(directory).expect("test directory removes");
    }
}
