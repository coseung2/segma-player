//! Persistent, UI-independent metadata for files in the Companion library.
//!
//! The metadata file stays under the Companion root and keys do not contain a
//! folder path. Moving a file between the configured library root and one of
//! its direct collection folders therefore preserves its metadata.

use crate::jobs::{self, MediaFile};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub const MAX_LIBRARY_STATE_BYTES: usize = 256 * 1024;
pub const MAX_LIBRARY_ENTRIES: usize = 10_000;
pub const MIN_RESUME_POSITION_SECONDS: f64 = 5.0;
pub const COMPLETED_POSITION_FRACTION: f64 = 0.95;
pub const MAX_POSE_MARKERS: usize = 64;
pub const POSE_MARKER_TOGGLE_TOLERANCE_SECONDS: f64 = 0.75;
const POSE_MARKER_DEDUP_TOLERANCE_SECONDS: f64 = 0.25;
const LIBRARY_STATE_FILE_NAME: &str = "library-state.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WatchState {
    Unwatched,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LibraryMetadata {
    #[serde(default)]
    pub rating: i32,
    #[serde(default)]
    pub favorite: bool,
    #[serde(rename = "watchedOverride", alias = "watched", default)]
    pub watched_override: Option<bool>,
    #[serde(rename = "lastPosition", alias = "position", default)]
    pub last_position: f64,
    #[serde(default)]
    pub duration: f64,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: u64,
    #[serde(rename = "poseMarkers", default)]
    pub pose_markers: Vec<f64>,
}

impl Default for LibraryMetadata {
    fn default() -> Self {
        Self {
            rating: 0,
            favorite: false,
            watched_override: None,
            last_position: 0.0,
            duration: 0.0,
            updated_at: 0,
            pose_markers: Vec::new(),
        }
    }
}

impl LibraryMetadata {
    pub fn normalized(mut self) -> Self {
        self.rating = self.rating.clamp(0, 5);
        self.duration = finite_non_negative(self.duration);
        self.last_position = finite_non_negative(self.last_position);
        if self.duration > 0.0 {
            self.last_position = self.last_position.min(self.duration);
        }
        self.pose_markers
            .retain(|marker| marker.is_finite() && *marker >= 0.0);
        if self.duration > 0.0 {
            for marker in &mut self.pose_markers {
                *marker = marker.min(self.duration);
            }
        }
        self.pose_markers.sort_by(f64::total_cmp);
        self.pose_markers
            .dedup_by(|left, right| (*left - *right).abs() <= POSE_MARKER_DEDUP_TOLERANCE_SECONDS);
        self.pose_markers.truncate(MAX_POSE_MARKERS);
        self
    }

    pub fn watch_state(&self) -> WatchState {
        if let Some(watched) = self.watched_override {
            return if watched {
                WatchState::Completed
            } else {
                WatchState::Unwatched
            };
        }
        let metadata = self.clone().normalized();
        if metadata.duration > 0.0
            && metadata.last_position / metadata.duration >= COMPLETED_POSITION_FRACTION
        {
            WatchState::Completed
        } else if metadata.last_position >= MIN_RESUME_POSITION_SECONDS {
            WatchState::InProgress
        } else {
            WatchState::Unwatched
        }
    }
}

fn finite_non_negative(value: f64) -> f64 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LibraryState {
    pub entries: BTreeMap<String, LibraryMetadata>,
    #[serde(skip)]
    dirty: bool,
}

impl LibraryState {
    pub fn load() -> io::Result<Self> {
        Self::load_in(&jobs::companion_root()?)
    }

