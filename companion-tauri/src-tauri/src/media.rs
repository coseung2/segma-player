//! Validated local-media operations used by the Tauri command boundary.
//!
//! The frontend supplies only a library folder/file reference. This module
//! resolves that reference through the existing library contract, keeps all
//! ffmpeg paths and output paths backend-owned, and never replaces an existing
//! output file.

use crate::jobs;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(crate) const MAX_GIF_DURATION_SECONDS: f64 = 30.0;
pub(crate) const MAX_GIF_START_SECONDS: f64 = 24.0 * 60.0 * 60.0;
pub(crate) const MIN_GIF_WIDTH: u32 = 16;
pub(crate) const MAX_GIF_WIDTH: u32 = 3_840;
pub(crate) const MIN_GIF_FPS: u32 = 1;
pub(crate) const MAX_GIF_FPS: u32 = 60;
pub(crate) const PREVIEW_QUANTUM_MILLIS: u64 = 500;
pub(crate) const PREVIEW_FILTER: &str =
    "scale=192:108:force_original_aspect_ratio=decrease,pad=192:108:(ow-iw)/2:(oh-ih)/2:black";
pub(crate) const THUMBNAIL_FILTER: &str =
    "thumbnail,scale=640:360:force_original_aspect_ratio=increase,crop=640:360";

static NEXT_OPERATION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ValidatedMedia {
    pub library_root: PathBuf,
    pub path: PathBuf,
    pub folder: Option<String>,
    pub file_name: String,
    pub size: u64,
    pub modified_at: u64,
}

impl ValidatedMedia {
    pub(crate) fn title(&self) -> String {
        Path::new(&self.file_name)
            .file_stem()
            .and_then(OsStr::to_str)
            .filter(|stem| !stem.is_empty())
            .unwrap_or(&self.file_name)
            .to_string()
    }

    pub(crate) fn mime_type(&self) -> &'static str {
        mime_type_for_file_name(&self.file_name)
    }

    pub(crate) fn cache_key(&self) -> String {
        format!(
            "{}\0{}\0{}\0{}",
            self.folder.as_deref().unwrap_or_default(),
            self.file_name,
            self.size,
            self.modified_at
        )
    }
}

pub(crate) fn mime_type_for_file_name(file_name: &str) -> &'static str {
    match Path::new(file_name)
        .extension()
        .and_then(OsStr::to_str)
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("mkv") => "video/x-matroska",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("ts") | Some("m2ts") => "video/mp2t",
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        Some("flac") => "audio/flac",
        _ => "application/octet-stream",
    }
}

pub(crate) fn is_video_file_name(file_name: &str) -> bool {
    matches!(
        Path::new(file_name)
            .extension()
            .and_then(OsStr::to_str)
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("mp4")
            | Some("mkv")
            | Some("webm")
            | Some("m4v")
            | Some("mov")
            | Some("ts")
            | Some("m2ts")
    )
}

/// Resolve a library reference to a canonical regular file under `root`.
/// `jobs::media_path_in` owns the component validation and direct-folder
/// symlink checks; this final canonicalization also protects callers that use
/// the returned path in a child process.
pub(crate) fn validate_media_ref(
    root: &Path,
    folder: Option<&str>,
    file_name: &str,
) -> io::Result<ValidatedMedia> {
    let path = jobs::media_path_in(root, folder, file_name)?;
    let canonical_root = fs::canonicalize(root)?;
    let metadata = fs::symlink_metadata(&path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "library target is not a regular media file",
        ));
    }
    let canonical = fs::canonicalize(&path)?;
    if !canonical.starts_with(&canonical_root) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "media file escapes the download root",
        ));
    }
    let metadata = fs::metadata(&canonical)?;
    if !metadata.is_file() || !jobs::is_media_file_name(file_name) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "library target is not a regular media file",
        ));
    }
    Ok(ValidatedMedia {
        library_root: canonical_root,
        path: canonical,
        folder: folder.map(str::to_owned),
        file_name: file_name.to_string(),
        size: metadata.len(),
        modified_at: modified_millis(&metadata),
    })
}

