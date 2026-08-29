//! Pure egui surface for the embedded local-media player.
//!
//! Playback state stays in the engine. This module only renders a snapshot and
//! returns one command plus host-owned requests for the current frame.

use std::collections::HashMap;

use eframe::egui::{
    self, Align2, Color32, CursorIcon, FontId, Key, Modifiers, Pos2, Rect, Response, RichText,
    Sense, StrokeKind, TextureHandle, Ui, Vec2, WidgetInfo, WidgetType,
};

use crate::icons::{self, Icon};
use crate::model::{self, LibraryEntry};
use crate::player_contract::{
    ColorRangeMode, PhysicalVideoRect, PlayerCommand, PlayerSnapshot, SubtitleTrack, VideoFitMode,
};
use crate::shortcuts::{PlayerShortcuts, ShortcutAction};
use crate::theme::{color, corner, hairline, margin_xy, metric, radius, space, text};
use crate::widgets::{
    icon_button, interaction_state, media_thumbnail, paint_button_motion, ButtonStyle,
};

const VIDEO_ASPECT: f32 = 16.0 / 9.0;
const VIDEO_MIN_HEIGHT: f32 = 220.0;
const VIDEO_MAX_HEIGHT: f32 = 560.0;
/// Every control in the bar shares this height so icons, timecode, and chips
/// sit on one optical line.
const CONTROL_ROW_HEIGHT: f32 = 32.0;
const SCRUBBER_HIT_HEIGHT: f32 = 18.0;
const VOLUME_WIDTH: f32 = 84.0;
const FULLSCREEN_CONTROL_HEIGHT: f32 = 42.0;
const FULLSCREEN_CONTROL_MARGIN: f32 = 16.0;
const FULLSCREEN_CONTROL_ALPHA: f32 = 0.86;
pub const SEEK_PREVIEW_WIDTH: f32 = 192.0;
/// Native preview includes a 108px image and a 28px timecode strip.
pub const SEEK_PREVIEW_HEIGHT: f32 = 136.0;
const PREVIEW_SIZE: Vec2 = Vec2::new(SEEK_PREVIEW_WIDTH, SEEK_PREVIEW_HEIGHT);
const PREVIEW_GAP: f32 = 20.0;
const POSE_MARKER_HIT_RADIUS: f32 = 7.0;
pub(crate) const POSE_MARKER_ACTIVE_TOLERANCE_SECONDS: f64 = 0.75;
const UP_NEXT_COUNT: usize = 4;
const SPEEDS: [f64; 6] = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
pub const PAGE_HEADER_HEIGHT: f32 = 64.0;
/// Top-right page actions are icon-only: no card, no filled surface, no border.
/// The icon sits directly on the page background and discloses its label on
/// hover, which is the only affordance those controls need.
pub const HEADER_ACTION_SIZE: f32 = metric::ICON_SM;

/// One top-right page action. Every screen routes through this so no header
/// grows its own wrapper, fill, or border, and every icon keeps a hover label
/// plus its accessibility name.
pub fn header_action(ui: &mut Ui, icon: Icon, label: &str) -> Response {
    let size = Vec2::splat(HEADER_ACTION_SIZE);
    let (rect, response) = ui.allocate_exact_size(size, Sense::click());
    let hovering = response.hovered();
    if hovering {
        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
    }
    icons::paint_centered(
        ui,
        icon,
        rect,
        HEADER_ACTION_SIZE,
        if hovering {
            color::TEXT_PRIMARY
        } else {
            color::TEXT_SECONDARY
        },
    );
    response.widget_info(|| WidgetInfo::labeled(WidgetType::Button, true, label));
    response.on_hover_text(label)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HoverPreview {
    pub target: f64,
    /// Suggested top-left corner in logical egui points.
    pub placement: Pos2,
    /// Final logical size owned by the surface that produced the hover.
    pub size: Vec2,
}

#[derive(Debug)]
pub struct PlayerUiOutput {
    /// The full 16:9 logical surface reserved by egui.
    pub logical_video_rect: Rect,
    /// The same surface converted to physical pixels for the native child window.
    pub physical_video_rect: PhysicalVideoRect,
    /// Deliberately singular: one frame never floods the engine command queue.
    pub command: Option<PlayerCommand>,
    pub hover_preview: Option<HoverPreview>,
    pub selected_up_next_file: Option<String>,
    pub open_folder_requested: bool,
    pub fullscreen_requested: bool,
    pub gif_requested: bool,
    pub pose_marker_toggle_requested: bool,
    pub rating_requested: Option<i32>,
    pub pip_close_requested: bool,
}

impl Default for PlayerUiOutput {
    fn default() -> Self {
        Self {
            logical_video_rect: Rect::NOTHING,
            physical_video_rect: PhysicalVideoRect::default(),
            command: None,
            hover_preview: None,
            selected_up_next_file: None,
            open_folder_requested: false,
            fullscreen_requested: false,
            gif_requested: false,
            pose_marker_toggle_requested: false,
            rating_requested: None,
            pip_close_requested: false,
        }
    }
}

/// Inputs owned by the containing app. Thumbnail handles use the same keys as
/// the Library grid so the caller can pass its existing texture cache directly.
pub struct PlayerUiInput<'a> {
    pub snapshot: &'a PlayerSnapshot,
    pub up_next: &'a [LibraryEntry],
    pub thumbnail_textures: &'a HashMap<String, TextureHandle>,
    pub pose_markers: &'a [f64],
    pub fullscreen: bool,
    pub shortcuts: PlayerShortcuts,
    pub pro: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum KeyboardAction {
    Command(PlayerCommandKind),
    Fullscreen,
    TogglePoseMarker,
    SetRating(i32),
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum PlayerCommandKind {
    TogglePause,
    SeekRelative(f64),
    SetVolume(f64),
    ToggleMute,
    ToggleSubtitles,
    StepFrameBackward,
    StepFrameForward,
    SetLoopA(f64),
    SetLoopB(f64),
    ClearLoop,
}

/// Render the player screen and report all requested effects to the caller.
pub fn player_view(ui: &mut Ui, input: PlayerUiInput<'_>) -> PlayerUiOutput {
    let snapshot = input.snapshot;
    let mut output = PlayerUiOutput::default();

    if shortcuts_allowed(ui.ctx()) {
        if let Some(action) = read_keyboard_action(ui, snapshot, input.fullscreen, input.shortcuts)
        {
            apply_keyboard_action(action, &mut output);
        }
    }

    if input.fullscreen {
        fullscreen_player(ui, snapshot, input.pose_markers, &mut output);
    } else {
        header(ui, snapshot, &mut output);
        let available_width = ui.available_width();
        let video_height =
            (available_width / VIDEO_ASPECT).clamp(VIDEO_MIN_HEIGHT, VIDEO_MAX_HEIGHT);
        let video_width = (video_height * VIDEO_ASPECT).min(available_width);
        let start = ui.next_widget_position();
        let video_rect = Rect::from_min_size(
            Pos2::new(start.x + (available_width - video_width) / 2.0, start.y),
            Vec2::new(video_width, video_height),
        );
        let video_response = ui.allocate_rect(video_rect, Sense::click());
        paint_video_surface(ui, video_rect, &video_response, snapshot);
        if video_response.clicked() {
            set_command(&mut output, PlayerCommand::TogglePause);
        }
        output.logical_video_rect = video_rect;
        output.physical_video_rect = physical_rect(ui, video_rect);

        ui.add_space(space::X12);
        control_bar(ui, snapshot, input.pose_markers, input.pro, &mut output);

        ui.add_space(space::X16);
        up_next_row(ui, input.up_next, input.thumbnail_textures, &mut output);
    }
    output
}

/// Fullscreen keeps the video dominant and reveals the controls from the
/// bottom edge only while the pointer is in the lower control zone.
fn fullscreen_player(
    ui: &mut Ui,
    snapshot: &PlayerSnapshot,
    pose_markers: &[f64],
    output: &mut PlayerUiOutput,
) {
    let available = ui.available_rect_before_wrap();
    let context = ui.ctx().clone();
    let hover_memory_id = ui.id().with("fullscreen-control-overlay-hover");
    let overlay_hovered = context
        .data(|data| data.get_temp::<bool>(hover_memory_id))
        .unwrap_or(false);
    let bottom_hover = context.input(|input| {
        input.focused
            && input.pointer.hover_pos().is_some_and(|pointer| {
                pointer.x >= available.left()
                    && pointer.x <= available.right()
                    && pointer.y
                        >= available.bottom()
                            - FULLSCREEN_CONTROL_HEIGHT
                            - FULLSCREEN_CONTROL_MARGIN * 2.0
                    && pointer.y <= available.bottom()
            })
    });
    let controls_requested = bottom_hover || overlay_hovered;
    let control_progress = context.animate_bool_with_time(
        ui.id().with("fullscreen-controls"),
        controls_requested,
        0.18,
    );
    let (video_rect, controls_rect) = fullscreen_layout(available, control_progress);
    let video_response = ui.interact(video_rect, ui.id().with("fullscreen-video"), Sense::click());
    paint_video_surface(ui, video_rect, &video_response, snapshot);
    if video_response.clicked() {
        set_command(output, PlayerCommand::TogglePause);
    }
    output.logical_video_rect = video_rect;
    output.physical_video_rect = physical_rect(ui, video_rect);

    if control_progress > 0.01 {
        let parent_origin = context
            .input(|input| input.viewport().inner_rect.map(|rect| rect.min))
            .unwrap_or(Pos2::ZERO);
        let overlay_position = parent_origin + controls_rect.min.to_vec2();
        let overlay_size = controls_rect.size();
        let overlay_id = egui::ViewportId::from_hash_of("fullscreen-control-overlay");
        let builder = egui::ViewportBuilder::default()
            .with_title("Segma Player controls")
            .with_position(overlay_position)
            .with_inner_size(overlay_size)
            .with_min_inner_size(overlay_size)
            .with_max_inner_size(overlay_size)
            .with_decorations(false)
            .with_resizable(false)
            .with_transparent(true)
            .with_taskbar(false)
            .with_active(false)
            .with_always_on_top();

        let hovered = context.show_viewport_immediate(overlay_id, builder, |controls, _class| {
            controls.set_min_size(overlay_size);
            if controls.input_mut(|input| input.consume_key(Modifiers::NONE, Key::Escape)) {
                output.fullscreen_requested = true;
            }
            fullscreen_seek_bar(
                controls,
                snapshot,
                pose_markers,
                controls_rect.min.to_vec2(),
                output,
                control_progress,
            );
            controls.rect_contains_pointer(controls.max_rect())
        });
        context.data_mut(|data| data.insert_temp(hover_memory_id, hovered));
    } else {
        context.data_mut(|data| data.insert_temp(hover_memory_id, false));
    }
}

fn fullscreen_layout(available: Rect, control_progress: f32) -> (Rect, Rect) {
    (
        aspect_fit_rect(available, VIDEO_ASPECT),
        fullscreen_controls_rect(available, control_progress),
    )
}

fn aspect_fit_rect(available: Rect, aspect: f32) -> Rect {
    let width = available.width();
    let height = (width / aspect).min(available.height());
    Rect::from_center_size(available.center(), Vec2::new(height * aspect, height))
}

fn fullscreen_controls_rect(available: Rect, progress: f32) -> Rect {
    let progress = progress.clamp(0.0, 1.0);
    let width = (available.width() - FULLSCREEN_CONTROL_MARGIN * 2.0).max(1.0);
    let visible_bottom = available.bottom() - FULLSCREEN_CONTROL_MARGIN;
    let hidden_bottom = available.bottom() + FULLSCREEN_CONTROL_HEIGHT;
    let bottom = egui::lerp(hidden_bottom..=visible_bottom, progress);
    Rect::from_min_size(
        Pos2::new(
            available.left() + FULLSCREEN_CONTROL_MARGIN,
            bottom - FULLSCREEN_CONTROL_HEIGHT,
        ),
        Vec2::new(width, FULLSCREEN_CONTROL_HEIGHT),
    )
}

fn fullscreen_control_fill(progress: f32) -> Color32 {
    Color32::from_rgba_unmultiplied(
        255,
        255,
        255,
        (255.0 * FULLSCREEN_CONTROL_ALPHA * progress.clamp(0.0, 1.0)).round() as u8,
    )
}

fn header(ui: &mut Ui, snapshot: &PlayerSnapshot, output: &mut PlayerUiOutput) {
    let width = ui.available_width();
    ui.allocate_ui_with_layout(
        Vec2::new(width, PAGE_HEADER_HEIGHT),
        egui::Layout::left_to_right(egui::Align::Min),
        |ui| {
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = space::X4;
                let title = if snapshot.title.trim().is_empty() {
                    snapshot
                        .loaded_path
                        .as_deref()
                        .and_then(|path| path.file_name())
                        .and_then(|value| value.to_str())
                        .unwrap_or("재생할 파일 없음")
                } else {
                    snapshot.title.trim()
                };
                ui.add(
                    egui::Label::new(
                        RichText::new(title)
                            .size(text::HEADING_LG)
                            .strong()
                            .color(color::TEXT_PRIMARY),
                    )
                    .truncate(),
                );

                // The heading already resolves to the file name when no container
                // title exists, so repeating it below would restate the same value.
                let detail = snapshot
                    .loaded_path
                    .as_deref()
                    .and_then(|path| path.file_name())
                    .and_then(|value| value.to_str())
                    .filter(|name| *name != title);
                if let Some(detail) = detail {
                    ui.add(
                        egui::Label::new(
                            RichText::new(detail)
                                .size(text::BODY_MD)
                                .color(color::TEXT_MUTED),
                        )
                        .truncate(),
                    );
                }
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
                if header_action(ui, Icon::FolderOpen, "폴더 열기").clicked() {
                    output.open_folder_requested = true;
                }
            });
        },
    );
}

