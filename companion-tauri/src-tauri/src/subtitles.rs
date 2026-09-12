//! Local subtitle discovery, import, synchronization, and generation.
//!
//! The worker path intentionally mirrors the native-host subtitle contract:
//! local media is reduced to bounded mono AAC with the bundled ffmpeg, the
//! approved Companion license stays inside Rust, and only bounded JSON/result
//! data is retained in the shared job state. All output files are created as
//! new sibling files; a source sidecar or media file is never replaced.

use crate::jobs;
use crate::license;
use crate::media::ValidatedMedia;
use aura_companion_contract as contract;
use reqwest::blocking::{Client, Response};
use reqwest::redirect::Policy;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(crate) const WORKER_URL: &str = "https://aura.mdownloader.workers.dev/api/subtitles";
pub(crate) const MAX_SIDECAR_SUBTITLE_BYTES: u64 = 2 * 1024 * 1024;
pub(crate) const MAX_AUDIO_UPLOAD_BYTES: u64 = 80 * 1024 * 1024;
pub(crate) const MAX_DURATION_SECONDS: u64 = 60 * 60;
pub(crate) const MAX_SUBTITLE_TITLE_BYTES: usize = 240;
pub(crate) const MAX_SUBTITLE_REMOTE_RESPONSE_BYTES: usize =
    MAX_SIDECAR_SUBTITLE_BYTES as usize + 64 * 1024;
pub(crate) const MAX_SUBTITLE_PHASE_BYTES: usize = 128;
pub(crate) const MAX_SYNC_OFFSET_SECONDS: f64 = 24.0 * 60.0 * 60.0;
const POLL_INTERVAL: Duration = Duration::from_millis(1_200);
const MAX_RUNTIME: Duration = Duration::from_secs(30 * 60);
const MAX_ACTIVE_AGE_MS: u64 = 2 * 60 * 60 * 1000;
const SUBTITLE_REQUEST_SUFFIX: &str = ".subtitle.request.json";
const MAX_OUTPUT_ATTEMPTS: u32 = 10_000;

static NEXT_SUBTITLE_JOB_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_TEMP_FILE_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SubtitleFormat {
    Srt,
    Vtt,
    Ass,
}

impl SubtitleFormat {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Srt => "srt",
            Self::Vtt => "vtt",
            Self::Ass => "ass",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SidecarSubtitle {
    pub file_name: String,
    pub format: String,
    pub language: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SelectedSubtitle {
    pub file_name: String,
    pub format: SubtitleFormat,
    pub text: String,
}

pub(crate) fn subtitle_format(file_name: &str) -> Option<SubtitleFormat> {
    match Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("srt") => Some(SubtitleFormat::Srt),
        Some("vtt") => Some(SubtitleFormat::Vtt),
        Some("ass") => Some(SubtitleFormat::Ass),
        _ => None,
    }
}

fn valid_language(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn language_for_file(media_stem: &str, subtitle_stem: &str) -> Option<String> {
    let subtitle_stem = generated_stem_without_collision(subtitle_stem);
    let subtitle_stem = subtitle_stem
        .strip_suffix(".synced")
        .unwrap_or(subtitle_stem);
    let suffix = stem_suffix(media_stem, subtitle_stem)?.strip_prefix('.')?;
    valid_language(suffix).then(|| suffix.to_string())
}

fn generated_stem_without_collision(value: &str) -> &str {
    let Some((stem, suffix)) = value.rsplit_once(" (") else {
        return value;
    };
    suffix
        .strip_suffix(')')
        .is_some_and(|number| !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()))
        .then_some(stem)
        .unwrap_or(value)
}

fn is_synced_stem(value: &str) -> bool {
    generated_stem_without_collision(value)
        .strip_suffix(".synced")
        .is_some()
}

fn shares_media_stem(media_stem: &str, subtitle_stem: &str) -> bool {
    subtitle_stem.eq_ignore_ascii_case(media_stem)
        || stem_suffix(media_stem, subtitle_stem).is_some_and(|suffix| suffix.starts_with('.'))
}

fn stem_suffix<'a>(media_stem: &str, subtitle_stem: &'a str) -> Option<&'a str> {
    let prefix = subtitle_stem.get(..media_stem.len())?;
    prefix
        .eq_ignore_ascii_case(media_stem)
        .then(|| &subtitle_stem[media_stem.len()..])
}

fn read_utf8_subtitle(path: &Path, metadata: &fs::Metadata) -> io::Result<String> {
    if metadata.len() > MAX_SIDECAR_SUBTITLE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "subtitle file is too large",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(path)?
        .take(MAX_SIDECAR_SUBTITLE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_SIDECAR_SUBTITLE_BYTES
        || bytes.contains(&0)
        || bytes
            .iter()
            .any(|byte| byte.is_ascii_control() && !matches!(byte, b'\t' | b'\n' | b'\r'))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "subtitle file is not valid text",
        ));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "subtitle file is not UTF-8"))?;
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

fn valid_file_name_component(file_name: &str) -> bool {
    if file_name.is_empty()
        || file_name.encode_utf16().count() > 255
        || file_name.chars().any(char::is_control)
        || file_name.contains(['/', '\\'])
    {
        return false;
    }
    let path = Path::new(file_name);
    path.file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| name == file_name)
}

fn media_stem(media: &ValidatedMedia) -> io::Result<String> {
    Path::new(&media.file_name)
        .file_stem()
        .and_then(OsStr::to_str)
        .filter(|stem| !stem.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid media name"))
}

fn validate_sidecar_name(media: &ValidatedMedia, file_name: &str) -> io::Result<SubtitleFormat> {
    if !valid_file_name_component(file_name) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid subtitle file name",
        ));
    }
    let format = subtitle_format(file_name).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "subtitle format is not supported",
        )
    })?;
    let media_stem = media_stem(media)?;
    let subtitle_stem = Path::new(file_name)
        .file_stem()
        .and_then(OsStr::to_str)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid subtitle name"))?;
    if !shares_media_stem(&media_stem, subtitle_stem) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "subtitle does not belong to the selected media",
        ));
    }
    Ok(format)
}

fn direct_regular_file(path: &Path) -> io::Result<PathBuf> {
    let link_metadata = fs::symlink_metadata(path)?;
    if !link_metadata.is_file() || link_metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "subtitle source is not a regular file",
        ));
    }
    let canonical = fs::canonicalize(path)?;
    let metadata = fs::metadata(&canonical)?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "subtitle source is not a regular file",
        ));
    }
    Ok(canonical)
}

/// Read one selected sibling sidecar after applying the same direct-file and
/// media-stem checks used by discovery. This is intentionally narrower than a
/// generic path reader so sync cannot operate on an arbitrary file.
pub(crate) fn read_selected_sidecar(
    media: &ValidatedMedia,
    file_name: &str,
) -> io::Result<SelectedSubtitle> {
    let format = validate_sidecar_name(media, file_name)?;
    let directory = media.path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "media directory unavailable")
    })?;
    let path = directory.join(file_name);
    let canonical = direct_regular_file(&path)?;
    if canonical.parent() != Some(directory) || !canonical.starts_with(&media.library_root) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "subtitle sidecar escapes the media directory",
        ));
    }
    let metadata = fs::metadata(&canonical)?;
    Ok(SelectedSubtitle {
        file_name: file_name.to_string(),
        format,
        text: read_utf8_subtitle(&canonical, &metadata)?,
    })
}

fn load_sidecar(
    media_stem: &str,
    path: &Path,
    file_name: String,
    format: SubtitleFormat,
    library_root: &Path,
    directory: &Path,
) -> io::Result<SidecarSubtitle> {
    let canonical = direct_regular_file(path)?;
    if !canonical.starts_with(library_root) || canonical.parent() != Some(directory) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "subtitle sidecar escapes the media directory",
        ));
    }
    let subtitle_stem = Path::new(&file_name)
        .file_stem()
        .and_then(OsStr::to_str)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid subtitle name"))?;
    let language = language_for_file(media_stem, subtitle_stem);
    if !subtitle_stem.eq_ignore_ascii_case(media_stem)
        && language.is_none()
        && !is_synced_stem(subtitle_stem)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "subtitle language metadata is invalid",
        ));
    }
    let metadata = fs::metadata(&canonical)?;
    Ok(SidecarSubtitle {
        file_name,
        format: format.as_str().to_string(),
        language,
        text: read_utf8_subtitle(&canonical, &metadata)?,
    })
}

