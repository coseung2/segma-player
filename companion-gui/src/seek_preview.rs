//! Nonblocking seek-hover previews rendered in a native sibling child window.
//!
//! A single worker owns ffmpeg extraction. Its pending slot is replaceable, so
//! pointer motion can leave at most one stale extraction in flight and one
//! newest request waiting instead of spawning an ffmpeg process per event.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime};

use crate::jobs;
use crate::player_contract::PhysicalVideoRect;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const QUANTUM_MILLIS: u64 = 500;
const MAX_CACHE_FILES: usize = 96;
const MAX_MEMORY_PREVIEWS: usize = 96;
const PREVIEW_FILTER: &str = "scale=192:108:force_original_aspect_ratio=increase,crop=192:108";
const EXTRACTION_POLL_INTERVAL: Duration = Duration::from_millis(12);

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, PartialEq, Eq)]
struct PreviewRequest {
    id: u64,
    media_key: String,
    media_path: PathBuf,
    timestamp_millis: u64,
}

#[derive(Debug)]
struct PreviewResult {
    request: PreviewRequest,
    image: Option<DecodedPreview>,
}

#[derive(Debug, Clone)]
struct DecodedPreview {
    width: i32,
    height: i32,
    bgra: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PreviewCacheKey {
    media_key: String,
    timestamp_millis: u64,
}

impl From<&PreviewRequest> for PreviewCacheKey {
    fn from(request: &PreviewRequest) -> Self {
        Self {
            media_key: request.media_key.clone(),
            timestamp_millis: request.timestamp_millis,
        }
    }
}

#[derive(Default)]
struct MemoryPreviewCache {
    images: HashMap<PreviewCacheKey, DecodedPreview>,
    order: VecDeque<PreviewCacheKey>,
}

impl MemoryPreviewCache {
    fn get(&mut self, key: &PreviewCacheKey) -> Option<DecodedPreview> {
        let image = self.images.get(key).cloned()?;
        self.touch(key);
        Some(image)
    }

    fn insert(&mut self, key: PreviewCacheKey, image: DecodedPreview) {
        self.images.insert(key.clone(), image);
        self.touch(&key);
        while self.order.len() > MAX_MEMORY_PREVIEWS {
            if let Some(oldest) = self.order.pop_front() {
                self.images.remove(&oldest);
            }
        }
    }

    fn touch(&mut self, key: &PreviewCacheKey) {
        self.order.retain(|candidate| candidate != key);
        self.order.push_back(key.clone());
    }
}

#[derive(Default)]
struct WorkerState {
    pending: Option<PreviewRequest>,
    shutdown: bool,
}

struct WorkerQueue {
    state: Mutex<WorkerState>,
    changed: Condvar,
}

impl WorkerQueue {
    fn new() -> Self {
        Self {
            state: Mutex::new(WorkerState::default()),
            changed: Condvar::new(),
        }
    }

    fn submit(&self, request: PreviewRequest) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        replace_pending(&mut state.pending, request);
        self.changed.notify_one();
    }

    fn next(&self) -> Option<PreviewRequest> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        loop {
            if state.shutdown {
                return None;
            }
            if let Some(request) = state.pending.take() {
                return Some(request);
            }
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(|error| error.into_inner());
        }
    }

    /// An in-flight extraction is disposable as soon as a different newest
    /// request is waiting. Cancelling it prevents fast pointer motion from
    /// queueing behind an irrelevant keyframe seek.
    fn superseded(&self, active: &PreviewRequest) -> bool {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.shutdown
            || state
                .pending
                .as_ref()
                .is_some_and(|pending| pending.id != active.id)
    }

    fn shutdown(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.shutdown = true;
        state.pending = None;
        self.changed.notify_one();
    }
}

/// UI-thread owner for seek-preview extraction and its native child overlay.
///
/// Call [`Self::request`] while hover is active, [`Self::poll`] once per UI
/// frame, and [`Self::hide`] as soon as hover ends. Dropping the controller
/// stops the worker and destroys its Win32 window.
pub struct SeekPreviewController {
    queue: Arc<WorkerQueue>,
    results: Receiver<PreviewResult>,
    worker: Option<JoinHandle<()>>,
    next_request_id: u64,
    current_request: Option<PreviewRequest>,
    current_parent: isize,
    current_rect: PhysicalVideoRect,
    hover_active: bool,
    memory_cache: MemoryPreviewCache,
    overlay: NativeOverlay,
}

