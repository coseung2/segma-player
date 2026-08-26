//! Local thumbnail extraction for the Library grid.
//!
//! The installer already ships ffmpeg beside the manager. Extraction runs on
//! one background worker so opening a folder with many videos never launches a
//! process storm or blocks egui's render thread.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;

use crate::jobs::{self, MediaFile};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct ThumbnailRequest {
    pub key: String,
    pub media_path: PathBuf,
}

pub struct ThumbnailResult {
    pub key: String,
    pub image: Option<DecodedThumbnail>,
}

pub struct DecodedThumbnail {
    pub size: [usize; 2],
    pub rgba: Vec<u8>,
}

pub struct ThumbnailWorker {
    pub requests: Sender<ThumbnailRequest>,
    pub results: Receiver<ThumbnailResult>,
}

pub fn key(file: &MediaFile) -> String {
    format!("{}:{}:{}", file.file_name, file.size, file.modified_at)
}

fn cache_name(key: &str) -> String {
    // FNV-1a is deterministic and sufficient for a disposable local cache.
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in key.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}.jpg")
}

fn cache_path(key: &str) -> io::Result<PathBuf> {
    Ok(jobs::companion_root()?
        .join("thumbnails")
        .join(cache_name(key)))
}

pub(crate) fn ffmpeg_path() -> io::Result<PathBuf> {
    let executable = std::env::current_exe()?;
    let beside_manager = executable
        .parent()
        .unwrap_or(Path::new("."))
        .join("tools")
        .join("ffmpeg")
        .join("ffmpeg.exe");
    if beside_manager.is_file() {
        return Ok(beside_manager);
    }
    let installed = jobs::companion_root()?
        .join("tools")
        .join("ffmpeg")
        .join("ffmpeg.exe");
    installed
        .is_file()
        .then_some(installed)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "ffmpeg is unavailable"))
}

fn decode(path: &Path) -> Option<DecodedThumbnail> {
    let image = image::open(path).ok()?.into_rgba8();
    let (width, height) = image.dimensions();
    Some(DecodedThumbnail {
        size: [width as usize, height as usize],
        rgba: image.into_raw(),
    })
}

fn generate(request: &ThumbnailRequest) -> Option<DecodedThumbnail> {
    let output = cache_path(&request.key).ok()?;
    if output.is_file() {
        return decode(&output);
    }
    let parent = output.parent()?;
    fs::create_dir_all(parent).ok()?;
    let temporary = parent.join(format!("{}.tmp.jpg", cache_name(&request.key)));
    let ffmpeg = ffmpeg_path().ok()?;
    let mut command = Command::new(ffmpeg);
    command
        .args(["-hide_banner", "-loglevel", "error", "-ss", "3"])
        .arg("-i")
        .arg(&request.media_path)
        .args([
            "-frames:v",
            "1",
            "-vf",
            "thumbnail,scale=640:360:force_original_aspect_ratio=increase,crop=640:360",
            "-q:v",
            "4",
            "-y",
        ])
        .arg(&temporary)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let success = command.status().ok()?.success();
    if !success {
        let _ = fs::remove_file(&temporary);
        return None;
    }
    fs::rename(&temporary, &output).ok()?;
    decode(&output)
}

pub fn start_worker() -> ThumbnailWorker {
    let (request_tx, request_rx) = mpsc::channel::<ThumbnailRequest>();
    let (result_tx, result_rx) = mpsc::channel::<ThumbnailResult>();
    thread::Builder::new()
        .name("aura-thumbnail-worker".into())
        .spawn(move || {
            while let Ok(request) = request_rx.recv() {
                let image = generate(&request);
                if result_tx
                    .send(ThumbnailResult {
                        key: request.key,
                        image,
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .expect("thumbnail worker starts");
    ThumbnailWorker {
        requests: request_tx,
        results: result_rx,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_keys_change_when_the_file_changes() {
        let first = MediaFile {
            file_name: "clip.mp4".into(),
            size: 100,
            modified_at: 10,
        };
        let mut changed = first.clone();
        changed.size = 101;
        assert_ne!(key(&first), key(&changed));
        assert_ne!(cache_name(&key(&first)), cache_name(&key(&changed)));
        assert!(cache_name(&key(&first)).ends_with(".jpg"));
    }
}
