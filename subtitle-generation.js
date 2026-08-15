import { getStoredLicense } from "./license.js";

export const SUBTITLE_API_URL = "https://aura.mdownloader.workers.dev/api/subtitles";
export const GENERATED_SUBTITLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_VTT_BYTES = 2_000_000;
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

export class SubtitleGenerationError extends Error {
  constructor(code = "subtitle-generation-failed") {
    super(code);
    this.name = "SubtitleGenerationError";
    this.code = code;
  }
}

function cacheKeyInput({ mediaUrl = "", sourceUrl = "", title = "" } = {}) {
  return [sourceUrl, title, mediaUrl].map((value) => String(value || "").trim()).join("\u001f");
}

function hashKey(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function generatedSubtitleCacheKey(input) {
  return `auraGeneratedSubtitle:${hashKey(cacheKeyInput(input))}`;
}

async function requestJson(url, options = {}, signal = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  const abort = () => controller.abort();
  signal?.addEventListener?.("abort", abort, { once: true });
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      cache: "no-store",
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) {
      throw new SubtitleGenerationError(body?.error || `http-${response.status}`);
    }
    return body;
  } catch (error) {
    if (error instanceof SubtitleGenerationError) throw error;
    if (signal?.aborted) throw new SubtitleGenerationError("aborted");
    throw new SubtitleGenerationError("network-error");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.("abort", abort);
  }
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new SubtitleGenerationError("aborted"));
    };
    signal?.addEventListener?.("abort", abort, { once: true });
  });
}

export async function requestGeneratedSubtitle({ mediaUrl, sourceUrl = "", title = "", signal = null } = {}) {
  const license = await getStoredLicense();
  if (!license?.key || license.edition !== "pro") {
    throw new SubtitleGenerationError("pro-license-required");
  }
  const submitted = await requestJson(SUBTITLE_API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mediaUrl, sourceUrl, title, licenseKey: license.key }),
  }, signal);
  const jobId = typeof submitted.jobId === "string" ? submitted.jobId : "";
  if (!jobId) throw new SubtitleGenerationError("invalid-job");
  const startedAt = Date.now();
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await wait(POLL_INTERVAL_MS, signal);
    const result = await requestJson(`${SUBTITLE_API_URL}?id=${encodeURIComponent(jobId)}`, {}, signal);
    if (result.status === "running") continue;
    const vtt = result.result?.vtt || result.vtt || "";
    if (result.status !== "completed" || typeof vtt !== "string" || !vtt.trim()) {
      throw new SubtitleGenerationError("empty-subtitle");
    }
    if (new TextEncoder().encode(vtt).byteLength > MAX_VTT_BYTES) {
      throw new SubtitleGenerationError("subtitle-too-large");
    }
    return { vtt, model: result.result?.model || "" };
  }
  throw new SubtitleGenerationError("timeout");
}

export async function loadGeneratedSubtitle(input) {
  if (typeof globalThis.chrome?.storage?.local?.get !== "function") return null;
  const key = generatedSubtitleCacheKey(input);
  try {
    const stored = await chrome.storage.local.get(key);
    const entry = stored?.[key];
    if (!entry || typeof entry.vtt !== "string" || Date.now() - Number(entry.at || 0) > GENERATED_SUBTITLE_TTL_MS) {
      if (entry) await chrome.storage.local.remove(key);
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

export async function storeGeneratedSubtitle(input, value) {
  if (typeof globalThis.chrome?.storage?.local?.set !== "function" || typeof value?.vtt !== "string") return;
  const bytes = new TextEncoder().encode(value.vtt).byteLength;
  if (!bytes || bytes > MAX_VTT_BYTES) return;
  const key = generatedSubtitleCacheKey(input);
  try {
    await chrome.storage.local.set({ [key]: { vtt: value.vtt, model: value.model || "", at: Date.now() } });
  } catch {
    // Cache failure must not block playback.
  }
}
