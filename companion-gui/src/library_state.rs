//! Persistent metadata for media files in the Companion library.
//!
//! The file is deliberately independent of the UI and player process.  A
//! media key contains no folder path, so moving a file between the configured
//! download folder and one of its library folders does not lose its metadata.

use crate::jobs::{self, MediaFile};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// The largest library document accepted from disk.
pub const MAX_LIBRARY_STATE_BYTES: usize = 256 * 1024;

/// The maximum number of metadata records retained after loading.
pub const MAX_LIBRARY_ENTRIES: usize = 10_000;

/// Positions below this value do not make a file appear in progress.
pub const MIN_RESUME_POSITION_SECONDS: f64 = 5.0;

/// A file is completed after at least this fraction has been played.
pub const COMPLETED_POSITION_FRACTION: f64 = 0.95;

/// Keep marker metadata bounded even when a sidecar is hand-edited.
pub const MAX_POSE_MARKERS: usize = 64;

/// Adding a marker near an existing one toggles that marker off.
pub const POSE_MARKER_TOGGLE_TOLERANCE_SECONDS: f64 = 0.75;

const POSE_MARKER_DEDUP_TOLERANCE_SECONDS: f64 = 0.25;

const LIBRARY_STATE_FILE_NAME: &str = "library-state.json";

/// The three user-facing states derived from saved playback metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WatchState {
    /// No meaningful resume position has been saved.
    Unwatched,
    /// Playback has started but has not reached the completion threshold.
    InProgress,
    /// Playback reached the completion threshold, or the user forced watched.
    Completed,
}

/// Metadata saved for one media key.
///
/// `rating` is normalized to 0..=5, positions are non-negative finite
/// seconds, and `watched_override` is `Some` only when the user explicitly
/// chose a watched state.  The normalization is also applied when loading
/// older or hand-edited JSON.
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
    fn normalized(mut self) -> Self {
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

    /// Derives the watch state from the optional override and saved position.
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

/// The serde-backed document stored in `library-state.json`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LibraryState {
    /// Metadata indexed by [`media_key`].
    pub entries: BTreeMap<String, LibraryMetadata>,
    #[serde(skip)]
    dirty: bool,
}

impl LibraryState {
    /// Loads the state from the current Companion root.
    ///
    /// A missing, corrupt, non-object, or oversized document is treated as an
    /// empty state. Other filesystem errors are returned to the caller.
    pub fn load() -> io::Result<Self> {
        Self::load_in(&jobs::companion_root()?)
    }

    /// Loads the state from an explicit Companion root, which is useful for
    /// tests and for callers that already resolved the root.
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

    /// Returns whether a mutation has happened since the last successful save.
    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// Looks up metadata for a media file without creating a record.
    pub fn metadata_for(&self, media: &MediaFile) -> Option<&LibraryMetadata> {
        self.entries.get(&media_key(media))
    }

    /// Returns metadata or defaults when the file has not been seen before.
    pub fn metadata_or_default(&self, media: &MediaFile) -> LibraryMetadata {
        self.metadata_for(media).cloned().unwrap_or_default()
    }

    /// Returns the derived watch state for a media file.
    pub fn watch_state_for(&self, media: &MediaFile) -> WatchState {
        self.metadata_or_default(media).watch_state()
    }

    /// Applies a metadata edit and returns whether it changed persisted data.
    ///
    /// The closure receives a copy of the current record. If it leaves the
    /// normalized values unchanged, no record is created and no save is needed.
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

    /// Sets and clamps a media rating to 0..=5.
    pub fn set_rating(&mut self, media: &MediaFile, rating: i32, updated_at: u64) -> bool {
        self.update_media(media, updated_at, |metadata| {
            metadata.rating = rating;
        })
    }

    /// Sets the favorite flag.
    pub fn set_favorite(&mut self, media: &MediaFile, favorite: bool, updated_at: u64) -> bool {
        self.update_media(media, updated_at, |metadata| {
            metadata.favorite = favorite;
        })
    }

    /// Toggles and returns the new favorite flag.
    pub fn toggle_favorite(&mut self, media: &MediaFile, updated_at: u64) -> bool {
        let favorite = !self.metadata_or_default(media).favorite;
        self.set_favorite(media, favorite, updated_at);
        favorite
    }

    /// Sets or clears the explicit watched override.
    pub fn set_watched_override(
        &mut self,
        media: &MediaFile,
        watched: Option<bool>,
        updated_at: u64,
    ) -> bool {
        self.update_media(media, updated_at, |metadata| {
            metadata.watched_override = watched;
        })
    }

