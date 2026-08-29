//! Reusable pieces that correspond to the Figma components.
//!
//! Each function here maps to one component on the `Components` page so the
//! native window and the design stay in step: button, status chip, media type
//! chip, progress bar, nav item, and the job row.

use eframe::egui::{self, Color32, Response, RichText, Sense, TextureHandle, Ui, Vec2};

use crate::icons::{self, Icon};
use crate::model::{Action, JobView};
use crate::theme::{color, corner, hairline, margin_xy, metric, radius, text, Tone};

/// Button / Primary, Secondary, Quiet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ButtonStyle {
    Primary,
    Inverse,
    Secondary,
    Quiet,
    Danger,
}

const HOVER_MOTION_TIME: f32 = 0.12;
const PRESS_MOTION_TIME: f32 = 0.10;
const CLICK_PULSE_TIME: f64 = 0.14;

/// Library drag-to-folder motion. Feedback is painted outside the widget rect
/// so a hovered drop target never reflows the chip row.
pub const DROP_TARGET_MOTION_TIME: f32 = 0.12;
pub const DRAG_LIFT_MOTION_TIME: f32 = 0.10;
/// Post-drop settle length. Long enough to read as "landed here", short enough
/// that it can never be mistaken for selection state.
pub const DROP_SETTLE_TIME: f64 = 0.42;
/// Faked scale-up, in points, for a hovered drop target.
const DROP_TARGET_MAX_GROWTH: f32 = 3.0;
/// How far the settle ring travels outward before it fades out.
const DROP_SETTLE_MAX_SPREAD: f32 = 7.0;

/// Remaining settle progress: `1.0` at the moment of the drop, `0.0` once the
/// animation window has passed. Pure so the lifecycle is testable.
pub fn drop_settle_progress(now: f64, until: f64, duration: f64) -> f32 {
    if duration <= 0.0 || now >= until {
        return 0.0;
    }
    let remaining = (until - now).min(duration);
    (remaining / duration).clamp(0.0, 1.0) as f32
}

/// Outward growth used to read as a scale-up without allocating extra space.
pub fn drop_target_growth(progress: f32) -> f32 {
    DROP_TARGET_MAX_GROWTH * progress.clamp(0.0, 1.0)
}

/// Accent halo on the folder chip currently under a dragged library file.
pub fn paint_drop_target_emphasis(ui: &Ui, rect: egui::Rect, progress: f32) {
    let progress = progress.clamp(0.0, 1.0);
    if progress <= 0.0 {
        return;
    }
    let grown = rect.expand(drop_target_growth(progress));
    ui.painter().rect_filled(
        grown,
        corner(radius::MD),
        color::ACCENT.gamma_multiply(progress * 0.12),
    );
    ui.painter().rect_stroke(
        grown,
        corner(radius::MD),
        egui::Stroke::new(1.0 + progress, color::ACCENT.gamma_multiply(progress)),
        egui::StrokeKind::Outside,
    );
}

/// Lifts the card being dragged so the pointer clearly carries one file.
pub fn paint_drag_lift(ui: &Ui, rect: egui::Rect, progress: f32) {
    let progress = progress.clamp(0.0, 1.0);
    if progress <= 0.0 {
        return;
    }
    ui.painter().rect_filled(
        rect,
        corner(radius::LG),
        color::BG_INVERSE.gamma_multiply(progress * 0.08),
    );
    ui.painter().rect_stroke(
        rect.expand(progress * 2.0),
        corner(radius::LG),
        egui::Stroke::new(1.0 + progress, color::ACCENT.gamma_multiply(progress * 0.9)),
        egui::StrokeKind::Outside,
    );
}

/// One-shot completion ring on the folder that just received a file.
pub fn paint_drop_settle(ui: &Ui, rect: egui::Rect, progress: f32) {
    let progress = progress.clamp(0.0, 1.0);
    if progress <= 0.0 {
        return;
    }
    let spread = DROP_SETTLE_MAX_SPREAD * (1.0 - progress);
    ui.painter().rect_filled(
        rect,
        corner(radius::MD),
        color::ACCENT.gamma_multiply(progress * 0.14),
    );
    ui.painter().rect_stroke(
        rect.expand(spread),
        corner(radius::MD),
        egui::Stroke::new(1.5, color::ACCENT.gamma_multiply(progress)),
        egui::StrokeKind::Outside,
    );
}