impl SeekPreviewController {
    pub fn new() -> Self {
        let queue = Arc::new(WorkerQueue::new());
        let worker_queue = Arc::clone(&queue);
        let (result_tx, results) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("aura-seek-preview-worker".into())
            .spawn(move || worker_loop(worker_queue, result_tx))
            .expect("seek preview worker starts");
        Self {
            queue,
            results,
            worker: Some(worker),
            next_request_id: 0,
            current_request: None,
            current_parent: 0,
            current_rect: PhysicalVideoRect::default(),
            hover_active: false,
            memory_cache: MemoryPreviewCache::default(),
            overlay: NativeOverlay::default(),
        }
    }

    /// Request a preview without blocking the caller.
    ///
    /// `overlay_rect` is in physical parent-client pixels. `parent_hwnd` is the
    /// raw Win32 parent handle represented as `isize`, matching PlayerCommand.
    #[allow(clippy::too_many_arguments)]
    pub fn request(
        &mut self,
        media_key: impl Into<String>,
        media_path: impl Into<PathBuf>,
        target_seconds: f64,
        duration_seconds: f64,
        parent_hwnd: isize,
        overlay_rect: PhysicalVideoRect,
    ) {
        let media_key = media_key.into();
        let media_path = media_path.into();
        let timestamp_millis = quantize_timestamp(target_seconds, duration_seconds);
        let same_preview = self.current_request.as_ref().is_some_and(|request| {
            request.media_key == media_key
                && request.media_path == media_path
                && request.timestamp_millis == timestamp_millis
        });

        let media_changed = self.current_request.as_ref().is_some_and(|request| {
            request.media_key != media_key || request.media_path != media_path
        });
        if media_changed || self.current_parent != parent_hwnd {
            self.overlay.hide();
        }

        self.hover_active = true;
        self.current_parent = parent_hwnd;
        self.current_rect = overlay_rect;
        if same_preview {
            self.overlay.reposition(parent_hwnd, overlay_rect);
            return;
        }

        self.next_request_id = self.next_request_id.wrapping_add(1).max(1);
        let request = PreviewRequest {
            id: self.next_request_id,
            media_key,
            media_path,
            timestamp_millis,
        };
        self.current_request = Some(request.clone());
        let timecode = format_timecode(timestamp_millis as f64 / 1_000.0);
        if let Some(image) = self.memory_cache.get(&PreviewCacheKey::from(&request)) {
            self.overlay
                .show(parent_hwnd, overlay_rect, image, timecode);
            return;
        }
        self.overlay
            .retain_and_reposition(parent_hwnd, overlay_rect, timecode);
        self.queue.submit(request);
    }

    /// Display a completed newest result, if one is available. Never blocks.
    pub fn poll(&mut self) {
        while let Ok(result) = self.results.try_recv() {
            if let Some(image) = result.image.as_ref() {
                self.memory_cache
                    .insert(PreviewCacheKey::from(&result.request), image.clone());
            }
            if !self.hover_active || self.current_request.as_ref() != Some(&result.request) {
                continue;
            }
            if let Some(image) = result.image {
                self.overlay.show(
                    self.current_parent,
                    self.current_rect,
                    image,
                    format_timecode(result.request.timestamp_millis as f64 / 1_000.0),
                );
            }
        }
    }

    /// Hide immediately and invalidate all outstanding results.
    pub fn hide(&mut self) {
        self.hover_active = false;
        self.current_request = None;
        self.next_request_id = self.next_request_id.wrapping_add(1);
        self.overlay.hide();
    }

    /// Hide immediately when the loaded media identity changes.
    pub fn media_changed(&mut self) {
        self.hide();
    }

