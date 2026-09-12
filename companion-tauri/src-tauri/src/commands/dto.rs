use serde::Serialize;
use std::io;

/// Stable error envelope for every Tauri command. Messages are deliberately
/// fixed and user-safe; filesystem paths, request bodies, and license keys are
/// never copied from lower-level errors into this DTO.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl CommandError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn invalid_request(message: &'static str) -> Self {
        Self::new("invalid-request", message)
    }

    pub fn from_io(error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::InvalidInput => Self::new("invalid-request", "요청을 확인해 주세요."),
            io::ErrorKind::NotFound => Self::new("not-found", "대상을 찾지 못했습니다."),
            io::ErrorKind::AlreadyExists => {
                Self::new("already-exists", "같은 이름의 대상이 이미 있습니다.")
            }
            io::ErrorKind::PermissionDenied => {
                Self::new("permission-denied", "이 작업을 수행할 권한이 없습니다.")
            }
            io::ErrorKind::Unsupported => {
                Self::new("unsupported", "이 환경에서는 지원되지 않는 작업입니다.")
            }
            io::ErrorKind::InvalidData => {
                Self::new("invalid-data", "저장된 데이터를 읽지 못했습니다.")
            }
            _ => Self::new("operation-failed", "작업을 완료하지 못했습니다."),
        }
    }
}

impl From<io::Error> for CommandError {
    fn from(error: io::Error) -> Self {
        Self::from_io(error)
    }
}