/// Returns animated hover/press progress. A short post-click pulse keeps a
/// fast pointer click perceptible instead of relying on one-frame state.
pub(crate) fn interaction_state(ui: &Ui, response: &Response) -> (f32, f32) {
    let now = ui.input(|input| input.time);
    if response.clicked() {
        ui.ctx().data_mut(|data| {
            data.insert_temp(
                response.id.with("click-pulse-until"),
                now + CLICK_PULSE_TIME,
            );
        });
    }
    let pulse_until = ui
        .ctx()
        .data(|data| data.get_temp::<f64>(response.id.with("click-pulse-until")))
        .unwrap_or(0.0);
    let hovering = ui.ctx().animate_bool_with_time(
        response.id.with("hover"),
        response.hovered(),
        HOVER_MOTION_TIME,
    );
    let pressing = ui.ctx().animate_bool_with_time(
        response.id.with("press"),
        response.is_pointer_button_down_on() || now < pulse_until,
        PRESS_MOTION_TIME,
    );
    (hovering, pressing)
}

pub(crate) fn paint_button_motion(
    ui: &Ui,
    response: &Response,
    style: ButtonStyle,
    hovering: f32,
    pressing: f32,
) {
    if hovering > 0.0 {
        let hover_fill = if style == ButtonStyle::Danger {
            color::BG_DANGER
        } else {
            color::BG_SUBTLE
        };
        ui.painter().rect_filled(
            response.rect,
            corner(radius::MD),
            hover_fill.gamma_multiply(hovering * 0.9),
        );
    }
    if pressing > 0.0 {
        ui.painter().rect_filled(
            response.rect,
            corner(radius::MD),
            color::BG_INVERSE.gamma_multiply(pressing * 0.10),
        );
    }
}

pub fn button(ui: &mut Ui, label: &str, style: ButtonStyle, enabled: bool) -> Response {
    let (fill, stroke, foreground) = match style {
        ButtonStyle::Primary => (color::ACCENT, egui::Stroke::NONE, color::TEXT_INVERSE),
        ButtonStyle::Inverse => (color::BG_INVERSE, egui::Stroke::NONE, color::TEXT_INVERSE),
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
        ButtonStyle::Danger => (color::BG_DANGER, egui::Stroke::NONE, color::TEXT_DANGER),
    };

    let widget = egui::Button::new(RichText::new(label).size(text::LABEL_MD).color(foreground))
        .fill(fill)
        .stroke(stroke)
        .corner_radius(corner(radius::MD))
        .min_size(Vec2::new(0.0, metric::CONTROL_HEIGHT));

    let response = ui.add_enabled(enabled, widget);
    let (hovering, pressing) = interaction_state(ui, &response);
    paint_button_motion(ui, &response, style, hovering, pressing);
    response
}

/// Square icon-only control. The hit area is always the shared control height,
/// so a row of icon buttons lines up with text buttons and chips.
pub fn icon_button(
    ui: &mut Ui,
    icon: Icon,
    accessible_label: &str,
    style: ButtonStyle,
    enabled: bool,
) -> Response {
    let (fill, stroke, foreground) = match style {
        ButtonStyle::Primary => (color::ACCENT, egui::Stroke::NONE, color::TEXT_INVERSE),
        ButtonStyle::Inverse => (color::BG_INVERSE, egui::Stroke::NONE, color::TEXT_INVERSE),
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
        ButtonStyle::Danger => (color::BG_DANGER, egui::Stroke::NONE, color::TEXT_DANGER),
    };

    let response = ui.add_enabled(
        enabled,
        egui::Button::new("")
            .fill(fill)
            .stroke(stroke)
            .corner_radius(corner(radius::MD))
            .min_size(Vec2::splat(metric::CONTROL_HEIGHT)),
    );
    let (hovering, pressing) = interaction_state(ui, &response);
    paint_button_motion(ui, &response, style, hovering, pressing);
    let tint = if enabled {
        foreground
    } else {
        color::TEXT_MUTED
    };
    let icon_size = metric::ICON_SM - pressing;
    icons::paint_centered(
        ui,
        icon,
        egui::Rect::from_center_size(
            response.rect.center() + egui::vec2(0.0, pressing),
            Vec2::splat(icon_size),
        ),
        icon_size,
        tint,
    );
    response.widget_info(|| {
        egui::WidgetInfo::labeled(egui::WidgetType::Button, enabled, accessible_label)
    });
    response
}

