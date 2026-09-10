use aura_companion_contract::cloud::{CloudJobRequest, CloudJobState, CloudOperation};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const DEFAULT_CHUNK_BYTES: u64 = 512 * 1024 * 1024;
const COPY_BUFFER_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MockManifest {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    #[serde(rename = "itemId")]
    item_id: String,
    #[serde(rename = "fileName")]
    file_name: String,
    size: u64,
    #[serde(rename = "chunkBytes")]
    chunk_bytes: u64,
    parts: Vec<MockPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MockPart {
    index: u32,
    #[serde(rename = "fileName")]
    file_name: String,
    size: u64,
}

pub fn execute<F>(
    root: &Path,
    request: &CloudJobRequest,
    state: &mut CloudJobState,
    mut persist: F,
) -> io::Result<()>
where
    F: FnMut(&CloudJobState) -> io::Result<()>,
{
    execute_with_chunk_size(root, request, state, DEFAULT_CHUNK_BYTES, &mut persist)
}

fn execute_with_chunk_size<F>(
    root: &Path,
    request: &CloudJobRequest,
    state: &mut CloudJobState,
    chunk_bytes: u64,
    persist: &mut F,
) -> io::Result<()>
where
    F: FnMut(&CloudJobState) -> io::Result<()>,
{
    if chunk_bytes == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "cloud chunk size must be positive",
        ));
    }
    match request.operation {
        CloudOperation::Upload => upload(root, request, state, chunk_bytes, persist),
        CloudOperation::Download => download(root, request, state, persist),
        CloudOperation::Delete => delete(root, request, state, persist),
    }
}

fn mock_root(root: &Path) -> PathBuf {
    root.join("cloud-mock").join("items")
}

fn item_dir(root: &Path, item_id: &str) -> PathBuf {
    mock_root(root).join(item_id)
}

fn manifest_path(root: &Path, item_id: &str) -> PathBuf {
    item_dir(root, item_id).join("manifest.json")
}

fn part_name(index: u32) -> String {
    format!("part-{index:05}.bin")
}

fn upload<F>(
    root: &Path,
    request: &CloudJobRequest,
    state: &mut CloudJobState,
    chunk_bytes: u64,
    persist: &mut F,
) -> io::Result<()>
where
    F: FnMut(&CloudJobState) -> io::Result<()>,
{
    let source_path = request
        .local_path
        .as_deref()
        .map(Path::new)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "upload requires localPath"))?;
    let metadata = fs::metadata(source_path)?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "upload localPath is not a file",
        ));
    }
    let file_name = request
        .file_name
        .clone()
        .or_else(|| {
            source_path
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_owned)
        })
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "upload file name is invalid"))?;

    let size = metadata.len();
    state.phase = Some("uploading".into());
    state.total = Some(size);
    state.completed = Some(0);
    state.progress = Some(if size == 0 { 100 } else { 0 });
    state.file_name = Some(file_name.clone());
    persist(state)?;

    let directory = item_dir(root, &request.item_id);
    fs::create_dir_all(&directory)?;
    let mut source = File::open(source_path)?;
    let part_count = if size == 0 {
        0
    } else {
        (size + chunk_bytes - 1) / chunk_bytes
    };
    let mut parts = Vec::with_capacity(part_count as usize);
    let mut completed = 0_u64;

    for part_index in 0..part_count {
        let offset = part_index * chunk_bytes;
        let expected = (size - offset).min(chunk_bytes);
        let name = part_name(part_index as u32);
        let destination = directory.join(&name);

        let already_complete = fs::metadata(&destination)
            .map(|metadata| metadata.is_file() && metadata.len() == expected)
            .unwrap_or(false);
        if !already_complete {
            source.seek(SeekFrom::Start(offset))?;
            write_part(&mut source, &destination, expected)?;
        }

        completed = completed.saturating_add(expected);
        state.completed = Some(completed);
        state.progress = Some(progress(completed, size));
        persist(state)?;
        parts.push(MockPart {
            index: part_index as u32,
            file_name: name,
            size: expected,
        });
    }

    let manifest = MockManifest {
        schema_version: 1,
        item_id: request.item_id.clone(),
        file_name,
        size,
        chunk_bytes,
        parts,
    };
    write_json_atomic(&manifest_path(root, &request.item_id), &manifest)?;
    state.phase = Some("committing".into());
    state.completed = Some(size);
    state.progress = Some(100);
    persist(state)
}

