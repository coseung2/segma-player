//! Reusable pieces that correspond to the Figma components.
//!
//! Each function here maps to one component on the `Components` page so the
//! native window and the design stay in step: button, status chip, media type
//! chip, progress bar, nav item, and the job row.

use eframe::egui::{self, Color32, Response, RichText, Sense, Ui, Vec2};

use crate::model::{Action, JobView};
use crate::theme::{color, corner, hairline, margin_xy, metric, radius, text, Tone};

/// Button / Primary, Secondary, Quiet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ButtonStyle {
    Primary,
    Secondary,
    Quiet,
}

pub fn button(ui: &mut Ui, label: &str, style: ButtonStyle, enabled: bool) -> Response {
    let (fill, stroke, foreground) = match style {
        ButtonStyle::Primary => (
            color::BG_INVERSE,
            egui::Stroke::NONE,
            color::TEXT_INVERSE,
        ),
        ButtonStyle::Secondary => (
            color::BG_SURFACE,
            hairline(color::BORDER_DEFAULT),
            color::TEXT_PRIMARY,
        ),
        ButtonStyle::Quiet => (
            Color32::TRANSPARENT,
            egui::Stroke::NONE,
            color::TEXT_SECONDARY,
        ),
    };

    let widget = egui::Button::new(RichText::new(label).size(text::LABEL_MD).color(foreground))
        .fill(fill)
        .stroke(stroke)
        .corner_radius(corner(radius::MD))
        .min_size(Vec2::new(0.0, metric::CONTROL_HEIGHT));

    ui.add_enabled(enabled, widget)
}

/// Status chip and media type chip. Both are pill shaped in the design; the
/// type chip uses the mono label so codes line up between rows.
pub fn chip(ui: &mut Ui, label: &str, tone: Tone, mono: bool) -> Response {
    let size = if mono { text::MONO_SM } else { text::LABEL_SM };
    egui::Frame::new()
        .fill(tone.background())
        .corner_radius(corner(radius::FULL))
        .inner_margin(margin_xy(8.0, 3.0))
        .show(ui, |ui| {
            ui.label(RichText::new(label).size(size).color(tone.foreground()));
        })
        .response
}

/// ProgressBar. `percent` is `None` while the host has not reported enough to
/// know, and the track is drawn alone rather than guessing a position.
pub fn progress(ui: &mut Ui, percent: Option<u8>) {
    let width = ui.available_width();
    let (rect, _) = ui.allocate_exact_size(
        Vec2::new(width, metric::PROGRESS_HEIGHT),
        Sense::hover(),
    );
    let painter = ui.painter();
    painter.rect_filled(rect, corner(radius::FULL), color::BG_TRACK);
    if let Some(value) = percent {
        let ratio = f32::from(value.min(100)) / 100.0;
        if ratio > 0.0 {
            let mut filled = rect;
            filled.set_width(rect.width() * ratio);
            painter.rect_filled(filled, corner(radius::FULL), color::BG_INVERSE);
        }
    }
}

/// NavItem / Selected and NavItem / Default.
pub fn nav_item(ui: &mut Ui, label: &str, selected: bool) -> Response {
    let width = ui.available_width();
    let response = ui.allocate_response(
        Vec2::new(width, metric::NAV_ITEM_HEIGHT),
        Sense::click(),
    );
    let hovered = response.hovered();
    let painter = ui.painter();

    if selected {
        painter.rect_filled(response.rect, corner(radius::MD), color::BG_SELECTED);
    } else if hovered {
        painter.rect_filled(response.rect, corner(radius::MD), color::BG_SUBTLE);
    }

    let dot_color = if selected {
        color::TEXT_PRIMARY
    } else {
        color::TEXT_MUTED
    };
    let dot_center = egui::pos2(
        response.rect.left() + 12.0 + metric::NAV_DOT_RADIUS,
        response.rect.center().y,
    );
    painter.circle_filled(dot_center, metric::NAV_DOT_RADIUS, dot_color);

    let (label_color, label_size) = if selected {
        (color::TEXT_PRIMARY, text::BODY_MD)
    } else {
        (color::TEXT_SECONDARY, text::BODY_MD)
    };
    painter.text(
        egui::pos2(dot_center.x + metric::NAV_DOT_RADIUS + 10.0, response.rect.center().y),
        egui::Align2::LEFT_CENTER,
        label,
        egui::FontId::proportional(label_size),
        label_color,
    );

    if hovered {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    response
}

/// What a job row reported back to the caller. `None` means no click.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RowEvent {
    Pause(String),
    Resume(String),
    Retry(String),
    Play(String),
    Cancel(String),
    OpenFolder,
}