pub(crate) fn bundled_ffmpeg_path() -> io::Result<PathBuf> {
    let beside_application = std::env::current_exe()?
        .parent()
        .unwrap_or(Path::new("."))
        .join("tools")
        .join("ffmpeg")
        .join("ffmpeg.exe");
    if beside_application.is_file() {
        return Ok(beside_application);
    }

    let installed = jobs::companion_root()?
        .join("tools")
        .join("ffmpeg")
        .join("ffmpeg.exe");
    if installed.is_file() {
        return Ok(installed);
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "bundled ffmpeg is unavailable",
    ))
}

fn modified_millis(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn run_ffmpeg(ffmpeg: &Path, arguments: &[OsString]) -> io::Result<()> {
    let mut command = Command::new(ffmpeg);
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let status = command.status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other("ffmpeg operation failed"))
    }
}

fn modified_cache_file(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.is_file() && !metadata.file_type().is_symlink() {
                Ok(true)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "cache entry is not a regular file",
                ))
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn cache_directory(root: &Path, name: &str) -> PathBuf {
    root.join(name)
}

pub(crate) fn seek_preview_cache_path(
    root: &Path,
    media_key: &str,
    timestamp_millis: u64,
) -> PathBuf {
    cache_directory(root, "seek-previews")
        .join(seek_preview_cache_name(media_key, timestamp_millis))
}

pub(crate) fn thumbnail_cache_path(root: &Path, media_key: &str) -> PathBuf {
    cache_directory(root, "thumbnails").join(thumbnail_cache_name(media_key))
}

pub(crate) fn seek_preview_cache_name(media_key: &str, timestamp_millis: u64) -> String {
    let hash = fnv1a(
        media_key
            .as_bytes()
            .iter()
            .copied()
            .chain(timestamp_millis.to_le_bytes()),
    );
    format!("{hash:016x}-{timestamp_millis:010}.jpg")
}

pub(crate) fn thumbnail_cache_name(media_key: &str) -> String {
    format!("{:016x}.jpg", fnv1a(media_key.as_bytes().iter().copied()))
}

fn fnv1a<I>(bytes: I) -> u64
where
    I: IntoIterator<Item = u8>,
{
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Clamp a requested hover position and quantize it to the same half-second
/// cache slots used by the legacy seek-preview implementation.
pub(crate) fn quantize_timestamp(target_seconds: f64, duration_seconds: f64) -> u64 {
    if !target_seconds.is_finite() || !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return 0;
    }
    let maximum = (duration_seconds - 0.001).max(0.0);
    let clamped_millis = (target_seconds.max(0.0).min(maximum) * 1_000.0).floor() as u64;
    clamped_millis / PREVIEW_QUANTUM_MILLIS * PREVIEW_QUANTUM_MILLIS
}

fn temporary_path(directory: &Path, stem: &str, extension: &str) -> io::Result<PathBuf> {
    for _ in 0..64 {
        let id = NEXT_OPERATION_ID.fetch_add(1, Ordering::Relaxed);
        let candidate = directory.join(format!(".{stem}-{id}.tmp.{extension}"));
        match fs::symlink_metadata(&candidate) {
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(candidate),
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a temporary media output",
    ))
}

/// Publish a same-directory temporary file without replacing any existing
/// path. Hard-link creation is an atomic create-new operation on the supported
/// local filesystems; the temporary link is removed after publication.
fn publish_without_replacement(temporary: &Path, destination: &Path) -> io::Result<()> {
    match fs::hard_link(temporary, destination) {
        Ok(()) => {
            fs::remove_file(temporary)?;
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_file(temporary);
            Err(error)
        }
    }
}

fn remove_file_quietly(path: &Path) {
    let _ = fs::remove_file(path);
}

fn truncate_utf16(value: &str, maximum_units: usize) -> String {
    let mut used = 0;
    value
        .chars()
        .take_while(|character| {
            let units = character.len_utf16();
            if used + units > maximum_units {
                return false;
            }
            used += units;
            true
        })
        .collect()
}

