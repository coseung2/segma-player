use aura_companion_contract as contract;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Parent-to-child runner handoff lease. A claim younger than this remains
/// reserved even if its creator has already exited, giving the detached child
/// time to start and adopt it. Older claims are reclaimed only after their
/// recorded owner process is confirmed absent.
pub const RUNNER_CLAIM_HANDOFF_MS: u64 = 30_000;

#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;

static NEXT_ATOMIC_FILE_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_RUNNER_TOKEN_ID: AtomicU64 = AtomicU64::new(1);

pub use contract::JobState;

pub fn companion_root() -> io::Result<PathBuf> {
    contract::companion_root()
}

pub fn jobs_dir() -> io::Result<PathBuf> {
    let path = contract::jobs_dir()?;
    fs::create_dir_all(&path)?;
    Ok(path)
}

pub fn settings_path(root: &Path) -> PathBuf {
    contract::settings_path(root)
}

pub fn valid_download_folder(value: &str) -> Option<PathBuf> {
    contract::valid_download_folder(value)
}

pub fn safe_id(value: &str) -> Option<String> {
    contract::safe_id(value)
}

pub fn request_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    contract::request_path_in(directory, job_id)
}

pub fn state_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    contract::state_path_in(directory, job_id)
}

pub fn cancel_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    contract::cancel_path_in(directory, job_id)
}

pub fn pause_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    contract::pause_path_in(directory, job_id)
}

pub fn runner_claim_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    contract::runner_claim_path_in(directory, job_id)
}

pub fn subtitle_request_path_in(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    contract::subtitle_request_path_in(directory, job_id)
}

fn replace_file_atomic(temporary: &Path, path: &Path) -> io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        let source = temporary
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let destination = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let started = std::time::Instant::now();
        loop {
            let result = unsafe {
                windows_sys::Win32::Storage::FileSystem::MoveFileExW(
                    source.as_ptr(),
                    destination.as_ptr(),
                    windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING
                        | windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH,
                )
            };
            if result != 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if !matches!(error.raw_os_error(), Some(5 | 32))
                || started.elapsed() >= std::time::Duration::from_secs(2)
            {
                return Err(error);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        fs::rename(temporary, path)
    }
}

pub fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temporary = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        NEXT_ATOMIC_FILE_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        replace_file_atomic(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn write_json_atomic(path: &Path, value: &impl Serialize) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    write_bytes_atomic(path, &bytes)
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    contract::read_json(path)
}

pub fn list_job_states_in(directory: &Path) -> io::Result<Vec<JobState>> {
    contract::list_job_states_in(directory)
}

/// Media downloads written before `jobType` existed (YouTube) have no type;
/// subtitle jobs always carry one. Treat untyped records as media downloads.
pub fn is_media_job(state: &JobState) -> bool {
    matches!(state.job_type.as_deref(), None | Some("media"))
}

pub fn persist_job_state_in(
    directory: &Path,
    state: &mut JobState,
    updated_at: u64,
) -> io::Result<()> {
    fs::create_dir_all(directory)?;
    state.updated_at = updated_at;
    write_json_atomic(&state_path_in(directory, &state.job_id)?, state)
}

pub struct RunnerClaim {
    path: Option<PathBuf>,
    token: String,
}

impl Drop for RunnerClaim {
    fn drop(&mut self) {
        if let Some(path) = &self.path {
            let Some(directory) = path.parent() else {
                return;
            };
            if !directory.is_dir() {
                return;
            }
            let Ok(_lifecycle) = lifecycle_lock_in(directory) else {
                return;
            };
            // A recovered job may already own a replacement claim. Never let
            // an old RunnerClaim remove a newer owner's reservation.
            if read_runner_claim(path).is_some_and(|claim| claim.token == self.token) {
                let _ = fs::remove_file(path);
            }
        }
    }
}

impl RunnerClaim {
    pub fn token(&self) -> &str {
        &self.token
    }

    /// Leaves the on-disk reservation for the spawned child to adopt.
    pub fn handoff(mut self) {
        self.path.take();
    }
}

fn runner_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{:x}-{:x}-{:x}",
        std::process::id(),
        nanos,
        NEXT_RUNNER_TOKEN_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn valid_runner_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerClaimRecord {
    token: String,
    pid: u32,
    updated_at: u64,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn read_runner_claim(path: &Path) -> Option<RunnerClaimRecord> {
    let bytes = fs::read(path).ok()?;
    if bytes.len() > 512 {
        return None;
    }
    if let Ok(record) = serde_json::from_slice::<RunnerClaimRecord>(&bytes) {
        return valid_runner_token(&record.token).then_some(record);
    }
    // Compatibility with pre-lease claims, whose token starts with the owner
    // PID in hexadecimal. File modification time supplies the lease age.
    let token = std::str::from_utf8(&bytes).ok()?.trim();
    if !valid_runner_token(token) {
        return None;
    }
    let pid = token
        .split('-')
        .next()
        .and_then(|part| u32::from_str_radix(part, 16).ok())?;
    let updated_at = fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis()
        .min(u128::from(u64::MAX)) as u64;
    Some(RunnerClaimRecord {
        token: token.to_string(),
        pid,
        updated_at,
    })
}

#[cfg(target_os = "windows")]
fn process_owns_claim(pid: u32, claimed_at: u64) -> bool {
    type Handle = *mut std::ffi::c_void;
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const ERROR_INVALID_PARAMETER: u32 = 87;
    const WINDOWS_TO_UNIX_EPOCH_MS: u64 = 11_644_473_600_000;
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> Handle;
        fn GetProcessTimes(
            process: Handle,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn GetLastError() -> u32;
        fn CloseHandle(object: Handle) -> i32;
    }
    // SAFETY: OpenProcess receives a numeric PID. All FILETIME outputs point to
    // initialized stack values, and a successful handle is closed exactly once.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        // Invalid PID means the owner is gone. Access/query failures fail safe
        // and keep the claim rather than risking concurrent live runners.
        return unsafe { GetLastError() } != ERROR_INVALID_PARAMETER;
    }
    let mut creation = FileTime { low: 0, high: 0 };
    let mut exit = FileTime { low: 0, high: 0 };
    let mut kernel = FileTime { low: 0, high: 0 };
    let mut user = FileTime { low: 0, high: 0 };
    let queried =
        unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
    unsafe { CloseHandle(handle) };
    if queried == 0 {
        return true;
    }
    let ticks = (u64::from(creation.high) << 32) | u64::from(creation.low);
    let started_at = (ticks / 10_000).saturating_sub(WINDOWS_TO_UNIX_EPOCH_MS);
    started_at <= claimed_at
}

