const KNOWN_LEVEL5_KEY_ERRORS = new Set([
  "decode-session-failed",
  "invalid-level5-key",
  "key-fetch-failed",
  "key-response-read-failed",
  "level5-key-load-failed",
  "level5-key-load-timeout",
  "level5-loader-failed",
  "level5-key-unavailable",
  "not-level5-session-key",
  "page-bridge-timeout",
  "runtime-exports-missing",
  "runtime-import-failed",
  "wasm-init-failed",
]);

export function normalizeLevel5KeyError(value) {
  const code = typeof value === "string" ? value : "";
  if (KNOWN_LEVEL5_KEY_ERRORS.has(code) || /^level5-key-http-[1-5]\d\d$/.test(code)) return code;
  return "level5-key-unavailable";
}

export function level5KeyErrorMessage(value) {
  const code = normalizeLevel5KeyError(value);
  let detail = "페이지의 Level5 키 해독기에 연결하지 못했습니다.";
  if (code === "runtime-import-failed") detail = "Level5 런타임 모듈을 불러오지 못했습니다.";
  else if (code === "runtime-exports-missing") detail = "Level5 런타임에 키 해독 함수가 없습니다.";
  else if (code === "wasm-init-failed") detail = "Level5 WASM 코어 초기화에 실패했습니다.";
  else if (code === "key-fetch-failed") detail = "원본 영상 프레임에서 키 요청을 보내지 못했습니다.";
  else if (code === "key-response-read-failed") detail = "키 서버 응답을 읽지 못했습니다.";
  else if (/^level5-key-http-/.test(code)) detail = `키 서버 요청이 HTTP ${code.slice("level5-key-http-".length)}로 실패했습니다.`;
  else if (code === "decode-session-failed") detail = "Level5 decode_session 실행에 실패했습니다.";
  else if (code === "invalid-level5-key") detail = "해독 결과가 AES 키 길이와 맞지 않습니다.";
  else if (code === "level5-key-load-failed" || code === "level5-loader-failed") detail = "페이지 HLS 키 로더도 키를 반환하지 못했습니다.";
  else if (code === "level5-key-load-timeout" || code === "page-bridge-timeout") detail = "원본 영상 프레임의 키 해독 응답이 시간 초과되었습니다.";
  return `보호된 HLS 키 해독 실패: ${detail} (${code})`;
}
