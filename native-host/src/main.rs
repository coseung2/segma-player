#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Deserialize)]
struct Request {
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "jobId")]
    job_id: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    filename: String,
    #[serde(default)]
    data: String,
    #[serde(default = "default_quality")]
    quality: String,
}

#[derive(Serialize)]
struct Response<'a> {
    #[serde(rename = "jobId")]
    job_id: &'a str,
    status: &'a str,
    #[serde(rename = "statusText")]
    status_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(rename = "fileName", skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
}

struct MediaWriter {
    job_id: String,
    file: File,
    temporary_path: PathBuf,
    final_path: PathBuf,
}

fn default_quality() -> String {
    "best".into()
}

fn quality_height(value: &str) -> Option<u16> {
    match value {
        "2160" => Some(2160),
        "1440" => Some(1440),
        "1080" => Some(1080),
        "720" => Some(720),
        "480" => Some(480),
        "best" => None,
        _ => None,
    }
}

fn valid_quality(value: &str) -> bool {
    value == "best" || quality_height(value).is_some()
}

fn write_message(response: &Response<'_>) -> io::Result<()> {
    let data = serde_json::to_vec(response).map_err(io::Error::other)?;
    let mut stdout = io::stdout().lock();
    stdout.write_all(&(data.len() as u32).to_le_bytes())?;
    stdout.write_all(&data)?;
    stdout.flush()
}

fn read_message() -> io::Result<Option<Request>> {
    let mut length = [0_u8; 4];
    let mut stdin = io::stdin().lock();
    match stdin.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let size = u32::from_le_bytes(length) as usize;
    if size == 0 || size > 1024 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid native message length",
        ));
    }
    let mut data = vec![0_u8; size];
    stdin.read_exact(&mut data)?;
    serde_json::from_slice(&data)
        .map(Some)
        .map_err(io::Error::other)
}

fn tools_dir() -> io::Result<PathBuf> {
    let executable = env::current_exe()?;
    Ok(executable.parent().unwrap_or(Path::new(".")).join("tools"))
}

fn downloads_dir() -> io::Result<PathBuf> {
    let home = env::var_os("USERPROFILE")
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "USERPROFILE is unavailable"))?;
    Ok(PathBuf::from(home).join("Downloads"))
}

fn send(
    job_id: &str,
    status: &str,
    status_text: impl Into<String>,
    title: Option<String>,
    error: Option<String>,
) {
    let _ = write_message(&Response {
        job_id,
        status,
        status_text: status_text.into(),
        title,
        error,
        file_name: None,
    });
}

fn safe_filename(value: &str) -> String {
    let mut name: String = value
        .chars()
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .take(180)
        .collect();
    while name.ends_with([' ', '.']) {
        name.pop();
    }
    if name.is_empty() || name == "." || name == ".." {
        "aura-media.ts".into()
    } else {
        name
    }
}

fn unique_media_path(directory: &Path, filename: &str) -> PathBuf {
    let requested = Path::new(filename);
    let stem = requested
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("aura-media");
    let extension = requested
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    for index in 0..10_000 {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!(" ({index})")
        };
        let candidate = if extension.is_empty() {
            format!("{stem}{suffix}")
        } else {
            format!("{stem}{suffix}.{extension}")
        };
        let path = directory.join(candidate);
        let temporary = PathBuf::from(format!("{}.part", path.display()));
        if !path.exists() && !temporary.exists() {
            return path;
        }
    }
    directory.join(format!("aura-media-{}.ts", std::process::id()))
}

fn media_response(
    job_id: &str,
    status: &str,
    status_text: impl Into<String>,
    file_name: Option<String>,
    error: Option<String>,
) {
    let _ = write_message(&Response {
        job_id,
        status,
        status_text: status_text.into(),
        title: None,
        error,
        file_name,
    });
}

fn open_media_writer(request: &Request) -> io::Result<MediaWriter> {
    let directory = downloads_dir()?.join("Aura Media");
    fs::create_dir_all(&directory)?;
    let filename = safe_filename(&request.filename);
    let final_path = unique_media_path(&directory, &filename);
    let temporary_path = PathBuf::from(format!("{}.part", final_path.display()));
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary_path)?;
    Ok(MediaWriter {
        job_id: request.job_id.clone(),
        file,
        temporary_path,
        final_path,
    })
}