    /// Saves a resume position and duration in seconds, clamping invalid
    /// values and ensuring the position never exceeds the duration.
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

    /// Adds a pose-start marker at the current position, or removes the
    /// nearest marker when it is already within the toggle tolerance.
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

    /// Persists changed state to the current Companion root.
    ///
    /// Returns `true` when bytes were written and `false` for a no-op save.
    pub fn persist(&mut self) -> io::Result<bool> {
        self.persist_in(&jobs::companion_root()?)
    }

    /// Atomically persists changed state to an explicit Companion root.
    ///
    /// The parent directory is created as needed. A clean state is not
    /// serialized, so no-op updates do not rewrite the JSON file.
    pub fn persist_in(&mut self, root: &Path) -> io::Result<bool> {
        if !self.dirty {
            return Ok(false);
        }
        self.normalize();
        let bytes = serde_json::to_vec_pretty(self).map_err(io::Error::other)?;
        let path = library_state_path(root);
        write_atomic(&path, &bytes)?;
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

/// Returns the path used for persistent Companion library metadata.
pub fn library_state_path(root: &Path) -> PathBuf {
    root.join(LIBRARY_STATE_FILE_NAME)
}

/// Returns a stable, path-independent key for a listed media file.
///
/// The key uses the file name, byte size, and modification timestamp exposed
/// by [`MediaFile`]. It therefore remains unchanged when only the containing
/// folder changes. File names are case-folded for Windows-style filesystem
/// identity.
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

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("aura-library-state-{label}-{nonce}"))
    }

    fn media(file_name: &str) -> MediaFile {
        MediaFile {
            file_name: file_name.to_string(),
            size: 42,
            modified_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn corrupt_and_oversized_documents_are_bounded_to_empty_state() {
        let corrupt_root = temp_root("corrupt");
        fs::create_dir_all(&corrupt_root).expect("root creates");
        fs::write(library_state_path(&corrupt_root), b"{not json").expect("corrupt write");
        assert!(LibraryState::load_in(&corrupt_root)
            .expect("corrupt input is non-fatal")
            .entries
            .is_empty());

        let oversized_root = temp_root("oversized");
        fs::create_dir_all(&oversized_root).expect("root creates");
        fs::write(
            library_state_path(&oversized_root),
            vec![b'x'; MAX_LIBRARY_STATE_BYTES + 1],
        )
        .expect("oversized write");
        assert!(LibraryState::load_in(&oversized_root)
            .expect("oversized input is non-fatal")
            .entries
            .is_empty());

        fs::remove_dir_all(corrupt_root).expect("corrupt root removes");
        fs::remove_dir_all(oversized_root).expect("oversized root removes");
    }

    #[test]
    fn save_and_load_round_trip_uses_atomic_replacement() {
        let root = temp_root("round-trip");
        let file = media("Clip.MP4");
        let mut state = LibraryState::default();
        assert!(state.set_rating(&file, 4, 12));
        assert!(state.set_resume(&file, 30.0, 100.0, 13));
        assert!(state.toggle_pose_marker(&file, 42.25, 100.0, 14));
        assert!(state.persist_in(&root).expect("state persists"));
        assert!(!library_state_path(&root)
            .with_extension("json.tmp")
            .exists());

        let loaded = LibraryState::load_in(&root).expect("state loads");
        assert_eq!(
            loaded.metadata_for(&file).expect("metadata exists").rating,
            4
        );
        assert_eq!(
            loaded
                .metadata_for(&file)
                .expect("metadata exists")
                .last_position,
            30.0
        );
        assert_eq!(
            loaded
                .metadata_for(&file)
                .expect("metadata exists")
                .pose_markers,
            vec![42.25]
        );
        assert!(!loaded.is_dirty());
        fs::remove_dir_all(root).expect("round-trip root removes");
    }

    #[test]
    fn rating_is_clamped_and_favorite_can_be_toggled() {
        let file = media("clip.mp4");
        let mut state = LibraryState::default();
        assert!(state.set_rating(&file, 99, 1));
        assert_eq!(state.metadata_or_default(&file).rating, 5);
        assert!(state.set_rating(&file, -4, 2));
        assert_eq!(state.metadata_or_default(&file).rating, 0);
        assert!(state.toggle_favorite(&file, 3));
        assert!(state.metadata_or_default(&file).favorite);
        assert!(!state.toggle_favorite(&file, 4));
        assert!(!state.metadata_or_default(&file).favorite);
    }

    #[test]
    fn resume_thresholds_and_completed_derivation_are_stable() {
        let file = media("clip.mp4");
        let mut state = LibraryState::default();
        assert_eq!(state.watch_state_for(&file), WatchState::Unwatched);
        assert!(state.set_resume(&file, 4.99, 100.0, 1));
        assert_eq!(state.watch_state_for(&file), WatchState::Unwatched);
        assert!(state.set_resume(&file, 5.0, 100.0, 2));
        assert_eq!(state.watch_state_for(&file), WatchState::InProgress);
        assert!(state.set_resume(&file, 95.0, 100.0, 3));
        assert_eq!(state.watch_state_for(&file), WatchState::Completed);
        assert!(state.set_watched_override(&file, Some(false), 4));
        assert_eq!(state.watch_state_for(&file), WatchState::Unwatched);
    }

    #[test]
    fn invalid_resume_numbers_are_clamped() {
        let file = media("clip.mp4");
        let mut state = LibraryState::default();
        assert!(
            !state.set_resume(&file, -5.0, f64::NAN, 1),
            "invalid values normalize to the existing default, so this is a no-op"
        );
        let metadata = state.metadata_or_default(&file);
        assert_eq!(metadata.last_position, 0.0);
        assert_eq!(metadata.duration, 0.0);
        assert!(state.set_resume(&file, 500.0, 100.0, 2));
        assert_eq!(state.metadata_or_default(&file).last_position, 100.0);
    }

    #[test]
    fn pose_markers_toggle_nearby_and_remain_sorted() {
        let file = media("clip.mp4");
        let mut state = LibraryState::default();
        assert!(state.toggle_pose_marker(&file, 20.0, 100.0, 1));
        assert!(state.toggle_pose_marker(&file, 5.0, 100.0, 2));
        assert_eq!(
            state.metadata_or_default(&file).pose_markers,
            vec![5.0, 20.0]
        );

        assert!(state.toggle_pose_marker(&file, 20.5, 100.0, 3));
        assert_eq!(state.metadata_or_default(&file).pose_markers, vec![5.0]);
        assert!(!state.toggle_pose_marker(&file, f64::NAN, 100.0, 4));
    }

    #[test]
    fn loaded_pose_markers_are_clamped_deduplicated_and_bounded() {
        let mut metadata = LibraryMetadata {
            duration: 10.0,
            pose_markers: (0..=MAX_POSE_MARKERS + 5)
                .map(|index| index as f64)
                .chain([f64::NAN, -1.0, 2.1])
                .collect(),
            ..LibraryMetadata::default()
        }
        .normalized();
        assert_eq!(metadata.pose_markers.len(), 11);
        assert_eq!(metadata.pose_markers.first(), Some(&0.0));
        assert_eq!(metadata.pose_markers.last(), Some(&10.0));
        assert_eq!(
            metadata
                .pose_markers
                .iter()
                .filter(|marker| **marker == 2.0)
                .count(),
            1
        );

        metadata.duration = 1_000.0;
        metadata.pose_markers = (0..MAX_POSE_MARKERS + 5)
            .map(|index| index as f64)
            .collect();
        assert_eq!(metadata.normalized().pose_markers.len(), MAX_POSE_MARKERS);
    }

    #[test]
    fn no_op_updates_do_not_mark_state_dirty_or_rewrite() {
        let root = temp_root("no-op");
        let file = media("clip.mp4");
        let mut state = LibraryState::default();
        assert!(!state.set_rating(&file, 0, 1));
        assert!(!state.is_dirty());
        assert!(!state.persist_in(&root).expect("no-op save succeeds"));

        assert!(state.set_rating(&file, 3, 1));
        assert!(state.persist_in(&root).expect("initial save succeeds"));
        let before = fs::read(library_state_path(&root)).expect("saved bytes");
        assert!(!state.set_rating(&file, 3, 999));
        assert!(!state.persist_in(&root).expect("no-op save succeeds"));
        let after = fs::read(library_state_path(&root)).expect("saved bytes remain");
        assert_eq!(before, after);
        fs::remove_dir_all(root).expect("no-op root removes");
    }

    #[test]
    fn media_key_survives_folder_moves() {
        let file = media("folder\u{5f71}\u{7247}.mkv");
        let moved = file.clone();
        assert_eq!(media_key(&file), media_key(&moved));
        assert_eq!(
            media_key(&file),
            media_key(&MediaFile {
                file_name: file.file_name.clone(),
                size: file.size,
                modified_at: file.modified_at,
            })
        );
    }
}
