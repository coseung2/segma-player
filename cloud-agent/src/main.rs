mod mock;

use aura_companion_contract as contract;
use contract::cloud::{
    self, CloudJobRequest, CloudJobState, CloudProvider, CLOUD_JOB_CAPABILITY,
    CLOUD_JOB_SCHEMA_VERSION,
};
use serde_json::json;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn main() {
    if let Err(error) = run(env::args().skip(1).collect()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run(arguments: Vec<String>) -> io::Result<()> {
    match arguments.as_slice() {
        [flag] if flag == "--status" => {
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "protocol": CLOUD_JOB_SCHEMA_VERSION,
                    "capabilities": [CLOUD_JOB_CAPABILITY, "mock-blob-v1"],
                    "providers": {
                        "mock": true,
                        "telegram": false
                    }
                }))
                .map_err(io::Error::other)?
            );
            Ok(())
        }
        [flag, job_id] if flag == "--run-job" => run_job(job_id),
        [flag, request_path] if flag == "--submit" => submit_request(Path::new(request_path)),
        [flag] if flag == "--help" || flag == "-h" => {
            print_help();
            Ok(())
        }
        [] => {
            print_help();
            Ok(())
        }
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: aura-media-cloud --status | --submit <request.json> | --run-job <job-id>",
        )),
    }
}

fn print_help() {
    println!("Segma Player cloud agent");
    println!("  --status                Show protocol and provider capabilities");
    println!("  --submit <request.json> Persist and execute one cloud request");
    println!("  --run-job <job-id>      Execute an already persisted cloud request");
}

fn submit_request(path: &Path) -> io::Result<()> {
    let bytes = fs::read(path)?;
    let request: CloudJobRequest = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    cloud::validate_cloud_job_request(&request)?;
    let directory = cloud::cloud_jobs_dir()?;
    let persisted = cloud::cloud_request_path_in(&directory, &request.job_id)?;
    if persisted.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "cloud job id already exists",
        ));
    }
    cloud::write_cloud_request_in(&directory, &request)?;
    let state = CloudJobState::queued(&request, now_millis());
    cloud::write_cloud_state_in(&directory, &state)?;
    run_job(&request.job_id)
}

fn run_job(job_id: &str) -> io::Result<()> {
    run_job_in(&contract::companion_root()?, job_id)
}

struct RunnerClaim {
    path: PathBuf,
}

impl Drop for RunnerClaim {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn claim_runner(directory: &Path, job_id: &str) -> io::Result<RunnerClaim> {
    fs::create_dir_all(directory)?;
    let path = cloud::cloud_runner_claim_path_in(directory, job_id)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                io::Error::new(io::ErrorKind::AlreadyExists, "cloud job already has a runner")
            } else {
                error
            }
        })?;
    write!(file, "{}", std::process::id())?;
    file.sync_all()?;
    Ok(RunnerClaim { path })
}

fn run_job_in(root: &Path, job_id: &str) -> io::Result<()> {
    let directory = root.join("cloud-jobs");
    let _claim = claim_runner(&directory, job_id)?;
    let request = cloud::read_cloud_request_in(&directory, job_id)?;
    let now = now_millis();
    let mut state = CloudJobState::queued(&request, now);
    state.status = "running".into();
    state.phase = Some("starting".into());
    state.updated_at = now;
    cloud::write_cloud_state_in(&directory, &state)?;

    let execution = match request.provider {
        CloudProvider::Mock => mock::execute(root, &request, &mut state, |state| {
            cloud::write_cloud_state_in(&directory, state).map(|_| ())
        }),
        CloudProvider::Telegram => Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Telegram provider is not wired in this foundation build",
        )),
    };

    if let Ok(cancel_path) = cloud::cloud_cancel_path_in(&directory, job_id) {
        let _ = fs::remove_file(cancel_path);
    }

    match execution {
        Ok(()) => {
            state.status = "completed".into();
            state.phase = Some("completed".into());
            state.progress = Some(100);
            state.error = None;
            state.updated_at = now_millis();
            cloud::write_cloud_state_in(&directory, &state)?;
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::Interrupted => {
            state.status = "cancelled".into();
            state.phase = Some("cancelled".into());
            state.error = None;
            state.updated_at = now_millis();
            cloud::write_cloud_state_in(&directory, &state)?;
            Ok(())
        }
        Err(error) => {
            state.status = "failed".into();
            state.phase = Some("failed".into());
            state.error = Some(error.to_string());
            state.updated_at = now_millis();
            let _ = cloud::write_cloud_state_in(&directory, &state);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use contract::cloud::{CloudOperation, CloudProvider};

    fn temp_root(label: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "segma-cloud-agent-{label}-{}-{}",
            std::process::id(),
            now_millis()
        ))
    }

    fn local_test_path() -> String {
        if cfg!(windows) {
            r"C:\Temp\clip.mp4".to_string()
        } else {
            "/tmp/clip.mp4".to_string()
        }
    }

    #[test]
    fn unsupported_telegram_provider_fails_closed_and_persists_failure() {
        let root = temp_root("telegram");
        let directory = root.join("cloud-jobs");
        fs::create_dir_all(&directory).expect("cloud jobs directory creates");
        let request = CloudJobRequest {
            schema_version: CLOUD_JOB_SCHEMA_VERSION,
            job_id: "telegram-job".into(),
            provider: CloudProvider::Telegram,
            operation: CloudOperation::Upload,
            item_id: "item-1".into(),
            local_path: Some(local_test_path()),
            ..CloudJobRequest::default()
        };
        cloud::write_cloud_request_in(&directory, &request).expect("request writes");
        assert!(run_job_in(&root, &request.job_id).is_err());
        let states = cloud::list_cloud_job_states_in(&directory).expect("states list");
        assert_eq!(states.len(), 1);
        assert_eq!(states[0].status, "failed");
        assert!(states[0]
            .error
            .as_deref()
            .is_some_and(|value| value.contains("not wired")));
        assert!(!cloud::cloud_runner_claim_path_in(&directory, &request.job_id)
            .unwrap()
            .exists());
        fs::remove_dir_all(root).expect("test root removes");
    }

    #[test]
    fn runner_claim_rejects_concurrent_execution() {
        let root = temp_root("claim");
        let directory = root.join("cloud-jobs");
        let first = claim_runner(&directory, "job-1").expect("first claim succeeds");
        let second = claim_runner(&directory, "job-1").expect_err("second claim is rejected");
        assert_eq!(second.kind(), io::ErrorKind::AlreadyExists);
        drop(first);
        assert!(claim_runner(&directory, "job-1").is_ok());
        fs::remove_dir_all(root).expect("test root removes");
    }
}