fn paint_video_surface(ui: &mut Ui, rect: Rect, response: &Response, snapshot: &PlayerSnapshot) {
    ui.painter()
        .rect_filled(rect, corner(radius::LG), Color32::BLACK);
    if response.hovered() {
        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
    }
    if response.has_focus() {
        ui.painter().rect_stroke(
            rect.shrink(2.0),
            corner(radius::LG),
            hairline(color::TEXT_INVERSE),
            StrokeKind::Inside,
        );
    }
    response.widget_info(|| WidgetInfo::labeled(WidgetType::Button, true, "재생 또는 일시정지"));

    let feedback = concise_feedback(snapshot);
    if let Some((message, tone)) = feedback {
        ui.painter().text(
            rect.center(),
            Align2::CENTER_CENTER,
            message,
            FontId::proportional(text::BODY_MD),
            tone,
        );
    }
}

fn control_bar(
    ui: &mut Ui,
    snapshot: &PlayerSnapshot,
    pose_markers: &[f64],
    pro: bool,
    output: &mut PlayerUiOutput,
) {
    egui::Frame::new()
        .fill(color::BG_SURFACE)
        .stroke(hairline(color::BORDER_SUBTLE))
        .corner_radius(corner(radius::LG))
        .inner_margin(margin_xy(space::X16, space::X12))
        .show(ui, |ui| {
            ui.spacing_mut().item_spacing = Vec2::new(space::X8, space::X12);
            scrubber(ui, snapshot, pose_markers, Vec2::ZERO, output);

            let playable = snapshot.loaded_path.is_some() && snapshot.engine_available;
            let muted = snapshot.muted || snapshot.volume <= 0.0;

            ui.horizontal_wrapped(|ui| {
                ui.set_min_height(CONTROL_ROW_HEIGHT);
                ui.spacing_mut().item_spacing.x = space::X8;

                if icon_button(
                    ui,
                    if snapshot.paused {
                        Icon::Play
                    } else {
                        Icon::Pause
                    },
                    if snapshot.paused {
                        "재생"
                    } else {
                        "일시정지"
                    },
                    ButtonStyle::Quiet,
                    playable,
                )
                .clicked()
                {
                    set_command(output, PlayerCommand::TogglePause);
                }

                timecode(ui, snapshot);

                if icon_button(
                    ui,
                    if muted {
                        Icon::VolumeOff
                    } else {
                        Icon::VolumeOn
                    },
                    if muted {
                        "음소거 해제"
                    } else {
                        "음소거"
                    },
                    ButtonStyle::Quiet,
                    snapshot.engine_available,
                )
                .clicked()
                {
                    set_command(output, PlayerCommand::ToggleMute);
                }

                volume_slider(ui, snapshot, output);

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if icon_button(ui, Icon::Fullscreen, "전체 화면", ButtonStyle::Quiet, true)
                        .clicked()
                    {
                        output.fullscreen_requested = true;
                    }
                    range_selector(ui, snapshot, output);
                    speed_selector(ui, snapshot, pro, output);
                    subtitle_controls(ui, snapshot, output);
                });
            });

            ui.add_space(space::X8);
            advanced_controls(ui, snapshot, pose_markers, output);
        });
}

/// Fullscreen deliberately exposes only the seek surface. Playback remains
/// keyboard/click controlled and the overlay never reserves video space.
fn fullscreen_seek_bar(
    ui: &mut Ui,
    snapshot: &PlayerSnapshot,
    pose_markers: &[f64],
    preview_origin: Vec2,
    output: &mut PlayerUiOutput,
    progress: f32,
) {
    egui::Frame::new()
        .fill(fullscreen_control_fill(progress))
        .stroke(hairline(color::BORDER_SUBTLE))
        .corner_radius(corner(radius::LG))
        .inner_margin(margin_xy(space::X12, space::X8))
        .show(ui, |ui| {
            scrubber(ui, snapshot, pose_markers, preview_origin, output);
        });
}

fn advanced_controls(
    ui: &mut Ui,
    snapshot: &PlayerSnapshot,
    pose_markers: &[f64],
    output: &mut PlayerUiOutput,
) {
    ui.horizontal_wrapped(|ui| {
        ui.set_min_height(CONTROL_ROW_HEIGHT);
        ui.spacing_mut().item_spacing.x = space::X8;

        if icon_button(
            ui,
            Icon::StepBackward,
            "이전 프레임",
            ButtonStyle::Quiet,
            snapshot.engine_available,
        )
        .clicked()
        {
            set_command(output, PlayerCommand::StepFrameBackward);
        }
        if icon_button(
            ui,
            Icon::StepForward,
            "다음 프레임",
            ButtonStyle::Quiet,
            snapshot.engine_available,
        )
        .clicked()
        {
            set_command(output, PlayerCommand::StepFrameForward);
        }

        subtitle_delay_controls(ui, snapshot, output);
        fit_selector(ui, snapshot, output);
        loop_controls(ui, snapshot, output);

        let marker_selected = pose_marker_is_active(pose_markers, snapshot.position);
        if icon_button(
            ui,
            Icon::Bookmark,
            if marker_selected {
                "포즈 시작점 삭제"
            } else {
                "포즈 시작점 추가"
            },
            if marker_selected {
                ButtonStyle::Primary
            } else {
                ButtonStyle::Quiet
            },
            snapshot.loaded_path.is_some()
                && snapshot.engine_available
                && snapshot.duration.is_finite()
                && snapshot.duration > 0.0,
        )
        .clicked()
        {
            output.pose_marker_toggle_requested = true;
        }

        let valid_loop = loop_is_valid(snapshot.loop_a, snapshot.loop_b);
        if icon_button(
            ui,
            Icon::Film,
            "GIF 내보내기",
            ButtonStyle::Secondary,
            valid_loop,
        )
        .clicked()
        {
            request_gif(output);
        }
    });
}

