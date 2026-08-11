import { canonicalHttpUrl } from "./candidate.js";

export const PROGRESSIVE_REDIRECT_CACHE_TTL_MS = 60_000;

export class ProgressiveRedirectError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ProgressiveRedirectError";
    this.code = code;
  }
}

const RECORDED_HEADER_DENYLIST = new Set([
  "cookie", "host", "content-length", "content-type", "connection", "accept-encoding",
  "accept", "cache-control", "pragma", "te", "upgrade", "priority", "origin",
  "referer", "referrer", "user-agent", "range",
]);

export function replayableRecordedHeaders(value) {
  if (!value || typeof value !== "object") return {};
  const headers = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof name !== "string" || typeof headerValue !== "string" || !headerValue) continue;
    const lower = name.toLowerCase();
    if (RECORDED_HEADER_DENYLIST.has(lower)
      || lower.startsWith("sec-fetch-") || lower.startsWith("sec-ch-ua")) continue;
    headers[name] = headerValue;
  }
  return headers;
}

function normalizedHeaders(value) {
  const headers = replayableRecordedHeaders(value);
  headers.Range = "bytes=0-0";
  return headers;
}

const PROGRESSIVE_ERROR_MESSAGES = Object.freeze({
  "invalid-probe-url": "영상 주소가 올바르지 않습니다.",
  "invalid-probe-referrer": "영상 페이지 주소가 올바르지 않습니다.",
  "invalid-probe-response-url": "영상 서버가 올바르지 않은 주소를 반환했습니다.",
  "invalid-route-url": "미디어 경로 주소가 올바르지 않습니다.",
  "invalid-route-urls": "미디어 경로 주소 목록이 올바르지 않습니다.",
  "route-timeout": "미디어 경로 준비 시간이 초과되었습니다. 다시 시도해 주세요.",
  "route-disconnected": "미디어 경로 연결이 끊겼습니다. 다시 시도해 주세요.",
  "route-rejected": "미디어 경로를 준비하지 못했습니다. 다시 시도해 주세요.",
  "invalid-route-response": "미디어 경로 응답이 올바르지 않습니다. 다시 시도해 주세요.",
  "route-preparation-failed": "미디어 경로를 준비하지 못했습니다. 다시 시도해 주세요.",
  "media-route-failed": "미디어 경로를 준비하지 못했습니다. 다시 시도해 주세요.",
  "invalid-route-preparer": "미디어 경로 준비 기능을 사용할 수 없습니다. 확장 프로그램을 다시 로드해 주세요.",
  "invalid-probe-fetch": "영상 확인 기능을 사용할 수 없습니다. 확장 프로그램을 다시 로드해 주세요.",
  "invalid-probe-cache-ttl": "영상 확인 설정이 올바르지 않습니다. 확장 프로그램을 다시 로드해 주세요.",
});

export function authenticatedRecoveryForProgressiveError(error, session) {
  if (error?.code !== "media-probe-failed") return null;
  return { ...session, authenticatedProbeRequired: true };
}

export function progressiveDownloadErrorMessage(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  if (/[가-힣]/.test(message)) return message;
  return PROGRESSIVE_ERROR_MESSAGES[error?.code]
    || "영상 주소를 갱신하지 못했습니다. 영상 페이지를 새로고침한 뒤 다시 시도해 주세요.";
}

function expiryFromRoute(result, now, ttlMs) {
  const routeExpiry = Number.isFinite(result?.expiresAtMs)
    ? result.expiresAtMs
    : (typeof result?.expiresAtUtc === "string" ? Date.parse(result.expiresAtUtc) : Number.NaN);
  const shortExpiry = now + ttlMs;
  return Number.isFinite(routeExpiry) && routeExpiry > now
    ? Math.min(routeExpiry, shortExpiry)
    : shortExpiry;
}

async function cancelProbeBody(response) {
  try {
    if (typeof response?.body?.cancel === "function") {
      await response.body.cancel();
      return;
    }
    const reader = response?.body?.getReader?.();
    await reader?.cancel?.();
  } catch {
    // The response has already supplied its final URL; body cleanup is best effort.
  }
}

export function createProgressiveRedirectResolver({
  ensureRoutes,
  fetchImpl = globalThis.fetch,
  getRequestHeaders = () => ({}),
  now = () => Date.now(),
  cacheTtlMs = PROGRESSIVE_REDIRECT_CACHE_TTL_MS,
} = {}) {
  if (typeof ensureRoutes !== "function") throw new ProgressiveRedirectError("invalid-route-preparer");
  if (typeof fetchImpl !== "function") throw new ProgressiveRedirectError("invalid-probe-fetch");
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs <= 0) {
    throw new ProgressiveRedirectError("invalid-probe-cache-ttl");
  }

  const cache = new Map();

  async function resolve({ url: rawUrl, referrer: rawReferrer = "", requestHeaders } = {}) {
    const initial = canonicalHttpUrl(rawUrl);
    if (!initial) throw new ProgressiveRedirectError("invalid-probe-url");
    const referrer = rawReferrer ? canonicalHttpUrl(rawReferrer)?.href : "";
    if (rawReferrer && !referrer) throw new ProgressiveRedirectError("invalid-probe-referrer");

    await ensureRoutes([initial.href]);
    const key = `${initial.href}\n${referrer}`;
    const currentTime = now();
    const cached = cache.get(key);
    if (cached && cached.expiresAtMs > currentTime) {
      try {
        await ensureRoutes([cached.url]);
        return { url: cached.url, referrer, cached: true };
      } catch (error) {
        cache.delete(key);
        throw error;
      }
    }
    if (cached) cache.delete(key);

    let response;
    try {
      let headers = requestHeaders;
      if (headers === undefined) headers = await getRequestHeaders(initial.href);
      response = await fetchImpl(initial.href, {
        method: "GET",
        headers: normalizedHeaders(headers),
        credentials: "include",
        redirect: "follow",
        ...(referrer ? { referrer, referrerPolicy: "unsafe-url" } : {}),
      });
    } catch {
      throw new ProgressiveRedirectError("media-probe-failed");
    }

    const responseUrl = typeof response?.url === "string" && response.url ? response.url : initial.href;
    const final = canonicalHttpUrl(responseUrl);
    await cancelProbeBody(response);
    if (!final) throw new ProgressiveRedirectError("invalid-probe-response-url");
    if (!response?.ok && response?.status !== 206) {
      throw new ProgressiveRedirectError("media-probe-failed");
    }

    const routeResult = await ensureRoutes([final.href]);
    const expiresAtMs = expiryFromRoute(routeResult, now(), cacheTtlMs);
    cache.set(key, { url: final.href, expiresAtMs });
    return { url: final.href, referrer, cached: false };
  }

  return Object.freeze({
    resolve,
    clear() {
      cache.clear();
    },
    get cacheSize() {
      return cache.size;
    },
  });
}
