//! Disk-backed Companion jobs and library operations.
//!
//! This module intentionally uses the shared contract crate for the Companion
//! root, settings document, safe job ids, and marker filenames. The native
//! host remains the owner of durable job state and runner processes; this
//! crate only reads state and writes the existing cancel/pause markers.

use aura_companion_contract as contract;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashSet};
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub use contract::JobState;

pub fn companion_root() -> io::Result<PathBuf> {
    contract::companion_root()
}

pub fn jobs_dir() -> io::Result<PathBuf> {
    contract::jobs_dir()
}

pub fn settings_path(root: &Path) -> PathBuf {
    contract::settings_path(root)
}

pub fn default_downloads_dir() -> io::Result<PathBuf> {
    let home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "user profile unavailable"))?;
    Ok(PathBuf::from(home).join("Downloads").join("Aura Media"))
}

pub fn valid_download_folder(value: &str) -> Option<PathBuf> {
    contract::valid_download_folder(value)
}

pub fn read_download_folder_in(root: &Path) -> Option<PathBuf> {
    let document = contract::read_settings_document(root);
    document
        .get("downloadFolder")
        .and_then(Value::as_str)
        .and_then(valid_download_folder)
}

pub fn downloads_dir() -> io::Result<PathBuf> {
    if let Ok(root) = companion_root() {
        if let Some(folder) = read_download_folder_in(&root) {
            return Ok(folder);
        }
    }
    default_downloads_dir()
}

pub fn write_download_folder_in(root: &Path, folder: &Path) -> io::Result<PathBuf> {
    let path = valid_download_folder(&folder.to_string_lossy())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid download folder"))?;
    fs::create_dir_all(&path)?;
    contract::update_settings_document(root, |document| {
        document["downloadFolder"] = Value::String(path.to_string_lossy().into_owned());
        Ok(())
    })?;
    Ok(path)
}

pub fn read_jobs_in(directory: &Path) -> io::Result<Vec<JobState>> {
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    contract::list_job_states_in(directory)
}

pub fn read_jobs() -> io::Result<Vec<JobState>> {
    read_jobs_in(&jobs_dir()?)
}

pub fn request_cancel_in(directory: &Path, job_id: &str) -> io::Result<()> {
    let path = contract::cancel_path_in(directory, job_id)?;
    fs::create_dir_all(directory)?;
    fs::write(path, b"cancel")
}

pub fn request_cancel(job_id: &str) -> io::Result<()> {
    request_cancel_in(&jobs_dir()?, job_id)
}

pub fn request_pause_in(directory: &Path, job_id: &str) -> io::Result<()> {
    let path = contract::pause_path_in(directory, job_id)?;
    fs::create_dir_all(directory)?;
    fs::write(path, b"pause")
}

pub fn request_pause(job_id: &str) -> io::Result<()> {
    request_pause_in(&jobs_dir()?, job_id)
}

pub fn restartable_ids_in(directory: &Path, job_ids: &[String]) -> HashSet<String> {
    job_ids
        .iter()
        .filter(|job_id| {
            contract::request_path_in(directory, job_id)
                .map(|path| path.is_file())
                .unwrap_or(false)
        })
        .cloned()
        .collect()
}

/// Resume/retry is delegated to the installed native host. The host reads the
/// persisted request, clears markers, updates the state, and starts the runner.
pub fn restart_job(job_id: &str, action: &str) -> io::Result<()> {
    contract::safe_id(job_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid job id"))?;
    let request_type = match action {
        "resume" => "resume-job",
        "retry" => "retry-job",
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid job action",
            ))
        }
    };
    let request = json!({
        "type": request_type,
        "requestId": format!("manager-{request_type}-{}", now_millis()),
        "jobId": job_id,
    });
    let response = submit_host_command(&request)?;
    if response.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(())
    } else {
        Err(io::Error::other("job restart was rejected by Companion"))
    }
}

#[cfg(target_os = "windows")]
const HOST_EXECUTABLE: &str = "aura-media-companion.exe";

#[cfg(target_os = "windows")]
fn host_executable() -> io::Result<PathBuf> {
    let directory = env::current_exe()?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "install directory unavailable"))?;
    host_executable_in(&directory)
}

#[cfg(target_os = "windows")]
fn host_executable_in(directory: &Path) -> io::Result<PathBuf> {
    let installed = directory.join(HOST_EXECUTABLE);
    if installed.is_file() {
        return Ok(installed);
    }

    let profile = directory.file_name().unwrap_or_default().to_owned();
    // companion-tauri/src-tauri/target/{profile}/ -> ../../../../native-host/target/{profile}/
    let development = directory.ancestors().nth(4).map(|repository| {
        repository
            .join("native-host")
            .join("target")
            .join(&profile)
            .join(HOST_EXECUTABLE)
    });
    development
        .filter(|path| path.is_file())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Companion executable unavailable"))
}