fn output_stem(source: &Path) -> String {
    source
        .file_stem()
        .and_then(OsStr::to_str)
        .filter(|stem| !stem.is_empty())
        .map(|stem| truncate_utf16(stem, 220))
        .filter(|stem| !stem.is_empty())
        .unwrap_or_else(|| "aura-export".to_string())
}

fn unique_output_path(directory: &Path, source: &Path, extension: &str) -> io::Result<PathBuf> {
    let stem = output_stem(source);
    for index in 0_u32..10_000 {
        let name = if index == 0 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem} ({}).{extension}", index + 1)
        };
        let candidate = directory.join(name);
        match fs::symlink_metadata(&candidate) {
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(candidate),
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not find an unused media destination",
    ))
}

fn safe_gif_stem(value: &str) -> String {
    let mut result = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
            result.push(character);
        } else if !result.ends_with('_') {
            result.push('_');
        }
    }
    let trimmed = result.trim_matches('_');
    truncate_utf16(trimmed, 220)
}

/// Keep the existing Companion GIF naming contract: `clip.gif`, then
/// `clip-1.gif`, and so on, without replacing a prior export.
fn unique_gif_output_path(directory: &Path, source: &Path) -> io::Result<PathBuf> {
    let stem = source
        .file_stem()
        .and_then(OsStr::to_str)
        .map(safe_gif_stem)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "aura-export".to_string());
    for index in 0_u32..10_000 {
        let name = if index == 0 {
            format!("{stem}.gif")
        } else {
            format!("{stem}-{index}.gif")
        };
        let candidate = directory.join(name);
        match fs::symlink_metadata(&candidate) {
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(candidate),
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not find an unused GIF destination",
    ))
}

pub(crate) fn remux_ffmpeg_arguments(source: &Path, temporary: &Path) -> Vec<OsString> {
    vec![
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-nostdin"),
        OsString::from("-i"),
        source.as_os_str().to_owned(),
        OsString::from("-map"),
        OsString::from("0"),
        OsString::from("-c"),
        OsString::from("copy"),
        OsString::from("-movflags"),
        OsString::from("+faststart"),
        temporary.as_os_str().to_owned(),
    ]
}

pub(crate) fn remux_ts_to_mp4(media: &ValidatedMedia, ffmpeg: &Path) -> io::Result<PathBuf> {
    let extension = Path::new(&media.file_name)
        .extension()
        .and_then(OsStr::to_str)
        .map(|value| value.to_ascii_lowercase());
    if !matches!(extension.as_deref(), Some("ts") | Some("m2ts")) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "only transport-stream media can be remuxed",
        ));
    }
    let directory = media.path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "media directory unavailable")
    })?;
    let destination = unique_output_path(directory, &media.path, "mp4")?;
    let temporary = temporary_path(directory, &output_stem(&media.path), "mp4")?;
    let arguments = remux_ffmpeg_arguments(&media.path, &temporary);
    if let Err(error) = run_ffmpeg(ffmpeg, &arguments) {
        remove_file_quietly(&temporary);
        return Err(error);
    }
    if let Err(error) = publish_without_replacement(&temporary, &destination) {
        remove_file_quietly(&temporary);
        return Err(error);
    }
    Ok(destination)
}

pub(crate) fn seek_preview_ffmpeg_arguments(
    source: &Path,
    timestamp_millis: u64,
    temporary: &Path,
) -> Vec<OsString> {
    vec![
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-nostdin"),
        OsString::from("-ss"),
        OsString::from(format!("{:.3}", timestamp_millis as f64 / 1_000.0)),
        OsString::from("-i"),
        source.as_os_str().to_owned(),
        OsString::from("-frames:v"),
        OsString::from("1"),
        OsString::from("-vf"),
        OsString::from(PREVIEW_FILTER),
        OsString::from("-q:v"),
        OsString::from("4"),
        temporary.as_os_str().to_owned(),
    ]
}

