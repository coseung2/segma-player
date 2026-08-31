use aura_companion_contract as contract;
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;

static NEXT_ATOMIC_FILE_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_RUNNER_TOKEN_ID: AtomicU64 = AtomicU64::new(1);

pub use contract::JobState;

pub fn companion_root() -> io::Result<PathBuf> {
    contract::companion_root()
}

pub fn jobs_dir() -> io::Result<PathBuf> {
    let path = contract::jobs_dir()?;
    fs::create_dir_all(&path)?;
    Ok(path)
}

pub fn settings_path(root: &Path) -> PathBuf {
    contract::settings_path(root)
}

pub fn valid_download_folder(value: &str) -> Option<PathBuf> {
    contract::valid_download_folder(value)
}

pub fn safe_id(value: &str) -> Option<String> {
    contract::safe_id(value)
}

pub fn request_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    contract::request_path_in(directory, job_id)
}

pub fn state_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    contract::state_path_in(directory, job_id)
}

pub fn cancel_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    contract::cancel_path_in(directory, job_id)
}

pub fn pause_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    contract::pause_path_in(directory, job_id)
}

pub fn runner_claim_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    contract::runner_claim_path_in(directory, job_id)
}

pub fn subtitle_request_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    contract::subtitle_request_path_in(directory, job_id)
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

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    contract::read_json(path)
}

pub fn list_job_states_in(directory: &Path) -> io::Result<Vec<JobState>> {
    contract::list_job_states_in(directory)
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

pub struct RunnerClaim {
    path: Option<PathBuf>,
    token: String,
}

impl Drop for RunnerClaim {
    fn drop(&mut self) {
        if let Some(path) = &self.path {
            let _ = fs::remove_file(path);
        }
    }
}

impl RunnerClaim {
    pub fn token(&self) -> &str {
        &self.token
    }

    /// Leaves the on-disk reservation for the spawned child to adopt.
    pub fn handoff(mut self) {
        self.path.take();
    }
}

fn runner_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{:x}-{:x}-{:x}",
        std::process::id(),
        nanos,
        NEXT_RUNNER_TOKEN_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn valid_runner_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

pub fn reserve_runner_claim_in(directory: &Path, job_id: &str) -> io::Result<RunnerClaim> {
    fs::create_dir_all(directory)?;
    let path = runner_claim_path_in(directory, job_id)?;
    let token = runner_token();
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
    Ok(RunnerClaim {
        path: Some(path),
        token,
    })
}

pub fn acquire_runner_claim_in(directory: &Path, job_id: &str) -> io::Result<RunnerClaim> {
    reserve_runner_claim_in(directory, job_id)
}

pub fn adopt_runner_claim_in(
    directory: &Path,
    job_id: &str,
    expected_token: &str,
) -> io::Result<RunnerClaim> {
    if !valid_runner_token(expected_token) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid-runner-token",
        ));
    }
    let path = runner_claim_path_in(directory, job_id)?;
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
    Ok(RunnerClaim {
        path: Some(path),
        token: expected_token.to_string(),
    })
}

