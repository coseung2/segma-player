//! Nonblocking GIF export for the native Companion player.
//!
//! GifExportController owns one background ffmpeg invocation at a time. The
//! UI submits a GifExportRequest and calls poll once per frame. Completion is
//! reported as a final GIF path or a descriptive error; no UI or egui types
//! are required here.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_DURATION_SECONDS: f64 = 30.0;
const MIN_WIDTH: u32 = 16;
const MAX_WIDTH: u32 = 3_840;
const MIN_FPS: u32 = 1;
const MAX_FPS: u32 = 60;

static NEXT_EXPORT_ID: AtomicU64 = AtomicU64::new(1);

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Values needed to render one GIF clip.
#[derive(Debug, Clone, PartialEq)]
pub struct GifExportRequest {
    pub source_video_path: PathBuf,
    pub ffmpeg_path: PathBuf,
    pub output_directory: PathBuf,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub width: u32,
    pub fps: u32,
}

impl GifExportRequest {
    /// Construct a request. Validation happens when it is submitted.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        source_video_path: impl Into<PathBuf>,
        ffmpeg_path: impl Into<PathBuf>,
        output_directory: impl Into<PathBuf>,
        start_seconds: f64,
        end_seconds: f64,
        width: u32,
        fps: u32,
    ) -> Self {
        Self {
            source_video_path: source_video_path.into(),
            ffmpeg_path: ffmpeg_path.into(),
            output_directory: output_directory.into(),
            start_seconds,
            end_seconds,
            width,
            fps,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GifExportError {
    Busy,
    InvalidRequest(String),
    Io(String),
    Ffmpeg(String),
}

impl std::fmt::Display for GifExportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Busy => formatter.write_str("a GIF export is already running"),
            Self::InvalidRequest(message) | Self::Io(message) | Self::Ffmpeg(message) => {
                formatter.write_str(message)
            }
        }
    }
}

impl std::error::Error for GifExportError {}

/// Result of a nonblocking controller poll.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GifExportStatus {
    Idle,
    Running,
    Completed(PathBuf),
    Failed(GifExportError),
}

#[derive(Debug, Clone, PartialEq)]
struct ValidatedRequest {
    source_video_path: PathBuf,
    ffmpeg_path: PathBuf,
    output_directory: PathBuf,
    start_seconds: f64,
    duration_seconds: f64,
    width: u32,
    fps: u32,
}

/// UI-thread owner for one background GIF export.
pub struct GifExportController {
    result_receiver: Option<Receiver<Result<PathBuf, GifExportError>>>,
    active: bool,
}

impl GifExportController {
    pub fn new() -> Self {
        Self {
            result_receiver: None,
            active: false,
        }
    }

    /// Submit an export and return immediately. A second active export is
    /// rejected until the first result has been consumed by poll.
    pub fn submit(&mut self, request: GifExportRequest) -> Result<(), GifExportError> {
        if self.active {
            return Err(GifExportError::Busy);
        }
        let request = validate_request(request)?;
        let (result_sender, result_receiver) = mpsc::channel();
        self.active = true;
        self.result_receiver = Some(result_receiver);

        let spawn_result = thread::Builder::new()
            .name("aura-gif-export-worker".into())
            .spawn(move || {
                let result = export_gif(&request);
                let _ = result_sender.send(result);
            });
        if let Err(error) = spawn_result {
            self.active = false;
            self.result_receiver = None;
            return Err(GifExportError::Io(format!(
                "could not start GIF export worker: {error}"
            )));
        }
        Ok(())
    }

    /// Poll without blocking the caller. A terminal result is returned once;
    /// subsequent polls return GifExportStatus::Idle.
    pub fn poll(&mut self) -> GifExportStatus {
        if !self.active {
            return GifExportStatus::Idle;
        }
        let Some(receiver) = self.result_receiver.as_ref() else {
            self.active = false;
            return GifExportStatus::Failed(GifExportError::Io(
                "GIF export worker result channel is unavailable".into(),
            ));
        };

        match receiver.try_recv() {
            Ok(Ok(path)) => {
                self.active = false;
                self.result_receiver = None;
                GifExportStatus::Completed(path)
            }
            Ok(Err(error)) => {
                self.active = false;
                self.result_receiver = None;
                GifExportStatus::Failed(error)
            }
            Err(TryRecvError::Empty) => GifExportStatus::Running,
            Err(TryRecvError::Disconnected) => {
                self.active = false;
                self.result_receiver = None;
                GifExportStatus::Failed(GifExportError::Io(
                    "GIF export worker disconnected before reporting a result".into(),
                ))
            }
        }
    }