    /// Explicitly release the native window and join the one extraction worker.
    pub fn shutdown(&mut self) {
        self.hide();
        self.overlay.destroy();
        self.queue.shutdown();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Default for SeekPreviewController {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for SeekPreviewController {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn worker_loop(queue: Arc<WorkerQueue>, results: Sender<PreviewResult>) {
    while let Some(request) = queue.next() {
        let image = generate(&request, &queue);
        if results.send(PreviewResult { request, image }).is_err() {
            break;
        }
    }
}

/// Quantize to stable half-second cache slots and avoid seeking exactly to EOF.
pub fn quantize_timestamp(target_seconds: f64, duration_seconds: f64) -> u64 {
    if !target_seconds.is_finite() || !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return 0;
    }
    let maximum = (duration_seconds - 0.001).max(0.0);
    let clamped_millis = (target_seconds.max(0.0).min(maximum) * 1_000.0).floor() as u64;
    clamped_millis / QUANTUM_MILLIS * QUANTUM_MILLIS
}

/// Deterministic disposable-cache filename keyed by media identity and slot.
pub fn cache_name(media_key: &str, timestamp_millis: u64) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in media_key
        .as_bytes()
        .iter()
        .copied()
        .chain(timestamp_millis.to_le_bytes())
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}-{timestamp_millis:010}.jpg")
}

fn replace_pending<T>(slot: &mut Option<T>, newest: T) -> Option<T> {
    slot.replace(newest)
}

/// Clamp a requested child rectangle to physical parent-client bounds.
pub fn clamp_overlay_bounds(
    requested: PhysicalVideoRect,
    parent: PhysicalVideoRect,
) -> PhysicalVideoRect {
    if !requested.visible() || !parent.visible() {
        return PhysicalVideoRect::default();
    }
    let width = requested.width.min(parent.width).max(0);
    let height = requested.height.min(parent.height).max(0);
    let maximum_x = parent.x.saturating_add(parent.width.saturating_sub(width));
    let maximum_y = parent
        .y
        .saturating_add(parent.height.saturating_sub(height));
    PhysicalVideoRect {
        x: requested.x.clamp(parent.x, maximum_x),
        y: requested.y.clamp(parent.y, maximum_y),
        width,
        height,
    }
}

pub fn format_timecode(seconds: f64) -> String {
    let total = if seconds.is_finite() && seconds > 0.0 {
        seconds.floor() as u64
    } else {
        0
    };
    let hours = total / 3_600;
    let minutes = total % 3_600 / 60;
    let seconds = total % 60;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes:02}:{seconds:02}")
    }
}

fn cache_path(request: &PreviewRequest) -> io::Result<PathBuf> {
    Ok(jobs::companion_root()?
        .join("seek-previews")
        .join(cache_name(&request.media_key, request.timestamp_millis)))
}

fn ffmpeg_path() -> io::Result<PathBuf> {
    let executable = std::env::current_exe()?;
    let beside_manager = executable
        .parent()
        .unwrap_or(Path::new("."))
        .join("tools")
        .join("ffmpeg")
        .join("ffmpeg.exe");
    if beside_manager.is_file() {
        return Ok(beside_manager);
    }
    let installed = jobs::companion_root()?
        .join("tools")
        .join("ffmpeg")
        .join("ffmpeg.exe");
    installed
        .is_file()
        .then_some(installed)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "ffmpeg is unavailable"))
}

fn decode(path: &Path) -> Option<DecodedPreview> {
    let image = image::open(path).ok()?.into_rgba8();
    // Existing 320x180 cache entries remain readable; new entries are already
    // generated at native overlay size and skip this second resample.
    let image = if image.dimensions() == (192, 108) {
        image
    } else {
        image::imageops::resize(&image, 192, 108, image::imageops::FilterType::Triangle)
    };
    let (width, height) = image.dimensions();
    let mut bgra = image.into_raw();
    for pixel in bgra.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    Some(DecodedPreview {
        width: i32::try_from(width).ok()?,
        height: i32::try_from(height).ok()?,
        bgra,
    })
}