/// One row inside a popup menu: leading icon, label, single background layer.
pub fn menu_row(ui: &mut Ui, icon: Icon, label: &str, danger: bool) -> Response {
    let height = metric::CONTROL_HEIGHT;
    let width = ui.available_width();
    let response = ui.allocate_response(Vec2::new(width, height), Sense::click());
    let foreground = if danger {
        color::TEXT_DANGER
    } else {
        color::TEXT_PRIMARY
    };

    let (hovering, pressing) = interaction_state(ui, &response);
    if hovering > 0.0 {
        ui.painter().rect_filled(
            response.rect,
            corner(radius::MD),
            if danger {
                color::BG_DANGER.gamma_multiply(hovering)
            } else {
                color::BG_SUBTLE.gamma_multiply(hovering)
            },
        );
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    if pressing > 0.0 {
        ui.painter().rect_filled(
            response.rect,
            corner(radius::MD),
            color::BG_INVERSE.gamma_multiply(pressing * 0.10),
        );
    }

    let icon_rect = egui::Rect::from_min_size(
        egui::pos2(response.rect.left() + 8.0, response.rect.top()),
        Vec2::new(metric::ICON_SM, response.rect.height()),
    );
    icons::paint_centered(ui, icon, icon_rect, metric::ICON_SM, foreground);
    ui.painter().text(
        egui::pos2(icon_rect.right() + 8.0, response.rect.center().y),
        egui::Align2::LEFT_CENTER,
        label,
        egui::FontId::proportional(text::BODY_MD),
        foreground,
    );
    response.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, true, label));
    response
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
pub fn progress(ui: &mut Ui, id_source: &str, percent: Option<u8>, indeterminate: bool) {
    let width = ui.available_width();
    let (rect, _) =
        ui.allocate_exact_size(Vec2::new(width, metric::PROGRESS_HEIGHT), Sense::hover());
    let painter = ui.painter();
    painter.rect_filled(rect, corner(radius::FULL), color::BG_TRACK);
    if let Some(value) = percent {
        let target = f32::from(value.min(100)) / 100.0;
        let ratio = ui.ctx().animate_value_with_time(
            ui.id().with(("job-progress", id_source)),
            target,
            // Download state is persisted about every 750ms and subtitle state
            // is polled every 1.2s. Interpolate through that interval instead
            // of racing to each sample and visibly pausing between updates.
            1.25,
        );
        if ratio > 0.0 {
            let mut filled = rect;
            filled.set_width(rect.width() * ratio);
            painter.rect_filled(filled, corner(radius::FULL), color::ACCENT);
        }
    } else if indeterminate {
        ui.ctx()
            .request_repaint_after(std::time::Duration::from_millis(16));
        let phase = (ui.ctx().input(|input| input.time) * 0.55).fract() as f32;
        let segment = rect.width() * 0.28;
        let travel = rect.width() + segment;
        let left = rect.left() + phase * travel - segment;
        let mut filled = rect;
        filled.set_left(left.max(rect.left()));
        filled.set_right((left + segment).min(rect.right()));
        if filled.width() > 0.0 {
            painter.rect_filled(filled, corner(radius::FULL), color::ACCENT);
        }
    }
}

