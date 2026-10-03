const MAIN_WINDOW_LABEL: &str = "main";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanionConnectionStatus {
    state: &'static str,
    label: &'static str,
    version: Option<String>,
}

#[tauri::command]
async fn companion_connection_status() -> CompanionConnectionStatus {
    tauri::async_runtime::spawn_blocking(probe_companion_connection)
        .await
        .unwrap_or_else(|_| unavailable_connection())
}

fn unavailable_connection() -> CompanionConnectionStatus {
    CompanionConnectionStatus {
        state: "unavailable",
        label: "Companion 연결 안 됨",
        version: None,
    }
}

fn probe_companion_connection() -> CompanionConnectionStatus {
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let executable = match std::env::current_exe().ok().and_then(|path| {
        let directory = path.parent()?;
        let installed = directory.join("aura-media-companion.exe");
        if installed.is_file() {
            return Some(installed);
        }
        let profile = directory.file_name()?;
        directory
            .ancestors()
            .nth(4)
            .map(|root| {
                root.join("native-host")
                    .join("target")
                    .join(profile)
                    .join("aura-media-companion.exe")
            })
            .filter(|candidate| candidate.is_file())
    }) {
        Some(path) => path,
        None => return unavailable_connection(),
    };
    let mut child = match Command::new(executable)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return unavailable_connection(),
    };
    let payload = br#"{"type":"status","requestId":"manager-connection-status"}"#;
    let mut frame = Vec::with_capacity(payload.len() + 4);
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(payload);
    if child
        .stdin
        .take()
        .map_or(true, |mut stdin| stdin.write_all(&frame).is_err())
    {
        let _ = child.kill();
        return unavailable_connection();
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return unavailable_connection(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return unavailable_connection();
            }
        }
    }
    let mut output = Vec::new();
    if child.stdout.take().map_or(true, |stdout| {
        stdout.take(16 * 1024).read_to_end(&mut output).is_err()
    }) || output.len() < 4
    {
        return unavailable_connection();
    }
    let size = u32::from_le_bytes(output[..4].try_into().unwrap()) as usize;
    if size > 12 * 1024 || output.len() != size + 4 {
        return unavailable_connection();
    }
    let response: serde_json::Value = match serde_json::from_slice(&output[4..]) {
        Ok(value) => value,
        Err(_) => return unavailable_connection(),
    };
    if response.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return unavailable_connection();
    }
    let tools_ready = response
        .get("toolsReady")
        .and_then(serde_json::Value::as_bool)
        == Some(true);
    let version = response
        .get("version")
        .and_then(serde_json::Value::as_str)
        .filter(|value| {
            value.len() <= 32
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        })
        .map(str::to_string);
    CompanionConnectionStatus {
        state: if tools_ready { "connected" } else { "degraded" },
        label: if tools_ready {
            "Companion 연결됨"
        } else {
            "Companion 기능 제한"
        },
        version,
    }
}

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
            companion_connection_status,
            commands::cloud::cloud_status,
            commands::cloud::configure_telegram,
            commands::cloud::install_cloud_component,
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
            commands::jobs::remove_job_history,
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