fn generate_image<F>(
    ffmpeg: &Path,
    output: &Path,
    temporary_stem: &str,
    build_arguments: F,
) -> io::Result<PathBuf>
where
    F: FnOnce(&Path) -> Vec<OsString>,
{
    if modified_cache_file(output)? {
        return Ok(output.to_path_buf());
    }
    let directory = output.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "image cache directory unavailable",
        )
    })?;
    fs::create_dir_all(directory)?;
    let temporary = temporary_path(directory, temporary_stem, "jpg")?;
    let arguments = build_arguments(&temporary);
    if let Err(error) = run_ffmpeg(ffmpeg, &arguments) {
        remove_file_quietly(&temporary);
        return Err(error);
    }
    if let Err(error) = publish_without_replacement(&temporary, output) {
        remove_file_quietly(&temporary);
        return Err(error);
    }
    Ok(output.to_path_buf())
}

pub(crate) fn generate_seek_preview(
    media: &ValidatedMedia,
    timestamp_seconds: f64,
    duration_seconds: f64,
    cache_root: &Path,
    ffmpeg: &Path,
) -> io::Result<(PathBuf, u64)> {
    if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "media duration must be positive and finite",
        ));
    }
    let timestamp_millis = quantize_timestamp(timestamp_seconds, duration_seconds);
    let output = seek_preview_cache_path(cache_root, &media.cache_key(), timestamp_millis);
    let output = generate_image(ffmpeg, &output, &output_stem(&media.path), |temporary| {
        seek_preview_ffmpeg_arguments(&media.path, timestamp_millis, temporary)
    })?;
    Ok((output, timestamp_millis))
}

pub(crate) fn thumbnail_ffmpeg_arguments(source: &Path, temporary: &Path) -> Vec<OsString> {
    vec![
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-nostdin"),
        OsString::from("-ss"),
        OsString::from("3"),
        OsString::from("-i"),
        source.as_os_str().to_owned(),
        OsString::from("-frames:v"),
        OsString::from("1"),
        OsString::from("-vf"),
        OsString::from(THUMBNAIL_FILTER),
        OsString::from("-q:v"),
        OsString::from("4"),
        temporary.as_os_str().to_owned(),
    ]
}

pub(crate) fn generate_thumbnail(
    media: &ValidatedMedia,
    cache_root: &Path,
    ffmpeg: &Path,
) -> io::Result<PathBuf> {
    let output = thumbnail_cache_path(cache_root, &media.cache_key());
    generate_image(ffmpeg, &output, &output_stem(&media.path), |temporary| {
        thumbnail_ffmpeg_arguments(&media.path, temporary)
    })
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ValidatedGifRequest {
    pub start_seconds: f64,
    pub duration_seconds: f64,
    pub width: u32,
    pub fps: u32,
}

pub(crate) fn validate_gif_request(
    start_seconds: f64,
    end_seconds: f64,
    width: u32,
    fps: u32,
) -> io::Result<ValidatedGifRequest> {
    if !start_seconds.is_finite()
        || !end_seconds.is_finite()
        || start_seconds < 0.0
        || start_seconds > MAX_GIF_START_SECONDS
        || end_seconds <= start_seconds
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "GIF range is outside the supported bounds",
        ));
    }
    if !(MIN_GIF_WIDTH..=MAX_GIF_WIDTH).contains(&width)
        || !(MIN_GIF_FPS..=MAX_GIF_FPS).contains(&fps)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "GIF dimensions or frame rate are outside the supported bounds",
        ));
    }
    let duration_seconds = (end_seconds - start_seconds).min(MAX_GIF_DURATION_SECONDS);
    if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "GIF duration is outside the supported bounds",
        ));
    }
    Ok(ValidatedGifRequest {
        start_seconds,
        duration_seconds,
        width,
        fps,
    })
}

pub(crate) fn gif_ffmpeg_arguments(
    media: &ValidatedMedia,
    request: &ValidatedGifRequest,
    temporary: &Path,
) -> Vec<OsString> {
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
        media.path.as_os_str().to_owned(),
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

pub(crate) fn export_gif(
    media: &ValidatedMedia,
    request: &ValidatedGifRequest,
    ffmpeg: &Path,
) -> io::Result<PathBuf> {
    if !is_video_file_name(&media.file_name) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "GIF export requires video media",
        ));
    }
    let directory = media.path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "media directory unavailable")
    })?;
    let destination = unique_gif_output_path(directory, &media.path)?;
    let temporary = temporary_path(directory, &output_stem(&media.path), "gif")?;
    let arguments = gif_ffmpeg_arguments(media, request, &temporary);
    if let Err(error) = run_ffmpeg(ffmpeg, &arguments) {
        remove_file_quietly(&temporary);
        return Err(error);
    }
    if let Err(error) = publish_without_replacement(&temporary, &destination) {
        remove_file_quietly(&temporary);
        return Err(error);
    }
    Ok(destination)
}