    pub fn is_busy(&self) -> bool {
        self.active
    }
}

impl Default for GifExportController {
    fn default() -> Self {
        Self::new()
    }
}

fn validate_request(request: GifExportRequest) -> Result<ValidatedRequest, GifExportError> {
    let GifExportRequest {
        source_video_path,
        ffmpeg_path,
        output_directory,
        start_seconds,
        end_seconds,
        width,
        fps,
    } = request;

    if !start_seconds.is_finite() || !end_seconds.is_finite() {
        return Err(GifExportError::InvalidRequest(
            "A/B seconds must be finite".into(),
        ));
    }
    if start_seconds < 0.0 || end_seconds <= start_seconds {
        return Err(GifExportError::InvalidRequest(
            "GIF loop must satisfy finite 0 <= A < B".into(),
        ));
    }
    if !(MIN_WIDTH..=MAX_WIDTH).contains(&width) {
        return Err(GifExportError::InvalidRequest(format!(
            "GIF width must be between {MIN_WIDTH} and {MAX_WIDTH} pixels"
        )));
    }
    if !(MIN_FPS..=MAX_FPS).contains(&fps) {
        return Err(GifExportError::InvalidRequest(format!(
            "GIF fps must be between {MIN_FPS} and {MAX_FPS}"
        )));
    }

    let requested_duration = end_seconds - start_seconds;
    let duration_seconds = requested_duration.min(MAX_DURATION_SECONDS);
    let effective_end = start_seconds + duration_seconds;
    if !effective_end.is_finite() || effective_end <= start_seconds {
        return Err(GifExportError::InvalidRequest(
            "A/B seconds are outside a representable range".into(),
        ));
    }

    Ok(ValidatedRequest {
        source_video_path,
        ffmpeg_path,
        output_directory,
        start_seconds,
        duration_seconds,
        width,
        fps,
    })
}

fn export_gif(request: &ValidatedRequest) -> Result<PathBuf, GifExportError> {
    fs::create_dir_all(&request.output_directory).map_err(io_error)?;
    let destination = unique_destination(&request.output_directory, &request.source_video_path)
        .map_err(io_error)?;
    let temporary =
        temporary_destination(&request.output_directory, &destination).map_err(io_error)?;
    let arguments = ffmpeg_arguments(request, &temporary);

    let mut command = Command::new(&request.ffmpeg_path);
    command
        .args(&arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = match command.output() {
        Ok(output) => output,
        Err(error) => {
            remove_temporary(&temporary);
            return Err(io_error(error));
        }
    };
    if !output.status.success() {
        remove_temporary(&temporary);
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(GifExportError::Ffmpeg(format!(
            "ffmpeg failed ({}): {}",
            output.status,
            truncate_error(detail.trim())
        )));
    }

    if let Err(error) = fs::rename(&temporary, &destination) {
        remove_temporary(&temporary);
        return Err(io_error(error));
    }
    Ok(destination)
}

fn ffmpeg_arguments(request: &ValidatedRequest, temporary: &Path) -> Vec<OsString> {
    let filter = format!(
        "[0:v]fps={},scale={}:{}:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a[v]",
        request.fps, request.width, -1
    );
    vec![
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-nostdin"),
        OsString::from("-ss"),
        OsString::from(format_seconds(request.start_seconds)),
        OsString::from("-t"),
        OsString::from(format_seconds(request.duration_seconds)),
        OsString::from("-i"),
        request.source_video_path.as_os_str().to_owned(),
        OsString::from("-filter_complex"),
        OsString::from(filter),
        OsString::from("-map"),
        OsString::from("[v]"),
        OsString::from("-loop"),
        OsString::from("0"),
        temporary.as_os_str().to_owned(),
    ]
}

fn format_seconds(seconds: f64) -> String {
    format!("{seconds:.6}")
}

fn unique_destination(output_directory: &Path, source_video_path: &Path) -> io::Result<PathBuf> {
    let stem = source_video_path
        .file_stem()
        .and_then(OsStr::to_str)
        .map(safe_stem)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "aura-export".into());
    for index in 0_u32..10_000 {
        let name = if index == 0 {
            format!("{stem}.gif")
        } else {
            format!("{stem}-{index}.gif")
        };
        let candidate = output_directory.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not find an unused GIF destination",
    ))
}

