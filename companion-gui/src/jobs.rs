//! Reads companion job state and issues the two actions the protocol supports.
//!
//! The manager runs as a separate process from the native messaging host, but
//! both share `%LOCALAPPDATA%\Aura Media\Companion\jobs`. State files are the
//! interface, so nothing here talks to the host process.
//!
//! Field names mirror the host's `JobState` serde renames. Unknown fields are
//! ignored on purpose: a newer host must not break an older manager window.

use aura_companion_contract as contract;
pub use aura_companion_contract::JobState;
use std::collections::{BTreeSet, HashSet};
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::shortcuts::PlayerShortcuts;

pub fn companion_root() -> io::Result<PathBuf> {
    contract::companion_root()
}

pub fn jobs_dir() -> io::Result<PathBuf> {
    contract::jobs_dir()
}

pub fn settings_path(root: &Path) -> PathBuf {
    contract::settings_path(root)
}

/// Largest settings file the manager will parse, matching the host's own cap.
const MAX_SETTINGS_BYTES: usize = 16 * 1024;

pub fn default_downloads_dir() -> io::Result<PathBuf> {
    let home = env::var_os("USERPROFILE")
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no user profile"))?;
    Ok(PathBuf::from(home).join("Downloads").join("Aura Media"))
}

/// Same rule the host applies: absolute, no traversal, no control characters.
/// Both sides validate independently so neither trusts the other's writes.
pub fn valid_download_folder(value: &str) -> Option<PathBuf> {
    contract::valid_download_folder(value)
}

pub fn read_download_folder_in(root: &Path) -> Option<PathBuf> {
    let bytes = fs::read(settings_path(root)).ok()?;
    if bytes.len() > MAX_SETTINGS_BYTES {
        return None;
    }
    let document: Value = serde_json::from_slice(&bytes).ok()?;
    document
        .get("downloadFolder")
        .and_then(Value::as_str)
        .and_then(valid_download_folder)
}

/// The folder every writer uses. Reads `settings.json`, which the host reads
/// too, so the extension and this window can never point at different places.
pub fn downloads_dir() -> io::Result<PathBuf> {
    if let Ok(root) = companion_root() {
        if let Some(folder) = read_download_folder_in(&root) {
            return Ok(folder);
        }
    }
    default_downloads_dir()
}

/// Bytes used by playable media in `directory`, including user collection folders.
/// The subtitle sidecar folder is skipped because it is not a library collection.
pub fn media_bytes_in(directory: &Path) -> io::Result<u64> {
    if !directory.is_dir() {
        return Ok(0);
    }
    let mut total = 0_u64;
    for file in read_media_files_in(directory)? {
        total = total.saturating_add(file.size);
    }
    for folder in read_library_folders_in(directory)? {
        let nested = directory.join(&folder.name);
        for file in read_media_files_in(&nested)? {
            total = total.saturating_add(file.size);
        }
    }
    Ok(total)
}

pub fn download_folder_media_bytes() -> io::Result<u64> {
    media_bytes_in(&downloads_dir()?)
}

/// Read-modify-write so the license key and any other setting survive.
pub fn write_download_folder_in(root: &Path, folder: &Path) -> io::Result<PathBuf> {
    let path = valid_download_folder(&folder.to_string_lossy())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid download folder"))?;
    fs::create_dir_all(&path)?;

    let file = settings_path(root);
    let mut document = match fs::read(&file) {
        Ok(bytes) if bytes.len() <= MAX_SETTINGS_BYTES => {
            serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_| json!({}))
        }
        _ => json!({}),
    };
    if !document.is_object() {
        document = json!({});
    }
    document["downloadFolder"] = Value::String(path.to_string_lossy().into_owned());

    fs::create_dir_all(root)?;
    let temporary = file.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&document).map_err(io::Error::other)?,
    )?;
    fs::rename(&temporary, &file)?;
    Ok(path)
}

pub fn read_player_shortcuts_in(root: &Path) -> PlayerShortcuts {
    let Ok(bytes) = fs::read(settings_path(root)) else {
        return PlayerShortcuts::default();
    };
    if bytes.len() > MAX_SETTINGS_BYTES {
        return PlayerShortcuts::default();
    }
    serde_json::from_slice::<Value>(&bytes)
        .map(|document| PlayerShortcuts::from_settings_document(&document))
        .unwrap_or_default()
}

pub fn read_player_shortcuts() -> PlayerShortcuts {
    companion_root()
        .ok()
        .map(|root| read_player_shortcuts_in(&root))
        .unwrap_or_default()
}

/// Preserve host-owned settings while atomically updating player shortcuts.
pub fn write_player_shortcuts_in(root: &Path, shortcuts: PlayerShortcuts) -> io::Result<()> {
    let file = settings_path(root);
    let mut document = match fs::read(&file) {
        Ok(bytes) if bytes.len() <= MAX_SETTINGS_BYTES => {
            serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_| json!({}))
        }
        _ => json!({}),
    };
    shortcuts.write_to_settings_document(&mut document);
    fs::create_dir_all(root)?;
    let temporary = file.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&document).map_err(io::Error::other)?,
    )?;
    fs::rename(temporary, file)
}

pub fn write_player_shortcuts(shortcuts: PlayerShortcuts) -> io::Result<()> {
    write_player_shortcuts_in(&companion_root()?, shortcuts)
}

pub fn write_download_folder(folder: &Path) -> io::Result<PathBuf> {
    write_download_folder_in(&companion_root()?, folder)
}

pub fn cancel_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    contract::cancel_path_in(directory, job_id)
}

pub fn pause_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    contract::pause_path_in(directory, job_id)
}

pub fn request_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    contract::request_path_in(directory, job_id)
}

pub fn read_jobs_in(directory: &Path) -> io::Result<Vec<JobState>> {
    contract::list_job_states_in(directory)
}

/// Missing folder means the companion has simply never run a job, which is an
/// empty list rather than an error the window should surface.
pub fn read_jobs() -> io::Result<Vec<JobState>> {
    let directory = jobs_dir()?;
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    read_jobs_in(&directory)
}

/// Writes the marker the host's download loop polls for. Only meaningful while
/// a job is running: the runner deletes the marker when its loop ends, so a
/// marker for a finished job would linger with nothing to clean it up.
pub fn request_cancel_in(directory: &Path, job_id: &str) -> io::Result<()> {
    let path = cancel_path_in(directory, job_id)?;
    fs::create_dir_all(directory)?;
    fs::write(path, b"cancel")?;

    // The marker is the stop contract. Update the shared state only after it
    // exists, so the manager never reports cancellation before the writer has
    // a stop signal waiting for it.
    let state_path = state_path_in(directory, job_id)?;
    if state_path.is_file() {
        let bytes = fs::read(&state_path)?;
        let mut document: Value = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
        if !document.is_object() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "job state is not an object",
            ));
        }
        document["statusText"] = Value::String("취소 처리 중…".into());
        document["updatedAt"] = Value::from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        );
        document
            .as_object_mut()
            .expect("checked above")
            .remove("error");
        let temporary = state_path.with_extension("json.tmp");
        fs::write(
            &temporary,
            serde_json::to_vec(&document).map_err(io::Error::other)?,
        )?;
        fs::rename(temporary, state_path)?;
    }
    Ok(())
}

pub fn request_cancel(job_id: &str) -> io::Result<()> {
    request_cancel_in(&jobs_dir()?, job_id)
}