/// Discover only direct sibling sidecars for one validated media file. A
/// recognized same-stem symlink, binary file, or oversized file fails closed
/// instead of being silently promoted to a subtitle track.
pub(crate) fn discover_sidecar_subtitles(
    media: &ValidatedMedia,
) -> io::Result<Vec<SidecarSubtitle>> {
    let directory = media.path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "media directory unavailable")
    })?;
    let media_stem = media_stem(media)?;
    let mut subtitles = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let file_name = entry
            .file_name()
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "subtitle name is not Unicode")
            })?;
        let Some(format) = subtitle_format(&file_name) else {
            continue;
        };
        let subtitle_stem = Path::new(&file_name)
            .file_stem()
            .and_then(OsStr::to_str)
            .unwrap_or_default();
        if !shares_media_stem(&media_stem, subtitle_stem) {
            continue;
        }
        subtitles.push(load_sidecar(
            &media_stem,
            &entry.path(),
            file_name,
            format,
            &media.library_root,
            directory,
        )?);
    }
    subtitles.sort_by(|left, right| left.file_name.cmp(&right.file_name));
    Ok(subtitles)
}

fn normalized_lines(value: &str) -> String {
    value
        .strip_prefix('\u{feff}')
        .unwrap_or(value)
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}

fn output_stem(value: &str) -> String {
    let mut stem = String::new();
    for character in value.chars() {
        if character.is_control()
            || matches!(
                character,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            )
        {
            stem.push('_');
        } else {
            stem.push(character);
        }
    }
    let stem = stem.trim_end_matches(['.', ' ']);
    let stem: String = stem.chars().take(220).collect();
    if stem.is_empty() {
        "aura-subtitle".to_string()
    } else {
        stem
    }
}

fn temp_output_path(directory: &Path) -> io::Result<PathBuf> {
    for _ in 0..64 {
        let id = NEXT_TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed);
        let path = directory.join(format!(".segma-subtitle-{id}.tmp"));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => {
                drop(file);
                return Ok(path);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "subtitle temporary file allocation limit reached",
    ))
}

fn output_path(directory: &Path, stem: &str, extension: &str, index: u32) -> PathBuf {
    let suffix = if index == 0 {
        String::new()
    } else {
        format!(" ({index})")
    };
    directory.join(format!("{}{suffix}.{extension}", output_stem(stem)))
}

fn replace_file_atomically(temporary: &Path, destination: &Path) -> io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
        const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
        #[link(name = "Kernel32")]
        unsafe extern "system" {
            fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
        }
        let source = temporary
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let target = destination
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let result = unsafe {
            MoveFileExW(
                source.as_ptr(),
                target.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if result == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        fs::rename(temporary, destination)
    }
}

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

/// Create a sibling output without replacement. A temp file is flushed and
/// atomically published through a hard link into a still-unused candidate;
/// races simply try the next collision-safe name.
pub(crate) fn write_collision_safe(
    directory: &Path,
    stem: &str,
    extension: &str,
    bytes: &[u8],
) -> io::Result<String> {
    if bytes.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "subtitle output is empty",
        ));
    }
    fs::create_dir_all(directory)?;
    for index in 0..MAX_OUTPUT_ATTEMPTS {
        let destination = output_path(directory, stem, extension, index);
        match fs::symlink_metadata(&destination) {
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let temporary = temp_output_path(directory)?;
        let result = (|| {
            let mut file = OpenOptions::new().write(true).open(&temporary)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            publish_without_replacement(&temporary, &destination)
        })();
        if result.is_ok() {
            return destination
                .file_name()
                .and_then(OsStr::to_str)
                .map(str::to_owned)
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "invalid subtitle output name")
                });
        }
        let _ = fs::remove_file(&temporary);
        if result
            .as_ref()
            .is_err_and(|error| error.kind() == io::ErrorKind::AlreadyExists)
        {
            continue;
        }
        return Err(result.unwrap_err());
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "subtitle filename allocation limit reached",
    ))
}

pub(crate) fn import_subtitle_from_path(
    media: &ValidatedMedia,
    source: &Path,
) -> io::Result<(String, SubtitleFormat)> {
    let source_name = source
        .file_name()
        .and_then(OsStr::to_str)
        .filter(|name| valid_file_name_component(name))
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "invalid subtitle source name")
        })?;
    let format = subtitle_format(source_name).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "subtitle format is not supported",
        )
    })?;
    let canonical = direct_regular_file(source)?;
    let metadata = fs::metadata(&canonical)?;
    let text = read_utf8_subtitle(&canonical, &metadata)?;
    let stem = format!("{}.imported", media_stem(media)?);
    let directory = media.path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "media directory unavailable")
    })?;
    let output = write_collision_safe(directory, &stem, format.as_str(), text.as_bytes())?;
    Ok((output, format))
}

fn parse_clock(value: &str, separator: char, allow_short: bool) -> Option<(u64, bool)> {
    let value = value.trim();
    let (whole, fraction) = value.split_once('.')?;
    if fraction.is_empty() || fraction.len() > 3 || !fraction.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let millis = fraction
        .parse::<u64>()
        .ok()?
        .checked_mul(10_u64.pow(3 - fraction.len() as u32))?;
    let parts = whole.split(':').collect::<Vec<_>>();
    let has_hours = parts.len() == 3;
    if !has_hours && (!allow_short || parts.len() != 2) {
        return None;
    }
    let (hours, minutes, seconds) = if has_hours {
        (parts[0], parts[1], parts[2])
    } else {
        ("0", parts[0], parts[1])
    };
    if !hours.chars().all(|c| c.is_ascii_digit())
        || !minutes.chars().all(|c| c.is_ascii_digit())
        || !seconds.chars().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let hours = hours.parse::<u64>().ok()?;
    let minutes = minutes.parse::<u64>().ok()?;
    let seconds = seconds.parse::<u64>().ok()?;
    if minutes >= 60 || seconds >= 60 {
        return None;
    }
    let _ = separator;
    hours
        .checked_mul(60)?
        .checked_add(minutes)?
        .checked_mul(60)?
        .checked_add(seconds)?
        .checked_mul(1000)?
        .checked_add(millis)
        .map(|millis| (millis, has_hours))
}

pub(crate) fn parse_vtt_timestamp(value: &str) -> Option<u64> {
    parse_clock(value, '.', true).map(|(millis, _)| millis)
}

fn parse_srt_timestamp(value: &str) -> Option<u64> {
    parse_clock(value, ',', false)
        .map(|(millis, _)| millis)
        .or_else(|| {
            let (whole, fraction) = value.trim().split_once(',')?;
            parse_clock(&format!("{whole}.{fraction}"), ',', false).map(|(millis, _)| millis)
        })
}

fn shifted_timestamp(millis: u64, offset_millis: i64) -> u64 {
    let shifted = i128::from(millis) + i128::from(offset_millis);
    shifted.max(0).min(i128::from(u64::MAX)) as u64
}

fn format_vtt_timestamp(millis: u64, with_hours: bool) -> String {
    let hours = millis / 3_600_000;
    let minutes = (millis / 60_000) % 60;
    let seconds = (millis / 1_000) % 60;
    let fraction = millis % 1_000;
    if with_hours {
        format!("{hours:02}:{minutes:02}:{seconds:02}.{fraction:03}")
    } else {
        let total_minutes = millis / 60_000;
        let seconds = (millis / 1_000) % 60;
        format!("{total_minutes:02}:{seconds:02}.{fraction:03}")
    }
}

fn format_srt_timestamp(millis: u64) -> String {
    let hours = millis / 3_600_000;
    let minutes = (millis / 60_000) % 60;
    let seconds = (millis / 1_000) % 60;
    let millis = millis % 1_000;
    format!("{hours:02}:{minutes:02}:{seconds:02},{millis:03}")
}

fn invalid_subtitle_data() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "subtitle timestamps are invalid",
    )
}