pub fn clear_terminal_history_in(directory: &Path) -> io::Result<usize> {
    if !directory.is_dir() {
        return Ok(0);
    }
    let mut terminal = Vec::new();
    for state in list_job_states_in(directory)? {
        if matches!(
            state.status.to_ascii_lowercase().as_str(),
            "completed" | "failed" | "cancelled"
        ) && !runner_claim_path_in(directory, &state.job_id)?.exists()
        {
            terminal.push(state.job_id);
        }
    }

    for job_id in &terminal {
        for path in [
            state_path_in(directory, job_id)?,
            request_path_in(directory, job_id)?,
            cancel_path_in(directory, job_id)?,
            pause_path_in(directory, job_id)?,
            runner_claim_path_in(directory, job_id)?,
            subtitle_request_path_in(directory, job_id)?,
        ] {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
    }
    Ok(terminal.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::env;

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
    fn host_and_manager_share_the_same_job_state_type_contract() {
        let current: JobState = serde_json::from_str(include_str!(
            "../../test-fixtures/companion/job-state-v1.json"
        ))
        .expect("current state fixture loads");
        let legacy: JobState = serde_json::from_str(include_str!(
            "../../test-fixtures/companion/job-state-legacy-v1.json"
        ))
        .expect("legacy state fixture loads");
        assert_eq!(current.execution_status.as_deref(), Some("running"));
        assert_eq!(legacy.created_at, 0);
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

    #[test]
    fn runner_reservation_is_single_flight_and_can_be_reacquired_after_drop() {
        let directory = test_directory();
        let first = reserve_runner_claim_in(&directory, "job-one").expect("first claim reserves");
        let error = reserve_runner_claim_in(&directory, "job-one")
            .err()
            .expect("second claim rejects");
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(error.to_string(), "job-already-running");
        drop(first);
        let second = reserve_runner_claim_in(&directory, "job-one").expect("claim reacquires");
        drop(second);
        fs::remove_dir_all(directory).expect("directory removes");
    }

    #[test]
    fn child_adopts_only_the_reserved_runner_token() {
        let directory = test_directory();
        let reservation = reserve_runner_claim_in(&directory, "job-one").expect("claim reserves");
        let token = reservation.token().to_string();
        reservation.handoff();

        let mismatch = adopt_runner_claim_in(&directory, "job-one", "wrong-token")
            .err()
            .expect("wrong token rejects");
        assert_eq!(mismatch.kind(), io::ErrorKind::PermissionDenied);
        assert!(runner_claim_path_in(&directory, "job-one")
            .unwrap()
            .is_file());

        let adopted = adopt_runner_claim_in(&directory, "job-one", &token).expect("token adopts");
        drop(adopted);
        assert!(!runner_claim_path_in(&directory, "job-one")
            .unwrap()
            .exists());
        fs::remove_dir_all(directory).expect("directory removes");
    }

    #[test]
    fn terminal_history_removes_all_artifacts_but_preserves_active_and_claimed_jobs() {
        let directory = test_directory();
        for (job_id, status) in [
            ("done", "completed"),
            ("failed", "failed"),
            ("cancelled", "cancelled"),
            ("active", "running"),
            ("claimed", "failed"),
        ] {
            let state = JobState {
                job_id: job_id.into(),
                status: status.into(),
                updated_at: 1,
                ..JobState::default()
            };
            write_json_atomic(&state_path_in(&directory, job_id).unwrap(), &state).unwrap();
            for path in [
                request_path_in(&directory, job_id).unwrap(),
                cancel_path_in(&directory, job_id).unwrap(),
                pause_path_in(&directory, job_id).unwrap(),
                subtitle_request_path_in(&directory, job_id).unwrap(),
            ] {
                fs::write(path, b"artifact").expect("artifact writes");
            }
        }
        let claimed = reserve_runner_claim_in(&directory, "claimed").expect("claim reserves");

        assert_eq!(
            clear_terminal_history_in(&directory).expect("history clears"),
            3
        );
        for job_id in ["done", "failed", "cancelled"] {
            for path in [
                state_path_in(&directory, job_id).unwrap(),
                request_path_in(&directory, job_id).unwrap(),
                cancel_path_in(&directory, job_id).unwrap(),
                pause_path_in(&directory, job_id).unwrap(),
                subtitle_request_path_in(&directory, job_id).unwrap(),
            ] {
                assert!(!path.exists(), "{} should be removed", path.display());
            }
        }
        for job_id in ["active", "claimed"] {
            assert!(state_path_in(&directory, job_id).unwrap().is_file());
            assert!(request_path_in(&directory, job_id).unwrap().is_file());
        }
        drop(claimed);
        fs::remove_dir_all(directory).expect("directory removes");
    }
}