    pub fn load_in(root: &Path) -> io::Result<Self> {
        let path = library_state_path(root);
        let bytes = match fs::read(path) {
            Ok(bytes) if bytes.len() <= MAX_LIBRARY_STATE_BYTES => bytes,
            Ok(_) => return Ok(Self::default()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(error) => return Err(error),
        };
        let mut state = match serde_json::from_slice::<Self>(&bytes) {
            Ok(state) => state,
            Err(_) => return Ok(Self::default()),
        };
        state.normalize();
        state.dirty = false;
        Ok(state)
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    pub fn metadata_for(&self, media: &MediaFile) -> Option<&LibraryMetadata> {
        self.entries.get(&media_key(media))
    }

    pub fn metadata_or_default(&self, media: &MediaFile) -> LibraryMetadata {
        self.metadata_for(media).cloned().unwrap_or_default()
    }

    pub fn watch_state_for(&self, media: &MediaFile) -> WatchState {
        self.metadata_or_default(media).watch_state()
    }

    pub fn update_media<F>(&mut self, media: &MediaFile, updated_at: u64, update: F) -> bool
    where
        F: FnOnce(&mut LibraryMetadata),
    {
        let key = media_key(media);
        let existing = self.entries.get(&key).cloned();
        let mut metadata = existing.clone().unwrap_or_default();
        update(&mut metadata);
        metadata = metadata.normalized();
        if existing.as_ref() == Some(&metadata) {
            return false;
        }
        if metadata == LibraryMetadata::default() {
            if existing.is_some() {
                self.entries.remove(&key);
                self.dirty = true;
                return true;
            }
            return false;
        }
        metadata.updated_at = updated_at;
        self.entries.insert(key, metadata);
        self.trim_entries();
        self.dirty = true;
        true
    }

    pub fn set_rating(&mut self, media: &MediaFile, rating: i32, updated_at: u64) -> bool {
        self.update_media(media, updated_at, |metadata| metadata.rating = rating)
    }

    pub fn set_favorite(&mut self, media: &MediaFile, favorite: bool, updated_at: u64) -> bool {
        self.update_media(media, updated_at, |metadata| metadata.favorite = favorite)
    }

    pub fn set_watched_override(
        &mut self,
        media: &MediaFile,
        watched: Option<bool>,
        updated_at: u64,
    ) -> bool {
        self.update_media(media, updated_at, |metadata| {
            metadata.watched_override = watched
        })
    }

    pub fn set_resume(
        &mut self,
        media: &MediaFile,
        position: f64,
        duration: f64,
        updated_at: u64,
    ) -> bool {
        self.update_media(media, updated_at, |metadata| {
            metadata.last_position = position;
            metadata.duration = duration;
        })
    }

    pub fn toggle_pose_marker(
        &mut self,
        media: &MediaFile,
        position: f64,
        duration: f64,
        updated_at: u64,
    ) -> bool {
        if !position.is_finite() || !duration.is_finite() || duration <= 0.0 {
            return false;
        }
        let position = position.clamp(0.0, duration);
        self.update_media(media, updated_at, |metadata| {
            metadata.duration = duration;
            if let Some((index, _)) = metadata
                .pose_markers
                .iter()
                .enumerate()
                .map(|(index, marker)| (index, (marker - position).abs()))
                .filter(|(_, distance)| *distance <= POSE_MARKER_TOGGLE_TOLERANCE_SECONDS)
                .min_by(|left, right| left.1.total_cmp(&right.1))
            {
                metadata.pose_markers.remove(index);
            } else {
                metadata.pose_markers.push(position);
            }
        })
    }

    pub fn persist(&mut self) -> io::Result<bool> {
        self.persist_in(&jobs::companion_root()?)
    }

    pub fn persist_in(&mut self, root: &Path) -> io::Result<bool> {
        if !self.dirty {
            return Ok(false);
        }
        self.normalize();
        let bytes = serde_json::to_vec_pretty(self).map_err(io::Error::other)?;
        write_atomic(&library_state_path(root), &bytes)?;
        self.dirty = false;
        Ok(true)
    }

    fn normalize(&mut self) {
        for metadata in self.entries.values_mut() {
            *metadata = metadata.clone().normalized();
        }
        self.trim_entries();
    }

    fn trim_entries(&mut self) {
        while self.entries.len() > MAX_LIBRARY_ENTRIES {
            let Some(key) = self.entries.keys().next().cloned() else {
                break;
            };
            self.entries.remove(&key);
        }
    }
}

pub fn library_state_path(root: &Path) -> PathBuf {
    root.join(LIBRARY_STATE_FILE_NAME)
}

pub fn media_key(media: &MediaFile) -> String {
    format!(
        "v1:{}:{}:{}",
        media.file_name.to_lowercase(),
        media.size,
        media.modified_at
    )
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension("json.tmp");
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    replace_file_atomically(&temporary, path)
}

#[cfg(not(windows))]
fn replace_file_atomically(temporary: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(temporary, destination)
}

#[cfg(windows)]
fn replace_file_atomically(temporary: &Path, destination: &Path) -> io::Result<()> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }
    let source: Vec<u16> = temporary.as_os_str().encode_wide().chain(once(0)).collect();
    let target: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("segma-tauri-state-{label}-{nonce}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn media(name: &str) -> MediaFile {
        MediaFile {
            file_name: name.into(),
            size: 42,
            modified_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn legacy_metadata_aliases_migrate_and_normalize() {
        let path = root("migration");
        fs::write(
            library_state_path(&path),
            br#"{"entries":{"v1:clip.mp4:42:1700000000000":{"rating":99,"watched":true,"position":500,"duration":100}}}"#,
        )
        .unwrap();
        let state = LibraryState::load_in(&path).unwrap();
        let metadata = state.metadata_for(&media("clip.mp4")).unwrap();
        assert_eq!(metadata.rating, 5);
        assert_eq!(metadata.watched_override, Some(true));
        assert_eq!(metadata.last_position, 100.0);
        assert_eq!(metadata.watch_state(), WatchState::Completed);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn settings_like_metadata_round_trip_is_atomic_and_noop_safe() {
        let path = root("round-trip");
        let file = media("Clip.MP4");
        let mut state = LibraryState::default();
        assert!(state.set_rating(&file, 4, 12));
        assert!(state.set_resume(&file, 30.0, 100.0, 13));
        assert!(state.persist_in(&path).unwrap());
        assert!(!state.persist_in(&path).unwrap());
        let loaded = LibraryState::load_in(&path).unwrap();
        assert_eq!(loaded.metadata_for(&file).unwrap().rating, 4);
        assert_eq!(loaded.metadata_for(&file).unwrap().last_position, 30.0);
        assert!(!loaded.is_dirty());
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn resume_thresholds_and_invalid_numbers_are_safe() {
        let file = media("clip.mp4");
        let mut state = LibraryState::default();
        assert!(!state.set_resume(&file, -5.0, f64::NAN, 1));
        assert_eq!(state.watch_state_for(&file), WatchState::Unwatched);
        assert!(state.set_resume(&file, 5.0, 100.0, 2));
        assert_eq!(state.watch_state_for(&file), WatchState::InProgress);
        assert!(state.set_resume(&file, 95.0, 100.0, 3));
        assert_eq!(state.watch_state_for(&file), WatchState::Completed);
        assert!(state.set_watched_override(&file, Some(false), 4));
        assert_eq!(state.watch_state_for(&file), WatchState::Unwatched);
    }
}