fn submit_host_command(command: &Value) -> io::Result<Value> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut child = Command::new(host_executable()?)
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let payload = serde_json::to_vec(command).map_err(io::Error::other)?;
        let length = u32::try_from(payload.len())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "native request too large"))?;
        let mut frame = Vec::with_capacity(payload.len() + 4);
        frame.extend_from_slice(&length.to_le_bytes());
        frame.extend_from_slice(&payload);
        child
            .stdin
            .take()
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::BrokenPipe, "Companion stdin unavailable")
            })?
            .write_all(&frame)?;
        let mut output = Vec::new();
        child
            .stdout
            .take()
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::BrokenPipe, "Companion stdout unavailable")
            })?
            .read_to_end(&mut output)?;
        let status = child.wait()?;
        if !status.success() || output.len() < 4 || output.len() > 8 * 1024 * 1024 {
            return Err(io::Error::other(
                "Companion did not return a valid response",
            ));
        }
        let size =
            u32::from_le_bytes(output[..4].try_into().expect("four-byte frame prefix")) as usize;
        if output.len() != size + 4 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid native response",
            ));
        }
        return serde_json::from_slice(&output[4..]).map_err(io::Error::other);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = command;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Companion runner control is Windows only",
        ))
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct MediaFile {
    pub file_name: String,
    pub size: u64,
    pub modified_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFileRef {
    pub folder: Option<String>,
    pub file_name: String,
}

impl LibraryFileRef {
    pub fn new(folder: Option<String>, file_name: impl Into<String>) -> Self {
        Self {
            folder,
            file_name: file_name.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryOperationFailure {
    pub kind: io::ErrorKind,
    pub message: String,
}

impl LibraryOperationFailure {
    fn from_error(error: &io::Error) -> Self {
        Self {
            kind: error.kind(),
            message: error.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LibraryOperationOutcome {
    Succeeded { path: PathBuf },
    Failed(LibraryOperationFailure),
}

impl LibraryOperationOutcome {
    pub fn is_success(&self) -> bool {
        matches!(self, Self::Succeeded { .. })
    }

    pub fn failure(&self) -> Option<&LibraryOperationFailure> {
        match self {
            Self::Succeeded { .. } => None,
            Self::Failed(failure) => Some(failure),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchRecycleItemResult {
    pub item: LibraryFileRef,
    pub outcome: LibraryOperationOutcome,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BatchRecycleReport {
    pub items: Vec<BatchRecycleItemResult>,
}

impl BatchRecycleReport {
    pub fn succeeded_count(&self) -> usize {
        self.items
            .iter()
            .filter(|item| item.outcome.is_success())
            .count()
    }

    pub fn failed_count(&self) -> usize {
        self.items.len().saturating_sub(self.succeeded_count())
    }
}

const MEDIA_EXTENSIONS: [&str; 10] = [
    "mp4", "mkv", "webm", "m4v", "mov", "ts", "m2ts", "mp3", "m4a", "flac",
];
const SUBTITLE_FOLDER: &str = "Subtitles";

pub fn is_media_file_name(name: &str) -> bool {
    let Some((_, extension)) = name.rsplit_once('.') else {
        return false;
    };
    MEDIA_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
}

fn modified_millis(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

pub fn read_media_files_in(directory: &Path) -> io::Result<Vec<MediaFile>> {
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(directory)? {
        let Ok(entry) = entry else { continue };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if is_media_file_name(&name) {
            files.push(MediaFile {
                file_name: name,
                size: metadata.len(),
                modified_at: modified_millis(&metadata),
            });
        }
    }
    files.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));
    Ok(files)
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LibraryFolder {
    pub name: String,
    pub media_count: usize,
}

pub fn valid_folder_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 120 || trimmed != value {
        return None;
    }
    if trimmed.ends_with('.') || trimmed.ends_with(' ') {
        return None;
    }
    if trimmed
        .chars()
        .any(|character| character.is_control() || r#"\/:*?"<>|"#.contains(character))
    {
        return None;
    }
    if trimmed == "." || trimmed == ".." || trimmed.eq_ignore_ascii_case(SUBTITLE_FOLDER) {
        return None;
    }
    if is_windows_reserved_component(trimmed) {
        return None;
    }
    Some(trimmed.to_string())
}

fn is_windows_reserved_component(value: &str) -> bool {
    let base = value.split('.').next().unwrap_or_default();
    let upper = base.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || upper
            .strip_prefix("COM")
            .or_else(|| upper.strip_prefix("LPT"))
            .is_some_and(|number| {
                matches!(number, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
}

fn validate_library_root_syntax(root: &Path) -> io::Result<()> {
    let rendered = root.to_str().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "library root is not Unicode")
    })?;
    if valid_download_folder(rendered).as_deref() != Some(root) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid library root",
        ));
    }
    Ok(())
}

fn validated_library_root(root: &Path) -> io::Result<PathBuf> {
    validate_library_root_syntax(root)?;
    let metadata = fs::metadata(root)?;
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "library root is not a directory",
        ));
    }
    fs::canonicalize(root)
}

fn validated_library_dir_in(
    root: &Path,
    folder: Option<&str>,
    create: bool,
) -> io::Result<PathBuf> {
    let root = validated_library_root(root)?;
    let Some(folder) = folder else {
        return Ok(root);
    };
    let folder = valid_folder_name(folder)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid folder name"))?;
    let candidate = root.join(&folder);
    let mut created = false;
    if create {
        match fs::create_dir(&candidate) {
            Ok(()) => created = true,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    let link_metadata = fs::symlink_metadata(&candidate)?;
    if !link_metadata.is_dir() || link_metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "library folder is not a direct directory",
        ));
    }
    let canonical = fs::canonicalize(&candidate)?;
    if canonical.parent() != Some(root.as_path()) {
        if created {
            let _ = fs::remove_dir(&canonical);
        }
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "library folder escapes the library root",
        ));
    }
    Ok(canonical)
}

/// Resolves a directory for listing. A missing named collection is returned as
/// an absent path so a fresh library reads as empty; existing paths are still
/// checked for symlink escape.
pub fn library_dir_in(root: &Path, folder: Option<&str>) -> io::Result<PathBuf> {
    validate_library_root_syntax(root)?;
    let Some(folder) = folder else {
        return Ok(root.to_path_buf());
    };
    let folder = valid_folder_name(folder)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid folder name"))?;
    let candidate = root.join(&folder);
    if !candidate.exists() {
        return Ok(candidate);
    }
    validated_library_dir_in(root, Some(folder.as_str()), false)
}

pub fn library_dir(folder: Option<&str>) -> io::Result<PathBuf> {
    library_dir_in(&downloads_dir()?, folder)
}

pub fn read_library_folders_in(directory: &Path) -> io::Result<Vec<LibraryFolder>> {
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut folders = Vec::new();
    for entry in fs::read_dir(directory)? {
        let Ok(entry) = entry else { continue };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if valid_folder_name(&name).as_deref() != Some(name.as_str()) {
            continue;
        }
        let media_count = read_media_files_in(&entry.path())
            .map(|files| files.len())
            .unwrap_or(0);
        folders.push(LibraryFolder { name, media_count });
    }
    folders.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(folders)
}

pub fn read_media_files_in_folder(folder: Option<&str>) -> io::Result<Vec<MediaFile>> {
    read_media_files_in(&library_dir(folder)?)
}

fn valid_file_name_component(file_name: &str) -> io::Result<&str> {
    if file_name.is_empty()
        || file_name.encode_utf16().count() > 255
        || file_name.chars().any(char::is_control)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid file name",
        ));
    }
    let path = Path::new(file_name);
    let mut components = path.components();
    let Some(std::path::Component::Normal(name)) = components.next() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid file name",
        ));
    };
    if components.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid file name",
        ));
    }
    let name = name
        .to_str()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid file name"))?;
    if name != file_name
        || name.ends_with('.')
        || name.ends_with(' ')
        || name
            .chars()
            .any(|character| r#"\/:*?"<>|"#.contains(character))
        || is_windows_reserved_component(name)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid file name",
        ));
    }
    Ok(name)
}