pub(crate) fn open_media_externally(media: &ValidatedMedia) -> io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer.exe")
            .arg(&media.path)
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = media;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "opening media externally is Windows only",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = env::temp_dir().join(format!("segma-tauri-media-{label}-{nonce}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn media(root: &Path, file_name: &str) -> ValidatedMedia {
        let path = root.join(file_name);
        fs::write(&path, b"fixture").unwrap();
        let metadata = fs::metadata(&path).unwrap();
        ValidatedMedia {
            library_root: root.to_path_buf(),
            path,
            folder: None,
            file_name: file_name.to_string(),
            size: metadata.len(),
            modified_at: modified_millis(&metadata),
        }
    }

    #[test]
    fn timestamp_bounds_are_clamped_and_quantized_without_eof_seeking() {
        assert_eq!(quantize_timestamp(-1.0, 10.0), 0);
        assert_eq!(quantize_timestamp(1.499, 10.0), 1_000);
        assert_eq!(quantize_timestamp(1.500, 10.0), 1_500);
        assert_eq!(quantize_timestamp(99.0, 10.0), 9_500);
        assert_eq!(quantize_timestamp(f64::NAN, 10.0), 0);
        assert_eq!(quantize_timestamp(1.0, 0.0), 0);
    }

    #[test]
    fn cache_names_and_paths_are_deterministic_and_stay_in_the_cache_root() {
        let root = Path::new("C:\\cache");
        let first = seek_preview_cache_path(root, "clip\0key", 1_000);
        assert_eq!(first, seek_preview_cache_path(root, "clip\0key", 1_000));
        assert_ne!(first, seek_preview_cache_path(root, "clip\0key", 1_500));
        assert!(first.starts_with(root.join("seek-previews")));
        assert!(first
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with("-0000001000.jpg"));
        assert!(thumbnail_cache_path(root, "clip").starts_with(root.join("thumbnails")));
    }

    #[test]
    fn media_reference_rejects_traversal_and_non_media_targets() {
        let root = temp_root("path");
        fs::write(root.join("clip.mp4"), b"media").unwrap();
        fs::write(root.join("notes.txt"), b"text").unwrap();
        assert!(validate_media_ref(&root, None, "clip.mp4").is_ok());
        assert!(validate_media_ref(&root, None, "../clip.mp4").is_err());
        assert!(validate_media_ref(&root, None, "notes.txt").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn media_reference_rejects_symlinked_files() {
        let root = temp_root("symlink");
        fs::write(root.join("real.mp4"), b"media").unwrap();
        std::os::unix::fs::symlink(root.join("real.mp4"), root.join("linked.mp4")).unwrap();
        assert!(validate_media_ref(&root, None, "linked.mp4").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remux_arguments_require_copy_and_faststart_without_overwrite() {
        let arguments = remux_ffmpeg_arguments(
            Path::new("C:\\Media\\clip.ts"),
            Path::new("C:\\Media\\.clip-1.tmp.mp4"),
        );
        assert!(arguments
            .windows(2)
            .any(|pair| { pair[0] == OsString::from("-c") && pair[1] == OsString::from("copy") }));
        assert!(arguments.windows(2).any(|pair| {
            pair[0] == OsString::from("-movflags") && pair[1] == OsString::from("+faststart")
        }));
        assert!(!arguments.iter().any(|argument| argument == "-y"));
    }

    #[test]
    fn remux_failure_preserves_transport_stream_and_output_collisions_are_renamed() {
        let root = temp_root("remux-failure");
        let source = media(&root, "clip.ts");
        fs::write(root.join("clip.mp4"), b"existing").unwrap();
        let destination = unique_output_path(&root, &source.path, "mp4").unwrap();
        assert_eq!(destination.file_name().unwrap(), "clip (2).mp4");
        let result = remux_ts_to_mp4(&source, Path::new("missing-ffmpeg.exe"));
        assert!(result.is_err());
        assert_eq!(fs::read(&source.path).unwrap(), b"fixture");
        assert_eq!(fs::read(root.join("clip.mp4")).unwrap(), b"existing");
        assert!(!destination.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn thumbnail_arguments_keep_the_existing_filter_and_source_path() {
        let arguments = thumbnail_ffmpeg_arguments(
            Path::new("C:\\Media\\clip.mkv"),
            Path::new("C:\\Cache\\frame.tmp.jpg"),
        );
        assert!(arguments.windows(2).any(|pair| {
            pair[0] == OsString::from("-i") && pair[1] == OsString::from("C:\\Media\\clip.mkv")
        }));
        assert!(arguments.iter().any(|argument| {
            argument
                .to_str()
                .is_some_and(|value| value == THUMBNAIL_FILTER)
        }));
    }

    #[test]
    fn cached_preview_and_thumbnail_paths_are_reused_without_running_ffmpeg() {
        let media_root = temp_root("cache-source");
        let cache_root = temp_root("cache-output");
        let source = media(&media_root, "clip.mp4");
        let key = source.cache_key();
        let timestamp = quantize_timestamp(2.2, 10.0);
        let preview = seek_preview_cache_path(&cache_root, &key, timestamp);
        fs::create_dir_all(preview.parent().unwrap()).unwrap();
        fs::write(&preview, b"cached-preview").unwrap();
        let (preview_result, actual_timestamp) = generate_seek_preview(
            &source,
            2.2,
            10.0,
            &cache_root,
            Path::new("missing-ffmpeg.exe"),
        )
        .unwrap();
        assert_eq!(actual_timestamp, timestamp);
        assert_eq!(preview_result, preview);

        let thumbnail = thumbnail_cache_path(&cache_root, &key);
        fs::create_dir_all(thumbnail.parent().unwrap()).unwrap();
        fs::write(&thumbnail, b"cached-thumbnail").unwrap();
        assert_eq!(
            generate_thumbnail(&source, &cache_root, Path::new("missing-ffmpeg.exe")).unwrap(),
            thumbnail
        );
        fs::remove_dir_all(media_root).unwrap();
        fs::remove_dir_all(cache_root).unwrap();
    }

    #[test]
    fn gif_validation_caps_duration_and_rejects_unsafe_ranges() {
        let request = validate_gif_request(4.0, 99.0, 640, 15).unwrap();
        assert_eq!(request.start_seconds, 4.0);
        assert_eq!(request.duration_seconds, MAX_GIF_DURATION_SECONDS);
        for (start, end) in [
            (f64::NAN, 1.0),
            (-0.1, 1.0),
            (MAX_GIF_START_SECONDS + 1.0, MAX_GIF_START_SECONDS + 2.0),
            (3.0, 3.0),
        ] {
            assert!(validate_gif_request(start, end, 640, 15).is_err());
        }
        assert!(validate_gif_request(0.0, 1.0, 15, 15).is_err());
        assert!(validate_gif_request(0.0, 1.0, 640, 0).is_err());
    }

    #[test]
    fn failed_ffmpeg_preserves_source_and_does_not_leave_destination() {
        let root = temp_root("failure");
        let source = media(&root, "clip.ts");
        let request = validate_gif_request(0.0, 1.0, 320, 10).unwrap();
        let result = export_gif(&source, &request, Path::new("missing-ffmpeg.exe"));
        assert!(result.is_err());
        assert!(source.path.is_file());
        assert!(!root.join("clip.gif").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gif_destination_keeps_the_existing_suffix_contract() {
        let root = temp_root("gif-collision");
        fs::write(root.join("clip.gif"), b"existing").unwrap();
        let destination = unique_gif_output_path(&root, Path::new("clip.mp4")).unwrap();
        assert_eq!(destination.file_name().unwrap(), "clip-1.gif");
        fs::remove_dir_all(root).unwrap();
    }
}
