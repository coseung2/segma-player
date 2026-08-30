use serde_json::{json, Value};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const OUTPUT_TEMPLATE: &str = "[%(height)sp] %(title).170B.%(ext)s";

pub fn command_tools(tools: &Path) -> io::Result<(PathBuf, PathBuf, PathBuf)> {
    let yt_dlp = tools.join("yt-dlp.exe");
    let node = tools.join("node.exe");
    let ffmpeg = tools.join("ffmpeg");
    if !yt_dlp.is_file() || !ffmpeg.join("ffmpeg.exe").is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "tools-not-installed",
        ));
    }
    Ok((yt_dlp, node, ffmpeg))
}

pub fn apply_hidden_process(command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
}

pub fn apply_runtime(command: &mut Command, node: &Path, ffmpeg: &Path) {
    command.arg("--ffmpeg-location").arg(ffmpeg);
    command.arg("--encoding").arg("utf-8");
    command
        .arg("--replace-in-metadata")
        .arg("title")
        .arg(r"\s*[/\\]\s*")
        .arg(" - ");
    command
        .arg("--retries")
        .arg("3")
        .arg("--fragment-retries")
        .arg("3")
        .arg("--extractor-retries")
        .arg("3")
        .arg("--retry-sleep")
        .arg("http:linear=1::2");
    if node.is_file() {
        command
            .arg("--js-runtimes")
            .arg(format!("node:{}", node.display()));
    }
}

pub fn info(url: &str, tools: (PathBuf, PathBuf, PathBuf)) -> Result<Value, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("invalid-youtube-url".into());
    }
    let (yt_dlp, node, ffmpeg) = tools;
    let mut command = Command::new(yt_dlp);
    command
        .arg("--dump-single-json")
        .arg("--skip-download")
        .arg("--no-playlist")
        .arg("--no-warnings");
    apply_runtime(&mut command, &node, &ffmpeg);
    command.arg(url);
    apply_hidden_process(&mut command);
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(detail.trim().chars().take(500).collect());
    }
    let parsed: Value =
        serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())?;
    let title = parsed
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let mut qualities = parsed
        .get("formats")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|format| format.get("height").and_then(Value::as_u64))
        .filter(|height| *height > 0 && *height <= 4320)
        .collect::<Vec<_>>();
    qualities.sort_unstable_by(|left, right| right.cmp(left));
    qualities.dedup();
    Ok(json!({ "title": title, "qualities": qualities }))
}

pub fn should_restart(error: &str, attempt: u8) -> bool {
    attempt < 2 && error.to_ascii_lowercase().contains("http error 403")
}

pub fn configure_download_command(
    command: &mut Command,
    url: &str,
    height: Option<u16>,
    downloads: &Path,
    node: &Path,
    ffmpeg: &Path,
) {
    command
        .arg("--newline")
        .arg("--no-playlist")
        .arg("--windows-filenames")
        .arg("--continue")
        .arg("--merge-output-format")
        .arg("mp4")
        .arg("--paths")
        .arg(format!("home:{}", downloads.display()))
        .arg("--output")
        .arg(OUTPUT_TEMPLATE)
        .arg("--print")
        .arg("before_dl:AURA_TITLE:%(title)s")
        .arg("--print")
        .arg("after_move:AURA_FILE:%(filepath)s")
        .arg("--progress-template")
        .arg("download:AURA_PROGRESS:%(progress._percent_str)s %(progress._speed_str)s ETA %(progress._eta_str)s");
    if let Some(height) = height {
        command
            .arg("--format")
            .arg(format!("bv*[height<={height}]+ba/b[height<={height}]"));
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    apply_runtime(command, node, ffmpeg);
    command.arg(url);
    apply_hidden_process(command);
}
