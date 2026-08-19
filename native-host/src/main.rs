#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::ffi::c_void;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const PROTOCOL_VERSION: u32 = 2;
const MAX_NATIVE_MESSAGE_BYTES: usize = 1024 * 1024;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(target_os = "windows")]
const DETACHED_PROCESS: u32 = 0x0000_0008;
#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

#[derive(Debug, Clone, Deserialize, Serialize)]
struct Request {
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "requestId", default)]
    request_id: String,
    #[serde(rename = "jobId", default)]
    job_id: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    filename: String,
    #[serde(default)]
    data: String,
    #[serde(default = "default_quality")]
    quality: String,
    #[serde(default)]
    protocol: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct JobState {
    #[serde(rename = "jobId")]
    job_id: String,
    status: String,
    #[serde(rename = "statusText")]
    status_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<u8>,
    #[serde(rename = "fileName", skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
}

struct MediaWriter {
    job_id: String,
    file: File,
    temporary_path: PathBuf,
    final_path: PathBuf,
}

fn default_quality() -> String {
    "best".into()
}

fn quality_height(value: &str) -> Option<u16> {
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

fn valid_quality(value: &str) -> bool {
    value == "best" || quality_height(value).is_some()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn read_message() -> io::Result<Option<Request>> {
    let mut length = [0_u8; 4];
    let mut stdin = io::stdin().lock();
    match stdin.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let size = u32::from_le_bytes(length) as usize;
    if size == 0 || size > MAX_NATIVE_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid native message length",
        ));
    }
    let mut data = vec![0_u8; size];
    stdin.read_exact(&mut data)?;
    serde_json::from_slice(&data)
        .map(Some)
        .map_err(io::Error::other)
}

fn write_message(value: &Value) -> io::Result<()> {
    let data = serde_json::to_vec(value).map_err(io::Error::other)?;
    let mut stdout = io::stdout().lock();
    stdout.write_all(&(data.len() as u32).to_le_bytes())?;
    stdout.write_all(&data)?;
    stdout.flush()
}

fn reply(request: &Request, body: Value) {
    let mut object = body.as_object().cloned().unwrap_or_default();
    if !request.request_id.is_empty() {
        object.insert("requestId".into(), Value::String(request.request_id.clone()));
    }
    let _ = write_message(&Value::Object(object));
}

fn companion_root() -> io::Result<PathBuf> {
    if let Some(local) = env::var_os("LOCALAPPDATA") {
        return Ok(PathBuf::from(local).join("Aura Media").join("Companion"));
    }
    let executable = env::current_exe()?;
    Ok(executable
        .parent()
        .unwrap_or(Path::new("."))
        .to_path_buf())
}

fn jobs_dir() -> io::Result<PathBuf> {
    let path = companion_root()?.join("jobs");
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn tools_dir() -> io::Result<PathBuf> {
    let executable = env::current_exe()?;
    Ok(executable.parent().unwrap_or(Path::new(".")).join("tools"))
}

fn downloads_dir() -> io::Result<PathBuf> {
    let home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "home directory is unavailable"))?;
    Ok(PathBuf::from(home).join("Downloads"))
}

fn aura_downloads_dir() -> io::Result<PathBuf> {
    let path = downloads_dir()?.join("Aura Media");
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn safe_id(value: &str) -> Option<String> {
    if value.is_empty() || value.len() > 128 {
        return None;
    }
    if value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        Some(value.to_string())
    } else {
        None
    }
}

