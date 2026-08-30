use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

pub const STATE_PERSIST_INTERVAL_MS: u64 = 750;
pub const STATE_PERSIST_BYTE_INTERVAL: u64 = 8 * 1024 * 1024;

pub fn decode_chunk(value: &str) -> Result<Vec<u8>, base64::DecodeError> {
    BASE64.decode(value.as_bytes())
}

pub fn should_persist_state(
    now: u64,
    last_persisted_at: u64,
    bytes_written: u64,
    last_persisted_bytes: u64,
) -> bool {
    now.saturating_sub(last_persisted_at) >= STATE_PERSIST_INTERVAL_MS
        || bytes_written.saturating_sub(last_persisted_bytes) >= STATE_PERSIST_BYTE_INTERVAL
}

pub fn progress(bytes_written: u64, total: Option<u64>) -> Option<u8> {
    total.filter(|total| *total > 0).map(|total| {
        ((bytes_written as f64 / total as f64) * 100.0)
            .round()
            .clamp(0.0, 99.0) as u8
    })
}
