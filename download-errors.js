const ROUTE_ERROR_CODES = new Set([
  "route-unavailable",
  "route-timeout",
  "route-disconnected",
  "route-rejected",
  "route-closed",
  "invalid-route-response",
  "invalid-route-url",
  "invalid-route-urls",
]);

export function candidateDownloadErrorCode(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (ROUTE_ERROR_CODES.has(code)) return code;
  const message = typeof error?.message === "string" ? error.message : "";
  if (ROUTE_ERROR_CODES.has(message) || message === "test-domain-not-allowed") return message;
  return "unsupported-media";
}

export function candidateDownloadErrorLabel(code) {
  if (code === "test-domain-not-allowed") return "테스트 도메인 필요";
  if (code === "route-unavailable" || code === "route-closed") return "네트워크 확인";
  if (ROUTE_ERROR_CODES.has(code)) return "경로 다시 시도";
  return "다시 시도";
}

export function candidateDownloadErrorMessage(code) {
  if (code === "route-unavailable" || code === "route-closed") {
    return "미디어 서버에 연결할 수 없습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요.";
  }
  if (code === "route-timeout") return "미디어 연결 준비 시간이 초과되었습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.";
  if (code === "route-disconnected") return "미디어 연결이 끊겼습니다. 확장을 새로고침한 뒤 다시 시도해 주세요.";
  if (code === "route-rejected" || code === "invalid-route-response") {
    return "미디어 서버 연결을 준비하지 못했습니다. 네트워크 설정을 확인해 주세요.";
  }
  if (code === "invalid-route-url" || code === "invalid-route-urls") return "미디어 서버 주소가 올바르지 않습니다.";
  if (code === "test-domain-not-allowed") return "현재 사이트를 테스트 도메인에 추가해야 합니다.";
  return "이 미디어 형식은 직접 다운로드할 수 없거나 다운로드 준비에 실패했습니다.";
}
