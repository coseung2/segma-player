import { getStoredLicense, LICENSE_API_URL } from "./license.js";

export const YOUTUBE_SERVER_STORAGE_KEY = "auraYouTubeServer";
// Tailscale serve HTTPS proxy (443 → local 8788). Port 443 keeps the
// canonical-URL validator happy and the address only resolves inside the
// tailnet.
export const DEFAULT_YOUTUBE_SERVER_URL = "https://desktop-8n966j0.tail4cbe57.ts.net";
const DEVICE_ID_STORAGE_KEY = "auraYouTubeDeviceId";
const TOKEN_STORAGE_KEY = "auraYouTubeServerToken";
const QUALITIES_STORAGE_KEY = "auraYouTubeQualities";
const TOKEN_API_URL = LICENSE_API_URL.replace("/api/license", "/api/youtube-token");
const TOKEN_FETCH_TIMEOUT_MS = 12_000;
const QUALITIES_TTL_MS = 10 * 60 * 1000;
const JOB_POLL_MS = 2_000;
const JOB_TIMEOUT_MS = 5 * 60 * 1000;

function linkedAbortController(signal = null) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener?.("abort", abort, { once: true });
  return {
    controller,
    unlink: () => signal?.removeEventListener?.("abort", abort),
  };
}

function waitForPoll(ms, signal = null) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", done);
      resolve();
    }
    signal?.addEventListener?.("abort", done, { once: true });
  });
}

export function normalizeServerUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function getYouTubeServerUrl() {
  try {
    const stored = await chrome.storage.local.get(YOUTUBE_SERVER_STORAGE_KEY);
    const value = stored?.[YOUTUBE_SERVER_STORAGE_KEY];
    if (typeof value === "string" && value.trim()) {
      const normalized = normalizeServerUrl(value);
      if (normalized) return normalized;
    }
  } catch {
    // Fall back to the packaged default.
  }
  return normalizeServerUrl(DEFAULT_YOUTUBE_SERVER_URL);
}

export async function setYouTubeServerUrl(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    await chrome.storage.local.remove(YOUTUBE_SERVER_STORAGE_KEY);
    return { ok: true, url: "" };
  }
  const normalized = normalizeServerUrl(trimmed);
  if (!normalized) return { ok: false, error: "invalid-server-url" };
  await chrome.storage.local.set({ [YOUTUBE_SERVER_STORAGE_KEY]: normalized });
  return { ok: true, url: normalized };
}

export async function checkYouTubeServer(baseUrl = null) {
  const server = baseUrl || (await getYouTubeServerUrl());
  if (!server) return { ok: false, error: "not-configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  timer?.unref?.();
  try {
    const response = await fetch(`${server}/healthz`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return { ok: false, error: `http-${response.status}` };
    const data = await response.json();
    return data && data.ok === true
      ? {
        ok: true,
        service: typeof data.service === "string" ? data.service : "aura-youtube",
        active: data.active ?? 0,
        queued: data.queued ?? 0,
      }
      : { ok: false, error: "bad-healthz" };
  } catch {
    return { ok: false, error: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

async function deviceId() {
  try {
    const stored = await chrome.storage.local.get(DEVICE_ID_STORAGE_KEY);
    if (typeof stored?.[DEVICE_ID_STORAGE_KEY] === "string" && stored[DEVICE_ID_STORAGE_KEY]) {
      return stored[DEVICE_ID_STORAGE_KEY];
    }
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ [DEVICE_ID_STORAGE_KEY]: id });
    return id;
  } catch {
    return "unknown-device";
  }
}

async function fetchYouTubeToken(force = false) {
  try {
    const stored = await chrome.storage.session.get(TOKEN_STORAGE_KEY);
    const entry = stored?.[TOKEN_STORAGE_KEY];
    if (!force && entry && typeof entry.token === "string" && Number(entry.exp) > Date.now() + 5 * 60 * 1000) {
      return entry.token;
    }
    const license = await getStoredLicense();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOKEN_FETCH_TIMEOUT_MS);
    timer?.unref?.();
    try {
      const response = await fetch(TOKEN_API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: await deviceId(), key: license?.key || "" }),
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const data = await response.json();
      if (data?.ok !== true || typeof data.token !== "string" || !data.token) return null;
      await chrome.storage.session.set({
        [TOKEN_STORAGE_KEY]: { token: data.token, exp: Number(data.exp) || 0 },
      });
      return data.token;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

async function youTubeFetch(url, options = {}, signal = null) {
  let token = await fetchYouTubeToken();
  if (!token) return { response: null, authError: true };
  const headers = new Headers(options.headers || {});
  headers.set("authorization", `Bearer ${token}`);
  let response = await fetch(url, { ...options, headers, cache: "no-store", signal });
  if (response.status === 401) {
    token = await fetchYouTubeToken(true);
    if (token) {
      headers.set("authorization", `Bearer ${token}`);
      response = await fetch(url, { ...options, headers, cache: "no-store", signal });
    }
  }
  return { response, authError: response.status === 401 };
}

export async function submitYouTubeJob(url, quality = "best", server = null, { signal = null } = {}) {
  const base = server || (await getYouTubeServerUrl());
  if (!base) return { ok: false, error: "server-not-configured" };
  const body = {
    url,
    quality: String(quality || "best"),
  };
  async function post(forceToken = false) {
    const { controller, unlink } = linkedAbortController(signal);
    const timer = setTimeout(() => controller.abort(), 15_000);
    timer?.unref?.();
    try {
      if (forceToken) await fetchYouTubeToken(true);
      return await youTubeFetch(`${base}/api/youtube`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }, controller.signal);
    } finally {
      clearTimeout(timer);
      unlink();
    }
  }
  let { response, authError } = await post();
  if (!authError && response?.status === 429) {
    // A freshly registered license key is not reflected in the cached
    // capability token; refresh once and retry so Pro applies immediately.
    const refreshed = await post(true);
    response = refreshed.response;
    authError = refreshed.authError;
  }
  if (authError || !response) return { ok: false, error: "server-unauthorized" };
  try {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        error: typeof data?.error === "string" ? data.error : `http-${response.status}`,
        ...(Number.isInteger(data?.used) ? { used: data.used } : {}),
        ...(Number.isInteger(data?.limit) ? { limit: data.limit } : {}),
      };
    }
    if (typeof data?.jobId !== "string" || !data.jobId) return { ok: false, error: "missing-job-id" };
    return {
      ok: true,
      jobId: data.jobId,
      pro: data.pro === true,
      quotaUsed: Number.isInteger(data?.quotaUsed) ? data.quotaUsed : null,
      quotaLimit: Number.isInteger(data?.quotaLimit) ? data.quotaLimit : null,
    };
  } catch {
    return { ok: false, error: "server-unreachable" };
  }
}

export async function waitForYouTubeJob(jobId, server = null, {
  pollMs = JOB_POLL_MS,
  timeoutMs = JOB_TIMEOUT_MS,
  onProgress = null,
  signal = null,
} = {}) {
  const base = server || (await getYouTubeServerUrl());
  if (!base) return { ok: false, error: "server-not-configured" };
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) return { ok: false, error: "cancelled" };
    try {
      const { controller, unlink } = linkedAbortController(signal);
      const timer = setTimeout(() => controller.abort(), 10_000);
      timer?.unref?.();
      const { response, authError } = await youTubeFetch(
        `${base}/api/jobs/${encodeURIComponent(jobId)}`,
        {},
        controller.signal,
      ).finally(() => {
        clearTimeout(timer);
        unlink();
      });
      if (authError) return { ok: false, error: "server-unauthorized" };
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.status) {
        if (data.status === "ready") {
          return {
            ok: true,
            jobId,
            title: data.title || "",
            localFile: typeof data.localFile === "string" && data.localFile ? data.localFile : null,
          };
        }
        if (data.status === "failed") {
          return { ok: false, error: typeof data.error === "string" && data.error ? data.error : "job-failed" };
        }
        if (typeof onProgress === "function" && Number.isFinite(data?.progress)) {
          onProgress(
            Math.max(0, Math.min(100, Math.round(data.progress))),
            {
              speedMBps: Number.isFinite(data?.speedMBps) ? data.speedMBps : null,
              etaSeconds: Number.isFinite(data?.etaSeconds) ? data.etaSeconds : null,
            },
          );
        }
      }
    } catch {
      if (signal?.aborted) return { ok: false, error: "cancelled" };
      // Transient network error or poll timeout; keep polling.
    }
    await waitForPoll(pollMs, signal);
  }
  return { ok: false, error: "job-timeout" };
}

