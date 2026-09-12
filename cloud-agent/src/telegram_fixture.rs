use super::telegram::{self, ConfigLoader, RemoteDocument, TelegramConfig, TelegramTransport};
use aura_companion_contract::cloud::{
    CloudJobRequest, CloudJobState, CloudOperation, CloudProvider, CLOUD_JOB_SCHEMA_VERSION,
};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Default)]
struct FixtureTransport {
    next_message: i64,
    blobs: HashMap<String, Vec<u8>>,
    uploads: usize,
    deletes: Vec<i64>,
    fail_upload_after: Option<usize>,
    corrupt_download: bool,
    seen_secret: bool,
}

impl TelegramTransport for FixtureTransport {
    fn upload(
        &mut self,
        config: &TelegramConfig,
        _: &str,
        bytes: Vec<u8>,
    ) -> io::Result<RemoteDocument> {
        self.seen_secret = format!("{config:?}").contains("123456:fixture-secret");
        if self.fail_upload_after == Some(self.uploads) {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "Telegram transport failed",
            ));
        }
        self.next_message += 1;
        self.uploads += 1;
        let file_id = format!("file-{}", self.next_message);
        self.blobs.insert(file_id.clone(), bytes);
        Ok(RemoteDocument {
            message_id: self.next_message,
            file_id: file_id.clone(),
            file_unique_id: format!("unique-{}", self.next_message),
        })
    }
    fn resolve(&mut self, _: &TelegramConfig, file_id: &str) -> io::Result<String> {
        Ok(file_id.to_owned())
    }
    fn download(&mut self, _: &TelegramConfig, path: &str) -> io::Result<Vec<u8>> {
        let mut bytes = self.blobs.get(path).cloned().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "Telegram API request failed")
        })?;
        if self.corrupt_download && !bytes.is_empty() {
            bytes[0] ^= 0xff;
        }
        Ok(bytes)
    }
    fn delete(&mut self, _: &TelegramConfig, message_id: i64) -> io::Result<()> {
        self.deletes.push(message_id);
        Ok(())
    }
}

fn root(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "segma-telegram-{label}-{}-{nonce}",
        std::process::id()
    ))
}

fn request(operation: CloudOperation, item: &str, path: Option<&Path>) -> CloudJobRequest {
    CloudJobRequest {
        schema_version: CLOUD_JOB_SCHEMA_VERSION,
        job_id: format!("job-{item}"),
        provider: CloudProvider::Telegram,
        operation,
        item_id: item.into(),
        local_path: path.map(|value| value.to_string_lossy().into_owned()),
        ..CloudJobRequest::default()
    }
}

fn config() -> TelegramConfig {
    telegram::test_config("123456:fixture-secret", "-100123456")
}

