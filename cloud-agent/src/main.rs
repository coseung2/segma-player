mod mock;
mod telegram;
#[cfg(test)]
mod telegram_fixture;

use aura_companion_contract as contract;
use contract::cloud::{
    self, CloudJobRequest, CloudJobState, CloudProvider, CLOUD_JOB_CAPABILITY,
    CLOUD_JOB_SCHEMA_VERSION,
};
use serde_json::json;
use std::env;
use std::fs;
use std::io;
use std::path::Path;
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
            let telegram = contract::companion_root()
                .map(|root| telegram::protected_config_available(&root))
                .unwrap_or(false);
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "protocol": CLOUD_JOB_SCHEMA_VERSION,
                    "capabilities": [CLOUD_JOB_CAPABILITY, "mock-blob-v1"],
                    "providers": {
                        "mock": true,
                        "telegram": telegram
                    }
                }))
                .map_err(io::Error::other)?
            );
            Ok(())
        }
        [flag, job_id] if flag == "--run-job" => run_job(job_id, None),
        [flag, job_id, token_flag, token]
            if flag == "--run-job" && token_flag == "--claim-token" =>
        {
            run_job(job_id, Some(token))
        }
        [flag, request_path] if flag == "--submit" => submit_request(Path::new(request_path)),
        [flag] if flag == "--configure-telegram" => {
            let root = contract::companion_root()?;
            telegram::configure_from_reader(&root, &mut io::stdin().lock())
        }
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
            "usage: aura-media-cloud --status | --configure-telegram | --submit <request.json> | --run-job <job-id> [--claim-token <token>]",
        )),
    }
}

fn print_help() {
    println!("Segma Player cloud agent");
    println!("  --status                Show protocol and provider capabilities");
    println!("  --configure-telegram    Read token/channel JSON from stdin and protect it locally");
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
    run_job(&request.job_id, None)
}

fn run_job(job_id: &str, claim_token: Option<&str>) -> io::Result<()> {
    run_job_in(&contract::companion_root()?, job_id, claim_token)
}

fn run_job_in(root: &Path, job_id: &str, claim_token: Option<&str>) -> io::Result<()> {
    let directory = root.join("cloud-jobs");
    let _claim = match claim_token {
        Some(token) => cloud::adopt_cloud_runner_claim_in(&directory, job_id, token)?,
        None => cloud::reserve_cloud_runner_claim_in(&directory, job_id)?,
    };
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
        CloudProvider::Telegram => telegram::execute(root, &request, &mut state, |state| {
            cloud::write_cloud_state_in(&directory, state).map(|_| ())
        }),
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
    use std::path::PathBuf;

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
    fn telegram_without_protected_config_fails_closed_and_persists_sanitized_failure() {
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
        assert!(run_job_in(&root, &request.job_id, None).is_err());
        let states = cloud::list_cloud_job_states_in(&directory).expect("states list");
        assert_eq!(states.len(), 1);
        assert_eq!(states[0].status, "failed");
        assert!(states[0]
            .error
            .as_deref()
            .is_some_and(|value| !value.contains("token")));
        assert!(
            !cloud::cloud_runner_claim_path_in(&directory, &request.job_id)
                .unwrap()
                .exists()
        );
        fs::remove_dir_all(root).expect("test root removes");
    }

    #[test]
    fn runner_claim_rejects_concurrent_execution() {
        let root = temp_root("claim");
        let directory = root.join("cloud-jobs");
        let first = cloud::reserve_cloud_runner_claim_in(&directory, "job-1")
            .expect("first claim succeeds");
        let second = cloud::reserve_cloud_runner_claim_in(&directory, "job-1")
            .expect_err("second claim is rejected");
        assert_eq!(second.kind(), io::ErrorKind::AlreadyExists);
        drop(first);
        assert!(cloud::reserve_cloud_runner_claim_in(&directory, "job-1").is_ok());
        fs::remove_dir_all(root).expect("test root removes");
    }
}