/// Measures a label so a control can reserve exactly the width it needs.
fn text_width(ui: &Ui, label: &str, font: FontId) -> f32 {
    ui.painter()
        .layout_no_wrap(label.to_owned(), font, color::TEXT_PRIMARY)
        .rect
        .width()
}

/// Monospace timecode sized for the widest value it will ever show, so the
/// controls to its right never shift as playback advances.
fn timecode(ui: &mut Ui, snapshot: &PlayerSnapshot) {
    let label = format!(
        "{} / {}",
        format_time(snapshot.position),
        format_time(snapshot.duration)
    );
    let font = FontId::monospace(text::MONO_SM);
    let widest = if snapshot.duration >= 3_600.0 {
        "0:00:00 / 0:00:00"
    } else {
        "00:00 / 00:00"
    };
    let width = text_width(ui, widest, font.clone()).max(text_width(ui, &label, font.clone()));
    let (rect, _) = ui.allocate_exact_size(Vec2::new(width, CONTROL_ROW_HEIGHT), Sense::hover());
    ui.painter().text(
        Pos2::new(rect.left(), rect.center().y),
        Align2::LEFT_CENTER,
        label,
        font,
        color::TEXT_SECONDARY,
    );
}

fn scrubber(
    ui: &mut Ui,
    snapshot: &PlayerSnapshot,
    pose_markers: &[f64],
    preview_origin: Vec2,
    output: &mut PlayerUiOutput,
) {
    let track_height = metric::PROGRESS_HEIGHT;
    let (hit_rect, response) = ui.allocate_exact_size(
        Vec2::new(ui.available_width(), SCRUBBER_HIT_HEIGHT),
        Sense::click_and_drag(),
    );
    response.widget_info(|| {
        WidgetInfo::slider(
            snapshot.engine_available,
            seek_fraction(snapshot.position, snapshot.duration),
            "재생 위치",
        )
    });

    let track =
        Rect::from_center_size(hit_rect.center(), Vec2::new(hit_rect.width(), track_height));
    let played = seek_fraction(snapshot.position, snapshot.duration) as f32;
    ui.painter()
        .rect_filled(track, corner(radius::FULL), color::BG_TRACK);
    if played > 0.0 {
        let fill = Rect::from_min_max(
            track.min,
            Pos2::new(track.left() + track.width() * played, track.bottom()),
        );
        ui.painter()
            .rect_filled(fill, corner(radius::FULL), color::ACCENT);
    }

    paint_pose_markers(ui, track, pose_markers, snapshot.duration);

    if (response.hovered() || response.dragged())
        && snapshot.duration.is_finite()
        && snapshot.duration > 0.0
    {
        if let Some(pointer) = response.hover_pos() {
            let target = marker_target_at_pointer(
                pointer.x,
                track,
                pose_markers,
                snapshot.duration,
                POSE_MARKER_HIT_RADIUS,
            )
            .unwrap_or_else(|| {
                seek_fraction(
                    f64::from(pointer.x - track.left()),
                    f64::from(track.width()),
                ) * snapshot.duration
            });
            output.hover_preview = Some(HoverPreview {
                target,
                placement: seek_preview_placement(pointer.x, track, PREVIEW_SIZE, preview_origin),
                size: PREVIEW_SIZE,
            });

            ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
        }
    }

    if (response.clicked() || response.drag_stopped()) && snapshot.duration > 0.0 {
        if let Some(pointer) = response.interact_pointer_pos() {
            let target = marker_target_at_pointer(
                pointer.x,
                track,
                pose_markers,
                snapshot.duration,
                POSE_MARKER_HIT_RADIUS,
            )
            .unwrap_or_else(|| {
                seek_fraction(
                    f64::from(pointer.x - track.left()),
                    f64::from(track.width()),
                ) * snapshot.duration
            });
            set_command(output, PlayerCommand::SeekAbsolute(target));
        }
    }
}

fn seek_preview_x(pointer_x: f32, track: Rect, preview_width: f32) -> f32 {
    (pointer_x - preview_width / 2.0).clamp(
        track.left(),
        (track.right() - preview_width).max(track.left()),
    )
}

fn seek_preview_placement(pointer_x: f32, track: Rect, preview_size: Vec2, origin: Vec2) -> Pos2 {
    Pos2::new(
        seek_preview_x(pointer_x, track, preview_size.x) + origin.x,
        track.top() - preview_size.y - PREVIEW_GAP + origin.y,
    )
}

fn paint_pose_markers(ui: &Ui, track: Rect, pose_markers: &[f64], duration: f64) {
    if !duration.is_finite() || duration <= 0.0 {
        return;
    }
    for marker in pose_markers
        .iter()
        .copied()
        .filter(|marker| marker.is_finite() && *marker >= 0.0 && *marker <= duration)
    {
        let x = track.left() + track.width() * (marker / duration) as f32;
        ui.painter().circle_filled(
            Pos2::new(x, track.center().y),
            (track.height() + 4.0) / 2.0,
            color::BG_INVERSE,
        );
    }
}

fn marker_target_at_pointer(
    pointer_x: f32,
    track: Rect,
    pose_markers: &[f64],
    duration: f64,
    hit_radius: f32,
) -> Option<f64> {
    if !pointer_x.is_finite()
        || !duration.is_finite()
        || duration <= 0.0
        || !track.width().is_finite()
        || track.width() <= 0.0
    {
        return None;
    }
    pose_markers
        .iter()
        .copied()
        .filter(|marker| marker.is_finite() && *marker >= 0.0 && *marker <= duration)
        .map(|marker| {
            let marker_x = track.left() + track.width() * (marker / duration) as f32;
            (marker, (marker_x - pointer_x).abs())
        })
        .filter(|(_, distance)| *distance <= hit_radius)
        .min_by(|left, right| left.1.total_cmp(&right.1))
        .map(|(marker, _)| marker)
}

fn pose_marker_is_active(pose_markers: &[f64], position: f64) -> bool {
    position.is_finite()
        && pose_markers.iter().any(|marker| {
            marker.is_finite() && (*marker - position).abs() <= POSE_MARKER_ACTIVE_TOLERANCE_SECONDS
        })
}

fn volume_slider(ui: &mut Ui, snapshot: &PlayerSnapshot, output: &mut PlayerUiOutput) {
    let mut volume = snapshot.volume.clamp(0.0, 100.0);
    // A bare track: the adjacent mute icon already identifies the control, so a
    // "음량" caption would only add a second label to the same thing.
    let response = ui.add_sized(
        Vec2::new(VOLUME_WIDTH, CONTROL_ROW_HEIGHT),
        egui::Slider::new(&mut volume, 0.0..=100.0)
            .show_value(false)
            .trailing_fill(true),
    );
    response.widget_info(|| WidgetInfo::slider(snapshot.engine_available, volume, "음량"));
    if response.changed() {
        set_command(output, PlayerCommand::SetVolume(volume));
    }
}

/// Subtitles are a click-to-toggle icon. When several tracks exist, each extra
/// track becomes its own language chip beside the toggle, so switching never
/// requires opening a menu.
fn subtitle_controls(ui: &mut Ui, snapshot: &PlayerSnapshot, output: &mut PlayerUiOutput) {
    let tracks = &snapshot.subtitle_tracks;
    let selected = tracks.iter().find(|track| track.selected);
    let current = selected.or_else(|| tracks.first());
    let showing = snapshot.subtitle_visible && selected.is_some();

    let Some(current) = current else {
        icon_button(
            ui,
            Icon::CaptionsOff,
            "자막 없음",
            ButtonStyle::Quiet,
            false,
        );
        return;
    };

    // The primary subtitle control is one icon-plus-language pill. Its visible
    // text is the track's native-language name, never a generic abbreviation.
    if pill_button(
        ui,
        Some(if showing {
            Icon::CaptionsOn
        } else {
            Icon::CaptionsOff
        }),
        &current.label(),
        if showing {
            "자막 끄기"
        } else {
            "자막 켜기"
        },
        true,
        showing,
    )
    .clicked()
    {
        set_command(
            output,
            if selected.is_some() {
                PlayerCommand::ToggleSubtitles
            } else {
                PlayerCommand::SelectSubtitle(Some(current.id))
            },
        );
    }

    // Multiple embedded languages stay one click away without introducing a
    // dropdown. The current language is already represented by the main pill.
    if tracks.len() > 1 {
        for track in tracks.iter().rev().filter(|track| track.id != current.id) {
            if language_chip(ui, track, false).clicked() {
                set_command(output, PlayerCommand::SelectSubtitle(Some(track.id)));
            }
        }
    }
}

