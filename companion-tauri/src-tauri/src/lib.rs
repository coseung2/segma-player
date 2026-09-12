const MAIN_WINDOW_LABEL: &str = "main";

mod commands;
mod jobs;
mod library_state;
mod license;
mod media;
mod model;
mod subtitles;

#[cfg(desktop)]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // This must be the first plugin so a second launch is routed to the
    // already-running process before any future plugin can interfere.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main_window(app);
        }));
    }

    builder
        .invoke_handler(tauri::generate_handler![
            commands::cloud::cloud_status,
            commands::cloud::list_cloud_items,
            commands::cloud::list_cloud_jobs,
            commands::cloud::pick_cloud_upload,
            commands::cloud::pick_cloud_download_destination,
            commands::cloud::start_cloud_upload,
            commands::cloud::start_cloud_download,
            commands::cloud::start_cloud_delete,
            commands::cloud::cancel_cloud_job,
            commands::jobs::list_jobs,
            commands::jobs::cancel_job,
            commands::jobs::pause_job,
            commands::jobs::resume_job,
            commands::jobs::retry_job,
            commands::jobs::resolve_job_output,
            commands::library::list_library,
            commands::library::update_library_metadata,
            commands::library::move_library_file,
            commands::library::delete_library_file,
            commands::library::delete_library_files,
            commands::library::auto_organize_library,
            commands::license::get_license,
            commands::license::verify_license,
            commands::license::remove_license,
            commands::settings::get_settings,
            commands::settings::update_download_folder,
            commands::media::prepare_media_source,
            commands::media::open_media_externally,
            commands::media::remux_ts_to_mp4,
            commands::media::generate_seek_preview,
            commands::media::generate_thumbnail,
            commands::media::load_sidecar_subtitles,
            commands::media::export_gif,
            commands::subtitles::list_subtitle_capabilities,
            commands::subtitles::start_or_generate_subtitle,
            commands::subtitles::import_subtitle,
            commands::subtitles::sync_subtitle,
            commands::system::open_library_folder,
            commands::system::reveal_library_file,
            commands::system::reveal_job_output,
            commands::system::recycle_library_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Segma Player");
}

#[cfg(desktop)]
fn focus_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
