use crate::job_store::{self, JobState};
use crate::Request;
use serde_json::{json, Value};
use std::fs;
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

pub const OUTPUT_TEMPLATE: &str = "[%(height)sp] %(title).170B.%(ext)s";

pub fn command_tools(tools: &Path) -> io::Result<(PathBuf, PathBuf, PathBuf)> {
    let yt_dlp = tools.join("yt-dlp.exe");
    let node = tools.join("node.exe");
    let ffmpeg = tools.join("ffmpeg");
    if !yt_dlp.is_file() || !ffmpeg.join("ffmpeg.exe").is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "tools-not-installed",
        ));
    }
    Ok((yt_dlp, node, ffmpeg))
}

pub fn apply_hidden_process(command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
}

pub fn apply_runtime(command: &mut Command, node: &Path, ffmpeg: &Path) {
    command.arg("--ffmpeg-location").arg(ffmpeg);
    command.arg("--encoding").arg("utf-8");
    command
        .arg("--replace-in-metadata")
        .arg("title")
        .arg(r"\s*[/\\]\s*")
        .arg(" - ");
    command
        .arg("--retries")
        .arg("3")
        .arg("--fragment-retries")
        .arg("3")
        .arg("--extractor-retries")
        .arg("3")
        .arg("--retry-sleep")
        .arg("http:linear=1::2");
    if node.is_file() {
        command
            .arg("--js-runtimes")
            .arg(format!("node:{}", node.display()));
    }
}

pub fn info(url: &str, tools: (PathBuf, PathBuf, PathBuf)) -> Result<Value, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("invalid-youtube-url".into());
    }
    let (yt_dlp, node, ffmpeg) = tools;
    let mut command = Command::new(yt_dlp);
    command
        .arg("--dump-single-json")
        .arg("--skip-download")
        .arg("--no-playlist")
        .arg("--no-warnings");
    apply_runtime(&mut command, &node, &ffmpeg);
    command.arg(url);
    apply_hidden_process(&mut command);
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(detail.trim().chars().take(500).collect());
    }
    let parsed: Value =
        serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())?;
    let title = parsed
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let mut qualities = parsed
        .get("formats")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|format| format.get("height").and_then(Value::as_u64))
        .filter(|height| *height > 0 && *height <= 4320)
        .collect::<Vec<_>>();
    qualities.sort_unstable_by(|left, right| right.cmp(left));
    qualities.dedup();
    Ok(json!({ "title": title, "qualities": qualities }))
}

pub fn should_restart(error: &str, attempt: u8) -> bool {
    attempt < 2 && error.to_ascii_lowercase().contains("http error 403")
}

pub fn quality_height(value: &str) -> Option<u16> {
    match value {
        "4320" => Some(4320),
        "2160" => Some(2160),
        "1440" => Some(1440),
        "1080" => Some(1080),
        "720" => Some(720),
        "480" => Some(480),
        "360" => Some(360),
        "240" => Some(240),
        "144" => Some(144),
        "best" => None,
        _ => None,
    }
}

pub fn valid_quality(value: &str) -> bool {
    value == "best" || quality_height(value).is_some()
}

pub fn parse_progress(value: &str) -> Option<u8> {
    let token = value
        .split_whitespace()
        .find(|part| part.trim_end_matches('%').parse::<f32>().is_ok())?;
    let number = token.trim_end_matches('%').parse::<f32>().ok()?;
    Some(number.clamp(0.0, 100.0).round() as u8)
}

pub struct ExecutionContext<T, D, C, P> {
    pub tools: T,
    pub downloads: D,
    pub cancel_path: C,
    pub pause_path: P,
}

enum DownloadAttemptResult {
    Completed,
    Failed(String),
    SpawnError(String),
    StatusError(String),
    Cancelled,
    Paused,
}

fn update_state<F>(state: &mut JobState, notify: &F)
where
    F: Fn(&JobState),
{
    if let Ok(directory) = job_store::jobs_dir() {
        let _ = job_store::persist_job_state_in(directory.as_path(), state, crate::now_millis());
    }
    notify(state);
}

