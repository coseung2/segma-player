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

use serde_json::{json, Value};

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
    Ok(PathBuf::from(home)
        .join("Downloads")
        .join("Aura Media"))
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
    fs::write(&temporary, serde_json::to_vec_pretty(&document).map_err(io::Error::other)?)?;
    fs::rename(&temporary, &file)?;
    Ok(path)
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
    fs::write(path, b"cancel")
}

pub fn request_cancel(job_id: &str) -> io::Result<()> {
    request_cancel_in(&jobs_dir()?, job_id)
}

/// Pause stops the runner but leaves yt-dlp's `.part` file, so a later resume
/// continues from the same byte. The host leaves this marker on disk while the
/// job is paused; `resume` removes it.
pub fn request_pause_in(directory: &Path, job_id: &str) -> io::Result<()> {
    let path = pause_path_in(directory, job_id)?;
    fs::create_dir_all(directory)?;
    fs::write(path, b"pause")
}

pub fn request_pause(job_id: &str) -> io::Result<()> {
    request_pause_in(&jobs_dir()?, job_id)
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
        "Aura Media Companion 실행 파일을 찾지 못했습니다.",
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
    fs::write(&temporary, serde_json::to_vec(&document).map_err(io::Error::other)?)?;
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
const MEDIA_EXTENSIONS: [&str; 8] = ["mp4", "mkv", "webm", "m4v", "mov", "mp3", "m4a", "flac"];

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
        let Ok(metadata) = entry.metadata() else { continue };
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

pub fn read_media_files() -> io::Result<Vec<MediaFile>> {
    read_media_files_in(&downloads_dir()?)
}


/// Resume or retry a job: prepare, mark queued, then run the host's runner.
pub fn restart_job(job_id: &str, status_text: &str) -> io::Result<()> {
    let directory = jobs_dir()?;
    let request = prepare_restart_in(&directory, job_id)?;
    // A missing or unreadable state file is not fatal; the runner rewrites it.
    let _ = mark_queued_in(&directory, job_id, status_text);
    spawn_job_runner(&request)
}

/// Opens a completed file in whatever the user has associated with it.
///
/// Playback stage one. A libmpv surface inside this window is the intended end
/// state, but the engine is not shipped yet, and handing the file to the system
/// player is honest about what exists rather than showing a dead video area.
#[cfg(target_os = "windows")]
pub fn play_file(file_name: &str) -> io::Result<PathBuf> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // Only the file name is used, so a state file cannot point the player at an
    // arbitrary location on disk.
    let name = Path::new(file_name)
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid file name"))?;
    let path = downloads_dir()?.join(name);
    if !path.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "파일을 찾지 못했습니다. 이동했거나 삭제된 것 같습니다.",
        ));
    }
    Command::new("cmd.exe")
        .arg("/c")
        .arg("start")
        .arg("")
        .arg(&path)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(path)
}

#[cfg(not(target_os = "windows"))]
pub fn play_file(_file_name: &str) -> io::Result<PathBuf> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "playback is Windows only",
    ))
}

#[cfg(target_os = "windows")]
pub fn open_downloads_folder() -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let folder = downloads_dir()?;
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
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "opening the downloads folder is Windows only",
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
        fs::write(directory.join(format!("{job_id}.state.json")), body)
            .expect("state file writes");
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
        write_state(&directory, "good", r#"{"jobId":"good","status":"queued","updatedAt":5}"#);
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
                &format!(
                    r#"{{"jobId":"job{index}","status":"completed","updatedAt":{index}}}"#
                ),
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
        assert_eq!(jobs[0].error, None, "a stale error must not survive a retry");
        assert_eq!(jobs[0].progress, Some(40), "other fields are preserved");
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
    fn a_malformed_settings_folder_falls_back_instead_of_being_trusted() {
        let root = temp_dir("settings-bad");
        fs::write(settings_path(&root), br#"{"downloadFolder":"not-absolute"}"#)
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
        for name in ["clip.mp4", "clip.MKV", "audio.m4a", "song.flac", "show.webm"] {
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
        let base = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
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

    /// Sets a file's modified time so ordering assertions are deterministic.
    fn filetime_set(path: &Path, when: std::time::SystemTime) {
        // No external crate for this, so round-trip through a fresh write and
        // fall back silently when the platform refuses.
        let _ = fs::OpenOptions::new().write(true).open(path).and_then(|file| {
            file.set_modified(when)?;
            Ok(())
        });
    }
}
