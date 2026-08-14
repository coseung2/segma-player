import { canonicalHttpUrl, normalizeOriginPath } from "./candidate.js";

export const REQUEST_HEADER_STORE_LIMITS = Object.freeze({
  maxEntries: 256,
  ttlMs: 60_000,
  maxHeadersPerEntry: 16,
  maxHeaderValueBytes: 2_048,
  maxEntryBytes: 8_192,
  maxTotalBytes: 262_144,
});

const CORE_HEADER_NAMES = Object.freeze({
  referer: "Referer",
  origin: "Origin",
  "accept-language": "Accept-Language",
  authorization: "Authorization",
  cookie: "Cookie",
});

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const CLIENT_HINT_HEADERS = new Set([
  "dpr",
  "downlink",
  "device-memory",
  "ect",
  "rtt",
  "save-data",
  "viewport-width",
  "width",
]);

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_\x60|~0-9A-Za-z]+$/;
const X_AUTH_HEADER_RE = /^x-(?:(?:[a-z0-9]+[-_])*?(?:auth|authorization|token|sign|signature|key|ticket|session)(?:[-_][a-z0-9]+)*)$/;
const EMPTY_FETCH_HEADERS = Object.freeze({});
const EMPTY_DNR_REQUEST_HEADERS = Object.freeze([]);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function utf8ByteLength(value) {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(value).byteLength;
  return [...value].length;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError("invalid-request-header-" + name);
  }
  return value;
}

function positiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError("invalid-request-header-" + name);
  }
  return value;
}

function optionValue(options, primary, alias, fallback) {
  if (options && options[primary] !== undefined) return options[primary];
  if (options && alias && options[alias] !== undefined) return options[alias];
  return fallback;
}

function normalizedLimits(options = {}) {
  const limits = {
    maxEntries: positiveInteger(
      optionValue(options, "maxEntries", null, REQUEST_HEADER_STORE_LIMITS.maxEntries),
      "max-entries",
    ),
    ttlMs: positiveNumber(
      optionValue(options, "ttlMs", "ttl", REQUEST_HEADER_STORE_LIMITS.ttlMs),
      "ttl",
    ),
    maxHeadersPerEntry: positiveInteger(
      optionValue(options, "maxHeadersPerEntry", "maxHeaders", REQUEST_HEADER_STORE_LIMITS.maxHeadersPerEntry),
      "header-count",
    ),
    maxHeaderValueBytes: positiveInteger(
      optionValue(options, "maxHeaderValueBytes", "maxValueBytes", REQUEST_HEADER_STORE_LIMITS.maxHeaderValueBytes),
      "header-value",
    ),
    maxEntryBytes: positiveInteger(
      optionValue(options, "maxEntryBytes", "maxTotalHeaderBytes", REQUEST_HEADER_STORE_LIMITS.maxEntryBytes),
      "entry-size",
    ),
    maxTotalBytes: positiveInteger(
      optionValue(options, "maxTotalBytes", "maxStoreBytes", REQUEST_HEADER_STORE_LIMITS.maxTotalBytes),
      "total-size",
    ),
  };
  return Object.freeze(limits);
}

function headerPairs(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (!entry || typeof entry !== "object") return [null, null];
      return [entry.name ?? entry.header, entry.value];
    });
  }
  if (typeof value.entries === "function") {
    try {
      return [...value.entries()];
    } catch {
      return [];
    }
  }
  if (typeof value !== "object") return [];
  try {
    return Object.entries(value);
  } catch {
    return [];
  }
}

function normalizedHeaderName(value) {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  if (!lower || !HEADER_NAME_RE.test(lower)) return null;
  if (HOP_BY_HOP_HEADERS.has(lower)
    || CLIENT_HINT_HEADERS.has(lower)
    || lower.startsWith("sec-fetch-")
    || lower.startsWith("sec-ch-")
    || lower === "range"
    || lower === "host"
    || lower === "user-agent") {
    return null;
  }
  if (hasOwn(CORE_HEADER_NAMES, lower)) return CORE_HEADER_NAMES[lower];
  if (X_AUTH_HEADER_RE.test(lower)) return lower;
  return null;
}