#[test]
fn upload_download_delete_preserve_bytes_catalog_and_sanitization() {
    let root = root("roundtrip");
    fs::create_dir_all(&root).unwrap();
    let source = root.join("source.bin");
    let expected: Vec<u8> = (0..23).collect();
    fs::write(&source, &expected).unwrap();
    let upload = request(CloudOperation::Upload, "item-a", Some(&source));
    let mut state = CloudJobState::queued(&upload, 1);
    let mut transport = FixtureTransport::default();
    telegram::execute_with(
        &root,
        &upload,
        &mut state,
        &config(),
        &mut transport,
        |_| Ok(()),
        8,
    )
    .unwrap();
    assert_eq!(transport.uploads, 3);
    assert!(!transport.seen_secret);
    let catalog = fs::read_to_string(root.join("cloud-telegram/items/item-a.json")).unwrap();
    assert!(catalog.contains("messageId") && catalog.contains("fileUniqueId"));
    assert!(!catalog.contains("fixture-secret") && !catalog.contains("channelId"));

    let destination = root.join("restored.bin");
    let download = request(CloudOperation::Download, "item-a", Some(&destination));
    let mut state = CloudJobState::queued(&download, 2);
    telegram::execute_with(
        &root,
        &download,
        &mut state,
        &config(),
        &mut transport,
        |_| Ok(()),
        8,
    )
    .unwrap();
    assert_eq!(fs::read(&destination).unwrap(), expected);
    let delete = request(CloudOperation::Delete, "item-a", None);
    let mut state = CloudJobState::queued(&delete, 3);
    telegram::execute_with(
        &root,
        &delete,
        &mut state,
        &config(),
        &mut transport,
        |_| Ok(()),
        8,
    )
    .unwrap();
    assert_eq!(transport.deletes.len(), 3);
    assert!(!root.join("cloud-telegram/items/item-a.json").exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retry_after_transport_failure_reuses_durable_uploaded_parts() {
    let root = root("retry");
    fs::create_dir_all(&root).unwrap();
    let source = root.join("source.bin");
    fs::write(&source, b"abcdefghijklmnop").unwrap();
    let upload = request(CloudOperation::Upload, "item-b", Some(&source));
    let mut state = CloudJobState::queued(&upload, 1);
    let mut first = FixtureTransport {
        fail_upload_after: Some(1),
        ..FixtureTransport::default()
    };
    assert_eq!(
        telegram::execute_with(
            &root,
            &upload,
            &mut state,
            &config(),
            &mut first,
            |_| Ok(()),
            8
        )
        .unwrap_err()
        .kind(),
        io::ErrorKind::ConnectionAborted
    );
    assert_eq!(first.uploads, 1);
    let mut restarted = FixtureTransport {
        next_message: first.next_message,
        blobs: first.blobs,
        ..FixtureTransport::default()
    };
    telegram::execute_with(
        &root,
        &upload,
        &mut state,
        &config(),
        &mut restarted,
        |_| Ok(()),
        8,
    )
    .unwrap();
    assert_eq!(restarted.uploads, 1);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn cancellation_and_integrity_failure_never_publish_destination() {
    let root = root("integrity");
    fs::create_dir_all(root.join("cloud-jobs")).unwrap();
    let source = root.join("source.bin");
    fs::write(&source, b"integrity-data").unwrap();
    let upload = request(CloudOperation::Upload, "item-c", Some(&source));
    let mut state = CloudJobState::queued(&upload, 1);
    let mut transport = FixtureTransport::default();
    telegram::execute_with(
        &root,
        &upload,
        &mut state,
        &config(),
        &mut transport,
        |_| Ok(()),
        8,
    )
    .unwrap();
    let destination = root.join("restored.bin");
    let download = request(CloudOperation::Download, "item-c", Some(&destination));
    fs::write(root.join("cloud-jobs/job-item-c.cancel"), b"cancel").unwrap();
    let mut state = CloudJobState::queued(&download, 2);
    assert_eq!(
        telegram::execute_with(
            &root,
            &download,
            &mut state,
            &config(),
            &mut transport,
            |_| Ok(()),
            8
        )
        .unwrap_err()
        .kind(),
        io::ErrorKind::Interrupted
    );
    assert!(!destination.exists());
    fs::remove_file(root.join("cloud-jobs/job-item-c.cancel")).unwrap();
    transport.corrupt_download = true;
    assert_eq!(
        telegram::execute_with(
            &root,
            &download,
            &mut state,
            &config(),
            &mut transport,
            |_| Ok(()),
            8
        )
        .unwrap_err()
        .kind(),
        io::ErrorKind::InvalidData
    );
    assert!(
        !destination.exists()
            && !PathBuf::from(format!("{}.segma.part", destination.display())).exists()
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_protected_config_and_api_errors_are_sanitized() {
    let root = root("config");
    let error = telegram::ProtectedConfigLoader::new(&root)
        .load()
        .unwrap_err();
    assert!(!error.to_string().contains("fixture-secret"));
    let source = root.join("source");
    let request = request(CloudOperation::Upload, "item-d", Some(&source));
    let mut state = CloudJobState::queued(&request, 1);
    let mut transport = FixtureTransport {
        fail_upload_after: Some(0),
        ..FixtureTransport::default()
    };
    fs::create_dir_all(&root).unwrap();
    fs::write(source, b"x").unwrap();
    let error = telegram::execute_with(
        &root,
        &request,
        &mut state,
        &config(),
        &mut transport,
        |_| Ok(()),
        8,
    )
    .unwrap_err();
    assert_eq!(error.to_string(), "Telegram transport failed");
    assert!(!error.to_string().contains("fixture-secret"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn missing_remote_file_returns_a_sanitized_api_error_without_publishing() {
    let root = root("api-error");
    fs::create_dir_all(&root).unwrap();
    let source = root.join("source");
    fs::write(&source, b"remote-data").unwrap();
    let upload = request(CloudOperation::Upload, "item-e", Some(&source));
    let mut state = CloudJobState::queued(&upload, 1);
    let mut transport = FixtureTransport::default();
    telegram::execute_with(
        &root,
        &upload,
        &mut state,
        &config(),
        &mut transport,
        |_| Ok(()),
        8,
    )
    .unwrap();
    transport.blobs.clear();

    let destination = root.join("restored");
    let download = request(CloudOperation::Download, "item-e", Some(&destination));
    let mut state = CloudJobState::queued(&download, 2);
    let error = telegram::execute_with(
        &root,
        &download,
        &mut state,
        &config(),
        &mut transport,
        |_| Ok(()),
        8,
    )
    .unwrap_err();
    assert_eq!(error.to_string(), "Telegram API request failed");
    assert!(!error.to_string().contains("fixture-secret"));
    assert!(!destination.exists());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn configuration_is_dpapi_protected_and_loadable_for_status() {
    let root = root("dpapi");
    let mut input = br#"{"token":"123456:fixture-secret","channelId":"-100123456"}"#.as_slice();
    telegram::configure_from_reader(&root, &mut input).unwrap();
    let stored = fs::read(root.join("telegram-config.dpapi")).unwrap();
    assert!(!stored
        .windows(b"fixture-secret".len())
        .any(|window| window == b"fixture-secret"));
    assert!(telegram::protected_config_available(&root));
    let loaded = telegram::ProtectedConfigLoader::new(&root).load().unwrap();
    assert!(!format!("{loaded:?}").contains("fixture-secret"));
    fs::remove_dir_all(root).unwrap();
}