fn offset_millis(offset_seconds: f64) -> io::Result<i64> {
    if !offset_seconds.is_finite() || offset_seconds.abs() > MAX_SYNC_OFFSET_SECONDS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "subtitle offset is outside the supported range",
        ));
    }
    Ok((offset_seconds * 1_000.0).round() as i64)
}

fn shift_srt(text: &str, offset: i64) -> io::Result<String> {
    let normalized = normalized_lines(text);
    let mut result = String::new();
    let mut cue_count = 0_u32;
    let mut previous_start = None;
    for line in normalized.lines() {
        if line.contains("-->") {
            let mut parts = line.split("-->");
            let start_text = parts.next().unwrap_or_default().trim();
            let end_text = parts.next().unwrap_or_default().trim();
            if parts.next().is_some() || end_text.is_empty() {
                return Err(invalid_subtitle_data());
            }
            let start = parse_srt_timestamp(start_text).ok_or_else(invalid_subtitle_data)?;
            let end = parse_srt_timestamp(end_text).ok_or_else(invalid_subtitle_data)?;
            let start = shifted_timestamp(start, offset);
            let end = shifted_timestamp(end, offset);
            if start >= end || previous_start.is_some_and(|previous| start < previous) {
                return Err(invalid_subtitle_data());
            }
            result.push_str(&format!(
                "{} --> {}\n",
                format_srt_timestamp(start),
                format_srt_timestamp(end)
            ));
            previous_start = Some(start);
            cue_count += 1;
        } else {
            result.push_str(line);
            result.push('\n');
        }
    }
    if cue_count == 0 {
        return Err(invalid_subtitle_data());
    }
    Ok(result)
}

fn shift_vtt(text: &str, offset: i64) -> io::Result<String> {
    let normalized = normalized_lines(text);
    if normalized
        .lines()
        .next()
        .is_none_or(|line| line.trim() != "WEBVTT")
    {
        return Err(invalid_subtitle_data());
    }
    let mut result = String::new();
    let mut cue_count = 0_u32;
    let mut previous_start = None;
    for line in normalized.lines() {
        if line.contains("-->") {
            let mut parts = line.split("-->");
            let start_text = parts.next().unwrap_or_default().trim();
            let end_and_settings = parts.next().unwrap_or_default().trim();
            if parts.next().is_some() || end_and_settings.is_empty() {
                return Err(invalid_subtitle_data());
            }
            let end_text = end_and_settings
                .split_whitespace()
                .next()
                .unwrap_or_default();
            let start_parsed =
                parse_clock(start_text, '.', true).ok_or_else(invalid_subtitle_data)?;
            let end_parsed = parse_clock(end_text, '.', true).ok_or_else(invalid_subtitle_data)?;
            let start = shifted_timestamp(start_parsed.0, offset);
            let end = shifted_timestamp(end_parsed.0, offset);
            if start >= end || previous_start.is_some_and(|previous| start < previous) {
                return Err(invalid_subtitle_data());
            }
            let settings = end_and_settings.strip_prefix(end_text).unwrap_or_default();
            result.push_str(&format!(
                "{} --> {}{}\n",
                format_vtt_timestamp(start, start_parsed.1),
                format_vtt_timestamp(end, end_parsed.1),
                settings
            ));
            previous_start = Some(start);
            cue_count += 1;
        } else {
            result.push_str(line);
            result.push('\n');
        }
    }
    if cue_count == 0 || !valid_vtt(&result) {
        return Err(invalid_subtitle_data());
    }
    Ok(result)
}

pub(crate) fn sync_subtitle_text(
    format: SubtitleFormat,
    text: &str,
    offset_seconds: f64,
) -> io::Result<String> {
    let offset = offset_millis(offset_seconds)?;
    match format {
        SubtitleFormat::Srt => shift_srt(text, offset),
        SubtitleFormat::Vtt => shift_vtt(text, offset),
        SubtitleFormat::Ass => Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "ASS synchronization is not supported",
        )),
    }
}

pub(crate) fn sync_subtitle_from_sidecar(
    media: &ValidatedMedia,
    file_name: &str,
    offset_seconds: f64,
) -> io::Result<(String, SubtitleFormat)> {
    let selected = read_selected_sidecar(media, file_name)?;
    let shifted = sync_subtitle_text(selected.format, &selected.text, offset_seconds)?;
    let directory = media.path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "media directory unavailable")
    })?;
    let source_stem = Path::new(file_name)
        .file_stem()
        .and_then(OsStr::to_str)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid subtitle name"))?;
    let output_stem = format!("{source_stem}.synced");
    let output = write_collision_safe(
        directory,
        &output_stem,
        selected.format.as_str(),
        shifted.as_bytes(),
    )?;
    Ok((output, selected.format))
}

pub(crate) fn valid_vtt(vtt: &str) -> bool {
    if vtt.is_empty() || vtt.as_bytes().len() > MAX_SIDECAR_SUBTITLE_BYTES as usize {
        return false;
    }
    let vtt = vtt.strip_prefix('\u{feff}').unwrap_or(vtt);
    if vtt
        .lines()
        .next()
        .is_none_or(|line| line.trim() != "WEBVTT")
    {
        return false;
    }
    let lines = vtt.lines().collect::<Vec<_>>();
    let mut index = 0_usize;
    let mut cue_count = 0_u32;
    let mut previous_start = None;
    while index < lines.len() {
        let line = lines[index];
        if !line.contains("-->") {
            index += 1;
            continue;
        }
        let mut parts = line.split("-->");
        let Some(start) = parts.next().and_then(parse_vtt_timestamp) else {
            return false;
        };
        let Some(end) = parts
            .next()
            .and_then(|value| value.split_whitespace().next())
            .and_then(parse_vtt_timestamp)
        else {
            return false;
        };
        if parts.next().is_some() {
            return false;
        }
        index += 1;
        let mut has_cue_text = false;
        while index < lines.len() && !lines[index].trim().is_empty() {
            if lines[index].contains("-->") {
                return false;
            }
            has_cue_text = true;
            index += 1;
        }
        if !has_cue_text || start >= end || previous_start.is_some_and(|previous| start < previous)
        {
            return false;
        }
        previous_start = Some(start);
        cue_count += 1;
    }
    cue_count > 0
}

fn normalize_vtt(vtt: &str) -> String {
    let normalized = normalized_lines(vtt);
    if normalized.ends_with('\n') {
        normalized
    } else {
        format!("{normalized}\n")
    }
}