#[cfg(not(target_os = "windows"))]
fn process_owns_claim(pid: u32, _claimed_at: u64) -> bool {
    PathBuf::from(format!("/proc/{pid}")).exists()
}

fn claim_blocks_runner(
    path: &Path,
    now: u64,
    owner_matches: impl FnOnce(u32, u64) -> bool,
) -> bool {
    let Some(claim) = read_runner_claim(path) else {
        // A partial/malformed record cannot prove its owner absent. Preserve
        // it regardless of age instead of deleting possibly live history.
        return true;
    };
    now.saturating_sub(claim.updated_at) <= RUNNER_CLAIM_HANDOFF_MS
        || owner_matches(claim.pid, claim.updated_at)
}

fn reserve_runner_claim_in_with(
    directory: &Path,
    job_id: &str,
    now: u64,
    owner_matches: impl Fn(u32, u64) -> bool,
) -> io::Result<RunnerClaim> {
    fs::create_dir_all(directory)?;
    let _lifecycle = lifecycle_lock_in(directory)?;
    let path = runner_claim_path_in(directory, job_id)?;
    if path.exists() {
        if claim_blocks_runner(&path, now, &owner_matches) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "job-already-running",
            ));
        }
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    let token = runner_token();
    // A reservation is ownerless during the bounded spawn handoff. The child
    // records its PID when it adopts the token, so the parent can never
    // overwrite a live child's ownership during a fast startup.
    let record = RunnerClaimRecord {
        token: token.clone(),
        pid: 0,
        updated_at: now,
    };
    let bytes = serde_json::to_vec(&record).map_err(io::Error::other)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                io::Error::new(io::ErrorKind::AlreadyExists, "job-already-running")
            } else {
                error
            }
        })?;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    Ok(RunnerClaim {
        path: Some(path),
        token,
    })
}

pub fn reserve_runner_claim_in(directory: &Path, job_id: &str) -> io::Result<RunnerClaim> {
    reserve_runner_claim_in_with(directory, job_id, now_millis(), process_owns_claim)
}

pub fn acquire_runner_claim_in(directory: &Path, job_id: &str) -> io::Result<RunnerClaim> {
    let reservation = reserve_runner_claim_in(directory, job_id)?;
    let adopted = adopt_runner_claim_in(directory, job_id, reservation.token())?;
    reservation.handoff();
    Ok(adopted)
}

pub fn adopt_runner_claim_in(
    directory: &Path,
    job_id: &str,
    expected_token: &str,
) -> io::Result<RunnerClaim> {
    if !valid_runner_token(expected_token) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid-runner-token",
        ));
    }
    let _lifecycle = lifecycle_lock_in(directory)?;
    let path = runner_claim_path_in(directory, job_id)?;
    let Some(mut record) = read_runner_claim(&path) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid-runner-claim",
        ));
    };
    if record.token != expected_token {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "job-runner-token-mismatch",
        ));
    }
    record.pid = std::process::id();
    record.updated_at = now_millis();
    write_json_atomic(&path, &record)?;
    Ok(RunnerClaim {
        path: Some(path),
        token: expected_token.to_string(),
    })
}

