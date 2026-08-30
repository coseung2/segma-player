//! Native child-window ownership for the embedded player.
//!
//! Exactly one `PlayerSurface` owns the mpv target HWND. The UI thread creates,
//! positions, clips, hides, and destroys that child; the player backend only
//! receives its handle through the existing `SetVideoWindow` command.

use eframe::egui;

use crate::player_contract::PhysicalVideoRect;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SurfaceLayout {
    pub(crate) rect: PhysicalVideoRect,
    pub(crate) visible: bool,
    pub(crate) clip_height: Option<i32>,
}

impl SurfaceLayout {
    pub(crate) fn player(rect: PhysicalVideoRect, clip_height: Option<i32>) -> Self {
        Self {
            rect,
            visible: rect.visible(),
            clip_height,
        }
    }

    pub(crate) fn pip(rect: PhysicalVideoRect) -> Self {
        Self {
            rect,
            visible: rect.visible(),
            clip_height: None,
        }
    }

    pub(crate) fn hidden() -> Self {
        Self {
            rect: PhysicalVideoRect::default(),
            visible: false,
            clip_height: None,
        }
    }
}

#[derive(Default)]
pub(crate) struct PlayerSurface {
    parent_hwnd: isize,
    taskbar_icon_applied: bool,
    video_hwnd: isize,
}

impl PlayerSurface {
    /// Attach to eframe's root viewport once and return a newly created child
    /// handle. The caller must send that handle to mpv before any media command.
    pub(crate) fn ensure_attached(&mut self, frame: &eframe::Frame) -> Option<isize> {
        let hwnd = frame_hwnd(frame)?;
        if !self.taskbar_icon_applied {
            self.taskbar_icon_applied = apply_taskbar_icon(hwnd);
        }
        if self.parent_hwnd != 0 {
            return None;
        }
        self.parent_hwnd = hwnd;
        self.video_hwnd = create_video_window(hwnd).unwrap_or(0);
        (self.video_hwnd != 0).then_some(self.video_hwnd)
    }

    /// Remove any previous fullscreen clip before egui computes the next
    /// Player frame. This preserves the existing Player/PiP transition order.
    pub(crate) fn begin_player_frame(&self) {
        clear_video_window_region(self.video_hwnd);
    }

    pub(crate) fn apply(&self, layout: SurfaceLayout) {
        if layout.clip_height.is_none() {
            clear_video_window_region(self.video_hwnd);
        }
        layout_video_window(self.video_hwnd, layout.rect, layout.visible);
        if let Some(height) = layout.clip_height {
            clip_video_window_height(self.video_hwnd, layout.rect.width, height);
        }
    }

    pub(crate) fn clear_clip(&self) {
        clear_video_window_region(self.video_hwnd);
    }

    /// Hiding always clears the last region first, matching the old inline
    /// teardown and preventing a fullscreen clip from leaking into a later PiP.
    pub(crate) fn hide(&self) {
        self.apply(SurfaceLayout::hidden());
    }

    pub(crate) fn shutdown(&mut self) {
        destroy_video_window(self.video_hwnd);
        self.video_hwnd = 0;
        self.parent_hwnd = 0;
    }
}

impl Drop for PlayerSurface {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Current primary-pointer state even when the native mpv child owns input.
#[cfg(target_os = "windows")]
pub(crate) fn native_primary_pointer_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};

    unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0 }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn native_primary_pointer_down() -> bool {
    false
}

/// OS cursor converted to the root viewport's logical egui coordinates.
#[cfg(target_os = "windows")]
pub(crate) fn native_pointer_position(context: &egui::Context) -> Option<egui::Pos2> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point).ok()? };
    let scale = context.pixels_per_point().max(f32::EPSILON);
    let origin = context
        .input(|input| input.viewport().inner_rect.map(|rect| rect.min))
        .unwrap_or(egui::Pos2::ZERO);
    Some(egui::pos2(
        point.x as f32 / scale - origin.x,
        point.y as f32 / scale - origin.y,
    ))
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn native_pointer_position(_context: &egui::Context) -> Option<egui::Pos2> {
    None
}

#[cfg(target_os = "windows")]
fn frame_hwnd(frame: &eframe::Frame) -> Option<isize> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    match frame.window_handle().ok()?.as_raw() {
        RawWindowHandle::Win32(handle) => Some(handle.hwnd.get()),
        _ => None,
    }
}

#[cfg(not(target_os = "windows"))]
fn frame_hwnd(_frame: &eframe::Frame) -> Option<isize> {
    None
}

#[cfg(target_os = "windows")]
fn apply_taskbar_icon(window: isize) -> bool {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        LoadImageW, SendMessageW, SetClassLongPtrW, GCLP_HICON, GCLP_HICONSM, HICON, ICON_BIG,
        ICON_SMALL, IMAGE_ICON, WM_SETICON,
    };

    let hwnd = HWND(window as *mut core::ffi::c_void);
    let Ok(module) = (unsafe { GetModuleHandleW(None) }) else {
        return false;
    };
    let load = |cx: i32, cy: i32| unsafe {
        LoadImageW(
            Some(module.into()),
            windows::core::w!("#1"),
            IMAGE_ICON,
            cx,
            cy,
            windows::Win32::UI::WindowsAndMessaging::LR_DEFAULTCOLOR,
        )
        .ok()
        .map(|image| HICON(image.0))
    };
    let Some(small) = load(16, 16) else {
        return false;
    };
    let Some(big) = load(32, 32).or_else(|| load(256, 256)) else {
        return false;
    };
    unsafe {
        let _ = SendMessageW(
            hwnd,
            WM_SETICON,
            Some(WPARAM(ICON_SMALL as usize)),
            Some(LPARAM(small.0 as isize)),
        );
        let _ = SendMessageW(
            hwnd,
            WM_SETICON,
            Some(WPARAM(ICON_BIG as usize)),
            Some(LPARAM(big.0 as isize)),
        );
        let _ = SetClassLongPtrW(hwnd, GCLP_HICONSM, small.0 as isize);
        let _ = SetClassLongPtrW(hwnd, GCLP_HICON, big.0 as isize);
    }
    true
}