fn save_generated_vtt(
    directory: &Path,
    title: &str,
    vtt: &str,
) -> Result<String, SubtitleRunError> {
    let normalized = normalize_vtt(vtt);
    if !valid_vtt(&normalized) {
        return Err(run_error(
            "subtitle-invalid-vtt",
            "subtitle result was empty or structurally invalid",
        ));
    }
    write_collision_safe(directory, title, "vtt", normalized.as_bytes())
        .map_err(|_| run_error("subtitle-save-failed", "subtitle file could not be saved"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalSubtitleRequest {
    pub job_id: String,
    pub folder: Option<String>,
    pub file_name: String,
    pub source_language: String,
    pub target_language: String,
    pub title: String,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct SubtitleRunError {
    pub code: &'static str,
    pub message: &'static str,
}

fn run_error(code: &'static str, message: &'static str) -> SubtitleRunError {
    SubtitleRunError { code, message }
}

#[derive(Debug, Clone)]
pub(crate) struct SubtitleSubmitResult {
    pub remote_job_id: String,
}

#[derive(Debug, Clone)]
pub(crate) struct SubtitlePollResult {
    pub status: String,
    pub phase: Option<String>,
    pub progress: Option<u8>,
    pub completed: Option<u64>,
    pub total: Option<u64>,
    pub result: Option<SubtitleResult>,
}

#[derive(Debug, Clone)]
pub(crate) struct SubtitleResult {
    pub vtt: String,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SubtitleCancelStatus {
    Cancelled,
    Completed,
}

pub(crate) trait SubtitleTransport {
    fn submit(
        &self,
        source_language: &str,
        title: &str,
        audio: &[u8],
        license_key: &str,
    ) -> Result<SubtitleSubmitResult, SubtitleRunError>;

    fn poll(
        &self,
        remote_job_id: &str,
        license_key: &str,
    ) -> Result<SubtitlePollResult, SubtitleRunError>;

    fn cancel(
        &self,
        remote_job_id: &str,
        license_key: &str,
    ) -> Result<SubtitleCancelStatus, SubtitleRunError>;
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct SubtitleRunPolicy {
    pub poll_interval: Duration,
    pub max_runtime: Duration,
    pub max_polls: Option<usize>,
}

impl SubtitleRunPolicy {
    fn production() -> Self {
        Self {
            poll_interval: POLL_INTERVAL,
            max_runtime: MAX_RUNTIME,
            max_polls: None,
        }
    }
}

fn valid_remote_job_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
}

fn bounded_remote_phase(value: Option<&Value>) -> Option<String> {
    let phase = value?.as_str()?;
    if phase.is_empty()
        || phase.len() > MAX_SUBTITLE_PHASE_BYTES
        || !phase
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || " ._-".contains(character))
    {
        return None;
    }
    Some(phase.to_string())
}

fn bounded_remote_model(value: Option<&Value>) -> Option<String> {
    let model = value?.as_str()?;
    (model.len() <= 128
        && model
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || " ._:+/-".contains(character)))
    .then(|| model.to_string())
}

fn known_remote_error(error: &str) -> Option<SubtitleRunError> {
    let (code, message) = match error {
        "subtitle-audio-too-large" => (
            "subtitle-audio-too-large",
            "extracted audio exceeds the subtitle upload limit",
        ),
        "audio-size-mismatch" => (
            "audio-size-mismatch",
            "subtitle audio upload size did not match",
        ),
        "invalid-audio-upload" => ("invalid-audio-upload", "subtitle audio upload was invalid"),
        "invalid-audio-content-type" => (
            "invalid-audio-content-type",
            "subtitle audio type was rejected",
        ),
        "invalid-source-language" => (
            "invalid-source-language",
            "subtitle source language was rejected",
        ),
        "invalid-title" => ("invalid-title", "subtitle title metadata was rejected"),
        "pro-license-required" => (
            "pro-license-required",
            "a valid Companion Pro license is required",
        ),
        "unauthorized" => (
            "unauthorized",
            "subtitle service authorization was rejected",
        ),
        "rate-limited" => ("rate-limited", "subtitle service rate limit reached"),
        "asr-not-configured" => ("asr-not-configured", "subtitle service is not configured"),
        "asr-upstream-unreachable" => (
            "asr-upstream-unreachable",
            "subtitle service upstream is unreachable",
        ),
        "subtitle-too-large" => (
            "subtitle-too-large",
            "subtitle result exceeded the service limit",
        ),
        "job-failed" => ("job-failed", "subtitle service job failed"),
        "subtitle-job-not-owned" => (
            "subtitle-job-not-owned",
            "subtitle job is not owned by this license",
        ),
        "invalid-job-id" => ("invalid-job-id", "subtitle job identifier was rejected"),
        "job-cancellation-failed" => (
            "job-cancellation-failed",
            "subtitle job cancellation failed",
        ),
        _ => return None,
    };
    Some(run_error(code, message))
}

fn response_error(status: StatusCode, body: &Value) -> SubtitleRunError {
    if let Some(error) = body
        .get("error")
        .and_then(Value::as_str)
        .and_then(known_remote_error)
    {
        return error;
    }
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        run_error(
            "pro-license-required",
            "a valid Companion Pro license is required",
        )
    } else if status == StatusCode::TOO_MANY_REQUESTS {
        run_error("rate-limited", "subtitle service rate limit reached")
    } else if status.is_server_error() {
        run_error("subtitle-service-failed", "subtitle service failed")
    } else {
        run_error("subtitle-request-rejected", "subtitle request was rejected")
    }
}

fn read_http_json(response: Response) -> Result<(StatusCode, Value), SubtitleRunError> {
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_SUBTITLE_REMOTE_RESPONSE_BYTES as u64)
    {
        return Err(run_error(
            "subtitle-response-too-large",
            "subtitle service response was too large",
        ));
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_SUBTITLE_REMOTE_RESPONSE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            run_error(
                "subtitle-service-unavailable",
                "subtitle service is unavailable",
            )
        })?;
    if bytes.len() > MAX_SUBTITLE_REMOTE_RESPONSE_BYTES {
        return Err(run_error(
            "subtitle-response-too-large",
            "subtitle service response was too large",
        ));
    }
    let body = serde_json::from_slice(&bytes).map_err(|_| {
        run_error(
            "subtitle-service-invalid-response",
            "subtitle service response was invalid",
        )
    })?;
    Ok((status, body))
}

fn remote_body_error(status: StatusCode, body: &Value) -> Result<(), SubtitleRunError> {
    if !status.is_success() || body.get("ok").and_then(Value::as_bool) == Some(false) {
        Err(response_error(status, body))
    } else {
        Ok(())
    }
}

pub(crate) fn parse_submit_response(
    status: StatusCode,
    body: Value,
) -> Result<SubtitleSubmitResult, SubtitleRunError> {
    remote_body_error(status, &body)?;
    let remote_job_id = body
        .get("jobId")
        .or_else(|| body.get("id"))
        .and_then(Value::as_str)
        .filter(|value| valid_remote_job_id(value))
        .ok_or_else(|| {
            run_error(
                "subtitle-service-invalid-response",
                "subtitle service response was invalid",
            )
        })?;
    Ok(SubtitleSubmitResult {
        remote_job_id: remote_job_id.to_string(),
    })
}

fn parse_progress_value(value: Option<&Value>) -> Option<u8> {
    let number = value?.as_f64()?;
    number
        .is_finite()
        .then(|| number.clamp(0.0, 100.0).round() as u8)
}

pub(crate) fn parse_poll_response(
    status_code: StatusCode,
    body: Value,
) -> Result<SubtitlePollResult, SubtitleRunError> {
    remote_body_error(status_code, &body)?;
    let status = body
        .get("status")
        .and_then(Value::as_str)
        .map(str::to_ascii_lowercase)
        .filter(|status| {
            matches!(
                status.as_str(),
                "queued" | "running" | "completed" | "failed" | "cancelled"
            )
        })
        .ok_or_else(|| {
            run_error(
                "subtitle-service-invalid-response",
                "subtitle service response was invalid",
            )
        })?;
    let result_body = body.get("result").and_then(Value::as_object);
    if let Some(error) = result_body
        .and_then(|result| result.get("error"))
        .and_then(Value::as_str)
    {
        return Err(known_remote_error(error).unwrap_or_else(|| {
            run_error(
                "subtitle-remote-failed",
                "subtitle service failed to process the job",
            )
        }));
    }
    let result = match result_body {
        None => None,
        Some(result) => match result.get("vtt") {
            None => None,
            Some(value) => {
                let vtt = value.as_str().filter(|value| {
                    value.len() <= MAX_SIDECAR_SUBTITLE_BYTES as usize && valid_vtt(value)
                });
                let Some(vtt) = vtt else {
                    return Err(run_error(
                        "subtitle-service-invalid-response",
                        "subtitle service response was invalid",
                    ));
                };
                Some(SubtitleResult {
                    vtt: vtt.to_string(),
                    model: bounded_remote_model(result.get("model")),
                })
            }
        },
    };
    Ok(SubtitlePollResult {
        status,
        phase: bounded_remote_phase(body.get("phase")),
        progress: parse_progress_value(body.get("progress")),
        completed: body.get("completed").and_then(Value::as_u64),
        total: body.get("total").and_then(Value::as_u64),
        result,
    })
}

pub(crate) fn parse_cancel_response(
    status_code: StatusCode,
    body: Value,
) -> Result<SubtitleCancelStatus, SubtitleRunError> {
    remote_body_error(status_code, &body)?;
    match body.get("status").and_then(Value::as_str) {
        Some("cancelled") => Ok(SubtitleCancelStatus::Cancelled),
        Some("completed") => Ok(SubtitleCancelStatus::Completed),
        _ => Err(run_error(
            "subtitle-service-invalid-response",
            "subtitle service response was invalid",
        )),
    }
}