pub fn clear_terminal_history_in(directory: &Path) -> io::Result<usize> {
    if !directory.is_dir() {
        return Ok(0);
    }
    let terminal = read_jobs_in(directory)?
        .into_iter()
        .filter(|job| {
            matches!(
                job.status.to_ascii_lowercase().as_str(),
                "completed" | "failed" | "cancelled"
            )
        })
        .map(|job| job.job_id)
        .collect::<Vec<_>>();

    for job_id in &terminal {
        for path in [
            state_path_in(directory, job_id)?,
            request_path_in(directory, job_id)?,
            cancel_path_in(directory, job_id)?,
            pause_path_in(directory, job_id)?,
        ] {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
    }
    Ok(terminal.len())
}

pub fn clear_terminal_history() -> io::Result<usize> {
    clear_terminal_history_in(&jobs_dir()?)
}

/// Pause stops the runner but leaves yt-dlp's `.part` file, so a later resume
/// continues from the same byte. The host leaves this marker on disk while the
/// job is paused; `resume` removes it.
pub fn request_pause_in(directory: &Path, job_id: &str) -> io::Result<()> {
    let path = pause_path_in(directory, job_id)?;
    fs::create_dir_all(directory)?;
    fs::write(path, b"pause")?;
    set_job_status_text_in(directory, job_id, "일시정지를 처리하는 중…")
}

pub fn request_pause(job_id: &str) -> io::Result<()> {
    request_pause_in(&jobs_dir()?, job_id)
}

pub fn set_job_status_text_in(directory: &Path, job_id: &str, message: &str) -> io::Result<()> {
    let path = state_path_in(directory, job_id)?;
    if !path.is_file() {
        return Ok(());
    }
    let bytes = fs::read(&path)?;
    let mut document: Value = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    if !document.is_object() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "job state is not an object",
        ));
    }
    document["statusText"] = Value::String(message.to_string());
    document["updatedAt"] = Value::from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    );
    let temporary = path.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec(&document).map_err(io::Error::other)?,
    )?;
    fs::rename(temporary, path)
}

pub fn set_job_status_text(job_id: &str, message: &str) -> io::Result<()> {
    set_job_status_text_in(&jobs_dir()?, job_id, message)
}

/// Prepares a stopped job to run again, which is what both resume and retry do.
///
/// Markers are cleared first: a leftover marker would make the fresh runner stop
/// again on its first loop iteration. Returns the request path so the caller can
/// hand it to the runner.
pub fn prepare_restart_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    let request = request_path_in(directory, job_id)?;
    if !request.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "이 작업의 원본 요청 기록이 없어 다시 시작할 수 없습니다.",
        ));
    }
    let _ = fs::remove_file(pause_path_in(directory, job_id)?);
    let _ = fs::remove_file(cancel_path_in(directory, job_id)?);
    Ok(request)
}

/// Name of the native host binary, which owns the download runner.
#[cfg(target_os = "windows")]
const HOST_EXECUTABLE: &str = "aura-media-companion.exe";

/// Resolves the host binary beside this executable, which is how the installer
/// lays both out. During development the two crates build into separate target
/// directories, so the sibling release build is checked as a fallback.
#[cfg(target_os = "windows")]
fn host_executable() -> io::Result<PathBuf> {
    let directory = env::current_exe()?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no install directory"))?;

    let installed = directory.join(HOST_EXECUTABLE);
    if installed.is_file() {
        return Ok(installed);
    }

    // companion-gui/target/{profile}/ -> ../../../native-host/target/{profile}/
    let profile = directory.file_name().unwrap_or_default().to_owned();
    let development = directory
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(|repository| {
            repository
                .join("native-host")
                .join("target")
                .join(&profile)
                .join(HOST_EXECUTABLE)
        });
    if let Some(path) = development.filter(|path| path.is_file()) {
        return Ok(path);
    }

    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "Segma Player 실행 파일을 찾지 못했습니다.",
    ))
}

/// Runs the host's own job runner in a detached process.
///
/// This is the same entry point the host uses when the extension submits a
/// download, so resume and retry go through one code path rather than a second
/// implementation of the transfer.
#[cfg(target_os = "windows")]
pub fn spawn_job_runner(request_path: &Path) -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    Command::new(host_executable()?)
        .arg("--run-job")
        .arg(request_path)
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn spawn_job_runner(_request_path: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "restarting a job is Windows only",
    ))
}

/// Marks a job queued so the row updates before the runner reports in.
pub fn mark_queued_in(directory: &Path, job_id: &str, status_text: &str) -> io::Result<()> {
    let path = state_path_in(directory, job_id)?;
    let bytes = fs::read(&path)?;
    let mut document: Value = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    if !document.is_object() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "job state is not an object",
        ));
    }
    document["status"] = Value::String("queued".into());
    document["statusText"] = Value::String(status_text.to_string());
    document
        .as_object_mut()
        .expect("checked above")
        .remove("error");

    let temporary = path.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec(&document).map_err(io::Error::other)?,
    )?;
    fs::rename(&temporary, &path)?;
    Ok(())
}

pub fn state_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    contract::state_path_in(directory, job_id)
}

/// Job ids whose `.request.json` still exists, so a restart has something to
/// replay. The host removes stale request files, so this is checked per poll
/// rather than assumed from the job's age.
pub fn restartable_ids_in(directory: &Path, job_ids: &[String]) -> HashSet<String> {
    job_ids
        .iter()
        .filter(|job_id| {
            request_path_in(directory, job_id)
                .map(|path| path.is_file())
                .unwrap_or(false)
        })
        .cloned()
        .collect()
}

pub fn restartable_ids(job_ids: &[String]) -> HashSet<String> {
    match jobs_dir() {
        Ok(directory) => restartable_ids_in(&directory, job_ids),
        Err(_) => HashSet::new(),
    }
}

/// A media file that actually exists in the download folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaFile {
    pub file_name: String,
    pub size: u64,
    /// Milliseconds since the epoch, matching `JobState::updated_at` so the two
    /// sources can be sorted together.
    pub modified_at: u64,
}

/// One media item addressed relative to the configured library root.
///
/// Keeping the folder and file name as separate validated components prevents
/// callers from smuggling an absolute path or traversal into a batch action.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
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

/// Copyable details suitable for presenting one failed item without losing the
/// successful results from the rest of a batch.
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

/// Extensions the library treats as playable media. Subtitle sidecars and
/// partial transfers are deliberately excluded: a `.part` file is not a result,
/// and a `.vtt` belongs to the Subtitles view.
const MEDIA_EXTENSIONS: [&str; 10] = [
    "mp4", "mkv", "webm", "m4v", "mov", "ts", "m2ts", "mp3", "m4a", "flac",
];

pub fn is_media_file_name(name: &str) -> bool {
    let Some((_, extension)) = name.rsplit_once('.') else {
        return false;
    };
    let lowered = extension.to_ascii_lowercase();
    MEDIA_EXTENSIONS.contains(&lowered.as_str())
}

fn modified_millis(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Lists media files in a folder, newest first.
///
/// Not recursive: the host writes into the folder root, and the `Subtitles`
/// subfolder is a different surface. A missing folder is an empty list rather
/// than an error, because it simply means nothing has been saved yet.
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
        if !is_media_file_name(&name) {
            continue;
        }
        files.push(MediaFile {
            file_name: name,
            size: metadata.len(),
            modified_at: modified_millis(&metadata),
        });
    }
    files.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));
    Ok(files)
}

/// Name of the subtitle sidecar folder, which the library treats as engine
/// storage rather than a user-visible collection.
const SUBTITLE_FOLDER: &str = "Subtitles";

/// A user-created folder directly inside the download folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryFolder {
    pub name: String,
    pub media_count: usize,
}

/// Folder names are single path segments with no traversal, no separators, and
/// no reserved characters, so a name can never escape the download folder.
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

/// Returns the canonical root only after proving it is the configured kind of
/// absolute, traversal-free directory.
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

/// Resolves either the root or one direct, non-link collection directory.
/// Existing junctions and symlinks are rejected if their canonical target is
/// not a direct child of the canonical library root.
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
    let candidate = root.join(folder);
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

/// Resolves the folder a view is showing. `None` is the download folder root.
pub fn library_dir(folder: Option<&str>) -> io::Result<PathBuf> {
    let root = downloads_dir()?;
    match folder {
        None => Ok(root),
        Some(name) => {
            let name = valid_folder_name(name).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "invalid folder name")
            })?;
            Ok(root.join(name))
        }
    }
}

