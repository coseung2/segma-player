import { getStoredLicense, LICENSE_API_URL } from "./license.js";

export const YOUTUBE_SERVER_STORAGE_KEY = "auraYouTubeServer";
// Tailscale serve HTTPS proxy (443 → local 8788). Port 443 keeps the
// canonical-URL validator happy and the address only resolves inside the
// tailnet.
export const DEFAULT_YOUTUBE_SERVER_URL = "https://desktop-8n966j0.tail4cbe57.ts.net";
const DEVICE_ID_STORAGE_KEY = "auraYouTubeDeviceId";
const TOKEN_STORAGE_KEY = "auraYouTubeServerToken";
const TOKEN_API_URL = LICENSE_API_URL.replace("/api/license", "/api/youtube-token");
const TOKEN_FETCH_TIMEOUT_MS = 12_000;
const JOB_POLL_MS = 2_000;
const JOB_TIMEOUT_MS = 5 * 60 * 1000;

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

export async function submitYouTubeJob(url, quality = "best", server = null) {
  const base = server || (await getYouTubeServerUrl());
  if (!base) return { ok: false, error: "server-not-configured" };
  const body = {
    url,
    quality: String(quality || "best"),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  timer?.unref?.();
  const { response, authError } = await youTubeFetch(`${base}/api/youtube`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, controller.signal).finally(() => clearTimeout(timer));
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
} = {}) {
  const base = server || (await getYouTubeServerUrl());
  if (!base) return { ok: false, error: "server-not-configured" };
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      timer?.unref?.();
      const { response, authError } = await youTubeFetch(
        `${base}/api/jobs/${encodeURIComponent(jobId)}`,
        {},
        controller.signal,
      ).finally(() => clearTimeout(timer));
      if (authError) return { ok: false, error: "server-unauthorized" };
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.status) {
        if (data.status === "ready") return { ok: true, jobId, title: data.title || "" };
        if (data.status === "failed") {
          return { ok: false, error: typeof data.error === "string" && data.error ? data.error : "job-failed" };
        }
        if (typeof onProgress === "function" && Number.isFinite(data?.progress)) {
          onProgress(Math.max(0, Math.min(100, Math.round(data.progress))));
        }
      }
    } catch {
      // Transient network error or poll timeout; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { ok: false, error: "job-timeout" };
}

export async function youtubeJobFileUrl(jobId, server = null) {
  const base = server || normalizeServerUrl(DEFAULT_YOUTUBE_SERVER_URL) || "";
  const token = await fetchYouTubeToken();
  const fileUrl = `${base}/api/jobs/${encodeURIComponent(jobId)}/file`;
  return token ? `${fileUrl}?t=${encodeURIComponent(token)}` : fileUrl;
}
