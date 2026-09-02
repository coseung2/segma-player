//! Embedded mpv process control for the native player surface.
//!
//! The egui thread only sends commands and clones a small shared snapshot. All
//! Win32 calls, process management, named-pipe connection work, and IPC writes
//! happen on the controller thread. Named-pipe reads are guarded by
//! `PeekNamedPipe`, so a quiet player never blocks commands.

use std::env;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[cfg(test)]
use std::collections::HashSet;
#[cfg(test)]
use std::ffi::OsString;

use serde_json::{json, Value};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Pipes::PeekNamedPipe;

use crate::jobs;
use crate::player_contract::{
    ColorRangeMode, PlayerCommand, PlayerSnapshot, SourceColorRange, SubtitleTrack, VideoFitMode,
};

#[cfg(target_os = "windows")]
use std::os::windows::io::AsRawHandle;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const CONTROL_TICK: Duration = Duration::from_millis(25);
const PIPE_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const RANGE_FILTER_LABEL: &str = "@aura-range";
const MAX_IPC_BUFFER_BYTES: usize = 1024 * 1024;
const OBSERVED_PROPERTIES: [&str; 16] = [
    "pause",
    "time-pos",
    "duration",
    "volume",
    "mute",
    "speed",
    "sub-visibility",
    "track-list",
    "seeking",
    "video-params/colorlevels",
    "path",
    "media-title",
    "video-params",
    "sub-delay",
    "ab-loop-a",
    "ab-loop-b",
];

/// Stable embedded-player flags. `window` output is intentional: in mpv's
/// DirectComposition mode the swapchain can keep the former PiP dimensions
/// after the Win32 child HWND returns to the full Player surface. Window mode
/// binds presentation to that child HWND, so `SetWindowPos` remains the one
/// authoritative size transition for Player, PiP, and every resize edge.
const MPV_EMBEDDED_ARGS: [&str; 15] = [
    "--no-config",
    "--idle=yes",
    "--keep-open=yes",
    "--terminal=no",
    "--input-terminal=no",
    "--input-default-bindings=no",
    "--osc=yes",
    "--script-opts=osc-visibility=never",
    "--really-quiet",
    "--vo=gpu-next",
    "--gpu-api=d3d11",
    "--d3d11-output-mode=window",
    "--video-output-levels=full",
    "--sub-auto=fuzzy",
    "--force-window=no",
];

static PIPE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Non-blocking UI handle for the embedded player process.
pub struct PlayerController {
    snapshot: Arc<Mutex<PlayerSnapshot>>,
    commands: Sender<PlayerCommand>,
    worker: Option<JoinHandle<()>>,
}

impl PlayerController {
    pub fn new() -> Self {
        let snapshot = Arc::new(Mutex::new(PlayerSnapshot::default()));
        let (commands, receiver) = mpsc::channel();
        let worker_snapshot = Arc::clone(&snapshot);
        let worker = thread::Builder::new()
            .name("aura-player-control".into())
            .spawn(move || run_controller(worker_snapshot, receiver));

        match worker {
            Ok(worker) => Self {
                snapshot,
                commands,
                worker: Some(worker),
            },
            Err(_) => {
                snapshot_lock(&snapshot).error =
                    Some("플레이어 작업 스레드를 시작하지 못했습니다.".into());
                Self {
                    snapshot,
                    commands,
                    worker: None,
                }
            }
        }
    }

    /// Returns an inexpensive point-in-time copy for rendering.
    pub fn snapshot(&self) -> PlayerSnapshot {
        snapshot_lock(&self.snapshot).clone()
    }

    /// Enqueues work without waiting for mpv or Win32.
    pub fn send(&self, command: PlayerCommand) -> Result<(), mpsc::SendError<PlayerCommand>> {
        self.commands.send(command)
    }