fn handle_media_request(request: &Request, writer: &mut Option<MediaWriter>) {
    match request.kind.as_str() {
        "media-open" => match open_media_writer(request) {
            Ok(opened) => {
                let file_name = opened
                    .final_path
                    .file_name()
                    .map(|value| value.to_string_lossy().into_owned());
                *writer = Some(opened);
                media_response(
                    &request.job_id,
                    "opened",
                    "기본 Downloads 폴더에 저장을 시작합니다.",
                    file_name,
                    None,
                );
            }
            Err(error) => media_response(
                &request.job_id,
                "failed",
                "기본 Downloads 파일을 만들지 못했습니다.",
                None,
                Some(error.to_string()),
            ),
        },
        "media-chunk" => {
            let Some(active) = writer
                .as_mut()
                .filter(|active| active.job_id == request.job_id)
            else {
                media_response(
                    &request.job_id,
                    "failed",
                    "열린 미디어 파일이 없습니다.",
                    None,
                    Some("media-writer-not-open".into()),
                );
                return;
            };
            match BASE64.decode(request.data.as_bytes()) {
                Ok(bytes) => match active.file.write_all(&bytes) {
                    Ok(()) => media_response(
                        &request.job_id,
                        "chunk",
                        format!("{} bytes", bytes.len()),
                        None,
                        None,
                    ),
                    Err(error) => media_response(
                        &request.job_id,
                        "failed",
                        "미디어 데이터를 저장하지 못했습니다.",
                        None,
                        Some(error.to_string()),
                    ),
                },
                Err(error) => media_response(
                    &request.job_id,
                    "failed",
                    "미디어 데이터 형식이 올바르지 않습니다.",
                    None,
                    Some(error.to_string()),
                ),
            }
        }
        "media-close" => {
            let Some(mut active) = writer
                .take()
                .filter(|active| active.job_id == request.job_id)
            else {
                media_response(
                    &request.job_id,
                    "failed",
                    "닫을 미디어 파일이 없습니다.",
                    None,
                    Some("media-writer-not-open".into()),
                );
                return;
            };
            let result = active.file.flush().and_then(|_| active.file.sync_all());
            drop(active.file);
            match result.and_then(|_| fs::rename(&active.temporary_path, &active.final_path)) {
                Ok(()) => media_response(
                    &request.job_id,
                    "closed",
                    "기본 Downloads 폴더에 저장했습니다.",
                    active
                        .final_path
                        .file_name()
                        .map(|value| value.to_string_lossy().into_owned()),
                    None,
                ),
                Err(error) => {
                    let _ = fs::remove_file(&active.temporary_path);
                    media_response(
                        &request.job_id,
                        "failed",
                        "미디어 파일을 완료하지 못했습니다.",
                        None,
                        Some(error.to_string()),
                    );
                }
            }
        }
        "media-abort" => {
            if let Some(active) = writer.take() {
                drop(active.file);
                let _ = fs::remove_file(active.temporary_path);
            }
            media_response(
                &request.job_id,
                "aborted",
                "부분 파일을 정리했습니다.",
                None,
                None,
            );
        }
        _ => media_response(
            &request.job_id,
            "failed",
            "지원하지 않는 미디어 저장 요청입니다.",
            None,
            Some("invalid-media-request".into()),
        ),
    }
}

