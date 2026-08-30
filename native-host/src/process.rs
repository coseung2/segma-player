use std::env;
use std::io;
#[cfg(target_os = "windows")]
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const DETACHED_PROCESS: u32 = 0x0000_0008;
#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

#[cfg(target_os = "windows")]
pub const MANAGER_EXECUTABLE: &str = "aura-media-manager.exe";

pub fn spawn_detached(arguments: &[&str]) -> io::Result<()> {
    let executable = env::current_exe()?;
    let mut command = Command::new(executable);
    command.args(arguments);
    #[cfg(target_os = "windows")]
    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.spawn()?;
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn apply_detached_creation_flags(command: &mut Command) {
    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
}

#[cfg(not(target_os = "windows"))]
pub fn apply_detached_creation_flags(_command: &mut Command) {}

#[cfg(target_os = "windows")]
pub fn manager_executable_in(directory: &Path) -> io::Result<PathBuf> {
    let path = directory.join(MANAGER_EXECUTABLE);
    if path.is_file() {
        return Ok(path);
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "manager-not-installed",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "windows")]
    use std::fs;
    #[cfg(target_os = "windows")]
    use std::sync::atomic::{AtomicU64, Ordering};

    #[cfg(target_os = "windows")]
    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(1);

    #[cfg(target_os = "windows")]
    #[test]
    fn manager_resolution_requires_the_sibling_binary() {
        let directory = env::temp_dir().join(format!(
            "segma-process-test-{}-{}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&directory).expect("directory creates");
        let error = manager_executable_in(&directory).expect_err("missing manager rejects");
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert_eq!(error.to_string(), "manager-not-installed");
        fs::write(directory.join(MANAGER_EXECUTABLE), b"stub").expect("stub writes");
        assert_eq!(
            manager_executable_in(&directory).expect("manager resolves"),
            directory.join(MANAGER_EXECUTABLE)
        );
        fs::remove_dir_all(directory).expect("directory removes");
    }
}
