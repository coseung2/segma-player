use std::path::{Path, PathBuf};
use std::process::Command;

pub const WORKER_URL: &str = "https://aura.mdownloader.workers.dev/api/subtitles";
#[cfg(test)]
pub const MAX_URL_BYTES: usize = 4096;
pub const MAX_AUDIO_BYTES: u64 = 80 * 1024 * 1024;
pub const MAX_DURATION_SECONDS: u64 = 60 * 60;

pub fn valid_local_path(value: &Option<String>) -> bool {
    let Some(path) = value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    if path.chars().any(char::is_control) || path.len() > 32_767 {
        return false;
    }
    let path = Path::new(path);
    path.is_absolute()
        && !path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
}

pub fn valid_local_file(value: &Option<String>) -> bool {
    valid_local_path(value) && Path::new(value.as_deref().unwrap_or("")).is_file()
}

pub fn ffmpeg_executable(ffmpeg_directory: &Path) -> Option<PathBuf> {
    let ffmpeg = ffmpeg_directory.join("ffmpeg.exe");
    ffmpeg.is_file().then_some(ffmpeg)
}

pub fn configure_local_audio_command(command: &mut Command, source: &Path, output: &Path) {
    command
        .arg("-y")
        .arg("-i")
        .arg(source)
        .arg("-vn")
        .arg("-ac")
        .arg("1")
        .arg("-ar")
        .arg("16000")
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg("64k")
        .arg("-t")
        .arg(MAX_DURATION_SECONDS.to_string())
        .arg(output);
}

pub fn encode_title(title: &str) -> String {
    let clipped: String = title.chars().take(240).collect();
    let mut encoded = String::new();
    for byte in clipped.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}