/// Language name shown in that language, sized and centered like every other
/// control in the row.
fn language_chip(ui: &mut Ui, track: &SubtitleTrack, active: bool) -> Response {
    let label = track.label();
    let font = FontId::proportional(text::LABEL_MD);
    let label_width = text_width(ui, &label, font.clone());
    let response = ui.allocate_response(
        Vec2::new(label_width + space::X16, CONTROL_ROW_HEIGHT),
        Sense::click(),
    );
    let (hovering, pressing) = interaction_state(ui, &response);
    let (fill, foreground) = if active {
        (color::BG_SELECTED, color::TEXT_PRIMARY)
    } else if hovering > 0.0 {
        (color::BG_SUBTLE, color::TEXT_SECONDARY)
    } else {
        (Color32::TRANSPARENT, color::TEXT_SECONDARY)
    };
    ui.painter()
        .rect_filled(response.rect, corner(radius::MD), fill);
    if pressing > 0.0 {
        ui.painter().rect_filled(
            response.rect,
            corner(radius::MD),
            color::BG_INVERSE.gamma_multiply(pressing * 0.10),
        );
    }
    ui.painter().text(
        response.rect.center(),
        Align2::CENTER_CENTER,
        &label,
        font,
        foreground,
    );
    if hovering > 0.0 {
        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
    }
    response.widget_info(|| {
        WidgetInfo::selected(WidgetType::Button, true, active, format!("{label} 자막"))
    });
    response
}

fn speed_selector(ui: &mut Ui, snapshot: &PlayerSnapshot, pro: bool, output: &mut PlayerUiOutput) {
    let active = !speed_matches(snapshot.speed, 1.0);
    let response = pill_button(
        ui,
        Some(Icon::Speed),
        &speed_label(snapshot.speed),
        "재생 속도",
        speed_control_enabled(pro, snapshot.engine_available),
        active,
    );
    if !pro {
        response.on_hover_text("재생 속도 조절은 Pro 기능입니다. 설정에서 업그레이드하세요.");
    } else if response.clicked() {
        set_command(output, PlayerCommand::SetSpeed(next_speed(snapshot.speed)));
    }
}

/// App Pro owns speed entitlement; the player engine being available is not
/// sufficient. Keeping this pure makes the General disabled state explicit.
pub(crate) const fn speed_control_enabled(pro: bool, engine_available: bool) -> bool {
    pro && engine_available
}

/// Hover-control geometry inside the PiP video surface. Pure so the "controls
/// stay inside the video, no separate window" rule is directly testable.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct PipControlLayout {
    pub close: Rect,
    pub return_to_tab: Rect,
    pub rewind: Rect,
    pub play: Rect,
    pub forward: Rect,
    pub seek: Rect,
    pub time: Rect,
}

pub(crate) fn pip_control_layout(video: Rect) -> PipControlLayout {
    let inset = space::X8;
    let icon = metric::ICON_SM;
    let row_y = video.top() + 34.0;
    let close = Rect::from_min_size(
        Pos2::new(video.right() - inset - icon, row_y - icon / 2.0),
        Vec2::splat(icon),
    );
    let return_to_tab = Rect::from_min_size(
        Pos2::new(close.left() - space::X8 - icon, close.top()),
        Vec2::splat(icon),
    );
    let play = Rect::from_center_size(Pos2::new(video.left() + 48.0, row_y), Vec2::splat(32.0));
    let rewind = Rect::from_center_size(Pos2::new(video.left() + 16.0, row_y), Vec2::splat(icon));
    let forward = Rect::from_center_size(Pos2::new(video.left() + 80.0, row_y), Vec2::splat(icon));
    let time = Rect::from_min_max(
        Pos2::new(video.left() + 100.0, row_y - 10.0),
        Pos2::new(return_to_tab.left() - space::X8, row_y + 10.0),
    );
    let seek = Rect::from_min_max(
        Pos2::new(video.left() + inset, video.top() + space::X8),
        Pos2::new(
            video.right() - inset,
            video.top() + space::X8 + metric::PROGRESS_HEIGHT,
        ),
    );
    PipControlLayout {
        close,
        return_to_tab,
        rewind,
        play,
        forward,
        seek,
        time,
    }
}

/// Render compact PiP controls in a stable sibling bar below native video.
///
/// `rect` is the video surface itself and is passed in rather than read from the
/// `Ui`: the host renders this inside a floating area whose own `max_rect`
/// reaches the screen edge, which would place the controls below the video.
pub(crate) fn pip_controls(
    ui: &mut Ui,
    rect: Rect,
    snapshot: &PlayerSnapshot,
    output: &mut PlayerUiOutput,
    preview_size: Vec2,
    preview_origin: Vec2,
) {
    ui.painter().rect_filled(rect, 0.0, color::BG_INVERSE);
    let layout = pip_control_layout(rect);
    if overlay_icon_button(ui, layout.close, Icon::Cancel, "PiP 닫기", true).clicked() {
        output.pip_close_requested = true;
    }
    if overlay_icon_button(
        ui,
        layout.return_to_tab,
        Icon::Fullscreen,
        "탭으로 돌아가기",
        true,
    )
    .clicked()
    {
        output.fullscreen_requested = true;
    }
    if overlay_icon_button(
        ui,
        layout.rewind,
        Icon::StepBackward,
        "10초 뒤로",
        snapshot.engine_available,
    )
    .clicked()
    {
        set_command(output, PlayerCommand::SeekRelative(-10.0));
    }
    if overlay_icon_button(
        ui,
        layout.play,
        if snapshot.paused {
            Icon::Play
        } else {
            Icon::Pause
        },
        if snapshot.paused {
            "재생"
        } else {
            "일시정지"
        },
        snapshot.engine_available,
    )
    .clicked()
    {
        set_command(output, PlayerCommand::TogglePause);
    }
    if overlay_icon_button(
        ui,
        layout.forward,
        Icon::StepForward,
        "10초 앞으로",
        snapshot.engine_available,
    )
    .clicked()
    {
        set_command(output, PlayerCommand::SeekRelative(10.0));
    }

    paint_pip_seek_bar(
        ui,
        layout.seek,
        snapshot,
        output,
        preview_size,
        preview_origin,
    );
    ui.painter().text(
        Pos2::new(layout.time.left(), layout.time.center().y),
        Align2::LEFT_CENTER,
        format!(
            "{} / {}",
            format_time(snapshot.position),
            format_time(snapshot.duration)
        ),
        FontId::monospace(text::MONO_SM),
        color::TEXT_INVERSE,
    );
}

fn paint_pip_seek_bar(
    ui: &mut Ui,
    track: Rect,
    snapshot: &PlayerSnapshot,
    output: &mut PlayerUiOutput,
    preview_size: Vec2,
    preview_origin: Vec2,
) {
    let response = ui.interact(track, ui.id().with("pip-seek-bar"), Sense::click_and_drag());
    ui.painter()
        .rect_filled(track, corner(radius::FULL), Color32::from_white_alpha(70));
    let played = seek_fraction(snapshot.position, snapshot.duration) as f32;
    if played > 0.0 {
        let fill = Rect::from_min_max(
            track.min,
            Pos2::new(track.left() + track.width() * played, track.bottom()),
        );
        ui.painter()
            .rect_filled(fill, corner(radius::FULL), color::ACCENT);
    }
    if (response.hovered() || response.dragged()) && snapshot.duration > 0.0 {
        if let Some(pointer) = response.hover_pos() {
            let target = seek_fraction(
                f64::from(pointer.x - track.left()),
                f64::from(track.width()),
            ) * snapshot.duration;
            output.hover_preview = Some(HoverPreview {
                target,
                placement: seek_preview_placement(pointer.x, track, preview_size, preview_origin),
                size: preview_size,
            });
        }
        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
    }
    if (response.clicked() || response.drag_stopped()) && snapshot.duration > 0.0 {
        if let Some(pointer) = response.interact_pointer_pos() {
            let target = seek_fraction(
                f64::from(pointer.x - track.left()),
                f64::from(track.width()),
            ) * snapshot.duration;
            set_command(output, PlayerCommand::SeekAbsolute(target));
        }
    }
}

/// Compact control painted inside the stable bar below the native video.
fn overlay_icon_button(
    ui: &mut Ui,
    rect: Rect,
    icon: Icon,
    accessible_label: &str,
    enabled: bool,
) -> Response {
    let response = ui.interact(
        rect,
        ui.id().with(("pip-overlay-control", accessible_label)),
        if enabled {
            Sense::click()
        } else {
            Sense::hover()
        },
    );
    if enabled && response.hovered() {
        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
    }
    icons::paint_centered(
        ui,
        icon,
        rect,
        metric::ICON_SM,
        if enabled {
            color::TEXT_INVERSE
        } else {
            color::TEXT_INVERSE.gamma_multiply(0.45)
        },
    );
    response.widget_info(|| WidgetInfo::labeled(WidgetType::Button, enabled, accessible_label));
    response
}