fn generate(request: &PreviewRequest, queue: &WorkerQueue) -> Option<DecodedPreview> {
    let output = cache_path(request).ok()?;
    if output.is_file() {
        return decode(&output);
    }
    let parent = output.parent()?;
    fs::create_dir_all(parent).ok()?;
    let temporary = parent.join(format!("{}.tmp.jpg", output.file_stem()?.to_string_lossy()));
    let _ = fs::remove_file(&temporary);
    let ffmpeg = ffmpeg_path().ok()?;
    let timestamp = format!("{:.3}", request.timestamp_millis as f64 / 1_000.0);
    let mut command = Command::new(ffmpeg);
    command
        .args(["-hide_banner", "-loglevel", "error", "-ss"])
        .arg(timestamp)
        .arg("-i")
        .arg(&request.media_path)
        .args(["-frames:v", "1", "-vf", PREVIEW_FILTER, "-q:v", "4", "-y"])
        .arg(&temporary)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command.spawn().ok()?;
    let status = loop {
        if queue.superseded(request) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&temporary);
            return None;
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(EXTRACTION_POLL_INTERVAL),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = fs::remove_file(&temporary);
                return None;
            }
        }
    };
    if !status.success() {
        let _ = fs::remove_file(&temporary);
        return None;
    }
    if fs::rename(&temporary, &output).is_err() {
        let _ = fs::remove_file(&temporary);
        return None;
    }
    prune_cache(parent);
    decode(&output)
}

fn prune_cache(directory: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut cached = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".tmp.jpg") {
            let _ = fs::remove_file(path);
            continue;
        }
        if !name.ends_with(".jpg") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        cached.push((modified, name, path));
    }
    cached.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    let remove_count = cached.len().saturating_sub(MAX_CACHE_FILES);
    for (_, _, path) in cached.into_iter().take(remove_count) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(target_os = "windows")]
