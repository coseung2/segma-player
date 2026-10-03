use super::dto::CommandError;
use aura_companion_contract::{self as contract, cloud};
use cloud::{CloudJobRequest, CloudJobState, CloudOperation, CloudProvider};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const CLOUD_EXECUTABLE: &str = if cfg!(target_os = "windows") {
    "aura-media-cloud.exe"
} else {
    "aura-media-cloud"
};
const MAX_CATALOG_BYTES: u64 = 1024 * 1024;
const MAX_TELEGRAM_CONFIG_BYTES: usize = 256;
#[cfg(target_os = "windows")]
const DETACHED_PROCESS: u32 = 0x0000_0008;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatusDto {
    pub schema_version: u32,
    pub capability: String,
    pub executable_available: bool,
    pub telegram_configured: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudItemDto {
    pub item_id: String,
    pub provider: String,
    pub file_name: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudJobDto {
    pub job_id: String,
    pub provider: String,
    pub operation: String,
    pub item_id: String,
    pub status: String,
    pub phase: Option<String>,
    pub completed: Option<u64>,
    pub total: Option<u64>,
    pub progress: Option<u8>,
    pub file_name: Option<String>,
    pub error: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudUploadSelectionDto {
    pub local_path: String,
    pub file_name: String,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDownloadDestinationRequest {
    pub file_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCloudUploadRequest {
    pub local_path: String,
    pub folder_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCloudDownloadRequest {
    pub item_id: String,
    pub local_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCloudDeleteRequest {
    pub item_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelCloudJobRequest {
    pub job_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureTelegramRequest {
    token: String,
    channel_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TelegramCatalogSummary {
    schema_version: u32,
    item_id: String,
    file_name: String,
    size: u64,
    committed: bool,
}

#[derive(Deserialize)]
struct CloudAgentStatus {
    protocol: u32,
    capabilities: Vec<String>,
    providers: CloudAgentProviders,
}

#[derive(Deserialize)]
struct CloudAgentProviders {
    telegram: bool,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn generated_id(prefix: &str) -> String {
    format!(
        "{prefix}-{:x}-{:x}-{:x}",
        std::process::id(),
        now_millis(),
        NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn provider_name(provider: CloudProvider) -> String {
    match provider {
        CloudProvider::Mock => "mock",
        CloudProvider::Telegram => "telegram",
    }
    .into()
}

fn operation_name(operation: CloudOperation) -> String {
    match operation {
        CloudOperation::Upload => "upload",
        CloudOperation::Download => "download",
        CloudOperation::Delete => "delete",
    }
    .into()
}

impl From<CloudJobState> for CloudJobDto {
    fn from(state: CloudJobState) -> Self {
        Self {
            job_id: state.job_id,
            provider: provider_name(state.provider),
            operation: operation_name(state.operation),
            item_id: state.item_id,
            status: state.status,
            phase: state.phase,
            completed: state.completed,
            total: state.total,
            progress: state.progress,
            file_name: state.file_name,
            error: state
                .error
                .map(|_| "Cloud operation failed. Check the job and try again.".into()),
            created_at: state.created_at,
            updated_at: state.updated_at,
        }
    }
}

fn valid_file_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && !value.chars().any(char::is_control)
        && Path::new(value).file_name().and_then(|name| name.to_str()) == Some(value)
        && value != "."
        && value != ".."
}

fn executable_candidates(current_exe: &Path, manifest_dir: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(directory) = current_exe.parent() {
        candidates.push(directory.join(CLOUD_EXECUTABLE));
    }
    // This compile-time source-tree fallback is intentionally bounded to the
    // adjacent cloud-agent crate and is useful only for local development.
    if let Some(repository_root) = manifest_dir.ancestors().nth(2) {
        candidates.push(
            repository_root
                .join("cloud-agent")
                .join("target")
                .join("debug")
                .join(CLOUD_EXECUTABLE),
        );
        candidates.push(
            repository_root
                .join("cloud-agent")
                .join("target")
                .join("release")
                .join(CLOUD_EXECUTABLE),
        );
    }
    candidates.dedup();
    candidates
}

fn resolve_cloud_executable_from(current_exe: &Path, manifest_dir: &Path) -> Option<PathBuf> {
    executable_candidates(current_exe, manifest_dir)
        .into_iter()
        .find(|candidate| candidate.is_file())
}

fn resolve_cloud_executable() -> Result<PathBuf, CommandError> {
    let current_exe = std::env::current_exe().map_err(|_| {
        CommandError::new(
            "cloud-agent-unavailable",
            "Cloud storage component could not be located.",
        )
    })?;
    resolve_cloud_executable_from(&current_exe, Path::new(env!("CARGO_MANIFEST_DIR"))).ok_or_else(
        || {
            CommandError::new(
                "cloud-agent-unavailable",
                "Cloud storage component is not installed.",
            )
        },
    )
}

fn valid_telegram_token(value: &str) -> bool {
    let Some((bot_id, secret)) = value.split_once(':') else {
        return false;
    };
    value.len() >= 12
        && value.len() <= 256
        && !bot_id.is_empty()
        && bot_id.bytes().all(|byte| byte.is_ascii_digit())
        && !secret.is_empty()
        && secret
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn valid_telegram_channel_id(value: &str) -> bool {
    let digits = value.strip_prefix('-').unwrap_or(value);
    !digits.is_empty()
        && value.len() <= 24
        && digits.bytes().all(|byte| byte.is_ascii_digit())
        && digits.bytes().any(|byte| byte != b'0')
}

fn telegram_config_payload(request: ConfigureTelegramRequest) -> Result<Vec<u8>, CommandError> {
    if request.token.trim() != request.token
        || request.channel_id.trim() != request.channel_id
        || !valid_telegram_token(&request.token)
        || !valid_telegram_channel_id(&request.channel_id)
    {
        return Err(CommandError::invalid_request(
            "봇 토큰과 저장소 채팅 ID를 확인해 주세요.",
        ));
    }
    let payload = serde_json::to_vec(&serde_json::json!({
        "token": request.token,
        "channelId": request.channel_id,
    }))
    .map_err(|_| CommandError::invalid_request("텔레그램 설정을 확인해 주세요."))?;
    if payload.len() > MAX_TELEGRAM_CONFIG_BYTES {
        return Err(CommandError::invalid_request(
            "텔레그램 설정 입력이 너무 깁니다.",
        ));
    }
    Ok(payload)
}

fn configure_telegram_with(
    executable: &Path,
    request: ConfigureTelegramRequest,
) -> Result<(), CommandError> {
    let payload = telegram_config_payload(request)?;
    let mut command = Command::new(executable);
    command
        .arg("--configure-telegram")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command.spawn().map_err(|_| {
        CommandError::new(
            "telegram-configuration-failed",
            "텔레그램 저장소 설정을 저장하지 못했습니다.",
        )
    })?;
    let written = child
        .stdin
        .take()
        .is_some_and(|mut stdin| stdin.write_all(&payload).is_ok());
    let succeeded = written && child.wait().is_ok_and(|status| status.success());
    if !succeeded {
        let _ = child.kill();
        let _ = child.wait();
        return Err(CommandError::new(
            "telegram-configuration-failed",
            "텔레그램 저장소 설정을 저장하지 못했습니다.",
        ));
    }
    Ok(())
}

fn installer_candidates(application_dir: &Path) -> Vec<PathBuf> {
    let mut candidates = fs::read_dir(application_dir)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    let name = name.to_ascii_lowercase();
                    name.starts_with("aura-media-companion-") && name.ends_with("-win-x64.exe")
                })
        })
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.reverse();
    candidates
}

fn is_companion_installer(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            let name = name.to_ascii_lowercase();
            name.starts_with("aura-media-companion-") && name.ends_with("-win-x64.exe")
        })
}

fn run_local_installer(installer: &Path) -> Result<(), CommandError> {
    let mut command = Command::new(installer);
    command
        .args([
            "/VERYSILENT",
            "/SUPPRESSMSGBOXES",
            "/NORESTART",
            "/CURRENTUSER",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    if command.status().is_ok_and(|status| status.success()) {
        Ok(())
    } else {
        Err(CommandError::new(
            "cloud-component-install-failed",
            "클라우드 구성 요소를 복구하지 못했습니다.",
        ))
    }
}

fn install_cloud_binary(source: &Path, destination: &Path) -> Result<(), CommandError> {
    if read_cloud_agent_status(source).is_none() {
        return Err(CommandError::invalid_request(
            "호환되는 클라우드 구성 요소 파일을 선택해 주세요.",
        ));
    }
    if source != destination {
        fs::copy(source, destination).map_err(|_| {
            CommandError::new(
                "cloud-component-install-failed",
                "클라우드 구성 요소를 복구하지 못했습니다.",
            )
        })?;
    }
    Ok(())
}

fn install_cloud_component_from(source: &Path, application_dir: &Path) -> Result<(), CommandError> {
    let destination = application_dir.join(CLOUD_EXECUTABLE);
    let is_cloud_binary = source
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case(CLOUD_EXECUTABLE));
    if is_cloud_binary {
        install_cloud_binary(source, &destination)?;
    } else if is_companion_installer(source) {
        run_local_installer(source)?;
    } else {
        return Err(CommandError::invalid_request(
            "클라우드 구성 요소 또는 Companion 설치 파일을 선택해 주세요.",
        ));
    }
    if read_cloud_agent_status(&destination).is_none() {
        return Err(CommandError::new(
            "cloud-component-install-failed",
            "클라우드 구성 요소를 복구하지 못했습니다.",
        ));
    }
    Ok(())
}

fn read_cloud_agent_status(executable: &Path) -> Option<CloudAgentStatus> {
    let mut command = Command::new(executable);
    command.arg("--status").stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().ok()?;
    if !output.status.success() || output.stdout.len() > 64 * 1024 {
        return None;
    }
    let status: CloudAgentStatus = serde_json::from_slice(&output.stdout).ok()?;
    (status.protocol == cloud::CLOUD_JOB_SCHEMA_VERSION
        && status
            .capabilities
            .iter()
            .any(|value| value == cloud::CLOUD_JOB_CAPABILITY))
    .then_some(status)
}

fn read_catalog_item(path: &Path) -> Option<CloudItemDto> {
    if fs::metadata(path).ok()?.len() > MAX_CATALOG_BYTES {
        return None;
    }
    let catalog: TelegramCatalogSummary = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let path_item_id = path.file_stem()?.to_str()?;
    if catalog.schema_version != 1
        || !catalog.committed
        || contract::safe_id(&catalog.item_id).is_none()
        || catalog.item_id != path_item_id
        || !valid_file_name(&catalog.file_name)
    {
        return None;
    }
    Some(CloudItemDto {
        item_id: catalog.item_id,
        provider: "telegram".into(),
        file_name: catalog.file_name,
        size: catalog.size,
    })
}

fn list_cloud_items_in(root: &Path) -> std::io::Result<Vec<CloudItemDto>> {
    let directory = root.join("cloud-telegram").join("items");
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut items = fs::read_dir(directory)?
        .filter_map(Result::ok)
        .filter_map(|entry| read_catalog_item(&entry.path()))
        .collect::<Vec<_>>();
    items.sort_by(|left, right| left.file_name.cmp(&right.file_name));
    Ok(items)
}

fn build_upload_request(input: StartCloudUploadRequest) -> Result<CloudJobRequest, CommandError> {
    let path = contract::valid_download_folder(&input.local_path)
        .filter(|path| path.is_file())
        .ok_or_else(|| CommandError::invalid_request("Select a valid file to upload."))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| valid_file_name(value))
        .ok_or_else(|| CommandError::invalid_request("The upload file name is invalid."))?;
    let request = CloudJobRequest {
        schema_version: cloud::CLOUD_JOB_SCHEMA_VERSION,
        job_id: generated_id("cloud"),
        provider: CloudProvider::Telegram,
        operation: CloudOperation::Upload,
        item_id: generated_id("item"),
        folder_id: input.folder_id,
        local_path: Some(path.to_string_lossy().into_owned()),
        file_name: Some(file_name.into()),
        created_at: now_millis(),
    };
    cloud::validate_cloud_job_request(&request).map_err(CommandError::from_io)?;
    Ok(request)
}

fn build_download_request(
    input: StartCloudDownloadRequest,
) -> Result<CloudJobRequest, CommandError> {
    let item_id = contract::safe_id(&input.item_id)
        .ok_or_else(|| CommandError::invalid_request("The cloud item is invalid."))?;
    let request = CloudJobRequest {
        schema_version: cloud::CLOUD_JOB_SCHEMA_VERSION,
        job_id: generated_id("cloud"),
        provider: CloudProvider::Telegram,
        operation: CloudOperation::Download,
        item_id,
        local_path: Some(input.local_path),
        created_at: now_millis(),
        ..CloudJobRequest::default()
    };
    cloud::validate_cloud_job_request(&request).map_err(CommandError::from_io)?;
    Ok(request)
}

fn build_delete_request(input: StartCloudDeleteRequest) -> Result<CloudJobRequest, CommandError> {
    let item_id = contract::safe_id(&input.item_id)
        .ok_or_else(|| CommandError::invalid_request("The cloud item is invalid."))?;
    let request = CloudJobRequest {
        schema_version: cloud::CLOUD_JOB_SCHEMA_VERSION,
        job_id: generated_id("cloud"),
        provider: CloudProvider::Telegram,
        operation: CloudOperation::Delete,
        item_id,
        created_at: now_millis(),
        ..CloudJobRequest::default()
    };
    cloud::validate_cloud_job_request(&request).map_err(CommandError::from_io)?;
    Ok(request)
}

fn spawn_cloud_job_in(
    directory: &Path,
    executable: &Path,
    request: &CloudJobRequest,
) -> Result<CloudJobDto, CommandError> {
    let claim = cloud::reserve_cloud_runner_claim_in(directory, &request.job_id)
        .map_err(CommandError::from_io)?;
    let request_path =
        cloud::write_cloud_request_in(directory, request).map_err(CommandError::from_io)?;
    let state = CloudJobState::queued(request, now_millis());
    if let Err(error) = cloud::write_cloud_state_in(directory, &state) {
        let _ = fs::remove_file(request_path);
        return Err(CommandError::from_io(error));
    }

    let mut command = Command::new(executable);
    command
        .arg("--run-job")
        .arg(&request.job_id)
        .arg("--claim-token")
        .arg(claim.token())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);

    if command.spawn().is_err() {
        let mut failed = state;
        failed.status = "failed".into();
        failed.phase = Some("launch-failed".into());
        failed.error = Some("Cloud storage component could not be started.".into());
        failed.updated_at = now_millis();
        let _ = cloud::write_cloud_state_in(directory, &failed);
        return Err(CommandError::new(
            "cloud-agent-launch-failed",
            "Cloud storage component could not be started.",
        ));
    }
    claim.handoff();
    Ok(state.into())
}

fn start_request(request: CloudJobRequest) -> Result<CloudJobDto, CommandError> {
    let executable = resolve_cloud_executable()?;
    let directory = cloud::cloud_jobs_dir().map_err(CommandError::from_io)?;
    spawn_cloud_job_in(&directory, &executable, &request)
}

#[tauri::command]
pub async fn cloud_status() -> Result<CloudStatusDto, CommandError> {
    tauri::async_runtime::spawn_blocking(|| {
        let executable = resolve_cloud_executable().ok();
        let status = executable.as_deref().and_then(read_cloud_agent_status);
        Ok(CloudStatusDto {
            schema_version: cloud::CLOUD_JOB_SCHEMA_VERSION,
            capability: cloud::CLOUD_JOB_CAPABILITY.into(),
            executable_available: executable.is_some(),
            telegram_configured: status.is_some_and(|value| value.providers.telegram),
        })
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "Cloud status could not be read."))?
}

#[tauri::command]
pub async fn configure_telegram(request: ConfigureTelegramRequest) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let executable = resolve_cloud_executable()?;
        configure_telegram_with(&executable, request)
    })
    .await
    .map_err(|_| {
        CommandError::new(
            "telegram-configuration-failed",
            "텔레그램 저장소 설정을 저장하지 못했습니다.",
        )
    })?
}

#[tauri::command]
pub async fn install_cloud_component() -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(|| {
        let current_exe = std::env::current_exe().map_err(|_| {
            CommandError::new(
                "cloud-component-source-missing",
                "로컬 설치 파일을 찾지 못했습니다. Companion을 다시 설치해 주세요.",
            )
        })?;
        let application_dir = current_exe.parent().ok_or_else(|| {
            CommandError::new(
                "cloud-component-source-missing",
                "로컬 설치 파일을 찾지 못했습니다. Companion을 다시 설치해 주세요.",
            )
        })?;

        if let Some(source) =
            executable_candidates(&current_exe, Path::new(env!("CARGO_MANIFEST_DIR")))
                .into_iter()
                .skip(1)
                .find(|candidate| {
                    candidate.is_file() && read_cloud_agent_status(candidate).is_some()
                })
        {
            return install_cloud_component_from(&source, application_dir);
        }
        if let Some(installer) = installer_candidates(application_dir).into_iter().next() {
            return install_cloud_component_from(&installer, application_dir);
        }
        let Some(source) = rfd::FileDialog::new()
            .set_title("클라우드 구성 요소 또는 Companion 설치 파일 선택")
            .add_filter("실행 파일", &["exe"])
            .pick_file()
        else {
            return Err(CommandError::new(
                "cloud-component-source-missing",
                "로컬 설치 파일을 찾지 못했습니다. Companion을 다시 설치해 주세요.",
            ));
        };
        install_cloud_component_from(&source, application_dir)
    })
    .await
    .map_err(|_| {
        CommandError::new(
            "cloud-component-install-failed",
            "클라우드 구성 요소를 복구하지 못했습니다.",
        )
    })?
}

#[tauri::command]
pub async fn list_cloud_items() -> Result<Vec<CloudItemDto>, CommandError> {
    tauri::async_runtime::spawn_blocking(|| {
        let root = contract::companion_root().map_err(CommandError::from_io)?;
        list_cloud_items_in(&root).map_err(CommandError::from_io)
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "Cloud items could not be listed."))?
}

#[tauri::command]
pub async fn list_cloud_jobs() -> Result<Vec<CloudJobDto>, CommandError> {
    tauri::async_runtime::spawn_blocking(|| {
        let directory = cloud::cloud_jobs_dir().map_err(CommandError::from_io)?;
        cloud::list_cloud_job_states_in(&directory)
            .map(|states| states.into_iter().map(CloudJobDto::from).collect())
            .map_err(CommandError::from_io)
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "Cloud jobs could not be listed."))?
}

#[tauri::command]
pub async fn pick_cloud_upload() -> Result<Option<CloudUploadSelectionDto>, CommandError> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(path) = rfd::FileDialog::new()
            .set_title("Choose a file to upload")
            .pick_file()
        else {
            return Ok(None);
        };
        let metadata = fs::metadata(&path).map_err(CommandError::from_io)?;
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| valid_file_name(value))
            .ok_or_else(|| CommandError::invalid_request("The selected file name is invalid."))?;
        Ok(Some(CloudUploadSelectionDto {
            local_path: path.to_string_lossy().into_owned(),
            file_name: file_name.into(),
            size: metadata.len(),
        }))
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "The file picker could not be opened."))?
}