/// Paint a decoded seek frame entirely in egui. The caller controls placement,
/// so a PiP preview is part of the same movable/resizable area and a normal
/// Player preview cannot create a competing native child window.
pub(crate) fn paint_seek_preview(
    ui: &Ui,
    placement: Pos2,
    size: Vec2,
    texture: Option<&TextureHandle>,
    timecode: &str,
) {
    let size = Vec2::new(size.x.max(1.0), size.y.max(1.0));
    // `size` contains a 16:9 image plus its timecode strip. Deriving the strip
    // from width keeps the image proportional at both 192x136 Player size and
    // compact 128x92 PiP size.
    let image_height = (size.x * 9.0 / 16.0).min(size.y);
    let strip_height = (size.y - image_height).clamp(0.0, 28.0);
    let rect = Rect::from_min_size(placement, size);
    let image_rect = Rect::from_min_max(
        rect.min,
        Pos2::new(rect.right(), rect.bottom() - strip_height),
    );
    let strip_rect = Rect::from_min_max(Pos2::new(rect.left(), image_rect.bottom()), rect.max);
    let rounding = corner(radius::MD);
    ui.painter().rect_filled(rect, rounding, color::BG_INVERSE);
    if let Some(texture) = texture {
        ui.painter().image(
            texture.id(),
            image_rect,
            Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)),
            Color32::WHITE,
        );
    } else {
        ui.painter().text(
            image_rect.center(),
            Align2::CENTER_CENTER,
            "미리보기 준비 중",
            FontId::proportional((text::BODY_SM - 1.0).max(9.0)),
            color::TEXT_MUTED,
        );
    }
    ui.painter().rect_filled(strip_rect, 0.0, color::BG_INVERSE);
    ui.painter().text(
        strip_rect.center(),
        Align2::CENTER_CENTER,
        timecode,
        FontId::monospace((text::MONO_SM - 1.0).max(9.0)),
        color::TEXT_INVERSE,
    );
    ui.painter().rect_stroke(
        rect,
        rounding,
        hairline(Color32::from_white_alpha(40)),
        StrokeKind::Inside,
    );
}

fn range_selector(ui: &mut Ui, snapshot: &PlayerSnapshot, output: &mut PlayerUiOutput) {
    let mode = snapshot.color_range_mode;
    if pill_button(
        ui,
        Some(Icon::Contrast),
        mode.label(),
        "색 범위",
        snapshot.engine_available,
        mode != ColorRangeMode::Auto,
    )
    .clicked()
    {
        set_command(output, PlayerCommand::SetColorRange(next_color_range(mode)));
    }
}

fn fit_selector(ui: &mut Ui, snapshot: &PlayerSnapshot, output: &mut PlayerUiOutput) {
    let mode = snapshot.video_fit_mode;
    if pill_button(
        ui,
        None,
        mode.label(),
        "영상 화면 맞춤",
        snapshot.engine_available,
        mode != VideoFitMode::Fit,
    )
    .clicked()
    {
        set_command(
            output,
            PlayerCommand::SetVideoFitMode(next_video_fit_mode(mode)),
        );
    }
}

fn subtitle_delay_controls(ui: &mut Ui, snapshot: &PlayerSnapshot, output: &mut PlayerUiOutput) {
    let delay = normalized_subtitle_delay(snapshot.subtitle_delay);
    let enabled = snapshot.engine_available && !snapshot.subtitle_tracks.is_empty();
    if pill_button(ui, None, "-0.1s", "자막 싱크 늦추기", enabled, false).clicked() {
        set_command(
            output,
            PlayerCommand::SetSubtitleDelay(step_subtitle_delay(delay, -0.1)),
        );
    }
    if pill_button(
        ui,
        None,
        &subtitle_delay_label(delay),
        "자막 싱크 초기화",
        enabled && delay.abs() > 0.0005,
        delay.abs() > 0.0005,
    )
    .clicked()
    {
        set_command(output, PlayerCommand::SetSubtitleDelay(0.0));
    }
    if pill_button(ui, None, "+0.1s", "자막 싱크 당기기", enabled, false).clicked() {
        set_command(
            output,
            PlayerCommand::SetSubtitleDelay(step_subtitle_delay(delay, 0.1)),
        );
    }
}

fn loop_controls(ui: &mut Ui, snapshot: &PlayerSnapshot, output: &mut PlayerUiOutput) {
    let position = current_position(snapshot.position);
    let can_mark_a = position.is_some();
    let can_mark_b = position.is_some_and(|b| {
        snapshot
            .loop_a
            .is_some_and(|a| loop_is_valid(Some(a), Some(b)))
    });
    let active = snapshot.loop_a.is_some() || snapshot.loop_b.is_some();

    if pill_button(
        ui,
        None,
        &loop_mark_label("A", snapshot.loop_a),
        "A 지점 설정",
        snapshot.engine_available && can_mark_a,
        snapshot.loop_a.is_some(),
    )
    .clicked()
    {
        if let Some(position) = position {
            set_command(output, PlayerCommand::SetLoopA(Some(position)));
        }
    }
    if pill_button(
        ui,
        None,
        &loop_mark_label("B", snapshot.loop_b),
        "B 지점 설정",
        snapshot.engine_available && can_mark_b,
        snapshot.loop_b.is_some(),
    )
    .clicked()
    {
        if let Some(position) = position {
            set_command(output, PlayerCommand::SetLoopB(Some(position)));
        }
    }
    if icon_button(
        ui,
        Icon::Cancel,
        "A-B 구간 지우기",
        if active {
            ButtonStyle::Secondary
        } else {
            ButtonStyle::Quiet
        },
        snapshot.engine_available && active,
    )
    .clicked()
    {
        set_command(output, PlayerCommand::ClearLoop);
    }
}

/// Icon plus short value in one control-height pill. Used for the cycling speed
/// and color-range controls so both align with the icon buttons beside them.
fn pill_button(
    ui: &mut Ui,
    icon: Option<Icon>,
    visible_label: &str,
    accessible_label: &str,
    enabled: bool,
    active: bool,
) -> Response {
    let font = FontId::proportional(text::LABEL_MD);
    let label_width = text_width(ui, visible_label, font.clone());
    let icon_width = if icon.is_some() {
        metric::ICON_SM + space::X4
    } else {
        0.0
    };
    let response = ui.allocate_response(
        Vec2::new(label_width + icon_width + space::X16, CONTROL_ROW_HEIGHT),
        if enabled {
            Sense::click()
        } else {
            Sense::hover()
        },
    );
    let (hovering, pressing) = interaction_state(ui, &response);
    let (fill, foreground) = if !enabled {
        (Color32::TRANSPARENT, color::TEXT_MUTED)
    } else if active {
        (color::BG_SELECTED, color::TEXT_PRIMARY)
    } else if hovering > 0.0 {
        (color::BG_SUBTLE, color::TEXT_SECONDARY)
    } else {
        (Color32::TRANSPARENT, color::TEXT_SECONDARY)
    };
    ui.painter()
        .rect_filled(response.rect, corner(radius::MD), fill);
    if hovering > 0.0 || pressing > 0.0 {
        paint_button_motion(ui, &response, ButtonStyle::Quiet, hovering, pressing);
    }

    let mut cursor = response.rect.left() + space::X8;
    if let Some(icon) = icon {
        let icon_rect = Rect::from_min_size(
            Pos2::new(cursor, response.rect.top()),
            Vec2::new(metric::ICON_SM, response.rect.height()),
        );
        let icon_size = metric::ICON_SM - pressing;
        icons::paint_centered(
            ui,
            icon,
            Rect::from_center_size(
                icon_rect.center() + Vec2::new(0.0, pressing),
                Vec2::splat(icon_size),
            ),
            icon_size,
            foreground,
        );
        cursor = icon_rect.right() + space::X4;
    }
    ui.painter().text(
        Pos2::new(cursor, response.rect.center().y),
        Align2::LEFT_CENTER,
        visible_label,
        font,
        foreground,
    );
    if enabled && hovering > 0.0 {
        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
    }
    response.widget_info(|| {
        WidgetInfo::labeled(
            WidgetType::Button,
            enabled,
            format!("{accessible_label} {visible_label}"),
        )
    });
    response
}

fn up_next_row(
    ui: &mut Ui,
    entries: &[LibraryEntry],
    thumbnail_textures: &HashMap<String, TextureHandle>,
    output: &mut PlayerUiOutput,
) {
    if entries.is_empty() {
        return;
    }
    ui.label(
        RichText::new("다음 재생")
            .size(text::LABEL_SM)
            .color(color::TEXT_MUTED),
    );
    ui.add_space(space::X4);

    let gap = space::X16;
    let available = ui.available_width();
    let tile_width =
        ((available - gap * (UP_NEXT_COUNT as f32 - 1.0)) / UP_NEXT_COUNT as f32).max(132.0);
    ui.horizontal_top(|ui| {
        ui.spacing_mut().item_spacing.x = gap;
        for entry in entries.iter().take(UP_NEXT_COUNT) {
            ui.allocate_ui_with_layout(
                Vec2::new(tile_width, tile_width * 9.0 / 16.0 + 48.0),
                egui::Layout::top_down(egui::Align::LEFT),
                |ui| {
                    ui.set_width(tile_width);
                    let response = media_thumbnail(
                        ui,
                        thumbnail_textures.get(&entry.thumbnail_key),
                        &entry.type_label,
                        tile_width,
                    );
                    response.widget_info(|| {
                        WidgetInfo::labeled(
                            WidgetType::Button,
                            true,
                            format!("{} 재생", entry.title),
                        )
                    });
                    if response.hovered() {
                        ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
                        ui.painter().rect_stroke(
                            response.rect,
                            corner(radius::LG),
                            hairline(color::BORDER_STRONG),
                            StrokeKind::Inside,
                        );
                    }
                    if response.has_focus() {
                        ui.painter().rect_stroke(
                            response.rect.shrink(2.0),
                            corner(radius::LG),
                            hairline(color::BORDER_STRONG),
                            StrokeKind::Inside,
                        );
                    }
                    if response.clicked() {
                        output.selected_up_next_file = Some(entry.file_name.clone());
                    }
                    ui.add(
                        egui::Label::new(
                            RichText::new(&entry.title)
                                .size(text::HEADING_SM)
                                .strong()
                                .color(color::TEXT_PRIMARY),
                        )
                        .truncate(),
                    );
                    let meta = [Some(entry.type_label.clone()), entry.size.clone()]
                        .into_iter()
                        .flatten()
                        .collect::<Vec<_>>()
                        .join(" · ");
                    ui.add(
                        egui::Label::new(
                            RichText::new(meta)
                                .size(text::BODY_SM)
                                .color(color::TEXT_MUTED),
                        )
                        .truncate(),
                    );
                },
            );
        }
    });
}