mod native_overlay {
    use super::{clamp_overlay_bounds, DecodedPreview, PhysicalVideoRect};
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::sync::OnceLock;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        BeginPaint, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, FillRect, InvalidateRect,
        SetBkMode, SetDIBitsToDevice, SetTextColor, StretchDIBits, UpdateWindow, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, DT_CENTER, DT_NOPREFIX, DT_SINGLELINE,
        DT_VCENTER, HGDIOBJ, PAINTSTRUCT, SRCCOPY, TRANSPARENT,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, GetWindowLongPtrW,
        RegisterClassW, SetWindowLongPtrW, SetWindowPos, ShowWindow, CREATESTRUCTW, GWLP_USERDATA,
        HTTRANSPARENT, HWND_TOP, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE, WM_ERASEBKGND,
        WM_NCCREATE, WM_NCDESTROY, WM_NCHITTEST, WM_PAINT, WNDCLASSW, WS_CHILD, WS_CLIPSIBLINGS,
        WS_EX_NOACTIVATE,
    };

    const CLASS_NAME: PCWSTR = w!("AuraSeekPreviewOverlay");
    const TIMECODE_STRIP_HEIGHT: i32 = 28;
    static CLASS_REGISTERED: OnceLock<bool> = OnceLock::new();

    #[derive(Default)]
    struct OverlayState {
        image: Option<DecodedPreview>,
        timecode: Vec<u16>,
    }

    #[derive(Default)]
    pub(super) struct NativeOverlay {
        hwnd: Option<HWND>,
        parent: Option<HWND>,
        state: Option<Box<OverlayState>>,
    }

    impl NativeOverlay {
        pub(super) fn show(
            &mut self,
            parent_raw: isize,
            requested: PhysicalVideoRect,
            image: DecodedPreview,
            timecode: String,
        ) {
            if parent_raw == 0 || !requested.visible() || !self.ensure_window(parent_raw) {
                self.hide();
                return;
            }
            let Some(state) = self.state.as_mut() else {
                return;
            };
            state.image = Some(image);
            state.timecode = timecode.encode_utf16().collect();
            self.reposition(parent_raw, requested);
            if let Some(hwnd) = self.hwnd {
                unsafe {
                    let _ = InvalidateRect(Some(hwnd), None, false);
                    let _ = UpdateWindow(hwnd);
                }
            }
        }

        pub(super) fn reposition(&mut self, parent_raw: isize, requested: PhysicalVideoRect) {
            if self.parent != Some(raw_hwnd(parent_raw)) {
                return;
            }
            let Some(hwnd) = self.hwnd else {
                return;
            };
            let bounds = parent_client_bounds(raw_hwnd(parent_raw));
            let rect = clamp_overlay_bounds(requested, bounds);
            if !rect.visible() {
                self.hide();
                return;
            }
            unsafe {
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOP),
                    rect.x,
                    rect.y,
                    rect.width,
                    rect.height,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
        }

        /// Keep the last decoded frame visible while a newer slot is being
        /// extracted. This avoids flashing an empty holder between requests.
        pub(super) fn retain_and_reposition(
            &mut self,
            parent_raw: isize,
            requested: PhysicalVideoRect,
            timecode: String,
        ) {
            if self.parent != Some(raw_hwnd(parent_raw))
                || self
                    .state
                    .as_ref()
                    .and_then(|state| state.image.as_ref())
                    .is_none()
            {
                return;
            }
            if let Some(state) = self.state.as_mut() {
                state.timecode = timecode.encode_utf16().collect();
            }
            self.reposition(parent_raw, requested);
            if let Some(hwnd) = self.hwnd {
                unsafe {
                    let _ = InvalidateRect(Some(hwnd), None, false);
                    let _ = UpdateWindow(hwnd);
                }
            }
        }

        pub(super) fn hide(&mut self) {
            if let Some(hwnd) = self.hwnd {
                unsafe {
                    let _ = ShowWindow(hwnd, SW_HIDE);
                }
            }
        }

        pub(super) fn destroy(&mut self) {
            if let Some(hwnd) = self.hwnd.take() {
                unsafe {
                    let _ = DestroyWindow(hwnd);
                }
            }
            self.parent = None;
            self.state = None;
        }

        fn ensure_window(&mut self, parent_raw: isize) -> bool {
            let parent = raw_hwnd(parent_raw);
            if self.hwnd.is_some() && self.parent == Some(parent) {
                return true;
            }
            self.destroy();
            if !register_class() {
                return false;
            }
            let mut state = Box::<OverlayState>::default();
            let state_pointer = (&mut *state) as *mut OverlayState as *const c_void;
            let Ok(module) = (unsafe { GetModuleHandleW(None) }) else {
                return false;
            };
            let window = unsafe {
                CreateWindowExW(
                    WS_EX_NOACTIVATE,
                    CLASS_NAME,
                    w!(""),
                    WS_CHILD | WS_CLIPSIBLINGS,
                    0,
                    0,
                    1,
                    1,
                    Some(parent),
                    None,
                    Some(HINSTANCE(module.0)),
                    Some(state_pointer),
                )
            };
            let Ok(hwnd) = window else {
                return false;
            };
            self.hwnd = Some(hwnd);
            self.parent = Some(parent);
            self.state = Some(state);
            true
        }
    }

    fn raw_hwnd(value: isize) -> HWND {
        HWND(value as *mut c_void)
    }

    fn parent_client_bounds(parent: HWND) -> PhysicalVideoRect {
        let mut rect = RECT::default();
        if unsafe { GetClientRect(parent, &mut rect) }.is_err() {
            return PhysicalVideoRect::default();
        }
        PhysicalVideoRect {
            x: 0,
            y: 0,
            width: rect.right.saturating_sub(rect.left),
            height: rect.bottom.saturating_sub(rect.top),
        }
    }

    fn register_class() -> bool {
        *CLASS_REGISTERED.get_or_init(|| {
            let Ok(module) = (unsafe { GetModuleHandleW(None) }) else {
                return false;
            };
            let class = WNDCLASSW {
                lpfnWndProc: Some(window_proc),
                hInstance: HINSTANCE(module.0),
                lpszClassName: CLASS_NAME,
                ..Default::default()
            };
            unsafe { RegisterClassW(&class) != 0 }
        })
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message == WM_NCCREATE {
            let create = &*(lparam.0 as *const CREATESTRUCTW);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
        }
        let state_pointer = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut OverlayState;
        match message {
            WM_PAINT => {
                paint(hwnd, state_pointer.as_ref());
                LRESULT(0)
            }
            WM_ERASEBKGND => LRESULT(1),
            WM_NCHITTEST => LRESULT(HTTRANSPARENT as isize),
            WM_NCDESTROY => {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                DefWindowProcW(hwnd, message, wparam, lparam)
            }
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        }
    }

    unsafe fn paint(hwnd: HWND, state: Option<&OverlayState>) {
        let mut paint = PAINTSTRUCT::default();
        let dc = BeginPaint(hwnd, &mut paint);
        let mut client = RECT::default();
        if GetClientRect(hwnd, &mut client).is_ok() {
            let background = CreateSolidBrush(COLORREF(0x0018_1513));
            FillRect(dc, &client, background);
            let _ = DeleteObject(HGDIOBJ(background.0));

            if let Some(state) = state {
                let image_bottom = (client.bottom - TIMECODE_STRIP_HEIGHT).max(client.top);
                if let Some(image) = &state.image {
                    let bitmap = BITMAPINFO {
                        bmiHeader: BITMAPINFOHEADER {
                            biSize: size_of::<BITMAPINFOHEADER>() as u32,
                            biWidth: image.width,
                            biHeight: -image.height,
                            biPlanes: 1,
                            biBitCount: 32,
                            biCompression: BI_RGB.0,
                            ..Default::default()
                        },
                        ..Default::default()
                    };
                    let drawn = StretchDIBits(
                        dc,
                        client.left,
                        client.top,
                        client.right - client.left,
                        image_bottom - client.top,
                        0,
                        0,
                        image.width,
                        image.height,
                        Some(image.bgra.as_ptr().cast()),
                        &bitmap,
                        DIB_RGB_COLORS,
                        SRCCOPY,
                    );
                    if drawn <= 0 {
                        let _ = SetDIBitsToDevice(
                            dc,
                            client.left,
                            client.top,
                            image.width as u32,
                            image.height as u32,
                            0,
                            0,
                            0,
                            image.height as u32,
                            image.bgra.as_ptr().cast(),
                            &bitmap,
                            DIB_RGB_COLORS,
                        );
                    }
                }

                let strip = RECT {
                    left: client.left,
                    top: image_bottom,
                    right: client.right,
                    bottom: client.bottom,
                };
                let brush = CreateSolidBrush(COLORREF(0x0022_1d1a));
                FillRect(dc, &strip, brush);
                let _ = DeleteObject(HGDIOBJ(brush.0));
                SetBkMode(dc, TRANSPARENT);
                SetTextColor(dc, COLORREF(0x00ff_ffff));
                let mut text_rect = strip;
                let mut text = state.timecode.clone();
                DrawTextW(
                    dc,
                    &mut text,
                    &mut text_rect,
                    DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX,
                );
            }
        }
        let _ = EndPaint(hwnd, &paint);
    }
}

