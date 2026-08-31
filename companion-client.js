export const MEDIA_COMPANION_NATIVE_HOST = "com.aura.media_companion";
export const MEDIA_COMPANION_PROTOCOL = 2;
export const MEDIA_DOWNLOAD_PROTOCOL = 1;
export const MEDIA_DOWNLOAD_CAPABILITY = "media-download-v1";
export const SUBTITLE_COMMAND_PROTOCOL = 1;

const DEFAULT_TIMEOUT_MS = 5_000;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_MEDIA_DOWNLOAD_URL_BYTES = 4_096;
const MAX_MEDIA_DOWNLOAD_TITLE_BYTES = 512;
const MAX_MEDIA_DOWNLOAD_ID_BYTES = 128;
const MAX_MEDIA_DOWNLOAD_USER_AGENT_BYTES = 512;
const MAX_MEDIA_DOWNLOAD_ACCEPT_LANGUAGE_BYTES = 256;
const SUBTITLE_TIMEOUT_MS = 10_000;
const MAX_SUBTITLE_URL_BYTES = 4_096;
const MAX_SUBTITLE_TITLE_BYTES = 512;
const MAX_SUBTITLE_METADATA_BYTES = 128;
const UINT32_MAX = 0xffff_ffff;
const SAFE_SUBTITLE_TOKEN = /^[A-Za-z0-9_-]+$/;
const SUBTITLE_INPUT_KEYS = new Set(["candidateId", "sourceLanguage", "media", "sourceContext"]);
const SUBTITLE_MEDIA_KEYS = new Set(["type", "title", "pageUrl", "resourceUrl", "audioRenditionUrl"]);
const SUBTITLE_CONTEXT_KEYS = new Set(["tabId", "frameId", "contextLeaseId"]);
const MEDIA_DOWNLOAD_INPUT_KEYS = new Set([
  "jobId", "candidateId", "url", "referrer", "title", "inputKind", "userAgent", "acceptLanguage",
]);
const MEDIA_DOWNLOAD_INPUT_KINDS = new Set(["PROGRESSIVE", "HLS_MASTER", "HLS_MEDIA", "DASH"]);
const SAFE_MEDIA_DOWNLOAD_ID = /^[A-Za-z0-9_-]+$/;
const SAFE_BROWSER_LANGUAGE = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/;
const SAFE_ACCEPT_LANGUAGE = /^[A-Za-z0-9,.;= -]+$/;
let activePort = null;
let activeCapabilities = new Set();
let connectPromise = null;
let requestSequence = 0;
const pendingRequests = new Map();
const eventListeners = new Set();

function companionError(message, code = "media-companion-unavailable") {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}

function hasControlCharacter(value) {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function validBrowserMetadata(value, maximum, pattern = null) {
  return typeof value === "string"
    && value.length > 0
    && utf8Length(value) <= maximum
    && !hasControlCharacter(value)
    && (!pattern || pattern.test(value));
}

export function mediaDownloadBrowserContext(navigatorLike = globalThis.navigator) {
  const userAgent = typeof navigatorLike?.userAgent === "string" ? navigatorLike.userAgent.trim() : "";
  const sourceLanguages = Array.isArray(navigatorLike?.languages)
    ? navigatorLike.languages
    : [navigatorLike?.language];
  const languages = [];
  const seen = new Set();
  for (const value of sourceLanguages) {
    const language = typeof value === "string" ? value.trim() : "";
    const key = language.toLowerCase();
    if (!SAFE_BROWSER_LANGUAGE.test(language) || seen.has(key)) continue;
    seen.add(key);
    languages.push(language);
    if (languages.length >= 10) break;
  }
  const acceptLanguage = languages.map((language, index) => {
    if (index === 0) return language;
    return `${language};q=${Math.max(0.1, 1 - index * 0.1).toFixed(1)}`;
  }).join(",");
  return {
    ...(validBrowserMetadata(userAgent, MAX_MEDIA_DOWNLOAD_USER_AGENT_BYTES) ? { userAgent } : {}),
    ...(validBrowserMetadata(acceptLanguage, MAX_MEDIA_DOWNLOAD_ACCEPT_LANGUAGE_BYTES, SAFE_ACCEPT_LANGUAGE)
      ? { acceptLanguage }
      : {}),
  };
}

function containsForbiddenMediaDownloadInput(value, visited = new WeakSet()) {
  if (!value || typeof value !== "object") return false;
  if (typeof ArrayBuffer !== "undefined" && (value instanceof ArrayBuffer || ArrayBuffer.isView(value))) return true;
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (visited.has(value)) return false;
  visited.add(value);
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalized.includes("cookie")
      || normalized.includes("authorization")
      || normalized.includes("header")
      || normalized.includes("license")
      || normalized.includes("secret")
      || normalized.includes("apikey")
      || normalized.includes("accesstoken")
      || normalized.includes("bearer")
      || normalized.includes("bytes")
      || normalized.includes("binary")
      || normalized.includes("blob")
      || normalized.includes("filesystem")
      || normalized === "path"
      || normalized.includes("filepath")
      || normalized.includes("filename")
      || normalized.includes("folder")
      || normalized.includes("directory")) return true;
    if (containsForbiddenMediaDownloadInput(child, visited)) return true;
  }
  return false;
}