fn shortcuts_allowed(context: &egui::Context) -> bool {
    !context.egui_wants_keyboard_input()
        && !context.any_popup_open()
        && context.memory(|memory| memory.top_modal_layer().is_none())
}

fn read_keyboard_action(
    ui: &mut Ui,
    snapshot: &PlayerSnapshot,
    fullscreen: bool,
    shortcuts: PlayerShortcuts,
) -> Option<KeyboardAction> {
    ui.input_mut(|input| {
        for (shortcut, action) in keyboard_bindings(snapshot, fullscreen, shortcuts) {
            if input.consume_shortcut(&shortcut) {
                return Some(action);
            }
        }
        None
    })
}

fn keyboard_bindings(
    snapshot: &PlayerSnapshot,
    fullscreen: bool,
    shortcuts: PlayerShortcuts,
) -> Vec<(egui::KeyboardShortcut, KeyboardAction)> {
    let mut bindings = ShortcutAction::ALL
        .into_iter()
        .map(|action| (shortcuts.get(action), keyboard_action(action, snapshot)))
        .collect::<Vec<_>>();
    if fullscreen {
        bindings.push((
            egui::KeyboardShortcut::new(Modifiers::NONE, Key::Escape),
            KeyboardAction::Fullscreen,
        ));
    }
    bindings
}

fn keyboard_action(action: ShortcutAction, snapshot: &PlayerSnapshot) -> KeyboardAction {
    if let Some(rating) = action.rating() {
        return KeyboardAction::SetRating(rating);
    }
    match action {
        ShortcutAction::TogglePause => KeyboardAction::Command(PlayerCommandKind::TogglePause),
        ShortcutAction::SeekBackward => {
            KeyboardAction::Command(PlayerCommandKind::SeekRelative(-5.0))
        }
        ShortcutAction::SeekForward => {
            KeyboardAction::Command(PlayerCommandKind::SeekRelative(5.0))
        }
        ShortcutAction::VolumeUp => KeyboardAction::Command(PlayerCommandKind::SetVolume(
            (snapshot.volume + 5.0).clamp(0.0, 100.0),
        )),
        ShortcutAction::VolumeDown => KeyboardAction::Command(PlayerCommandKind::SetVolume(
            (snapshot.volume - 5.0).clamp(0.0, 100.0),
        )),
        ShortcutAction::ToggleMute => KeyboardAction::Command(PlayerCommandKind::ToggleMute),
        ShortcutAction::ToggleSubtitles => {
            KeyboardAction::Command(PlayerCommandKind::ToggleSubtitles)
        }
        ShortcutAction::ToggleFullscreen => KeyboardAction::Fullscreen,
        ShortcutAction::TogglePoseMarker => KeyboardAction::TogglePoseMarker,
        ShortcutAction::StepFrameBackward => {
            KeyboardAction::Command(PlayerCommandKind::StepFrameBackward)
        }
        ShortcutAction::StepFrameForward => {
            KeyboardAction::Command(PlayerCommandKind::StepFrameForward)
        }
        ShortcutAction::SetLoopA => KeyboardAction::Command(PlayerCommandKind::SetLoopA(
            current_position(snapshot.position).unwrap_or(0.0),
        )),
        ShortcutAction::SetLoopB => KeyboardAction::Command(PlayerCommandKind::SetLoopB(
            current_position(snapshot.position).unwrap_or(0.0),
        )),
        ShortcutAction::ClearLoop => KeyboardAction::Command(PlayerCommandKind::ClearLoop),
        ShortcutAction::Rating0
        | ShortcutAction::Rating1
        | ShortcutAction::Rating2
        | ShortcutAction::Rating3
        | ShortcutAction::Rating4
        | ShortcutAction::Rating5 => unreachable!("rating actions return above"),
    }
}

fn apply_keyboard_action(action: KeyboardAction, output: &mut PlayerUiOutput) {
    match action {
        KeyboardAction::Fullscreen => output.fullscreen_requested = true,
        KeyboardAction::Command(kind) => set_command(output, command_from_kind(kind)),
        KeyboardAction::TogglePoseMarker => output.pose_marker_toggle_requested = true,
        KeyboardAction::SetRating(rating) => output.rating_requested = Some(rating),
    }
}

fn command_from_kind(kind: PlayerCommandKind) -> PlayerCommand {
    match kind {
        PlayerCommandKind::TogglePause => PlayerCommand::TogglePause,
        PlayerCommandKind::SeekRelative(delta) => PlayerCommand::SeekRelative(delta),
        PlayerCommandKind::SetVolume(value) => PlayerCommand::SetVolume(value),
        PlayerCommandKind::ToggleMute => PlayerCommand::ToggleMute,
        PlayerCommandKind::ToggleSubtitles => PlayerCommand::ToggleSubtitles,
        PlayerCommandKind::StepFrameBackward => PlayerCommand::StepFrameBackward,
        PlayerCommandKind::StepFrameForward => PlayerCommand::StepFrameForward,
        PlayerCommandKind::SetLoopA(position) => PlayerCommand::SetLoopA(Some(position)),
        PlayerCommandKind::SetLoopB(position) => PlayerCommand::SetLoopB(Some(position)),
        PlayerCommandKind::ClearLoop => PlayerCommand::ClearLoop,
    }
}

fn set_command(output: &mut PlayerUiOutput, command: PlayerCommand) {
    if output.command.is_none() {
        output.command = Some(command);
    }
}

fn concise_feedback(snapshot: &PlayerSnapshot) -> Option<(String, Color32)> {
    if !snapshot.engine_available {
        return Some(("재생 엔진을 사용할 수 없음".into(), color::TEXT_INVERSE));
    }
    if let Some(error) = snapshot
        .error
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some((model::single_line(error, 72), color::TEXT_INVERSE));
    }
    if snapshot.loaded_path.is_none() {
        return Some(("재생할 파일 없음".into(), color::TEXT_MUTED));
    }
    None
}

pub(crate) fn physical_rect(ui: &Ui, logical: Rect) -> PhysicalVideoRect {
    let scale = ui.ctx().pixels_per_point();
    PhysicalVideoRect {
        x: (logical.left() * scale).round() as i32,
        y: (logical.top() * scale).round() as i32,
        width: (logical.width() * scale).round() as i32,
        height: (logical.height() * scale).round() as i32,
    }
}

pub(crate) fn format_time(seconds: f64) -> String {
    let total = if seconds.is_finite() {
        seconds.max(0.0).floor() as u64
    } else {
        0
    };
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let seconds = total % 60;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes:02}:{seconds:02}")
    }
}

pub(crate) fn seek_fraction(position: f64, duration: f64) -> f64 {
    if !position.is_finite() || !duration.is_finite() || duration <= 0.0 {
        return 0.0;
    }
    (position / duration).clamp(0.0, 1.0)
}

pub(crate) fn next_speed(current: f64) -> f64 {
    SPEEDS
        .iter()
        .copied()
        .find(|speed| *speed > current + 0.001)
        .unwrap_or(SPEEDS[0])
}

pub(crate) const fn next_video_fit_mode(mode: VideoFitMode) -> VideoFitMode {
    match mode {
        VideoFitMode::Fit => VideoFitMode::Fill,
        VideoFitMode::Fill => VideoFitMode::Stretch,
        VideoFitMode::Stretch => VideoFitMode::Fit,
    }
}

pub(crate) fn normalized_subtitle_delay(delay: f64) -> f64 {
    if delay.is_finite() {
        (delay * 10.0).round() / 10.0
    } else {
        0.0
    }
}

pub(crate) fn step_subtitle_delay(current: f64, delta: f64) -> f64 {
    let current = normalized_subtitle_delay(current);
    if delta.is_finite() {
        normalized_subtitle_delay(current + delta)
    } else {
        current
    }
}

fn subtitle_delay_label(delay: f64) -> String {
    let delay = normalized_subtitle_delay(delay);
    if delay.abs() < 0.0005 {
        "0.0s".to_string()
    } else {
        format!("{delay:+.1}s")
    }
}

pub(crate) fn loop_is_valid(loop_a: Option<f64>, loop_b: Option<f64>) -> bool {
    let (Some(a), Some(b)) = (loop_a, loop_b) else {
        return false;
    };
    a.is_finite() && b.is_finite() && a >= 0.0 && a < b
}

fn current_position(position: f64) -> Option<f64> {
    position
        .is_finite()
        .then_some(position)
        .filter(|value| *value >= 0.0)
}

fn loop_mark_label(prefix: &str, position: Option<f64>) -> String {
    position
        .map(|position| format!("{prefix} {}", format_time(position)))
        .unwrap_or_else(|| prefix.to_string())
}

