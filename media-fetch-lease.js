import { canonicalHttpUrl } from "./candidate.js";

export const MEDIA_FETCH_RESOURCE_TYPES = Object.freeze(["xmlhttprequest", "other", "media"]);
export const MEDIA_FETCH_RULE_ID_START = 1_000_000_000;
export const OFFSCREEN_DOCUMENT_TAB_ID = -1;
const MAX_RULE_ID = 2_147_483_647;
const MAX_EXACT_REGEX_URL_LENGTH = 1800;

export function canonicalMediaFetchUrl(value) {
  return canonicalHttpUrl(value)?.href || null;
}

export function canonicalMediaFetchReferrer(value) {
  return canonicalMediaFetchUrl(value);
}

function regexLiteral(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function normalizedRequestHeaderOperations(requestHeaders, referrer) {
  const operations = new Map();
  for (const operation of Array.isArray(requestHeaders) ? requestHeaders : []) {
    const header = typeof operation?.header === "string" ? operation.header.trim() : "";
    const name = header.toLowerCase();
    if (!name || !["set", "remove", "append"].includes(operation?.operation)) continue;
    operations.delete(name);
    operations.set(name, { ...operation, header });
  }
  const recordedReferrer = operations.get("referer") || null;
  const recordedOrigin = operations.get("origin") || null;
  operations.delete("referer");
  operations.delete("origin");
  const result = [];
  if (referrer) result.push({ header: "Referer", operation: "set", value: referrer });
  else if (recordedReferrer) result.push(recordedReferrer);
  if (recordedOrigin) result.push(recordedOrigin);
  else {
    // Prevent chrome-extension:// from leaking as Origin. When the original
    // page request did carry Origin, the contextual header store supplies its
    // exact value and that value wins instead of this removal operation.
    result.push({ header: "Origin", operation: "remove" });
  }
  result.push(...operations.values());
  return result;
}

export function exactMediaFetchRule({ ruleId, tabId, url, referrer = "", requestHeaders = [] }) {
  if (!Number.isInteger(ruleId) || ruleId <= 0 || ruleId > MAX_RULE_ID) {
    throw new Error("invalid-media-fetch-rule-id");
  }
  if (!Number.isInteger(tabId) || (tabId <= 0 && tabId !== OFFSCREEN_DOCUMENT_TAB_ID)) {
    throw new Error("invalid-media-fetch-tab");
  }
  if (!canonicalMediaFetchUrl(url)) throw new Error("invalid-media-fetch-url");
  if (referrer && !canonicalMediaFetchReferrer(referrer)) {
    throw new Error("invalid-media-fetch-referrer");
  }
  const headers = normalizedRequestHeaderOperations(requestHeaders, referrer);
  const condition = {
    isUrlFilterCaseSensitive: true,
    resourceTypes: [...MEDIA_FETCH_RESOURCE_TYPES],
    tabIds: [tabId],
  };
  if (url.length <= MAX_EXACT_REGEX_URL_LENGTH) {
    condition.regexFilter = `^${regexLiteral(url)}$`;
  } else {
    condition.urlFilter = `|${url}|`;
  }
  return {
    id: ruleId,
    priority: 1,
    action: { type: "modifyHeaders", requestHeaders: headers },
    condition,
  };
}

export function playbackMediaFetchRule({ ruleId, tabId, url, referrer = "" }) {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) throw new Error("invalid-playback-media-url");
  const directory = parsed.pathname.slice(0, parsed.pathname.lastIndexOf("/") + 1) || "/";
  const rule = exactMediaFetchRule({ ruleId, tabId, url, referrer });
  delete rule.condition.regexFilter;
  delete rule.condition.urlFilter;
  rule.condition.urlFilter = `|${parsed.origin}${directory}`;
  return rule;
}

export function createMediaFetchRuleIdAllocator(start = MEDIA_FETCH_RULE_ID_START) {
  if (!Number.isInteger(start) || start <= 0 || start > MAX_RULE_ID) {
    throw new Error("invalid-media-fetch-rule-id-start");
  }
  let next = start;
  const allocated = new Set();
  return Object.freeze({
    allocate() {
      while (allocated.has(next)) {
        next += 1;
        if (next > MAX_RULE_ID) next = 1;
        if (next === start) throw new Error("media-fetch-rule-id-exhausted");
      }
      const ruleId = next;
      allocated.add(ruleId);
      next += 1;
      if (next > MAX_RULE_ID) next = 1;
      return ruleId;
    },
    release(ruleId) {
      allocated.delete(ruleId);
    },
    has(ruleId) {
      return allocated.has(ruleId);
    },
    get size() {
      return allocated.size;
    },
  });
}

export function createMediaFetchLeaseRegistry({
  maxLeases = 128,
  staleAfterMs = 10 * 60 * 1000,
  leaseIdFactory = () => globalThis.crypto.randomUUID(),
} = {}) {
  const leases = new Map();

  function create({ tabId, url, referrer = "", ruleId, now = Date.now() }) {
    if (!Number.isInteger(tabId) || (tabId <= 0 && tabId !== OFFSCREEN_DOCUMENT_TAB_ID)) {
      throw new Error("invalid-media-fetch-tab");
    }
    if (leases.size >= maxLeases) throw new Error("media-fetch-lease-limit");
    let leaseId = String(leaseIdFactory());
    while (leases.has(leaseId)) leaseId = String(leaseIdFactory());
    const lease = Object.freeze({ leaseId, tabId, url, referrer, ruleId, touchedAt: now });
    leases.set(leaseId, lease);
    return lease;
  }

  function get(leaseId) {
    return leases.get(leaseId) || null;
  }

  function remove(leaseId) {
    const lease = leases.get(leaseId) || null;
    if (lease) leases.delete(leaseId);
    return lease;
  }

  function touch(leaseId, now = Date.now()) {
    const current = leases.get(leaseId);
    if (!current) return null;
    const lease = Object.freeze({ ...current, touchedAt: now });
    leases.set(leaseId, lease);
    return lease;
  }

  function forTab(tabId) {
    return [...leases.values()].filter((lease) => lease.tabId === tabId);
  }

  function stale(now = Date.now(), limit = 16) {
    const result = [];
    for (const lease of leases.values()) {
      if (now - lease.touchedAt <= staleAfterMs) continue;
      result.push(lease);
      if (result.length >= limit) break;
    }
    return result;
  }

  return Object.freeze({
    create,
    get,
    remove,
    touch,
    forTab,
    stale,
    get size() {
      return leases.size;
    },
  });
}
