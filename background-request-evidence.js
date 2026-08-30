import { canonicalHttpUrl, redactUrl } from "./candidate.js";

const DEFAULT_QA_TRACE_LIMIT = 512;
const DEFAULT_REDIRECT_LIMIT = 1000;
const DEFAULT_REDIRECT_TTL_MS = 60_000;

export function createQaRequestTraceStore({
  limit = DEFAULT_QA_TRACE_LIMIT,
  now = () => Date.now(),
} = {}) {
  if (!Number.isInteger(limit) || limit <= 0) throw new TypeError("invalid-qa-trace-limit");
  const entries = new Map();

  function remember(details, patch = {}) {
    if (!Number.isInteger(details?.tabId) || details.tabId <= 0 || typeof details?.url !== "string") return false;
    const resource = redactUrl(details.url);
    if (resource === "[redacted-invalid-url]") return false;
    const key = `${details.tabId}:${details.requestId || resource}`;
    const previous = entries.get(key) || {
      tabId: details.tabId,
      requestId: typeof details.requestId === "string" ? details.requestId : "",
      frameId: Number.isInteger(details.frameId) ? details.frameId : null,
      parentFrameId: Number.isInteger(details.parentFrameId) ? details.parentFrameId : null,
      resource,
      documentUrl: typeof details.documentUrl === "string" ? redactUrl(details.documentUrl) : "",
      type: typeof details.type === "string" ? details.type : "",
      phases: [],
    };
    previous.resource = resource;
    previous.phases = [...new Set([...previous.phases, patch.phase].filter(Boolean))].slice(-8);
    Object.assign(previous, patch);
    previous.updatedAt = Number.isFinite(details.timeStamp) ? details.timeStamp : now();
    entries.delete(key);
    entries.set(key, previous);
    while (entries.size > limit) entries.delete(entries.keys().next().value);
    return true;
  }

  function listForTab(tabId, { limit: requestedLimit = 160 } = {}) {
    if (!Number.isInteger(tabId) || tabId <= 0) return [];
    const boundedLimit = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, limit)
      : Math.min(160, limit);
    return [...entries.values()]
      .filter((entry) => entry.tabId === tabId)
      .slice(-boundedLimit)
      .map((entry) => ({ ...entry, phases: [...entry.phases] }));
  }

  function clearTab(tabId) {
    for (const [key, entry] of entries) {
      if (entry.tabId === tabId) entries.delete(key);
    }
  }

  return Object.freeze({
    remember,
    listForTab,
    clearTab,
    get size() { return entries.size; },
  });
}

export function createProgressiveRedirectStore({
  limit = DEFAULT_REDIRECT_LIMIT,
  ttlMs = DEFAULT_REDIRECT_TTL_MS,
  now = () => Date.now(),
} = {}) {
  if (!Number.isInteger(limit) || limit <= 0) throw new TypeError("invalid-redirect-limit");
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError("invalid-redirect-ttl");
  const entries = new Map();

  function get(value) {
    const url = canonicalHttpUrl(value)?.href;
    if (!url) return null;
    const entry = entries.get(url);
    if (!entry) return null;
    if (now() - entry.at > ttlMs) {
      entries.delete(url);
      return null;
    }
    return entry.url;
  }

  function record(details) {
    const from = canonicalHttpUrl(details?.url)?.href;
    const to = canonicalHttpUrl(details?.redirectUrl)?.href;
    if (!from || !to || from === to) return false;
    entries.delete(from);
    entries.set(from, { url: to, at: now() });
    while (entries.size > limit) entries.delete(entries.keys().next().value);
    return true;
  }

  function clear() {
    entries.clear();
  }

  return Object.freeze({ record, get, clear, get size() { return entries.size; } });
}