function canonicalPublicHttpUrl(value, { required = false } = {}) {
  if (typeof value !== "string") return null;
  if (!value) return required ? null : "";
  if (utf8Length(value) > MAX_MEDIA_DOWNLOAD_URL_BYTES || hasControlCharacter(value) || /\s/u.test(value)) return null;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:")
      || parsed.username || parsed.password) return null;
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")
      || hostname.endsWith(".local") || hostname === "::" || hostname === "::1"
      || hostname === "0.0.0.0" || hostname.startsWith("127.")
      || hostname.startsWith("10.") || hostname.startsWith("192.168.")
      || /^172\.(?:1[6-9]|2\d|3[0-1])\./.test(hostname)
      || hostname.startsWith("169.254.") || hostname.startsWith("fc")
      || hostname.startsWith("fd") || hostname.startsWith("fe80:")) return null;
    parsed.hash = "";
    const canonical = parsed.href;
    return utf8Length(canonical) <= MAX_MEDIA_DOWNLOAD_URL_BYTES ? canonical : null;
  } catch {
    return null;
  }
}

function mediaDownloadPayload(input) {
  if (!isPlainRecord(input)) {
    throw companionError("미디어 다운로드 요청 형식이 올바르지 않습니다.", "invalid-media-download-command");
  }
  if (containsForbiddenMediaDownloadInput(input)) {
    throw companionError(
      "미디어 다운로드 요청에는 비밀값, 헤더, 미디어 바이트 또는 파일 경로를 포함할 수 없습니다.",
      "sensitive-media-download-field-rejected",
    );
  }
  for (const key of Object.keys(input)) {
    if (!MEDIA_DOWNLOAD_INPUT_KEYS.has(key)) {
      throw companionError("미디어 다운로드 요청에 허용되지 않은 필드가 있습니다.", "invalid-media-download-command");
    }
  }
  const validId = (value) => typeof value === "string"
    && utf8Length(value) <= MAX_MEDIA_DOWNLOAD_ID_BYTES
    && SAFE_MEDIA_DOWNLOAD_ID.test(value);
  const url = canonicalPublicHttpUrl(input.url, { required: true });
  const referrer = canonicalPublicHttpUrl(input.referrer ?? "");
  const userAgent = input.userAgent ?? "";
  const acceptLanguage = input.acceptLanguage ?? "";
  if (!validId(input.jobId) || !validId(input.candidateId)
    || !url || referrer === null
    || !validBoundedText(input.title, MAX_MEDIA_DOWNLOAD_TITLE_BYTES, { required: true })
    || !MEDIA_DOWNLOAD_INPUT_KINDS.has(input.inputKind)
    || (userAgent && !validBrowserMetadata(userAgent, MAX_MEDIA_DOWNLOAD_USER_AGENT_BYTES))
    || (acceptLanguage && !validBrowserMetadata(
      acceptLanguage,
      MAX_MEDIA_DOWNLOAD_ACCEPT_LANGUAGE_BYTES,
      SAFE_ACCEPT_LANGUAGE,
    ))) {
    throw companionError("미디어 다운로드 요청 또는 공개 URL이 올바르지 않습니다.", "invalid-media-download-command");
  }
  return {
    protocolVersion: MEDIA_DOWNLOAD_PROTOCOL,
    jobId: input.jobId,
    candidateId: input.candidateId,
    url,
    ...(referrer ? { referrer } : {}),
    title: input.title,
    inputKind: input.inputKind,
    ...(userAgent ? { userAgent } : {}),
    ...(acceptLanguage ? { acceptLanguage } : {}),
  };
}