fn write_part(source: &mut File, destination: &Path, expected: u64) -> io::Result<()> {
    let temporary = destination.with_extension("bin.tmp");
    let _ = fs::remove_file(&temporary);
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    let mut limited = source.take(expected);
    let copied = copy_buffered(&mut limited, &mut output)?;
    if copied != expected {
        let _ = fs::remove_file(&temporary);
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "source file changed while uploading",
        ));
    }
    output.sync_all()?;
    drop(output);
    if destination.exists() {
        fs::remove_file(destination)?;
    }
    fs::rename(&temporary, destination)
}

fn download<F>(
    root: &Path,
    request: &CloudJobRequest,
    state: &mut CloudJobState,
    persist: &mut F,
) -> io::Result<()>
where
    F: FnMut(&CloudJobState) -> io::Result<()>,
{
    let manifest = read_manifest(root, &request.item_id)?;
    let destination = request
        .local_path
        .as_deref()
        .map(Path::new)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "download requires localPath"))?;
    if destination.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "download destination already exists",
        ));
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }

    state.phase = Some("downloading".into());
    state.total = Some(manifest.size);
    state.completed = Some(0);
    state.progress = Some(if manifest.size == 0 { 100 } else { 0 });
    state.file_name = Some(manifest.file_name.clone());
    persist(state)?;

    let temporary = PathBuf::from(format!("{}.segma.part", destination.display()));
    let _ = fs::remove_file(&temporary);
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    let directory = item_dir(root, &request.item_id);
    let mut completed = 0_u64;

    for part in &manifest.parts {
        let path = directory.join(&part.file_name);
        let metadata = fs::metadata(&path)?;
        if !metadata.is_file() || metadata.len() != part.size {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("cloud part {} is incomplete", part.index),
            ));
        }
        let mut input = File::open(&path)?;
        let copied = copy_buffered(&mut input, &mut output)?;
        if copied != part.size {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("cloud part {} changed while downloading", part.index),
            ));
        }
        completed = completed.saturating_add(copied);
        state.completed = Some(completed);
        state.progress = Some(progress(completed, manifest.size));
        persist(state)?;
    }

    if completed != manifest.size {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "cloud manifest byte count does not match its parts",
        ));
    }
    output.sync_all()?;
    drop(output);
    fs::rename(&temporary, destination)?;
    state.phase = Some("materialized".into());
    state.progress = Some(100);
    persist(state)
}

fn delete<F>(
    root: &Path,
    request: &CloudJobRequest,
    state: &mut CloudJobState,
    persist: &mut F,
) -> io::Result<()>
where
    F: FnMut(&CloudJobState) -> io::Result<()>,
{
    state.phase = Some("deleting".into());
    persist(state)?;
    let directory = item_dir(root, &request.item_id);
    match fs::remove_dir_all(directory) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    state.completed = Some(0);
    state.total = Some(0);
    state.progress = Some(100);
    persist(state)
}

fn read_manifest(root: &Path, item_id: &str) -> io::Result<MockManifest> {
    let bytes = fs::read(manifest_path(root, item_id))?;
    let manifest: MockManifest = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    if manifest.schema_version != 1 || manifest.item_id != item_id {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid mock cloud manifest",
        ));
    }
    Ok(manifest)
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
    let temporary = path.with_extension("json.tmp");
    let _ = fs::remove_file(&temporary);
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    output.write_all(&bytes)?;
    output.sync_all()?;
    drop(output);
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(temporary, path)
}

