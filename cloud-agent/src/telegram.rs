use aura_companion_contract::cloud::{self, CloudJobRequest, CloudJobState, CloudOperation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const CHUNK_BYTES: usize = 45 * 1024 * 1024;
const CONFIG_FILE: &str = "telegram-config.dpapi";
const CATALOG_VERSION: u32 = 1;

#[derive(Clone)]
pub(crate) struct TelegramConfig {
    token: String,
    chat_id: String,
}

impl std::fmt::Debug for TelegramConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TelegramConfig")
            .field("token", &"[REDACTED]")
            .field("chat_id", &self.chat_id)
            .finish()
    }
}

#[derive(Deserialize, Serialize)]
struct StoredConfig {
    token: String,
    #[serde(rename = "channelId")]
    channel_id: String,
}

impl TelegramConfig {
    fn new(token: String, chat_id: String) -> io::Result<Self> {
        let token_ok = token.len() >= 12
            && token.len() <= 256
            && token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'));
        let chat_ok = !chat_id.is_empty()
            && chat_id.len() <= 128
            && chat_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'@' | b'_' | b'-'));
        if !token_ok || !chat_ok {
            return Err(public_error(
                io::ErrorKind::InvalidInput,
                "invalid Telegram configuration",
            ));
        }
        Ok(Self { token, chat_id })
    }
}

pub(crate) trait ConfigLoader {
    fn load(&self) -> io::Result<TelegramConfig>;
}

pub(crate) struct ProtectedConfigLoader<'a> {
    root: &'a Path,
}

impl<'a> ProtectedConfigLoader<'a> {
    pub(crate) fn new(root: &'a Path) -> Self {
        Self { root }
    }
}

impl ConfigLoader for ProtectedConfigLoader<'_> {
    fn load(&self) -> io::Result<TelegramConfig> {
        load_protected_config(self.root)
    }
}

pub(crate) fn protected_config_available(root: &Path) -> bool {
    load_protected_config(root).is_ok()
}

pub(crate) fn configure_from_reader(root: &Path, reader: &mut dyn Read) -> io::Result<()> {
    let mut bytes = Vec::new();
    reader.take(16 * 1024).read_to_end(&mut bytes)?;
    let stored: StoredConfig = serde_json::from_slice(&bytes).map_err(|_| {
        public_error(
            io::ErrorKind::InvalidInput,
            "invalid Telegram configuration",
        )
    })?;
    let config = TelegramConfig::new(stored.token, stored.channel_id)?;
    let serialized = serde_json::to_vec(&StoredConfig {
        token: config.token,
        channel_id: config.chat_id,
    })
    .map_err(|_| {
        public_error(
            io::ErrorKind::InvalidData,
            "could not encode Telegram configuration",
        )
    })?;
    let protected = protect(&serialized)?;
    fs::create_dir_all(root)?;
    write_bytes_atomic(&root.join(CONFIG_FILE), &protected)
}

fn load_protected_config(root: &Path) -> io::Result<TelegramConfig> {
    let protected = fs::read(root.join(CONFIG_FILE))?;
    if protected.len() > 32 * 1024 {
        return Err(public_error(
            io::ErrorKind::InvalidData,
            "invalid Telegram configuration",
        ));
    }
    let plain = unprotect(&protected)?;
    let stored: StoredConfig = serde_json::from_slice(&plain)
        .map_err(|_| public_error(io::ErrorKind::InvalidData, "invalid Telegram configuration"))?;
    TelegramConfig::new(stored.token, stored.channel_id)
}

fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temporary = path.with_extension("tmp");
    let _ = fs::remove_file(&temporary);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    drop(file);
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(temporary, path)
}

#[cfg(windows)]
fn protect(input: &[u8]) -> io::Result<Vec<u8>> {
    dpapi(input, true)
}
#[cfg(windows)]
fn unprotect(input: &[u8]) -> io::Result<Vec<u8>> {
    dpapi(input, false)
}