fn run_download(request: Request) {
    if request.kind != "youtube-download"
        || !(request.url.starts_with("https://") || request.url.starts_with("http://"))
        || !valid_quality(&request.quality)
    {
        send(
            &request.job_id,
            "failed",
            "올바른 YouTube 요청이 아닙니다.",
            None,
            Some("invalid-request".into()),
        );
        return;
    }
    let tools = match tools_dir() {
        Ok(path) => path,
        Err(error) => {
            send(
                &request.job_id,
                "failed",
                "YouTube 도구 경로를 찾지 못했습니다.",
                None,
                Some(error.to_string()),
            );
            return;
        }
    };
    let yt_dlp = tools.join("yt-dlp.exe");
    let node = tools.join("node.exe");
    let ffmpeg = tools.join("ffmpeg");
    let downloads = match downloads_dir() {
        Ok(path) => path,
        Err(error) => {
            send(
                &request.job_id,
                "failed",
                "Downloads 폴더를 찾지 못했습니다.",
                None,
                Some(error.to_string()),
            );
            return;
        }
    };
    if !yt_dlp.is_file() || !ffmpeg.join("ffmpeg.exe").is_file() {
        send(
            &request.job_id,
            "failed",
            "YouTube 도구가 설치되지 않았습니다. install-youtube-host.ps1을 실행해 주세요.",
            None,
            Some("tools-not-installed".into()),
        );
        return;
    }

    send(
        &request.job_id,
        "running",
        "YouTube 정보를 확인하는 중…",
        None,
        None,
    );
    let mut command = Command::new(&yt_dlp);
    command
        .arg("--newline")
        .arg("--no-playlist")
        .arg("--windows-filenames")
        .arg("--merge-output-format").arg("mp4")
        .arg("--ffmpeg-location").arg(&ffmpeg)
        .arg("--paths").arg(format!("home:{}", downloads.display()))
        .arg("--output").arg("[%(height)sp] %(title).170B [%(id)s].%(ext)s")
        .arg("--print").arg("before_dl:AURA_TITLE:%(title)s")
        .arg("--progress-template").arg("download:AURA_PROGRESS:%(progress._percent_str)s %(progress._speed_str)s ETA %(progress._eta_str)s")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if node.is_file() {
        command
            .arg("--js-runtimes")
            .arg(format!("node:{}", node.display()));
    }
    if let Some(height) = quality_height(&request.quality) {
        command
            .arg("--format")
            .arg(format!("bv*[height<={height}]+ba/b[height<={height}]"));
    }
    command.arg(&request.url);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            send(
                &request.job_id,
                "failed",
                "yt-dlp를 실행하지 못했습니다.",
                None,
                Some(error.to_string()),
            );
            return;
        }
    };
    let (tx, rx) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        let tx = tx.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let tx = tx.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        });
    }
    drop(tx);

    let mut last_error = String::new();
    for line in rx {
        if let Some(title) = line.strip_prefix("AURA_TITLE:") {
            send(
                &request.job_id,
                "running",
                "영상 다운로드를 시작합니다…",
                Some(title.trim().to_string()),
                None,
            );
        } else if let Some(progress) = line.strip_prefix("AURA_PROGRESS:") {
            send(
                &request.job_id,
                "running",
                format!("다운로드 중 · {}", progress.trim()),
                None,
                None,
            );
        } else if line.starts_with("ERROR:") {
            last_error = line.trim().chars().take(500).collect();
        }
    }
    match child.wait() {
        Ok(status) if status.success() => send(
            &request.job_id,
            "completed",
            "YouTube 다운로드를 완료했습니다. Downloads 폴더에서 확인하세요.",
            None,
            None,
        ),
        Ok(status) => send(
            &request.job_id,
            "failed",
            "YouTube 다운로드에 실패했습니다.",
            None,
            Some(if last_error.is_empty() {
                format!("yt-dlp exit {}", status)
            } else {
                last_error
            }),
        ),
        Err(error) => send(
            &request.job_id,
            "failed",
            "yt-dlp 종료 상태를 확인하지 못했습니다.",
            None,
            Some(error.to_string()),
        ),
    }
}

fn main() {
    let mut writer: Option<MediaWriter> = None;
    while let Ok(Some(request)) = read_message() {
        if request.kind.starts_with("media-") {
            handle_media_request(&request, &mut writer);
        } else {
            run_download(request);
        }
    }
    if let Some(active) = writer.take() {
        drop(active.file);
        let _ = fs::remove_file(active.temporary_path);
    }
}

#[cfg(test)]
mod tests {
    use super::{quality_height, valid_quality};

    #[test]
    fn validates_supported_quality_caps() {
        assert_eq!(quality_height("2160"), Some(2160));
        assert_eq!(quality_height("1080"), Some(1080));
        assert_eq!(quality_height("best"), None);
        assert!(valid_quality("best"));
        assert!(!valid_quality("4320"));
    }
}