fn copy_buffered<R: Read, W: Write>(reader: &mut R, writer: &mut W) -> io::Result<u64> {
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut total = 0_u64;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read])?;
        total = total.saturating_add(read as u64);
    }
    Ok(total)
}

fn progress(completed: u64, total: u64) -> u8 {
    if total == 0 {
        return 100;
    }
    (((completed as u128) * 100) / (total as u128)).min(100) as u8
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_companion_contract::cloud::{
        CloudJobRequest, CloudJobState, CloudProvider, CLOUD_JOB_SCHEMA_VERSION,
    };
    use std::env;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        env::temp_dir().join(format!("segma-cloud-mock-{}-{nonce}", std::process::id()))
    }

    fn request(operation: CloudOperation, item_id: &str, path: Option<&Path>) -> CloudJobRequest {
        CloudJobRequest {
            schema_version: CLOUD_JOB_SCHEMA_VERSION,
            job_id: format!("job-{item_id}"),
            provider: CloudProvider::Mock,
            operation,
            item_id: item_id.into(),
            local_path: path.map(|value| value.to_string_lossy().into_owned()),
            ..CloudJobRequest::default()
        }
    }

    #[test]
    fn mock_upload_is_resumable_and_download_materializes_exact_bytes() {
        let root = temp_root();
        fs::create_dir_all(&root).expect("root creates");
        let source = root.join("source.bin");
        let expected: Vec<u8> = (0u8..=200).cycle().take(350).collect();
        fs::write(&source, &expected).expect("source writes");

        let upload = request(CloudOperation::Upload, "item-a", Some(&source));
        let mut upload_state = CloudJobState::queued(&upload, 1);
        execute_with_chunk_size(&root, &upload, &mut upload_state, 64, &mut |_| Ok(()))
            .expect("upload succeeds");
        assert_eq!(upload_state.completed, Some(expected.len() as u64));
        assert!(item_dir(&root, "item-a").join("part-00005.bin").is_file());

        execute_with_chunk_size(&root, &upload, &mut upload_state, 64, &mut |_| Ok(()))
            .expect("resumed upload succeeds");

        let destination = root.join("restored.bin");
        let download = request(CloudOperation::Download, "item-a", Some(&destination));
        let mut download_state = CloudJobState::queued(&download, 2);
        execute_with_chunk_size(&root, &download, &mut download_state, 64, &mut |_| Ok(()))
            .expect("download succeeds");
        assert_eq!(fs::read(&destination).expect("restored reads"), expected);
        assert_eq!(download_state.progress, Some(100));

        let delete = request(CloudOperation::Delete, "item-a", None);
        let mut delete_state = CloudJobState::queued(&delete, 3);
        execute_with_chunk_size(&root, &delete, &mut delete_state, 64, &mut |_| Ok(()))
            .expect("delete succeeds");
        assert!(!item_dir(&root, "item-a").exists());
        fs::remove_dir_all(root).expect("root removes");
    }

    #[test]
    fn download_refuses_to_replace_an_existing_file() {
        let root = temp_root();
        fs::create_dir_all(&root).expect("root creates");
        let source = root.join("source.bin");
        fs::write(&source, b"cloud-data").expect("source writes");
        let upload = request(CloudOperation::Upload, "item-b", Some(&source));
        let mut state = CloudJobState::queued(&upload, 1);
        execute_with_chunk_size(&root, &upload, &mut state, 4, &mut |_| Ok(()))
            .expect("upload succeeds");

        let destination = root.join("existing.bin");
        fs::write(&destination, b"keep-me").expect("destination writes");
        let download = request(CloudOperation::Download, "item-b", Some(&destination));
        let mut download_state = CloudJobState::queued(&download, 2);
        let error = execute_with_chunk_size(&root, &download, &mut download_state, 4, &mut |_| Ok(()))
            .expect_err("existing destination is rejected");
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&destination).unwrap(), b"keep-me");
        fs::remove_dir_all(root).expect("root removes");
    }
}
