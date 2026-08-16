import { canonicalHttpUrl } from "./candidate.js";

const CONSUMER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
const CREDENTIAL_HEADER_NAMES = new Set(["authorization", "cookie"]);
const MAX_DIAGNOSTICS = 256;

function canonicalReferrer(value) {
  return value ? canonicalHttpUrl(value)?.href || null : "";
}

function normalizedSourceContext(value = {}) {
  const initiator = canonicalReferrer(value?.initiator || "");
  return Object.freeze({
    tabId: Number.isInteger(value?.tabId) ? value.tabId : null,
    frameId: Number.isInteger(value?.frameId) && value.frameId >= 0 ? value.frameId : null,
    initiator: initiator || "",
  });
}

function normalizedConsumer(value) {
  return typeof value === "string" && CONSUMER_PATTERN.test(value) ? value : "media-fetch";
}

function headerName(operation) {
  return typeof operation?.header === "string" ? operation.header.trim() : "";
}

function recordedReferrer(operations) {
  for (const operation of operations) {
    if (headerName(operation).toLowerCase() !== "referer" || operation?.operation !== "set") continue;
    const referrer = canonicalReferrer(operation.value);
    if (referrer) return referrer;
  }
  return "";
}

function stablePathHash(pathname) {
  let hash = 2166136261;
  for (let index = 0; index < pathname.length; index += 1) {
    hash ^= pathname.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function targetMetadata(rawUrl) {
  const url = canonicalHttpUrl(rawUrl);
  if (!url) return Object.freeze({ host: "", extension: "", pathHash: "" });
  const extension = /\.([a-z0-9]{1,8})$/i.exec(url.pathname)?.[1]?.toLowerCase() || "";
  return Object.freeze({
    host: url.hostname,
    extension,
    pathHash: stablePathHash(url.pathname),
  });
}

function operationMetadata(operations) {
  const names = [];
  const credentialNames = [];
  for (const operation of operations) {
    const name = headerName(operation);
    if (!name) continue;
    const lower = name.toLowerCase();
    if (!names.some((item) => item.toLowerCase() === lower)) names.push(name);
    if ((CREDENTIAL_HEADER_NAMES.has(lower) || lower.startsWith("x-"))
      && !credentialNames.some((item) => item.toLowerCase() === lower)) {
      credentialNames.push(name);
    }
  }
  return Object.freeze({
    headerNames: Object.freeze(names),
    credentialHeaderNames: Object.freeze(credentialNames),
  });
}

export function resolveMediaRequestContext({
  url: rawUrl,
  fallbackReferrer = "",
  sourceContext = {},
  consumer = "media-fetch",
  lookupRequestHeaders = () => null,
} = {}) {
  const url = canonicalHttpUrl(rawUrl);
  if (!url) throw new Error("invalid-media-request-url");
  const fallback = canonicalReferrer(fallbackReferrer);
  if (fallbackReferrer && !fallback) throw new Error("invalid-media-request-referrer");
  const context = normalizedSourceContext(sourceContext);
  const lookup = lookupRequestHeaders(url.href, context) || null;
  const requestHeaders = Object.freeze([...(lookup?.dnrRequestHeaders || [])]);
  const replayedReferrer = recordedReferrer(requestHeaders);
  const referrer = replayedReferrer || fallback || "";
  const metadata = operationMetadata(requestHeaders);

  return Object.freeze({
    url: url.href,
    referrer,
    requestHeaders,
    sourceContext: context,
    diagnostic: Object.freeze({
      consumer: normalizedConsumer(consumer),
      target: targetMetadata(url.href),
      matchedBy: lookup?.matchedBy || "none",
      referrerSource: replayedReferrer ? "recorded" : fallback ? "fallback" : "none",
      referrerOrigin: referrer ? new URL(referrer).origin : "",
      sourceTabId: context.tabId,
      sourceFrameId: context.frameId,
      initiatorOrigin: context.initiator ? new URL(context.initiator).origin : "",
      ...metadata,
    }),
  });
}

function diagnosticKey(tabId, url) {
  return `${tabId}\n${url}`;
}

function publicDiagnostic(entry) {
  return Object.freeze({
    leaseId: entry.leaseId,
    consumer: entry.consumer,
    target: entry.target,
    matchedBy: entry.matchedBy,
    referrerSource: entry.referrerSource,
    referrerOrigin: entry.referrerOrigin,
    sourceTabId: entry.sourceTabId,
    sourceFrameId: entry.sourceFrameId,
    initiatorOrigin: entry.initiatorOrigin,
    headerNames: entry.headerNames,
    credentialHeaderNames: entry.credentialHeaderNames,
    requestTabId: entry.requestTabId,
    resourceType: entry.resourceType,
    statusCode: entry.statusCode,
    networkError: entry.networkError,
    fromCache: entry.fromCache,
    redirects: Object.freeze(entry.redirects.map((redirect) => Object.freeze({ ...redirect }))),
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
    durationMs: entry.completedAt === null ? null : Math.max(0, entry.completedAt - entry.startedAt),
  });
}

export function createMediaRequestDiagnosticStore({ maxEntries = MAX_DIAGNOSTICS, now = () => Date.now() } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new TypeError("invalid-media-diagnostic-limit");
  const entries = new Map();
  const pendingByRequest = new Map();

  function trim() {
    while (entries.size > maxEntries) {
      const oldestId = entries.keys().next().value;
      const removed = entries.get(oldestId);
      entries.delete(oldestId);
      if (!removed) continue;
      const key = diagnosticKey(removed.requestTabId, removed.rawUrl);
      const pending = pendingByRequest.get(key);
      if (!pending) continue;
      const next = pending.filter((leaseId) => leaseId !== oldestId);
      if (next.length) pendingByRequest.set(key, next);
      else pendingByRequest.delete(key);
    }
  }

  function start({ leaseId, requestTabId, url, diagnostic }) {
    if (typeof leaseId !== "string" || !leaseId || !Number.isInteger(requestTabId)) return false;
    const canonical = canonicalHttpUrl(url);
    if (!canonical || !diagnostic || typeof diagnostic !== "object") return false;
    const startedAt = Number(now());
    const entry = {
      leaseId,
      rawUrl: canonical.href,
      requestTabId,
      consumer: normalizedConsumer(diagnostic.consumer),
      target: targetMetadata(canonical.href),
      matchedBy: diagnostic.matchedBy || "none",
      referrerSource: diagnostic.referrerSource || "none",
      referrerOrigin: diagnostic.referrerOrigin || "",
      sourceTabId: Number.isInteger(diagnostic.sourceTabId) ? diagnostic.sourceTabId : null,
      sourceFrameId: Number.isInteger(diagnostic.sourceFrameId) ? diagnostic.sourceFrameId : null,
      initiatorOrigin: diagnostic.initiatorOrigin || "",
      headerNames: Object.freeze([...(diagnostic.headerNames || [])]),
      credentialHeaderNames: Object.freeze([...(diagnostic.credentialHeaderNames || [])]),
      resourceType: "",
      statusCode: null,
      networkError: "",
      fromCache: false,
      redirects: [],
      startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
      completedAt: null,
    };
    entries.delete(leaseId);
    entries.set(leaseId, entry);
    const key = diagnosticKey(requestTabId, canonical.href);
    pendingByRequest.set(key, [...(pendingByRequest.get(key) || []), leaseId]);
    trim();
    return true;
  }

  function takePending(tabId, url) {
    const key = diagnosticKey(tabId, url);
    const pending = pendingByRequest.get(key) || [];
    let entry = null;
    while (pending.length && !entry) {
      const leaseId = pending.shift();
      const candidate = entries.get(leaseId);
      if (candidate?.completedAt === null) entry = candidate;
    }
    if (pending.length) pendingByRequest.set(key, pending);
    else pendingByRequest.delete(key);
    return entry;
  }

  function redirect({ tabId, url, redirectUrl, statusCode = null } = {}) {
    if (!Number.isInteger(tabId)) return null;
    const source = canonicalHttpUrl(url);
    const target = canonicalHttpUrl(redirectUrl);
    if (!source || !target) return null;
    const entry = takePending(tabId, source.href);
    if (!entry) return null;
    entry.redirects.push(Object.freeze({
      host: target.hostname,
      statusCode: Number.isInteger(statusCode) ? statusCode : null,
    }));
    if (entry.redirects.length > 8) entry.redirects.shift();
    entry.rawUrl = target.href;
    entry.target = targetMetadata(target.href);
    const key = diagnosticKey(tabId, target.href);
    pendingByRequest.set(key, [...(pendingByRequest.get(key) || []), entry.leaseId]);
    return publicDiagnostic(entry);
  }

  function finish({ tabId, url, statusCode = null, error = "", resourceType = "", fromCache = false } = {}) {
    if (!Number.isInteger(tabId)) return null;
    const canonical = canonicalHttpUrl(url);
    if (!canonical) return null;
    const entry = takePending(tabId, canonical.href);
    if (!entry) return null;
    const completedAt = Number(now());
    entry.statusCode = Number.isInteger(statusCode) ? statusCode : null;
    entry.networkError = typeof error === "string" ? error.slice(0, 160) : "";
    entry.resourceType = typeof resourceType === "string" ? resourceType.slice(0, 32) : "";
    entry.fromCache = fromCache === true;
    entry.completedAt = Number.isFinite(completedAt) ? completedAt : Date.now();
    return publicDiagnostic(entry);
  }

  function list({ consumer = "", limit = maxEntries } = {}) {
    const normalizedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, maxEntries) : maxEntries;
    const filter = consumer ? normalizedConsumer(consumer) : "";
    return Object.freeze([...entries.values()]
      .filter((entry) => !filter || entry.consumer === filter)
      .slice(-normalizedLimit)
      .map(publicDiagnostic));
  }

  function clear() {
    entries.clear();
    pendingByRequest.clear();
  }

  return Object.freeze({ start, redirect, finish, list, clear, get size() { return entries.size; } });
}