/// NavItem / Selected and NavItem / Default.
pub fn nav_item(ui: &mut Ui, label: &str, selected: bool) -> Response {
    let width = ui.available_width();
    let response = ui.allocate_response(Vec2::new(width, metric::NAV_ITEM_HEIGHT), Sense::click());
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
        egui::pos2(
            dot_center.x + metric::NAV_DOT_RADIUS + 10.0,
            response.rect.center().y,
        ),
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

            if view.percent.is_some() || view.active || view.paused {
                progress(
                    ui,
                    &view.id,
                    view.percent,
                    view.active && view.percent.is_none(),
                );
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
                            Action::Resume | Action::Retry => ButtonStyle::Secondary,
                            _ => ButtonStyle::Quiet,
                        };
                        let icon = match action {
                            Action::Pause => Icon::Pause,
                            Action::Resume => Icon::Resume,
                            Action::Retry => Icon::Retry,
                            Action::Play => Icon::Play,
                            Action::Cancel => Icon::Cancel,
                            Action::OpenFolder => Icon::FolderOpen,
                        };
                        if icon_button(ui, icon, action.label(), style, true).clicked() {
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

/// MediaTile thumbnail. The image is the object: no surrounding card chrome.
pub fn media_thumbnail(
    ui: &mut Ui,
    texture: Option<&TextureHandle>,
    type_label: &str,
    width: f32,
) -> Response {
    let size = Vec2::new(width, width * 9.0 / 16.0);
    if let Some(texture) = texture {
        return ui.add(
            egui::Image::new(texture)
                .fit_to_exact_size(size)
                .corner_radius(corner(radius::LG))
                .sense(Sense::click_and_drag()),
        );
    }
    let response = ui.allocate_response(size, Sense::click_and_drag());
    ui.painter()
        .rect_filled(response.rect, corner(radius::LG), color::BG_SUBTLE);
    ui.painter().text(
        response.rect.center(),
        egui::Align2::CENTER_CENTER,
        type_label,
        egui::FontId::monospace(text::MONO_SM),
        color::TEXT_MUTED,
    );
    response
}

/// What a library row's overflow menu reported back. `None` means no action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TileMenuEvent {
    Play(String),
    GenerateSubtitle(String),
    Reveal(String),
    MoveTo(String),
    Delete(String),
}

/// Overflow toggle for one library item, placed on its title row.
///
/// The popup is a single surface: rows carry their own hover background, so
/// there is no nested button-inside-menu wrapper.
pub fn tile_menu(ui: &mut Ui, file_name: &str, has_folders: bool) -> Option<TileMenuEvent> {
    let response = icon_button(
        ui,
        Icon::MoreVertical,
        "파일 메뉴",
        ButtonStyle::Quiet,
        true,
    );

    let mut event = None;
    egui::Popup::menu(&response).gap(4.0).show(|ui| {
        ui.spacing_mut().item_spacing = Vec2::new(0.0, 2.0);
        let labels: &[&str] = if has_folders {
            &["재생", "자막 생성", "폴더에서 보기", "폴더로 이동", "삭제"]
        } else {
            &["재생", "자막 생성", "폴더에서 보기", "삭제"]
        };
        let longest = labels
            .iter()
            .map(|label| {
                ui.painter()
                    .layout_no_wrap(
                        (*label).to_string(),
                        egui::FontId::proportional(text::BODY_MD),
                        color::TEXT_PRIMARY,
                    )
                    .rect
                    .width()
            })
            .fold(0.0, f32::max);
        ui.set_width(popup_menu_width(longest));
        if menu_row(ui, Icon::Play, "재생", false).clicked() {
            event = Some(TileMenuEvent::Play(file_name.to_string()));
            ui.close();
        }
        if menu_row(ui, Icon::CaptionsOn, "자막 생성", false).clicked() {
            event = Some(TileMenuEvent::GenerateSubtitle(file_name.to_string()));
            ui.close();
        }
        if menu_row(ui, Icon::FolderOpen, "폴더에서 보기", false).clicked() {
            event = Some(TileMenuEvent::Reveal(file_name.to_string()));
            ui.close();
        }
        if has_folders && menu_row(ui, Icon::FolderMove, "폴더로 이동", false).clicked() {
            event = Some(TileMenuEvent::MoveTo(file_name.to_string()));
            ui.close();
        }
        if menu_row(ui, Icon::Trash, "삭제", true).clicked() {
            event = Some(TileMenuEvent::Delete(file_name.to_string()));
            ui.close();
        }
    });
    event
}

fn popup_menu_width(longest_label_width: f32) -> f32 {
    longest_label_width + metric::ICON_SM + 32.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn popup_width_tracks_its_longest_label_instead_of_a_fixed_minimum() {
        assert_eq!(popup_menu_width(40.0), 40.0 + metric::ICON_SM + 32.0);
        assert_eq!(popup_menu_width(90.0) - popup_menu_width(40.0), 50.0);
        assert!(popup_menu_width(40.0) < 150.0);
    }

    #[test]
    fn drop_settle_fades_out_and_then_stops_costing_anything() {
        let until = 10.0 + DROP_SETTLE_TIME;
        let start = drop_settle_progress(10.0, until, DROP_SETTLE_TIME);
        let middle = drop_settle_progress(10.0 + DROP_SETTLE_TIME / 2.0, until, DROP_SETTLE_TIME);
        assert!((start - 1.0).abs() < 1e-6);
        assert!(middle < start && middle > 0.0);
        assert_eq!(drop_settle_progress(until, until, DROP_SETTLE_TIME), 0.0);
        assert_eq!(
            drop_settle_progress(until + 5.0, until, DROP_SETTLE_TIME),
            0.0
        );
        // A clock that jumped backwards must not exceed a full-strength frame.
        assert!(drop_settle_progress(0.0, until, DROP_SETTLE_TIME) <= 1.0);
    }

    #[test]
    fn drop_target_growth_is_bounded_and_never_negative() {
        assert_eq!(drop_target_growth(0.0), 0.0);
        assert_eq!(drop_target_growth(-1.0), 0.0);
        assert_eq!(drop_target_growth(1.0), DROP_TARGET_MAX_GROWTH);
        assert_eq!(drop_target_growth(4.0), DROP_TARGET_MAX_GROWTH);
        assert!(drop_target_growth(1.0) < metric::CONTROL_HEIGHT / 4.0);
    }

    #[test]
    fn drag_motion_stays_short_enough_to_feel_immediate() {
        assert!(DRAG_LIFT_MOTION_TIME <= HOVER_MOTION_TIME);
        assert!(DROP_TARGET_MOTION_TIME <= HOVER_MOTION_TIME);
        assert!(DROP_SETTLE_TIME < 1.0);
    }
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