fn job_request_path(job_id: &str) -> io::Result<PathBuf> {
    let safe = safe_id(job_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid job id"))?;
    Ok(jobs_dir()?.join(format!("{safe}.request.json")))
}

fn job_state_path(job_id: &str) -> io::Result<PathBuf> {
    let safe = safe_id(job_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid job id"))?;
    Ok(jobs_dir()?.join(format!("{safe}.state.json")))
}

fn job_cancel_path(job_id: &str) -> io::Result<PathBuf> {
    let safe = safe_id(job_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid job id"))?;
    Ok(jobs_dir()?.join(format!("{safe}.cancel")))
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> io::Result<()> {
    let temporary = path.with_extension("tmp");
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    fs::write(&temporary, bytes)?;
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(temporary, path)
}

fn read_job_state(path: &Path) -> Option<JobState> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn list_job_states() -> io::Result<Vec<JobState>> {
    let mut states = Vec::new();
    for entry in fs::read_dir(jobs_dir()?)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        let name = path.file_name().and_then(|value| value.to_str()).unwrap_or("");
        if !name.ends_with(".state.json") {
            continue;
        }
        if let Some(state) = read_job_state(&path) {
            states.push(state);
        }
    }
    states.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    states.truncate(100);
    Ok(states)
}

fn persist_job_state(state: &mut JobState) -> io::Result<()> {
    state.updated_at = now_millis();
    write_json_atomic(&job_state_path(&state.job_id)?, state)
}

fn safe_filename(value: &str) -> String {
    let mut name: String = value
        .chars()
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .take(180)
        .collect();
    while name.ends_with([' ', '.']) {
        name.pop();
    }
    if name.is_empty() || name == "." || name == ".." {
        "aura-media.ts".into()
    } else {
        name
    }
}

fn unique_media_path(directory: &Path, filename: &str) -> PathBuf {
    let requested = Path::new(filename);
    let stem = requested
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("aura-media");
    let extension = requested
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    for index in 0..10_000 {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!(" ({index})")
        };
        let candidate = if extension.is_empty() {
            format!("{stem}{suffix}")
        } else {
            format!("{stem}{suffix}.{extension}")
        };
        let path = directory.join(candidate);
        let temporary = PathBuf::from(format!("{}.part", path.display()));
        if !path.exists() && !temporary.exists() {
            return path;
        }
    }
    directory.join(format!("aura-media-{}.ts", std::process::id()))
}

fn open_media_writer(request: &Request) -> io::Result<MediaWriter> {
    let directory = aura_downloads_dir()?;
    let filename = safe_filename(&request.filename);
    let final_path = unique_media_path(&directory, &filename);
    let temporary_path = PathBuf::from(format!("{}.part", final_path.display()));
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary_path)?;
    Ok(MediaWriter {
        job_id: request.job_id.clone(),
        file,
        temporary_path,
        final_path,
    })
}

fn handle_media_request(request: &Request, writer: &mut Option<MediaWriter>) {
    match request.kind.as_str() {
        "media-open" => match open_media_writer(request) {
            Ok(opened) => {
                let file_name = opened
                    .final_path
                    .file_name()
                    .map(|value| value.to_string_lossy().into_owned());
                *writer = Some(opened);
                reply(request, json!({
                    "ok": true,
                    "jobId": request.job_id,
                    "status": "opened",
                    "statusText": "Downloads\\Aura Media 폴더에 저장을 시작합니다.",
                    "fileName": file_name,
                }));
            }
            Err(error) => reply(request, json!({
                "ok": false,
                "jobId": request.job_id,
                "status": "failed",
                "statusText": "로컬 파일을 만들지 못했습니다.",
                "error": error.to_string(),
            })),
        },
        "media-chunk" => {
            let Some(active) = writer
                .as_mut()
                .filter(|active| active.job_id == request.job_id)
            else {
                reply(request, json!({
                    "ok": false,
                    "jobId": request.job_id,
                    "status": "failed",
                    "errorCode": "media-writer-not-open",
                    "error": "열린 미디어 파일이 없습니다.",
                }));
                return;
            };
            match BASE64.decode(request.data.as_bytes()) {
                Ok(bytes) => match active.file.write_all(&bytes) {
                    Ok(()) => reply(request, json!({
                        "ok": true,
                        "jobId": request.job_id,
                        "status": "chunk",
                        "bytes": bytes.len(),
                    })),
                    Err(error) => reply(request, json!({
                        "ok": false,
                        "jobId": request.job_id,
                        "status": "failed",
                        "error": error.to_string(),
                    })),
                },
                Err(error) => reply(request, json!({
                    "ok": false,
                    "jobId": request.job_id,
                    "status": "failed",
                    "errorCode": "invalid-media-data",
                    "error": error.to_string(),
                })),
            }
        }
        "media-close" => {
            let Some(mut active) = writer
                .take()
                .filter(|active| active.job_id == request.job_id)
            else {
                reply(request, json!({
                    "ok": false,
                    "jobId": request.job_id,
                    "status": "failed",
                    "errorCode": "media-writer-not-open",
                }));
                return;
            };
            let result = active.file.flush().and_then(|_| active.file.sync_all());
            drop(active.file);
            match result.and_then(|_| fs::rename(&active.temporary_path, &active.final_path)) {
                Ok(()) => reply(request, json!({
                    "ok": true,
                    "jobId": request.job_id,
                    "status": "closed",
                    "statusText": "Downloads\\Aura Media 폴더에 저장했습니다.",
                    "fileName": active.final_path.file_name().map(|value| value.to_string_lossy().into_owned()),
                })),
                Err(error) => {
                    let _ = fs::remove_file(&active.temporary_path);
                    reply(request, json!({
                        "ok": false,
                        "jobId": request.job_id,
                        "status": "failed",
                        "error": error.to_string(),
                    }));
                }
            }
        }
        "media-abort" => {
            if let Some(active) = writer.take() {
                drop(active.file);
                let _ = fs::remove_file(active.temporary_path);
            }
            reply(request, json!({
                "ok": true,
                "jobId": request.job_id,
                "status": "aborted",
            }));
        }
        _ => reply(request, json!({
            "ok": false,
            "jobId": request.job_id,
            "status": "failed",
            "errorCode": "invalid-media-request",
        })),
    }
}

fn command_tools() -> io::Result<(PathBuf, PathBuf, PathBuf)> {
    let tools = tools_dir()?;
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

fn apply_hidden_process(command: &mut Command) {
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
}

fn apply_ytdlp_runtime(command: &mut Command, node: &Path, ffmpeg: &Path) {
    command.arg("--ffmpeg-location").arg(ffmpeg);
    if node.is_file() {
        command
            .arg("--js-runtimes")
            .arg(format!("node:{}", node.display()));
    }
}

fn youtube_info(request: &Request) -> Result<Value, String> {
    if !(request.url.starts_with("https://") || request.url.starts_with("http://")) {
        return Err("invalid-youtube-url".into());
    }
    let (yt_dlp, node, ffmpeg) = command_tools().map_err(|error| error.to_string())?;
    let mut command = Command::new(yt_dlp);
    command
        .arg("--dump-single-json")
        .arg("--skip-download")
        .arg("--no-playlist")
        .arg("--no-warnings");
    apply_ytdlp_runtime(&mut command, &node, &ffmpeg);
    command.arg(&request.url);
    apply_hidden_process(&mut command);
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(detail.trim().chars().take(500).collect());
    }
    let parsed: Value = serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())?;
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

fn initial_job_state(request: &Request) -> JobState {
    JobState {
        job_id: request.job_id.clone(),
        status: "queued".into(),
        status_text: "Aura Companion 대기 중…".into(),
        title: None,
        error: None,
        progress: None,
        file_name: None,
        updated_at: now_millis(),
    }
}

fn parse_progress(value: &str) -> Option<u8> {
    let token = value
        .split_whitespace()
        .find(|part| part.trim_end_matches('%').parse::<f32>().is_ok())?;
    let number = token.trim_end_matches('%').parse::<f32>().ok()?;
    Some(number.clamp(0.0, 100.0).round() as u8)
}

fn update_state<F>(state: &mut JobState, notify: &F)
where
    F: Fn(&JobState),
{
    let _ = persist_job_state(state);
    notify(state);
}

fn execute_download<F>(request: Request, notify: F)
where
    F: Fn(&JobState),
{
    let mut state = initial_job_state(&request);
    state.status = "running".into();
    state.status_text = "YouTube 정보를 확인하는 중…".into();
    update_state(&mut state, &notify);

    if request.kind != "youtube-download"
        || safe_id(&request.job_id).is_none()
        || !(request.url.starts_with("https://") || request.url.starts_with("http://"))
        || !valid_quality(&request.quality)
    {
        state.status = "failed".into();
        state.status_text = "올바른 YouTube 요청이 아닙니다.".into();
        state.error = Some("invalid-request".into());
        update_state(&mut state, &notify);
        return;
    }

    let (yt_dlp, node, ffmpeg) = match command_tools() {
        Ok(tools) => tools,
        Err(error) => {
            state.status = "failed".into();
            state.status_text = "미디어 도구가 설치되지 않았습니다.".into();
            state.error = Some(error.to_string());
            update_state(&mut state, &notify);
            return;
        }
    };
    let downloads = match aura_downloads_dir() {
        Ok(path) => path,
        Err(error) => {
            state.status = "failed".into();
            state.status_text = "Downloads\\Aura Media 폴더를 준비하지 못했습니다.".into();
            state.error = Some(error.to_string());
            update_state(&mut state, &notify);
            return;
        }
    };

    let mut command = Command::new(&yt_dlp);
    command
        .arg("--newline")
        .arg("--no-playlist")
        .arg("--windows-filenames")
        .arg("--merge-output-format")
        .arg("mp4")
        .arg("--paths")
        .arg(format!("home:{}", downloads.display()))
        .arg("--output")
        .arg("[%(height)sp] %(title).170B [%(id)s].%(ext)s")
        .arg("--print")
        .arg("before_dl:AURA_TITLE:%(title)s")
        .arg("--print")
        .arg("after_move:AURA_FILE:%(filepath)s")
        .arg("--progress-template")
        .arg("download:AURA_PROGRESS:%(progress._percent_str)s %(progress._speed_str)s ETA %(progress._eta_str)s")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_ytdlp_runtime(&mut command, &node, &ffmpeg);
    if let Some(height) = quality_height(&request.quality) {
        command
            .arg("--format")
            .arg(format!("bv*[height<={height}]+ba/b[height<={height}]"));
    }
    command.arg(&request.url);
    apply_hidden_process(&mut command);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            state.status = "failed".into();
            state.status_text = "yt-dlp를 실행하지 못했습니다.".into();
            state.error = Some(error.to_string());
            update_state(&mut state, &notify);
            return;
        }
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

    let cancel_path = job_cancel_path(&request.job_id).ok();
    let mut last_error = String::new();
    let mut cancelled = false;
    loop {
        if cancel_path.as_ref().is_some_and(|path| path.exists()) {
            let _ = child.kill();
            cancelled = true;
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
    if let Some(path) = cancel_path {
        let _ = fs::remove_file(path);
    }

    if cancelled {
        state.status = "cancelled".into();
        state.status_text = "다운로드를 취소했습니다.".into();
        state.error = None;
        update_state(&mut state, &notify);
        return;
    }
    match status {
        Ok(status) if status.success() => {
            state.status = "completed".into();
            state.status_text = "Downloads\\Aura Media 폴더에 저장했습니다.".into();
            state.progress = Some(100);
            state.error = None;
        }
        Ok(status) => {
            state.status = "failed".into();
            state.status_text = "YouTube 다운로드에 실패했습니다.".into();
            state.error = Some(if last_error.is_empty() {
                format!("yt-dlp exit {status}")
            } else {
                last_error
            });
        }
        Err(error) => {
            state.status = "failed".into();
            state.status_text = "yt-dlp 종료 상태를 확인하지 못했습니다.".into();
            state.error = Some(error.to_string());
        }
    }
    update_state(&mut state, &notify);
}

fn spawn_detached(arguments: &[&str]) -> io::Result<()> {
    let executable = env::current_exe()?;
    let mut command = Command::new(executable);
    command.args(arguments);
    #[cfg(target_os = "windows")]
    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    command.spawn()?;
    Ok(())
}

fn spawn_job_runner(request: &Request) -> io::Result<()> {
    let request_path = job_request_path(&request.job_id)?;
    write_json_atomic(&request_path, request)?;
    let mut state = initial_job_state(request);
    persist_job_state(&mut state)?;
    if let Ok(cancel_path) = job_cancel_path(&request.job_id) {
        let _ = fs::remove_file(cancel_path);
    }
    let request_path_text = request_path.to_string_lossy().into_owned();
    spawn_detached(&["--run-job", &request_path_text])?;
    #[cfg(target_os = "windows")]
    {
        let _ = spawn_detached(&["--job-ui", &request.job_id]);
    }
    Ok(())
}

fn spawn_manager() -> io::Result<()> {
    let executable = env::current_exe()?;
    let mut command = Command::new(executable);
    command.arg("--manager");
    #[cfg(target_os = "windows")]
    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    command.spawn()?;
    Ok(())
}

fn open_download_folder() -> io::Result<()> {
    let folder = aura_downloads_dir()?;
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer.exe");
        command.arg(folder);
        command.creation_flags(CREATE_NO_WINDOW);
        command.spawn()?;
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = folder;
        Ok(())
    }
}

fn run_native_host() {
    let mut writer: Option<MediaWriter> = None;
    while let Ok(Some(request)) = read_message() {
        match request.kind.as_str() {
            "hello" => reply(&request, json!({
                "ok": true,
                "protocol": PROTOCOL_VERSION,
                "version": env!("CARGO_PKG_VERSION"),
                "capabilities": ["youtube", "youtube-info", "persistent-jobs", "local-writer", "manager-ui", "open-folder", "cancel"],
            })),
            "status" => reply(&request, json!({
                "ok": true,
                "protocol": PROTOCOL_VERSION,
                "version": env!("CARGO_PKG_VERSION"),
                "toolsReady": command_tools().is_ok(),
                "downloadsFolder": aura_downloads_dir().ok().map(|path| path.to_string_lossy().into_owned()),
            })),
            "youtube-info" => match youtube_info(&request) {
                Ok(info) => reply(&request, json!({ "ok": true, "title": info["title"], "qualities": info["qualities"] })),
                Err(error) => reply(&request, json!({ "ok": false, "error": error, "errorCode": "youtube-info-failed" })),
            },
            "youtube-download" => {
                if safe_id(&request.job_id).is_none() || !valid_quality(&request.quality) {
                    reply(&request, json!({ "ok": false, "errorCode": "invalid-request", "error": "올바른 다운로드 요청이 아닙니다." }));
                    continue;
                }
                match spawn_job_runner(&request) {
                    Ok(()) => reply(&request, json!({ "ok": true, "accepted": true, "jobId": request.job_id })),
                    Err(error) => reply(&request, json!({ "ok": false, "errorCode": "job-start-failed", "error": error.to_string() })),
                }
            }
            "list-jobs" => match list_job_states() {
                Ok(jobs) => reply(&request, json!({ "ok": true, "jobs": jobs })),
                Err(error) => reply(&request, json!({ "ok": false, "errorCode": "job-list-failed", "error": error.to_string() })),
            },
            "cancel-job" => match job_cancel_path(&request.job_id) {
                Ok(path) => match fs::write(path, b"cancel") {
                    Ok(()) => reply(&request, json!({ "ok": true, "jobId": request.job_id })),
                    Err(error) => reply(&request, json!({ "ok": false, "error": error.to_string() })),
                },
                Err(error) => reply(&request, json!({ "ok": false, "error": error.to_string() })),
            },
            "show-ui" => match spawn_manager() {
                Ok(()) => reply(&request, json!({ "ok": true })),
                Err(error) => reply(&request, json!({ "ok": false, "error": error.to_string() })),
            },
            "open-folder" => match open_download_folder() {
                Ok(()) => reply(&request, json!({ "ok": true })),
                Err(error) => reply(&request, json!({ "ok": false, "error": error.to_string() })),
            },
            kind if kind.starts_with("media-") => handle_media_request(&request, &mut writer),
            _ => reply(&request, json!({ "ok": false, "errorCode": "unsupported-request", "error": "지원하지 않는 Aura Companion 요청입니다." })),
        }
    }
    if let Some(active) = writer.take() {
        drop(active.file);
        let _ = fs::remove_file(active.temporary_path);
    }
}

#[cfg(target_os = "windows")]
mod windows_ui {
    use super::{list_job_states, JobState};
    use std::ffi::c_void;
    use std::ptr;
    use std::thread;
    use std::time::Duration;

    type Hwnd = *mut c_void;
    type Hinstance = *mut c_void;
    type Hicon = *mut c_void;
    type Hcursor = *mut c_void;
    type Hbrush = *mut c_void;
    type Lresult = isize;
    type Wparam = usize;
    type Lparam = isize;

    const WS_OVERLAPPEDWINDOW: u32 = 0x00CF0000;
    const WS_VISIBLE: u32 = 0x10000000;
    const WS_CHILD: u32 = 0x40000000;
    const SS_LEFT: u32 = 0x00000000;
    const CW_USEDEFAULT: i32 = 0x80000000_u32 as i32;
    const SW_SHOWNORMAL: i32 = 1;
    const WM_DESTROY: u32 = 0x0002;
    const WM_CLOSE: u32 = 0x0010;
    const WM_SETTEXT: u32 = 0x000C;

    #[repr(C)]
    struct WndClassW {
        style: u32,
        lpfn_wnd_proc: Option<unsafe extern "system" fn(Hwnd, u32, Wparam, Lparam) -> Lresult>,
        cb_cls_extra: i32,
        cb_wnd_extra: i32,
        h_instance: Hinstance,
        h_icon: Hicon,
        h_cursor: Hcursor,
        hbr_background: Hbrush,
        lpsz_menu_name: *const u16,
        lpsz_class_name: *const u16,
    }

    #[repr(C)]
    struct Msg {
        hwnd: Hwnd,
        message: u32,
        w_param: Wparam,
        l_param: Lparam,
        time: u32,
        pt_x: i32,
        pt_y: i32,
        l_private: u32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn RegisterClassW(class: *const WndClassW) -> u16;
        fn CreateWindowExW(
            ex_style: u32,
            class_name: *const u16,
            window_name: *const u16,
            style: u32,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            parent: Hwnd,
            menu: *mut c_void,
            instance: Hinstance,
            param: *mut c_void,
        ) -> Hwnd;
        fn DefWindowProcW(hwnd: Hwnd, msg: u32, wparam: Wparam, lparam: Lparam) -> Lresult;
        fn ShowWindow(hwnd: Hwnd, command: i32) -> i32;
        fn UpdateWindow(hwnd: Hwnd) -> i32;
        fn GetMessageW(msg: *mut Msg, hwnd: Hwnd, min: u32, max: u32) -> i32;
        fn TranslateMessage(msg: *const Msg) -> i32;
        fn DispatchMessageW(msg: *const Msg) -> Lresult;
        fn PostQuitMessage(exit_code: i32);
        fn PostMessageW(hwnd: Hwnd, msg: u32, wparam: Wparam, lparam: Lparam) -> i32;
        fn SendMessageW(hwnd: Hwnd, msg: u32, wparam: Wparam, lparam: Lparam) -> Lresult;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(module: *const u16) -> Hinstance;
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe extern "system" fn window_proc(hwnd: Hwnd, msg: u32, wparam: Wparam, lparam: Lparam) -> Lresult {
        if msg == WM_DESTROY {
            PostQuitMessage(0);
            return 0;
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    struct Window {
        hwnd: isize,
        title: isize,
        status: isize,
    }

    impl Window {
        fn set_title(&self, value: &str) {
            let text = wide(value);
            unsafe { SendMessageW(self.title as Hwnd, WM_SETTEXT, 0, text.as_ptr() as Lparam); }
        }

        fn set_status(&self, value: &str) {
            let text = wide(value);
            unsafe { SendMessageW(self.status as Hwnd, WM_SETTEXT, 0, text.as_ptr() as Lparam); }
        }

        fn close_later(&self, delay: Duration) {
            let hwnd = self.hwnd;
            thread::spawn(move || {
                thread::sleep(delay);
                unsafe { PostMessageW(hwnd as Hwnd, WM_CLOSE, 0, 0); }
            });
        }
    }

    fn create_window(caption: &str, width: i32, height: i32) -> Option<Window> {
        unsafe {
            let instance = GetModuleHandleW(ptr::null());
            let class_name = wide("AuraMediaCompanionWindow");
            let class = WndClassW {
                style: 0,
                lpfn_wnd_proc: Some(window_proc),
                cb_cls_extra: 0,
                cb_wnd_extra: 0,
                h_instance: instance,
                h_icon: ptr::null_mut(),
                h_cursor: ptr::null_mut(),
                hbr_background: (6_isize) as Hbrush,
                lpsz_menu_name: ptr::null(),
                lpsz_class_name: class_name.as_ptr(),
            };
            RegisterClassW(&class);
            let caption = wide(caption);
            let hwnd = CreateWindowExW(
                0,
                class_name.as_ptr(),
                caption.as_ptr(),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                CW_USEDEFAULT,
                CW_USEDEFAULT,
                width,
                height,
                ptr::null_mut(),
                ptr::null_mut(),
                instance,
                ptr::null_mut(),
            );
            if hwnd.is_null() {
                return None;
            }
            let static_class = wide("STATIC");
            let title_text = wide("Aura Media");
            let status_text = wide("준비 중…");
            let title = CreateWindowExW(
                0,
                static_class.as_ptr(),
                title_text.as_ptr(),
                WS_CHILD | WS_VISIBLE | SS_LEFT,
                18,
                18,
                width - 56,
                28,
                hwnd,
                ptr::null_mut(),
                instance,
                ptr::null_mut(),
            );
            let status = CreateWindowExW(
                0,
                static_class.as_ptr(),
                status_text.as_ptr(),
                WS_CHILD | WS_VISIBLE | SS_LEFT,
                18,
                54,
                width - 56,
                height - 100,
                hwnd,
                ptr::null_mut(),
                instance,
                ptr::null_mut(),
            );
            ShowWindow(hwnd, SW_SHOWNORMAL);
            UpdateWindow(hwnd);
            Some(Window { hwnd: hwnd as isize, title: title as isize, status: status as isize })
        }
    }

    fn message_loop() {
        unsafe {
            let mut msg = Msg {
                hwnd: ptr::null_mut(),
                message: 0,
                w_param: 0,
                l_param: 0,
                time: 0,
                pt_x: 0,
                pt_y: 0,
                l_private: 0,
            };
            while GetMessageW(&mut msg, ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    fn manager_text(states: &[JobState]) -> String {
        if states.is_empty() {
            return "다운로드 작업이 없습니다.".into();
        }
        states
            .iter()
            .take(8)
            .map(|state| {
                let title = state.title.as_deref().unwrap_or("제목 확인 중…");
                format!("{} · {}\r\n{}", state.status, title, state.status_text)
            })
            .collect::<Vec<_>>()
            .join("\r\n\r\n")
    }

    pub fn run_job_ui(job_id: String) {
        let Some(window) = create_window("Aura Downloads", 460, 180) else {
            return;
        };
        let title_handle = window.title;
        let status_handle = window.status;
        let hwnd = window.hwnd;
        thread::spawn(move || {
            let mut terminal_seen = false;
            loop {
                let path = match super::job_state_path(&job_id) {
                    Ok(path) => path,
                    Err(_) => break,
                };
                if let Some(state) = super::read_job_state(&path) {
                    let title = state.title.as_deref().unwrap_or("Aura Media 다운로드");
                    let status = if let Some(progress) = state.progress {
                        format!("{}\r\n진행률 {}%", state.status_text, progress)
                    } else {
                        state.status_text.clone()
                    };
                    let title = wide(title);
                    let status = wide(&status);
                    unsafe {
                        SendMessageW(title_handle as Hwnd, WM_SETTEXT, 0, title.as_ptr() as Lparam);
                        SendMessageW(status_handle as Hwnd, WM_SETTEXT, 0, status.as_ptr() as Lparam);
                    }
                    if matches!(state.status.as_str(), "completed" | "failed" | "cancelled") {
                        if !terminal_seen {
                            terminal_seen = true;
                            thread::sleep(Duration::from_secs(4));
                            unsafe { PostMessageW(hwnd as Hwnd, WM_CLOSE, 0, 0); }
                        }
                        break;
                    }
                }
                thread::sleep(Duration::from_millis(400));
            }
        });
        message_loop();
    }

    pub fn run_manager_ui() {
        let Some(window) = create_window("Aura Downloads", 560, 420) else {
            return;
        };
        window.set_title("Aura Downloads");
        let status_handle = window.status;
        thread::spawn(move || loop {
            let states = list_job_states().unwrap_or_default();
            let text = wide(&manager_text(&states));
            unsafe { SendMessageW(status_handle as Hwnd, WM_SETTEXT, 0, text.as_ptr() as Lparam); }
            thread::sleep(Duration::from_secs(1));
        });
        message_loop();
    }
}

fn run_job_from_path(path: &Path) -> io::Result<()> {
    let request: Request = serde_json::from_slice(&fs::read(path)?).map_err(io::Error::other)?;
    execute_download(request, |_| {});
    Ok(())
}

fn main() {
    let args = env::args_os().collect::<Vec<_>>();
    if args.get(1).and_then(|value| value.to_str()) == Some("--run-job") {
        if let Some(path) = args.get(2) {
            let _ = run_job_from_path(Path::new(path));
        }
        return;
    }
    if args.get(1).and_then(|value| value.to_str()) == Some("--job-ui") {
        #[cfg(target_os = "windows")]
        if let Some(job_id) = args.get(2).and_then(|value| value.to_str()) {
            windows_ui::run_job_ui(job_id.to_string());
        }
        return;
    }
    if args.get(1).and_then(|value| value.to_str()) == Some("--manager") {
        #[cfg(target_os = "windows")]
        windows_ui::run_manager_ui();
        return;
    }
    run_native_host();
}

#[cfg(test)]
mod tests {
    use super::{parse_progress, quality_height, safe_id, valid_quality};

    #[test]
    fn validates_supported_quality_caps() {
        assert_eq!(quality_height("4320"), Some(4320));
        assert_eq!(quality_height("1080"), Some(1080));
        assert_eq!(quality_height("best"), None);
        assert!(valid_quality("best"));
        assert!(valid_quality("144"));
        assert!(!valid_quality("123"));
    }

    #[test]
    fn validates_job_ids() {
        assert_eq!(safe_id("abc-123_xyz").as_deref(), Some("abc-123_xyz"));
        assert!(safe_id("../escape").is_none());
        assert!(safe_id("").is_none());
    }

    #[test]
    fn parses_progress_lines() {
        assert_eq!(parse_progress(" 72.4% 12.0MiB/s ETA 00:12"), Some(72));
        assert_eq!(parse_progress("unknown"), None);
    }
}