/// Returns whether a claim still has a live owner or is inside the bounded
/// parent-to-child handoff window. Stale dead-owner claims are removed.
pub fn runner_claim_is_active_in(directory: &Path, job_id: &str, now: u64) -> io::Result<bool> {
    let _lifecycle = lifecycle_lock_in(directory)?;
    let path = runner_claim_path_in(directory, job_id)?;
    if !path.exists() {
        return Ok(false);
    }
    if claim_blocks_runner(&path, now, process_owns_claim) {
        return Ok(true);
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// Serialize claim recovery/adoption across host processes. The shared lock
/// file is not a job artifact; Windows releases its exclusive handle on exit.
fn lifecycle_lock_in(directory: &Path) -> io::Result<fs::File> {
    fs::create_dir_all(directory)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    let started = std::time::Instant::now();
    loop {
        match options.open(directory.join(".lifecycle.lock")) {
            Ok(file) => {
                #[cfg(unix)]
                {
                    use std::os::fd::AsRawFd;
                    extern "C" {
                        fn flock(fd: i32, operation: i32) -> i32;
                    }
                    // SAFETY: the descriptor is live; LOCK_EX is 2 on Unix.
                    if unsafe { flock(file.as_raw_fd(), 2) } != 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                return Ok(file);
            }
            Err(error)
                if error.raw_os_error() == Some(32)
                    && started.elapsed() < std::time::Duration::from_secs(2) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            Err(error) => return Err(error),
        }
    }
}

#[derive(Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoveJobHistoryResult {
    pub removed_ids: Vec<String>,
    pub skipped_ids: Vec<String>,
}

fn remove_history_artifacts_in(directory: &Path, job_id: &str) -> io::Result<bool> {
    let mut artifacts = Vec::new();
    // Validate every private entry before moving/deleting the first one. Keep
    // recovery bytes until every deletion succeeds, including the state row.
    for path in [
        request_path_in(directory, job_id)?,
        cancel_path_in(directory, job_id)?,
        pause_path_in(directory, job_id)?,
        subtitle_request_path_in(directory, job_id)?,
        state_path_in(directory, job_id)?,
    ] {
        match fs::symlink_metadata(&path) {
            Ok(metadata)
                if metadata.is_file()
                    && !is_reparse(&metadata)
                    && !metadata.permissions().readonly() =>
            {
                artifacts.push((path.clone(), fs::read(path)?));
            }
            Ok(_) => return Ok(false),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    let quarantine = directory.join(format!(".history-{job_id}-{}", runner_token()));
    fs::create_dir(&quarantine)?;
    let result = (|| {
        for (path, _) in &artifacts {
            fs::rename(path, quarantine.join(path.file_name().unwrap()))?;
        }
        for (path, _) in &artifacts {
            fs::remove_file(quarantine.join(path.file_name().unwrap()))?;
        }
        fs::remove_dir(&quarantine)
    })();
    if result.is_ok() {
        return Ok(true);
    }
    // A transient sharing/deletion failure is a per-job skip. Restore all
    // original private records before reporting it, so retry remains possible.
    for (path, bytes) in &artifacts {
        if !path.exists() {
            write_bytes_atomic(path, bytes)?;
        }
    }
    for (path, _) in &artifacts {
        let _ = fs::remove_file(quarantine.join(path.file_name().unwrap()));
    }
    let _ = fs::remove_dir(quarantine);
    Ok(false)
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct DownloadWorkspace {
    pub path: PathBuf,
    pub root: PathBuf,
    job_id: String,
    token: String,
}

fn workspace_receipt(directory: &Path, job_id: &str) -> io::Result<PathBuf> {
    safe_id(job_id).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid job id"))?;
    Ok(directory.join(format!("{job_id}.outputs.json")))
}

impl DownloadWorkspace {
    pub fn prepare(directory: &Path, downloads: &Path, job_id: &str) -> io::Result<Self> {
        let receipt = workspace_receipt(directory, job_id)?;
        if receipt.exists() {
            let workspace: Self =
                read_json(&receipt).ok_or_else(|| io::Error::other("invalid-output-ownership"))?;
            workspace.validate()?;
            if workspace.job_id != job_id || workspace.root != fs::canonicalize(downloads)? {
                return Err(io::Error::other("output-ownership-mismatch"));
            }
            return Ok(workspace);
        }
        fs::create_dir_all(downloads)?;
        let root = fs::canonicalize(downloads)?;
        let token = runner_token();
        let workspace = Self {
            path: root.join(format!(".aura-job-{job_id}-{token}")),
            root,
            job_id: job_id.into(),
            token,
        };
        fs::create_dir(&workspace.path)?;
        write_json_atomic(&workspace.path.join(".owner.json"), &workspace)?;
        write_json_atomic(&receipt, &workspace)?;
        Ok(workspace)
    }

    fn validate(&self) -> io::Result<()> {
        if self.path.parent() != Some(self.root.as_path())
            || self.path.file_name().and_then(|name| name.to_str())
                != Some(format!(".aura-job-{}-{}", self.job_id, self.token).as_str())
            || is_reparse(&fs::symlink_metadata(&self.path)?)
            || fs::canonicalize(&self.path)?.parent() != Some(self.root.as_path())
            || read_json::<Self>(&self.path.join(".owner.json")).as_ref() != Some(self)
        {
            return Err(io::Error::other("output-ownership-mismatch"));
        }
        Ok(())
    }

    pub fn publish(&self, name: &str) -> io::Result<PathBuf> {
        self.validate()?;
        if Path::new(name).file_name().and_then(|value| value.to_str()) != Some(name)
            || name == ".owner.json"
        {
            return Err(io::Error::other("invalid-output-name"));
        }
        let source = self.path.join(name);
        if !fs::symlink_metadata(&source)?.is_file()
            || is_reparse(&fs::symlink_metadata(&source)?)
            || fs::metadata(&source)?.len() == 0
        {
            return Err(io::Error::other("invalid-download-output"));
        }
        let target = crate::media_download::unique_media_path(&self.root, name);
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            #[link(name = "kernel32")]
            extern "system" {
                fn MoveFileW(source: *const u16, target: *const u16) -> i32;
            }
            let source: Vec<_> = source.as_os_str().encode_wide().chain(Some(0)).collect();
            let target_wide: Vec<_> = target.as_os_str().encode_wide().chain(Some(0)).collect();
            // MoveFileW fails if the destination exists; never replaces user media.
            if unsafe { MoveFileW(source.as_ptr(), target_wide.as_ptr()) } == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        #[cfg(not(windows))]
        {
            fs::hard_link(&source, &target)?;
            fs::remove_file(source)?;
        }
        Ok(target)
    }
}

fn is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

pub fn cleanup_download_workspace_in(directory: &Path, job_id: &str) -> io::Result<()> {
    // Windows can keep a handle for a moment after the owned yt-dlp/ffmpeg
    // tree exits (final flush, antivirus scan). Those sharing/access errors are
    // transient; retry for a bounded window before reporting a real failure.
    let started = std::time::Instant::now();
    loop {
        match cleanup_download_workspace_once(directory, job_id) {
            Err(error)
                if matches!(error.raw_os_error(), Some(5) | Some(32))
                    && started.elapsed() < std::time::Duration::from_secs(10) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            outcome => return outcome,
        }
    }
}

fn cleanup_download_workspace_once(directory: &Path, job_id: &str) -> io::Result<()> {
    let receipt = workspace_receipt(directory, job_id)?;
    if !receipt.exists() {
        return Ok(());
    }
    let workspace: DownloadWorkspace =
        read_json(&receipt).ok_or_else(|| io::Error::other("invalid-output-ownership"))?;
    if workspace.job_id != job_id {
        return Err(io::Error::other("output-ownership-mismatch"));
    }
    if !workspace.path.exists() {
        return fs::remove_file(receipt);
    }
    workspace.validate()?;
    fn remove_contents(path: &Path) -> io::Result<()> {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            if entry.file_name() == ".owner.json" {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path())?;
            if is_reparse(&metadata) {
                return Err(io::Error::other("unverified-output-link"));
            }
            if metadata.is_dir() {
                remove_contents(&entry.path())?;
                fs::remove_dir(entry.path())?;
            } else {
                fs::remove_file(entry.path())?;
            }
        }
        Ok(())
    }
    remove_contents(&workspace.path)?;
    fs::remove_file(workspace.path.join(".owner.json"))?;
    if let Err(error) = fs::remove_dir(&workspace.path) {
        let _ = write_json_atomic(&workspace.path.join(".owner.json"), &workspace);
        return Err(error);
    }
    fs::remove_file(receipt)
}

pub fn remove_job_history_in(
    directory: &Path,
    job_ids: &[String],
) -> io::Result<RemoveJobHistoryResult> {
    // Validate the entire batch before making the first mutation.
    for job_id in job_ids {
        state_path_in(directory, job_id)?;
    }
    let mut result = RemoveJobHistoryResult::default();
    let mut seen = std::collections::HashSet::new();
    for job_id in job_ids {
        if !seen.insert(job_id) {
            continue;
        }
        let claim = match reserve_runner_claim_in(directory, job_id) {
            Ok(claim) => claim,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                result.skipped_ids.push(job_id.clone());
                continue;
            }
            Err(error) => return Err(error),
        };
        let path = state_path_in(directory, job_id)?;
        let state: Option<JobState> = read_json(&path);
        if !state.is_some_and(|state| {
            state.job_id == *job_id
                // Media and subtitle records both own only private job files
                // here; downloaded media and generated subtitle files stay.
                && (is_media_job(&state) || state.job_type.as_deref() == Some("subtitle"))
                && matches!(state.status.as_str(), "completed" | "failed" | "cancelled")
        }) || workspace_receipt(directory, job_id)?.exists()
        {
            result.skipped_ids.push(job_id.clone());
            continue;
        }
        // Output paths/receipts are never part of the private transaction.
        if !remove_history_artifacts_in(directory, job_id)? {
            result.skipped_ids.push(job_id.clone());
            continue;
        }
        drop(claim);
        result.removed_ids.push(job_id.clone());
    }
    Ok(result)
}

/// Live runners own the terminal transition. With no runner, reserve the same
/// claim used by retry/history deletion and re-read state before cancelling.
pub fn request_cancel_in(directory: &Path, job_id: &str, now: u64) -> io::Result<()> {
    let state_path = state_path_in(directory, job_id)?;
    let state: JobState = read_json(&state_path)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "job-state-missing"))?;
    if matches!(state.status.as_str(), "completed" | "failed" | "cancelled")
        && !workspace_receipt(directory, job_id)?.exists()
    {
        return Ok(());
    }
    write_bytes_atomic(&cancel_path_in(directory, job_id)?, b"cancel")?;
    if !is_media_job(&state) {
        return Ok(());
    }
    let _claim = match reserve_runner_claim_in(directory, job_id) {
        Ok(claim) => claim,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(error),
    };
    let mut state: JobState = read_json(&state_path)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "job-state-missing"))?;
    if matches!(state.status.as_str(), "completed" | "failed" | "cancelled")
        && !workspace_receipt(directory, job_id)?.exists()
    {
        return Ok(());
    }
    if let Err(error) = cleanup_download_workspace_in(directory, job_id) {
        state.status = "failed".into();
        state.status_text = "다운로드 임시 파일을 정리하지 못했습니다. 다시 취소해 주세요.".into();
        state.error = Some(format!("download-cleanup-failed: {error}"));
        persist_job_state_in(directory, &mut state, now)?;
        return Err(error);
    }
    state.status = "cancelled".into();
    state.status_text = "다운로드가 취소되었습니다.".into();
    state.error = None;
    for path in [
        pause_path_in(directory, job_id)?,
        cancel_path_in(directory, job_id)?,
    ] {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    if let Err(error) = persist_job_state_in(directory, &mut state, now) {
        let _ = write_bytes_atomic(&cancel_path_in(directory, job_id)?, b"cancel");
        return Err(error);
    }
    Ok(())
}