    pub fn shutdown(&mut self) {
        let _ = self.commands.send(PlayerCommand::Shutdown);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Default for PlayerController {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for PlayerController {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn snapshot_lock(snapshot: &Arc<Mutex<PlayerSnapshot>>) -> MutexGuard<'_, PlayerSnapshot> {
    snapshot
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn set_runtime_error(snapshot: &Arc<Mutex<PlayerSnapshot>>, message: impl Into<String>) {
    snapshot_lock(snapshot).error = Some(message.into());
}

fn run_controller(snapshot: Arc<Mutex<PlayerSnapshot>>, commands: Receiver<PlayerCommand>) {
    let executable = resolve_mpv_executable();
    {
        let mut current = snapshot_lock(&snapshot);
        match &executable {
            Ok(_) => current.engine_available = true,
            Err(_) => {
                current.engine_available = false;
                current.error = Some("mpv.exe를 찾지 못했습니다.".into());
            }
        }
    }

    let mut runtime = BackendRuntime::new(snapshot, executable.ok());
    let mut shutting_down = false;

    while !shutting_down {
        runtime.drain_ipc_events();
        runtime.check_child();

        match commands.recv_timeout(CONTROL_TICK) {
            Ok(PlayerCommand::Shutdown) => shutting_down = true,
            Ok(command) => runtime.handle(command),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => shutting_down = true,
        }
    }

    runtime.shutdown();
}

struct IpcConnection {
    pipe: File,
    pending: Vec<u8>,
}

struct BackendRuntime {
    snapshot: Arc<Mutex<PlayerSnapshot>>,
    mpv_executable: Option<PathBuf>,
    video_window: Option<HWND>,
    child: Option<Child>,
    ipc: Option<IpcConnection>,
    pending_load: Option<PathBuf>,
    applied_color_range: ColorRangeMode,
}

impl BackendRuntime {
    fn new(snapshot: Arc<Mutex<PlayerSnapshot>>, mpv_executable: Option<PathBuf>) -> Self {
        Self {
            snapshot,
            mpv_executable,
            video_window: None,
            child: None,
            ipc: None,
            pending_load: None,
            applied_color_range: ColorRangeMode::Auto,
        }
    }

    fn handle(&mut self, command: PlayerCommand) {
        match command {
            PlayerCommand::SetVideoWindow(window) => self.set_video_window(window),
            PlayerCommand::SetFullscreenControls(visible) => {
                if self.ensure_engine() {
                    self.send_command(&PlayerCommand::SetFullscreenControls(visible));
                }
            }
            PlayerCommand::Load(path) => {
                self.pending_load = Some(path.clone());
                if self.ipc.is_some() {
                    self.send_json(command_json(&PlayerCommand::Load(path)));
                } else {
                    let _ = self.ensure_engine();
                }
            }
            PlayerCommand::SetColorRange(mode) => {
                snapshot_lock(&self.snapshot).color_range_mode = mode;
                if self.ipc.is_some() || self.ensure_engine() {
                    for transition in color_range_transition(self.applied_color_range, mode) {
                        self.send_json(command_json(&PlayerCommand::SetColorRange(transition)));
                    }
                    self.applied_color_range = mode;
                }
            }
            PlayerCommand::SetSubtitleDelay(delay) if delay.is_finite() => {
                snapshot_lock(&self.snapshot).subtitle_delay = delay;
                if self.ensure_engine() {
                    self.send_command(&PlayerCommand::SetSubtitleDelay(delay));
                }
            }
            PlayerCommand::SetSubtitleDelay(_) => {}
            PlayerCommand::SetVideoFitMode(mode) => {
                snapshot_lock(&self.snapshot).video_fit_mode = mode;
                if self.ensure_engine() {
                    self.send_command(&PlayerCommand::SetVideoFitMode(mode));
                }
            }
            PlayerCommand::SetLoopA(value) => {
                let Some(value) = normalize_loop_point(value) else {
                    return;
                };
                snapshot_lock(&self.snapshot).loop_a = value;
                if self.ensure_engine() {
                    self.send_command(&PlayerCommand::SetLoopA(value));
                }
            }
            PlayerCommand::SetLoopB(value) => {
                let Some(value) = normalize_loop_point(value) else {
                    return;
                };
                snapshot_lock(&self.snapshot).loop_b = value;
                if self.ensure_engine() {
                    self.send_command(&PlayerCommand::SetLoopB(value));
                }
            }
            PlayerCommand::ClearLoop => {
                {
                    let mut snapshot = snapshot_lock(&self.snapshot);
                    snapshot.loop_a = None;
                    snapshot.loop_b = None;
                }
                if self.ensure_engine() {
                    self.send_command(&PlayerCommand::ClearLoop);
                }
            }
            PlayerCommand::Stop => {
                self.pending_load = None;
                if self.ipc.is_some() {
                    self.send_json(command_json(&PlayerCommand::Stop));
                }
                reset_stopped_snapshot(&mut snapshot_lock(&self.snapshot));
            }
            PlayerCommand::Shutdown => {}
            command => {
                if self.ensure_engine() {
                    self.send_json(command_json(&command));
                }
            }
        }
    }

    fn set_video_window(&mut self, window: isize) {
        if window == 0 {
            set_runtime_error(&self.snapshot, "플레이어 창을 연결하지 못했습니다.");
            return;
        }
        let window = HWND(window as *mut core::ffi::c_void);
        if self.video_window == Some(window) {
            let _ = self.ensure_engine();
            return;
        }

        self.stop_process();
        self.video_window = Some(window);
        let _ = self.ensure_engine();
    }

    fn ensure_engine(&mut self) -> bool {
        if self.child.is_some() && self.ipc.is_some() {
            return true;
        }
        let Some(executable) = self.mpv_executable.clone() else {
            set_runtime_error(&self.snapshot, "mpv.exe를 찾지 못했습니다.");
            return false;
        };
        let Some(window) = self.video_window else {
            return false;
        };

        match launch_mpv(&executable, window) {
            Ok((child, ipc)) => {
                self.child = Some(child);
                self.ipc = Some(ipc);
                {
                    let mut current = snapshot_lock(&self.snapshot);
                    current.engine_available = true;
                    current.error = None;
                }
                self.observe_properties();

                let color_mode = snapshot_lock(&self.snapshot).color_range_mode;
                if color_mode != ColorRangeMode::Auto {
                    self.send_json(command_json(&PlayerCommand::SetColorRange(color_mode)));
                    self.applied_color_range = color_mode;
                }
                if let Some(path) = self.pending_load.clone() {
                    self.send_json(command_json(&PlayerCommand::Load(path)));
                }
                true
            }
            Err(_) => {
                self.stop_process();
                let mut current = snapshot_lock(&self.snapshot);
                current.engine_available = false;
                current.error = Some("mpv를 시작하지 못했습니다.".into());
                false
            }
        }
    }

    fn observe_properties(&mut self) {
        for (index, property) in OBSERVED_PROPERTIES.iter().enumerate() {
            self.send_json(Some(json!({
                "command": ["observe_property", index + 1, property]
            })));
        }
    }

    fn send_json(&mut self, message: Option<Value>) {
        let Some(message) = message else { return };
        let Some(ipc) = self.ipc.as_mut() else { return };
        if write_ipc_message(&mut ipc.pipe, &message).is_err() {
            set_runtime_error(&self.snapshot, "mpv와 통신하지 못했습니다.");
            self.stop_process();
        }
    }

    fn send_command(&mut self, command: &PlayerCommand) {
        for message in command_json_sequence(command) {
            self.send_json(Some(message));
        }
    }

    fn drain_ipc_events(&mut self) {
        let messages = match self.ipc.as_mut() {
            Some(ipc) => read_available_messages(ipc),
            None => return,
        };
        match messages {
            Ok(messages) => {
                let mut snapshot = snapshot_lock(&self.snapshot);
                for value in messages {
                    apply_ipc_message(&mut snapshot, &value);
                }
            }
            Err(error) => {
                diagnostic(format!("reader: error {error}"));
                set_runtime_error(&self.snapshot, "mpv와 통신이 끊겼습니다.");
                self.stop_process();
            }
        }
    }

    fn check_child(&mut self) {
        let exited = match self.child.as_mut() {
            Some(child) => child.try_wait().ok().flatten().is_some(),
            None => false,
        };
        if !exited {
            return;
        }

        self.child.take();
        self.ipc = None;
        self.applied_color_range = ColorRangeMode::Auto;
        let mut current = snapshot_lock(&self.snapshot);
        current.engine_available = false;
        current.paused = true;
        current.seeking = false;
        current.error = Some("mpv가 예기치 않게 종료되었습니다.".into());
    }

    fn stop_process(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.child = None;
        self.ipc = None;
        self.applied_color_range = ColorRangeMode::Auto;
    }

    fn shutdown(&mut self) {
        self.stop_process();
        self.video_window = None;
        let mut current = snapshot_lock(&self.snapshot);
        current.engine_available = false;
        current.paused = true;
        current.seeking = false;
    }
}

fn launch_mpv(executable: &Path, window: HWND) -> io::Result<(Child, IpcConnection)> {
    let pipe_name = unique_pipe_name();
    let subtitle_directory = jobs::downloads_dir()?.join("Subtitles");
    let window_id = window.0 as usize;
    let mut command = Command::new(executable);
    command
        .args(MPV_EMBEDDED_ARGS)
        .arg(format!("--sub-file-paths={}", subtitle_directory.display()))
        .arg(format!("--input-ipc-server={pipe_name}"))
        .arg(format!("--wid={window_id}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command.spawn()?;
    match connect_ipc(&pipe_name, &mut child) {
        Ok(ipc) => Ok((child, ipc)),
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(error)
        }
    }
}

fn unique_pipe_name() -> String {
    let sequence = PIPE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!(
        r"\\.\pipe\aura-media-player-{}-{sequence}",
        std::process::id()
    )
}

fn connect_ipc(pipe_name: &str, child: &mut Child) -> io::Result<IpcConnection> {
    let deadline = Instant::now() + PIPE_CONNECT_TIMEOUT;
    loop {
        match OpenOptions::new().read(true).write(true).open(pipe_name) {
            Ok(pipe) => {
                return Ok(IpcConnection {
                    pipe,
                    pending: Vec::new(),
                })
            }
            Err(error) => {
                if child.try_wait()?.is_some() {
                    return Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "mpv exited before IPC became ready",
                    ));
                }
                if Instant::now() >= deadline {
                    return Err(error);
                }
                thread::sleep(CONTROL_TICK);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn read_available_messages(ipc: &mut IpcConnection) -> io::Result<Vec<Value>> {
    loop {
        let mut available = 0_u32;
        let handle = windows::Win32::Foundation::HANDLE(ipc.pipe.as_raw_handle());
        unsafe {
            PeekNamedPipe(handle, None, 0, None, Some(&mut available), None)
                .map_err(io::Error::other)?;
        }
        if available == 0 {
            break;
        }

        let readable = usize::try_from(available)
            .unwrap_or(MAX_IPC_BUFFER_BYTES)
            .min(MAX_IPC_BUFFER_BYTES);
        let start = ipc.pending.len();
        ipc.pending.resize(start + readable, 0);
        let read = ipc.pipe.read(&mut ipc.pending[start..])?;
        ipc.pending.truncate(start + read);
        if read == 0 {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "mpv IPC closed"));
        }
        if ipc.pending.len() > MAX_IPC_BUFFER_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "mpv IPC message exceeded limit",
            ));
        }
    }

    Ok(take_complete_json_lines(&mut ipc.pending))
}

#[cfg(not(target_os = "windows"))]
fn read_available_messages(_ipc: &mut IpcConnection) -> io::Result<Vec<Value>> {
    Ok(Vec::new())
}

fn take_complete_json_lines(pending: &mut Vec<u8>) -> Vec<Value> {
    let complete_end = pending
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    if complete_end == 0 {
        return Vec::new();
    }

    let complete = pending.drain(..complete_end).collect::<Vec<_>>();
    complete
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            diagnostic(format!("reader: {}", String::from_utf8_lossy(line)));
            serde_json::from_slice::<Value>(line).ok()
        })
        .collect()
}

