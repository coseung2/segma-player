//! Periodic disk snapshot for the manager window.
//!
//! The native host and GUI remain separate processes. This controller owns the
//! timer and the last coherent disk snapshot while `ManagerApp` only decides
//! which view consumes it.

use std::time::{Duration, Instant};

use crate::jobs::{self, JobState, LibraryFolder, MediaFile};
use crate::model::RestartableJobs;

pub(crate) const POLL_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PollResult {
    Skipped,
    Updated,
    SelectedFolderMissing,
}

pub(crate) struct ManagerPoll {
    pub(crate) jobs: Vec<JobState>,
    pub(crate) media_files: Vec<MediaFile>,
    pub(crate) restartable: RestartableJobs,
    pub(crate) read_error: Option<String>,
    pub(crate) downloads_folder: Option<String>,
    pub(crate) library_folders: Vec<LibraryFolder>,
    last_poll: Instant,
}

impl Default for ManagerPoll {
    fn default() -> Self {
        Self {
            jobs: Vec::new(),
            media_files: Vec::new(),
            restartable: RestartableJobs::new(),
            read_error: None,
            downloads_folder: jobs::downloads_dir()
                .ok()
                .map(|path| path.to_string_lossy().into_owned()),
            library_folders: Vec::new(),
            last_poll: Instant::now() - POLL_INTERVAL,
        }
    }
}

impl ManagerPoll {
    pub(crate) fn refresh(&mut self, force: bool, selected_folder: Option<&str>) -> PollResult {
        if !force && self.last_poll.elapsed() < POLL_INTERVAL {
            return PollResult::Skipped;
        }
        self.last_poll = Instant::now();

        match jobs::read_jobs() {
            Ok(jobs) => {
                self.restartable = jobs::restartable_ids(
                    &jobs
                        .iter()
                        .map(|job| job.job_id.clone())
                        .collect::<Vec<_>>(),
                );
                self.jobs = jobs;
                self.read_error = None;
            }
            Err(error) => self.read_error = Some(error.to_string()),
        }

        // The extension can change this setting while the window is open.
        self.downloads_folder = jobs::downloads_dir()
            .ok()
            .map(|path| path.to_string_lossy().into_owned());
        self.library_folders = jobs::read_library_folders().unwrap_or_default();

        if selected_folder.is_some_and(|selected| {
            !self
                .library_folders
                .iter()
                .any(|folder| folder.name == selected)
        }) {
            return PollResult::SelectedFolderMissing;
        }

        self.media_files = jobs::read_media_files_in_folder(selected_folder).unwrap_or_default();
        PollResult::Updated
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_controller_is_immediately_pollable() {
        let controller = ManagerPoll::default();
        assert!(controller.last_poll.elapsed() >= POLL_INTERVAL);
    }

    #[test]
    fn poll_result_keeps_skip_and_missing_folder_distinct() {
        assert_ne!(PollResult::Skipped, PollResult::SelectedFolderMissing);
        assert_ne!(PollResult::Updated, PollResult::SelectedFolderMissing);
    }

    #[test]
    fn refresh_respects_the_interval_without_touching_the_snapshot() {
        let mut controller = ManagerPoll::default();
        controller.jobs.push(JobState {
            job_id: "preserved".into(),
            ..JobState::default()
        });
        controller.last_poll = Instant::now();

        assert_eq!(controller.refresh(false, None), PollResult::Skipped);
        assert_eq!(controller.jobs[0].job_id, "preserved");
    }
}
