//! PiP session, geometry, and floating-surface orchestration.
//!
//! The controller owns one in-app egui area. Native video remains the child
//! window owned by `PlayerSurface`; this module only returns its target rect and
//! the same singular player command the previous ManagerApp path emitted.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use eframe::egui::{self, Color32, Vec2};

use crate::jobs::MediaFile;
use crate::player_contract::{PhysicalVideoRect, PlayerCommand, PlayerSnapshot};
use crate::player_surface::{native_pointer_position, native_primary_pointer_down};
use crate::player_ui;
use crate::seek_preview::SeekPreviewController;
use crate::theme::{color, corner, radius};

const MINI_PLAYER_WIDTH: f32 = 320.0;
const MINI_PLAYER_MARGIN: f32 = 20.0;
const MINI_PLAYER_DRAG_HEIGHT: f32 = 32.0;
const MINI_PLAYER_CONTROLS_HEIGHT: f32 = 56.0;
const MINI_PLAYER_PREVIEW_WIDTH: f32 = 128.0;
/// 128x72 image plus a compact 20-point timecode strip.
const MINI_PLAYER_PREVIEW_HEIGHT: f32 = 92.0;
const MINI_PLAYER_MIN_WIDTH: f32 = 240.0;
const MINI_PLAYER_MAX_WIDTH: f32 = 640.0;
/// Native mpv never covers this perimeter, so all eight resize targets receive
/// pointer input even while the child window is topmost.
const MINI_PLAYER_RESIZE_GUTTER: f32 = 18.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PipResizeEdge {
    Left,
    Right,
    Top,
    Bottom,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl PipResizeEdge {
    const ALL: [Self; 8] = [
        Self::Left,
        Self::Right,
        Self::Top,
        Self::Bottom,
        Self::TopLeft,
        Self::TopRight,
        Self::BottomLeft,
        Self::BottomRight,
    ];

    fn id(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
            Self::Top => "top",
            Self::Bottom => "bottom",
            Self::TopLeft => "top-left",
            Self::TopRight => "top-right",
            Self::BottomLeft => "bottom-left",
            Self::BottomRight => "bottom-right",
        }
    }

    fn cursor(self) -> egui::CursorIcon {
        match self {
            Self::Left | Self::Right => egui::CursorIcon::ResizeHorizontal,
            Self::Top | Self::Bottom => egui::CursorIcon::ResizeVertical,
            Self::TopRight | Self::BottomLeft => egui::CursorIcon::ResizeNeSw,
            Self::TopLeft | Self::BottomRight => egui::CursorIcon::ResizeNwSe,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct PipResizeDrag {
    edge: PipResizeEdge,
    start_width: f32,
    start_position: egui::Pos2,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct PipGeometry {
    surface: egui::Rect,
    drag_strip: egui::Rect,
    video: egui::Rect,
    controls: egui::Rect,
}

impl PipGeometry {
    fn size(width: f32) -> Vec2 {
        let video_height = width * 9.0 / 16.0;
        Vec2::new(
            width + MINI_PLAYER_RESIZE_GUTTER * 2.0,
            MINI_PLAYER_RESIZE_GUTTER * 2.0
                + MINI_PLAYER_DRAG_HEIGHT
                + video_height
                + MINI_PLAYER_CONTROLS_HEIGHT,
        )
    }

    fn at(origin: egui::Pos2, width: f32) -> Self {
        let surface = egui::Rect::from_min_size(origin, Self::size(width));
        let content_left = surface.left() + MINI_PLAYER_RESIZE_GUTTER;
        let content_top = surface.top() + MINI_PLAYER_RESIZE_GUTTER;
        let drag_strip = egui::Rect::from_min_size(
            egui::pos2(content_left, content_top),
            Vec2::new(width, MINI_PLAYER_DRAG_HEIGHT),
        );
        let video = egui::Rect::from_min_size(
            egui::pos2(content_left, drag_strip.bottom()),
            Vec2::new(width, width * 9.0 / 16.0),
        );
        let controls = egui::Rect::from_min_max(
            egui::Pos2::new(content_left, video.bottom()),
            egui::Pos2::new(
                content_left + width,
                video.bottom() + MINI_PLAYER_CONTROLS_HEIGHT,
            ),
        );
        Self {
            surface,
            drag_strip,
            video,
            controls,
        }
    }

    fn handle(self, edge: PipResizeEdge) -> egui::Rect {
        let surface = self.surface;
        let gutter = MINI_PLAYER_RESIZE_GUTTER;
        match edge {
            PipResizeEdge::Left => egui::Rect::from_min_max(
                egui::pos2(surface.left(), surface.top() + gutter),
                egui::pos2(surface.left() + gutter, surface.bottom() - gutter),
            ),
            PipResizeEdge::Right => egui::Rect::from_min_max(
                egui::pos2(surface.right() - gutter, surface.top() + gutter),
                egui::pos2(surface.right(), surface.bottom() - gutter),
            ),
            PipResizeEdge::Top => egui::Rect::from_min_max(
                egui::pos2(surface.left() + gutter, surface.top()),
                egui::pos2(surface.right() - gutter, surface.top() + gutter),
            ),
            PipResizeEdge::Bottom => egui::Rect::from_min_max(
                egui::pos2(surface.left() + gutter, surface.bottom() - gutter),
                egui::pos2(surface.right() - gutter, surface.bottom()),
            ),
            PipResizeEdge::TopLeft => {
                egui::Rect::from_min_size(surface.left_top(), Vec2::splat(gutter))
            }
            PipResizeEdge::TopRight => egui::Rect::from_min_size(
                egui::pos2(surface.right() - gutter, surface.top()),
                Vec2::splat(gutter),
            ),
            PipResizeEdge::BottomLeft => egui::Rect::from_min_size(
                egui::pos2(surface.left(), surface.bottom() - gutter),
                Vec2::splat(gutter),
            ),
            PipResizeEdge::BottomRight => egui::Rect::from_min_size(
                surface.right_bottom() - Vec2::splat(gutter),
                Vec2::splat(gutter),
            ),
        }
    }
}

fn pip_resize_width(edge: PipResizeEdge, start_width: f32, delta: Vec2) -> f32 {
    let horizontal = match edge {
        PipResizeEdge::Left | PipResizeEdge::TopLeft | PipResizeEdge::BottomLeft => -delta.x,
        PipResizeEdge::Right | PipResizeEdge::TopRight | PipResizeEdge::BottomRight => delta.x,
        PipResizeEdge::Top | PipResizeEdge::Bottom => 0.0,
    };
    let vertical = match edge {
        PipResizeEdge::Top | PipResizeEdge::TopLeft | PipResizeEdge::TopRight => {
            -delta.y * 16.0 / 9.0
        }
        PipResizeEdge::Bottom | PipResizeEdge::BottomLeft | PipResizeEdge::BottomRight => {
            delta.y * 16.0 / 9.0
        }
        PipResizeEdge::Left | PipResizeEdge::Right => 0.0,
    };
    let delta = match edge {
        PipResizeEdge::Left | PipResizeEdge::Right => horizontal,
        PipResizeEdge::Top | PipResizeEdge::Bottom => vertical,
        _ if horizontal.abs() >= vertical.abs() => horizontal,
        _ => vertical,
    };
    (start_width + delta).clamp(MINI_PLAYER_MIN_WIDTH, MINI_PLAYER_MAX_WIDTH)
}

fn pip_resize_position(
    edge: PipResizeEdge,
    start_position: egui::Pos2,
    start_width: f32,
    width: f32,
) -> egui::Pos2 {
    let mut position = start_position;
    if matches!(
        edge,
        PipResizeEdge::Left | PipResizeEdge::TopLeft | PipResizeEdge::BottomLeft
    ) {
        position.x += start_width - width;
    }
    if matches!(
        edge,
        PipResizeEdge::Top | PipResizeEdge::TopLeft | PipResizeEdge::TopRight
    ) {
        position.y += (start_width - width) * 9.0 / 16.0;
    }
    position
}

#[derive(Debug, Default)]
pub(crate) struct PipFrameOutput {
    pub(crate) video_rect: PhysicalVideoRect,
    pub(crate) command: Option<PlayerCommand>,
    pub(crate) close_requested: bool,
    pub(crate) return_to_player_requested: bool,
}

pub(crate) struct PipController {
    armed: bool,
    dismissed: bool,
    position: Option<egui::Pos2>,
    width: f32,
    move_until: Option<Instant>,
    move_offset: Vec2,
    move_start: Option<egui::Pos2>,
    resize_drag: Option<PipResizeDrag>,
}

impl Default for PipController {
    fn default() -> Self {
        Self {
            armed: false,
            dismissed: false,
            position: None,
            width: MINI_PLAYER_WIDTH,
            move_until: None,
            move_offset: Vec2::ZERO,
            move_start: None,
            resize_drag: None,
        }
    }
}

impl PipController {
    pub(crate) fn reset_for_load(&mut self) {
        self.armed = false;
        self.dismissed = false;
    }

    pub(crate) fn stop(&mut self) {
        self.armed = false;
        self.dismissed = true;
        self.cancel_pointer_gestures();
    }

    pub(crate) fn return_to_player(&mut self) {
        self.dismissed = false;
    }

    /// Advance the loaded-session state and report whether PiP should render.
    /// Pausing preserves PiP; unload, engine failure, explicit close, or the
    /// Player view suppresses it exactly as before extraction.
    pub(crate) fn should_show(&mut self, player_view: bool, snapshot: &PlayerSnapshot) -> bool {
        let loaded = pip_is_active(snapshot);
        if player_view {
            self.armed = loaded;
            self.dismissed = self.dismissed && !loaded;
            return false;
        }
        self.armed = self.armed && loaded;
        self.armed && !self.dismissed && loaded
    }

    pub(crate) fn render(
        &mut self,
        context: &egui::Context,
        snapshot: &PlayerSnapshot,
        loaded_file: Option<&str>,
        media_files: &[MediaFile],
        seek_preview: &mut SeekPreviewController,
    ) -> PipFrameOutput {
        if !pip_is_active(snapshot) || self.dismissed {
            seek_preview.hide();
            self.cancel_pointer_gestures();
            return PipFrameOutput::default();
        }

        let mut controls_output = player_ui::PlayerUiOutput::default();
        let mut physical_video_rect = PhysicalVideoRect::default();
        let pip_width = self.width;
        let surface_size = PipGeometry::size(pip_width);
        let mut area = egui::Area::new(egui::Id::new("segma-pip-surface"))
            .order(egui::Order::Foreground)
            .movable(false)
            .constrain_to(context.content_rect());
        area = if let Some(position) = self.position {
            area.current_pos(position)
        } else {
            area.default_pos(
                context.content_rect().right_bottom()
                    - Vec2::new(
                        surface_size.x + MINI_PLAYER_MARGIN,
                        surface_size.y + MINI_PLAYER_MARGIN,
                    ),
            )
        };

        let mut next_width = None;
        let mut next_position = None;
        let mut dragged_position = None;
        let mut resize_finished = false;
        let shown = area.show(context, |ui| {
            let (surface, _) = ui.allocate_exact_size(surface_size, egui::Sense::hover());
            let geometry = PipGeometry::at(surface.min, pip_width);
            ui.painter()
                .rect_filled(surface, corner(radius::MD), color::BG_INVERSE);

            let drag_response = ui.interact(
                geometry.drag_strip,
                ui.id().with("pip-drag-strip"),
                egui::Sense::drag(),
            );
            if drag_response.hovered() || drag_response.dragged() {
                ui.ctx().set_cursor_icon(egui::CursorIcon::Grab);
            }
            if drag_response.drag_started() {
                self.move_start = Some(surface.min);
                self.move_until = Some(Instant::now() + Duration::from_secs(20));
                self.move_offset = drag_response
                    .interact_pointer_pos()
                    .map_or(Vec2::ZERO, |pointer| pointer - surface.min);
            }
            if drag_response.dragged() {
                dragged_position = Some(
                    self.move_start.unwrap_or(surface.min)
                        + drag_response.total_drag_delta().unwrap_or_default(),
                );
            }
            if drag_response.drag_stopped() {
                self.move_until = None;
                self.move_start = None;
            }
            let grip =
                egui::Rect::from_center_size(geometry.drag_strip.center(), Vec2::new(56.0, 4.0));
            ui.painter()
                .rect_filled(grip, corner(radius::FULL), Color32::from_white_alpha(128));

            physical_video_rect = player_ui::physical_rect(ui, geometry.video);
            player_ui::pip_controls(
                ui,
                geometry.controls,
                snapshot,
                &mut controls_output,
                Vec2::new(MINI_PLAYER_PREVIEW_WIDTH, MINI_PLAYER_PREVIEW_HEIGHT),
            );
            for edge in PipResizeEdge::ALL {
                let response = ui.interact(
                    geometry.handle(edge),
                    ui.id().with(("pip-resize-handle", edge.id())),
                    egui::Sense::drag(),
                );
                if response.hovered() || response.dragged() {
                    ui.ctx().set_cursor_icon(edge.cursor());
                }
                if response.drag_started() {
                    self.resize_drag = Some(PipResizeDrag {
                        edge,
                        start_width: pip_width,
                        start_position: surface.min,
                    });
                }
                if response.dragged() {
                    if let Some(drag) = self.resize_drag.filter(|drag| drag.edge == edge) {
                        let width = pip_resize_width(
                            edge,
                            drag.start_width,
                            response.total_drag_delta().unwrap_or_default(),
                        );
                        next_width = Some(width);
                        next_position = Some(pip_resize_position(
                            edge,
                            drag.start_position,
                            drag.start_width,
                            width,
                        ));
                    }
                }
                if response.drag_stopped() {
                    resize_finished = true;
                }
            }
            let resize_grip = geometry.handle(PipResizeEdge::BottomRight);
            for inset in [4.0, 8.0, 12.0] {
                ui.painter().line_segment(
                    [
                        egui::pos2(resize_grip.right() - inset, resize_grip.bottom() - 2.0),
                        egui::pos2(resize_grip.right() - 2.0, resize_grip.bottom() - inset),
                    ],
                    egui::Stroke::new(1.0, Color32::from_white_alpha(120)),
                );
            }
        });

        if resize_finished {
            self.resize_drag = None;
        }
        if self
            .move_until
            .is_some_and(|deadline| deadline > Instant::now())
        {
            if native_primary_pointer_down() {
                if let Some(pointer) = native_pointer_position(context) {
                    dragged_position = Some(pointer - self.move_offset);
                    context.request_repaint();
                }
            } else {
                self.move_until = None;
                self.move_start = None;
            }
        } else {
            self.move_until = None;
        }
        self.position = Some(
            next_position
                .or(dragged_position)
                .unwrap_or(shown.response.rect.min),
        );
        if let Some(width) = next_width {
            self.width = width;
        }

        if let (Some(hover), Some(path)) =
            (controls_output.hover_preview, snapshot.loaded_path.as_ref())
        {
            let media_key = loaded_file
                .and_then(|name| media_files.iter().find(|file| file.file_name == name))
                .map(crate::thumbnails::key)
                .unwrap_or_else(|| path.to_string_lossy().into_owned());
            seek_preview.request(
                context,
                media_key,
                PathBuf::from(path),
                hover.target,
                snapshot.duration,
            );
            let visual = seek_preview.visual();
            player_ui::show_seek_preview_overlay(
                context,
                hover.placement,
                hover.size,
                visual.map(|visual| visual.texture),
                visual.map_or("00:00", |visual| visual.timecode),
            );
        } else {
            seek_preview.hide();
        }

        PipFrameOutput {
            video_rect: if controls_output.pip_close_requested {
                PhysicalVideoRect::default()
            } else {
                physical_video_rect
            },
            command: controls_output.command,
            close_requested: controls_output.pip_close_requested,
            return_to_player_requested: controls_output.fullscreen_requested,
        }
    }

    fn cancel_pointer_gestures(&mut self) {
        self.move_until = None;
        self.move_start = None;
        self.resize_drag = None;
    }
}

fn pip_is_active(snapshot: &PlayerSnapshot) -> bool {
    snapshot.engine_available && snapshot.loaded_path.is_some() && snapshot.error.is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loaded_snapshot(paused: bool) -> PlayerSnapshot {
        PlayerSnapshot {
            engine_available: true,
            loaded_path: Some(PathBuf::from("movie.mp4")),
            paused,
            ..PlayerSnapshot::default()
        }
    }

    #[test]
    fn loaded_player_enters_pip_on_navigation_and_returns_without_dismissal() {
        let snapshot = loaded_snapshot(false);
        let mut pip = PipController::default();

        assert!(!pip.should_show(true, &snapshot));
        assert!(pip.should_show(false, &snapshot));
        pip.return_to_player();
        assert!(!pip.should_show(true, &snapshot));
        assert!(!pip.dismissed);
    }

    #[test]
    fn view_change_alone_never_arms_pip() {
        let mut pip = PipController::default();
        assert!(!pip.should_show(true, &PlayerSnapshot::default()));
        assert!(!pip.should_show(false, &loaded_snapshot(false)));
        assert!(!pip.armed);
    }

    #[test]
    fn paused_media_keeps_pip_but_close_holds_until_player_reentry() {
        let snapshot = loaded_snapshot(true);
        let mut pip = PipController::default();
        pip.should_show(true, &snapshot);
        assert!(pip.should_show(false, &snapshot));

        pip.move_until = Some(Instant::now() + Duration::from_secs(5));
        pip.move_start = Some(egui::pos2(12.0, 20.0));
        pip.resize_drag = Some(PipResizeDrag {
            edge: PipResizeEdge::Right,
            start_width: MINI_PLAYER_WIDTH,
            start_position: egui::Pos2::ZERO,
        });
        pip.stop();
        assert!(!pip.should_show(false, &snapshot));
        assert!(pip.dismissed);
        assert!(pip.move_until.is_none());
        assert!(pip.move_start.is_none());
        assert!(pip.resize_drag.is_none());

        assert!(!pip.should_show(true, &snapshot));
        assert!(
            !pip.dismissed,
            "Player reentry starts a fresh loaded session"
        );
    }

    #[test]
    fn unloaded_or_failed_media_cannot_arm_or_keep_pip() {
        let mut pip = PipController::default();
        let loaded = loaded_snapshot(false);
        pip.should_show(true, &loaded);

        let mut unavailable = loaded.clone();
        unavailable.error = Some("mpv failed".to_string());
        assert!(!pip.should_show(false, &unavailable));
        assert!(!pip.armed);

        let empty = PlayerSnapshot::default();
        assert!(!pip.should_show(true, &empty));
        assert!(!pip.should_show(false, &empty));
    }

    #[test]
    fn pip_geometry_keeps_video_controls_and_all_handles_inside_one_surface() {
        let geometry = PipGeometry::at(egui::pos2(100.0, 80.0), MINI_PLAYER_WIDTH);
        assert_eq!(geometry.video.width(), MINI_PLAYER_WIDTH);
        assert_eq!(geometry.video.height(), MINI_PLAYER_WIDTH * 9.0 / 16.0);
        assert_eq!(geometry.drag_strip.height(), MINI_PLAYER_DRAG_HEIGHT);
        assert_eq!(geometry.controls.height(), MINI_PLAYER_CONTROLS_HEIGHT);
        assert!(geometry.surface.contains_rect(geometry.video));
        assert!(geometry.surface.contains_rect(geometry.controls));
        for edge in PipResizeEdge::ALL {
            assert!(geometry.surface.contains_rect(geometry.handle(edge)));
        }
    }

    #[test]
    fn every_resize_edge_uses_the_drag_origin_and_preserves_its_opposite_anchor() {
        let start = egui::pos2(100.0, 80.0);
        let start_width = 320.0;
        let delta = egui::vec2(40.0, 22.5);
        for edge in PipResizeEdge::ALL {
            let width = pip_resize_width(edge, start_width, delta);
            let position = pip_resize_position(edge, start, start_width, width);
            assert!((MINI_PLAYER_MIN_WIDTH..=MINI_PLAYER_MAX_WIDTH).contains(&width));

            if matches!(
                edge,
                PipResizeEdge::Left | PipResizeEdge::TopLeft | PipResizeEdge::BottomLeft
            ) {
                assert_eq!(position.x + width, start.x + start_width);
            } else {
                assert_eq!(position.x, start.x);
            }
            if matches!(
                edge,
                PipResizeEdge::Top | PipResizeEdge::TopLeft | PipResizeEdge::TopRight
            ) {
                assert_eq!(
                    position.y + width * 9.0 / 16.0,
                    start.y + start_width * 9.0 / 16.0
                );
            } else {
                assert_eq!(position.y, start.y);
            }
        }

        let first = pip_resize_width(PipResizeEdge::Right, start_width, delta);
        assert_eq!(first, 360.0);
        assert_eq!(
            pip_resize_width(PipResizeEdge::Right, start_width, delta),
            first
        );
    }

    #[test]
    fn pip_controller_never_creates_an_extra_native_or_egui_viewport() {
        let source = include_str!("pip_controller.rs");
        let production = &source[..source.find("#[cfg(test)]").unwrap()];
        for forbidden in [
            "CreateWindowExW",
            "DestroyWindow",
            "show_viewport_immediate",
            "show_viewport_deferred",
            "ViewportBuilder",
        ] {
            assert!(
                !production.contains(forbidden),
                "PiP must not use {forbidden}"
            );
        }
    }

    #[test]
    fn pip_controls_use_the_existing_sibling_bar_contract() {
        let geometry = PipGeometry::at(egui::pos2(10.0, 20.0), MINI_PLAYER_WIDTH);
        let layout = player_ui::pip_control_layout(geometry.controls);
        for control in [
            layout.close,
            layout.return_to_tab,
            layout.rewind,
            layout.play,
            layout.forward,
            layout.seek,
            layout.time,
        ] {
            assert!(geometry.controls.contains_rect(control));
            assert!(!geometry.video.intersects(control));
        }
    }
}