pub fn clear_cancel_marker_in(directory: &Path, job_id: &str) -> io::Result<()> {
    match fs::remove_file(cancel_path_in(directory, job_id)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

pub fn finish_download_output_in(
    directory: &Path,
    state: &mut JobState,
    workspace: &DownloadWorkspace,
    completed: bool,
    paused: bool,
) -> io::Result<()> {
    if paused {
        return Ok(());
    }
    if completed {
        let name = state
            .file_name
            .as_deref()
            .ok_or_else(|| io::Error::other("download-output-missing"))?;
        let target = workspace.publish(name)?;
        state.file_name = target
            .file_name()
            .map(|name| name.to_string_lossy().into_owned());
    } else {
        state.file_name = None;
    }
    cleanup_download_workspace_in(directory, &state.job_id)
        .map_err(|error| io::Error::other(format!("download-cleanup-failed: {error}")))
}

pub fn clear_terminal_history_in(directory: &Path) -> io::Result<usize> {
    if !directory.is_dir() {
        return Ok(0);
    }
    let mut terminal = Vec::new();
    for state in list_job_states_in(directory)? {
        if matches!(
            state.status.to_ascii_lowercase().as_str(),
            "completed" | "failed" | "cancelled"
        ) && !runner_claim_path_in(directory, &state.job_id)?.exists()
        {
            terminal.push(state.job_id);
        }
    }

    let mut removed = 0;
    for job_id in &terminal {
        let _claim = match reserve_runner_claim_in(directory, job_id) {
            Ok(claim) => claim,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        if !read_json::<JobState>(&state_path_in(directory, job_id)?).is_some_and(|state| {
            matches!(state.status.as_str(), "completed" | "failed" | "cancelled")
        }) || workspace_receipt(directory, job_id)?.exists()
        {
            continue;
        }
        if !remove_history_artifacts_in(directory, job_id)? {
            continue;
        }
        removed += 1;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::env;

    fn test_directory() -> PathBuf {
        let directory = env::temp_dir().join(format!(
            "segma-job-store-test-{}-{}",
            std::process::id(),
            NEXT_ATOMIC_FILE_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&directory).expect("directory creates");
        directory
    }

    fn lifecycle_state(directory: &Path, id: &str, kind: &str, status: &str) -> JobState {
        let state = JobState {
            job_id: id.into(),
            job_type: Some(kind.into()),
            status: status.into(),
            file_name: Some("previously-completed.mp4".into()),
            ..JobState::default()
        };
        write_json_atomic(&state_path_in(directory, id).unwrap(), &state).unwrap();
        state
    }

    #[test]
    fn no_runner_cancel_is_authoritative_and_terminal_outputs_are_untouched() {
        let directory = test_directory();
        let output = directory.join("previously-completed.mp4");
        fs::write(&output, b"completed output").unwrap();
        for status in ["paused", "queued", "running"] {
            lifecycle_state(&directory, status, "media", status);
            fs::write(pause_path_in(&directory, status).unwrap(), b"pause").unwrap();
            request_cancel_in(&directory, status, 42).unwrap();
            let state: JobState = read_json(&state_path_in(&directory, status).unwrap()).unwrap();
            assert_eq!(state.status, "cancelled");
            assert_eq!(state.updated_at, 42);
            assert_eq!(state.error, None);
            assert!(!pause_path_in(&directory, status).unwrap().exists());
            assert!(!cancel_path_in(&directory, status).unwrap().exists());
            assert!(!runner_claim_path_in(&directory, status).unwrap().exists());
        }
        for status in ["completed", "failed", "cancelled"] {
            lifecycle_state(&directory, status, "media", status);
            request_cancel_in(&directory, status, 99).unwrap();
            assert_eq!(
                read_json::<JobState>(&state_path_in(&directory, status).unwrap())
                    .unwrap()
                    .status,
                status
            );
        }
        assert_eq!(fs::read(&output).unwrap(), b"completed output");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn legacy_untyped_youtube_records_cancel_and_remove_like_media() {
        // Records written before `jobType` existed are YouTube downloads.
        let directory = test_directory();
        let write = |id: &str, status: &str| {
            let mut value = serde_json::to_value(JobState {
                job_id: id.into(),
                status: status.into(),
                ..JobState::default()
            })
            .unwrap();
            value.as_object_mut().unwrap().remove("jobType");
            write_json_atomic(&state_path_in(&directory, id).unwrap(), &value).unwrap();
        };
        write("legacy-paused", "paused");
        write("legacy-completed", "completed");
        assert!(
            read_json::<JobState>(&state_path_in(&directory, "legacy-paused").unwrap())
                .unwrap()
                .job_type
                .is_none()
        );
        request_cancel_in(&directory, "legacy-paused", 50).unwrap();
        assert_eq!(
            read_json::<JobState>(&state_path_in(&directory, "legacy-paused").unwrap())
                .unwrap()
                .status,
            "cancelled"
        );
        let result = remove_job_history_in(
            &directory,
            &["legacy-paused".into(), "legacy-completed".into()],
        )
        .unwrap();
        assert_eq!(result.removed_ids, ["legacy-paused", "legacy-completed"]);
        assert!(result.skipped_ids.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn cancellation_with_runner_waits_for_runner_terminal_transition() {
        let directory = test_directory();
        lifecycle_state(&directory, "live", "media", "running");
        let claim = reserve_runner_claim_in(&directory, "live").unwrap();
        request_cancel_in(&directory, "live", 42).unwrap();
        assert_eq!(
            read_json::<JobState>(&state_path_in(&directory, "live").unwrap())
                .unwrap()
                .status,
            "running"
        );
        assert!(cancel_path_in(&directory, "live").unwrap().is_file());
        assert!(runner_claim_path_in(&directory, "live").unwrap().is_file());
        drop(claim);
        request_cancel_in(&directory, "live", 43).unwrap();
        assert_eq!(
            read_json::<JobState>(&state_path_in(&directory, "live").unwrap())
                .unwrap()
                .status,
            "cancelled"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn selected_history_removal_preserves_outputs_and_protects_other_jobs() {
        let directory = test_directory();
        let output = directory.join("previously-completed.mp4");
        fs::write(&output, b"user output").unwrap();
        let cases = [
            ("completed", "media", "completed"),
            ("failed", "media", "failed"),
            ("cancelled", "media", "cancelled"),
            ("running", "media", "running"),
            ("queued", "media", "queued"),
            ("paused", "media", "paused"),
            ("subtitle", "subtitle", "completed"),
            ("subtitle-running", "subtitle", "running"),
            ("live", "media", "completed"),
        ];
        for (id, kind, status) in cases {
            lifecycle_state(&directory, id, kind, status);
            for path in [
                request_path_in(&directory, id).unwrap(),
                cancel_path_in(&directory, id).unwrap(),
                pause_path_in(&directory, id).unwrap(),
                subtitle_request_path_in(&directory, id).unwrap(),
            ] {
                fs::write(path, b"private retained data").unwrap();
            }
        }
        let claim = reserve_runner_claim_in(&directory, "live").unwrap();
        let mut ids: Vec<String> = cases.iter().map(|(id, _, _)| id.to_string()).collect();
        ids.extend(["missing".into(), "completed".into()]);
        let result = remove_job_history_in(&directory, &ids).unwrap();
        assert_eq!(
            result.removed_ids,
            ["completed", "failed", "cancelled", "subtitle"]
        );
        assert_eq!(
            result.skipped_ids,
            [
                "running",
                "queued",
                "paused",
                "subtitle-running",
                "live",
                "missing"
            ]
        );
        for id in &result.removed_ids {
            for path in [
                state_path_in(&directory, id).unwrap(),
                request_path_in(&directory, id).unwrap(),
                cancel_path_in(&directory, id).unwrap(),
                pause_path_in(&directory, id).unwrap(),
                subtitle_request_path_in(&directory, id).unwrap(),
                runner_claim_path_in(&directory, id).unwrap(),
            ] {
                assert!(
                    !path.exists(),
                    "removed private artifact {}",
                    path.display()
                );
            }
        }
        for id in &result.skipped_ids[..5] {
            assert!(state_path_in(&directory, id).unwrap().is_file());
            assert!(request_path_in(&directory, id).unwrap().is_file());
        }
        assert_eq!(fs::read(output).unwrap(), b"user output");
        drop(claim);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn history_invalid_batch_is_rejected_before_deleting_valid_rows() {
        let directory = test_directory();
        lifecycle_state(&directory, "done", "media", "completed");
        assert!(remove_job_history_in(&directory, &["done".into(), "../escape".into()]).is_err());
        assert!(state_path_in(&directory, "done").unwrap().is_file());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn owned_workspace_resumes_only_its_files_and_publishes_without_overwrite() {
        let root = test_directory();
        let jobs = root.join("jobs");
        let downloads = root.join("downloads");
        fs::create_dir_all(&jobs).unwrap();
        fs::create_dir_all(&downloads).unwrap();
        let prior = downloads.join("finished.mp4");
        fs::write(&prior, b"prior completed output").unwrap();
        let workspace = DownloadWorkspace::prepare(&jobs, &downloads, "job").unwrap();
        fs::write(workspace.path.join("owned.part"), b"resume bytes").unwrap();
        let resumed = DownloadWorkspace::prepare(&jobs, &downloads, "job").unwrap();
        assert_eq!(workspace, resumed);
        assert_eq!(
            fs::read(resumed.path.join("owned.part")).unwrap(),
            b"resume bytes"
        );
        fs::write(workspace.path.join("finished.mp4"), b"new completed output").unwrap();
        let output = workspace.publish("finished.mp4").unwrap();
        assert_ne!(output, prior);
        assert_eq!(fs::read(&prior).unwrap(), b"prior completed output");
        assert_eq!(fs::read(&output).unwrap(), b"new completed output");
        cleanup_download_workspace_in(&jobs, "job").unwrap();
        assert!(!workspace.path.exists());
        assert_eq!(fs::read(output).unwrap(), b"new completed output");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn locked_owned_partial_reports_failed_cleanup_then_cancellation_can_retry() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = test_directory();
        let jobs = root.join("jobs");
        let downloads = root.join("downloads");
        fs::create_dir_all(&jobs).unwrap();
        lifecycle_state(&jobs, "paused", "media", "paused");
        let workspace = DownloadWorkspace::prepare(&jobs, &downloads, "paused").unwrap();
        let partial = workspace.path.join("owned.part");
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .share_mode(0)
            .open(&partial)
            .unwrap();
        assert!(request_cancel_in(&jobs, "paused", 42).is_err());
        let state: JobState = read_json(&state_path_in(&jobs, "paused").unwrap()).unwrap();
        assert_eq!(state.status, "failed");
        assert!(state.error.unwrap().starts_with("download-cleanup-failed:"));
        assert!(workspace.path.exists());
        assert!(workspace_receipt(&jobs, "paused").unwrap().is_file());
        assert_eq!(
            remove_job_history_in(&jobs, &["paused".into()])
                .unwrap()
                .skipped_ids,
            ["paused"]
        );
        assert!(state_path_in(&jobs, "paused").unwrap().is_file());
        drop(file);
        request_cancel_in(&jobs, "paused", 43).unwrap();
        assert_eq!(
            read_json::<JobState>(&state_path_in(&jobs, "paused").unwrap())
                .unwrap()
                .status,
            "cancelled"
        );
        assert!(!workspace.path.exists());
        assert!(!workspace_receipt(&jobs, "paused").unwrap().exists());
        fs::remove_dir_all(root).unwrap();
    }

    /// Cancelling yt-dlp: the process tree is gone but Windows releases the
    /// fragment handle a moment later. Cleanup must wait it out, not fail.
    #[cfg(windows)]
    #[test]
    fn cancel_cleanup_outlasts_a_briefly_held_partial() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = test_directory();
        let jobs = root.join("jobs");
        let downloads = root.join("downloads");
        fs::create_dir_all(&jobs).unwrap();
        lifecycle_state(&jobs, "brief", "media", "paused");
        let workspace = DownloadWorkspace::prepare(&jobs, &downloads, "brief").unwrap();
        let partial = workspace.path.join("video.mp4.part-Frag26.part");
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .share_mode(0)
            .open(&partial)
            .unwrap();
        let holder = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(600));
            drop(file);
        });
        request_cancel_in(&jobs, "brief", 42).unwrap();
        holder.join().unwrap();
        assert_eq!(
            read_json::<JobState>(&state_path_in(&jobs, "brief").unwrap())
                .unwrap()
                .status,
            "cancelled"
        );
        assert!(!workspace.path.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn atomic_state_replacement_recovers_transient_access_denied() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = test_directory();
        let target = directory.join("job.state.json");
        let incoming = directory.join("incoming.json");
        fs::write(&target, b"prior state").unwrap();
        fs::write(&incoming, b"next state").unwrap();
        let lock = OpenOptions::new()
            .read(true)
            .share_mode(3)
            .open(&target)
            .unwrap();
        let from: Vec<_> = incoming.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<_> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        let moved = unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(from.as_ptr(), to.as_ptr(), 3)
        };
        assert_eq!(
            moved, 0,
            "old single-attempt replacement must reproduce failure"
        );
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(5));
        let destination = target.clone();
        let writer =
            std::thread::spawn(move || write_bytes_atomic(&destination, b"recovered state"));
        std::thread::sleep(std::time::Duration::from_millis(120));
        assert_eq!(fs::read(&target).unwrap(), b"prior state");
        drop(lock);
        writer.join().unwrap().unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"recovered state");
        println!("STATE_REPLACE_FIXTURE old_single_attempt_os_error=5 transient_retry=success");
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn persistent_state_replace_lock_preserves_old_state_and_reports_error() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = test_directory();
        let target = directory.join("job.state.json");
        write_json_atomic(&target, &json!({"status":"running","completed":7})).unwrap();
        let lock = OpenOptions::new()
            .read(true)
            .share_mode(3)
            .open(&target)
            .unwrap();
        let started = std::time::Instant::now();
        let error =
            write_json_atomic(&target, &json!({"status":"completed","completed":100})).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(5));
        assert!(started.elapsed() >= std::time::Duration::from_millis(1800));
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        assert_eq!(
            read_json::<Value>(&target).unwrap(),
            json!({"status":"running","completed":7})
        );
        assert!(fs::read_dir(&directory).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
        println!("STATE_REPLACE_FIXTURE persistent_lock=os_error_5 prior_state=preserved temporary_files=0");
        drop(lock);
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn history_marker_lock_rolls_back_request_and_other_jobs_still_remove() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = test_directory();
        for id in ["blocked", "good"] {
            lifecycle_state(&directory, id, "media", "failed");
        }
        let request = request_path_in(&directory, "blocked").unwrap();
        fs::write(&request, b"retained retry request").unwrap();
        let marker = cancel_path_in(&directory, "blocked").unwrap();
        fs::write(&marker, b"cancel").unwrap();
        let lock = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&marker)
            .unwrap();
        let result = remove_job_history_in(&directory, &["blocked".into(), "good".into()]).unwrap();
        assert_eq!(result.skipped_ids, ["blocked"]);
        assert_eq!(result.removed_ids, ["good"]);
        assert_eq!(fs::read(&request).unwrap(), b"retained retry request");
        assert!(state_path_in(&directory, "blocked").unwrap().is_file());
        drop(lock);
        assert_eq!(
            remove_job_history_in(&directory, &["blocked".into()])
                .unwrap()
                .removed_ids,
            ["blocked"]
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn history_preserves_unverifiable_runner_ownership() {
        let directory = test_directory();
        lifecycle_state(&directory, "unknown-owner", "media", "failed");
        fs::write(
            runner_claim_path_in(&directory, "unknown-owner").unwrap(),
            b"invalid owner record",
        )
        .unwrap();
        let result = remove_job_history_in(&directory, &["unknown-owner".into()]).unwrap();
        assert!(result.removed_ids.is_empty());
        assert_eq!(result.skipped_ids, ["unknown-owner"]);
        assert!(state_path_in(&directory, "unknown-owner")
            .unwrap()
            .is_file());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn concurrent_stale_claim_recovery_has_exactly_one_owner() {
        let directory = test_directory();
        write_json_atomic(
            &runner_claim_path_in(&directory, "race").unwrap(),
            &RunnerClaimRecord {
                token: "dead-token".into(),
                pid: 4242,
                updated_at: 1,
            },
        )
        .unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let directory = directory.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    reserve_runner_claim_in_with(
                        &directory,
                        "race",
                        RUNNER_CLAIM_HANDOFF_MS + 2,
                        |_, _| false,
                    )
                })
            })
            .collect();
        let results: Vec<_> = threads
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert!(results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .all(|error| error.kind() == io::ErrorKind::AlreadyExists));
        drop(results);
        assert!(!runner_claim_path_in(&directory, "race").unwrap().exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn private_cleanup_failure_never_reports_removed_or_cancelled() {
        let directory = test_directory();
        lifecycle_state(&directory, "done", "media", "completed");
        // A directory where a private request/marker is expected simulates an
        // undeletable entry without touching permissions or any user files.
        fs::create_dir(request_path_in(&directory, "done").unwrap()).unwrap();
        assert_eq!(
            remove_job_history_in(&directory, &["done".into()])
                .unwrap()
                .skipped_ids,
            ["done"]
        );
        assert!(state_path_in(&directory, "done").unwrap().is_file());
        lifecycle_state(&directory, "paused", "media", "paused");
        fs::create_dir(pause_path_in(&directory, "paused").unwrap()).unwrap();
        assert!(request_cancel_in(&directory, "paused", 42).is_err());
        assert_eq!(
            read_json::<JobState>(&state_path_in(&directory, "paused").unwrap())
                .unwrap()
                .status,
            "paused"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn shared_disk_abi_fixture_matches_all_paths() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../test-fixtures/companion/disk-abi-v1.json"
        ))
        .expect("fixture parses");
        let directory = test_directory();
        let job_id = fixture["jobId"].as_str().expect("job id exists");
        for (key, path) in [
            ("request", request_path_in(&directory, job_id).unwrap()),
            ("state", state_path_in(&directory, job_id).unwrap()),
            ("cancel", cancel_path_in(&directory, job_id).unwrap()),
            ("pause", pause_path_in(&directory, job_id).unwrap()),
            (
                "subtitleRequest",
                subtitle_request_path_in(&directory, job_id).unwrap(),
            ),
        ] {
            assert_eq!(
                path.file_name().and_then(|value| value.to_str()),
                fixture[key].as_str()
            );
        }
        assert_eq!(
            settings_path(&directory)
                .file_name()
                .and_then(|value| value.to_str()),
            fixture["settings"].as_str()
        );
        fs::remove_dir_all(directory).expect("directory removes");
    }

    #[test]
    fn atomic_json_round_trips() {
        let directory = test_directory();
        let path = directory.join("state.json");
        write_json_atomic(&path, &json!({ "ok": true })).expect("JSON writes");
        assert_eq!(read_json::<Value>(&path), Some(json!({ "ok": true })));
        fs::remove_dir_all(directory).expect("directory removes");
    }

    #[test]
    fn host_and_manager_share_the_same_job_state_type_contract() {
        let current: JobState = serde_json::from_str(include_str!(
            "../../test-fixtures/companion/job-state-v1.json"
        ))
        .expect("current state fixture loads");
        let legacy: JobState = serde_json::from_str(include_str!(
            "../../test-fixtures/companion/job-state-legacy-v1.json"
        ))
        .expect("legacy state fixture loads");
        assert_eq!(current.execution_status.as_deref(), Some("running"));
        assert_eq!(legacy.created_at, 0);
    }

    #[test]
    fn unsafe_ids_and_folders_fail_closed() {
        let directory = test_directory();
        for id in ["", "../escape", "a/b", "a\\b"] {
            assert!(state_path_in(&directory, id).is_err());
        }
        assert!(valid_download_folder("relative\\path").is_none());
        assert!(valid_download_folder("C:\\Media\\..\\Windows").is_none());
        fs::remove_dir_all(directory).expect("directory removes");
    }

    #[test]
    fn runner_reservation_is_single_flight_and_can_be_reacquired_after_drop() {
        let directory = test_directory();
        let first = reserve_runner_claim_in(&directory, "job-one").expect("first claim reserves");
        let error = reserve_runner_claim_in(&directory, "job-one")
            .err()
            .expect("second claim rejects");
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(error.to_string(), "job-already-running");
        drop(first);
        let second = reserve_runner_claim_in(&directory, "job-one").expect("claim reacquires");
        drop(second);
        fs::remove_dir_all(directory).expect("directory removes");
    }

    #[test]
    fn direct_runner_acquisition_records_live_owner_beyond_handoff() {
        let directory = test_directory();
        let claim = acquire_runner_claim_in(&directory, "direct").unwrap();
        let record =
            read_runner_claim(&runner_claim_path_in(&directory, "direct").unwrap()).unwrap();
        assert_eq!(record.pid, std::process::id());
        assert!(runner_claim_is_active_in(
            &directory,
            "direct",
            record.updated_at + RUNNER_CLAIM_HANDOFF_MS + 1
        )
        .unwrap());
        assert!(reserve_runner_claim_in_with(
            &directory,
            "direct",
            record.updated_at + RUNNER_CLAIM_HANDOFF_MS + 1,
            process_owns_claim
        )
        .is_err());
        drop(claim);
        assert!(!runner_claim_path_in(&directory, "direct").unwrap().exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn child_adopts_only_the_reserved_runner_token() {
        let directory = test_directory();
        let reservation = reserve_runner_claim_in(&directory, "job-one").expect("claim reserves");
        let token = reservation.token().to_string();
        reservation.handoff();

        let mismatch = adopt_runner_claim_in(&directory, "job-one", "wrong-token")
            .err()
            .expect("wrong token rejects");
        assert_eq!(mismatch.kind(), io::ErrorKind::PermissionDenied);
        assert!(runner_claim_path_in(&directory, "job-one")
            .unwrap()
            .is_file());

        let adopted = adopt_runner_claim_in(&directory, "job-one", &token).expect("token adopts");
        drop(adopted);
        assert!(!runner_claim_path_in(&directory, "job-one")
            .unwrap()
            .exists());
        fs::remove_dir_all(directory).expect("directory removes");
    }

    #[test]
    fn expired_dead_owner_claim_is_recovered_but_live_owner_is_preserved() {
        let directory = test_directory();
        let old = RunnerClaimRecord {
            token: "dead-token".into(),
            pid: 4242,
            updated_at: 1,
        };
        write_json_atomic(&runner_claim_path_in(&directory, "job-dead").unwrap(), &old).unwrap();
        let recovered = reserve_runner_claim_in_with(
            &directory,
            "job-dead",
            RUNNER_CLAIM_HANDOFF_MS + 2,
            |_, _| false,
        )
        .expect("dead owner claim recovers");
        drop(recovered);

        write_json_atomic(&runner_claim_path_in(&directory, "job-live").unwrap(), &old).unwrap();
        let error = reserve_runner_claim_in_with(
            &directory,
            "job-live",
            RUNNER_CLAIM_HANDOFF_MS + 2,
            |_, _| true,
        )
        .err()
        .expect("live owner claim remains reserved");
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        fs::remove_dir_all(directory).expect("directory removes");
    }

    #[test]
    fn terminal_history_removes_all_artifacts_but_preserves_active_and_claimed_jobs() {
        let directory = test_directory();
        for (job_id, status) in [
            ("done", "completed"),
            ("failed", "failed"),
            ("cancelled", "cancelled"),
            ("active", "running"),
            ("claimed", "failed"),
        ] {
            let state = JobState {
                job_id: job_id.into(),
                status: status.into(),
                updated_at: 1,
                ..JobState::default()
            };
            write_json_atomic(&state_path_in(&directory, job_id).unwrap(), &state).unwrap();
            for path in [
                request_path_in(&directory, job_id).unwrap(),
                cancel_path_in(&directory, job_id).unwrap(),
                pause_path_in(&directory, job_id).unwrap(),
                subtitle_request_path_in(&directory, job_id).unwrap(),
            ] {
                fs::write(path, b"artifact").expect("artifact writes");
            }
        }
        let claimed = reserve_runner_claim_in(&directory, "claimed").expect("claim reserves");

        assert_eq!(
            clear_terminal_history_in(&directory).expect("history clears"),
            3
        );
        for job_id in ["done", "failed", "cancelled"] {
            for path in [
                state_path_in(&directory, job_id).unwrap(),
                request_path_in(&directory, job_id).unwrap(),
                cancel_path_in(&directory, job_id).unwrap(),
                pause_path_in(&directory, job_id).unwrap(),
                subtitle_request_path_in(&directory, job_id).unwrap(),
            ] {
                assert!(!path.exists(), "{} should be removed", path.display());
            }
        }
        for job_id in ["active", "claimed"] {
            assert!(state_path_in(&directory, job_id).unwrap().is_file());
            assert!(request_path_in(&directory, job_id).unwrap().is_file());
        }
        drop(claimed);
        fs::remove_dir_all(directory).expect("directory removes");
    }
}
