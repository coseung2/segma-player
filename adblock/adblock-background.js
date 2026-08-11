import {
  ADBLOCK_RULE_ID_START,
  DEFAULT_SETTINGS,
  blockedByFilters,
  buildDnrRules,
  isSiteAllowed,
  mergeSettings,
  withIncrements,
} from "./adblock-core.js";
import { AD_HOSTS, TRACKER_HOSTS } from "./adblock-rules.js";

const STORAGE_KEY = "auraAdBlock";
const MAX_RULE_COUNT = AD_HOSTS.length + TRACKER_HOSTS.length + 16;
const PENDING_FLUSH_MS = 3000;

let settings = DEFAULT_SETTINGS;
let pending = { blockedRequests: 0, hiddenElements: 0, suppressedPopups: 0 };
let flushTimer = null;

async function readSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  settings = mergeSettings(stored[STORAGE_KEY]);
  return settings;
}

async function writeSettings() {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings });
}

async function installRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .filter((rule) => rule.id >= ADBLOCK_RULE_ID_START && rule.id < ADBLOCK_RULE_ID_START + MAX_RULE_COUNT)
    .map((rule) => rule.id);
  const addRules = settings.enabled ? buildDnrRules(settings) : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

function scheduleFlush() {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPending();
  }, PENDING_FLUSH_MS);
}

async function flushPending() {
  if (!pending.blockedRequests && !pending.hiddenElements && !pending.suppressedPopups) {
    return;
  }
  const increments = pending;
  pending = { blockedRequests: 0, hiddenElements: 0, suppressedPopups: 0 };
  settings = { ...settings, stats: withIncrements(settings.stats, increments) };
  await writeSettings();
}

function initiatorAllowed(details) {
  const initiator = details.initiator || details.documentUrl;
  if (!initiator) return false;
  try {
    return isSiteAllowed(new URL(initiator).hostname, settings.siteAllow);
  } catch {
    return false;
  }
}

function handleRequest(details) {
  if (!settings.enabled) return;
  try {
    const hostname = new URL(details.url).hostname;
    if (blockedByFilters(hostname, settings.filters) && !initiatorAllowed(details)) {
      pending.blockedRequests += 1;
      scheduleFlush();
    }
  } catch {
    // Malformed URLs are ignored; declarativeNetRequest still enforces rules.
  }
}

async function handleMessage(message) {
  switch (message.type) {
    case "adblock:get-state":
      await flushPending();
      return { ok: true, settings };
    case "adblock:set-enabled": {
      settings = mergeSettings({ ...settings, enabled: Boolean(message.enabled) });
      await writeSettings();
      await installRules();
      return { ok: true, settings };
    }
    case "adblock:set-filters": {
      settings = mergeSettings({
        ...settings,
        filters: { ...settings.filters, ...(message.filters || {}) },
      });
      await writeSettings();
      await installRules();
      return { ok: true, settings };
    }
    case "adblock:set-site-allowed": {
      const site = mergeSettings({ siteAllow: [message.site] }).siteAllow[0];
      if (!site) return { ok: false, error: "invalid-site" };
      const current = new Set(settings.siteAllow);
      if (message.allowed) current.add(site);
      else current.delete(site);
      settings = mergeSettings({ ...settings, siteAllow: [...current] });
      await writeSettings();
      await installRules();
      return { ok: true, settings };
    }
    case "adblock:increment": {
      pending.hiddenElements += Number(message.hiddenElements) || 0;
      pending.suppressedPopups += Number(message.suppressedPopups) || 0;
      scheduleFlush();
      return { ok: true };
    }
    case "adblock:reset-stats": {
      settings = { ...settings, stats: withIncrements({}, {}) };
      await writeSettings();
      return { ok: true, settings };
    }
    default:
      return undefined;
  }
}

export async function initAdBlock() {
  await readSettings();
  await installRules();
  chrome.webRequest.onBeforeRequest.addListener(handleRequest, {
    urls: ["http://*/*", "https://*/*"],
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !String(message.type || "").startsWith("adblock:")) return undefined;
    void handleMessage(message).then(sendResponse);
    return true;
  });
}