function containsForbiddenSubtitleInput(value, visited = new WeakSet()) {
  if (!value || typeof value !== "object") return false;
  if (typeof ArrayBuffer !== "undefined" && (value instanceof ArrayBuffer || ArrayBuffer.isView(value))) return true;
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (visited.has(value)) return false;
  visited.add(value);
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalized.includes("cookie")
      || normalized.includes("authorization")
      || normalized.includes("header")
      || normalized.includes("license")
      || normalized.includes("secret")
      || normalized.includes("apikey")
      || normalized.includes("accesstoken")
      || normalized.includes("bearer")
      || normalized.includes("bytes")
      || normalized.includes("binary")
      || normalized.includes("blob")) return true;
    if (containsForbiddenSubtitleInput(child, visited)) return true;
  }
  return false;
}

function assertAllowedKeys(value, allowedKeys) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw companionError("Subtitle 요청에 허용되지 않은 필드가 있습니다.", "invalid-subtitle-command");
    }
  }
}

function validSubtitleToken(value) {
  return typeof value === "string"
    && value.length <= MAX_SUBTITLE_METADATA_BYTES
    && SAFE_SUBTITLE_TOKEN.test(value);
}

function validBoundedText(value, maximumBytes, { required = false } = {}) {
  return typeof value === "string"
    && (!required || value.length > 0)
    && utf8Length(value) <= maximumBytes
    && !hasControlCharacter(value);
}

function validSubtitleUrl(value, { required = false } = {}) {
  if (typeof value !== "string") return false;
  if (!value) return !required;
  if (utf8Length(value) > MAX_SUBTITLE_URL_BYTES || hasControlCharacter(value) || /\s/u.test(value)) return false;
  if (!value.startsWith("https://") && !value.startsWith("http://")) return false;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:")
      || parsed.username || parsed.password || parsed.hash) return false;
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")
      || hostname === "::1" || hostname === "0.0.0.0" || hostname.startsWith("127.")
      || hostname.startsWith("10.") || hostname.startsWith("192.168.")
      || /^172\.(?:1[6-9]|2\d|3[0-1])\./.test(hostname)
      || hostname.startsWith("169.254.") || hostname.startsWith("fc")
      || hostname.startsWith("fd") || hostname.startsWith("fe80:")) return false;
    return true;
  } catch {
    return false;
  }
}

