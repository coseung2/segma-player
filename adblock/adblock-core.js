import { AD_HOSTS, TRACKER_HOSTS } from "./adblock-rules.js";

// Dynamic declarativeNetRequest rule IDs for ad blocking. Static redirect
// rules live below 1000000 and media-fetch lease rules start at 1000000000.
export const ADBLOCK_RULE_ID_START = 2_000_000;

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  filters: { ads: true, trackers: true, annoyances: false },
  siteAllow: [],
  stats: { date: null, blockedRequests: 0, hiddenElements: 0, suppressedPopups: 0 },
});

export function normalizeHost(value) {
  const host = String(value || "").trim().toLowerCase().replace(/\.+$/, "");
  return host && /^[a-z0-9.-]+$/.test(host) && host.includes(".") ? host : null;
}

export function hostMatches(hostname, hosts) {
  const host = normalizeHost(hostname);
  if (!host) return false;
  return hosts.some((listed) => host === listed || host.endsWith(`.${listed}`));
}

export function blockedCategories(hostname) {
  const categories = new Set();
  if (hostMatches(hostname, AD_HOSTS)) categories.add("ads");
  if (hostMatches(hostname, TRACKER_HOSTS)) categories.add("trackers");
  return categories;
}

export function blockedByFilters(hostname, filters = DEFAULT_SETTINGS.filters) {
  const categories = blockedCategories(hostname);
  return (
    (filters?.ads && categories.has("ads")) ||
    (filters?.trackers && categories.has("trackers"))
  );
}

export function isSiteAllowed(hostname, siteAllow = []) {
  const host = normalizeHost(hostname);
  if (!host) return false;
  return siteAllow.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export function todayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function rollStats(stats = {}, now = new Date()) {
  const today = todayKey(now);
  if (stats.date === today) return stats;
  return { date: today, blockedRequests: 0, hiddenElements: 0, suppressedPopups: 0 };
}

export function withIncrements(stats, increments) {
  const base = rollStats(stats);
  return {
    ...base,
    blockedRequests: base.blockedRequests + (increments.blockedRequests || 0),
    hiddenElements: base.hiddenElements + (increments.hiddenElements || 0),
    suppressedPopups: base.suppressedPopups + (increments.suppressedPopups || 0),
  };
}

export function mergeSettings(stored) {
  const source = stored && typeof stored === "object" ? stored : {};
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_SETTINGS.enabled,
    filters: { ...DEFAULT_SETTINGS.filters, ...(source.filters || {}) },
    siteAllow: [
      ...new Set(
        (Array.isArray(source.siteAllow) ? source.siteAllow : [])
          .map(normalizeHost)
          .filter(Boolean),
      ),
    ].sort(),
    stats: rollStats(source.stats),
  };
}

export function buildDnrRules(settings) {
  const filters = settings?.filters || DEFAULT_SETTINGS.filters;
  const hosts = [];
  if (filters.ads) hosts.push(...AD_HOSTS);
  if (filters.trackers) hosts.push(...TRACKER_HOSTS);
  const unique = [...new Set(hosts.map(normalizeHost).filter(Boolean))].sort();
  const allowed = (settings?.siteAllow || []).filter(Boolean);
  const excludedInitiatorDomains = allowed.length ? allowed : undefined;
  const resourceTypes = [
    "sub_frame",
    "stylesheet",
    "script",
    "image",
    "font",
    "object",
    "xmlhttprequest",
    "ping",
    "media",
    "websocket",
    "other",
  ];
  return unique.map((host, index) => ({
    id: ADBLOCK_RULE_ID_START + index,
    priority: 1,
    action: { type: "block" },
    condition: {
      urlFilter: `||${host}^`,
      resourceTypes,
      ...(excludedInitiatorDomains ? { excludedInitiatorDomains } : {}),
    },
  }));
}