#[cfg(not(target_os = "windows"))]
fn apply_taskbar_icon(_window: isize) -> bool {
    true
}

#[cfg(target_os = "windows")]
fn create_video_window(parent: isize) -> windows::core::Result<isize> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, WINDOW_EX_STYLE, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
    };

    // SAFETY: called on eframe's UI thread; STATIC is a predefined class and
    // the supplied parent is the live viewport HWND.
    let window = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("STATIC"),
            PCWSTR::null(),
            WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
            0,
            0,
            1,
            1,
            Some(HWND(parent as *mut core::ffi::c_void)),
            None,
            None,
            None,
        )?
    };
    Ok(window.0 as isize)
}

#[cfg(not(target_os = "windows"))]
fn create_video_window(_parent: isize) -> Result<isize, ()> {
    Err(())
}

#[cfg(target_os = "windows")]
fn layout_video_window(window: isize, rect: PhysicalVideoRect, visible: bool) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, ShowWindow, HWND_TOP, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SW_HIDE, SW_SHOWNA,
    };

    if window == 0 {
        return;
    }
    let window = HWND(window as *mut core::ffi::c_void);
    if visible && rect.visible() {
        let positioned = unsafe {
            SetWindowPos(
                window,
                Some(HWND_TOP),
                rect.x,
                rect.y,
                rect.width,
                rect.height,
                SWP_NOOWNERZORDER | SWP_NOACTIVATE,
            )
        };
        if positioned.is_ok() {
            let _ = unsafe { ShowWindow(window, SW_SHOWNA) };
        }
    } else {
        let _ = unsafe { ShowWindow(window, SW_HIDE) };
    }
}

#[cfg(not(target_os = "windows"))]
fn layout_video_window(_window: isize, _rect: PhysicalVideoRect, _visible: bool) {}

#[cfg(target_os = "windows")]
fn clear_video_window_region(window: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::SetWindowRgn;

    if window == 0 {
        return;
    }
    unsafe {
        let _ = SetWindowRgn(HWND(window as *mut core::ffi::c_void), None, true);
    }
}

#[cfg(not(target_os = "windows"))]
fn clear_video_window_region(_window: isize) {}

/// Clip, but do not resize, the embedded video child so egui can own one
/// fullscreen control band in the root viewport.
#[cfg(target_os = "windows")]
fn clip_video_window_height(window: isize, width: i32, height: i32) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{CreateRectRgn, DeleteObject, SetWindowRgn};

    if window == 0 || width <= 1 || height <= 1 {
        return;
    }
    let region = unsafe { CreateRectRgn(0, 0, width, height) };
    if region.is_invalid() {
        return;
    }
    // Windows owns the region after a successful SetWindowRgn call.
    if unsafe { SetWindowRgn(HWND(window as *mut core::ffi::c_void), Some(region), true) } == 0 {
        let _ = unsafe { DeleteObject(region.into()) };
    }
}

#[cfg(not(target_os = "windows"))]
fn clip_video_window_height(_window: isize, _width: i32, _height: i32) {}

#[cfg(target_os = "windows")]
fn destroy_video_window(window: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::DestroyWindow;

    if window != 0 {
        let _ = unsafe { DestroyWindow(HWND(window as *mut core::ffi::c_void)) };
    }
}

#[cfg(not(target_os = "windows"))]
fn destroy_video_window(_window: isize) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect() -> PhysicalVideoRect {
        PhysicalVideoRect {
            x: 40,
            y: 60,
            width: 1280,
            height: 720,
        }
    }

    #[test]
    fn player_layout_keeps_video_geometry_and_fullscreen_clip_separate() {
        let layout = SurfaceLayout::player(rect(), Some(640));
        assert_eq!(layout.rect, rect());
        assert!(layout.visible);
        assert_eq!(layout.clip_height, Some(640));
    }

    #[test]
    fn pip_layout_never_inherits_a_fullscreen_clip() {
        let fullscreen = SurfaceLayout::player(rect(), Some(640));
        let pip = SurfaceLayout::pip(rect());
        assert_eq!(pip.rect, fullscreen.rect);
        assert!(pip.visible);
        assert_eq!(pip.clip_height, None);
    }

    #[test]
    fn zero_sized_geometry_is_hidden_for_player_and_pip() {
        let empty = PhysicalVideoRect::default();
        assert!(!SurfaceLayout::player(empty, None).visible);
        assert!(!SurfaceLayout::pip(empty).visible);
        assert_eq!(SurfaceLayout::hidden().rect, empty);
    }

    #[test]
    fn native_window_lifecycle_has_one_owning_boundary() {
        let app = include_str!("app.rs");
        let source = include_str!("player_surface.rs");
        for api in [
            "CreateWindowExW",
            "DestroyWindow",
            "SetWindowPos",
            "ShowWindow",
        ] {
            assert!(!app.contains(api), "ManagerApp must not own {api}");
            assert!(source.contains(api), "native surface must own {api}");
        }
    }

    #[test]
    fn shutdown_without_an_attached_window_is_idempotent() {
        let mut surface = PlayerSurface::default();
        surface.shutdown();
        surface.shutdown();
        assert_eq!(surface.parent_hwnd, 0);
        assert_eq!(surface.video_hwnd, 0);
    }
}
