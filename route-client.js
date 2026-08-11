import { canonicalHttpUrl } from "./candidate.js";

export const MEDIA_ROUTE_NATIVE_HOST = "com.personalvpn.media_route";
export const DEFAULT_ROUTE_TTL_SECONDS = 1800;
export const MIN_ROUTE_TTL_SECONDS = 300;
export const MAX_ROUTE_TTL_SECONDS = 7200;
export const MAX_ROUTE_URLS = 64;
export const DEFAULT_ROUTE_TIMEOUT_MS = 70_000;

export class MediaRouteError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "MediaRouteError";
    this.code = code;
  }
}

function validTtlSeconds(value) {
  return Number.isInteger(value)
    && value >= MIN_ROUTE_TTL_SECONDS
    && value <= MAX_ROUTE_TTL_SECONDS;
}

function normalizeEntry(value) {
  const url = canonicalHttpUrl(value);
  if (!url) return null;
  return Object.freeze({ url: url.href, host: url.hostname.toLowerCase().replace(/\.$/, "") });
}

export function normalizeRouteUrls(values) {
  if (!Array.isArray(values)) throw new MediaRouteError("invalid-route-urls");
  const entries = [];
  const seen = new Set();
  for (const value of values) {
    const entry = normalizeEntry(value);
    if (!entry) throw new MediaRouteError("invalid-route-url");
    if (seen.has(entry.host)) continue;
    seen.add(entry.host);
    entries.push(entry);
  }
  return entries;
}

function nativeError(code, detail = "") {
  const suffix = typeof detail === "string" && detail ? `: ${detail.slice(0, 256)}` : "";
  return new MediaRouteError(code, `${code}${suffix}`);
}

