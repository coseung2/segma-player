//! Aura Media Companion manager window.
//!
//! Native Rust GUI built from the Figma design system in `../design-system`.
//! It reads companion job state from disk and issues the two actions the
//! native messaging protocol supports: cancel a job, open the downloads folder.
//!
//! This binary opens no network listener. It is a local desktop window that
//! only touches the companion's own folders.

#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod app;
mod jobs;
mod model;
mod theme;
mod widgets;

use app::ManagerApp;
use theme::metric;

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: eframe::egui::ViewportBuilder::default()
            .with_title("Aura Media Companion")
            .with_inner_size(metric::WINDOW_DEFAULT)
            .with_min_inner_size(metric::WINDOW_MIN),
        ..Default::default()
    };

    eframe::run_native(
        "Aura Media Companion",
        options,
        Box::new(|context| Ok(Box::new(ManagerApp::new(&context.egui_ctx)))),
    )
}
