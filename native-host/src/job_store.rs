use aura_companion_contract as contract;
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;

static NEXT_ATOMIC_FILE_ID: AtomicU64 = AtomicU64::new(1);

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
}
