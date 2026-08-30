//! Segma Player manager window.
//!
//! Native Rust GUI built from the Figma design system in `../design-system`.
//! It reads companion job state from disk and issues the two actions the
//! native messaging protocol supports: cancel a job, open the downloads folder.
//!
//! This binary opens no network listener. It is a local desktop window that
//! only touches the companion's own folders.

#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod app;
mod gif_export;
mod icons;
mod jobs;
mod library_controller;
mod library_state;
mod license;
mod license_controller;
mod manager_poll;
mod model;
mod pip_controller;
mod player_backend;
mod player_contract;
mod player_session;
mod player_surface;
mod player_ui;
mod queue_controller;
mod seek_preview;
mod shortcuts;
mod theme;
mod thumbnails;
mod widgets;

use app::ManagerApp;
use theme::metric;

#[cfg(target_os = "windows")]
use std::os::raw::c_void;

#[cfg(target_os = "windows")]
type Handle = *mut c_void;

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateMutexW(attributes: *const c_void, initial_owner: i32, name: *const u16) -> Handle;
    fn GetLastError() -> u32;
}

#[cfg(target_os = "windows")]
const ERROR_ALREADY_EXISTS: u32 = 183;

#[cfg(target_os = "windows")]
fn manager_instance_guard() -> Option<Handle> {
    let name: Vec<u16> = "Local\\AuraMediaCompanionManager\0"
        .encode_utf16()
        .collect();
    // SAFETY: `name` is a live, null-terminated UTF-16 buffer. The returned
    // handle intentionally stays open for the process lifetime.
    let handle = unsafe { CreateMutexW(std::ptr::null(), 1, name.as_ptr()) };
    if handle.is_null() || unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        None
    } else {
        Some(handle)
    }
}

#[cfg(not(target_os = "windows"))]
fn manager_instance_guard() -> Option<()> {
    Some(())
}

#[cfg(target_os = "windows")]
fn refresh_shell_icon_cache() {
    use windows::Win32::UI::Shell::{
        SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_FLUSHNOWAIT, SHCNF_IDLIST,
    };

    // The embedded icon can change while the executable path remains stable.
    // Tell Explorer to invalidate its icon image list before the window appears,
    // otherwise the taskbar can keep rendering the previous release indefinitely.
    unsafe {
        SHChangeNotify(
            SHCNE_ASSOCCHANGED,
            SHCNF_IDLIST | SHCNF_FLUSHNOWAIT,
            None,
            None,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn refresh_shell_icon_cache() {}

fn main() -> eframe::Result<()> {
    let Some(_instance_guard) = manager_instance_guard() else {
        return Ok(());
    };
    refresh_shell_icon_cache();
    let icon = eframe::icon_data::from_png_bytes(include_bytes!(
        "../../assets/microsoft-store/listing/store-logo-50x50.png"
    ))
    .expect("bundled Segma window icon must be valid PNG");
    let options = eframe::NativeOptions {
        viewport: eframe::egui::ViewportBuilder::default()
            .with_title("Segma Player")
            .with_icon(icon)
            .with_inner_size(metric::WINDOW_DEFAULT)
            .with_min_inner_size(metric::WINDOW_MIN),
        ..Default::default()
    };

    eframe::run_native(
        "Segma Player",
        options,
        Box::new(|context| Ok(Box::new(ManagerApp::new(&context.egui_ctx)))),
    )
}