fn library_target(file_name: &str) -> io::Result<PathBuf> {
    let name = valid_file_name_component(file_name)?;
    if !is_media_file_name(name) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid media file name",
        ));
    }
    Ok(PathBuf::from(name))
}

fn validated_media_path_in_dir(directory: &Path, name: &Path) -> io::Result<PathBuf> {
    let path = directory.join(name);
    let metadata = fs::symlink_metadata(&path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            io::Error::new(io::ErrorKind::NotFound, "library media file was not found")
        } else {
            error
        }
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "library target is not a regular media file",
        ));
    }
    Ok(path)
}

pub fn media_path_in(root: &Path, folder: Option<&str>, file_name: &str) -> io::Result<PathBuf> {
    let name = library_target(file_name)?;
    let directory = validated_library_dir_in(root, folder, false)?;
    validated_media_path_in_dir(&directory, &name)
}

pub fn media_path(folder: Option<&str>, file_name: &str) -> io::Result<PathBuf> {
    media_path_in(&downloads_dir()?, folder, file_name)
}

fn generated_gif_file_name(file_name: &str) -> bool {
    let Ok(name) = valid_file_name_component(file_name) else {
        return false;
    };
    let path = Path::new(name);
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
        return false;
    };
    extension.eq_ignore_ascii_case("gif")
        && !stem.is_empty()
        && stem
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn generated_gif_path_in(
    root: &Path,
    folder: Option<&str>,
    file_name: &str,
) -> io::Result<PathBuf> {
    if !generated_gif_file_name(file_name) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid generated GIF name",
        ));
    }
    let directory = validated_library_dir_in(root, folder, false)?;
    validated_media_path_in_dir(&directory, Path::new(file_name))
}