fn write_ipc_message(writer: &mut File, message: &Value) -> io::Result<()> {
    diagnostic(format!("writer: {message}"));
    serde_json::to_writer(&mut *writer, message).map_err(io::Error::other)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

/// Opt-in IPC tracing for local diagnosis. Writes only when
/// `AURA_PLAYER_LOG` names a file, so shipped builds stay silent.
fn diagnostic(message: impl AsRef<str>) {
    let Some(path) = env::var_os("AURA_PLAYER_LOG") else {
        return;
    };
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", message.as_ref());
    }
}

fn command_json(command: &PlayerCommand) -> Option<Value> {
    match command {
        PlayerCommand::Load(path) => Some(json!({
            "command": ["loadfile", path.to_string_lossy(), "replace"],
            "async": true
        })),
        PlayerCommand::TogglePause => Some(json!({ "command": ["cycle", "pause"] })),
        PlayerCommand::SeekAbsolute(position) if position.is_finite() => Some(json!({
            "command": ["seek", position.max(0.0), "absolute+exact"]
        })),
        PlayerCommand::SeekRelative(offset) if offset.is_finite() => Some(json!({
            "command": ["seek", offset, "relative"]
        })),
        PlayerCommand::SetVolume(volume) if volume.is_finite() => Some(json!({
            "command": ["set_property", "volume", volume.clamp(0.0, 100.0)]
        })),
        PlayerCommand::ToggleMute => Some(json!({ "command": ["cycle", "mute"] })),
        PlayerCommand::SetSpeed(speed) if speed.is_finite() => Some(json!({
            "command": ["set_property", "speed", speed.clamp(0.25, 4.0)]
        })),
        PlayerCommand::SetSubtitleDelay(delay) if delay.is_finite() => Some(json!({
            "command": ["set_property", "sub-delay", delay]
        })),
        PlayerCommand::ToggleSubtitles => Some(json!({ "command": ["cycle", "sub-visibility"] })),
        PlayerCommand::SelectSubtitle(Some(id)) => {
            Some(json!({ "command": ["set_property", "sid", id] }))
        }
        PlayerCommand::SelectSubtitle(None) => {
            Some(json!({ "command": ["set_property", "sid", "no"] }))
        }
        PlayerCommand::SetColorRange(ColorRangeMode::Auto) => {
            Some(json!({ "command": ["vf", "remove", RANGE_FILTER_LABEL] }))
        }
        PlayerCommand::SetColorRange(ColorRangeMode::Limited) => Some(json!({
            "command": ["vf", "add", "@aura-range:format=colorlevels=limited"]
        })),
        PlayerCommand::SetColorRange(ColorRangeMode::Full) => Some(json!({
            "command": ["vf", "add", "@aura-range:format=colorlevels=full"]
        })),
        PlayerCommand::SetLoopA(value) => loop_property_json("ab-loop-a", *value),
        PlayerCommand::SetLoopB(value) => loop_property_json("ab-loop-b", *value),
        PlayerCommand::StepFrameForward => Some(json!({ "command": ["frame-step"] })),
        PlayerCommand::StepFrameBackward => Some(json!({ "command": ["frame-back-step"] })),
        PlayerCommand::Stop => Some(json!({ "command": ["stop"] })),
        PlayerCommand::SetFullscreenControls(visible) => Some(json!({
            "command": [
                "script-message",
                "osc-visibility",
                if *visible { "auto" } else { "never" },
                "no-osd"
            ]
        })),
        PlayerCommand::SetVideoWindow(_)
        | PlayerCommand::Shutdown
        | PlayerCommand::SetSubtitleDelay(_)
        | PlayerCommand::SetVideoFitMode(_)
        | PlayerCommand::ClearLoop
        | PlayerCommand::SeekAbsolute(_)
        | PlayerCommand::SeekRelative(_)
        | PlayerCommand::SetVolume(_)
        | PlayerCommand::SetSpeed(_) => None,
    }
}

