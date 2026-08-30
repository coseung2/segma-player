//! Nonblocking seek-hover preview extraction for egui-owned surfaces.
//!
//! A single worker owns ffmpeg extraction. Its pending slot is replaceable, so
//! pointer motion can leave at most one stale extraction in flight and one
//! newest request waiting instead of spawning an ffmpeg process per event. The
//! UI owns the resulting texture; no second Win32 child window participates in
//! player/PiP composition or z-order.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime};

use eframe::egui;

use crate::jobs;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const QUANTUM_MILLIS: u64 = 500;
/// Disk and memory caches are both bounded, and both are sized for a real sweep
/// across a long local file rather than a handful of hovers. A 96-slot cache is
/// only 48 seconds of a video, so a user scrubbing a movie evicted entries they
/// were about to hover again and paid for a fresh ffmpeg extraction each time.
const MAX_CACHE_FILES: usize = 512;
/// One decoded frame is 192x108 BGRA, so this bound is about 16 MiB.
const MAX_MEMORY_PREVIEWS: usize = 192;
/// Ceiling the memory bound is checked against, so a future size change cannot
/// quietly turn a hover cache into a large resident allocation.
#[cfg(test)]
const MAX_MEMORY_CACHE_BYTES: usize = 24 * 1_024 * 1_024;
const PREVIEW_FILTER: &str =
    "scale=192:108:force_original_aspect_ratio=decrease,pad=192:108:(ow-iw)/2:(oh-ih)/2:black";
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

#[derive(Debug, Clone, PartialEq)]
struct DecodedPreview {
    width: i32,
    height: i32,
    rgba: Vec<u8>,
}

/// Borrowed UI-ready preview. The texture is owned by the controller and stays
/// valid until the media changes, hover ends, or a newer request replaces it.
#[derive(Clone, Copy)]
pub struct SeekPreviewVisual<'a> {
    pub texture: &'a egui::TextureHandle,
    pub timecode: &'a str,
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

    /// Extraction is interrupted only for shutdown. Pointer motion already
    /// replaces the one pending slot, so killing every in-flight ffmpeg seek
    /// can starve continuous hover and leave the preview blank forever.
    fn shutdown_requested(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .shutdown
    }

    fn shutdown(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.shutdown = true;
        state.pending = None;
        self.changed.notify_one();
    }
}

