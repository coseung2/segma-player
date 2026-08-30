//! Queue-only selection state and derived rows.

use crate::jobs::{JobState, MediaFile};
use crate::model::{self, JobView, RestartableJobs};
use crate::theme::{color, corner, margin, radius, space, text, Tone};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QueueFilter {
    All,
    Active,
    Paused,
    Complete,
    Failed,
}

impl QueueFilter {
    pub(crate) const ALL: [QueueFilter; 5] = [
        QueueFilter::All,
        QueueFilter::Active,
        QueueFilter::Paused,
        QueueFilter::Complete,
        QueueFilter::Failed,
    ];

    pub(crate) fn label(self) -> &'static str {
        match self {
            QueueFilter::All => "전체",
            QueueFilter::Active => "진행 중",
            QueueFilter::Paused => "일시정지",
            QueueFilter::Complete => "완료",
            QueueFilter::Failed => "실패",
        }
    }

    pub(crate) fn matches(self, view: &JobView) -> bool {
        match self {
            QueueFilter::All => true,
            QueueFilter::Active => view.active,
            QueueFilter::Paused => view.paused,
            QueueFilter::Complete => view.tone == Tone::Success,
            QueueFilter::Failed => view.tone == Tone::Danger,
        }
    }
}

pub(crate) struct QueueController {
    pub(crate) filter: QueueFilter,
}

impl Default for QueueController {
    fn default() -> Self {
        Self {
            filter: QueueFilter::All,
        }
    }
}

impl QueueController {
    pub(crate) fn show_filters(&mut self, ui: &mut eframe::egui::Ui) {
        eframe::egui::Frame::new()
            .fill(color::BG_SUBTLE)
            .corner_radius(corner(radius::MD))
            .inner_margin(margin(4.0))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = space::X4;
                    for filter in QueueFilter::ALL {
                        let selected = self.filter == filter;
                        let widget = eframe::egui::Button::new(
                            eframe::egui::RichText::new(filter.label())
                                .size(text::LABEL_MD)
                                .color(if selected {
                                    color::TEXT_PRIMARY
                                } else {
                                    color::TEXT_SECONDARY
                                }),
                        )
                        .fill(if selected {
                            color::BG_SURFACE
                        } else {
                            eframe::egui::Color32::TRANSPARENT
                        })
                        .stroke(eframe::egui::Stroke::NONE)
                        .corner_radius(corner(radius::MD));
                        if ui.add(widget).clicked() {
                            self.filter = filter;
                        }
                    }
                });
            });
    }

    pub(crate) fn rows(
        &self,
        jobs: &[JobState],
        restartable: &RestartableJobs,
        media_files: &[MediaFile],
    ) -> (Vec<JobView>, usize) {
        let all = model::queue_views(jobs, restartable, media_files);
        let total = all.len();
        let visible = all
            .into_iter()
            .filter(|view| self.filter.matches(view))
            .collect();
        (visible, total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view_for(status: &str) -> JobView {
        model::to_view(
            &JobState {
                job_id: "job".into(),
                status: status.into(),
                ..JobState::default()
            },
            true,
            false,
        )
    }

    #[test]
    fn queue_filters_preserve_terminal_and_paused_boundaries() {
        let running = view_for("running");
        let paused = view_for("paused");
        let done = view_for("completed");
        let failed = view_for("failed");

        assert!(QueueFilter::Active.matches(&running));
        assert!(QueueFilter::Paused.matches(&paused));
        assert!(!QueueFilter::Active.matches(&paused));
        assert!(QueueFilter::Complete.matches(&done));
        assert!(QueueFilter::Failed.matches(&failed));
    }

    #[test]
    fn every_queue_filter_has_a_korean_label() {
        for filter in QueueFilter::ALL {
            assert!(filter
                .label()
                .chars()
                .any(|character| !character.is_ascii()));
        }
    }

    #[test]
    fn rows_return_filtered_rows_and_the_unfiltered_total() {
        let jobs = [
            JobState {
                job_id: "running".into(),
                status: "running".into(),
                ..JobState::default()
            },
            JobState {
                job_id: "done".into(),
                status: "completed".into(),
                ..JobState::default()
            },
        ];
        let controller = QueueController {
            filter: QueueFilter::Complete,
        };
        let (rows, total) = controller.rows(&jobs, &RestartableJobs::new(), &[]);
        assert_eq!(total, 2);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "done");
    }
}
