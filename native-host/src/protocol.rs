use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use std::io::{self, Read, Write};

pub const MAX_NATIVE_MESSAGE_BYTES: usize = 1024 * 1024;

pub fn parse_request_bytes<T: DeserializeOwned>(data: &[u8]) -> io::Result<(T, Value)> {
    let raw_message: Value = serde_json::from_slice(data).map_err(io::Error::other)?;
    let request = serde_json::from_value(raw_message.clone()).map_err(io::Error::other)?;
    Ok((request, raw_message))
}

fn read_framed_message<R: Read>(reader: &mut R, maximum: usize) -> io::Result<Option<Vec<u8>>> {
    let mut length = [0_u8; 4];
    match reader.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let size = u32::from_le_bytes(length) as usize;
    if size == 0 || size > maximum {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid native message length",
        ));
    }
    let mut data = vec![0_u8; size];
    reader.read_exact(&mut data)?;
    Ok(Some(data))
}

pub fn read_native_message<T: DeserializeOwned>() -> io::Result<Option<(T, Value, usize)>> {
    let mut stdin = io::stdin().lock();
    let Some(data) = read_framed_message(&mut stdin, MAX_NATIVE_MESSAGE_BYTES)? else {
        return Ok(None);
    };
    let size = data.len();
    let (request, raw_message) = parse_request_bytes(&data)?;
    Ok(Some((request, raw_message, size)))
}

fn write_framed_message<W: Write>(writer: &mut W, value: &Value) -> io::Result<()> {
    let data = serde_json::to_vec(value).map_err(io::Error::other)?;
    writer.write_all(&(data.len() as u32).to_le_bytes())?;
    writer.write_all(&data)?;
    writer.flush()
}

pub fn write_native_message(value: &Value) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    write_framed_message(&mut stdout, value)
}

pub fn reply_body(request_id: &str, body: Value) -> Value {
    let mut object = body.as_object().cloned().unwrap_or_else(Map::new);
    if !request_id.is_empty() {
        object.insert("requestId".into(), Value::String(request_id.to_string()));
    }
    Value::Object(object)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Debug, Deserialize, PartialEq)]
    struct FixtureRequest {
        #[serde(rename = "type")]
        kind: String,
    }

    #[test]
    fn framed_message_round_trips_and_preserves_raw_json() {
        let value = json!({ "type": "hello", "requestId": "request-1" });
        let mut framed = Vec::new();
        write_framed_message(&mut framed, &value).expect("message writes");
        let data = read_framed_message(&mut framed.as_slice(), MAX_NATIVE_MESSAGE_BYTES)
            .expect("message reads")
            .expect("message is present");
        let (request, raw): (FixtureRequest, Value) =
            parse_request_bytes(&data).expect("request parses");
        assert_eq!(request.kind, "hello");
        assert_eq!(raw, value);
    }

    #[test]
    fn framing_rejects_empty_and_oversized_messages() {
        for size in [0_u32, (MAX_NATIVE_MESSAGE_BYTES as u32) + 1] {
            let framed = size.to_le_bytes().to_vec();
            assert_eq!(
                read_framed_message(&mut framed.as_slice(), MAX_NATIVE_MESSAGE_BYTES)
                    .expect_err("invalid size rejects")
                    .kind(),
                io::ErrorKind::InvalidData
            );
        }
    }

    #[test]
    fn reply_body_echoes_only_non_empty_request_ids() {
        assert_eq!(
            reply_body("request-1", json!({ "ok": true })),
            json!({ "ok": true, "requestId": "request-1" })
        );
        assert_eq!(reply_body("", json!({ "ok": true })), json!({ "ok": true }));
    }
}