fn command_json_sequence(command: &PlayerCommand) -> Vec<Value> {
    match command {
        PlayerCommand::SetVideoFitMode(mode) => {
            let (keep_aspect, panscan) = match mode {
                VideoFitMode::Fit => ("yes", 0),
                VideoFitMode::Fill => ("yes", 1),
                VideoFitMode::Stretch => ("no", 0),
            };
            vec![
                json!({ "command": ["set_property", "keepaspect", keep_aspect] }),
                json!({ "command": ["set_property", "panscan", panscan] }),
            ]
        }
        PlayerCommand::ClearLoop => [PlayerCommand::SetLoopA(None), PlayerCommand::SetLoopB(None)]
            .iter()
            .filter_map(command_json)
            .collect(),
        _ => command_json(command).into_iter().collect(),
    }
}

fn normalize_loop_point(value: Option<f64>) -> Option<Option<f64>> {
    match value {
        Some(value) if value.is_finite() => Some(Some(value.max(0.0))),
        Some(_) => None,
        None => Some(None),
    }
}

fn loop_property_json(property: &str, value: Option<f64>) -> Option<Value> {
    let value = normalize_loop_point(value)?;
    Some(json!({
        "command": ["set_property", property, value.map_or_else(|| Value::String("no".into()), |value| json!(value))]
    }))
}

fn color_range_transition(
    current: ColorRangeMode,
    requested: ColorRangeMode,
) -> Vec<ColorRangeMode> {
    let mut commands = Vec::with_capacity(2);
    if current != ColorRangeMode::Auto {
        commands.push(ColorRangeMode::Auto);
    }
    if requested != ColorRangeMode::Auto {
        commands.push(requested);
    }
    commands
}