pub(crate) struct HttpSubtitleTransport {
    client: Client,
}

impl HttpSubtitleTransport {
    fn new() -> Result<Self, SubtitleRunError> {
        let client = Client::builder()
            .https_only(true)
            .redirect(Policy::none())
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|_| {
                run_error(
                    "subtitle-service-unavailable",
                    "subtitle service is unavailable",
                )
            })?;
        Ok(Self { client })
    }
}

fn encode_title(title: &str) -> String {
    let clipped: String = title.chars().take(MAX_SUBTITLE_TITLE_BYTES).collect();
    let mut encoded = String::new();
    for byte in clipped.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

impl SubtitleTransport for HttpSubtitleTransport {
    fn submit(
        &self,
        source_language: &str,
        title: &str,
        audio: &[u8],
        license_key: &str,
    ) -> Result<SubtitleSubmitResult, SubtitleRunError> {
        if audio.is_empty() || audio.len() as u64 > MAX_AUDIO_UPLOAD_BYTES {
            return Err(run_error(
                "subtitle-audio-too-large",
                "extracted audio is empty or too large",
            ));
        }
        let response = self
            .client
            .post(WORKER_URL)
            .header(
                reqwest::header::AUTHORIZATION,
                format!("Bearer {license_key}"),
            )
            .header(reqwest::header::CONTENT_TYPE, "audio/mp4")
            .header("x-aura-audio-upload", "1")
            .header("x-aura-audio-bytes", audio.len().to_string())
            .header("x-aura-audio-source", "library-file")
            .header("x-aura-source-language", source_language)
            .header("x-aura-title", encode_title(title))
            .body(audio.to_vec())
            .send()
            .map_err(|_| {
                run_error(
                    "subtitle-service-unavailable",
                    "subtitle service is unavailable",
                )
            })?;
        let (status, body) = read_http_json(response)?;
        parse_submit_response(status, body)
    }

    fn poll(
        &self,
        remote_job_id: &str,
        license_key: &str,
    ) -> Result<SubtitlePollResult, SubtitleRunError> {
        let response = self
            .client
            .get(WORKER_URL)
            .query(&[("id", remote_job_id)])
            .header(
                reqwest::header::AUTHORIZATION,
                format!("Bearer {license_key}"),
            )
            .send()
            .map_err(|_| {
                run_error(
                    "subtitle-service-unavailable",
                    "subtitle service is unavailable",
                )
            })?;
        let (status, body) = read_http_json(response)?;
        parse_poll_response(status, body)
    }

    fn cancel(
        &self,
        remote_job_id: &str,
        license_key: &str,
    ) -> Result<SubtitleCancelStatus, SubtitleRunError> {
        let response = self
            .client
            .delete(WORKER_URL)
            .query(&[("id", remote_job_id)])
            .header(
                reqwest::header::AUTHORIZATION,
                format!("Bearer {license_key}"),
            )
            .send()
            .map_err(|_| {
                run_error(
                    "subtitle-service-unavailable",
                    "subtitle service is unavailable",
                )
            })?;
        let (status, body) = read_http_json(response)?;
        parse_cancel_response(status, body)
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn state_path(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    contract::state_path_in(directory, job_id)
}

fn request_path(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    contract::subtitle_request_path_in(directory, job_id)
}

fn cancel_path(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    contract::cancel_path_in(directory, job_id)
}

fn write_state(directory: &Path, state: &mut jobs::JobState, updated_at: u64) -> io::Result<()> {
    fs::create_dir_all(directory)?;
    state.updated_at = updated_at;
    let bytes = serde_json::to_vec(state).map_err(io::Error::other)?;
    let temporary = directory.join(format!(
        ".{}.state.{}.tmp",
        state.job_id,
        NEXT_TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        replace_file_atomically(&temporary, &state_path(directory, &state.job_id)?)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn read_state(directory: &Path, job_id: &str) -> io::Result<jobs::JobState> {
    let path = state_path(directory, job_id)?;
    let bytes = fs::read(path)?;
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}

fn write_request(directory: &Path, request: &LocalSubtitleRequest) -> io::Result<()> {
    fs::create_dir_all(directory)?;
    let path = request_path(directory, &request.job_id)?;
    let bytes = serde_json::to_vec(request).map_err(io::Error::other)?;
    let temporary = directory.join(format!(
        ".{}.request.{}.tmp",
        request.job_id,
        NEXT_TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        replace_file_atomically(&temporary, &path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn cleanup_active(directory: &Path, job_id: &str) {
    if let Ok(path) = request_path(directory, job_id) {
        let _ = fs::remove_file(path);
    }
    if let Ok(path) = cancel_path(directory, job_id) {
        let _ = fs::remove_file(path);
    }
}

fn set_state(
    directory: &Path,
    state: &mut jobs::JobState,
    status: &str,
    status_text: &str,
    execution_status: Option<&str>,
) -> io::Result<()> {
    state.status = status.to_string();
    state.status_text = status_text.to_string();
    if let Some(execution_status) = execution_status {
        state.execution_status = Some(execution_status.to_string());
    }
    write_state(directory, state, now_millis())
}

fn fail_state(directory: &Path, state: &mut jobs::JobState, error: SubtitleRunError) {
    state.error = Some(error.code.to_string());
    let _ = set_state(directory, state, "failed", error.message, Some("failed"));
    cleanup_active(directory, &state.job_id);
}

fn cancelled_state(directory: &Path, state: &mut jobs::JobState) -> Result<(), SubtitleRunError> {
    let result = set_state(
        directory,
        state,
        "cancelled",
        "Subtitle job cancelled.",
        Some("cancelled"),
    );
    cleanup_active(directory, &state.job_id);
    result.map_err(|_| {
        run_error(
            "subtitle-job-state-failed",
            "subtitle job state is unavailable",
        )
    })?;
    Ok(())
}

fn cancellation_requested(directory: &Path, job_id: &str) -> bool {
    cancel_path(directory, job_id)
        .ok()
        .is_some_and(|path| path.is_file())
}

fn finish_cancel<T: SubtitleTransport>(
    transport: &T,
    directory: &Path,
    output_directory: &Path,
    state: &mut jobs::JobState,
    license_key: Option<&str>,
) -> Result<(), SubtitleRunError> {
    if let (Some(remote_job_id), Some(license_key)) = (state.remote_job_id.as_deref(), license_key)
    {
        match transport.cancel(remote_job_id, license_key) {
            Ok(SubtitleCancelStatus::Cancelled) => return cancelled_state(directory, state),
            Ok(SubtitleCancelStatus::Completed) => {
                let poll = match transport.poll(remote_job_id, license_key) {
                    Ok(poll) => poll,
                    Err(error) => {
                        fail_state(directory, state, error);
                        return Err(error);
                    }
                };
                let Some(result) = poll.result.filter(|_| poll.status == "completed") else {
                    let error = run_error(
                        "subtitle-cancel-state-conflict",
                        "subtitle completed while cancellation was requested",
                    );
                    fail_state(directory, state, error);
                    return Err(error);
                };
                return finish_completed(directory, output_directory, state, result);
            }
            Err(_) => {
                let error = run_error(
                    "subtitle-cancel-failed",
                    "subtitle service cancellation failed",
                );
                fail_state(directory, state, error);
                return Err(error);
            }
        }
    }
    cancelled_state(directory, state)
}

fn finish_completed(
    directory: &Path,
    output_directory: &Path,
    state: &mut jobs::JobState,
    result: SubtitleResult,
) -> Result<(), SubtitleRunError> {
    if set_state(
        directory,
        state,
        "running",
        "Saving subtitle.",
        Some("started"),
    )
    .is_err()
    {
        let error = run_error(
            "subtitle-job-state-failed",
            "subtitle job state is unavailable",
        );
        fail_state(directory, state, error);
        return Err(error);
    }
    let file_name = match save_generated_vtt(
        output_directory,
        state.title.as_deref().unwrap_or("aura-subtitle"),
        &result.vtt,
    ) {
        Ok(file_name) => file_name,
        Err(error) => {
            fail_state(directory, state, error);
            return Err(error);
        }
    };
    state.file_name = Some(file_name);
    state.model = result.model;
    state.progress = Some(100);
    if set_state(
        directory,
        state,
        "completed",
        "Subtitle saved.",
        Some("completed"),
    )
    .is_err()
    {
        let error = run_error(
            "subtitle-job-state-failed",
            "subtitle job state is unavailable",
        );
        fail_state(directory, state, error);
        return Err(error);
    }
    cleanup_active(directory, &state.job_id);
    Ok(())
}

fn read_extracted_audio(path: &Path) -> Result<Vec<u8>, SubtitleRunError> {
    let metadata = fs::metadata(path).map_err(|_| {
        run_error(
            "subtitle-audio-extract-failed",
            "audio could not be extracted",
        )
    })?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_AUDIO_UPLOAD_BYTES {
        return Err(run_error(
            "subtitle-audio-too-large",
            "extracted audio is empty or too large",
        ));
    }
    let mut audio = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(path)
        .and_then(|mut file| file.read_to_end(&mut audio))
        .map_err(|_| {
            run_error(
                "subtitle-audio-extract-failed",
                "extracted audio could not be read",
            )
        })?;
    if audio.is_empty() || audio.len() as u64 > MAX_AUDIO_UPLOAD_BYTES {
        return Err(run_error(
            "subtitle-audio-too-large",
            "extracted audio is empty or too large",
        ));
    }
    Ok(audio)
}

fn extract_audio(
    media: &ValidatedMedia,
    ffmpeg: &Path,
    job_id: &str,
) -> Result<Vec<u8>, SubtitleRunError> {
    let directory = std::env::temp_dir();
    let temporary = directory.join(format!("segma-subtitle-{job_id}-audio.m4a"));
    let _ = fs::remove_file(&temporary);
    let mut command = Command::new(ffmpeg);
    command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-nostdin")
        .arg("-y")
        .arg("-i")
        .arg(&media.path)
        .arg("-vn")
        .arg("-ac")
        .arg("1")
        .arg("-ar")
        .arg("16000")
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg("64k")
        .arg("-t")
        .arg(MAX_DURATION_SECONDS.to_string())
        .arg(&temporary)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let result = command.status().map_err(|_| {
        run_error(
            "subtitle-audio-extract-failed",
            "audio could not be extracted",
        )
    })?;
    let audio = if result.success() {
        read_extracted_audio(&temporary)
    } else {
        Err(run_error(
            "subtitle-audio-extract-failed",
            "audio could not be extracted",
        ))
    };
    let _ = fs::remove_file(&temporary);
    audio
}

fn run_job_with_transport<T, F>(
    transport: &T,
    request: &LocalSubtitleRequest,
    media: &ValidatedMedia,
    companion_root: &Path,
    directory: &Path,
    policy: SubtitleRunPolicy,
    load_audio: F,
) -> Result<(), SubtitleRunError>
where
    T: SubtitleTransport,
    F: FnOnce(&ValidatedMedia, &str) -> Result<Vec<u8>, SubtitleRunError>,
{
    let mut state = read_state(directory, &request.job_id).map_err(|_| {
        run_error(
            "subtitle-job-state-failed",
            "subtitle job state is unavailable",
        )
    })?;
    if cancellation_requested(directory, &request.job_id) {
        return cancelled_state(directory, &mut state);
    }
    let entitlement = license::load_in(companion_root);
    if !entitlement.pro || entitlement.key.is_empty() {
        let error = run_error(
            "pro-license-required",
            "a valid Companion Pro license is required",
        );
        fail_state(directory, &mut state, error);
        return Err(error);
    }
    let license_key = entitlement.key;
    if set_state(
        directory,
        &mut state,
        "preparing",
        "Preparing subtitle audio.",
        Some("started"),
    )
    .is_err()
    {
        let error = run_error(
            "subtitle-job-state-failed",
            "subtitle job state is unavailable",
        );
        fail_state(directory, &mut state, error);
        return Err(error);
    }
    let audio = match load_audio(media, &request.job_id) {
        Ok(audio) => audio,
        Err(error) => {
            fail_state(directory, &mut state, error);
            return Err(error);
        }
    };
    if cancellation_requested(directory, &request.job_id) {
        return finish_cancel(
            transport,
            directory,
            media.path.parent().unwrap_or(directory),
            &mut state,
            None,
        );
    }
    if set_state(
        directory,
        &mut state,
        "submitting",
        "Submitting subtitle job.",
        Some("started"),
    )
    .is_err()
    {
        let error = run_error(
            "subtitle-job-state-failed",
            "subtitle job state is unavailable",
        );
        fail_state(directory, &mut state, error);
        return Err(error);
    }
    let submitted = match transport.submit(
        &request.source_language,
        &request.title,
        &audio,
        &license_key,
    ) {
        Ok(value) => value,
        Err(error) => {
            fail_state(directory, &mut state, error);
            return Err(error);
        }
    };
    state.remote_job_id = Some(submitted.remote_job_id);
    state.phase = Some("queued".into());
    if set_state(
        directory,
        &mut state,
        "running",
        "Subtitle job is running.",
        Some("started"),
    )
    .is_err()
    {
        let error = run_error(
            "subtitle-job-state-failed",
            "subtitle job state is unavailable",
        );
        fail_state(directory, &mut state, error);
        return Err(error);
    }
    let started = std::time::Instant::now();
    let mut poll_count = 0_usize;
    loop {
        if cancellation_requested(directory, &request.job_id) {
            return finish_cancel(
                transport,
                directory,
                media.path.parent().unwrap_or(directory),
                &mut state,
                Some(&license_key),
            );
        }
        if started.elapsed() >= policy.max_runtime
            || policy.max_polls.is_some_and(|limit| poll_count >= limit)
        {
            let _ = transport.cancel(
                state.remote_job_id.as_deref().unwrap_or_default(),
                &license_key,
            );
            let error = run_error("subtitle-timeout", "subtitle job timed out");
            fail_state(directory, &mut state, error);
            return Err(error);
        }
        let poll = match transport.poll(
            state.remote_job_id.as_deref().unwrap_or_default(),
            &license_key,
        ) {
            Ok(value) => value,
            Err(error) => {
                fail_state(directory, &mut state, error);
                return Err(error);
            }
        };
        poll_count += 1;
        state.phase = poll.phase.clone();
        state.progress = poll.progress;
        state.completed = poll.completed;
        state.total = poll.total;
        if let Some(phase) = poll.phase.as_deref() {
            state.status_text = format!("Subtitle processing: {phase}");
        }
        if write_state(directory, &mut state, now_millis()).is_err() {
            let error = run_error(
                "subtitle-job-state-failed",
                "subtitle job state is unavailable",
            );
            fail_state(directory, &mut state, error);
            return Err(error);
        }
        match poll.status.as_str() {
            "queued" | "running" => {}
            "cancelled" => return cancelled_state(directory, &mut state),
            "failed" => {
                let error = run_error(
                    "subtitle-remote-failed",
                    "subtitle service failed to process the job",
                );
                fail_state(directory, &mut state, error);
                return Err(error);
            }
            "completed" => {
                let result = poll.result.ok_or_else(|| {
                    run_error(
                        "subtitle-invalid-vtt",
                        "subtitle result was empty or structurally invalid",
                    )
                });
                return match result {
                    Ok(result) => finish_completed(
                        directory,
                        media.path.parent().unwrap_or(directory),
                        &mut state,
                        result,
                    ),
                    Err(error) => {
                        fail_state(directory, &mut state, error);
                        Err(error)
                    }
                };
            }
            _ => unreachable!(),
        }
        if policy.poll_interval > Duration::ZERO {
            thread::sleep(policy.poll_interval);
        }
    }
}

fn run_job(
    request: LocalSubtitleRequest,
    media: ValidatedMedia,
    companion_root: PathBuf,
    directory: PathBuf,
) {
    let transport = match HttpSubtitleTransport::new() {
        Ok(transport) => transport,
        Err(error) => {
            if let Ok(mut state) = read_state(&directory, &request.job_id) {
                fail_state(&directory, &mut state, error);
            }
            return;
        }
    };
    let _ = run_job_with_transport(
        &transport,
        &request,
        &media,
        &companion_root,
        &directory,
        SubtitleRunPolicy::production(),
        |media, job_id| {
            let ffmpeg = crate::media::bundled_ffmpeg_path()
                .map_err(|_| run_error("tools-not-installed", "ffmpeg is not installed"))?;
            extract_audio(media, &ffmpeg, job_id)
        },
    );
}

fn next_job_id() -> String {
    format!(
        "subtitle-{}-{}",
        now_millis(),
        NEXT_SUBTITLE_JOB_ID.fetch_add(1, Ordering::Relaxed)
    )
}

pub(crate) fn validate_languages(source: &str, target: &str) -> io::Result<(String, String)> {
    let source = source.trim().to_ascii_lowercase();
    let target = target.trim().to_ascii_lowercase();
    if !matches!(source.as_str(), "ja" | "en") || target != "ko" {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "only Japanese or English to Korean subtitles are supported",
        ));
    }
    Ok((source, target))
}

pub(crate) fn start_subtitle_job(
    media: ValidatedMedia,
    source_language: String,
    target_language: String,
) -> io::Result<jobs::JobState> {
    let companion_root = jobs::companion_root()?;
    let directory = jobs::jobs_dir()?;
    let job_id = next_job_id();
    let now = now_millis();
    let request = LocalSubtitleRequest {
        job_id: job_id.clone(),
        folder: media.folder.clone(),
        file_name: media.file_name.clone(),
        source_language: source_language.clone(),
        target_language: target_language.clone(),
        title: media.title(),
    };
    let mut state = jobs::JobState {
        job_id: job_id.clone(),
        job_type: Some("subtitle".into()),
        source_language: Some(source_language),
        target_language: Some(target_language),
        input_kind: Some("local-file".into()),
        output_format: Some("vtt".into()),
        execution_status: Some("queued".into()),
        status: "created".into(),
        status_text: "Subtitle job queued.".into(),
        title: Some(request.title.clone()),
        created_at: now,
        updated_at: now,
        ..jobs::JobState::default()
    };
    write_state(&directory, &mut state, now)?;
    if let Err(error) = write_request(&directory, &request) {
        fail_state(
            &directory,
            &mut state,
            run_error(
                "subtitle-request-persist-failed",
                "Subtitle job could not be prepared.",
            ),
        );
        return Err(error);
    }
    if let Err(error) = set_state(
        &directory,
        &mut state,
        "preparing",
        "Preparing subtitle job.",
        Some("started"),
    ) {
        cleanup_active(&directory, &job_id);
        return Err(error);
    }
    let thread_request = request.clone();
    let thread_media = media;
    let thread_root = companion_root;
    let thread_directory = directory;
    let failed_directory = thread_directory.clone();
    if thread::Builder::new()
        .name(format!("segma-subtitle-{job_id}"))
        .spawn(move || run_job(thread_request, thread_media, thread_root, thread_directory))
        .is_err()
    {
        let error = run_error(
            "subtitle-start-failed",
            "Subtitle job could not be started.",
        );
        fail_state(&failed_directory, &mut state, error);
        return Err(io::Error::other(error.message));
    }
    Ok(state)
}

pub(crate) fn cleanup_stale_requests_in(directory: &Path, now: u64) -> io::Result<()> {
    if !directory.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(directory)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        let name = path.file_name().and_then(OsStr::to_str).unwrap_or_default();
        let Some(job_id) = name.strip_suffix(SUBTITLE_REQUEST_SUFFIX) else {
            continue;
        };
        let Ok(state_file) = state_path(directory, job_id) else {
            let _ = fs::remove_file(path);
            continue;
        };
        let state: Option<jobs::JobState> = fs::read(state_file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        match state {
            None => cleanup_active(directory, job_id),
            Some(state)
                if matches!(state.status.as_str(), "completed" | "failed" | "cancelled") =>
            {
                cleanup_active(directory, job_id)
            }
            Some(mut state) if now.saturating_sub(state.updated_at) > MAX_ACTIVE_AGE_MS => {
                fail_state(
                    directory,
                    &mut state,
                    run_error(
                        "subtitle-interrupted",
                        "Subtitle job expired after an interrupted run.",
                    ),
                );
                cleanup_active(directory, job_id);
            }
            Some(_) => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::StatusCode;
    use std::env;

    fn temp_root(label: &str) -> PathBuf {
        let nonce = now_millis() + NEXT_TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed);
        let root = env::temp_dir().join(format!("segma-tauri-subtitles-{label}-{nonce}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn media(root: &Path, file_name: &str) -> ValidatedMedia {
        let path = root.join(file_name);
        fs::write(&path, b"media").unwrap();
        let metadata = fs::metadata(&path).unwrap();
        ValidatedMedia {
            library_root: fs::canonicalize(root).unwrap(),
            path: fs::canonicalize(path).unwrap(),
            folder: None,
            file_name: file_name.to_string(),
            size: metadata.len(),
            modified_at: 0,
        }
    }

    #[derive(Default)]
    struct FakeTransport {
        polls: std::sync::Mutex<Vec<SubtitlePollResult>>,
        submitted: std::sync::Mutex<Vec<(String, String, usize, String)>>,
        cancelled: std::sync::Mutex<usize>,
    }

    impl SubtitleTransport for FakeTransport {
        fn submit(
            &self,
            source_language: &str,
            title: &str,
            audio: &[u8],
            license_key: &str,
        ) -> Result<SubtitleSubmitResult, SubtitleRunError> {
            self.submitted.lock().unwrap().push((
                source_language.to_string(),
                title.to_string(),
                audio.len(),
                license_key.to_string(),
            ));
            Ok(SubtitleSubmitResult {
                remote_job_id: "fc-test-1".into(),
            })
        }

        fn poll(
            &self,
            _remote_job_id: &str,
            _license_key: &str,
        ) -> Result<SubtitlePollResult, SubtitleRunError> {
            self.polls
                .lock()
                .unwrap()
                .pop()
                .ok_or_else(|| run_error("test-poll-exhausted", "test poll exhausted"))
        }

        fn cancel(
            &self,
            _remote_job_id: &str,
            _license_key: &str,
        ) -> Result<SubtitleCancelStatus, SubtitleRunError> {
            *self.cancelled.lock().unwrap() += 1;
            Ok(SubtitleCancelStatus::Cancelled)
        }
    }

    fn initial_state(directory: &Path, request: &LocalSubtitleRequest) {
        let mut state = jobs::JobState {
            job_id: request.job_id.clone(),
            job_type: Some("subtitle".into()),
            status: "created".into(),
            status_text: "queued".into(),
            title: Some(request.title.clone()),
            ..jobs::JobState::default()
        };
        write_state(directory, &mut state, now_millis()).unwrap();
    }

    #[test]
    fn language_bounds_match_worker_contract() {
        assert_eq!(
            validate_languages(" JA ", "KO").unwrap(),
            ("ja".into(), "ko".into())
        );
        assert!(validate_languages("fr", "ko").is_err());
        assert!(validate_languages("ja", "en").is_err());
        assert!(validate_languages("ja", "ko\0").is_err());
    }

    #[test]
    fn vtt_response_schema_is_bounded_and_validated() {
        let valid = serde_json::json!({
            "ok": true,
            "status": "completed",
            "result": {"vtt": "WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n"}
        });
        let parsed = parse_poll_response(StatusCode::OK, valid).unwrap();
        assert_eq!(parsed.status, "completed");
        assert_eq!(
            parsed.result.unwrap().vtt,
            "WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n"
        );
        let invalid = serde_json::json!({
            "ok": true,
            "status": "completed",
            "result": {"vtt": "not vtt"}
        });
        assert!(parse_poll_response(StatusCode::OK, invalid).is_err());
        let oversized = "x".repeat(MAX_SIDECAR_SUBTITLE_BYTES as usize + 1);
        let oversized =
            serde_json::json!({"ok": true, "status": "completed", "result": {"vtt": oversized}});
        assert!(parse_poll_response(StatusCode::OK, oversized).is_err());
        assert!(parse_submit_response(
            StatusCode::OK,
            serde_json::json!({"ok": true, "jobId": "bad id"})
        )
        .is_err());
    }

    #[test]
    fn srt_and_vtt_sync_shift_and_clamp_negative_time() {
        let srt = "1\n00:00:00,500 --> 00:00:01,500\nhello\n";
        assert_eq!(
            sync_subtitle_text(SubtitleFormat::Srt, srt, -1.0).unwrap(),
            "1\n00:00:00,000 --> 00:00:00,500\nhello\n"
        );
        let vtt = "WEBVTT\n\n00:01.000 --> 00:02.000 align:start\nhello\n";
        assert_eq!(
            sync_subtitle_text(SubtitleFormat::Vtt, vtt, 1.25).unwrap(),
            "WEBVTT\n\n00:02.250 --> 00:03.250 align:start\nhello\n"
        );
        assert!(sync_subtitle_text(SubtitleFormat::Ass, "[Script Info]", 1.0).is_err());
        assert!(
            sync_subtitle_text(SubtitleFormat::Srt, srt, MAX_SYNC_OFFSET_SECONDS + 1.0).is_err()
        );
    }

    #[test]
    fn import_validates_extension_size_utf8_and_collision_names() {
        let root = temp_root("import");
        let media = media(&root, "clip.mp4");
        let source = root.join("picked.srt");
        fs::write(&source, "1\nhello\n").unwrap();
        let first = import_subtitle_from_path(&media, &source).unwrap();
        assert_eq!(first.0, "clip.imported.srt");
        assert!(root.join(&first.0).is_file());
        let second = import_subtitle_from_path(&media, &source).unwrap();
        assert_eq!(second.0, "clip.imported (1).srt");
        let invalid_extension = root.join("picked.txt");
        fs::write(&invalid_extension, "text").unwrap();
        assert!(import_subtitle_from_path(&media, &invalid_extension).is_err());
        let invalid_utf8 = root.join("picked.vtt");
        fs::write(&invalid_utf8, [0xff, 0xfe]).unwrap();
        assert!(import_subtitle_from_path(&media, &invalid_utf8).is_err());
        let oversized = root.join("picked.ass");
        fs::write(
            &oversized,
            vec![b'x'; MAX_SIDECAR_SUBTITLE_BYTES as usize + 1],
        )
        .unwrap();
        assert!(import_subtitle_from_path(&media, &oversized).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sync_writes_collision_safe_copy_and_preserves_source() {
        let root = temp_root("sync");
        let media = media(&root, "clip.mp4");
        fs::write(
            root.join("clip.en.srt"),
            "1\n00:00:01,000 --> 00:00:02,000\nhello\n",
        )
        .unwrap();
        fs::write(
            root.join("clip.en.vtt"),
            "WEBVTT\n\n00:01.000 --> 00:02.000\nhello\n",
        )
        .unwrap();
        let original = fs::read(root.join("clip.en.srt")).unwrap();
        let first = sync_subtitle_from_sidecar(&media, "clip.en.srt", -0.5).unwrap();
        let second = sync_subtitle_from_sidecar(&media, "clip.en.srt", 0.5).unwrap();
        let vtt = sync_subtitle_from_sidecar(&media, "clip.en.vtt", 0.5).unwrap();
        assert_eq!(first.0, "clip.en.synced.srt");
        assert_eq!(second.0, "clip.en.synced (1).srt");
        assert_eq!(fs::read(root.join("clip.en.srt")).unwrap(), original);
        assert!(fs::read_to_string(root.join(&first.0))
            .unwrap()
            .contains("00:00:00,500"));
        let discovered = discover_sidecar_subtitles(&media).unwrap();
        assert_eq!(
            discovered
                .iter()
                .find(|subtitle| subtitle.file_name == first.0)
                .and_then(|subtitle| subtitle.language.as_deref()),
            Some("en")
        );
        assert_eq!(
            discovered
                .iter()
                .find(|subtitle| subtitle.file_name == second.0)
                .and_then(|subtitle| subtitle.language.as_deref()),
            Some("en")
        );
        assert_eq!(
            discovered
                .iter()
                .find(|subtitle| subtitle.file_name == vtt.0)
                .and_then(|subtitle| subtitle.language.as_deref()),
            Some("en")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sync_without_language_suffix_is_discoverable_as_unlabelled_srt_and_vtt() {
        let root = temp_root("sync-no-language");
        let media = media(&root, "clip.mp4");
        fs::write(
            root.join("clip.srt"),
            "1\n00:00:01,000 --> 00:00:02,000\nhello\n",
        )
        .unwrap();
        fs::write(
            root.join("clip.vtt"),
            "WEBVTT\n\n00:01.000 --> 00:02.000\nhello\n",
        )
        .unwrap();
        let srt = sync_subtitle_from_sidecar(&media, "clip.srt", 0.5).unwrap();
        let vtt = sync_subtitle_from_sidecar(&media, "clip.vtt", 0.5).unwrap();
        let discovered = discover_sidecar_subtitles(&media).unwrap();
        for output in [srt.0, vtt.0] {
            assert_eq!(
                discovered
                    .iter()
                    .find(|subtitle| subtitle.file_name == output)
                    .and_then(|subtitle| subtitle.language.as_deref()),
                None
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn job_transitions_persist_progress_and_cleanup_request() {
        let root = temp_root("job");
        let directory = root.join("jobs");
        let media = media(&root, "clip.mp4");
        let request = LocalSubtitleRequest {
            job_id: "subtitle-test-1".into(),
            folder: None,
            file_name: "clip.mp4".into(),
            source_language: "ja".into(),
            target_language: "ko".into(),
            title: "clip".into(),
        };
        initial_state(&directory, &request);
        write_request(&directory, &request).unwrap();
        let transport = FakeTransport::default();
        transport.polls.lock().unwrap().push(SubtitlePollResult {
            status: "completed".into(),
            phase: Some("finalizing".into()),
            progress: Some(99),
            completed: Some(1),
            total: Some(1),
            result: Some(SubtitleResult {
                vtt: "WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n".into(),
                model: Some("test-model".into()),
            }),
        });
        let companion_root = root.join("companion");
        fs::create_dir_all(&companion_root).unwrap();
        fs::write(
            jobs::settings_path(&companion_root),
            br#"{"licenseKey":"AM-0123456789ABCDEF0123456789ABCDEF0123","licenseEdition":"pro","licenseStatus":"approved"}"#,
        )
        .unwrap();
        run_job_with_transport(
            &transport,
            &request,
            &media,
            &companion_root,
            &directory,
            SubtitleRunPolicy {
                poll_interval: Duration::ZERO,
                max_runtime: Duration::from_secs(1),
                max_polls: Some(2),
            },
            |_, _| Ok(vec![1, 2, 3]),
        )
        .unwrap();
        let state = read_state(&directory, &request.job_id).unwrap();
        assert_eq!(state.status, "completed");
        assert_eq!(state.progress, Some(100));
        assert!(state.file_name.is_some());
        assert!(!request_path(&directory, &request.job_id).unwrap().exists());
        assert!(!cancel_path(&directory, &request.job_id).unwrap().exists());
        assert_eq!(
            transport.submitted.lock().unwrap()[0].3,
            "AM-0123456789ABCDEF0123456789ABCDEF0123"
        );
        assert!(root.join(state.file_name.unwrap()).is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn temporary_output_cleanup_leaves_no_temp_files_after_persist() {
        let root = temp_root("cleanup");
        let name = write_collision_safe(&root, "clip", "vtt", b"WEBVTT\n").unwrap();
        assert_eq!(name, "clip.vtt");
        let temporary = fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".tmp"));
        assert!(!temporary);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn existing_sidecar_discovery_keeps_same_stem_behavior() {
        let root = temp_root("discovery");
        let media = media(&root, "Clip.MP4");
        fs::write(root.join("clip.ko.srt"), "1\nhello\n").unwrap();
        fs::write(root.join("other.srt"), "other").unwrap();
        let subtitles = discover_sidecar_subtitles(&media).unwrap();
        assert_eq!(subtitles.len(), 1);
        assert_eq!(subtitles[0].file_name, "clip.ko.srt");
        fs::remove_dir_all(root).unwrap();
    }
}