/// Resolve a library item that may be a normal media file or a generated GIF.
/// The GIF branch is deliberately narrower than the media-file allowlist: it
/// accepts only the ASCII stem shape produced by the GIF exporter.
pub fn reveal_path_in(root: &Path, folder: Option<&str>, file_name: &str) -> io::Result<PathBuf> {
    if generated_gif_file_name(file_name) {
        generated_gif_path_in(root, folder, file_name)
    } else {
        media_path_in(root, folder, file_name)
    }
}

fn split_job_output(value: &str) -> io::Result<LibraryFileRef> {
    let components = value.split(['/', '\\']).collect::<Vec<_>>();
    let (folder, file_name) = match components.as_slice() {
        [file_name] => (None, *file_name),
        [folder, file_name] => {
            let folder = valid_folder_name(folder).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "invalid job output folder")
            })?;
            (Some(folder), *file_name)
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "job output must be library-relative",
            ))
        }
    };
    let file_name = valid_file_name_component(file_name)?;
    if !is_media_file_name(file_name) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "job output is not media",
        ));
    }
    Ok(LibraryFileRef::new(folder, file_name))
}

/// Resolve a completed job's recorded output to a validated library-relative
/// folder/file pair. Job state historically stores only a file name, so a
/// plain name is searched across the root and direct library folders; an
/// ambiguous match is rejected instead of selecting an arbitrary file.
pub fn resolve_job_output_in(root: &Path, job: &JobState) -> io::Result<LibraryFileRef> {
    if !job.status.eq_ignore_ascii_case("completed") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "job output is not completed",
        ));
    }
    let recorded = job
        .file_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "job output is missing"))?;
    let reference = split_job_output(recorded)?;
    if reference.folder.is_some() {
        media_path_in(root, reference.folder.as_deref(), &reference.file_name)?;
        return Ok(reference);
    }

    let mut matches = Vec::new();
    match media_path_in(root, None, &reference.file_name) {
        Ok(_) => matches.push(reference.clone()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    for folder in read_library_folders_in(root)? {
        if media_path_in(root, Some(&folder.name), &reference.file_name).is_ok() {
            matches.push(LibraryFileRef::new(
                Some(folder.name),
                reference.file_name.clone(),
            ));
        }
    }
    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 => Err(io::Error::new(
            io::ErrorKind::NotFound,
            "job output was not found in the library",
        )),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "job output matches multiple library files",
        )),
    }
}

pub fn media_file_in(
    root: &Path,
    folder: Option<&str>,
    file_name: &str,
) -> io::Result<(PathBuf, MediaFile)> {
    let path = media_path_in(root, folder, file_name)?;
    let metadata = fs::metadata(&path)?;
    Ok((
        path,
        MediaFile {
            file_name: file_name.to_string(),
            size: metadata.len(),
            modified_at: modified_millis(&metadata),
        },
    ))
}

pub fn move_library_file_in(
    root: &Path,
    from: Option<&str>,
    source_file_name: &str,
    to: Option<&str>,
    destination_file_name: &str,
) -> io::Result<PathBuf> {
    let source_name = library_target(source_file_name)?;
    let destination_name = library_target(destination_file_name)?;
    let source_extension = source_name.extension().and_then(|value| value.to_str());
    let destination_extension = destination_name
        .extension()
        .and_then(|value| value.to_str());
    if source_extension
        .zip(destination_extension)
        .is_none_or(|(source, destination)| !source.eq_ignore_ascii_case(destination))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a library move cannot change the media extension",
        ));
    }
    let source_dir = validated_library_dir_in(root, from, false)?;
    let source = validated_media_path_in_dir(&source_dir, &source_name)?;
    let destination_dir = validated_library_dir_in(root, to, false)?;
    let destination = destination_dir.join(destination_name);
    if destination == source {
        return Ok(destination);
    }
    match fs::symlink_metadata(&destination) {
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "destination already exists",
            ))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    #[cfg(target_os = "windows")]
    fs::rename(&source, &destination)?;
    #[cfg(not(target_os = "windows"))]
    {
        fs::hard_link(&source, &destination)?;
        if let Err(error) = fs::remove_file(&source) {
            let _ = fs::remove_file(&destination);
            return Err(error);
        }
    }
    Ok(destination)
}