pub fn execute<F, T, D, C, P>(request: Request, context: ExecutionContext<T, D, C, P>, notify: F)
where
    F: Fn(&JobState),
    T: FnOnce() -> Result<(PathBuf, PathBuf, PathBuf), String>,
    D: FnOnce() -> Result<PathBuf, String>,
    C: FnOnce() -> Option<PathBuf>,
    P: FnOnce() -> Option<PathBuf>,
{
    let mut state = crate::initial_job_state(&request);
    state.status = "running".into();
    state.status_text = "YouTube 정보를 확인하는 중…".into();
    update_state(&mut state, &notify);

    if request.kind != "youtube-download"
        || job_store::safe_id(&request.job_id).is_none()
        || !(request.url.starts_with("https://") || request.url.starts_with("http://"))
        || !valid_quality(&request.quality)
    {
        state.status = "failed".into();
        state.status_text = "올바른 YouTube 요청이 아닙니다.".into();
        state.error = Some("invalid-request".into());
        update_state(&mut state, &notify);
        return;
    }

    let (yt_dlp, node, ffmpeg) = match (context.tools)() {
        Ok(tools) => tools,
        Err(error) => {
            state.status = "failed".into();
            state.status_text = "미디어 도구가 설치되지 않았습니다.".into();
            state.error = Some(error);
            update_state(&mut state, &notify);
            return;
        }
    };
    let downloads = match (context.downloads)() {
        Ok(downloads) => downloads,
        Err(error) => {
            state.status = "failed".into();
            state.status_text = "Downloads\\Aura Media 폴더를 준비하지 못했습니다.".into();
            state.error = Some(error);
            update_state(&mut state, &notify);
            return;
        }
    };
    let cancel_path = (context.cancel_path)();
    let pause_path = (context.pause_path)();
    let mut attempt = 0_u8;
    let outcome = loop {
        attempt += 1;
        let mut command = Command::new(&yt_dlp);
        configure_download_command(
            &mut command,
            &request.url,
            quality_height(&request.quality),
            &downloads,
            &node,
            &ffmpeg,
        );

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => break DownloadAttemptResult::SpawnError(error.to_string()),
        };
        let (tx, rx) = mpsc::channel();
        if let Some(stdout) = child.stdout.take() {
            let tx = tx.clone();
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    let _ = tx.send(line);
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            let tx = tx.clone();
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    let _ = tx.send(line);
                }
            });
        }
        drop(tx);

        let mut last_error = String::new();
        let mut cancelled = false;
        let mut paused = false;
        loop {
            if cancel_path.as_ref().is_some_and(|path| path.exists()) {
                let _ = child.kill();
                cancelled = true;
                break;
            }
            if pause_path.as_ref().is_some_and(|path| path.exists()) {
                let _ = child.kill();
                paused = true;
                break;
            }
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(line) => {
                    if let Some(title) = line.strip_prefix("AURA_TITLE:") {
                        state.title = Some(title.trim().to_string());
                        state.status_text = "영상 다운로드를 시작합니다…".into();
                        update_state(&mut state, &notify);
                    } else if let Some(progress) = line.strip_prefix("AURA_PROGRESS:") {
                        state.progress = parse_progress(progress);
                        state.status_text = format!("다운로드 중 · {}", progress.trim());
                        update_state(&mut state, &notify);
                    } else if let Some(path) = line.strip_prefix("AURA_FILE:") {
                        state.file_name = Path::new(path.trim())
                            .file_name()
                            .map(|value| value.to_string_lossy().into_owned());
                    } else if line.starts_with("ERROR:") {
                        last_error = line.trim().chars().take(500).collect();
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if child.try_wait().ok().flatten().is_some() {
                        break;
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        let status = child.wait();
        if cancelled {
            break DownloadAttemptResult::Cancelled;
        }
        if paused {
            break DownloadAttemptResult::Paused;
        }
        match status {
            Ok(status) if status.success() => break DownloadAttemptResult::Completed,
            Ok(status) => {
                let error = if last_error.is_empty() {
                    format!("yt-dlp exit {status}")
                } else {
                    last_error
                };
                if should_restart(&error, attempt) {
                    state.progress = None;
                    state.status_text = "일시적인 403 오류입니다. 링크를 새로 확인하는 중…".into();
                    state.error = None;
                    update_state(&mut state, &notify);
                    thread::sleep(Duration::from_secs(1));
                    continue;
                }
                break DownloadAttemptResult::Failed(error);
            }
            Err(error) => break DownloadAttemptResult::StatusError(error.to_string()),
        }
    };
    if let Some(path) = cancel_path {
        let _ = fs::remove_file(path);
    }

    match outcome {
        DownloadAttemptResult::Completed => {
            state.status = "completed".into();
            state.status_text = "Downloads\\Aura Media 폴더에 저장했습니다.".into();
            state.progress = Some(100);
            state.error = None;
        }
        DownloadAttemptResult::Failed(error) => {
            state.status = "failed".into();
            state.status_text = "YouTube 다운로드에 실패했습니다.".into();
            state.error = Some(error);
        }
        DownloadAttemptResult::SpawnError(error) => {
            state.status = "failed".into();
            state.status_text = "yt-dlp를 실행하지 못했습니다.".into();
            state.error = Some(error);
        }
        DownloadAttemptResult::StatusError(error) => {
            state.status = "failed".into();
            state.status_text = "yt-dlp 종료 상태를 확인하지 못했습니다.".into();
            state.error = Some(error);
        }
        DownloadAttemptResult::Cancelled => {
            state.status = "cancelled".into();
            state.status_text = "다운로드를 취소했습니다.".into();
            state.error = None;
        }
        DownloadAttemptResult::Paused => {
            state.status = "paused".into();
            state.status_text = "일시정지했습니다. 이어받기를 누르면 계속합니다.".into();
            state.error = None;
        }
    }
    update_state(&mut state, &notify);
}

pub fn configure_download_command(
    command: &mut Command,
    url: &str,
    height: Option<u16>,
    downloads: &Path,
    node: &Path,
    ffmpeg: &Path,
) {
    command
        .arg("--newline")
        .arg("--no-playlist")
        .arg("--windows-filenames")
        .arg("--continue")
        .arg("--merge-output-format")
        .arg("mp4")
        .arg("--paths")
        .arg(format!("home:{}", downloads.display()))
        .arg("--output")
        .arg(OUTPUT_TEMPLATE)
        .arg("--print")
        .arg("before_dl:AURA_TITLE:%(title)s")
        .arg("--print")
        .arg("after_move:AURA_FILE:%(filepath)s")
        .arg("--progress-template")
        .arg("download:AURA_PROGRESS:%(progress._percent_str)s %(progress._speed_str)s ETA %(progress._eta_str)s");
    if let Some(height) = height {
        command
            .arg("--format")
            .arg(format!("bv*[height<={height}]+ba/b[height<={height}]"));
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    apply_runtime(command, node, ffmpeg);
    command.arg(url);
    apply_hidden_process(command);
}