function normalizeHeaderCollection(value, limits) {
  const byName = new Map();
  for (const [rawName, rawValue] of headerPairs(value)) {
    const name = normalizedHeaderName(rawName);
    if (!name || typeof rawValue !== "string" || !rawValue.trim()) continue;
    if (/[\u0000-\u001f\u007f]/.test(rawValue)) continue;
    const valueBytes = utf8ByteLength(rawValue);
    if (valueBytes > limits.maxHeaderValueBytes) continue;
    const bytes = utf8ByteLength(name) + valueBytes;
    byName.delete(name);
    byName.set(name, { name, value: rawValue, bytes });
  }

  const entries = [];
  let totalBytes = 0;
  for (const entry of byName.values()) {
    if (entries.length >= limits.maxHeadersPerEntry) break;
    if (entry.bytes > limits.maxEntryBytes || totalBytes + entry.bytes > limits.maxEntryBytes) continue;
    entries.push(Object.freeze(entry));
    totalBytes += entry.bytes;
  }
  return Object.freeze({ entries: Object.freeze(entries), totalBytes });
}

function credentialHeader(name) {
  return name === "Authorization" || name === "Cookie" || name.toLowerCase().startsWith("x-");
}

function headerViews(entries, includeCredentials = true) {
  const fetchHeaders = {};
  const dnrRequestHeaders = [];
  for (const entry of entries) {
    if (entry.name === "Accept-Language") fetchHeaders[entry.name] = entry.value;
    if (includeCredentials || !credentialHeader(entry.name)) {
      dnrRequestHeaders.push(Object.freeze({
        header: entry.name,
        operation: "set",
        value: entry.value,
      }));
    }
  }
  return Object.freeze({
    fetchHeaders: Object.freeze(fetchHeaders),
    dnrRequestHeaders: Object.freeze(dnrRequestHeaders),
  });
}

export function replayHeaderViews(value, options = {}) {
  const normalized = normalizeHeaderCollection(value, normalizedLimits(options));
  return headerViews(normalized.entries);
}

export function replayableFetchHeaders(value, options = {}) {
  return replayHeaderViews(value, options).fetchHeaders;
}

export function dnrRequestHeaderOperations(value, options = {}) {
  return replayHeaderViews(value, options).dnrRequestHeaders;
}

function normalizeContext(input = {}) {
  const nested = input && typeof input.context === "object" && input.context !== null
    ? input.context
    : {};
  const source = { ...nested, ...input };
  const tabId = Number.isInteger(source.tabId) ? source.tabId : null;
  const frameId = Number.isInteger(source.frameId) && source.frameId >= 0 ? source.frameId : null;
  const initiatorValue = source.initiator ?? source.documentUrl ?? source.initiatorOrigin;
  const initiatorUrl = canonicalHttpUrl(initiatorValue);
  return Object.freeze({
    tabId,
    frameId,
    initiatorOrigin: initiatorUrl ? initiatorUrl.origin : null,
  });
}

function sameContext(entry, context) {
  return entry.tabId === context.tabId
    && entry.frameId === context.frameId
    && entry.initiatorOrigin === context.initiatorOrigin;
}

function contextCompatible(entry, context) {
  return (context.tabId === null || entry.tabId === null || context.tabId === entry.tabId)
    && (context.frameId === null || entry.frameId === null || context.frameId === entry.frameId)
    && (context.initiatorOrigin === null
      || entry.initiatorOrigin === null
      || context.initiatorOrigin === entry.initiatorOrigin);
}

function contextScore(entry, context) {
  let score = 0;
  if (context.tabId !== null && entry.tabId === context.tabId) score += 100;
  if (context.frameId !== null && entry.frameId === context.frameId) score += 50;
  if (context.initiatorOrigin !== null && entry.initiatorOrigin === context.initiatorOrigin) score += 25;
  return score;
}

function currentTime(now) {
  const value = now();
  return Number.isFinite(value) ? value : Date.now();
}

function redactedUrl(value) {
  const url = canonicalHttpUrl(value);
  return url ? url.origin + "/[redacted]" : "[invalid-url]";
}