#[cfg(windows)]
fn dpapi(input: &[u8], encrypt: bool) -> io::Result<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let source = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let result = unsafe {
        if encrypt {
            CryptProtectData(
                &source,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &source,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if result == 0 {
        return Err(public_error(
            io::ErrorKind::PermissionDenied,
            "protected Telegram configuration is unavailable",
        ));
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as *mut std::ffi::c_void);
    }
    Ok(bytes)
}

#[cfg(not(windows))]
fn protect(_: &[u8]) -> io::Result<Vec<u8>> {
    Err(public_error(
        io::ErrorKind::Unsupported,
        "protected Telegram configuration is unavailable",
    ))
}
#[cfg(not(windows))]
fn unprotect(_: &[u8]) -> io::Result<Vec<u8>> {
    Err(public_error(
        io::ErrorKind::Unsupported,
        "protected Telegram configuration is unavailable",
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RemoteDocument {
    pub message_id: i64,
    pub file_id: String,
    pub file_unique_id: String,
}

pub(crate) trait TelegramTransport {
    fn upload(
        &mut self,
        config: &TelegramConfig,
        name: &str,
        bytes: Vec<u8>,
    ) -> io::Result<RemoteDocument>;
    fn resolve(&mut self, config: &TelegramConfig, file_id: &str) -> io::Result<String>;
    fn download(&mut self, config: &TelegramConfig, file_path: &str) -> io::Result<Vec<u8>>;
    fn delete(&mut self, config: &TelegramConfig, message_id: i64) -> io::Result<()>;
}

pub(crate) struct BotApiTransport {
    client: reqwest::blocking::Client,
}

impl BotApiTransport {
    pub(crate) fn new() -> io::Result<Self> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|_| transport_error())?;
        Ok(Self { client })
    }
    fn api_url(config: &TelegramConfig, method: &str) -> String {
        format!("https://api.telegram.org/bot{}/{method}", config.token)
    }
    fn file_url(config: &TelegramConfig, path: &str) -> io::Result<String> {
        if path.is_empty() || path.contains("..") || path.starts_with('/') || path.contains('\\') {
            return Err(public_error(
                io::ErrorKind::InvalidData,
                "Telegram returned an invalid file reference",
            ));
        }
        Ok(format!(
            "https://api.telegram.org/file/bot{}/{path}",
            config.token
        ))
    }
}

#[derive(Deserialize)]
struct ApiResponse<T> {
    ok: bool,
    result: Option<T>,
}
#[derive(Deserialize)]
struct SentMessage {
    message_id: i64,
    document: Option<SentDocument>,
}
#[derive(Deserialize)]
struct SentDocument {
    file_id: String,
    file_unique_id: String,
}
#[derive(Deserialize)]
struct ResolvedFile {
    file_path: Option<String>,
}

impl TelegramTransport for BotApiTransport {
    fn upload(
        &mut self,
        config: &TelegramConfig,
        name: &str,
        bytes: Vec<u8>,
    ) -> io::Result<RemoteDocument> {
        let part = reqwest::blocking::multipart::Part::bytes(bytes).file_name(name.to_owned());
        let form = reqwest::blocking::multipart::Form::new()
            .text("chat_id", config.chat_id.clone())
            .part("document", part);
        let response = self
            .client
            .post(Self::api_url(config, "sendDocument"))
            .multipart(form)
            .send()
            .map_err(|_| transport_error())?;
        let message = parse_api::<SentMessage>(response)?;
        message
            .document
            .map(|document| RemoteDocument {
                message_id: message.message_id,
                file_id: document.file_id,
                file_unique_id: document.file_unique_id,
            })
            .ok_or_else(api_error)
    }
    fn resolve(&mut self, config: &TelegramConfig, file_id: &str) -> io::Result<String> {
        let response = self
            .client
            .post(Self::api_url(config, "getFile"))
            .form(&[("file_id", file_id)])
            .send()
            .map_err(|_| transport_error())?;
        parse_api::<ResolvedFile>(response)?
            .file_path
            .ok_or_else(api_error)
    }
    fn download(&mut self, config: &TelegramConfig, file_path: &str) -> io::Result<Vec<u8>> {
        let response = self
            .client
            .get(Self::file_url(config, file_path)?)
            .send()
            .map_err(|_| transport_error())?;
        if !response.status().is_success() {
            return Err(api_error());
        }
        response
            .bytes()
            .map(|value| value.to_vec())
            .map_err(|_| transport_error())
    }
    fn delete(&mut self, config: &TelegramConfig, message_id: i64) -> io::Result<()> {
        let message_id = message_id.to_string();
        let response = self
            .client
            .post(Self::api_url(config, "deleteMessage"))
            .form(&[
                ("chat_id", config.chat_id.as_str()),
                ("message_id", message_id.as_str()),
            ])
            .send()
            .map_err(|_| transport_error())?;
        let result = parse_api::<bool>(response)?;
        if result {
            Ok(())
        } else {
            Err(api_error())
        }
    }
}

fn parse_api<T: for<'de> Deserialize<'de>>(response: reqwest::blocking::Response) -> io::Result<T> {
    if !response.status().is_success() {
        return Err(api_error());
    }
    let envelope: ApiResponse<T> = response.json().map_err(|_| api_error())?;
    if !envelope.ok {
        return Err(api_error());
    }
    envelope.result.ok_or_else(api_error)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Catalog {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    #[serde(rename = "itemId")]
    item_id: String,
    #[serde(rename = "fileName")]
    file_name: String,
    size: u64,
    sha256: String,
    committed: bool,
    parts: Vec<CatalogPart>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct CatalogPart {
    index: u32,
    size: u64,
    sha256: String,
    #[serde(rename = "messageId")]
    message_id: i64,
    #[serde(rename = "fileId")]
    file_id: String,
    #[serde(rename = "fileUniqueId")]
    file_unique_id: String,
}

pub(crate) fn execute<F>(
    root: &Path,
    request: &CloudJobRequest,
    state: &mut CloudJobState,
    persist: F,
) -> io::Result<()>
where
    F: FnMut(&CloudJobState) -> io::Result<()>,
{
    let config = ProtectedConfigLoader::new(root).load()?;
    let mut transport = BotApiTransport::new()?;
    execute_with(
        root,
        request,
        state,
        &config,
        &mut transport,
        persist,
        CHUNK_BYTES,
    )
}

pub(crate) fn execute_with<T, F>(
    root: &Path,
    request: &CloudJobRequest,
    state: &mut CloudJobState,
    config: &TelegramConfig,
    transport: &mut T,
    mut persist: F,
    chunk_bytes: usize,
) -> io::Result<()>
where
    T: TelegramTransport,
    F: FnMut(&CloudJobState) -> io::Result<()>,
{
    if chunk_bytes == 0 {
        return Err(public_error(
            io::ErrorKind::InvalidInput,
            "invalid Telegram chunk size",
        ));
    }
    match request.operation {
        CloudOperation::Upload => upload(
            root,
            request,
            state,
            config,
            transport,
            &mut persist,
            chunk_bytes,
        ),
        CloudOperation::Download => download(root, request, state, config, transport, &mut persist),
        CloudOperation::Delete => delete(root, request, state, config, transport, &mut persist),
    }
}

fn catalog_path(root: &Path, item_id: &str) -> PathBuf {
    root.join("cloud-telegram")
        .join("items")
        .join(format!("{item_id}.json"))
}
fn read_catalog(root: &Path, item_id: &str) -> io::Result<Catalog> {
    let catalog: Catalog = serde_json::from_slice(&fs::read(catalog_path(root, item_id))?)
        .map_err(|_| public_error(io::ErrorKind::InvalidData, "invalid Telegram catalog"))?;
    if catalog.schema_version != CATALOG_VERSION || catalog.item_id != item_id {
        return Err(public_error(
            io::ErrorKind::InvalidData,
            "invalid Telegram catalog",
        ));
    }
    Ok(catalog)
}
fn write_catalog(root: &Path, catalog: &Catalog) -> io::Result<()> {
    let path = catalog_path(root, &catalog.item_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    aura_companion_contract::write_json_atomic(&path, catalog)
}
fn cancelled(root: &Path, request: &CloudJobRequest) -> io::Result<()> {
    if cloud::cloud_cancel_path_in(&root.join("cloud-jobs"), &request.job_id)?.is_file() {
        Err(public_error(
            io::ErrorKind::Interrupted,
            "cloud job cancelled",
        ))
    } else {
        Ok(())
    }
}

fn upload<T: TelegramTransport, F: FnMut(&CloudJobState) -> io::Result<()>>(
    root: &Path,
    request: &CloudJobRequest,
    state: &mut CloudJobState,
    config: &TelegramConfig,
    transport: &mut T,
    persist: &mut F,
    chunk_bytes: usize,
) -> io::Result<()> {
    let source_path = request
        .local_path
        .as_deref()
        .map(Path::new)
        .ok_or_else(|| public_error(io::ErrorKind::InvalidInput, "upload requires localPath"))?;
    let size = fs::metadata(source_path)?.len();
    let file_name = request
        .file_name
        .clone()
        .or_else(|| source_path.file_name()?.to_str().map(str::to_owned))
        .ok_or_else(|| public_error(io::ErrorKind::InvalidInput, "invalid upload file name"))?;
    state.phase = Some("uploading".into());
    state.total = Some(size);
    state.completed = Some(0);
    state.progress = Some(if size == 0 { 100 } else { 0 });
    state.file_name = Some(file_name.clone());
    persist(state)?;
    let mut catalog = read_catalog(root, &request.item_id).unwrap_or(Catalog {
        schema_version: CATALOG_VERSION,
        item_id: request.item_id.clone(),
        file_name: file_name.clone(),
        size,
        sha256: String::new(),
        committed: false,
        parts: Vec::new(),
    });
    if catalog.file_name != file_name || catalog.size != size {
        return Err(public_error(
            io::ErrorKind::InvalidData,
            "upload source changed since the prior attempt",
        ));
    }
    let mut source = File::open(source_path)?;
    let mut whole = Sha256::new();
    let mut completed = 0u64;
    let mut index = 0u32;
    loop {
        cancelled(root, request)?;
        let mut bytes = vec![0; chunk_bytes];
        let mut count = 0;
        while count < bytes.len() {
            let read = source.read(&mut bytes[count..])?;
            if read == 0 {
                break;
            }
            count += read;
        }
        bytes.truncate(count);
        if bytes.is_empty() {
            break;
        }
        whole.update(&bytes);
        let part_hash = hash(&bytes);
        let existing = catalog
            .parts
            .iter()
            .find(|part| {
                part.index == index && part.size == count as u64 && part.sha256 == part_hash
            })
            .cloned();
        if existing.is_none() {
            if let Some(old) = catalog
                .parts
                .iter()
                .find(|part| part.index == index)
                .cloned()
            {
                let _ = transport.delete(config, old.message_id);
                catalog.parts.retain(|part| part.index != index);
            }
            let remote =
                transport.upload(config, &format!("{file_name}.part-{index:05}"), bytes)?;
            catalog.parts.push(CatalogPart {
                index,
                size: count as u64,
                sha256: part_hash,
                message_id: remote.message_id,
                file_id: remote.file_id,
                file_unique_id: remote.file_unique_id,
            });
            catalog.parts.sort_by_key(|part| part.index);
            write_catalog(root, &catalog)?;
        }
        completed += count as u64;
        state.completed = Some(completed);
        state.progress = Some(progress(completed, size));
        persist(state)?;
        index += 1;
    }
    cancelled(root, request)?;
    catalog.parts.retain(|part| part.index < index);
    catalog.sha256 = digest_hex(whole.finalize().as_slice());
    catalog.committed = true;
    write_catalog(root, &catalog)?;
    state.phase = Some("committing".into());
    state.completed = Some(size);
    state.progress = Some(100);
    persist(state)
}

fn download<T: TelegramTransport, F: FnMut(&CloudJobState) -> io::Result<()>>(
    root: &Path,
    request: &CloudJobRequest,
    state: &mut CloudJobState,
    config: &TelegramConfig,
    transport: &mut T,
    persist: &mut F,
) -> io::Result<()> {
    let catalog = read_catalog(root, &request.item_id)?;
    if !catalog.committed {
        return Err(public_error(
            io::ErrorKind::InvalidData,
            "Telegram upload is incomplete",
        ));
    }
    let destination = request
        .local_path
        .as_deref()
        .map(Path::new)
        .ok_or_else(|| public_error(io::ErrorKind::InvalidInput, "download requires localPath"))?;
    if destination.exists() {
        return Err(public_error(
            io::ErrorKind::AlreadyExists,
            "download destination already exists",
        ));
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    state.phase = Some("downloading".into());
    state.total = Some(catalog.size);
    state.completed = Some(0);
    state.progress = Some(if catalog.size == 0 { 100 } else { 0 });
    state.file_name = Some(catalog.file_name.clone());
    persist(state)?;
    let temporary = PathBuf::from(format!("{}.segma.part", destination.display()));
    let _ = fs::remove_file(&temporary);
    let result = (|| {
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        let mut whole = Sha256::new();
        let mut completed = 0u64;
        for part in &catalog.parts {
            cancelled(root, request)?;
            let remote_path = transport.resolve(config, &part.file_id)?;
            let bytes = transport.download(config, &remote_path)?;
            if bytes.len() as u64 != part.size || hash(&bytes) != part.sha256 {
                return Err(public_error(
                    io::ErrorKind::InvalidData,
                    "Telegram download integrity check failed",
                ));
            }
            output.write_all(&bytes)?;
            whole.update(&bytes);
            completed += bytes.len() as u64;
            state.completed = Some(completed);
            state.progress = Some(progress(completed, catalog.size));
            persist(state)?;
        }
        cancelled(root, request)?;
        if completed != catalog.size || digest_hex(whole.finalize().as_slice()) != catalog.sha256 {
            return Err(public_error(
                io::ErrorKind::InvalidData,
                "Telegram download integrity check failed",
            ));
        }
        output.sync_all()?;
        drop(output);
        fs::rename(&temporary, destination)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    state.phase = Some("materialized".into());
    state.progress = Some(100);
    persist(state)
}

fn delete<T: TelegramTransport, F: FnMut(&CloudJobState) -> io::Result<()>>(
    root: &Path,
    request: &CloudJobRequest,
    state: &mut CloudJobState,
    config: &TelegramConfig,
    transport: &mut T,
    persist: &mut F,
) -> io::Result<()> {
    state.phase = Some("deleting".into());
    persist(state)?;
    let path = catalog_path(root, &request.item_id);
    let catalog = match read_catalog(root, &request.item_id) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            state.progress = Some(100);
            return persist(state);
        }
        Err(error) => return Err(error),
    };
    let mut remaining = catalog;
    while let Some(part) = remaining.parts.first().cloned() {
        cancelled(root, request)?;
        transport.delete(config, part.message_id)?;
        remaining.parts.remove(0);
        write_catalog(root, &remaining)?;
    }
    fs::remove_file(path)?;
    state.completed = Some(0);
    state.total = Some(0);
    state.progress = Some(100);
    persist(state)
}

fn hash(bytes: &[u8]) -> String {
    digest_hex(Sha256::digest(bytes).as_slice())
}
fn digest_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn progress(done: u64, total: u64) -> u8 {
    if total == 0 {
        100
    } else {
        (((done as u128) * 100 / total as u128).min(100)) as u8
    }
}
fn public_error(kind: io::ErrorKind, message: &'static str) -> io::Error {
    io::Error::new(kind, message)
}
fn transport_error() -> io::Error {
    public_error(
        io::ErrorKind::ConnectionAborted,
        "Telegram transport failed",
    )
}
fn api_error() -> io::Error {
    public_error(io::ErrorKind::Other, "Telegram API request failed")
}

#[cfg(test)]
pub(crate) fn test_config(token: &str, chat_id: &str) -> TelegramConfig {
    TelegramConfig::new(token.into(), chat_id.into()).unwrap()
}
