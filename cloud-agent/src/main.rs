mod mock;

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
    cloud::write_cloud_request_in(&directory, &request)?;
    let state = CloudJobState::queued(&request, now_millis());
    cloud::write_cloud_state_in(&directory, &state)?;
    run_job(&request.job_id)
}

fn run_job(job_id: &str) -> io::Result<()> {
    run_job_in(&contract::companion_root()?, job_id)
}

fn run_job_in(root: &Path, job_id: &str) -> io::Result<()> {
    let directory = root.join("cloud-jobs");
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

    #[test]
    fn unsupported_telegram_provider_fails_closed_and_persists_failure() {
        let root = temp_root("telegram");
        let directory = root.join("cloud-jobs");
        fs::create_dir_all(&directory).expect("cloud jobs directory creates");
        let local_path = if cfg!(windows) {
            r"C:\\Temp\\clip.mp4".to_string()
        } else {
            "/tmp/clip.mp4".to_string()
        };
        let request = CloudJobRequest {
            schema_version: CLOUD_JOB_SCHEMA_VERSION,
            job_id: "telegram-job".into(),
            provider: CloudProvider::Telegram,
            operation: CloudOperation::Upload,
            item_id: "item-1".into(),
            local_path: Some(local_path),
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
        fs::remove_dir_all(root).expect("test root removes");
    }
}