pub fn move_media_file(
    file_name: &str,
    from: Option<&str>,
    to: Option<&str>,
) -> io::Result<PathBuf> {
    move_library_file_in(&downloads_dir()?, from, file_name, to, file_name)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryMediaRecord {
    pub folder: Option<String>,
    pub media: MediaFile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LibraryOrganizationRule {
    VideoExtension,
    AudioExtension,
}

impl LibraryOrganizationRule {
    pub fn destination_folder(self) -> &'static str {
        match self {
            Self::VideoExtension => "Videos",
            Self::AudioExtension => "Audio",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryOrganizationPlanItem {
    pub source: LibraryFileRef,
    pub destination: LibraryFileRef,
    pub media: MediaFile,
    pub rule: LibraryOrganizationRule,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryOrganizationPlan {
    root: PathBuf,
    items: Vec<LibraryOrganizationPlanItem>,
}

impl LibraryOrganizationPlan {
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn items(&self) -> &[LibraryOrganizationPlanItem] {
        &self.items
    }
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryMoveJournalEntry {
    pub from: LibraryFileRef,
    pub to: LibraryFileRef,
    pub media: MediaFile,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryMoveJournal {
    root: PathBuf,
    entries: Vec<LibraryMoveJournalEntry>,
}

impl LibraryMoveJournal {
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn entries(&self) -> &[LibraryMoveJournalEntry] {
        &self.entries
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryOrganizationApplyItemResult {
    pub item: LibraryOrganizationPlanItem,
    pub outcome: LibraryOperationOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryOrganizationApplyReport {
    pub items: Vec<LibraryOrganizationApplyItemResult>,
    pub journal: LibraryMoveJournal,
}

impl LibraryOrganizationApplyReport {
    pub fn succeeded_count(&self) -> usize {
        self.items
            .iter()
            .filter(|item| item.outcome.is_success())
            .count()
    }
    pub fn failed_count(&self) -> usize {
        self.items.len().saturating_sub(self.succeeded_count())
    }
}

fn library_record_order(
    left: &LibraryMediaRecord,
    right: &LibraryMediaRecord,
) -> std::cmp::Ordering {
    let left_folder = left.folder.as_deref().unwrap_or_default();
    let right_folder = right.folder.as_deref().unwrap_or_default();
    left_folder
        .to_lowercase()
        .cmp(&right_folder.to_lowercase())
        .then_with(|| left_folder.cmp(right_folder))
        .then_with(|| {
            left.media
                .file_name
                .to_lowercase()
                .cmp(&right.media.file_name.to_lowercase())
        })
        .then_with(|| left.media.file_name.cmp(&right.media.file_name))
}

pub fn read_library_media_records_in(root: &Path) -> io::Result<Vec<LibraryMediaRecord>> {
    validate_library_root_syntax(root)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let root = validated_library_root(root)?;
    let mut records = read_media_files_in(&root)?
        .into_iter()
        .map(|media| LibraryMediaRecord {
            folder: None,
            media,
        })
        .collect::<Vec<_>>();
    for folder in read_library_folders_in(&root)? {
        let directory = validated_library_dir_in(&root, Some(&folder.name), false)?;
        records.extend(read_media_files_in(&directory)?.into_iter().map(|media| {
            LibraryMediaRecord {
                folder: Some(folder.name.clone()),
                media,
            }
        }));
    }
    records.sort_by(library_record_order);
    Ok(records)
}

fn organization_rule(file_name: &str) -> Option<LibraryOrganizationRule> {
    match Path::new(file_name)
        .extension()?
        .to_str()?
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" | "mkv" | "webm" | "m4v" | "mov" | "ts" | "m2ts" => {
            Some(LibraryOrganizationRule::VideoExtension)
        }
        "mp3" | "m4a" | "flac" => Some(LibraryOrganizationRule::AudioExtension),
        _ => None,
    }
}

fn current_media_file(path: &Path, file_name: &str) -> io::Result<MediaFile> {
    let metadata = fs::metadata(path)?;
    Ok(MediaFile {
        file_name: file_name.to_string(),
        size: metadata.len(),
        modified_at: modified_millis(&metadata),
    })
}

fn require_matching_media_record(path: &Path, expected: &MediaFile) -> io::Result<()> {
    if current_media_file(path, &expected.file_name)? != *expected {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "media file changed after organization preview",
        ));
    }
    Ok(())
}

fn occupied_names_in(root: &Path, folder: &str) -> io::Result<BTreeSet<String>> {
    let root = validated_library_root(root)?;
    let path = root.join(folder);
    if !path.exists() {
        return Ok(BTreeSet::new());
    }
    let directory = validated_library_dir_in(&root, Some(folder), false)?;
    let mut names = BTreeSet::new();
    for entry in fs::read_dir(directory)? {
        let Ok(entry) = entry else { continue };
        if let Some(name) = entry.file_name().to_str() {
            names.insert(name.to_lowercase());
        }
    }
    Ok(names)
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

fn collision_name(original: &str, occupied: &mut BTreeSet<String>) -> io::Result<String> {
    if occupied.insert(original.to_lowercase()) {
        return Ok(original.to_string());
    }
    let (stem, extension) = original.rsplit_once('.').ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "media file has no extension")
    })?;
    let mut index = 2_u32;
    loop {
        let suffix = format!(" ({index})");
        let fixed_units = suffix.encode_utf16().count() + 1 + extension.encode_utf16().count();
        let stem = truncate_utf16(stem, 255_usize.saturating_sub(fixed_units));
        if stem.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "media file name cannot be collision-renamed",
            ));
        }
        let candidate = format!("{stem}{suffix}.{extension}");
        if library_target(&candidate).is_ok() && occupied.insert(candidate.to_lowercase()) {
            return Ok(candidate);
        }
        index = index.checked_add(1).ok_or_else(|| {
            io::Error::new(io::ErrorKind::AlreadyExists, "no collision-free file name")
        })?;
    }
}

pub fn plan_library_organization_in(
    root: &Path,
    records: &[LibraryMediaRecord],
) -> io::Result<LibraryOrganizationPlan> {
    let root = validated_library_root(root)?;
    let mut records = records.to_vec();
    records.sort_by(library_record_order);
    let mut seen = HashSet::new();
    let mut video_names = occupied_names_in(&root, "Videos")?;
    let mut audio_names = occupied_names_in(&root, "Audio")?;
    let mut items = Vec::new();
    for record in records {
        let source = LibraryFileRef::new(record.folder.clone(), record.media.file_name.clone());
        let source_path = media_path_in(&root, source.folder.as_deref(), &source.file_name)?;
        require_matching_media_record(&source_path, &record.media)?;
        let source_key = format!(
            "{}\0{}",
            source.folder.as_deref().unwrap_or_default().to_lowercase(),
            source.file_name.to_lowercase()
        );
        if !seen.insert(source_key) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "duplicate media record",
            ));
        }
        if source.folder.is_some() {
            continue;
        }
        let rule = organization_rule(&source.file_name).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "unsupported media record")
        })?;
        let occupied = match rule {
            LibraryOrganizationRule::VideoExtension => &mut video_names,
            LibraryOrganizationRule::AudioExtension => &mut audio_names,
        };
        let destination_file_name = collision_name(&source.file_name, occupied)?;
        items.push(LibraryOrganizationPlanItem {
            source,
            destination: LibraryFileRef::new(
                Some(rule.destination_folder().to_string()),
                destination_file_name,
            ),
            media: record.media,
            rule,
        });
    }
    Ok(LibraryOrganizationPlan { root, items })
}