fn apply_ipc_message(snapshot: &mut PlayerSnapshot, message: &Value) {
    match message.get("event").and_then(Value::as_str) {
        Some("property-change") => apply_property_change(snapshot, message),
        Some("start-file") => {
            snapshot.error = None;
            snapshot.seeking = true;
        }
        Some("file-loaded") => {
            snapshot.error = None;
            snapshot.seeking = false;
        }
        Some("playback-restart") => snapshot.seeking = false,
        Some("end-file") => apply_end_file(snapshot, message),
        Some("shutdown") => {
            snapshot.engine_available = false;
            snapshot.paused = true;
            snapshot.seeking = false;
        }
        Some(_) => {}
        None => {
            if message
                .get("error")
                .and_then(Value::as_str)
                .is_some_and(|error| error != "success")
            {
                snapshot.error = Some("플레이어 명령을 처리하지 못했습니다.".into());
            }
        }
    }
}

fn apply_property_change(snapshot: &mut PlayerSnapshot, message: &Value) {
    let Some(name) = message.get("name").and_then(Value::as_str) else {
        return;
    };
    let Some(data) = message.get("data") else {
        return;
    };

    match name {
        "pause" => {
            if let Some(value) = data.as_bool() {
                snapshot.paused = value;
            }
        }
        "time-pos" => set_nonnegative_number(&mut snapshot.position, data),
        "duration" => set_nonnegative_number(&mut snapshot.duration, data),
        "volume" => set_nonnegative_number(&mut snapshot.volume, data),
        "mute" => {
            if let Some(value) = data.as_bool() {
                snapshot.muted = value;
            }
        }
        "speed" => set_positive_number(&mut snapshot.speed, data),
        "sub-delay" => set_finite_number(&mut snapshot.subtitle_delay, data),
        "ab-loop-a" => set_optional_nonnegative_number(&mut snapshot.loop_a, data),
        "ab-loop-b" => set_optional_nonnegative_number(&mut snapshot.loop_b, data),
        "sub-visibility" => {
            if let Some(value) = data.as_bool() {
                snapshot.subtitle_visible = value;
            }
        }
        "track-list" => snapshot.subtitle_tracks = parse_subtitle_tracks(data),
        "seeking" => {
            if let Some(value) = data.as_bool() {
                snapshot.seeking = value;
            }
        }
        "video-params/colorlevels" => {
            snapshot.detected_color_range = parse_color_range(data.as_str());
        }
        "video-params" => {
            if let Some(levels) = data.get("colorlevels").and_then(Value::as_str) {
                snapshot.detected_color_range = parse_color_range(Some(levels));
            }
        }
        "path" => {
            snapshot.loaded_path = data
                .as_str()
                .filter(|path| !path.is_empty())
                .map(PathBuf::from);
        }
        "media-title" => {
            if let Some(value) = data.as_str() {
                snapshot.title = value.to_string();
            }
        }
        _ => {}
    }
}

fn set_nonnegative_number(target: &mut f64, value: &Value) {
    if let Some(number) = value.as_f64().filter(|number| number.is_finite()) {
        *target = number.max(0.0);
    }
}

fn set_finite_number(target: &mut f64, value: &Value) {
    if let Some(number) = value.as_f64().filter(|number| number.is_finite()) {
        *target = number;
    }
}

fn set_optional_nonnegative_number(target: &mut Option<f64>, value: &Value) {
    if value.is_null() || value.as_str() == Some("no") {
        *target = None;
    } else if let Some(number) = value.as_f64().filter(|number| number.is_finite()) {
        *target = Some(number.max(0.0));
    }
}

fn set_positive_number(target: &mut f64, value: &Value) {
    if let Some(number) = value
        .as_f64()
        .filter(|number| number.is_finite() && *number > 0.0)
    {
        *target = number;
    }
}

fn parse_subtitle_tracks(value: &Value) -> Vec<SubtitleTrack> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|track| track.get("type").and_then(Value::as_str) == Some("sub"))
        .filter_map(|track| {
            let id = track.get("id")?.as_i64()?;
            let external = track
                .get("external")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let title = track
                .get("title")
                .and_then(Value::as_str)
                .filter(|title| !title.trim().is_empty())
                .map(str::to_owned)
                .or_else(|| {
                    track
                        .get("external-filename")
                        .and_then(Value::as_str)
                        .and_then(|path| Path::new(path).file_name())
                        .map(|name| name.to_string_lossy().into_owned())
                })
                .unwrap_or_else(|| format!("자막 {id}"));
            Some(SubtitleTrack {
                id,
                title,
                language: track.get("lang").and_then(Value::as_str).map(str::to_owned),
                selected: track
                    .get("selected")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                external,
            })
        })
        .collect()
}

fn parse_color_range(value: Option<&str>) -> Option<SourceColorRange> {
    match value?.trim().to_ascii_lowercase().as_str() {
        "limited" | "tv" | "mpeg" => Some(SourceColorRange::Limited),
        "full" | "pc" | "jpeg" => Some(SourceColorRange::Full),
        _ => None,
    }
}

fn apply_end_file(snapshot: &mut PlayerSnapshot, message: &Value) {
    snapshot.paused = true;
    snapshot.seeking = false;
    match message.get("reason").and_then(Value::as_str) {
        Some("eof") => snapshot.position = snapshot.duration,
        Some("stop") | Some("quit") => reset_stopped_snapshot(snapshot),
        Some("error") => snapshot.error = Some("미디어를 재생하지 못했습니다.".into()),
        Some("redirect") | Some("unknown") | Some(_) | None => {}
    }
}

