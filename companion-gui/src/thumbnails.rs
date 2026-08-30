//! Local thumbnail extraction for the Library grid.
//!
//! The installer already ships ffmpeg beside the manager. Extraction runs on
//! one background worker so opening a folder with many videos never launches a
//! process storm or blocks egui's render thread.

use std::collections::{HashMap, HashSet};
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

/// UI-side thumbnail ownership. The extraction worker, in-flight keys,
/// unavailable keys, and GPU textures advance together instead of being five
/// unrelated fields on `ManagerApp`.
pub struct ThumbnailCoordinator {
    requests: Sender<ThumbnailRequest>,
    results: Receiver<ThumbnailResult>,
    textures: HashMap<String, eframe::egui::TextureHandle>,
    pending: HashSet<String>,
    unavailable: HashSet<String>,
}

impl Default for ThumbnailCoordinator {
    fn default() -> Self {
        let worker = start_worker();
        Self {
            requests: worker.requests,
            results: worker.results,
            textures: HashMap::new(),
            pending: HashSet::new(),
            unavailable: HashSet::new(),
        }
    }
}

impl ThumbnailCoordinator {
    pub fn sync(
        &mut self,
        context: &eframe::egui::Context,
        folder: Option<&str>,
        media_files: &[MediaFile],
    ) {
        while let Ok(result) = self.results.try_recv() {
            self.pending.remove(&result.key);
            if let Some(image) = result.image {
                let color_image =
                    eframe::egui::ColorImage::from_rgba_unmultiplied(image.size, &image.rgba);
                let texture = context.load_texture(
                    format!("library:{}", result.key),
                    color_image,
                    eframe::egui::TextureOptions::LINEAR,
                );
                self.textures.insert(result.key, texture);
            } else {
                self.unavailable.insert(result.key);
            }
        }

        let Ok(folder) = jobs::library_dir(folder) else {
            return;
        };
        for file in media_files {
            let key = key(file);
            if self.textures.contains_key(&key)
                || self.pending.contains(&key)
                || self.unavailable.contains(&key)
            {
                continue;
            }
            let request = ThumbnailRequest {
                key: key.clone(),
                media_path: folder.join(&file.file_name),
            };
            if self.requests.send(request).is_ok() {
                self.pending.insert(key);
            }
        }
    }

    pub fn forget(&mut self, file: &MediaFile) {
        let key = key(file);
        self.textures.remove(&key);
        self.pending.remove(&key);
        self.unavailable.remove(&key);
    }

    pub fn clear(&mut self) {
        self.textures.clear();
        self.pending.clear();
        self.unavailable.clear();
    }

    pub fn texture(&self, key: &str) -> Option<&eframe::egui::TextureHandle> {
        self.textures.get(key)
    }

    pub fn textures(&self) -> &HashMap<String, eframe::egui::TextureHandle> {
        &self.textures
    }
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

    #[test]
    fn coordinator_forget_and_clear_release_all_ui_state() {
        let mut coordinator = ThumbnailCoordinator::default();
        let file = MediaFile {
            file_name: "clip.mp4".into(),
            size: 100,
            modified_at: 10,
        };
        let cache_key = key(&file);
        coordinator.pending.insert(cache_key.clone());
        coordinator.unavailable.insert(cache_key.clone());
        coordinator.forget(&file);
        assert!(!coordinator.pending.contains(&cache_key));
        assert!(!coordinator.unavailable.contains(&cache_key));

        coordinator.pending.insert("other".into());
        coordinator.unavailable.insert("other".into());
        coordinator.clear();
        assert!(coordinator.pending.is_empty());
        assert!(coordinator.unavailable.is_empty());
        assert!(coordinator.textures.is_empty());
    }
}