pub fn preview_library_organization_in(root: &Path) -> io::Result<LibraryOrganizationPlan> {
    let records = read_library_media_records_in(root)?;
    if records.is_empty() && !root.exists() {
        return Ok(LibraryOrganizationPlan {
            root: root.to_path_buf(),
            items: Vec::new(),
        });
    }
    plan_library_organization_in(root, &records)
}

fn apply_organization_item(root: &Path, item: &LibraryOrganizationPlanItem) -> io::Result<PathBuf> {
    if item.source.folder.is_some()
        || item.source.file_name != item.media.file_name
        || organization_rule(&item.source.file_name) != Some(item.rule)
        || item.destination.folder.as_deref() != Some(item.rule.destination_folder())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "organization plan item does not match its rule",
        ));
    }
    let source = media_path_in(root, item.source.folder.as_deref(), &item.source.file_name)?;
    require_matching_media_record(&source, &item.media)?;
    validated_library_dir_in(root, item.destination.folder.as_deref(), true)?;
    move_library_file_in(
        root,
        None,
        &item.source.file_name,
        item.destination.folder.as_deref(),
        &item.destination.file_name,
    )
}

pub fn apply_library_organization(
    plan: &LibraryOrganizationPlan,
) -> LibraryOrganizationApplyReport {
    let mut results = Vec::with_capacity(plan.items.len());
    let mut entries = Vec::new();
    for item in &plan.items {
        let outcome = match apply_organization_item(&plan.root, item) {
            Ok(path) => {
                entries.push(LibraryMoveJournalEntry {
                    from: item.source.clone(),
                    to: item.destination.clone(),
                    media: item.media.clone(),
                });
                LibraryOperationOutcome::Succeeded { path }
            }
            Err(error) => {
                LibraryOperationOutcome::Failed(LibraryOperationFailure::from_error(&error))
            }
        };
        results.push(LibraryOrganizationApplyItemResult {
            item: item.clone(),
            outcome,
        });
    }
    LibraryOrganizationApplyReport {
        items: results,
        journal: LibraryMoveJournal {
            root: plan.root.clone(),
            entries,
        },
    }
}