export function createRequestHeaderStore(options = {}) {
  const limits = normalizedLimits(options);
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const entries = new Map();
  let totalBytes = 0;
  let nextEntryId = 1;

  function removeEntry(key) {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    totalBytes -= entry.headerBytes;
    return true;
  }

  function purgeExpired(at) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at) removeEntry(key);
    }
  }

  function touch(entry) {
    if (!entries.has(entry.key)) return;
    entries.delete(entry.key);
    entries.set(entry.key, entry);
  }

  function makeRoom(bytes) {
    if (bytes > limits.maxTotalBytes) return false;
    while (entries.size >= limits.maxEntries || totalBytes + bytes > limits.maxTotalBytes) {
      const oldest = entries.keys().next();
      if (oldest.done) return false;
      removeEntry(oldest.value);
    }
    return true;
  }

  function payloadForRecord(input, headers, context) {
    if (typeof input === "string") {
      return { url: input, headers, ...(context && typeof context === "object" ? context : {}) };
    }
    return input;
  }

  function record(input, headers, context) {
    const payload = payloadForRecord(input, headers, context);
    if (!payload || typeof payload !== "object") return false;
    const canonical = canonicalHttpUrl(payload.url);
    const originPath = canonical ? normalizeOriginPath(canonical.href) : null;
    if (!canonical || !originPath) return false;

    const normalized = normalizeHeaderCollection(
      payload.headers !== undefined ? payload.headers : payload.requestHeaders,
      limits,
    );
    if (!normalized.entries.length) return false;

    const contextValue = normalizeContext(payload);
    const observedAt = [payload.at, payload.recordedAt, payload.timestamp, payload.now]
      .find((value) => Number.isFinite(value));
    const recordedAt = observedAt === undefined ? currentTime(now) : observedAt;
    const expiresAt = recordedAt + limits.ttlMs;
    const at = currentTime(now);
    const headerBytes = normalized.totalBytes;
    if (!Number.isFinite(recordedAt) || !Number.isFinite(expiresAt)
      || expiresAt <= at || headerBytes > limits.maxTotalBytes) return false;

    purgeExpired(at);
    for (const entry of entries.values()) {
      if (entry.url === canonical.href && sameContext(entry, contextValue)) {
        removeEntry(entry.key);
        break;
      }
    }

    if (!makeRoom(headerBytes)) return false;
    const entry = Object.freeze({
      key: String(nextEntryId++),
      url: canonical.href,
      origin: canonical.origin,
      originPath,
      tabId: contextValue.tabId,
      frameId: contextValue.frameId,
      initiatorOrigin: contextValue.initiatorOrigin,
      headers: normalized.entries,
      headerBytes,
      recordedAt,
      expiresAt,
    });
    entries.set(entry.key, entry);
    totalBytes += headerBytes;
    return true;
  }

  function lookup(rawUrl, context = {}) {
    const canonical = canonicalHttpUrl(rawUrl);
    const originPath = canonical ? normalizeOriginPath(canonical.href) : null;
    if (!canonical || !originPath) return null;
    const at = currentTime(now);
    purgeExpired(at);
    const contextValue = normalizeContext(context);
    let selected = null;
    let selectedScore = -1;
    for (const entry of entries.values()) {
      if (entry.origin !== canonical.origin || entry.originPath !== originPath
        || !contextCompatible(entry, contextValue)) continue;
      const exact = entry.url === canonical.href;
      const score = (exact ? 1_000_000 : 0) + contextScore(entry, contextValue);
      if (score >= selectedScore) {
        selected = entry;
        selectedScore = score;
      }
    }
    if (!selected) return null;

    const exact = selected.url === canonical.href;
    const views = headerViews(selected.headers, exact);
    if (!Object.keys(views.fetchHeaders).length && !views.dnrRequestHeaders.length) return null;
    touch(selected);
    return Object.freeze({
      matchedBy: exact ? "exact" : "origin-path",
      context: contextValue,
      fetchHeaders: views.fetchHeaders,
      dnrRequestHeaders: views.dnrRequestHeaders,
    });
  }

  function fetchHeaders(rawUrl, context = {}) {
    return lookup(rawUrl, context)?.fetchHeaders || EMPTY_FETCH_HEADERS;
  }

  function dnrRequestHeaders(rawUrl, context = {}) {
    return lookup(rawUrl, context)?.dnrRequestHeaders || EMPTY_DNR_REQUEST_HEADERS;
  }

  function diagnostics() {
    const at = currentTime(now);
    purgeExpired(at);
    const diagnosticEntries = [...entries.values()].map((entry) => Object.freeze({
      url: redactedUrl(entry.url),
      tabId: entry.tabId,
      frameId: entry.frameId,
      initiatorOrigin: entry.initiatorOrigin,
      headerNames: Object.freeze(entry.headers.map(({ name }) => name)),
      headerCount: entry.headers.length,
      bytes: entry.headerBytes,
      expiresInMs: Math.max(0, entry.expiresAt - at),
    }));
    return Object.freeze({
      size: entries.size,
      totalBytes,
      limits,
      entries: Object.freeze(diagnosticEntries),
    });
  }

  function clear() {
    entries.clear();
    totalBytes = 0;
  }

  return Object.freeze({
    record,
    recordRequest: record,
    lookup,
    get: lookup,
    fetchHeaders,
    dnrRequestHeaders,
    diagnostics,
    clear,
    get size() {
      purgeExpired(currentTime(now));
      return entries.size;
    },
    get totalBytes() {
      purgeExpired(currentTime(now));
      return totalBytes;
    },
  });
}