/// Lists user folders with how many playable files each holds. Non-recursive,
/// and the subtitle sidecar folder is excluded because it is not a collection.
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

pub fn read_library_folders() -> io::Result<Vec<LibraryFolder>> {
    read_library_folders_in(&downloads_dir()?)
}

pub fn read_media_files_in_folder(folder: Option<&str>) -> io::Result<Vec<MediaFile>> {
    read_media_files_in(&library_dir(folder)?)
}

pub fn create_library_folder(name: &str) -> io::Result<PathBuf> {
    let path = library_dir(Some(name))?;
    if path.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "같은 이름의 폴더가 이미 있습니다.",
        ));
    }
    fs::create_dir(&path)?;
    Ok(path)
}

/// Renames one user collection without moving any of its contents outside the
/// configured library root. Both names are validated as single path segments
/// and an existing destination is never replaced.
pub fn rename_library_folder_in(root: &Path, from: &str, to: &str) -> io::Result<PathBuf> {
    let from = valid_folder_name(from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid source folder name"))?;
    let to = valid_folder_name(to).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid destination folder name",
        )
    })?;
    let source = root.join(&from);
    let destination = root.join(&to);
    if !source.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "폴더를 찾지 못했습니다.",
        ));
    }
    if source == destination {
        return Ok(destination);
    }
    if destination.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "같은 이름의 폴더가 이미 있습니다.",
        ));
    }
    fs::rename(&source, &destination)?;
    Ok(destination)
}

pub fn rename_library_folder(from: &str, to: &str) -> io::Result<PathBuf> {
    rename_library_folder_in(&downloads_dir()?, from, to)
}

/// Moves one media file between the root and a folder. The destination name is
/// kept, and an existing file at the destination is never overwritten.
pub fn move_media_file(
    file_name: &str,
    from: Option<&str>,
    to: Option<&str>,
) -> io::Result<PathBuf> {
    move_library_file_in(&downloads_dir()?, from, file_name, to, file_name)
}

/// Moves and optionally collision-renames one file inside a validated library
/// root. The destination is claimed without replacing an existing entry.
pub fn move_library_file_in(
    root: &Path,
    from: Option<&str>,
    source_file_name: &str,
    to: Option<&str>,
    destination_file_name: &str,
) -> io::Result<PathBuf> {
    let source_name = library_target(source_file_name)?;
    let destination_name = library_target(destination_file_name)?;
    if source_name
        .extension()
        .and_then(|value| value.to_str())
        .zip(
            destination_name
                .extension()
                .and_then(|value| value.to_str()),
        )
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
    move_file_no_replace(&source, &destination)?;
    Ok(destination)
}

fn move_file_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    match fs::symlink_metadata(destination) {
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "the destination already exists",
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }

    #[cfg(target_os = "windows")]
    {
        // Windows rename fails if a destination appeared after the check, so
        // this remains no-replace even across that race.
        fs::rename(source, destination)
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Both paths are below one root and therefore on one filesystem. A
        // hard-link claim is atomic and never replaces an existing name.
        fs::hard_link(source, destination)?;
        if let Err(error) = fs::remove_file(source) {
            let _ = fs::remove_file(destination);
            return Err(error);
        }
        Ok(())
    }
}

/// A current on-disk media record plus its direct library collection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryMediaRecord {
    pub folder: Option<String>,
    pub media: MediaFile,
}

/// Conservative organization rules based only on the already-supported media
/// extension. Titles, timestamps, and opaque metadata never affect a category.
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

/// Immutable-by-construction preview consumed by the apply operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryOrganizationPlan {
    root: PathBuf,
    items: Vec<LibraryOrganizationPlanItem>,
}

impl LibraryOrganizationPlan {
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn items(&self) -> &[LibraryOrganizationPlanItem] {
        &self.items
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryOrganizationReverseItemResult {
    pub entry: LibraryMoveJournalEntry,
    pub outcome: LibraryOperationOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryOrganizationReverseReport {
    pub items: Vec<LibraryOrganizationReverseItemResult>,
    /// Only entries that still need reversal, in original application order.
    pub remaining: LibraryMoveJournal,
}

impl LibraryOrganizationReverseReport {
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

/// Captures the current root and direct collection files as `MediaFile`
/// records. A missing root is an empty library and does not get created.
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
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase();
    match extension.as_str() {
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
            "media file changed after the organization preview",
        ));
    }
    Ok(())
}

fn occupied_names_in(root: &Path, folder: &str) -> io::Result<BTreeSet<String>> {
    let root = validated_library_root(root)?;
    let path = root.join(folder);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(BTreeSet::new()),
        Err(error) => return Err(error),
        Ok(_) => {}
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

/// Builds a deterministic, write-free preview from a media snapshot. Only
/// root-level files are organized; files in user collections are preserved.
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
        debug_assert!(source_path.is_file());
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

/// Scans current records and returns a preview without creating category
/// folders or moving files.
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

pub fn preview_library_organization() -> io::Result<LibraryOrganizationPlan> {
    preview_library_organization_in(&downloads_dir()?)
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
        item.source.folder.as_deref(),
        &item.source.file_name,
        item.destination.folder.as_deref(),
        &item.destination.file_name,
    )
}

/// Applies exactly the destinations shown in a preview. A destination that
/// became occupied is reported as failed rather than silently replanned.
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

/// Replays successful moves backward. Failures remain journaled so callers can
/// resolve a collision and retry without repeating reversals that succeeded.
pub fn reverse_library_organization(
    journal: &LibraryMoveJournal,
) -> LibraryOrganizationReverseReport {
    let mut results = Vec::with_capacity(journal.entries.len());
    let mut remaining = Vec::new();
    for entry in journal.entries.iter().rev() {
        let outcome = match (|| {
            let current = media_path_in(
                &journal.root,
                entry.to.folder.as_deref(),
                &entry.to.file_name,
            )?;
            require_matching_media_record(&current, &entry.media)?;
            move_library_file_in(
                &journal.root,
                entry.to.folder.as_deref(),
                &entry.to.file_name,
                entry.from.folder.as_deref(),
                &entry.from.file_name,
            )
        })() {
            Ok(path) => LibraryOperationOutcome::Succeeded { path },
            Err(error) => {
                remaining.push(entry.clone());
                LibraryOperationOutcome::Failed(LibraryOperationFailure::from_error(&error))
            }
        };
        results.push(LibraryOrganizationReverseItemResult {
            entry: entry.clone(),
            outcome,
        });
    }
    remaining.reverse();
    LibraryOrganizationReverseReport {
        items: results,
        remaining: LibraryMoveJournal {
            root: journal.root.clone(),
            entries: remaining,
        },
    }
}

/// Resume or retry a job: prepare, mark queued, then run the host's runner.
pub fn restart_job(job_id: &str, status_text: &str) -> io::Result<()> {
    let directory = jobs_dir()?;
    let request = prepare_restart_in(&directory, job_id)?;
    // A missing or unreadable state file is not fatal; the runner rewrites it.
    let _ = mark_queued_in(&directory, job_id, status_text);
    spawn_job_runner(&request)
}

fn safe_job_id(now: u64) -> String {
    format!("subtitle-{now}-{}", now % 997)
}

fn write_json_atomic(path: &Path, value: &Value) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec(value).map_err(io::Error::other)?,
    )?;
    fs::rename(temporary, path)
}