fn reset_stopped_snapshot(snapshot: &mut PlayerSnapshot) {
    snapshot.loaded_path = None;
    snapshot.title.clear();
    snapshot.duration = 0.0;
    snapshot.position = 0.0;
    snapshot.paused = true;
    snapshot.seeking = false;
    snapshot.subtitle_tracks.clear();
    snapshot.detected_color_range = None;
    snapshot.loop_a = None;
    snapshot.loop_b = None;
}

fn resolve_mpv_executable() -> io::Result<PathBuf> {
    if let Some(configured) = env::var_os("AURA_MPV_EXE").filter(|value| !value.is_empty()) {
        let configured = PathBuf::from(configured);
        if configured.is_file() {
            return Ok(configured);
        }
    }

    let executable = env::current_exe()?;
    let beside_manager = executable
        .parent()
        .unwrap_or(Path::new("."))
        .join("tools")
        .join("mpv")
        .join("mpv.exe");
    if beside_manager.is_file() {
        return Ok(beside_manager);
    }

    let installed = jobs::companion_root()?
        .join("tools")
        .join("mpv")
        .join("mpv.exe");
    installed
        .is_file()
        .then_some(installed)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "mpv.exe is unavailable"))
}

#[cfg(test)]
fn mpv_path_candidates(
    configured: Option<OsString>,
    manager_executable: &Path,
    companion_root: &Path,
) -> Vec<PathBuf> {
    let mut candidates = Vec::with_capacity(3);
    if let Some(configured) = configured.filter(|value| !value.is_empty()) {
        candidates.push(PathBuf::from(configured));
    }
    candidates.push(
        manager_executable
            .parent()
            .unwrap_or(Path::new("."))
            .join("tools")
            .join("mpv")
            .join("mpv.exe"),
    );
    candidates.push(companion_root.join("tools").join("mpv").join("mpv.exe"));

    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|candidate| seen.insert(candidate.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipc_property_events_update_public_snapshot_without_assuming_fields() {
        let mut snapshot = PlayerSnapshot::default();
        apply_ipc_message(
            &mut snapshot,
            &json!({"event":"property-change","name":"time-pos","data":42.5}),
        );
        apply_ipc_message(
            &mut snapshot,
            &json!({"event":"property-change","name":"pause","data":false}),
        );
        apply_ipc_message(
            &mut snapshot,
            &json!({
                "event":"property-change",
                "name":"track-list",
                "data":[
                    {"id":1,"type":"video","selected":true},
                    {"id":2,"type":"sub","title":"Embedded","lang":"en","selected":false},
                    {"id":3,"type":"sub","external":true,"external-filename":"C:\\Subs\\movie.ko.vtt","selected":true},
                    {"type":"sub","title":"missing id"},
                    null
                ]
            }),
        );
        apply_ipc_message(
            &mut snapshot,
            &json!({"event":"property-change","name":"video-params","data":{"colorlevels":"full"}}),
        );
        apply_ipc_message(
            &mut snapshot,
            &json!({"event":"property-change","name":"future-property"}),
        );

        assert_eq!(snapshot.position, 42.5);
        assert!(!snapshot.paused);
        assert_eq!(snapshot.subtitle_tracks.len(), 2);
        assert_eq!(snapshot.subtitle_tracks[0].title, "Embedded");
        assert!(!snapshot.subtitle_tracks[0].external);
        assert_eq!(snapshot.subtitle_tracks[1].title, "movie.ko.vtt");
        assert!(snapshot.subtitle_tracks[1].external);
        assert!(snapshot.subtitle_tracks[1].selected);
        assert_eq!(snapshot.detected_color_range, Some(SourceColorRange::Full));
    }

    #[test]
    fn end_file_events_distinguish_eof_stop_and_failure() {
        let mut snapshot = PlayerSnapshot {
            loaded_path: Some(PathBuf::from("movie.mkv")),
            duration: 90.0,
            position: 10.0,
            ..PlayerSnapshot::default()
        };
        apply_ipc_message(&mut snapshot, &json!({"event":"end-file","reason":"eof"}));
        assert_eq!(snapshot.position, 90.0);
        assert!(snapshot.loaded_path.is_some());

        apply_ipc_message(
            &mut snapshot,
            &json!({"event":"end-file","reason":"error","file_error":"loading failed"}),
        );
        assert_eq!(
            snapshot.error.as_deref(),
            Some("미디어를 재생하지 못했습니다.")
        );

        apply_ipc_message(&mut snapshot, &json!({"event":"end-file","reason":"stop"}));
        assert!(snapshot.loaded_path.is_none());
        assert_eq!(snapshot.duration, 0.0);
    }

    #[test]
    fn color_range_parser_accepts_mpv_and_legacy_aliases() {
        for value in ["limited", "tv", "MPEG"] {
            assert_eq!(
                parse_color_range(Some(value)),
                Some(SourceColorRange::Limited)
            );
        }
        for value in ["full", "pc", "JPEG"] {
            assert_eq!(parse_color_range(Some(value)), Some(SourceColorRange::Full));
        }
        assert_eq!(parse_color_range(Some("auto")), None);
        assert_eq!(parse_color_range(Some("future-range")), None);
        assert_eq!(parse_color_range(None), None);
    }

    #[test]
    fn ipc_line_buffer_keeps_partial_json_for_the_next_read() {
        let mut pending = br#"{"event":"file-loaded"}
{"event":"property-change","name":"time-pos","data":12"#
            .to_vec();
        let first = take_complete_json_lines(&mut pending);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["event"], "file-loaded");
        assert!(!pending.is_empty());

        pending.extend_from_slice(b".5}\n");
        let second = take_complete_json_lines(&mut pending);
        assert_eq!(second.len(), 1);
        assert_eq!(second[0]["data"], 12.5);
        assert!(pending.is_empty());
    }

    #[test]
    fn headless_mpv_accepts_load_after_ipc_has_been_polled() {
        let Some(media) = env::var_os("AURA_PLAYER_TEST_MEDIA").map(PathBuf::from) else {
            return;
        };
        assert!(media.is_file(), "headless test media must exist");
        let executable = resolve_mpv_executable().expect("headless mpv executable");
        let pipe_name = unique_pipe_name();
        let mut command = Command::new(executable);
        command
            .args([
                "--no-config",
                "--idle=yes",
                "--terminal=no",
                "--input-terminal=no",
                "--input-default-bindings=no",
                "--osc=no",
                "--vo=null",
                "--ao=null",
            ])
            .arg(format!("--input-ipc-server={pipe_name}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        command.creation_flags(CREATE_NO_WINDOW);

        let mut child = command.spawn().expect("headless mpv starts");
        let mut ipc = connect_ipc(&pipe_name, &mut child).expect("headless IPC connects");
        write_ipc_message(
            &mut ipc.pipe,
            &json!({"command":["observe_property",1,"pause"]}),
        )
        .expect("first IPC write");

        // Poll once before loading. The former blocking reader held the shared
        // synchronous handle here and prevented the second write indefinitely.
        let poll_deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < poll_deadline {
            let _ = read_available_messages(&mut ipc).expect("initial IPC poll");
            thread::sleep(Duration::from_millis(10));
        }
        write_ipc_message(
            &mut ipc.pipe,
            &command_json(&PlayerCommand::Load(media)).expect("load command"),
        )
        .expect("load IPC write after polling");

        let deadline = Instant::now() + Duration::from_secs(8);
        let mut loaded = false;
        while Instant::now() < deadline && !loaded {
            loaded = read_available_messages(&mut ipc)
                .expect("playback IPC poll")
                .iter()
                .any(|message| message.get("event").and_then(Value::as_str) == Some("file-loaded"));
            thread::sleep(Duration::from_millis(10));
        }

        let _ = write_ipc_message(&mut ipc.pipe, &json!({"command":["quit"]}));
        let exit_deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < exit_deadline && child.try_wait().ok().flatten().is_none() {
            thread::sleep(Duration::from_millis(10));
        }
        if child.try_wait().ok().flatten().is_none() {
            let _ = child.kill();
            let _ = child.wait();
        }
        assert!(loaded, "headless mpv must report file-loaded");
    }

    #[test]
    fn commands_use_native_json_arguments_and_named_range_filter() {
        assert_eq!(
            command_json(&PlayerCommand::Load(PathBuf::from("C:\\Media\\clip.mkv"))),
            Some(json!({
                "command":["loadfile","C:\\Media\\clip.mkv","replace"],
                "async":true
            }))
        );
        assert_eq!(
            command_json(&PlayerCommand::SeekAbsolute(12.25)),
            Some(json!({"command":["seek",12.25,"absolute+exact"]}))
        );
        assert_eq!(
            command_json(&PlayerCommand::SeekRelative(-5.0)),
            Some(json!({"command":["seek",-5.0,"relative"]}))
        );
        assert_eq!(
            command_json(&PlayerCommand::SetVolume(150.0)),
            Some(json!({"command":["set_property","volume",100.0]}))
        );
        assert_eq!(
            command_json(&PlayerCommand::SelectSubtitle(None)),
            Some(json!({"command":["set_property","sid","no"]}))
        );
        assert_eq!(
            command_json(&PlayerCommand::SetColorRange(ColorRangeMode::Auto)),
            Some(json!({"command":["vf","remove","@aura-range"]}))
        );
        assert_eq!(
            command_json(&PlayerCommand::SetColorRange(ColorRangeMode::Limited)),
            Some(json!({"command":["vf","add","@aura-range:format=colorlevels=limited"]}))
        );
        assert_eq!(
            command_json(&PlayerCommand::SetColorRange(ColorRangeMode::Full)),
            Some(json!({"command":["vf","add","@aura-range:format=colorlevels=full"]}))
        );
        assert_eq!(
            command_json(&PlayerCommand::SetFullscreenControls(true)),
            Some(json!({"command":["script-message","osc-visibility","auto","no-osd"]}))
        );
        assert_eq!(
            command_json(&PlayerCommand::SetFullscreenControls(false)),
            Some(json!({"command":["script-message","osc-visibility","never","no-osd"]}))
        );
        assert!(command_json(&PlayerCommand::SeekAbsolute(f64::NAN)).is_none());
    }

    #[test]
    fn new_commands_emit_ordered_mpv_sequences_and_reject_nonfinite_values() {
        assert_eq!(
            command_json(&PlayerCommand::SetSubtitleDelay(-1.25)),
            Some(json!({"command":["set_property","sub-delay",-1.25]}))
        );
        assert_eq!(
            command_json_sequence(&PlayerCommand::SetVideoFitMode(VideoFitMode::Fit)),
            vec![
                json!({"command":["set_property","keepaspect","yes"]}),
                json!({"command":["set_property","panscan",0]}),
            ]
        );
        assert_eq!(
            command_json_sequence(&PlayerCommand::SetVideoFitMode(VideoFitMode::Fill)),
            vec![
                json!({"command":["set_property","keepaspect","yes"]}),
                json!({"command":["set_property","panscan",1]}),
            ]
        );
        assert_eq!(
            command_json_sequence(&PlayerCommand::SetVideoFitMode(VideoFitMode::Stretch)),
            vec![
                json!({"command":["set_property","keepaspect","no"]}),
                json!({"command":["set_property","panscan",0]}),
            ]
        );
        assert_eq!(
            command_json_sequence(&PlayerCommand::ClearLoop),
            vec![
                json!({"command":["set_property","ab-loop-a","no"]}),
                json!({"command":["set_property","ab-loop-b","no"]}),
            ]
        );
        assert_eq!(
            command_json(&PlayerCommand::StepFrameForward),
            Some(json!({"command":["frame-step"]}))
        );
        assert_eq!(
            command_json(&PlayerCommand::StepFrameBackward),
            Some(json!({"command":["frame-back-step"]}))
        );
        assert!(command_json(&PlayerCommand::SetSubtitleDelay(f64::NAN)).is_none());
        assert!(command_json(&PlayerCommand::SetLoopA(Some(f64::INFINITY))).is_none());
    }

    #[test]
    fn embedded_mpv_uses_the_child_window_instead_of_direct_composition() {
        assert!(MPV_EMBEDDED_ARGS.contains(&"--vo=gpu-next"));
        assert!(MPV_EMBEDDED_ARGS.contains(&"--gpu-api=d3d11"));
        assert!(MPV_EMBEDDED_ARGS.contains(&"--d3d11-output-mode=window"));
        assert!(MPV_EMBEDDED_ARGS.contains(&"--osc=yes"));
        assert!(MPV_EMBEDDED_ARGS.contains(&"--script-opts=osc-visibility=never"));
        assert!(!MPV_EMBEDDED_ARGS
            .iter()
            .any(|argument| *argument == "--d3d11-output-mode=composition"));
    }

    #[test]
    fn observed_subtitle_delay_and_loop_properties_keep_snapshot_safe() {
        let mut snapshot = PlayerSnapshot::default();
        apply_ipc_message(
            &mut snapshot,
            &json!({"event":"property-change","name":"sub-delay","data":-2.5}),
        );
        apply_ipc_message(
            &mut snapshot,
            &json!({"event":"property-change","name":"ab-loop-a","data":12.0}),
        );
        apply_ipc_message(
            &mut snapshot,
            &json!({"event":"property-change","name":"ab-loop-b","data":30.0}),
        );

        assert_eq!(snapshot.subtitle_delay, -2.5);
        assert_eq!(snapshot.loop_a, Some(12.0));
        assert_eq!(snapshot.loop_b, Some(30.0));

        apply_ipc_message(
            &mut snapshot,
            &json!({"event":"property-change","name":"ab-loop-a","data":null}),
        );
        apply_ipc_message(
            &mut snapshot,
            &json!({"event":"property-change","name":"ab-loop-b","data":"no"}),
        );
        assert_eq!(snapshot.loop_a, None);
        assert_eq!(snapshot.loop_b, None);

        apply_ipc_message(
            &mut snapshot,
            &json!({"event":"property-change","name":"sub-delay","data":"invalid"}),
        );
        apply_ipc_message(
            &mut snapshot,
            &json!({"event":"property-change","name":"ab-loop-a","data":-4.0}),
        );
        assert_eq!(snapshot.subtitle_delay, -2.5);
        assert_eq!(snapshot.loop_a, Some(0.0));
    }

    #[test]
    fn color_range_transition_only_removes_a_filter_that_is_applied() {
        assert_eq!(
            color_range_transition(ColorRangeMode::Auto, ColorRangeMode::Limited),
            vec![ColorRangeMode::Limited]
        );
        assert_eq!(
            color_range_transition(ColorRangeMode::Limited, ColorRangeMode::Full),
            vec![ColorRangeMode::Auto, ColorRangeMode::Full]
        );
        assert_eq!(
            color_range_transition(ColorRangeMode::Full, ColorRangeMode::Auto),
            vec![ColorRangeMode::Auto]
        );
        assert!(color_range_transition(ColorRangeMode::Auto, ColorRangeMode::Auto).is_empty());
    }

    #[test]
    fn path_candidates_honor_configuration_then_manager_then_companion() {
        let candidates = mpv_path_candidates(
            Some(OsString::from("D:\\Portable\\mpv.exe")),
            Path::new("C:\\Program Files\\Aura\\aura-media-manager.exe"),
            Path::new("C:\\Users\\me\\AppData\\Local\\Aura Media\\Companion"),
        );
        assert_eq!(
            candidates,
            vec![
                PathBuf::from("D:\\Portable\\mpv.exe"),
                PathBuf::from("C:\\Program Files\\Aura\\tools\\mpv\\mpv.exe"),
                PathBuf::from(
                    "C:\\Users\\me\\AppData\\Local\\Aura Media\\Companion\\tools\\mpv\\mpv.exe"
                ),
            ]
        );
    }

    #[test]
    fn duplicate_path_candidates_are_removed_without_reordering() {
        let manager = Path::new("C:\\Aura\\aura-media-manager.exe");
        let configured = OsString::from("C:\\Aura\\tools\\mpv\\mpv.exe");
        let candidates = mpv_path_candidates(Some(configured), manager, Path::new("C:\\Companion"));
        assert_eq!(candidates.len(), 2);
        assert_eq!(
            candidates[0],
            PathBuf::from("C:\\Aura\\tools\\mpv\\mpv.exe")
        );
    }
}