#[cfg(target_os = "windows")]
fn recycle_validated_media_path(path: &Path) -> io::Result<PathBuf> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{BOOL, PCWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
        SHFILEOPSTRUCTW,
    };
    let rendered = path.as_os_str().to_string_lossy();
    let shell_path = if let Some(unc) = rendered.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{unc}"))
    } else if let Some(ordinary) = rendered.strip_prefix(r"\\?\") {
        PathBuf::from(ordinary)
    } else {
        path.to_path_buf()
    };
    let mut wide: Vec<u16> = shell_path.as_os_str().encode_wide().collect();
    wide.extend([0, 0]);
    let mut operation = SHFILEOPSTRUCTW {
        hwnd: HWND(std::ptr::null_mut()),
        wFunc: FO_DELETE,
        pFrom: PCWSTR(wide.as_ptr()),
        pTo: PCWSTR::null(),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI).0 as u16,
        fAnyOperationsAborted: BOOL(0),
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: PCWSTR::null(),
    };
    let result = unsafe { SHFileOperationW(&mut operation) };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result));
    }
    if operation.fAnyOperationsAborted != BOOL(0) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Recycle Bin operation was cancelled",
        ));
    }
    Ok(path.to_path_buf())
}

#[cfg(not(target_os = "windows"))]
fn recycle_validated_media_path(_path: &Path) -> io::Result<PathBuf> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Recycle Bin operations are Windows only",
    ))
}

pub fn delete_media_file_in(
    root: &Path,
    folder: Option<&str>,
    file_name: &str,
) -> io::Result<PathBuf> {
    let path = media_path_in(root, folder, file_name)?;
    recycle_validated_media_path(&path)
}

fn batch_recycle_media_files_with<F>(
    root: &Path,
    items: &[LibraryFileRef],
    mut recycle: F,
) -> BatchRecycleReport
where
    F: FnMut(&Path) -> io::Result<PathBuf>,
{
    let mut results = Vec::with_capacity(items.len());
    let mut seen = HashSet::new();
    for item in items {
        let outcome = match (|| {
            let path = media_path_in(root, item.folder.as_deref(), &item.file_name)?;
            let key = path.to_string_lossy().to_lowercase();
            if !seen.insert(key) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "duplicate batch recycle target",
                ));
            }
            recycle(&path)
        })() {
            Ok(path) => LibraryOperationOutcome::Succeeded { path },
            Err(error) => {
                LibraryOperationOutcome::Failed(LibraryOperationFailure::from_error(&error))
            }
        };
        results.push(BatchRecycleItemResult {
            item: item.clone(),
            outcome,
        });
    }
    BatchRecycleReport { items: results }
}

pub fn batch_recycle_media_files_in(root: &Path, items: &[LibraryFileRef]) -> BatchRecycleReport {
    batch_recycle_media_files_with(root, items, recycle_validated_media_path)
}

#[cfg(target_os = "windows")]
pub fn open_library_folder(folder: Option<&str>) -> io::Result<PathBuf> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let folder = library_dir(folder)?;
    fs::create_dir_all(&folder)?;
    Command::new("explorer.exe")
        .arg(&folder)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(folder)
}

#[cfg(not(target_os = "windows"))]
pub fn open_library_folder(_folder: Option<&str>) -> io::Result<PathBuf> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "opening folders is Windows only",
    ))
}

#[cfg(target_os = "windows")]
pub fn reveal_file(folder: Option<&str>, file_name: &str) -> io::Result<PathBuf> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let path = reveal_path_in(&downloads_dir()?, folder, file_name)?;
    Command::new("explorer.exe")
        .arg(format!("/select,{}", path.display()))
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(path)
}