/// Starts the Companion/Modal subtitle runner for a library file.
pub fn start_library_subtitle_job(folder: Option<&str>, file_name: &str) -> io::Result<String> {
    let media = media_path(folder, file_name)?;
    let title = Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(file_name)
        .to_string();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let job_id = safe_job_id(now);
    let directory = jobs_dir()?;
    fs::create_dir_all(&directory)?;
    let request_id = format!("library-{job_id}");
    let envelope = json!({
        "job_id": job_id,
        "request_id": request_id,
        "candidate_id": request_id,
        "source_language": "ja",
        "target_language": "ko",
        "media": {
            "type": "local-file",
            "title": title,
            "pageUrl": "",
            "resourceUrl": "",
            "audioRenditionUrl": "",
            "localFilePath": media.to_string_lossy(),
        }
    });
    let state = json!({
        "jobId": job_id,
        "jobType": "subtitle",
        "requestId": request_id,
        "candidateId": request_id,
        "sourceLanguage": "ja",
        "targetLanguage": "ko",
        "inputKind": "local-file",
        "outputFormat": "vtt",
        "executionStatus": "started",
        "status": "preparing",
        "statusText": "보관함 영상에서 자막을 준비하는 중…",
        "title": title,
        "createdAt": now,
        "updatedAt": now,
    });
    let request_path = directory.join(format!("{job_id}.subtitle.request.json"));
    let state_path = directory.join(format!("{job_id}.state.json"));
    write_json_atomic(&request_path, &envelope)?;
    write_json_atomic(&state_path, &state)?;
    spawn_subtitle_runner(&request_path)?;
    Ok(job_id)
}

#[cfg(target_os = "windows")]
pub fn spawn_subtitle_runner(request_path: &Path) -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    Command::new(host_executable()?)
        .arg("--run-subtitle-job")
        .arg(request_path)
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn spawn_subtitle_runner(_request_path: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "starting a subtitle job is Windows only",
    ))
}

#[cfg(target_os = "windows")]
pub fn open_downloads_folder() -> io::Result<()> {
    open_library_folder(None)
}

#[cfg(target_os = "windows")]
pub fn open_library_folder(folder: Option<&str>) -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let folder = library_dir(folder)?;
    fs::create_dir_all(&folder)?;
    Command::new("explorer.exe")
        .arg(folder)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn open_downloads_folder() -> io::Result<()> {
    open_library_folder(None)
}

#[cfg(not(target_os = "windows"))]
pub fn open_library_folder(_folder: Option<&str>) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "opening the downloads folder is Windows only",
    ))
}

/// Only the trailing file name is accepted, and only for media extensions, so
/// neither a state file nor an arbitrary path can ever become a delete target.
fn library_target(file_name: &str) -> io::Result<PathBuf> {
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
        || !is_media_file_name(name)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid media file name",
        ));
    }
    Ok(PathBuf::from(file_name))
}

fn validated_media_path_in_dir(directory: &Path, name: &Path) -> io::Result<PathBuf> {
    let path = directory.join(name);
    let metadata = fs::symlink_metadata(&path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            io::Error::new(
                io::ErrorKind::NotFound,
                "파일을 찾지 못했습니다. 이동했거나 삭제된 것 같습니다.",
            )
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

/// Resolves one media target under an explicit testable library root.
pub fn media_path_in(root: &Path, folder: Option<&str>, file_name: &str) -> io::Result<PathBuf> {
    let name = library_target(file_name)?;
    let directory = validated_library_dir_in(root, folder, false)?;
    validated_media_path_in_dir(&directory, &name)
}

/// Resolves one playable library file inside the configured download folder.
/// Callers never receive a path outside that folder, even when given a path-like
/// string instead of a plain file name.
pub fn media_path(folder: Option<&str>, file_name: &str) -> io::Result<PathBuf> {
    media_path_in(&downloads_dir()?, folder, file_name)
}

/// Moves a library file to the Windows Recycle Bin instead of deleting it
/// permanently, so a mistaken tap stays recoverable.
#[cfg(target_os = "windows")]
pub fn delete_media_file(folder: Option<&str>, file_name: &str) -> io::Result<PathBuf> {
    delete_media_file_in(&downloads_dir()?, folder, file_name)
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

    // `canonicalize` adds Windows' verbatim prefix, while the legacy shell API
    // expects an ordinary drive or UNC path. Validation still used the
    // canonical path; only the representation passed to the shell changes.
    let rendered = path.as_os_str().to_string_lossy();
    let shell_path = if let Some(unc) = rendered.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{unc}"))
    } else if let Some(ordinary) = rendered.strip_prefix(r"\\?\") {
        PathBuf::from(ordinary)
    } else {
        path.to_path_buf()
    };

    // SHFileOperationW expects a double-null-terminated source path list.
    let mut wide: Vec<u16> = shell_path.as_os_str().encode_wide().collect();
    wide.push(0);
    wide.push(0);

    let mut operation = SHFILEOPSTRUCTW {
        hwnd: HWND(core::ptr::null_mut()),
        wFunc: FO_DELETE,
        pFrom: PCWSTR(wide.as_ptr()),
        pTo: PCWSTR::null(),
        // Allowed undo sends the file to the recycle bin; the other three
        // flags suppress shell UI because the window already confirmed.
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI).0 as u16,
        fAnyOperationsAborted: BOOL(0),
        hNameMappings: core::ptr::null_mut(),
        lpszProgressTitle: PCWSTR::null(),
    };

    // SAFETY: `wide` stays alive for the call and holds a valid double-null
    // terminated path, and every struct field is initialized.
    let result = unsafe { SHFileOperationW(&mut operation) };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result));
    }
    if operation.fAnyOperationsAborted != BOOL(0) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "파일을 휴지통으로 보내지 못했습니다. 파일이 사용 중인지 확인해 주세요.",
        ));
    }
    Ok(path.to_path_buf())
}

#[cfg(not(target_os = "windows"))]
pub fn delete_media_file(_folder: Option<&str>, _file_name: &str) -> io::Result<PathBuf> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Recycle Bin deletion is Windows only",
    ))
}

/// Validates an explicit root/folder/file tuple before invoking the operating
/// system's recoverable Recycle Bin operation.
#[cfg(target_os = "windows")]
pub fn delete_media_file_in(
    root: &Path,
    folder: Option<&str>,
    file_name: &str,
) -> io::Result<PathBuf> {
    recycle_validated_media_path(&media_path_in(root, folder, file_name)?)
}

#[cfg(not(target_os = "windows"))]
pub fn delete_media_file_in(
    _root: &Path,
    _folder: Option<&str>,
    _file_name: &str,
) -> io::Result<PathBuf> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Recycle Bin deletion is Windows only",
    ))
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

/// Sends every independently validated media target to the Windows Recycle
/// Bin and retains an exact result for every requested item.
pub fn batch_recycle_media_files_in(root: &Path, items: &[LibraryFileRef]) -> BatchRecycleReport {
    #[cfg(target_os = "windows")]
    {
        batch_recycle_media_files_with(root, items, recycle_validated_media_path)
    }

    #[cfg(not(target_os = "windows"))]
    {
        batch_recycle_media_files_with(root, items, |_| {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Recycle Bin deletion is Windows only",
            ))
        })
    }
}

pub fn batch_recycle_media_files(items: &[LibraryFileRef]) -> io::Result<BatchRecycleReport> {
    Ok(batch_recycle_media_files_in(&downloads_dir()?, items))
}