function subtitlePayload(input) {
  if (!isPlainRecord(input)) {
    throw companionError("Subtitle 요청 형식이 올바르지 않습니다.", "invalid-subtitle-command");
  }
  if (containsForbiddenSubtitleInput(input)) {
    throw companionError("Subtitle 요청에는 비밀값, 헤더 또는 미디어 바이트를 포함할 수 없습니다.", "sensitive-header-rejected");
  }
  assertAllowedKeys(input, SUBTITLE_INPUT_KEYS);

  if (!validSubtitleToken(input.candidateId)) {
    throw companionError("Subtitle 후보 식별자가 올바르지 않습니다.", "invalid-subtitle-request-id");
  }
  if (input.sourceLanguage !== "ja" && input.sourceLanguage !== "en") {
    throw companionError("일본어 또는 영어에서 한국어로만 자막을 만들 수 있습니다.", "unsupported-subtitle-language");
  }
  if (!isPlainRecord(input.media)) {
    throw companionError("Subtitle 미디어 정보가 올바르지 않습니다.", "invalid-subtitle-media");
  }
  assertAllowedKeys(input.media, SUBTITLE_MEDIA_KEYS);

  const media = {
    type: input.media.type,
    title: input.media.title ?? "",
    pageUrl: input.media.pageUrl ?? "",
    resourceUrl: input.media.resourceUrl,
    audioRenditionUrl: input.media.audioRenditionUrl ?? "",
  };
  if (!validBoundedText(media.type, MAX_SUBTITLE_METADATA_BYTES, { required: true })
    || !validBoundedText(media.title, MAX_SUBTITLE_TITLE_BYTES)
    || !validSubtitleUrl(media.pageUrl)
    || !validSubtitleUrl(media.resourceUrl, { required: true })
    || !validSubtitleUrl(media.audioRenditionUrl)) {
    throw companionError("Subtitle 미디어 정보 또는 URL이 올바르지 않습니다.", "invalid-subtitle-media");
  }

  const payload = {
    protocolVersion: SUBTITLE_COMMAND_PROTOCOL,
    candidateId: input.candidateId,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: "ko",
    mode: "generate",
    media,
  };

  if (input.sourceContext !== undefined && input.sourceContext !== null) {
    if (!isPlainRecord(input.sourceContext)) {
      throw companionError("Subtitle 소스 컨텍스트가 올바르지 않습니다.", "invalid-subtitle-context");
    }
    assertAllowedKeys(input.sourceContext, SUBTITLE_CONTEXT_KEYS);
    const complete = ["tabId", "frameId", "contextLeaseId"]
      .every((key) => Object.hasOwn(input.sourceContext, key)
        && input.sourceContext[key] !== undefined
        && input.sourceContext[key] !== null);
    if (complete) {
      const { tabId, frameId, contextLeaseId } = input.sourceContext;
      if (!Number.isInteger(tabId) || tabId < 0 || tabId > UINT32_MAX
        || !Number.isInteger(frameId) || frameId < 0 || frameId > UINT32_MAX
        || !validSubtitleToken(contextLeaseId)) {
        throw companionError("Subtitle 소스 컨텍스트가 올바르지 않습니다.", "invalid-subtitle-context");
      }
      payload.sourceContext = { tabId, frameId, contextLeaseId };
    }
  }
  return payload;
}

function nextRequestId() {
  requestSequence = (requestSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}

function settleRequest(message) {
  const requestId = typeof message?.requestId === "string" ? message.requestId : "";
  if (!requestId) return false;
  const pending = pendingRequests.get(requestId);
  if (!pending) return false;
  pendingRequests.delete(requestId);
  clearTimeout(pending.timer);
  if (message.ok === false) {
    pending.reject(companionError(message.error || message.statusText || "Aura Companion 요청에 실패했습니다.", message.errorCode || "media-companion-request-failed"));
  } else {
    pending.resolve(message);
  }
  return true;
}

function rejectPending(error) {
  for (const [requestId, pending] of pendingRequests) {
    pendingRequests.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(error);
  }
}

function attachPort(port) {
  activePort = port;
  port.onMessage.addListener((message) => {
    if (settleRequest(message)) return;
    for (const listener of [...eventListeners]) {
      try { listener(message); } catch { /* isolate UI/job listeners */ }
    }
  });
  port.onDisconnect.addListener(() => {
    if (activePort !== port) return;
    activePort = null;
    activeCapabilities = new Set();
    connectPromise = null;
    const detail = chrome.runtime.lastError?.message || "Aura Companion 연결이 끊겼습니다.";
    rejectPending(companionError(detail, "media-companion-disconnected"));
    for (const listener of [...eventListeners]) {
      try { listener({ type: "companion-disconnected", error: detail }); } catch { /* isolate listeners */ }
    }
  });
  return port;
}

function postRequest(port, type, payload = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(companionError("Aura Companion 응답 시간이 초과되었습니다.", "media-companion-timeout"));
    }, timeoutMs);
    pendingRequests.set(requestId, { resolve, reject, timer });
    try {
      port.postMessage({ ...payload, type, requestId });
    } catch (error) {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      reject(companionError(error?.message || "Aura Companion에 요청을 보내지 못했습니다."));
    }
  });
}