fn request_gif(output: &mut PlayerUiOutput) {
    output.gif_requested = true;
}

fn speed_matches(left: f64, right: f64) -> bool {
    (left - right).abs() < 0.001
}

fn speed_label(speed: f64) -> String {
    if speed_matches(speed, speed.round()) {
        format!("{}x", speed as i64)
    } else {
        let mut value = format!("{speed:.2}");
        while value.ends_with('0') {
            value.pop();
        }
        format!("{value}x")
    }
}

/// Cycles Auto -> 16–235 -> 0–255 -> Auto, matching the pill's single-click
/// behavior.
pub(crate) const fn next_color_range(mode: ColorRangeMode) -> ColorRangeMode {
    match mode {
        ColorRangeMode::Auto => ColorRangeMode::Limited,
        ColorRangeMode::Limited => ColorRangeMode::Full,
        ColorRangeMode::Full => ColorRangeMode::Auto,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speed_control_is_pro_only_but_engine_state_still_gates_it() {
        assert!(!speed_control_enabled(false, true));
        assert!(!speed_control_enabled(true, false));
        assert!(speed_control_enabled(true, true));
        assert_eq!(next_speed(1.0), 1.25);
    }

    #[test]
    fn top_right_icon_actions_have_no_wrapper_and_keep_a_hover_label() {
        // Keep the original 16px icon. Alignment comes from the header row, not
        // from enlarging the glyph to the 24px title or the 32px control box.
        assert_eq!(HEADER_ACTION_SIZE, metric::ICON_SM);
        assert_ne!(HEADER_ACTION_SIZE, metric::CONTROL_HEIGHT);
        assert_ne!(HEADER_ACTION_SIZE, text::HEADING_LG);

        let source = include_str!("player_ui.rs");
        let action = &source[source.find("pub fn header_action").unwrap()..];
        let action = &action[..action.find("\n}").unwrap()];
        assert!(action.contains("HEADER_ACTION_SIZE"));
        assert!(!action.contains("icon_button"));
        assert!(!action.contains("ButtonStyle"));
        assert!(!action.contains("rect_filled"));
        // Hover disclosure replaces the visible chrome that was removed.
        assert!(action.contains("on_hover_text(label)"));

        // Every header action routes through the helper: no page may re-introduce
        // a filled or bordered wrapper for its top-right icons.
        let app = include_str!("app.rs");
        assert!(!app.contains("actions: &[(Icon, &str, ButtonStyle)]"));
        let shared_header = &app[app.find("fn header(").unwrap()..app.find("fn filters(").unwrap()];
        assert!(shared_header.contains("player_ui::header_action(ui, *icon, label)"));
        assert!(!shared_header.contains("ButtonStyle"));
        assert!(shared_header.contains("egui::Align::Min"));

        // The Library screen builds its own header row; its right-side actions
        // must use the same unwrapped control.
        let library =
            &app[app.find("fn library_view").unwrap()..app.find("fn folder_chip").unwrap()];
        let right_side = &library
            [library.find("Layout::right_to_left").unwrap()..library.find("search_field").unwrap()];
        assert_eq!(right_side.matches("player_ui::header_action").count(), 4);
        assert!(!right_side.contains("ButtonStyle"));
    }

    #[test]
    fn pip_controls_stay_inside_the_stable_sibling_bar() {
        let bar = Rect::from_min_size(Pos2::new(20.0, 220.0), Vec2::new(320.0, 56.0));
        let layout = pip_control_layout(bar);
        for part in [
            layout.close,
            layout.return_to_tab,
            layout.rewind,
            layout.play,
            layout.forward,
            layout.seek,
            layout.time,
        ] {
            assert!(bar.contains_rect(part), "{part:?} escaped {bar:?}");
        }
        assert_eq!(layout.close.right(), bar.right() - space::X8);
        assert_eq!(
            layout.return_to_tab.right(),
            layout.close.left() - space::X8
        );
        assert!(layout.rewind.right() < layout.play.left());
        assert!(layout.play.right() < layout.forward.left());
        assert_eq!(layout.time.left(), bar.left() + 100.0);
        assert_eq!(layout.seek.top(), bar.top() + space::X8);
        assert_eq!(layout.seek.height(), metric::PROGRESS_HEIGHT);
        assert!(layout.seek.bottom() < layout.time.top());

        let moved = pip_control_layout(bar.translate(Vec2::new(-120.0, 40.0)));
        assert_ne!(moved.close, layout.close);
        assert_eq!(moved.close.size(), layout.close.size());
    }

    #[test]
    fn pip_controls_are_always_perceptible_and_do_not_depend_on_hover() {
        let source = include_str!("player_ui.rs");
        let controls = &source[source.find("pub(crate) fn pip_controls").unwrap()
            ..source.find("fn overlay_icon_button").unwrap()];
        assert!(controls.contains("BG_INVERSE"));
        assert!(!controls.contains("if !hovered"));
        assert!(controls.contains("paint_pip_seek_bar"));
        assert!(controls.contains("탭으로 돌아가기"));
        assert!(controls.contains("10초 뒤로"));
        assert!(controls.contains("10초 앞으로"));
        assert!(!controls.contains("on_hover_text"));
        assert!(controls.contains("output.hover_preview = Some(HoverPreview"));
        assert!(!controls.contains("scrubber("));

        let overlay_start = source.find("fn overlay_icon_button").unwrap();
        let overlay = &source[overlay_start
            ..source[overlay_start..]
                .find("\n}")
                .map(|offset| overlay_start + offset + 2)
                .unwrap()];
        assert!(!overlay.contains("rect_filled"));
        assert!(!overlay.contains("from_black_alpha"));
        assert!(!overlay.contains("egui::Frame"));
    }

    #[test]
    fn time_formatting_handles_short_long_and_invalid_values() {
        assert_eq!(format_time(0.0), "00:00");
        assert_eq!(format_time(197.9), "03:17");
        assert_eq!(format_time(3_661.0), "1:01:01");
        assert_eq!(format_time(f64::NAN), "00:00");
        assert_eq!(format_time(-5.0), "00:00");
    }

    #[test]
    fn seek_fraction_is_bounded_and_rejects_unknown_duration() {
        assert_eq!(seek_fraction(25.0, 100.0), 0.25);
        assert_eq!(seek_fraction(-5.0, 100.0), 0.0);
        assert_eq!(seek_fraction(150.0, 100.0), 1.0);
        assert_eq!(seek_fraction(20.0, 0.0), 0.0);
        assert_eq!(seek_fraction(f64::NAN, 100.0), 0.0);
    }

    #[test]
    fn pose_marker_hit_snaps_to_the_exact_saved_timestamp() {
        let track = Rect::from_min_size(Pos2::new(10.0, 0.0), Vec2::new(200.0, 4.0));
        let markers = [25.25, 75.5];
        let marker_x = track.left() + track.width() * 0.2525;
        assert_eq!(
            marker_target_at_pointer(marker_x + 4.0, track, &markers, 100.0, 7.0),
            Some(25.25)
        );
        assert_eq!(
            marker_target_at_pointer(marker_x + 8.0, track, &markers, 100.0, 7.0),
            None
        );
    }

    #[test]
    fn pose_marker_hit_ignores_invalid_metadata_and_selects_nearest() {
        let track = Rect::from_min_size(Pos2::ZERO, Vec2::new(100.0, 4.0));
        let markers = [f64::NAN, -1.0, 49.0, 52.0, 101.0];
        assert_eq!(
            marker_target_at_pointer(50.0, track, &markers, 100.0, 5.0),
            Some(49.0)
        );
        assert_eq!(
            marker_target_at_pointer(50.0, track, &markers, 0.0, 5.0),
            None
        );
    }

    #[test]
    fn pose_marker_active_state_uses_toggle_tolerance() {
        assert!(pose_marker_is_active(&[12.0], 12.75));
        assert!(!pose_marker_is_active(&[12.0], 12.751));
        assert!(!pose_marker_is_active(&[f64::NAN], 12.0));
    }

    #[test]
    fn fullscreen_controls_float_without_resizing_the_video() {
        let available = Rect::from_min_max(Pos2::ZERO, Pos2::new(1920.0, 1080.0));
        let (hidden_video, hidden_controls) = fullscreen_layout(available, 0.0);
        let (shown_video, shown_controls) = fullscreen_layout(available, 1.0);

        assert_eq!(
            hidden_video, shown_video,
            "controls must not reflow the video"
        );
        assert!((shown_video.width() / shown_video.height() - VIDEO_ASPECT).abs() < 0.001);
        assert_eq!(shown_video.center(), available.center());
        assert_eq!(hidden_controls.top(), available.bottom());
        assert_eq!(
            shown_controls.bottom(),
            available.bottom() - FULLSCREEN_CONTROL_MARGIN
        );
        assert_eq!(shown_controls.height(), FULLSCREEN_CONTROL_HEIGHT);
        assert!(shown_controls.top() < hidden_controls.top());
    }

    #[test]
    fn fullscreen_control_surface_fades_to_a_translucent_fill() {
        assert_eq!(fullscreen_control_fill(0.0).a(), 0);
        let shown = fullscreen_control_fill(1.0);
        assert!(shown.a() > 0 && shown.a() < 255);
        assert_eq!(shown.r(), shown.a());
        assert_eq!(shown.g(), shown.a());
        assert_eq!(shown.b(), shown.a());
    }

    #[test]
    fn windowed_seek_preview_uses_the_full_track_width() {
        let track = Rect::from_min_max(Pos2::new(20.0, 0.0), Pos2::new(1_020.0, 8.0));
        assert_eq!(seek_preview_x(20.0, track, 192.0), 20.0);
        assert_eq!(seek_preview_x(1_020.0, track, 192.0), 828.0);
        assert_eq!(seek_preview_x(520.0, track, 192.0), 424.0);
    }

    #[test]
    fn seek_preview_floats_above_the_track_in_parent_coordinates() {
        let windowed_track = Rect::from_min_max(Pos2::new(20.0, 700.0), Pos2::new(1_020.0, 704.0));
        let windowed = seek_preview_placement(520.0, windowed_track, PREVIEW_SIZE, Vec2::ZERO);
        assert_eq!(windowed, Pos2::new(424.0, 544.0));
        assert_eq!(
            windowed.y + PREVIEW_SIZE.y + PREVIEW_GAP,
            windowed_track.top()
        );

        let overlay_track = Rect::from_min_max(Pos2::new(12.0, 19.0), Pos2::new(1_868.0, 23.0));
        let overlay_origin = Vec2::new(16.0, 1_022.0);
        let fullscreen = seek_preview_placement(940.0, overlay_track, PREVIEW_SIZE, overlay_origin);
        assert_eq!(fullscreen, Pos2::new(860.0, 885.0));
        assert_eq!(
            fullscreen.y + PREVIEW_SIZE.y + PREVIEW_GAP,
            overlay_track.top() + overlay_origin.y
        );
    }

    #[test]
    fn speed_cycle_advances_and_wraps() {
        assert_eq!(next_speed(0.5), 0.75);
        assert_eq!(next_speed(1.0), 1.25);
        assert_eq!(next_speed(2.0), 0.5);
        assert_eq!(next_speed(1.1), 1.25);
    }

    #[test]
    fn fit_cycle_uses_the_contract_labels_and_wraps() {
        assert_eq!(next_video_fit_mode(VideoFitMode::Fit), VideoFitMode::Fill);
        assert_eq!(
            next_video_fit_mode(VideoFitMode::Fill),
            VideoFitMode::Stretch
        );
        assert_eq!(
            next_video_fit_mode(VideoFitMode::Stretch),
            VideoFitMode::Fit
        );
        assert_eq!(VideoFitMode::Fit.label(), "맞춤");
        assert_eq!(VideoFitMode::Fill.label(), "채우기");
        assert_eq!(VideoFitMode::Stretch.label(), "늘이기");
    }

    #[test]
    fn subtitle_delay_steps_are_tenths_and_recover_from_invalid_state() {
        assert_eq!(step_subtitle_delay(0.0, -0.1), -0.1);
        assert_eq!(step_subtitle_delay(-0.1, 0.1), 0.0);
        assert_eq!(step_subtitle_delay(0.25, 0.1), 0.4);
        assert_eq!(step_subtitle_delay(f64::NAN, 0.1), 0.1);
        assert_eq!(subtitle_delay_label(0.0), "0.0s");
        assert_eq!(subtitle_delay_label(0.1), "+0.1s");
        assert_eq!(subtitle_delay_label(-0.1), "-0.1s");
    }

    #[test]
    fn loop_validity_requires_finite_non_negative_ordered_bounds() {
        assert!(!loop_is_valid(None, Some(2.0)));
        assert!(!loop_is_valid(Some(-1.0), Some(2.0)));
        assert!(!loop_is_valid(Some(2.0), Some(2.0)));
        assert!(!loop_is_valid(Some(3.0), Some(2.0)));
        assert!(!loop_is_valid(Some(f64::NAN), Some(2.0)));
        assert!(loop_is_valid(Some(1.0), Some(2.0)));
    }

    #[test]
    fn output_helpers_keep_one_command_and_record_gif_request() {
        let mut output = PlayerUiOutput::default();
        set_command(&mut output, PlayerCommand::StepFrameBackward);
        set_command(&mut output, PlayerCommand::StepFrameForward);
        assert!(matches!(
            output.command,
            Some(PlayerCommand::StepFrameBackward)
        ));
        assert!(!output.gif_requested);
        request_gif(&mut output);
        assert!(output.gif_requested);
        apply_keyboard_action(KeyboardAction::TogglePoseMarker, &mut output);
        apply_keyboard_action(KeyboardAction::SetRating(5), &mut output);
        assert!(output.pose_marker_toggle_requested);
        assert_eq!(output.rating_requested, Some(5));
    }

    #[test]
    fn keyboard_mapping_restores_all_documented_actions() {
        let snapshot = PlayerSnapshot {
            volume: 98.0,
            ..PlayerSnapshot::default()
        };
        let shortcuts = PlayerShortcuts::default();
        let bindings = keyboard_bindings(&snapshot, false, shortcuts);
        assert_eq!(
            bindings[0],
            (
                shortcuts.get(ShortcutAction::TogglePause),
                KeyboardAction::Command(PlayerCommandKind::TogglePause)
            )
        );
        assert_eq!(
            bindings[1],
            (
                shortcuts.get(ShortcutAction::SeekBackward),
                KeyboardAction::Command(PlayerCommandKind::SeekRelative(-5.0))
            )
        );
        assert_eq!(
            bindings[2],
            (
                shortcuts.get(ShortcutAction::SeekForward),
                KeyboardAction::Command(PlayerCommandKind::SeekRelative(5.0))
            )
        );
        assert_eq!(
            bindings[3],
            (
                shortcuts.get(ShortcutAction::VolumeUp),
                KeyboardAction::Command(PlayerCommandKind::SetVolume(100.0))
            )
        );
        assert_eq!(
            bindings[4],
            (
                shortcuts.get(ShortcutAction::VolumeDown),
                KeyboardAction::Command(PlayerCommandKind::SetVolume(93.0))
            )
        );
        assert_eq!(bindings[5].0, shortcuts.get(ShortcutAction::ToggleMute));
        assert_eq!(
            bindings[6].0,
            shortcuts.get(ShortcutAction::ToggleSubtitles)
        );
        assert_eq!(
            bindings[7],
            (
                shortcuts.get(ShortcutAction::ToggleFullscreen),
                KeyboardAction::Fullscreen
            )
        );
        assert!(!bindings
            .iter()
            .any(|(shortcut, _)| shortcut.logical_key == Key::Escape));

        let fullscreen_bindings = keyboard_bindings(&snapshot, true, shortcuts);
        assert_eq!(
            fullscreen_bindings.last(),
            Some(&(
                egui::KeyboardShortcut::new(Modifiers::NONE, Key::Escape),
                KeyboardAction::Fullscreen
            ))
        );
    }

    #[test]
    fn keyboard_mapping_uses_the_customized_shortcut() {
        let mut shortcuts = PlayerShortcuts::default();
        shortcuts.assign_and_swap(
            ShortcutAction::TogglePause,
            egui::KeyboardShortcut::new(Modifiers::COMMAND, Key::P),
        );
        let bindings = keyboard_bindings(&PlayerSnapshot::default(), false, shortcuts);
        assert_eq!(
            bindings[0],
            (
                egui::KeyboardShortcut::new(Modifiers::COMMAND, Key::P),
                KeyboardAction::Command(PlayerCommandKind::TogglePause)
            )
        );
    }

    #[test]
    fn keyboard_mapping_includes_marking_editing_and_zero_to_five_ratings() {
        let snapshot = PlayerSnapshot {
            position: 12.5,
            ..PlayerSnapshot::default()
        };
        let shortcuts = PlayerShortcuts::default();
        let bindings = keyboard_bindings(&snapshot, false, shortcuts);
        assert!(bindings.contains(&(
            shortcuts.get(ShortcutAction::TogglePoseMarker),
            KeyboardAction::TogglePoseMarker
        )));
        assert!(bindings.contains(&(
            shortcuts.get(ShortcutAction::StepFrameBackward),
            KeyboardAction::Command(PlayerCommandKind::StepFrameBackward)
        )));
        assert!(bindings.contains(&(
            shortcuts.get(ShortcutAction::SetLoopA),
            KeyboardAction::Command(PlayerCommandKind::SetLoopA(12.5))
        )));
        for action in ShortcutAction::RATING {
            assert!(bindings.contains(&(
                shortcuts.get(action),
                KeyboardAction::SetRating(action.rating().expect("rating action"))
            )));
        }
    }

    #[test]
    fn the_range_control_cycles_through_every_mode_and_returns_to_auto() {
        // One click has to reach each mode and come back, or a user could never
        // undo a forced range without restarting playback.
        assert_eq!(
            next_color_range(ColorRangeMode::Auto),
            ColorRangeMode::Limited
        );
        assert_eq!(
            next_color_range(ColorRangeMode::Limited),
            ColorRangeMode::Full
        );
        assert_eq!(next_color_range(ColorRangeMode::Full), ColorRangeMode::Auto);
        assert_eq!(ColorRangeMode::Auto.label(), "자동");
        assert_eq!(ColorRangeMode::Limited.label(), "16–235");
        assert_eq!(ColorRangeMode::Full.label(), "0–255");
    }

    #[test]
    fn every_player_control_uses_the_shared_control_height() {
        assert_eq!(CONTROL_ROW_HEIGHT, metric::CONTROL_HEIGHT);
        assert!(SCRUBBER_HIT_HEIGHT < CONTROL_ROW_HEIGHT);
    }
}
