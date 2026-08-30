//! Library interaction state kept apart from application/window ownership.

use std::collections::HashSet;

use crate::icons::Icon;
use crate::jobs::{LibraryFileRef, LibraryMoveJournal, LibraryOrganizationPlan};
use crate::library_state::LibraryState;
use crate::theme::space;
use crate::widgets::{button, icon_button, ButtonStyle};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LibraryFilter {
    All,
    Favorite,
    Unwatched,
    InProgress,
    Completed,
}

impl LibraryFilter {
    pub(crate) const ALL: [Self; 5] = [
        Self::All,
        Self::Favorite,
        Self::Unwatched,
        Self::InProgress,
        Self::Completed,
    ];

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::All => "전체",
            Self::Favorite => "찜",
            Self::Unwatched => "미시청",
            Self::InProgress => "보는 중",
            Self::Completed => "완료",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LibrarySort {
    Newest,
    Rating,
    Title,
}

impl LibrarySort {
    pub(crate) const ALL: [Self; 3] = [Self::Newest, Self::Rating, Self::Title];

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Newest => "최신순",
            Self::Rating => "별점순",
            Self::Title => "제목순",
        }
    }
}

pub(crate) struct LibraryController {
    pub(crate) search: String,
    pub(crate) filter: LibraryFilter,
    pub(crate) sort: LibrarySort,
    pub(crate) min_rating: i32,
    pub(crate) state: LibraryState,
    pub(crate) pending_delete: Option<String>,
    pub(crate) selection: HashSet<LibraryFileRef>,
    pub(crate) selection_mode: bool,
    pub(crate) pending_batch_delete: bool,
    pub(crate) pending_organization: Option<LibraryOrganizationPlan>,
    pub(crate) organization_journal: Option<LibraryMoveJournal>,
    pub(crate) folder: Option<String>,
    pub(crate) pending_move: Option<String>,
    pub(crate) pending_folder_name: Option<String>,
    pub(crate) pending_folder_rename: Option<(String, String)>,
    pub(crate) dragged_file: Option<String>,
    pub(crate) drop_settle: Option<(Option<String>, f64)>,
}

impl Default for LibraryController {
    fn default() -> Self {
        Self {
            search: String::new(),
            filter: LibraryFilter::All,
            sort: LibrarySort::Newest,
            min_rating: 0,
            state: LibraryState::load().unwrap_or_default(),
            pending_delete: None,
            selection: HashSet::new(),
            selection_mode: false,
            pending_batch_delete: false,
            pending_organization: None,
            organization_journal: None,
            folder: None,
            pending_move: None,
            pending_folder_name: None,
            pending_folder_rename: None,
            dragged_file: None,
            drop_settle: None,
        }
    }
}

impl LibraryController {
    pub(crate) fn show_controls(&mut self, ui: &mut eframe::egui::Ui) {
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing = eframe::egui::Vec2::new(space::X4, space::X4);
            for filter in LibraryFilter::ALL {
                let style = if self.filter == filter {
                    ButtonStyle::Inverse
                } else {
                    ButtonStyle::Quiet
                };
                if button(ui, filter.label(), style, true).clicked() {
                    self.filter = filter;
                }
            }
            ui.add_space(space::X8);
            for rating in 1..=5 {
                let selected = rating <= self.min_rating;
                if icon_button(
                    ui,
                    Icon::Star,
                    &format!("별점 {rating}점 이상"),
                    if selected {
                        ButtonStyle::Primary
                    } else {
                        ButtonStyle::Quiet
                    },
                    true,
                )
                .clicked()
                {
                    self.min_rating = if self.min_rating == rating { 0 } else { rating };
                }
            }
            ui.add_space(space::X8);
            for sort in LibrarySort::ALL {
                let style = if self.sort == sort {
                    ButtonStyle::Secondary
                } else {
                    ButtonStyle::Quiet
                };
                if button(ui, sort.label(), style, true).clicked() {
                    self.sort = sort;
                }
            }
        });
    }

    pub(crate) fn file_ref(&self, file_name: impl Into<String>) -> LibraryFileRef {
        LibraryFileRef::new(self.folder.clone(), file_name)
    }

    pub(crate) fn selection_contains(&self, file_name: &str) -> bool {
        self.selection
            .contains(&self.file_ref(file_name.to_string()))
    }

    pub(crate) fn toggle_selection(&mut self, file_name: &str) {
        let item = self.file_ref(file_name.to_string());
        if !self.selection.remove(&item) {
            self.selection.insert(item);
        }
        self.selection_mode = true;
    }

    pub(crate) fn clear_selection(&mut self) {
        self.selection.clear();
        self.selection_mode = false;
        self.pending_batch_delete = false;
    }

    pub(crate) fn retain_current_folder_selection(&mut self) {
        let folder = self.folder.clone();
        self.selection.retain(|item| item.folder == folder);
        self.selection_mode = !self.selection.is_empty();
        self.pending_batch_delete = false;
    }

    pub(crate) fn select_visible<'a>(
        &mut self,
        entries: impl IntoIterator<Item = &'a crate::model::LibraryEntry>,
    ) {
        let folder = self.folder.clone();
        self.selection.extend(
            entries
                .into_iter()
                .map(|entry| LibraryFileRef::new(folder.clone(), entry.file_name.clone())),
        );
        self.selection_mode = !self.selection.is_empty();
    }

    pub(crate) fn selected_size(&self, media_files: &[crate::jobs::MediaFile]) -> u64 {
        self.selection
            .iter()
            .filter(|item| item.folder == self.folder)
            .filter_map(|item| {
                media_files
                    .iter()
                    .find(|media| media.file_name == item.file_name)
                    .map(|media| media.size)
            })
            .sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controller_starts_without_transient_library_actions() {
        let controller = LibraryController::default();
        assert!(controller.selection.is_empty());
        assert!(!controller.selection_mode);
        assert!(controller.pending_delete.is_none());
        assert!(controller.pending_organization.is_none());
        assert!(controller.dragged_file.is_none());
    }

    #[test]
    fn selection_mode_remains_explicit_after_last_item_is_removed() {
        let mut controller = LibraryController::default();
        controller.toggle_selection("clip.mp4");
        controller.toggle_selection("clip.mp4");
        assert!(controller.selection.is_empty());
        assert!(controller.selection_mode);
        controller.clear_selection();
        assert!(!controller.selection_mode);
    }

    #[test]
    fn filters_and_sorts_have_stable_korean_labels() {
        assert!(LibraryFilter::ALL
            .iter()
            .all(|filter| !filter.label().is_empty()));
        assert!(LibrarySort::ALL.iter().all(|sort| !sort.label().is_empty()));
    }

    #[test]
    fn selected_size_is_scoped_to_the_open_folder() {
        let mut controller = LibraryController::default();
        controller.folder = Some("보관".into());
        controller
            .selection
            .insert(LibraryFileRef::new(Some("보관".into()), "clip.mp4"));
        controller
            .selection
            .insert(LibraryFileRef::new(None, "root.mp4"));
        let media = [crate::jobs::MediaFile {
            file_name: "clip.mp4".into(),
            size: 42,
            modified_at: 1,
        }];
        assert_eq!(controller.selected_size(&media), 42);
    }
}
