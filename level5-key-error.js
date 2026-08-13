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
  let detail = "영상 플레이어의 보호 키 정보에 연결하지 못했습니다.";
  if (code === "runtime-import-failed") detail = "영상 플레이어 보호 모듈을 불러오지 못했습니다.";
  else if (code === "runtime-exports-missing") detail = "영상 플레이어에 보호 키 확인 기능이 없습니다.";
  else if (code === "wasm-init-failed") detail = "영상 플레이어 보호 모듈 초기화에 실패했습니다.";
  else if (code === "key-fetch-failed") detail = "원본 영상 프레임에서 키 요청을 보내지 못했습니다.";
  else if (code === "key-response-read-failed") detail = "보호 키 서버 응답을 읽지 못했습니다.";
  else if (/^level5-key-http-/.test(code)) detail = `보호 키 서버 요청이 HTTP ${code.slice("level5-key-http-".length)}로 실패했습니다.`;
  else if (code === "decode-session-failed") detail = "영상 플레이어 보호 모듈 실행에 실패했습니다.";
  else if (code === "invalid-level5-key") detail = "보호 키 응답이 올바른 형식이 아닙니다.";
  else if (code === "level5-key-load-failed" || code === "level5-loader-failed") detail = "영상 플레이어도 보호 키를 반환하지 못했습니다.";
  else if (code === "level5-key-load-timeout" || code === "page-bridge-timeout") detail = "원본 영상 탭의 보호 키 응답이 지연되고 있습니다.";
  return `보호된 영상 키 확인 실패: ${detail} (${code})`;
}