export async function youtubeJobFileUrl(jobId, server = null) {
  const base = server || normalizeServerUrl(DEFAULT_YOUTUBE_SERVER_URL) || "";
  const token = await fetchYouTubeToken();
  const fileUrl = `${base}/api/jobs/${encodeURIComponent(jobId)}/file`;
  return token ? `${fileUrl}?t=${encodeURIComponent(token)}` : fileUrl;
}

function youtubeVideoId(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.hostname === "youtu.be") return url.pathname.slice(1).split("/")[0] || null;
    const direct = url.searchParams.get("v");
    if (direct) return direct;
    const pathMatch = /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,})/.exec(url.pathname);
    return pathMatch ? pathMatch[1] : null;
  } catch {
    return null;
  }
}

async function fetchYouTubeTitle(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  timer?.unref?.();
  try {
    const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const response = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
    if (!response.ok) return "";
    const data = await response.json().catch(() => ({}));
    return typeof data?.title === "string" ? data.title.trim().slice(0, 200) : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

export async function listYouTubeQualities(url, server = null) {
  const base = server || (await getYouTubeServerUrl());
  if (!base) return { ok: false, error: "server-not-configured" };
  const videoId = youtubeVideoId(url);
  if (!videoId) return { ok: false, error: "invalid-youtube-url" };
  try {
    const stored = await chrome.storage.session.get(QUALITIES_STORAGE_KEY);
    const cache = stored?.[QUALITIES_STORAGE_KEY] || {};
    const entry = cache[videoId];
    if (entry && Array.isArray(entry.qualities) && Number(entry.at) > Date.now() - QUALITIES_TTL_MS) {
      return {
        ok: true,
        qualities: entry.qualities,
        title: typeof entry.title === "string" ? entry.title : "",
        cached: true,
      };
    }
  } catch {
    // Cache is best effort.
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  timer?.unref?.();
  const { response, authError } = await youTubeFetch(`${base}/api/youtube-formats`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  }, controller.signal).finally(() => clearTimeout(timer));
  if (authError || !response) return { ok: false, error: "server-unauthorized" };
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok !== true || !Array.isArray(data.qualities)) {
    return { ok: false, error: typeof data?.error === "string" ? data.error : `http-${response.status}` };
  }
  const qualities = data.qualities.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  let title = typeof data?.title === "string" ? data.title.trim().slice(0, 200) : "";
  if (!title) title = await fetchYouTubeTitle(url);
  try {
    const stored = await chrome.storage.session.get(QUALITIES_STORAGE_KEY);
    const cache = stored?.[QUALITIES_STORAGE_KEY] || {};
    cache[videoId] = { qualities, title, at: Date.now() };
    await chrome.storage.session.set({ [QUALITIES_STORAGE_KEY]: cache });
  } catch {
    // Cache is best effort.
  }
  return { ok: true, qualities, title };
}
