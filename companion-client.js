export const MEDIA_COMPANION_NATIVE_HOST = "com.aura.media_companion";
export const MEDIA_COMPANION_PROTOCOL = 2;

const DEFAULT_TIMEOUT_MS = 5_000;
let activePort = null;
let connectPromise = null;
let requestSequence = 0;
const pendingRequests = new Map();
const eventListeners = new Set();

function companionError(message, code = "media-companion-unavailable") {
  const error = new Error(message || code);
  error.code = code;
  return error;
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
      port.postMessage({ type, requestId, ...payload });
    } catch (error) {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      reject(companionError(error?.message || "Aura Companion에 요청을 보내지 못했습니다."));
    }
  });
}

export async function ensureCompanion({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (activePort) return activePort;
  if (connectPromise) return connectPromise;
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
      return port;
    } catch (error) {
      try { port.disconnect(); } catch { /* already disconnected */ }
      activePort = null;
      throw error;
    }
  })();
  try {
    return await connectPromise;
  } finally {
    if (!activePort) connectPromise = null;
  }
}

export async function companionRequest(type, payload = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const port = await ensureCompanion({ timeoutMs });
  return postRequest(port, type, payload, timeoutMs);
}

export async function companionStatus() {
  try {
    const response = await companionRequest("status", {}, { timeoutMs: 2_500 });
    return { ok: true, ...response };
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

export async function cancelCompanionJob(jobId) {
  return companionRequest("cancel-job", { jobId }, { timeoutMs: 5_000 });
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
  connectPromise = null;
  if (port) {
    try { port.disconnect(); } catch { /* already disconnected */ }
  }
}