export function createMediaRouteClient({
  connectNative = (name) => chrome.runtime.connectNative(name),
  now = () => Date.now(),
  randomUUID = () => globalThis.crypto.randomUUID(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
  ttlSeconds = DEFAULT_ROUTE_TTL_SECONDS,
  timeoutMs = DEFAULT_ROUTE_TIMEOUT_MS,
} = {}) {
  if (!validTtlSeconds(ttlSeconds)) throw new MediaRouteError("invalid-route-ttl");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new MediaRouteError("invalid-route-timeout");

  let nativePort = null;
  const pendingRequests = new Map();
  const pendingByHost = new Map();
  const hostLeases = new Map();

  function clearExpiredLeases() {
    const current = now();
    for (const [host, expiresAtMs] of hostLeases) {
      if (!(expiresAtMs > current)) hostLeases.delete(host);
    }
  }

  function failPending(error) {
    for (const [requestId, pending] of pendingRequests) {
      pendingRequests.delete(requestId);
      pending.clear();
      pending.reject(error);
    }
  }

  function handleDisconnect(port) {
    void globalThis.chrome?.runtime?.lastError;
    if (nativePort !== port) return;
    nativePort = null;
    failPending(nativeError("route-disconnected"));
  }

  function handleMessage(message) {
    const pending = pendingRequests.get(message?.requestId);
    if (!pending || message?.type !== "ensure-routes-result") return;
    pendingRequests.delete(message.requestId);
    pending.clear();
    if (typeof message.ok !== "boolean") {
      pending.reject(nativeError("invalid-route-response"));
      return;
    }
    if (!message.ok) {
      pending.reject(nativeError("route-rejected", message.error));
      return;
    }
    const expiresAtMs = typeof message.expiresAtUtc === "string" ? Date.parse(message.expiresAtUtc) : Number.NaN;
    const hosts = Array.isArray(message.hosts)
      ? message.hosts.filter((value) => typeof value === "string")
        .map((value) => value.toLowerCase().replace(/\.$/, ""))
      : [];
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now()
      || !pending.hosts.every((host) => hosts.includes(host))) {
      pending.reject(nativeError("invalid-route-response"));
      return;
    }
    pending.resolve({
      ok: true,
      requestId: message.requestId,
      requestedHosts: pending.hosts,
      hosts,
      expiresAtUtc: message.expiresAtUtc,
      expiresAtMs,
    });
  }

  function getNativePort() {
    if (nativePort) return nativePort;
    let port;
    try {
      port = connectNative(MEDIA_ROUTE_NATIVE_HOST);
      if (!port?.onMessage?.addListener || !port?.onDisconnect?.addListener
        || typeof port.postMessage !== "function") throw new Error("invalid-native-port");
      port.onMessage.addListener(handleMessage);
      port.onDisconnect.addListener(() => handleDisconnect(port));
      nativePort = port;
      return port;
    } catch {
      nativePort = null;
      throw nativeError("route-unavailable");
    }
  }

  function requestHosts(entries) {
    const hosts = entries.map((entry) => entry.host);
    const urls = entries.map((entry) => entry.url);
    const requestId = String(randomUUID());
    return new Promise((resolve, reject) => {
      let timer = null;
      const pending = {
        hosts,
        resolve,
        reject,
        clear() {
          if (timer !== null) clearTimer(timer);
          timer = null;
        },
      };
      pendingRequests.set(requestId, pending);
      timer = setTimer(() => {
        if (!pendingRequests.delete(requestId)) return;
        pending.clear();
        reject(nativeError("route-timeout"));
      }, timeoutMs);
      try {
        const port = getNativePort();
        port.postMessage({
          type: "ensure-routes",
          requestId,
          urls,
          ttlSeconds,
        });
      } catch {
        pendingRequests.delete(requestId);
        pending.clear();
        nativePort = null;
        reject(nativeError("route-unavailable"));
      }
    });
  }

  function cacheSuccessfulHosts(entries, result) {
    if (!(result.expiresAtMs > now())) return;
    const reported = new Set(result.hosts);
    for (const entry of entries) {
      if (!reported.has(entry.host)) continue;
      hostLeases.set(entry.host, result.expiresAtMs);
    }
  }

  function startHostRequest(entries) {
    const nativeRequest = requestHosts(entries);
    for (const entry of entries) {
      const hostRequest = nativeRequest
        .then((result) => {
          cacheSuccessfulHosts(entries, result);
          return result;
        })
        .finally(() => {
          if (pendingByHost.get(entry.host) === hostRequest) pendingByHost.delete(entry.host);
        });
      pendingByHost.set(entry.host, hostRequest);
    }
  }

  async function ensureRoutes(values) {
    const entries = normalizeRouteUrls(values);
    if (!entries.length) return { ok: true, hosts: [], expiresAtUtc: undefined };
    clearExpiredLeases();
    const missing = entries.filter((entry) => !hostLeases.has(entry.host));
    const toRequest = missing.filter((entry) => !pendingByHost.has(entry.host));
    for (let offset = 0; offset < toRequest.length; offset += MAX_ROUTE_URLS) {
      startHostRequest(toRequest.slice(offset, offset + MAX_ROUTE_URLS));
    }
    const waits = missing.map((entry) => pendingByHost.get(entry.host));
    if (waits.length) await Promise.all(waits);
    clearExpiredLeases();
    const expiries = entries
      .map((entry) => hostLeases.get(entry.host))
      .filter((value) => Number.isFinite(value));
    const expiresAtMs = expiries.length ? Math.min(...expiries) : null;
    return {
      ok: true,
      hosts: entries.map((entry) => entry.host),
      expiresAtUtc: expiresAtMs ? new Date(expiresAtMs).toISOString() : undefined,
    };
  }

  function close() {
    const port = nativePort;
    nativePort = null;
    failPending(nativeError("route-closed"));
    try { port?.disconnect?.(); } catch { /* already closed */ }
  }

  return Object.freeze({
    ensureRoutes,
    close,
    cachedHosts() {
      clearExpiredLeases();
      return [...hostLeases.keys()];
    },
  });
}