export async function ensureCompanion({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (connectPromise) return connectPromise;
  if (activePort) return activePort;
  connectPromise = (async () => {
    let port;
    try {
      port = attachPort(chrome.runtime.connectNative(MEDIA_COMPANION_NATIVE_HOST));
    } catch (error) {
      activePort = null;
      throw companionError(error?.message || "Aura Companion을 실행하지 못했습니다.");
    }
    try {
      const hello = await postRequest(port, "hello", { protocol: MEDIA_COMPANION_PROTOCOL }, timeoutMs);
      if (Number(hello.protocol) !== MEDIA_COMPANION_PROTOCOL) {
        throw companionError("Aura Companion 버전이 맞지 않습니다. Companion을 업데이트해 주세요.", "media-companion-protocol-mismatch");
      }
      activeCapabilities = new Set(Array.isArray(hello.capabilities)
        ? hello.capabilities.filter((value) => typeof value === "string")
        : []);
      return port;
    } catch (error) {
      try { port.disconnect(); } catch { /* already disconnected */ }
      activePort = null;
      activeCapabilities = new Set();
      throw error;
    }
  })();
  try {
    return await connectPromise;
  } finally {
    connectPromise = null;
  }
}

export async function companionRequest(type, payload = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const port = await ensureCompanion({ timeoutMs });
  return postRequest(port, type, payload, timeoutMs);
}

export async function companionStatus() {
  try {
    const response = await companionRequest("status", {}, { timeoutMs: 2_500 });
    return { ok: true, capabilities: [...activeCapabilities], ...response };
  } catch (error) {
    return { ok: false, error: error?.message || "media-companion-unavailable", errorCode: error?.code || "media-companion-unavailable" };
  }
}

export function onCompanionEvent(listener) {
  if (typeof listener !== "function") throw new TypeError("listener must be a function");
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

export async function companionYouTubeInfo(url) {
  return companionRequest("youtube-info", { url }, { timeoutMs: 20_000 });
}

export async function startCompanionYouTubeDownload({ jobId, url, quality }) {
  return companionRequest("youtube-download", { jobId, url, quality }, { timeoutMs: 10_000 });
}

export function startCompanionMediaDownload(input) {
  const payload = mediaDownloadPayload(input);
  return ensureCompanion({ timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS }).then(async (port) => {
    if (!activeCapabilities.has(MEDIA_DOWNLOAD_CAPABILITY)) {
      throw companionError(
        "Segma Player가 미디어 다운로드를 지원하지 않습니다. 앱을 업데이트한 뒤 다시 열어 주세요.",
        "media-companion-update-required",
      );
    }
    const response = await postRequest(port, "media-download", payload, MEDIA_DOWNLOAD_TIMEOUT_MS);
    if (response?.accepted !== true || response?.jobId !== payload.jobId) {
      throw companionError(
        "Segma Player가 다운로드 작업을 수락하지 않았습니다.",
        "media-companion-start-rejected",
      );
    }
    return response;
  });
}

export function startCompanionSubtitleJob(input) {
  return companionRequest("subtitle.create", subtitlePayload(input), { timeoutMs: SUBTITLE_TIMEOUT_MS });
}

export async function cancelCompanionJob(jobId) {
  return companionRequest("cancel-job", { jobId }, { timeoutMs: 5_000 });
}

// Pause stops the transfer but keeps yt-dlp's partial file, so resume continues
// from the same byte. Resume and retry both replay the persisted request, so
// neither needs the URL or quality supplied again.
export async function pauseCompanionJob(jobId) {
  return companionRequest("pause-job", { jobId }, { timeoutMs: 5_000 });
}

export async function resumeCompanionJob(jobId) {
  return companionRequest("resume-job", { jobId }, { timeoutMs: 10_000 });
}

export async function retryCompanionJob(jobId) {
  return companionRequest("retry-job", { jobId }, { timeoutMs: 10_000 });
}

// The companion owns the media folder. Both entry points read and write this
// one value, so the extension and the manager window can never point at
// different destinations.
export async function setCompanionDownloadFolder(folder) {
  return companionRequest("set-download-folder", { folder }, { timeoutMs: 10_000 });
}

export async function playCompanionFile(filename) {
  return companionRequest("play-file", { filename }, { timeoutMs: 10_000 });
}

export async function listCompanionJobs() {
  return companionRequest("list-jobs", {}, { timeoutMs: 5_000 });
}

export async function showCompanionUi() {
  return companionRequest("show-ui", {}, { timeoutMs: 5_000 });
}

export async function openCompanionDownloads() {
  return companionRequest("open-folder", {}, { timeoutMs: 5_000 });
}

export function disconnectCompanion() {
  const port = activePort;
  activePort = null;
  activeCapabilities = new Set();
  connectPromise = null;
  if (port) {
    try { port.disconnect(); } catch { /* already disconnected */ }
  }
}
