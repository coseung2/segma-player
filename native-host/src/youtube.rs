use crate::job_store::{self, JobState};
use crate::Request;
use serde_json::{json, Value};
#[cfg(test)]
use std::fs;
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

pub const OUTPUT_TEMPLATE: &str = "[%(height)sp] %(title).170B.%(ext)s";

/// One verified ownership boundary for yt-dlp, ffmpeg and HTTP workers. On
/// Windows the child starts suspended and cannot spawn outside its Job Object.
pub struct OwnedProcess {
    pub child: std::process::Child,
    #[cfg(windows)]
    job: *mut std::ffi::c_void,
}

#[cfg(windows)]
mod owned_job {
    use std::ffi::c_void;
    #[repr(C)]
    #[derive(Default)]
    pub struct Limits {
        process_time: i64,
        job_time: i64,
        flags: u32,
        minimum: usize,
        maximum: usize,
        active_limit: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
        io: [u64; 6],
        process_memory: usize,
        job_memory: usize,
        peak_process: usize,
        peak_job: usize,
    }
    impl Limits {
        pub fn kill_on_close() -> Self {
            Self {
                flags: 0x2000,
                ..Self::default()
            }
        }
    }
    #[repr(C)]
    #[derive(Default)]
    pub struct Accounting {
        pub times: [i64; 4],
        pub faults: u32,
        pub total: u32,
        pub active: u32,
        pub terminated: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        pub fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> *mut c_void;
        pub fn SetInformationJobObject(
            job: *mut c_void,
            class: i32,
            info: *const c_void,
            length: u32,
        ) -> i32;
        pub fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        pub fn TerminateJobObject(job: *mut c_void, exit: u32) -> i32;
        pub fn QueryInformationJobObject(
            job: *mut c_void,
            class: i32,
            info: *mut c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
        pub fn CloseHandle(handle: *mut c_void) -> i32;
    }
    #[link(name = "ntdll")]
    extern "system" {
        pub fn NtResumeProcess(process: *mut c_void) -> i32;
    }
}

impl OwnedProcess {
    pub fn spawn(command: &mut Command) -> io::Result<Self> {
        command.stdin(Stdio::null());
        #[cfg(windows)]
        {
            use owned_job::*;
            use std::os::windows::{io::AsRawHandle, process::CommandExt};
            let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let limits = Limits::kill_on_close();
            if unsafe {
                SetInformationJobObject(
                    job,
                    9,
                    (&limits as *const Limits).cast(),
                    std::mem::size_of::<Limits>() as u32,
                )
            } == 0
            {
                let error = io::Error::last_os_error();
                unsafe {
                    CloseHandle(job);
                }
                return Err(error);
            }
            command.creation_flags(0x0800_0000 | 4); // no window, suspended
            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    unsafe {
                        CloseHandle(job);
                    }
                    return Err(error);
                }
            };
            if unsafe { AssignProcessToJobObject(job, child.as_raw_handle()) } == 0
                || unsafe { NtResumeProcess(child.as_raw_handle()) } < 0
            {
                let error = io::Error::last_os_error();
                let _ = child.kill();
                let _ = child.wait();
                unsafe {
                    CloseHandle(job);
                }
                return Err(error);
            }
            Ok(Self { child, job })
        }
        #[cfg(not(windows))]
        {
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                command.process_group(0);
            }
            Ok(Self {
                child: command.spawn()?,
            })
        }
    }

    pub fn finish(&mut self, terminate: bool) -> io::Result<std::process::ExitStatus> {
        #[cfg(windows)]
        {
            use owned_job::*;
            let status = if terminate {
                None
            } else {
                Some(self.child.wait()?)
            };
            // Even an exited root can leave descendants holding inherited pipes.
            if unsafe { TerminateJobObject(self.job, 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let status = match status {
                Some(status) => status,
                None => self.child.wait()?,
            };
            let started = std::time::Instant::now();
            loop {
                let mut accounting = Accounting::default();
                if unsafe {
                    QueryInformationJobObject(
                        self.job,
                        1,
                        (&mut accounting as *mut Accounting).cast(),
                        std::mem::size_of::<Accounting>() as u32,
                        std::ptr::null_mut(),
                    )
                } == 0
                {
                    return Err(io::Error::last_os_error());
                }
                if accounting.active == 0 {
                    return Ok(status);
                }
                if started.elapsed() > Duration::from_secs(5) {
                    return Err(io::Error::other("owned-processes-still-running"));
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
        #[cfg(not(windows))]
        {
            #[cfg(unix)]
            {
                extern "C" {
                    fn kill(pid: i32, signal: i32) -> i32;
                }
                unsafe {
                    kill(-(self.child.id() as i32), 9);
                }
            }
            if terminate {
                let _ = self.child.kill();
            }
            self.child.wait()
        }
    }
}

impl Drop for OwnedProcess {
    fn drop(&mut self) {
        let _ = self.finish(true);
        #[cfg(windows)]
        unsafe {
            owned_job::CloseHandle(self.job);
        }
    }
}

pub fn join_readers(readers: Vec<thread::JoinHandle<()>>) -> io::Result<()> {
    for reader in readers {
        reader
            .join()
            .map_err(|_| io::Error::other("download-reader-failed"))?;
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
pub enum ProcessOutcome {
    Completed,
    Cancelled,
    Paused,
    Failed(String),
}

pub fn run_owned_download(
    command: &mut Command,
    cancel: Option<&Path>,
    pause: Option<&Path>,
    mut line: impl FnMut(&str) -> io::Result<()>,
) -> io::Result<ProcessOutcome> {
    let mut child = OwnedProcess::spawn(command)?;
    let (tx, rx) = mpsc::channel();
    let mut readers = Vec::new();
    fn reader<R: io::Read + Send + 'static>(
        input: R,
        tx: mpsc::Sender<String>,
    ) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            for line in BufReader::new(input).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        })
    }
    if let Some(stdout) = child.child.stdout.take() {
        readers.push(reader(stdout, tx.clone()));
    }
    if let Some(stderr) = child.child.stderr.take() {
        readers.push(reader(stderr, tx.clone()));
    }
    drop(tx);
    let mut outcome = None;
    let mut callback_error = None;
    let mut last_error = String::new();
    loop {
        if cancel.is_some_and(Path::exists) {
            outcome = Some(ProcessOutcome::Cancelled);
            break;
        }
        if pause.is_some_and(Path::exists) {
            outcome = Some(ProcessOutcome::Paused);
            break;
        }
        if child.child.try_wait()?.is_some() {
            break;
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(value) => {
                if value.starts_with("ERROR:") {
                    last_error = value.chars().take(500).collect();
                }
                if let Err(error) = line(&value) {
                    callback_error = Some(error);
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => thread::sleep(Duration::from_millis(10)),
        }
    }
    let status = child.finish(outcome.is_some() || callback_error.is_some())?;
    join_readers(readers)?;
    for value in rx {
        if value.starts_with("ERROR:") {
            last_error = value.chars().take(500).collect();
        }
        if callback_error.is_none() {
            if let Err(error) = line(&value) {
                callback_error = Some(error);
            }
        }
    }
    if let Some(error) = callback_error {
        return Err(error);
    }
    Ok(outcome.unwrap_or_else(|| {
        if status.success() {
            ProcessOutcome::Completed
        } else {
            ProcessOutcome::Failed(if last_error.is_empty() {
                format!("yt-dlp exit {status}")
            } else {
                last_error
            })
        }
    }))
}

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
    pub jobs_directory: PathBuf,
}

enum DownloadAttemptResult {
    Completed,
    Failed(String),
    Cancelled,
    Paused,
}

fn update_state<F>(jobs_directory: &Path, state: &mut JobState, notify: &F) -> io::Result<()>
where
    F: Fn(&JobState),
{
    job_store::persist_job_state_in(jobs_directory, state, crate::now_millis())?;
    notify(state);
    Ok(())
}

pub fn execute<F, T, D, C, P>(
    request: Request,
    context: ExecutionContext<T, D, C, P>,
    notify: F,
) -> io::Result<()>
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
    update_state(&context.jobs_directory, &mut state, &notify)?;

    if request.kind != "youtube-download"
        || job_store::safe_id(&request.job_id).is_none()
        || !(request.url.starts_with("https://") || request.url.starts_with("http://"))
        || !valid_quality(&request.quality)
    {
        state.status = "failed".into();
        state.status_text = "올바른 YouTube 요청이 아닙니다.".into();
        state.error = Some("invalid-request".into());
        return update_state(&context.jobs_directory, &mut state, &notify);
    }

    let (yt_dlp, node, ffmpeg) = match (context.tools)() {
        Ok(tools) => tools,
        Err(error) => {
            state.status = "failed".into();
            state.status_text = "미디어 도구가 설치되지 않았습니다.".into();
            state.error = Some(error);
            return update_state(&context.jobs_directory, &mut state, &notify);
        }
    };
    let downloads = match (context.downloads)() {
        Ok(downloads) => downloads,
        Err(error) => {
            state.status = "failed".into();
            state.status_text = "Downloads\\Aura Media 폴더를 준비하지 못했습니다.".into();
            state.error = Some(error);
            return update_state(&context.jobs_directory, &mut state, &notify);
        }
    };
    let cancel_path = (context.cancel_path)();
    let pause_path = (context.pause_path)();
    let workspace = match job_store::DownloadWorkspace::prepare(
        &context.jobs_directory,
        &downloads,
        &request.job_id,
    ) {
        Ok(workspace) => workspace,
        Err(error) => {
            state.status = "failed".into();
            state.error = Some(error.to_string());
            return update_state(&context.jobs_directory, &mut state, &notify);
        }
    };
    let mut attempt = 0_u8;
    let outcome = loop {
        attempt += 1;
        let mut command = Command::new(&yt_dlp);
        configure_download_command(
            &mut command,
            &request.url,
            quality_height(&request.quality),
            &workspace.path,
            &node,
            &ffmpeg,
        );

        let result = run_owned_download(
            &mut command,
            cancel_path.as_deref(),
            pause_path.as_deref(),
            |line| {
                if let Some(title) = line.strip_prefix("AURA_TITLE:") {
                    state.title = Some(title.trim().to_string());
                    state.status_text = "영상 다운로드를 시작합니다…".into();
                    update_state(&context.jobs_directory, &mut state, &notify)?;
                } else if let Some(progress) = line.strip_prefix("AURA_PROGRESS:") {
                    state.progress = parse_progress(progress);
                    state.status_text = format!("다운로드 중 · {}", progress.trim());
                    update_state(&context.jobs_directory, &mut state, &notify)?;
                } else if let Some(path) = line.strip_prefix("AURA_FILE:") {
                    state.file_name = Path::new(path.trim())
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned());
                }
                Ok(())
            },
        );
        match result {
            Ok(ProcessOutcome::Completed) => break DownloadAttemptResult::Completed,
            Ok(ProcessOutcome::Cancelled) => break DownloadAttemptResult::Cancelled,
            Ok(ProcessOutcome::Paused) => break DownloadAttemptResult::Paused,
            Ok(ProcessOutcome::Failed(error)) if should_restart(&error, attempt) => {
                state.progress = None;
                state.error = None;
                state.status_text = "일시적인 403 오류입니다. 링크를 새로 확인하는 중…".into();
                update_state(&context.jobs_directory, &mut state, &notify)?;
                thread::sleep(Duration::from_secs(1));
            }
            Ok(ProcessOutcome::Failed(error)) => break DownloadAttemptResult::Failed(error),
            Err(error) => {
                state.status = "failed".into();
                state.status_text = "다운로드 실행기 종료를 확인하지 못했습니다.".into();
                state.error = Some(format!("download-stop-failed: {error}"));
                return update_state(&context.jobs_directory, &mut state, &notify);
            }
        }
    };
    let outcome = match job_store::finish_download_output_in(
        &context.jobs_directory,
        &mut state,
        &workspace,
        matches!(outcome, DownloadAttemptResult::Completed),
        matches!(outcome, DownloadAttemptResult::Paused),
    ) {
        Ok(()) => outcome,
        Err(error) => DownloadAttemptResult::Failed(error.to_string()),
    };
    let outcome = if matches!(
        outcome,
        DownloadAttemptResult::Completed | DownloadAttemptResult::Cancelled
    ) {
        match job_store::clear_cancel_marker_in(&context.jobs_directory, &request.job_id) {
            Ok(()) => outcome,
            Err(error) => {
                DownloadAttemptResult::Failed(format!("download-cleanup-failed: {error}"))
            }
        }
    } else {
        outcome
    };

    match outcome {
        DownloadAttemptResult::Completed => {
            state.status = "completed".into();
            state.status_text = "다운로드 폴더에 저장했습니다.".into();
            state.progress = Some(100);
            state.error = None;
        }
        DownloadAttemptResult::Failed(error) => {
            state.status = "failed".into();
            state.status_text = "YouTube 다운로드에 실패했습니다.".into();
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
    update_state(&context.jobs_directory, &mut state, &notify)
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
        // --print implies --quiet, which hides progress; --progress restores it.
        .arg("--progress")
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Request;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(1);

    fn test_directory(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "segma-youtube-{tag}-{}-{}",
            std::process::id(),
            NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).expect("test directory creates");
        path
    }

    fn request() -> Request {
        serde_json::from_value(json!({
            "type": "youtube-download",
            "requestId": "request-1",
            "jobId": "youtube-job-1",
            "url": "https://www.youtube.com/watch?v=example",
            "quality": "best"
        }))
        .expect("request parses")
    }

    #[test]
    fn initial_persistence_failure_stops_before_tool_or_download_setup() {
        let root = test_directory("state-failure");
        let blocked = root.join("not-a-directory");
        fs::write(&blocked, b"blocked").expect("blocking file writes");
        let context = ExecutionContext {
            tools: || panic!("tools must not resolve after state failure"),
            downloads: || panic!("downloads must not resolve after state failure"),
            cancel_path: || None,
            pause_path: || None,
            jobs_directory: blocked,
        };

        assert!(execute(request(), context, |_| {}).is_err());
        fs::remove_dir_all(root).expect("test directory removes");
    }
}