fn temporary_destination(output_directory: &Path, destination: &Path) -> io::Result<PathBuf> {
    let stem = destination
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("aura-export");
    for _ in 0..32 {
        let id = unique_id();
        let candidate = output_directory.join(format!(".{stem}-{id}.tmp.gif"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not find an unused temporary GIF destination",
    ))
}

fn unique_id() -> u64 {
    let sequence = NEXT_EXPORT_ID.fetch_add(1, Ordering::Relaxed);
    let clock = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    sequence ^ clock ^ u64::from(std::process::id())
}

fn safe_stem(value: &str) -> String {
    let mut result = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
            result.push(character);
        } else if !result.ends_with('_') {
            result.push('_');
        }
    }
    result.trim_matches('_').to_string()
}

fn remove_temporary(path: &Path) {
    let _ = fs::remove_file(path);
}

fn io_error(error: io::Error) -> GifExportError {
    GifExportError::Io(error.to_string())
}

fn truncate_error(message: &str) -> String {
    message.chars().take(4_096).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> GifExportRequest {
        GifExportRequest::new(
            PathBuf::from("C:\\Media\\clip.mkv"),
            PathBuf::from("C:\\Tools\\ffmpeg.exe"),
            PathBuf::from("C:\\Exports"),
            2.5,
            8.0,
            640,
            12,
        )
    }

    fn temporary_directory() -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "aura-gif-export-test-{}-{}",
            std::process::id(),
            unique_id()
        ));
        fs::create_dir_all(&directory).expect("test directory");
        directory
    }

    #[test]
    fn validation_rejects_invalid_loop_and_practical_output_bounds() {
        for (start, end) in [
            (f64::NAN, 1.0),
            (0.0, f64::INFINITY),
            (-0.1, 1.0),
            (3.0, 3.0),
            (4.0, 3.0),
        ] {
            let mut invalid = request();
            invalid.start_seconds = start;
            invalid.end_seconds = end;
            assert!(matches!(
                validate_request(invalid),
                Err(GifExportError::InvalidRequest(_))
            ));
        }

        let mut invalid_width = request();
        invalid_width.width = MAX_WIDTH + 1;
        assert!(matches!(
            validate_request(invalid_width),
            Err(GifExportError::InvalidRequest(_))
        ));

        let mut invalid_fps = request();
        invalid_fps.fps = 0;
        assert!(matches!(
            validate_request(invalid_fps),
            Err(GifExportError::InvalidRequest(_))
        ));
    }

    #[test]
    fn validation_caps_clip_duration_without_moving_a() {
        let mut long = request();
        long.start_seconds = 4.0;
        long.end_seconds = 99.0;
        let normalized = validate_request(long).expect("valid capped request");
        assert_eq!(normalized.start_seconds, 4.0);
        assert_eq!(normalized.duration_seconds, MAX_DURATION_SECONDS);
    }

    #[test]
    fn ffmpeg_arguments_use_one_palette_pipeline_and_os_paths() {
        let normalized = validate_request(request()).expect("valid request");
        let temporary = Path::new("C:\\Exports\\.clip-1.tmp.gif");
        let arguments = ffmpeg_arguments(&normalized, temporary);
        assert!(arguments.windows(2).any(|pair| {
            pair[0] == OsString::from("-i") && pair[1] == OsString::from("C:\\Media\\clip.mkv")
        }));
        let filter = arguments
            .iter()
            .find_map(|argument| {
                argument
                    .to_str()
                    .filter(|value| value.contains("palettegen"))
            })
            .expect("palette filter");
        assert!(filter.contains("fps=12"));
        assert!(filter.contains("scale=640:-1"));
        assert!(filter.contains("paletteuse"));
        assert!(arguments.ends_with(&[temporary.as_os_str().to_owned()]));
    }

    #[test]
    fn unique_destination_never_reuses_an_existing_gif() {
        let directory = temporary_directory();
        let first = unique_destination(&directory, Path::new("clip.mp4")).expect("first path");
        fs::write(&first, b"existing").expect("reserve first path");
        let second = unique_destination(&directory, Path::new("clip.mp4")).expect("second path");
        assert_ne!(first, second);
        assert_eq!(
            second.file_name().and_then(OsStr::to_str),
            Some("clip-1.gif")
        );
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn second_submit_is_busy_without_needing_a_real_ffmpeg_binary() {
        let directory = temporary_directory();
        let first = GifExportRequest::new(
            "missing-video.mkv",
            "missing-ffmpeg.exe",
            &directory,
            0.0,
            1.0,
            320,
            10,
        );
        let mut controller = GifExportController::new();
        controller.submit(first.clone()).expect("first submission");
        assert!(controller.is_busy());
        assert_eq!(controller.submit(first), Err(GifExportError::Busy));

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            if !matches!(controller.poll(), GifExportStatus::Running) {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(1));
        }
        assert!(!controller.is_busy());
        fs::remove_dir_all(directory).expect("remove test directory");
    }
}