#[tauri::command]
pub async fn pick_cloud_download_destination(
    request: CloudDownloadDestinationRequest,
) -> Result<Option<String>, CommandError> {
    if !valid_file_name(&request.file_name) {
        return Err(CommandError::invalid_request(
            "The download file name is invalid.",
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        Ok(rfd::FileDialog::new()
            .set_title("Save cloud file")
            .set_file_name(&request.file_name)
            .save_file()
            .map(|path| path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "The file picker could not be opened."))?
}

#[tauri::command]
pub async fn start_cloud_upload(
    request: StartCloudUploadRequest,
) -> Result<CloudJobDto, CommandError> {
    tauri::async_runtime::spawn_blocking(move || start_request(build_upload_request(request)?))
        .await
        .map_err(|_| CommandError::new("operation-failed", "Cloud upload could not be started."))?
}

#[tauri::command]
pub async fn start_cloud_download(
    request: StartCloudDownloadRequest,
) -> Result<CloudJobDto, CommandError> {
    tauri::async_runtime::spawn_blocking(move || start_request(build_download_request(request)?))
        .await
        .map_err(|_| {
            CommandError::new("operation-failed", "Cloud download could not be started.")
        })?
}

#[tauri::command]
pub async fn start_cloud_delete(
    request: StartCloudDeleteRequest,
) -> Result<CloudJobDto, CommandError> {
    tauri::async_runtime::spawn_blocking(move || start_request(build_delete_request(request)?))
        .await
        .map_err(|_| {
            CommandError::new("operation-failed", "Cloud deletion could not be started.")
        })?
}

fn cancel_cloud_job_in(directory: &Path, job_id: &str) -> Result<(), CommandError> {
    let job_id = contract::safe_id(job_id)
        .ok_or_else(|| CommandError::invalid_request("The cloud job is invalid."))?;
    let state_path =
        cloud::cloud_state_path_in(directory, &job_id).map_err(CommandError::from_io)?;
    if !state_path.is_file() {
        return Err(CommandError::new("not-found", "Cloud job was not found."));
    }
    let cancel_path =
        cloud::cloud_cancel_path_in(directory, &job_id).map_err(CommandError::from_io)?;
    fs::write(cancel_path, b"cancel").map_err(CommandError::from_io)
}

#[tauri::command]
pub async fn cancel_cloud_job(request: CancelCloudJobRequest) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = cloud::cloud_jobs_dir().map_err(CommandError::from_io)?;
        cancel_cloud_job_in(&directory, &request.job_id)
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "Cloud job could not be cancelled."))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "segma-tauri-cloud-{label}-{}-{}",
            std::process::id(),
            generated_id("test")
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn request_builders_create_valid_upload_download_and_delete_contracts() {
        let root = temp_dir("requests");
        let source = root.join("clip.mp4");
        fs::write(&source, b"media").unwrap();
        let upload = build_upload_request(StartCloudUploadRequest {
            local_path: source.to_string_lossy().into_owned(),
            folder_id: Some("videos".into()),
        })
        .unwrap();
        let download = build_download_request(StartCloudDownloadRequest {
            item_id: upload.item_id.clone(),
            local_path: root.join("copy.mp4").to_string_lossy().into_owned(),
        })
        .unwrap();
        let delete = build_delete_request(StartCloudDeleteRequest {
            item_id: upload.item_id.clone(),
        })
        .unwrap();
        assert_eq!(upload.operation, CloudOperation::Upload);
        assert_eq!(download.operation, CloudOperation::Download);
        assert_eq!(delete.operation, CloudOperation::Delete);
        for request in [&upload, &download, &delete] {
            cloud::validate_cloud_job_request(request).unwrap();
            assert_eq!(request.provider, CloudProvider::Telegram);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn executable_resolution_prefers_installed_sibling_then_bounded_dev_build() {
        let root = temp_dir("executable");
        let installed = root.join("installed");
        let manifest = root.join("repo/companion-tauri/src-tauri");
        fs::create_dir_all(&installed).unwrap();
        fs::create_dir_all(&manifest).unwrap();
        let manager = installed.join("aura-media-manager.exe");
        let sibling = installed.join(CLOUD_EXECUTABLE);
        fs::write(&sibling, b"binary").unwrap();
        assert_eq!(
            resolve_cloud_executable_from(&manager, &manifest),
            Some(sibling.clone())
        );
        fs::remove_file(&sibling).unwrap();
        let dev = root
            .join("repo/cloud-agent/target/debug")
            .join(CLOUD_EXECUTABLE);
        fs::create_dir_all(dev.parent().unwrap()).unwrap();
        fs::write(&dev, b"binary").unwrap();
        assert_eq!(
            resolve_cloud_executable_from(&manager, &manifest),
            Some(dev)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn catalog_listing_returns_only_committed_safe_summaries_and_never_secrets() {
        let root = temp_dir("catalog");
        let items = root.join("cloud-telegram/items");
        fs::create_dir_all(&items).unwrap();
        fs::write(
            items.join("item-1.json"),
            serde_json::to_vec(&json!({
                "schemaVersion": 1,
                "itemId": "item-1",
                "fileName": "clip.mp4",
                "size": 42,
                "committed": true,
                "token": "TOP-SECRET",
                "chatId": "PRIVATE-CHAT",
                "parts": [{"fileId": "REMOTE-SECRET", "messageId": 7}]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            items.join("incomplete.json"),
            serde_json::to_vec(&json!({
                "schemaVersion": 1, "itemId": "incomplete", "fileName": "x.mp4",
                "size": 1, "committed": false
            }))
            .unwrap(),
        )
        .unwrap();
        let listed = list_cloud_items_in(&root).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].file_name, "clip.mp4");
        let response = serde_json::to_string(&listed).unwrap();
        for secret in [
            "TOP-SECRET",
            "PRIVATE-CHAT",
            "REMOTE-SECRET",
            "token",
            "chatId",
        ] {
            assert!(!response.contains(secret));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancellation_requires_a_valid_existing_job_and_writes_only_marker() {
        let root = temp_dir("cancel");
        let request = CloudJobRequest {
            schema_version: cloud::CLOUD_JOB_SCHEMA_VERSION,
            job_id: "job-1".into(),
            provider: CloudProvider::Telegram,
            operation: CloudOperation::Delete,
            item_id: "item-1".into(),
            created_at: 1,
            ..CloudJobRequest::default()
        };
        cloud::write_cloud_state_in(&root, &CloudJobState::queued(&request, 1)).unwrap();
        cancel_cloud_job_in(&root, "job-1").unwrap();
        assert_eq!(fs::read(root.join("job-1.cancel")).unwrap(), b"cancel");
        assert!(cancel_cloud_job_in(&root, "../escape").is_err());
        assert!(cancel_cloud_job_in(&root, "missing").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cloud_dtos_use_camel_case_and_do_not_expose_local_paths() {
        let request = CloudJobRequest {
            schema_version: cloud::CLOUD_JOB_SCHEMA_VERSION,
            job_id: "job-1".into(),
            provider: CloudProvider::Telegram,
            operation: CloudOperation::Upload,
            item_id: "item-1".into(),
            local_path: Some(r"C:\private\clip.mp4".into()),
            file_name: Some("clip.mp4".into()),
            created_at: 1,
            ..CloudJobRequest::default()
        };
        let serialized =
            serde_json::to_value(CloudJobDto::from(CloudJobState::queued(&request, 2))).unwrap();
        assert_eq!(serialized["jobId"], "job-1");
        assert!(serialized.get("job_id").is_none());
        assert!(!serialized.to_string().contains("private"));

        let mut failed = CloudJobState::queued(&request, 2);
        failed.error = Some("token=TOP-SECRET chat_id=PRIVATE-CHAT".into());
        let serialized = serde_json::to_string(&CloudJobDto::from(failed)).unwrap();
        assert!(!serialized.contains("TOP-SECRET"));
        assert!(!serialized.contains("PRIVATE-CHAT"));
    }

    #[test]
    fn agent_status_requires_matching_protocol_and_capability() {
        let valid: CloudAgentStatus = serde_json::from_value(json!({
            "protocol": 1,
            "capabilities": ["cloud-job-v1", "mock-blob-v1"],
            "providers": { "mock": true, "telegram": true }
        }))
        .unwrap();
        assert_eq!(valid.protocol, cloud::CLOUD_JOB_SCHEMA_VERSION);
        assert!(valid
            .capabilities
            .iter()
            .any(|value| value == cloud::CLOUD_JOB_CAPABILITY));
        assert!(valid.providers.telegram);

        let incompatible: CloudAgentStatus = serde_json::from_value(json!({
            "protocol": 99,
            "capabilities": [],
            "providers": { "telegram": true }
        }))
        .unwrap();
        assert_ne!(incompatible.protocol, cloud::CLOUD_JOB_SCHEMA_VERSION);
    }

    #[test]
    fn telegram_configuration_rejects_invalid_shape_before_spawn() {
        let error = configure_telegram_with(
            Path::new("missing-agent"),
            ConfigureTelegramRequest {
                token: "not-a-token".into(),
                channel_id: "chat name".into(),
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "invalid-request");
    }

    #[test]
    fn telegram_configuration_rejects_oversized_json_payload() {
        let error = telegram_config_payload(ConfigureTelegramRequest {
            token: format!("1:{}", "a".repeat(220)),
            channel_id: "-1001234567890".into(),
        })
        .unwrap_err();
        assert_eq!(error.code, "invalid-request");
        assert!(error.message.contains("너무 깁니다"));
    }

    #[test]
    fn telegram_configuration_failure_is_sanitized() {
        let secret = "123456:TOP_SECRET_TOKEN";
        let error = configure_telegram_with(
            Path::new("definitely-missing-cloud-agent"),
            ConfigureTelegramRequest {
                token: secret.into(),
                channel_id: "-1001234567890".into(),
            },
        )
        .unwrap_err();
        let serialized = serde_json::to_string(&error).unwrap();
        assert_eq!(error.code, "telegram-configuration-failed");
        assert!(!serialized.contains(secret));
        assert!(!serialized.contains("TOP_SECRET_TOKEN"));
        assert!(!serialized.contains("1001234567890"));
    }
}