#[cfg(target_os = "windows")]
use native_overlay::NativeOverlay;

#[cfg(not(target_os = "windows"))]
#[derive(Default)]
struct NativeOverlay;

#[cfg(not(target_os = "windows"))]
impl NativeOverlay {
    fn show(
        &mut self,
        _parent: isize,
        _rect: PhysicalVideoRect,
        _image: DecodedPreview,
        _timecode: String,
    ) {
    }
    fn reposition(&mut self, _parent: isize, _rect: PhysicalVideoRect) {}
    fn retain_and_reposition(
        &mut self,
        _parent: isize,
        _rect: PhysicalVideoRect,
        _timecode: String,
    ) {
    }
    fn hide(&mut self) {}
    fn destroy(&mut self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: u64, timestamp_millis: u64) -> PreviewRequest {
        PreviewRequest {
            id,
            media_key: "clip-key".into(),
            media_path: PathBuf::from("clip.mp4"),
            timestamp_millis,
        }
    }

    fn image(value: u8) -> DecodedPreview {
        DecodedPreview {
            width: 1,
            height: 1,
            bgra: vec![value; 4],
        }
    }

    #[test]
    fn timestamp_quantization_is_stable_clamped_and_avoids_eof() {
        assert_eq!(quantize_timestamp(-2.0, 10.0), 0);
        assert_eq!(quantize_timestamp(1.499, 10.0), 1_000);
        assert_eq!(quantize_timestamp(1.500, 10.0), 1_500);
        assert_eq!(quantize_timestamp(99.0, 10.0), 9_500);
        assert_eq!(quantize_timestamp(f64::NAN, 10.0), 0);
        assert_eq!(quantize_timestamp(1.0, 0.0), 0);
    }