/// JobCard. Progress is only drawn when the host reported a position, and the
/// action buttons come from the model so the row cannot offer a command the
/// protocol does not implement.
pub fn job_row(ui: &mut Ui, view: &JobView) -> Option<RowEvent> {
    let mut event = None;

    egui::Frame::new()
        .fill(color::BG_SURFACE)
        .stroke(hairline(color::BORDER_SUBTLE))
        .corner_radius(corner(radius::LG))
        .inner_margin(margin_xy(16.0, 14.0))
        .show(ui, |ui| {
            ui.spacing_mut().item_spacing = Vec2::new(8.0, 10.0);

            ui.horizontal(|ui| {
                ui.label(
                    RichText::new(&view.title)
                        .size(text::HEADING_SM)
                        .strong()
                        .color(color::TEXT_PRIMARY),
                );
                chip(ui, &view.type_label, Tone::Neutral, true);
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    chip(ui, view.status_label, view.tone, false);
                });
            });

            let mut meta = Vec::new();
            if let Some(language) = &view.language {
                meta.push(language.clone());
            }
            if let Some(detail) = &view.detail {
                meta.push(detail.clone());
            }
            if !meta.is_empty() {
                ui.label(
                    RichText::new(meta.join(" · "))
                        .size(text::BODY_SM)
                        .color(color::TEXT_MUTED),
                );
            }

            if view.percent.is_some() {
                progress(ui, view.percent);
            }

            ui.horizontal(|ui| {
                let transfer = view
                    .transfer
                    .clone()
                    .or_else(|| view.file_name.clone())
                    .unwrap_or_else(|| "—".to_string());
                ui.label(
                    RichText::new(transfer)
                        .size(text::MONO_SM)
                        .color(color::TEXT_SECONDARY),
                );

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    // Right-to-left layout reverses drawing order, so iterate
                    // backwards to keep the model's intended left-to-right order.
                    for action in view.actions.iter().rev() {
                        // The action that continues or repeats work gets the
                        // stronger treatment; stopping stays quiet.
                        let style = match action {
                            Action::Resume | Action::Retry | Action::Play => ButtonStyle::Secondary,
                            _ => ButtonStyle::Quiet,
                        };
                        if button(ui, action.label(), style, true).clicked() {
                            let id = view.id.clone();
                            event = Some(match action {
                                Action::Pause => RowEvent::Pause(id),
                                Action::Resume => RowEvent::Resume(id),
                                Action::Retry => RowEvent::Retry(id),
                                Action::Play => RowEvent::Play(id),
                                Action::Cancel => RowEvent::Cancel(id),
                                Action::OpenFolder => RowEvent::OpenFolder,
                            });
                        }
                    }
                });
            });
        });

    event
}

/// Empty state. Dashed in the design; egui has no dashed frame stroke, so a
/// subtle border is used and the copy carries the meaning instead.
pub fn empty_state(ui: &mut Ui, message: &str) {
    egui::Frame::new()
        .fill(color::BG_SURFACE)
        .stroke(hairline(color::BORDER_DEFAULT))
        .corner_radius(corner(radius::LG))
        .inner_margin(margin_xy(24.0, 32.0))
        .show(ui, |ui| {
            ui.vertical_centered(|ui| {
                ui.label(
                    RichText::new(message)
                        .size(text::BODY_MD)
                        .color(color::TEXT_MUTED),
                );
            });
        });
}

/// SettingRow: title, value, and an optional trailing chip.
pub fn setting_row(ui: &mut Ui, title: &str, value: &str, mono: bool, badge: Option<(&str, Tone)>) {
    ui.horizontal(|ui| {
        ui.vertical(|ui| {
            ui.spacing_mut().item_spacing.y = 2.0;
            ui.label(
                RichText::new(title)
                    .size(text::BODY_MD)
                    .color(color::TEXT_PRIMARY),
            );
            let size = if mono { text::MONO_SM } else { text::BODY_SM };
            ui.label(RichText::new(value).size(size).color(color::TEXT_MUTED));
        });
        if let Some((label, tone)) = badge {
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                chip(ui, label, tone, false);
            });
        }
    });
}