/// Reveals a library file in Explorer with it selected.
#[cfg(target_os = "windows")]
pub fn reveal_file(folder: Option<&str>, file_name: &str) -> io::Result<PathBuf> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let path = media_path(folder, file_name)?;
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
        "revealing a file is Windows only",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let directory = env::temp_dir().join(format!(
            "aura-manager-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock is after the epoch")
                .as_nanos()
        ));
        fs::create_dir_all(&directory).expect("temp directory creates");
        directory
    }

    #[cfg(target_os = "windows")]
    fn directory_link(target: &Path, link: &Path) -> io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    #[cfg(unix)]
    fn directory_link(target: &Path, link: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    fn write_state(directory: &Path, job_id: &str, body: &str) {
        fs::write(directory.join(format!("{job_id}.state.json")), body).expect("state file writes");
    }

    fn shared_fixture(name: &str) -> &'static str {
        match name {
            "current" => include_str!("../../test-fixtures/companion/job-state-v1.json"),
            "legacy" => include_str!("../../test-fixtures/companion/job-state-legacy-v1.json"),
            "disk" => include_str!("../../test-fixtures/companion/disk-abi-v1.json"),
            _ => panic!("unknown shared fixture: {name}"),
        }
    }

    #[test]
    fn reads_states_newest_first_and_ignores_other_files() {
        let directory = temp_dir("read");
        write_state(
            &directory,
            "older",
            r#"{"jobId":"older","status":"completed","statusText":"done","updatedAt":10}"#,
        );
        write_state(
            &directory,
            "newer",
            r#"{"jobId":"newer","status":"running","statusText":"going","updatedAt":20}"#,
        );
        fs::write(directory.join("newer.cancel"), b"cancel").expect("marker writes");
        fs::write(directory.join("notes.txt"), b"ignored").expect("stray file writes");

        let jobs = read_jobs_in(&directory).expect("jobs read");
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[0].job_id, "newer");
        assert_eq!(jobs[1].job_id, "older");

        fs::remove_dir_all(directory).expect("temp directory removes");
    }

    #[test]
    fn a_corrupt_state_file_does_not_discard_the_rest_of_the_list() {
        let directory = temp_dir("corrupt");
        write_state(
            &directory,
            "good",
            r#"{"jobId":"good","status":"queued","updatedAt":5}"#,
        );
        write_state(&directory, "torn", r#"{"jobId":"torn","status":"run"#);
        write_state(&directory, "empty-id", r#"{"jobId":"","status":"queued"}"#);

        let jobs = read_jobs_in(&directory).expect("jobs read");
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].job_id, "good");

        fs::remove_dir_all(directory).expect("temp directory removes");
    }

    #[test]
    fn unknown_fields_from_a_newer_host_are_tolerated() {
        let directory = temp_dir("forward");
        write_state(
            &directory,
            "future",
            r#"{"jobId":"future","status":"running","statusText":"x","updatedAt":1,"brandNewField":42}"#,
        );
        let jobs = read_jobs_in(&directory).expect("jobs read");
        assert_eq!(jobs.len(), 1);
        fs::remove_dir_all(directory).expect("temp directory removes");
    }

    #[test]
    fn shared_host_job_state_fixtures_remain_readable() {
        let directory = temp_dir("shared-state");
        write_state(&directory, "job-state-fixture", shared_fixture("current"));
        write_state(&directory, "legacy-job-fixture", shared_fixture("legacy"));

        let jobs = read_jobs_in(&directory).expect("shared job states read");
        assert_eq!(jobs.len(), 2);
        let current = jobs
            .iter()
            .find(|job| job.job_id == "job-state-fixture")
            .expect("current fixture is present");
        assert_eq!(current.input_kind.as_deref(), Some("HLS_MASTER"));
        assert_eq!(current.progress, Some(42));
        let legacy = jobs
            .iter()
            .find(|job| job.job_id == "legacy-job-fixture")
            .expect("legacy fixture is present");
        assert_eq!(legacy.status, "completed");
        assert_eq!(legacy.file_name.as_deref(), Some("legacy.mp4"));

        fs::remove_dir_all(directory).expect("temp directory removes");
    }

    #[test]
    fn shared_disk_abi_fixture_matches_manager_paths() {
        let directory = temp_dir("shared-disk-abi");
        let fixture: Value = serde_json::from_str(shared_fixture("disk")).expect("fixture parses");
        let job_id = fixture["jobId"].as_str().expect("job id is present");
        for (key, path) in [
            ("request", request_path_in(&directory, job_id).unwrap()),
            ("state", state_path_in(&directory, job_id).unwrap()),
            ("cancel", cancel_path_in(&directory, job_id).unwrap()),
            ("pause", pause_path_in(&directory, job_id).unwrap()),
            (
                "subtitleRequest",
                contract::subtitle_request_path_in(&directory, job_id).unwrap(),
            ),
        ] {
            assert_eq!(
                path.file_name().and_then(|value| value.to_str()),
                fixture[key].as_str(),
                "{key} path drifted from the shared disk ABI"
            );
        }
        assert_eq!(
            settings_path(&directory)
                .file_name()
                .and_then(|value| value.to_str()),
            fixture["settings"].as_str()
        );
        fs::remove_dir_all(directory).expect("temp directory removes");
    }

    #[test]
    fn subtitle_job_fields_round_trip() {
        let directory = temp_dir("subtitle");
        write_state(
            &directory,
            "sub",
            r#"{"jobId":"sub","jobType":"subtitle","status":"running","statusText":"t","phase":"transcribe","sourceLanguage":"en","targetLanguage":"ko","outputFormat":"vtt","progress":62,"updatedAt":3}"#,
        );
        let jobs = read_jobs_in(&directory).expect("jobs read");
        let job = &jobs[0];
        assert_eq!(job.job_type.as_deref(), Some("subtitle"));
        assert_eq!(job.phase.as_deref(), Some("transcribe"));
        assert_eq!(job.progress, Some(62));
        fs::remove_dir_all(directory).expect("temp directory removes");
    }

    #[test]
    fn cancel_writes_the_marker_the_host_polls_for() {
        let directory = temp_dir("cancel");
        request_cancel_in(&directory, "job-abc").expect("cancel writes");
        let path = directory.join("job-abc.cancel");
        assert!(path.is_file());
        assert_eq!(fs::read(path).expect("marker reads"), b"cancel");
        fs::remove_dir_all(directory).expect("temp directory removes");
    }

    #[test]
    fn cancel_marks_the_card_as_processing_after_the_stop_marker_exists() {
        let directory = temp_dir("cancel-state");
        write_state(
            &directory,
            "job-abc",
            r#"{"jobId":"job-abc","status":"running","statusText":"다운로드 중","error":"old","updatedAt":1}"#,
        );

        request_cancel_in(&directory, "job-abc").expect("cancel writes and state updates");

        assert!(directory.join("job-abc.cancel").is_file());
        let jobs = read_jobs_in(&directory).expect("jobs read");
        assert_eq!(jobs[0].status, "running");
        assert_eq!(jobs[0].status_text, "취소 처리 중…");
        assert!(jobs[0].error.is_none());
        fs::remove_dir_all(directory).expect("temp directory removes");
    }

    #[test]
    fn clearing_history_preserves_active_jobs_and_removes_only_terminal_records() {
        let directory = temp_dir("clear-history");
        for (id, status) in [
            ("done", "completed"),
            ("failed", "failed"),
            ("cancelled", "cancelled"),
            ("active", "running"),
        ] {
            write_state(
                &directory,
                id,
                &format!(r#"{{"jobId":"{id}","status":"{status}","updatedAt":1}}"#),
            );
            fs::write(directory.join(format!("{id}.request.json")), b"{}").expect("request writes");
        }

        assert_eq!(
            clear_terminal_history_in(&directory).expect("history clears"),
            3
        );
        assert!(directory.join("active.state.json").is_file());
        assert!(directory.join("active.request.json").is_file());
        for id in ["done", "failed", "cancelled"] {
            assert!(!directory.join(format!("{id}.state.json")).exists());
            assert!(!directory.join(format!("{id}.request.json")).exists());
        }
        fs::remove_dir_all(directory).expect("temp directory removes");
    }

    #[test]
    fn cancel_refuses_a_job_id_that_could_escape_the_jobs_folder() {
        let directory = temp_dir("escape");
        for bad in ["../escape", "a/b", "a\\b", "", "with space", "sem;colon"] {
            assert!(
                request_cancel_in(&directory, bad).is_err(),
                "job id {bad:?} must be rejected"
            );
        }
        assert!(contract::safe_id("valid-id_09").is_some());
        fs::remove_dir_all(directory).expect("temp directory removes");
    }

    #[test]
    fn the_job_list_is_capped() {
        let directory = temp_dir("cap");
        for index in 0..140 {
            write_state(
                &directory,
                &format!("job{index}"),
                &format!(r#"{{"jobId":"job{index}","status":"completed","updatedAt":{index}}}"#),
            );
        }
        assert_eq!(
            read_jobs_in(&directory).expect("jobs read").len(),
            contract::MAX_JOB_STATES
        );
        fs::remove_dir_all(directory).expect("temp directory removes");
    }

    #[test]
    fn pause_writes_a_marker_distinct_from_cancel() {
        let directory = temp_dir("pause");
        request_pause_in(&directory, "job-abc").expect("pause writes");
        assert!(directory.join("job-abc.pause").is_file());
        assert!(!directory.join("job-abc.cancel").exists());

        request_cancel_in(&directory, "job-abc").expect("cancel writes");
        assert!(directory.join("job-abc.cancel").is_file());
        fs::remove_dir_all(directory).expect("temp directory removes");
    }

    #[test]
    fn pause_refuses_a_job_id_that_could_escape_the_jobs_folder() {
        let directory = temp_dir("pause-escape");
        for bad in ["../escape", "a/b", "a\\b", "", "with space"] {
            assert!(
                request_pause_in(&directory, bad).is_err(),
                "job id {bad:?} must be rejected"
            );
        }
        fs::remove_dir_all(directory).expect("temp directory removes");
    }

    #[test]
    fn restart_requires_the_persisted_request_and_clears_both_markers() {
        let directory = temp_dir("restart");
        // Without the record there is nothing to replay.
        assert!(prepare_restart_in(&directory, "job-abc").is_err());

        fs::write(
            directory.join("job-abc.request.json"),
            br#"{"type":"youtube-download","jobId":"job-abc","url":"https://youtu.be/x"}"#,
        )
        .expect("request writes");
        request_pause_in(&directory, "job-abc").expect("pause writes");
        request_cancel_in(&directory, "job-abc").expect("cancel writes");

        let request = prepare_restart_in(&directory, "job-abc").expect("restart prepares");
        assert!(request.is_file());
        // A leftover marker would stop the fresh runner on its first loop.
        assert!(!directory.join("job-abc.pause").exists());
        assert!(!directory.join("job-abc.cancel").exists());

        fs::remove_dir_all(directory).expect("temp directory removes");
    }

    #[test]
    fn restartable_ids_only_include_jobs_with_a_surviving_record() {
        let directory = temp_dir("restartable");
        fs::write(directory.join("has-record.request.json"), b"{}").expect("request writes");
        let ids = restartable_ids_in(
            &directory,
            &["has-record".to_string(), "no-record".to_string()],
        );
        assert!(ids.contains("has-record"));
        assert!(!ids.contains("no-record"));
        fs::remove_dir_all(directory).expect("temp directory removes");
    }

    #[test]
    fn marking_a_job_queued_clears_a_previous_error() {
        let directory = temp_dir("queued");
        write_state(
            &directory,
            "job-abc",
            r#"{"jobId":"job-abc","status":"failed","statusText":"실패","error":"boom","progress":40,"updatedAt":7}"#,
        );
        mark_queued_in(&directory, "job-abc", "다시 시도하는 중…").expect("state updates");

        let jobs = read_jobs_in(&directory).expect("jobs read");
        assert_eq!(jobs[0].status, "queued");
        assert_eq!(jobs[0].status_text, "다시 시도하는 중…");
        assert_eq!(
            jobs[0].error, None,
            "a stale error must not survive a retry"
        );
        assert_eq!(jobs[0].progress, Some(40), "other fields are preserved");
        fs::remove_dir_all(directory).expect("temp directory removes");
    }

    #[test]
    fn media_bytes_sum_playable_files_in_root_and_user_folders() {
        let directory = temp_dir("media-bytes");
        fs::write(directory.join("root.mp4"), vec![0_u8; 1_000]).expect("root writes");
        fs::write(directory.join("notes.txt"), b"skip").expect("notes write");
        let nested = directory.join("Keep");
        fs::create_dir_all(&nested).expect("folder creates");
        fs::write(nested.join("clip.mkv"), vec![0_u8; 2_000]).expect("nested writes");
        let subtitles = directory.join("Subtitles");
        fs::create_dir_all(&subtitles).expect("subtitle folder creates");
        fs::write(subtitles.join("inner.mp4"), vec![0_u8; 9_000]).expect("sidecar writes");
        assert_eq!(media_bytes_in(&directory).expect("bytes"), 3_000);
        fs::remove_dir_all(directory).expect("temp directory removes");
    }

    #[test]
    fn a_settings_folder_must_be_absolute_and_traversal_free() {
        assert!(valid_download_folder("relative\\path").is_none());
        assert!(valid_download_folder("").is_none());
        assert!(valid_download_folder("C:\\Media\\..\\Windows").is_none());
        assert!(valid_download_folder("C:\\Media\u{0}").is_none());
        assert_eq!(
            valid_download_folder("  C:\\Media\\Aura  "),
            Some(PathBuf::from("C:\\Media\\Aura"))
        );
    }

    #[test]
    fn the_download_folder_round_trips_through_shared_settings() {
        let root = temp_dir("settings");
        fs::write(
            settings_path(&root),
            br#"{"licenseKey":"AM-0123456789ABCDEF0123456789ABCDEF012"}"#,
        )
        .expect("existing settings write");

        let target = root.join("chosen");
        let written = write_download_folder_in(&root, &target).expect("folder writes");
        assert_eq!(written, target);
        assert!(target.is_dir());
        assert_eq!(read_download_folder_in(&root), Some(target));

        // The host owns the license key; changing the folder must not drop it.
        let document: Value =
            serde_json::from_slice(&fs::read(settings_path(&root)).expect("settings read"))
                .expect("settings parse");
        assert_eq!(
            document["licenseKey"].as_str(),
            Some("AM-0123456789ABCDEF0123456789ABCDEF012")
        );

        fs::remove_dir_all(root).expect("temp directory removes");
    }

    #[test]
    fn player_shortcuts_round_trip_without_dropping_host_settings() {
        use crate::shortcuts::ShortcutAction;
        use eframe::egui::{Key, KeyboardShortcut, Modifiers};

        let root = temp_dir("shortcut-settings");
        fs::write(
            settings_path(&root),
            br#"{"licenseKey":"keep","downloadFolder":"C:\\Media"}"#,
        )
        .expect("existing settings write");
        let mut shortcuts = PlayerShortcuts::default();
        shortcuts.assign_and_swap(
            ShortcutAction::ToggleFullscreen,
            KeyboardShortcut::new(Modifiers::COMMAND, Key::Enter),
        );

        write_player_shortcuts_in(&root, shortcuts).expect("shortcuts write");
        assert_eq!(read_player_shortcuts_in(&root), shortcuts);
        let document: Value =
            serde_json::from_slice(&fs::read(settings_path(&root)).expect("settings read"))
                .expect("settings parse");
        assert_eq!(document["licenseKey"], "keep");
        assert_eq!(document["downloadFolder"], "C:\\Media");

        fs::remove_dir_all(root).expect("temp directory removes");
    }

    #[test]
    fn a_malformed_settings_folder_falls_back_instead_of_being_trusted() {
        let root = temp_dir("settings-bad");
        fs::write(
            settings_path(&root),
            br#"{"downloadFolder":"not-absolute"}"#,
        )
        .expect("settings write");
        assert_eq!(read_download_folder_in(&root), None);

        fs::write(settings_path(&root), b"{ not json").expect("settings write");
        assert_eq!(read_download_folder_in(&root), None);

        fs::remove_dir_all(root).expect("temp directory removes");
    }

    #[test]
    fn writing_a_relative_folder_is_refused_and_leaves_settings_untouched() {
        let root = temp_dir("settings-refuse");
        assert!(write_download_folder_in(&root, Path::new("relative\\media")).is_err());
        assert!(!settings_path(&root).exists());
        fs::remove_dir_all(root).expect("temp directory removes");
    }

    #[test]
    fn only_media_extensions_count_as_library_files() {
        for name in [
            "clip.mp4",
            "clip.MKV",
            "stream.ts",
            "capture.m2ts",
            "audio.m4a",
            "song.flac",
            "show.webm",
        ] {
            assert!(is_media_file_name(name), "{name} should count");
        }
        // Subtitles belong to their own view, and a partial transfer is not a
        // result the user can play.
        for name in [
            "clip.ko.vtt",
            "clip.srt",
            "clip.mp4.part",
            "notes.txt",
            "state.json",
            "noextension",
        ] {
            assert!(!is_media_file_name(name), "{name} should not count");
        }
    }

    #[test]
    fn the_folder_listing_returns_media_newest_first() {
        let directory = temp_dir("media");
        for name in ["old.mp4", "new.mkv", "notes.txt", "clip.ko.vtt"] {
            fs::write(directory.join(name), b"data").expect("file writes");
        }
        // Make the ordering deterministic rather than relying on write order.
        let old = directory.join("old.mp4");
        let new = directory.join("new.mkv");
        let base =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        filetime_set(&old, base);
        filetime_set(&new, base + std::time::Duration::from_secs(60));

        let files = read_media_files_in(&directory).expect("folder reads");
        assert_eq!(files.len(), 2, "only media files are listed");
        assert_eq!(files[0].file_name, "new.mkv");
        assert_eq!(files[1].file_name, "old.mp4");
        assert_eq!(files[0].size, 4);

        fs::remove_dir_all(directory).expect("temp directory removes");
    }

    #[test]
    fn a_missing_download_folder_is_an_empty_library_not_an_error() {
        let directory = temp_dir("absent").join("never-created");
        assert_eq!(read_media_files_in(&directory).expect("no error").len(), 0);
    }

    #[test]
    fn subdirectories_are_not_walked() {
        let directory = temp_dir("nested");
        let subtitles = directory.join("Subtitles");
        fs::create_dir_all(&subtitles).expect("subfolder creates");
        fs::write(subtitles.join("inner.mp4"), b"data").expect("file writes");
        fs::write(directory.join("outer.mp4"), b"data").expect("file writes");

        let files = read_media_files_in(&directory).expect("folder reads");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].file_name, "outer.mp4");

        fs::remove_dir_all(directory).expect("temp directory removes");
    }

    #[test]
    fn library_target_accepts_only_media_file_names() {
        for good in ["clip.mp4", "show.MKV", "audio.m4a"] {
            assert_eq!(
                library_target(good).expect("media name is accepted"),
                PathBuf::from(good)
            );
        }
        // Subtitles, partial transfers, and stray files belong to other
        // surfaces and must never be deletable from the library.
        for bad in [
            "clip.ko.vtt",
            "notes.txt",
            "state.json",
            "noextension",
            "",
            "../outside.mp4",
            "folder/inside.mp4",
            "folder\\inside.mp4",
            "C:\\Windows\\inside.mp4",
            "NUL.mp4",
        ] {
            assert!(library_target(bad).is_err(), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn delete_collapses_paths_to_the_file_name_and_refuses_non_media() {
        // A path is reduced to its trailing name, so it can never name a file
        // outside the download folder; a missing target simply errors.
        assert!(delete_media_file(None, "C:\\Windows\\evil.mp4").is_err());
        assert!(delete_media_file(None, "../outside.mp4").is_err());
        assert!(delete_media_file(None, "clip.ko.vtt").is_err());
        assert!(delete_media_file(None, "notes.txt").is_err());
    }

    #[test]
    fn folder_names_stay_inside_the_download_folder() {
        for good in ["Archive", "2026 정리", "ko subs"] {
            assert_eq!(valid_folder_name(good).as_deref(), Some(good));
        }
        // Traversal, separators, reserved characters, and the subtitle sidecar
        // folder can never become a user collection.
        for bad in [
            "..",
            ".",
            "a/b",
            "a\\b",
            "C:",
            "bad?",
            "trailing.",
            "trailing ",
            "",
            "Subtitles",
            "subtitles",
        ] {
            assert!(valid_folder_name(bad).is_none(), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn folder_listing_counts_media_and_skips_the_subtitle_sidecar() {
        let directory = temp_dir("folders");
        for folder in ["Archive", "Subtitles", "Empty"] {
            fs::create_dir_all(directory.join(folder)).expect("folder creates");
        }
        fs::write(directory.join("Archive\\a.mp4"), b"data").expect("file writes");
        fs::write(directory.join("Archive\\b.mkv"), b"data").expect("file writes");
        fs::write(directory.join("Archive\\notes.txt"), b"data").expect("file writes");
        fs::write(directory.join("Subtitles\\x.mp4"), b"data").expect("file writes");
        fs::write(directory.join("root.mp4"), b"data").expect("file writes");

        let folders = read_library_folders_in(&directory).expect("folders read");
        assert_eq!(folders.len(), 2, "the subtitle sidecar is not a collection");
        assert_eq!(folders[0].name, "Archive");
        assert_eq!(folders[0].media_count, 2);
        assert_eq!(folders[1].name, "Empty");
        assert_eq!(folders[1].media_count, 0);

        fs::remove_dir_all(directory).expect("temp directory removes");
    }

    #[test]
    fn folder_rename_keeps_contents_and_never_replaces_an_existing_folder() {
        let directory = temp_dir("rename-folder");
        let source = directory.join("Before");
        fs::create_dir_all(&source).expect("source folder creates");
        fs::write(source.join("clip.mp4"), b"media").expect("media writes");

        let renamed =
            rename_library_folder_in(&directory, "Before", "After").expect("folder renames");
        assert_eq!(renamed, directory.join("After"));
        assert!(renamed.join("clip.mp4").is_file());
        assert!(!source.exists());

        fs::create_dir(directory.join("Occupied")).expect("destination creates");
        let error = rename_library_folder_in(&directory, "After", "Occupied")
            .expect_err("existing destination must be preserved");
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert!(directory.join("After").join("clip.mp4").is_file());

        for invalid in ["..", "Subtitles", "a/b"] {
            assert!(rename_library_folder_in(&directory, "After", invalid).is_err());
        }
        fs::remove_dir_all(directory).expect("temp directory removes");
    }

    #[test]
    fn explicit_library_paths_reject_traversal_and_non_media_targets() {
        let root = temp_dir("library-path-validation");
        fs::write(root.join("inside.mp4"), b"media").expect("media writes");
        fs::create_dir(root.join("Collection")).expect("collection creates");
        fs::write(root.join("Collection").join("nested.mkv"), b"nested")
            .expect("nested media writes");

        assert!(media_path_in(&root, None, "inside.mp4").is_ok());
        assert!(media_path_in(&root, Some("Collection"), "nested.mkv").is_ok());
        for (folder, file) in [
            (None, "../inside.mp4"),
            (None, "C:\\Windows\\inside.mp4"),
            (Some(".."), "inside.mp4"),
            (Some("Collection/.."), "inside.mp4"),
            (None, "notes.txt"),
        ] {
            assert!(
                media_path_in(&root, folder, file).is_err(),
                "folder={folder:?} file={file:?} must be rejected"
            );
        }

        fs::remove_dir_all(root).expect("temp directory removes");
    }

    #[test]
    fn explicit_library_paths_reject_collection_links_outside_the_root() {
        let root = temp_dir("library-link-root");
        let outside = temp_dir("library-link-outside");
        fs::write(outside.join("outside.mp4"), b"outside").expect("outside media writes");
        let link = root.join("Linked");
        match directory_link(&outside, &link) {
            Ok(()) => {
                assert!(media_path_in(&root, Some("Linked"), "outside.mp4").is_err());
                assert!(outside.join("outside.mp4").is_file());
                fs::remove_dir(&link).expect("directory link removes");
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::PermissionDenied | io::ErrorKind::Unsupported
                ) || error.raw_os_error() == Some(1314) => {}
            Err(error) => panic!("unexpected directory link error: {error}"),
        }

        fs::remove_dir_all(root).expect("root temp directory removes");
        fs::remove_dir_all(outside).expect("outside temp directory removes");
    }

    #[test]
    fn batch_recycle_reports_every_item_and_continues_after_failures() {
        let root = temp_dir("batch-recycle");
        for name in ["first.mp4", "second.mkv"] {
            fs::write(root.join(name), name.as_bytes()).expect("media writes");
        }
        let items = vec![
            LibraryFileRef::new(None, "first.mp4"),
            LibraryFileRef::new(None, "../outside.mp4"),
            LibraryFileRef::new(None, "second.mkv"),
            LibraryFileRef::new(None, "second.mkv"),
        ];
        let mut attempted = Vec::new();
        let report = batch_recycle_media_files_with(&root, &items, |path| {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .expect("media path has a file name")
                .to_string();
            attempted.push(name.clone());
            if name == "second.mkv" {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "simulated recycle failure",
                ));
            }
            Ok(path.to_path_buf())
        });

        assert_eq!(attempted, ["first.mp4", "second.mkv"]);
        assert_eq!(report.items.len(), 4);
        assert_eq!(report.succeeded_count(), 1);
        assert_eq!(report.failed_count(), 3);
        assert_eq!(
            report.items[1]
                .outcome
                .failure()
                .expect("traversal fails")
                .kind,
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            report.items[2]
                .outcome
                .failure()
                .expect("recycle failure retained")
                .kind,
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            report.items[3]
                .outcome
                .failure()
                .expect("duplicate fails")
                .kind,
            io::ErrorKind::InvalidInput
        );
        assert!(root.join("first.mp4").is_file());
        assert!(root.join("second.mkv").is_file());

        fs::remove_dir_all(root).expect("temp directory removes");
    }

    #[test]
    fn organization_preview_is_stable_collision_safe_and_write_free() {
        let root = temp_dir("organization-preview");
        for (name, body) in [
            ("clip.mp4", b"root-video".as_slice()),
            ("song.mp3", b"root-audio".as_slice()),
            ("zeta.mkv", b"root-zeta".as_slice()),
        ] {
            fs::write(root.join(name), body).expect("media writes");
        }
        fs::create_dir(root.join("Videos")).expect("video folder creates");
        fs::write(root.join("Videos").join("clip.mp4"), b"occupied").expect("collision writes");
        fs::write(root.join("Videos").join("clip (2).mp4"), b"occupied")
            .expect("second collision writes");

        let records = read_library_media_records_in(&root).expect("records read");
        let first = plan_library_organization_in(&root, &records).expect("plan builds");
        let mut reversed = records.clone();
        reversed.reverse();
        let second = plan_library_organization_in(&root, &reversed).expect("plan is stable");

        assert_eq!(first, second);
        assert_eq!(
            first
                .items()
                .iter()
                .map(|item| (
                    item.source.file_name.as_str(),
                    item.destination.folder.as_deref(),
                    item.destination.file_name.as_str(),
                ))
                .collect::<Vec<_>>(),
            vec![
                ("clip.mp4", Some("Videos"), "clip (3).mp4"),
                ("song.mp3", Some("Audio"), "song.mp3"),
                ("zeta.mkv", Some("Videos"), "zeta.mkv"),
            ]
        );
        assert!(
            !root.join("Audio").exists(),
            "preview must not create folders"
        );
        assert!(
            root.join("clip.mp4").is_file(),
            "preview must not move files"
        );

        fs::remove_dir_all(root).expect("temp directory removes");
    }

    #[test]
    fn organization_apply_never_overwrites_and_reports_partial_failures() {
        let root = temp_dir("organization-apply-partial");
        fs::write(root.join("alpha.mp4"), b"alpha").expect("video writes");
        fs::write(root.join("beta.mp3"), b"beta").expect("audio writes");
        let plan = preview_library_organization_in(&root).expect("preview builds");
        let beta = plan
            .items()
            .iter()
            .find(|item| item.source.file_name == "beta.mp3")
            .expect("audio plan exists")
            .destination
            .clone();
        fs::create_dir(root.join("Audio")).expect("audio folder creates");
        fs::write(
            root.join(beta.folder.as_deref().expect("folder"))
                .join(&beta.file_name),
            b"do-not-overwrite",
        )
        .expect("late collision writes");

        let report = apply_library_organization(&plan);
        assert_eq!(report.succeeded_count(), 1);
        assert_eq!(report.failed_count(), 1);
        assert_eq!(report.journal.entries().len(), 1);
        assert!(root.join("Videos").join("alpha.mp4").is_file());
        assert!(!root.join("alpha.mp4").exists());
        assert!(root.join("beta.mp3").is_file());
        assert_eq!(
            fs::read(root.join("Audio").join("beta.mp3")).expect("collision reads"),
            b"do-not-overwrite"
        );
        assert_eq!(
            report
                .items
                .iter()
                .find(|item| item.item.source.file_name == "beta.mp3")
                .and_then(|item| item.outcome.failure())
                .expect("audio move fails")
                .kind,
            io::ErrorKind::AlreadyExists
        );

        fs::remove_dir_all(root).expect("temp directory removes");
    }

    #[test]
    fn organization_journal_reverses_successes_and_retains_retryable_failures() {
        let root = temp_dir("organization-reverse");
        fs::write(root.join("alpha.mp4"), b"alpha").expect("video writes");
        fs::write(root.join("beta.mp3"), b"beta").expect("audio writes");
        let plan = preview_library_organization_in(&root).expect("preview builds");
        let applied = apply_library_organization(&plan);
        assert_eq!(applied.succeeded_count(), 2);
        assert_eq!(applied.journal.entries().len(), 2);

        fs::write(root.join("beta.mp3"), b"new occupant").expect("reverse collision writes");
        let first_reverse = reverse_library_organization(&applied.journal);
        assert_eq!(first_reverse.succeeded_count(), 1);
        assert_eq!(first_reverse.failed_count(), 1);
        assert_eq!(first_reverse.remaining.entries().len(), 1);
        assert!(root.join("alpha.mp4").is_file());
        assert!(root.join("Audio").join("beta.mp3").is_file());
        assert_eq!(
            fs::read(root.join("beta.mp3")).expect("occupant reads"),
            b"new occupant"
        );

        fs::remove_file(root.join("beta.mp3")).expect("collision removes");
        let retry = reverse_library_organization(&first_reverse.remaining);
        assert_eq!(retry.succeeded_count(), 1);
        assert_eq!(retry.failed_count(), 0);
        assert!(retry.remaining.is_empty());
        assert_eq!(
            fs::read(root.join("beta.mp3")).expect("restored audio reads"),
            b"beta"
        );

        fs::remove_dir_all(root).expect("temp directory removes");
    }

    #[test]
    fn organization_apply_rejects_files_changed_after_preview() {
        let root = temp_dir("organization-stale-preview");
        fs::write(root.join("clip.mp4"), b"before").expect("video writes");
        let plan = preview_library_organization_in(&root).expect("preview builds");
        fs::write(root.join("clip.mp4"), b"different-length").expect("video changes");

        let report = apply_library_organization(&plan);
        assert_eq!(report.succeeded_count(), 0);
        assert_eq!(report.failed_count(), 1);
        assert!(report.journal.is_empty());
        assert!(root.join("clip.mp4").is_file());
        assert!(!root.join("Videos").join("clip.mp4").exists());
        assert_eq!(
            report.items[0]
                .outcome
                .failure()
                .expect("stale preview fails")
                .kind,
            io::ErrorKind::InvalidData
        );

        fs::remove_dir_all(root).expect("temp directory removes");
    }

    /// Sets a file's modified time so ordering assertions are deterministic.
    fn filetime_set(path: &Path, when: std::time::SystemTime) {
        // No external crate for this, so round-trip through a fresh write and
        // fall back silently when the platform refuses.
        let _ = fs::OpenOptions::new()
            .write(true)
            .open(path)
            .and_then(|file| {
                file.set_modified(when)?;
                Ok(())
            });
    }
}