#[cfg(not(target_os = "windows"))]
pub fn reveal_file(_folder: Option<&str>, _file_name: &str) -> io::Result<PathBuf> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "revealing files is Windows only",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = env::temp_dir().join(format!("segma-tauri-jobs-{label}-{nonce}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn marker_writes_use_the_shared_names_and_reject_traversal() {
        let root = temp_root("markers");
        request_cancel_in(&root, "job-1").unwrap();
        request_pause_in(&root, "job-1").unwrap();
        assert_eq!(fs::read(root.join("job-1.cancel")).unwrap(), b"cancel");
        assert_eq!(fs::read(root.join("job-1.pause")).unwrap(), b"pause");
        assert!(request_cancel_in(&root, "../escape").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn library_boundaries_reject_paths_and_non_media_targets() {
        let root = temp_root("boundaries");
        fs::write(root.join("inside.mp4"), b"media").unwrap();
        fs::create_dir(root.join("Collection")).unwrap();
        fs::write(root.join("Collection").join("nested.mkv"), b"nested").unwrap();
        assert!(media_path_in(&root, None, "inside.mp4").is_ok());
        assert!(media_path_in(&root, Some("Collection"), "nested.mkv").is_ok());
        for (folder, file) in [
            (None, "../inside.mp4"),
            (None, "notes.txt"),
            (Some("../"), "inside.mp4"),
            (Some("Collection/.."), "inside.mp4"),
        ] {
            assert!(media_path_in(&root, folder, file).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn completed_job_output_resolves_to_a_validated_library_reference() {
        let root = temp_root("job-output");
        fs::write(root.join("clip.mp4"), b"media").unwrap();
        let mut job = JobState {
            job_id: "job-1".into(),
            status: "completed".into(),
            file_name: Some("clip.mp4".into()),
            ..JobState::default()
        };
        assert_eq!(
            resolve_job_output_in(&root, &job).unwrap(),
            LibraryFileRef::new(None, "clip.mp4")
        );

        for file_name in ["../clip.mp4", "missing.mp4", r"C:\outside.mp4"] {
            job.file_name = Some(file_name.into());
            assert!(resolve_job_output_in(&root, &job).is_err(), "{file_name}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reveal_accepts_only_the_generated_gif_name_shape() {
        let root = temp_root("gif-reveal");
        fs::write(root.join("clip.gif"), b"gif").unwrap();
        assert!(reveal_path_in(&root, None, "clip.gif").is_ok());
        for file_name in ["notes.txt", "clip!.gif", "clip space.gif", "../clip.gif"] {
            assert!(
                reveal_path_in(&root, None, file_name).is_err(),
                "{file_name}"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn completed_job_output_rejects_symlink_targets() {
        use std::os::unix::fs::symlink;

        let root = temp_root("job-output-symlink");
        let outside = temp_root("job-output-outside");
        fs::write(outside.join("clip.mp4"), b"outside").unwrap();
        symlink(outside.join("clip.mp4"), root.join("clip.mp4")).unwrap();
        let job = JobState {
            job_id: "job-1".into(),
            status: "completed".into(),
            file_name: Some("clip.mp4".into()),
            ..JobState::default()
        };
        assert!(resolve_job_output_in(&root, &job).is_err());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn development_host_resolution_uses_the_tauri_repository_layout() {
        let root = temp_root("host-resolution");
        let directory = root
            .join("companion-tauri")
            .join("src-tauri")
            .join("target")
            .join("release");
        fs::create_dir_all(&directory).unwrap();
        let expected = root
            .join("native-host")
            .join("target")
            .join("release")
            .join(HOST_EXECUTABLE);
        fs::create_dir_all(expected.parent().unwrap()).unwrap();
        fs::write(&expected, b"development host").unwrap();
        assert_eq!(host_executable_in(&directory).unwrap(), expected);

        let sibling = directory.join(HOST_EXECUTABLE);
        fs::write(&sibling, b"installed host").unwrap();
        assert_eq!(host_executable_in(&directory).unwrap(), sibling);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn organization_preview_is_write_free_and_apply_moves_without_replacement() {
        let root = temp_root("organize");
        fs::write(root.join("clip.mp4"), b"video").unwrap();
        fs::write(root.join("song.mp3"), b"audio").unwrap();
        let plan = preview_library_organization_in(&root).unwrap();
        assert!(!root.join("Videos").exists());
        let report = apply_library_organization(&plan);
        assert_eq!(report.succeeded_count(), 2);
        assert!(root.join("Videos").join("clip.mp4").is_file());
        assert!(root.join("Audio").join("song.mp3").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn batch_recycle_validates_each_target_and_deduplicates() {
        let root = temp_root("batch");
        fs::write(root.join("a.mp4"), b"a").unwrap();
        let items = vec![
            LibraryFileRef::new(None, "a.mp4"),
            LibraryFileRef::new(None, "../outside.mp4"),
            LibraryFileRef::new(None, "a.mp4"),
        ];
        let mut called = 0;
        let report = batch_recycle_media_files_with(&root, &items, |path| {
            called += 1;
            Ok(path.to_path_buf())
        });
        assert_eq!(called, 1);
        assert_eq!(report.succeeded_count(), 1);
        assert_eq!(report.failed_count(), 2);
        fs::remove_dir_all(root).unwrap();
    }
}
