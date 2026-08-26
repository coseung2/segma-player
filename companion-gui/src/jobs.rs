//! Reads companion job state and issues the two actions the protocol supports.
//!
//! The manager runs as a separate process from the native messaging host, but
//! both share `%LOCALAPPDATA%\Aura Media\Companion\jobs`. State files are the
//! interface, so nothing here talks to the host process.
//!
//! Field names mirror the host's `JobState` serde renames. Unknown fields are
//! ignored on purpose: a newer host must not break an older manager window.

use serde::Deserialize;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::shortcuts::PlayerShortcuts;

/// Matches the host's cap so a long history cannot grow the window without
/// bound. The host already truncates to 100 when it serializes.
const MAX_JOBS: usize = 100;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct JobState {
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "jobType", default)]
    pub job_type: Option<String>,
    #[serde(rename = "inputKind", default)]
    pub input_kind: Option<String>,
    #[serde(rename = "outputFormat", default)]
    pub output_format: Option<String>,
    #[serde(rename = "sourceLanguage", default)]
    pub source_language: Option<String>,
    #[serde(rename = "targetLanguage", default)]
    pub target_language: Option<String>,
    #[serde(default)]
    pub phase: Option<String>,
    #[serde(default)]
    pub completed: Option<u64>,
    #[serde(default)]
    pub total: Option<u64>,
    #[serde(default)]
    pub status: String,
    #[serde(rename = "statusText", default)]
    pub status_text: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub progress: Option<u8>,
    #[serde(rename = "fileName", default)]
    pub file_name: Option<String>,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: u64,
}

pub fn companion_root() -> io::Result<PathBuf> {
    if let Some(local) = env::var_os("LOCALAPPDATA") {
        return Ok(PathBuf::from(local).join("Aura Media").join("Companion"));
    }
    let executable = env::current_exe()?;
    Ok(executable.parent().unwrap_or(Path::new(".")).to_path_buf())
}

pub fn jobs_dir() -> io::Result<PathBuf> {
    Ok(companion_root()?.join("jobs"))
}

pub fn settings_path(root: &Path) -> PathBuf {
    root.join("settings.json")
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
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 32_767 {
        return None;
    }
    if trimmed.chars().any(char::is_control) {
        return None;
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return None;
    }
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return None;
    }
    Some(path.to_path_buf())
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

/// Same character rule the host uses, so a job id that the host would reject
/// can never be turned into a path here either.
pub fn safe_id(value: &str) -> Option<String> {
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

pub fn cancel_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    let safe = safe_id(job_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid job id"))?;
    Ok(directory.join(format!("{safe}.cancel")))
}

pub fn pause_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    let safe = safe_id(job_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid job id"))?;
    Ok(directory.join(format!("{safe}.pause")))
}

pub fn request_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    let safe = safe_id(job_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid job id"))?;
    Ok(directory.join(format!("{safe}.request.json")))
}

pub fn read_jobs_in(directory: &Path) -> io::Result<Vec<JobState>> {
    let mut states = Vec::new();
    for entry in fs::read_dir(directory)? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !name.ends_with(".state.json") {
            continue;
        }
        // A partially written state file is expected: the host writes
        // atomically, but a reader can still catch a rename in flight. Skip it
        // and pick it up on the next poll instead of failing the whole list.
        if let Ok(bytes) = fs::read(&path) {
            if let Ok(state) = serde_json::from_slice::<JobState>(&bytes) {
                if !state.job_id.is_empty() {
                    states.push(state);
                }
            }
        }
    }
    states.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    states.truncate(MAX_JOBS);
    Ok(states)
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
    let safe = safe_id(job_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid job id"))?;
    Ok(directory.join(format!("{safe}.state.json")))
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
    Some(trimmed.to_string())
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
    let name = library_target(file_name)?;
    let source = library_dir(from)?.join(&name);
    if !source.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "파일을 찾지 못했습니다. 이동했거나 삭제된 것 같습니다.",
        ));
    }
    let destination_dir = library_dir(to)?;
    fs::create_dir_all(&destination_dir)?;
    let destination = destination_dir.join(&name);
    if destination == source {
        return Ok(destination);
    }
    if destination.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "그 폴더에 같은 이름의 파일이 있습니다.",
        ));
    }
    fs::rename(&source, &destination)?;
    Ok(destination)
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
    let name = Path::new(file_name)
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid file name"))?;
    let name = name.to_string_lossy().into_owned();
    if !is_media_file_name(&name) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a media file",
        ));
    }
    Ok(PathBuf::from(name))
}

/// Resolves one playable library file inside the configured download folder.
/// Callers never receive a path outside that folder, even when given a path-like
/// string instead of a plain file name.
pub fn media_path(folder: Option<&str>, file_name: &str) -> io::Result<PathBuf> {
    let path = library_dir(folder)?.join(library_target(file_name)?);
    if !path.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "파일을 찾지 못했습니다. 이동했거나 삭제된 것 같습니다.",
        ));
    }
    Ok(path)
}

/// Moves a library file to the Windows Recycle Bin instead of deleting it
/// permanently, so a mistaken tap stays recoverable.
#[cfg(target_os = "windows")]
pub fn delete_media_file(folder: Option<&str>, file_name: &str) -> io::Result<PathBuf> {
    use std::os::windows::ffi::OsStrExt;

    use windows::core::{BOOL, PCWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
        SHFILEOPSTRUCTW,
    };

    let path = media_path(folder, file_name)?;

    // SHFileOperationW expects a double-null-terminated source path list.
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
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
    Ok(path)
}

#[cfg(not(target_os = "windows"))]
pub fn delete_media_file(folder: Option<&str>, file_name: &str) -> io::Result<PathBuf> {
    let path = media_path(folder, file_name)?;
    fs::remove_file(&path)?;
    Ok(path)
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

    fn write_state(directory: &Path, job_id: &str, body: &str) {
        fs::write(directory.join(format!("{job_id}.state.json")), body).expect("state file writes");
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
        assert!(safe_id("valid-id_09").is_some());
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
        assert_eq!(read_jobs_in(&directory).expect("jobs read").len(), MAX_JOBS);
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
        for bad in ["clip.ko.vtt", "notes.txt", "state.json", "noextension", ""] {
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