    #[test]
    fn cache_name_invalidates_for_media_identity_and_time_slot() {
        let first = cache_name("clip:100:10", 1_000);
        assert_ne!(first, cache_name("clip:101:10", 1_000));
        assert_ne!(first, cache_name("clip:100:10", 1_500));
        assert_eq!(first, cache_name("clip:100:10", 1_000));
        assert!(first.ends_with("-0000001000.jpg"));
    }

    #[test]
    fn newest_request_replaces_the_only_pending_slot() {
        let mut pending = Some(request(1, 1_000));
        let displaced = replace_pending(&mut pending, request(2, 1_500));
        assert_eq!(displaced, Some(request(1, 1_000)));
        assert_eq!(pending, Some(request(2, 1_500)));
        replace_pending(&mut pending, request(3, 2_000));
        assert_eq!(pending, Some(request(3, 2_000)));
    }

    #[test]
    fn a_new_pending_request_supersedes_inflight_extraction() {
        let queue = WorkerQueue::new();
        let active = request(1, 1_000);
        let newest = request(2, 8_000);
        assert!(!queue.superseded(&active));
        queue.submit(newest.clone());
        assert!(queue.superseded(&active));
        assert!(!queue.superseded(&newest));
    }

    #[test]
    fn new_previews_are_generated_at_overlay_size() {
        assert_eq!(
            PREVIEW_FILTER,
            "scale=192:108:force_original_aspect_ratio=increase,crop=192:108"
        );
    }

    #[test]
    fn memory_cache_returns_recent_frames_and_evicts_the_oldest() {
        let mut cache = MemoryPreviewCache::default();
        for timestamp in 0..MAX_MEMORY_PREVIEWS as u64 {
            let request = request(timestamp + 1, timestamp * QUANTUM_MILLIS);
            cache.insert(PreviewCacheKey::from(&request), image(timestamp as u8));
        }
        let retained = request(99, 0);
        assert!(cache.get(&PreviewCacheKey::from(&retained)).is_some());

        let newest = request(100, MAX_MEMORY_PREVIEWS as u64 * QUANTUM_MILLIS);
        cache.insert(PreviewCacheKey::from(&newest), image(255));
        let evicted = request(101, QUANTUM_MILLIS);
        assert!(cache.get(&PreviewCacheKey::from(&evicted)).is_none());
        assert!(cache.get(&PreviewCacheKey::from(&retained)).is_some());
        assert!(cache.get(&PreviewCacheKey::from(&newest)).is_some());
    }

    #[test]
    fn timecode_formats_short_long_and_invalid_positions() {
        assert_eq!(format_timecode(0.0), "00:00");
        assert_eq!(format_timecode(65.9), "01:05");
        assert_eq!(format_timecode(3_661.2), "1:01:01");
        assert_eq!(format_timecode(f64::NAN), "00:00");
    }

    #[test]
    fn overlay_bounds_clamp_position_and_size_to_parent() {
        let parent = PhysicalVideoRect {
            x: 0,
            y: 0,
            width: 800,
            height: 450,
        };
        assert_eq!(
            clamp_overlay_bounds(
                PhysicalVideoRect {
                    x: 700,
                    y: -20,
                    width: 320,
                    height: 204,
                },
                parent,
            ),
            PhysicalVideoRect {
                x: 480,
                y: 0,
                width: 320,
                height: 204,
            }
        );
        assert_eq!(
            clamp_overlay_bounds(
                PhysicalVideoRect {
                    x: 20,
                    y: 20,
                    width: 1_000,
                    height: 700,
                },
                parent,
            ),
            parent
        );
    }
}
