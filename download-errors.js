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
  if (code === "route-unavailable" || code === "route-closed") return "VPN 설정 필요";
  if (ROUTE_ERROR_CODES.has(code)) return "경로 다시 시도";
  return "다시 시도";
}

export function candidateDownloadErrorMessage(code) {
  if (code === "route-unavailable" || code === "route-closed") {
    return "Aura VPN 브라우저 미디어 경로가 등록되지 않았습니다. Aura VPN 설정을 한 번 실행하고 확장을 새로고침해 주세요.";
  }
  if (code === "route-timeout") return "미디어 경로 준비 시간이 초과되었습니다. Aura VPN 상태를 확인한 뒤 다시 시도해 주세요.";
  if (code === "route-disconnected") return "Aura VPN 미디어 경로 연결이 끊겼습니다. 확장을 새로고침한 뒤 다시 시도해 주세요.";
  if (code === "route-rejected" || code === "invalid-route-response") {
    return "Aura VPN이 미디어 서버 경로를 준비하지 못했습니다. VPN 설정을 확인해 주세요.";
  }
  if (code === "invalid-route-url" || code === "invalid-route-urls") return "미디어 서버 주소가 올바르지 않습니다.";
  if (code === "test-domain-not-allowed") return "현재 사이트를 테스트 도메인에 추가해야 합니다.";
  return "이 미디어 형식은 직접 다운로드할 수 없거나 다운로드 준비에 실패했습니다.";
}