/// UI-thread owner for seek-preview extraction and its egui texture.
///
/// Call [`Self::request`] while hover is active, [`Self::poll`] once per UI
/// frame, and [`Self::hide`] as soon as hover ends. Dropping the controller
/// stops the worker. The controller never creates or repositions a native
/// window, so a preview cannot escape its Player/PiP surface or disturb the
/// mpv child window's z-order.
pub struct SeekPreviewController {
    queue: Arc<WorkerQueue>,
    results: Receiver<PreviewResult>,
    worker: Option<JoinHandle<()>>,
    next_request_id: u64,
    current_request: Option<PreviewRequest>,
    visual_request: Option<PreviewRequest>,
    hover_active: bool,
    memory_cache: MemoryPreviewCache,
    /// Memoized `(caller key, path, resolved identity)` for the loaded file.
    /// Hover fires on every frame, so file metadata is read once per media
    /// instead of once per pointer move.
    identity: Option<(String, PathBuf, String)>,
    texture: Option<egui::TextureHandle>,
    timecode: String,
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
            visual_request: None,
            hover_active: false,
            memory_cache: MemoryPreviewCache::default(),
            identity: None,
            texture: None,
            timecode: String::new(),
        }
    }

    /// Request a preview without blocking the caller.
    ///
    pub fn request(
        &mut self,
        context: &egui::Context,
        media_key: impl Into<String>,
        media_path: impl Into<PathBuf>,
        target_seconds: f64,
        duration_seconds: f64,
    ) {
        let media_key = media_key.into();
        let media_path = media_path.into();
        let media_key = self.resolved_identity(media_key, &media_path);
        let timestamp_millis = quantize_timestamp(target_seconds, duration_seconds);
        let same_preview = self.current_request.as_ref().is_some_and(|request| {
            request.media_key == media_key
                && request.media_path == media_path
                && request.timestamp_millis == timestamp_millis
        });

        self.hover_active = true;
        if same_preview {
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
        if let Some(image) = self.memory_cache.get(&PreviewCacheKey::from(&request)) {
            self.show(context, request, image);
            return;
        }
        // Retain the last frame from this media while the newest slot loads.
        // The current target timecode is updated immediately, so pointer motion
        // feels responsive without a placeholder flash between half-second
        // cache slots.
        if self.visual_request.as_ref().is_some_and(|visual| {
            visual.media_key == request.media_key && visual.media_path == request.media_path
        }) {
            self.timecode = format_timecode(request.timestamp_millis as f64 / 1_000.0);
        } else {
            self.visual_request = None;
        }
        self.queue.submit(request);
        context.request_repaint();
    }

    /// Resolve the cache identity for the hovered file, reusing the memoized
    /// value while the same caller key and path stay loaded.
    fn resolved_identity(&mut self, media_key: String, media_path: &Path) -> String {
        if let Some(identity) = reusable_identity(self.identity.as_ref(), &media_key, media_path) {
            return identity;
        }
        let identity = media_identity(&media_key, media_path);
        self.identity = Some((media_key, media_path.to_path_buf(), identity.clone()));
        identity
    }

    /// Display a completed newest result, if one is available. Never blocks.
    pub fn poll(&mut self, context: &egui::Context) {
        while let Ok(result) = self.results.try_recv() {
            if let Some(image) = result.image.as_ref() {
                self.memory_cache
                    .insert(PreviewCacheKey::from(&result.request), image.clone());
            }
            if !self.hover_active {
                continue;
            }
            let same_media = self.current_request.as_ref().is_some_and(|current| {
                current.media_key == result.request.media_key
                    && current.media_path == result.request.media_path
            });
            if !same_media {
                continue;
            }
            if let Some(image) = result.image {
                self.show(context, result.request, image);
            }
        }
    }

    fn show(&mut self, context: &egui::Context, request: PreviewRequest, image: DecodedPreview) {
        let Ok(width) = usize::try_from(image.width) else {
            return;
        };
        let Ok(height) = usize::try_from(image.height) else {
            return;
        };
        if width == 0 || height == 0 || image.rgba.len() != width * height * 4 {
            return;
        }
        let color_image = egui::ColorImage::from_rgba_unmultiplied([width, height], &image.rgba);
        if let Some(texture) = self.texture.as_mut() {
            texture.set(color_image, egui::TextureOptions::LINEAR);
        } else {
            self.texture = Some(context.load_texture(
                "segma-seek-preview",
                color_image,
                egui::TextureOptions::LINEAR,
            ));
        }
        let target_millis = self
            .current_request
            .as_ref()
            .filter(|current| {
                current.media_key == request.media_key && current.media_path == request.media_path
            })
            .map_or(request.timestamp_millis, |current| current.timestamp_millis);
        self.timecode = format_timecode(target_millis as f64 / 1_000.0);
        self.visual_request = Some(request);
        context.request_repaint();
    }

    pub fn visual(&self) -> Option<SeekPreviewVisual<'_>> {
        if !self.hover_active {
            return None;
        }
        let same_media = self
            .visual_request
            .as_ref()
            .zip(self.current_request.as_ref())
            .is_some_and(|(visual, current)| {
                visual.media_key == current.media_key && visual.media_path == current.media_path
            });
        if !same_media {
            return None;
        }
        Some(SeekPreviewVisual {
            texture: self.texture.as_ref()?,
            timecode: &self.timecode,
        })
    }

    /// Hide immediately. Keep the last same-media texture warm so re-entering
    /// the seek bar or moving into another slot never flashes a placeholder.
    /// [`Self::media_changed`] is the boundary that releases this association.
    pub fn hide(&mut self) {
        self.hover_active = false;
        self.current_request = None;
        self.next_request_id = self.next_request_id.wrapping_add(1);
    }

    /// Hide immediately when the loaded media identity changes.
    pub fn media_changed(&mut self) {
        // The next hover must re-read file metadata; the previous file's
        // identity can no longer describe what is loaded.
        self.identity = None;
        self.hide();
        self.visual_request = None;
        self.texture = None;
        self.timecode.clear();
    }

    /// Explicitly release the texture and join the one extraction worker.
    pub fn shutdown(&mut self) {
        self.hide();
        self.texture = None;
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

/// Include the local file's path and current metadata in the cache identity.
/// The caller-provided key remains part of the identity for compatibility with
/// the Library's file records, while metadata invalidates previews after a
/// downloaded file is replaced in place.
fn media_identity(media_key: &str, media_path: &Path) -> String {
    let path = fs::canonicalize(media_path).unwrap_or_else(|_| media_path.to_path_buf());
    let metadata = fs::metadata(media_path).ok();
    let size = metadata.as_ref().map_or(0, |value| value.len());
    let modified = metadata
        .and_then(|value| value.modified().ok())
        .and_then(|value| value.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map_or(0, |value| value.as_nanos());
    format!("{media_key}|{}|{size}|{modified}", path.to_string_lossy())
}

/// Decide whether a memoized identity still describes the hovered file. Pure so
/// the "no filesystem call per pointer move" rule is directly testable.
fn reusable_identity(
    memoized: Option<&(String, PathBuf, String)>,
    media_key: &str,
    media_path: &Path,
) -> Option<String> {
    memoized
        .filter(|(cached_key, cached_path, _)| {
            cached_key == media_key && cached_path.as_path() == media_path
        })
        .map(|(_, _, identity)| identity.clone())
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
    let rgba = image.into_raw();
    Some(DecodedPreview {
        width: i32::try_from(width).ok()?,
        height: i32::try_from(height).ok()?,
        rgba,
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
        if queue.shutdown_requested() {
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
    if prune_is_due(&EXTRACTIONS_SINCE_PRUNE) {
        prune_cache(parent);
    }
    decode(&output)
}

/// Extractions since the last disk prune. Pruning reads the whole cache
/// directory, so doing it on every extraction added a directory scan to each
/// uncached hover.
static EXTRACTIONS_SINCE_PRUNE: AtomicUsize = AtomicUsize::new(0);
/// How many extractions may pass between prunes. The cache can overshoot
/// `MAX_CACHE_FILES` by at most this much before it is trimmed back.
const PRUNE_INTERVAL: usize = 32;

/// Whether this extraction should pay for the directory scan. Pure apart from
/// the counter, so the amortization is testable.
fn prune_is_due(counter: &AtomicUsize) -> bool {
    let previous = counter.fetch_add(1, Ordering::Relaxed);
    if previous + 1 >= PRUNE_INTERVAL {
        counter.store(0, Ordering::Relaxed);
        return true;
    }
    false
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
            rgba: vec![value; 4],
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
    fn pointer_motion_replaces_pending_work_without_cancelling_inflight_extraction() {
        let queue = WorkerQueue::new();
        let newest = request(2, 8_000);
        queue.submit(newest.clone());
        assert!(!queue.shutdown_requested());
        assert_eq!(
            queue
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .pending,
            Some(newest)
        );
    }

    #[test]
    fn new_previews_are_generated_at_overlay_size() {
        assert_eq!(
            PREVIEW_FILTER,
            "scale=192:108:force_original_aspect_ratio=decrease,pad=192:108:(ow-iw)/2:(oh-ih)/2:black"
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
    fn cache_hit_reuses_the_existing_decoded_frame() {
        let request = request(1, 1_000);
        let key = PreviewCacheKey::from(&request);
        let expected = image(42);
        let mut cache = MemoryPreviewCache::default();
        cache.insert(key.clone(), expected.clone());

        assert_eq!(cache.get(&key), Some(expected));
        assert_eq!(cache.get(&key), Some(image(42)));
    }

    #[test]
    fn local_file_identity_changes_when_path_or_metadata_changes() {
        let first = media_identity("record", Path::new("clip-a.mp4"));
        let second = media_identity("record", Path::new("clip-b.mp4"));
        assert_ne!(first, second);
        assert!(first.starts_with("record|"));
    }

    #[test]
    fn identity_is_memoized_per_loaded_file_and_dropped_when_it_changes() {
        // Hover runs on every frame. Reusing the memoized identity is what keeps
        // a pointer sweep from calling into the filesystem once per event.
        let memoized = (
            "record".to_string(),
            PathBuf::from("clip-a.mp4"),
            "record|clip-a.mp4|10|20".to_string(),
        );
        assert_eq!(
            reusable_identity(Some(&memoized), "record", Path::new("clip-a.mp4")),
            Some("record|clip-a.mp4|10|20".to_string())
        );
        assert_eq!(
            reusable_identity(Some(&memoized), "record", Path::new("clip-b.mp4")),
            None
        );
        assert_eq!(
            reusable_identity(Some(&memoized), "other", Path::new("clip-a.mp4")),
            None
        );
        assert_eq!(
            reusable_identity(None, "record", Path::new("clip-a.mp4")),
            None
        );
    }

    #[test]
    fn a_repeated_hover_slot_is_served_from_cache_without_new_extraction_work() {
        // One quantized slot revisited many times must stay one cache entry and
        // never queue another ffmpeg extraction.
        let queue = WorkerQueue::new();
        let mut cache = MemoryPreviewCache::default();
        let hovered = request(1, 4_000);
        let key = PreviewCacheKey::from(&hovered);
        cache.insert(key.clone(), image(7));

        for _ in 0..32 {
            let hit = cache.get(&key);
            assert_eq!(hit, Some(image(7)));
            if hit.is_none() {
                queue.submit(hovered.clone());
            }
        }
        assert_eq!(cache.order.len(), 1);
        assert!(!queue.shutdown_requested());
        assert!(queue
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .pending
            .is_none());
    }

    #[test]
    fn the_reusable_window_covers_a_real_scrub_and_stays_bounded() {
        // A pointer sweep across a two-hour file revisits slots as it moves back
        // and forth. The cache has to be large enough that a nearby revisit is a
        // hit, and still small enough to stay a hover cache.
        assert!(MAX_MEMORY_PREVIEWS >= 128);
        let frame_bytes = 192 * 108 * 4;
        assert!(MAX_MEMORY_PREVIEWS * frame_bytes <= MAX_MEMORY_CACHE_BYTES);
        // Disk retains at least as much as memory, so an eviction from memory can
        // still be re-decoded instead of re-extracted.
        assert!(MAX_CACHE_FILES >= MAX_MEMORY_PREVIEWS);

        let mut cache = MemoryPreviewCache::default();
        let slot = |index: u64| {
            let mut request = request(index + 1, index * QUANTUM_MILLIS);
            request.timestamp_millis = index * QUANTUM_MILLIS;
            request
        };
        // Sweep forward across the whole window, then sweep back over it.
        for index in 0..MAX_MEMORY_PREVIEWS as u64 {
            let request = slot(index);
            cache.insert(PreviewCacheKey::from(&request), image(index as u8));
        }
        for index in (0..MAX_MEMORY_PREVIEWS as u64).rev() {
            let request = slot(index);
            assert!(
                cache.get(&PreviewCacheKey::from(&request)).is_some(),
                "slot {index} should still be reusable within one sweep"
            );
        }
        assert_eq!(cache.order.len(), MAX_MEMORY_PREVIEWS);
        assert_eq!(cache.images.len(), MAX_MEMORY_PREVIEWS);
    }

    #[test]
    fn disk_pruning_is_amortized_instead_of_running_on_every_extraction() {
        let counter = AtomicUsize::new(0);
        let mut prunes = 0;
        for _ in 0..PRUNE_INTERVAL * 3 {
            if prune_is_due(&counter) {
                prunes += 1;
            }
        }
        assert_eq!(prunes, 3);
        // The very first extraction of a session must not trigger a scan.
        let fresh = AtomicUsize::new(0);
        assert!(!prune_is_due(&fresh));
        assert!(PRUNE_INTERVAL < MAX_CACHE_FILES);
    }

    #[test]
    fn timecode_formats_short_long_and_invalid_positions() {
        assert_eq!(format_timecode(0.0), "00:00");
        assert_eq!(format_timecode(65.9), "01:05");
        assert_eq!(format_timecode(3_661.2), "1:01:01");
        assert_eq!(format_timecode(f64::NAN), "00:00");
    }
}
