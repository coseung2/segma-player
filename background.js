import {
  LIMITS,
  MEDIA_TYPES,
  canonicalHttpUrl,
  isDownloadableMediaType,
  isImageResourceUrl,
  isLikelyHlsSegmentUrl,
  makeCandidate,
  mediaTypeForResource,
  normalizeOriginPath,
  redactUrl,
  redactCandidateForUi,
  sanitizePageMessage,
  toTextOnlyRows,
  upsertCandidate,
} from "./candidate.js";
import { rankCandidates } from "./candidate-ranking.js";
import { DOWNLOAD_MENU_ID } from "./download.js";
import { candidateDownloadErrorCode } from "./download-errors.js";
import { normalizeLevel5KeyError } from "./level5-key-error.js";
import {
  MOBILE_USER_AGENT_RULE_ID_START,
  buildMobileUserAgentRule,
  buildMobileUserAgentRuleRemoval,
  createMobileUserAgentRuleIdAllocator,
  isMobileUserAgentRuleId,
} from "./mobile-user-agent.js";
import {
  createPlayerGraphResolver,
  isStreamtapePlayerPage,
  looksLikePlayerPage,
} from "./player-page-resolver.js";
import {
  companionStatus,
  showCompanionUi,
  startCompanionMediaDownload,
  startCompanionYouTubeDownload,
} from "./companion-client.js";
import { createMediaRequestDiagnosticStore } from "./media-request-context.js";
import { isPlayerFrameUrl, titleSelectorsForPage } from "./sites/registry.js";

const candidates = new Map();
const PROGRESSIVE_REDIRECT_TARGET_LIMIT = 1000;
const PROGRESSIVE_REDIRECT_TARGET_TTL_MS = 60_000;
const mediaRequestDiagnostics = createMediaRequestDiagnosticStore();
const qaRequestTraceByKey = new Map();
const QA_REQUEST_TRACE_LIMIT = 512;
const progressiveRedirectTargets = new Map();
const mainFramesByTab = new Map();
const frameLayoutsByTab = new Map();
const frameStatesByTab = new Map();
const doodDirectByFrame = new Map();
const DOOD_DIRECT_CACHE_TTL_MS = 60_000;
const nonPersistentCandidates = new WeakSet();
const SESSION_CANDIDATES_KEY = "candidates";
const tabTitleCache = new Map();
let persistTimer = null;
const MOBILE_USER_AGENT = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
const mobileUaRulesByTab = new Map();
let mobileUaRuleIds = null;

function rememberQaRequestTrace(details, patch = {}) {
  if (!Number.isInteger(details?.tabId) || details.tabId <= 0 || typeof details?.url !== "string") return;
  const resource = redactUrl(details.url);
  if (resource === "[redacted-invalid-url]") return;
  const key = `${details.tabId}:${details.requestId || resource}`;
  const previous = qaRequestTraceByKey.get(key) || {
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
  previous.updatedAt = Number.isFinite(details.timeStamp) ? details.timeStamp : Date.now();
  qaRequestTraceByKey.delete(key);
  qaRequestTraceByKey.set(key, previous);
  while (qaRequestTraceByKey.size > QA_REQUEST_TRACE_LIMIT) {
    qaRequestTraceByKey.delete(qaRequestTraceByKey.keys().next().value);
  }
}

try {
  const sessionAccess = chrome.storage.session.setAccessLevel?.({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  void sessionAccess?.catch?.(() => {});
} catch {
  // Chrome versions predating storage access levels keep the secure default.
}

const DOOD_MEDIA_HOST_RE = /(?:doodcdn|doimg|d000d|dood\.|playmogo|cloudatacdn)\./i;
async function ensureDirectMediaAccess(values) {
  const hosts = [...new Set((Array.isArray(values) ? values : [])
    .map((value) => canonicalHttpUrl(value)?.hostname)
    .filter(Boolean))];
  return { ok: true, hosts };
}

// Shared, bounded player-graph resolver for every player-page resolution
// path. Caches are keyed by canonical URL with short TTLs; the factory's only
// clear() aborts every in-flight traversal, so tab navigation never calls it
// globally (one tab would cancel another tab's active resolution). Positive
// and negative TTLs self-expire stale entries instead.
const playerGraphResolver = createPlayerGraphResolver({
  ensureRoute: ensureDirectMediaAccess,
  getRedirectTarget: (url) => progressiveRedirectTargetFor(url),
});

async function resolveObservedPlayerFrame(details) {
  if (details?.type !== "sub_frame" || !looksLikePlayerPage(details?.url)
    || !Number.isInteger(details?.tabId) || details.tabId <= 0
    || !Number.isInteger(details?.frameId) || details.frameId < 0) return null;
  const resolved = await playerGraphResolver.resolve(details.url);
  if (!resolved?.url) return null;
  const title = await tabTitle(details.tabId);
  return observeResource({
    pageTitle: title,
    pageUrl: resolved.referrer || details.url,
    siteUrl: details.initiator || details.documentUrl || details.url,
    frameUrl: details.url,
    frameId: details.frameId,
    resourceUrl: resolved.url,
    contentType: resolved.type === "hls"
      ? "application/vnd.apple.mpegurl" : "video/mp4",
    detectionSource: "player-page-resolver",
    player: isStreamtapePlayerPage(details.url) ? "streamtape" : "player-page",
    requestType: "sub_frame",
    confidence: 100,
    observedAt: details.timeStamp,
  }, details.tabId);
}

function canonicalYouTubeUrl(value) {
  const url = canonicalHttpUrl(value);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")) return url.href;
  return null;
}

function isYouTubeDetectionCandidate(candidate) {
  if (canonicalYouTubeUrl(candidate?.pageUrl)) return true;
  const resource = canonicalHttpUrl(candidate?.resourceUrl);
  if (!resource) return false;
  const host = resource.hostname.toLowerCase();
  return host === "googlevideo.com"
    || host.endsWith(".googlevideo.com")
    || host === "youtube.com"
    || host.endsWith(".youtube.com")
    || host === "youtu.be";
}

const YOUTUBE_QUALITIES = new Set(["best", "4320", "2160", "1440", "1080", "720", "480", "360", "240", "144"]);

async function startYouTubeDownload(rawUrl, rawQuality = "best") {
  const url = canonicalYouTubeUrl(rawUrl);
  if (!url) throw new Error("invalid-youtube-url");
  const quality = String(rawQuality || "best");
  if (!YOUTUBE_QUALITIES.has(quality)) throw new Error("invalid-youtube-quality");

  const jobId = crypto.randomUUID();
  const accepted = await startCompanionYouTubeDownload({ jobId, url, quality });
  if (accepted?.accepted !== true || accepted?.jobId !== jobId) {
    const error = new Error("Segma Player가 YouTube 다운로드 작업을 수락하지 않았습니다.");
    error.code = "media-companion-start-rejected";
    throw error;
  }
  return { mode: "youtube-companion", jobId };
}
function progressiveRedirectTargetFor(value) {
  const url = canonicalHttpUrl(value)?.href;
  if (!url) return null;
  const entry = progressiveRedirectTargets.get(url);
  if (!entry) return null;
  if (Date.now() - entry.at > PROGRESSIVE_REDIRECT_TARGET_TTL_MS) {
    progressiveRedirectTargets.delete(url);
    return null;
  }
  return entry.url;
}

function recordProgressiveRedirect(details) {
  const from = canonicalHttpUrl(details?.url)?.href;
  const to = canonicalHttpUrl(details?.redirectUrl)?.href;
  if (!from || !to || from === to) return;
  progressiveRedirectTargets.delete(from);
  progressiveRedirectTargets.set(from, { url: to, at: Date.now() });
  while (progressiveRedirectTargets.size > PROGRESSIVE_REDIRECT_TARGET_LIMIT) {
    progressiveRedirectTargets.delete(progressiveRedirectTargets.keys().next().value);
  }
}

const mobileUaRulesReady = chrome.declarativeNetRequest.getSessionRules().then((rules) => {
  const mobileRules = rules.filter((rule) => isMobileUserAgentRuleId(rule.id));
  mobileUaRuleIds = createMobileUserAgentRuleIdAllocator({
    reservedIds: mobileRules.map((rule) => rule.id),
  });
  for (const rule of mobileRules) {
    const tabId = rule.condition?.tabIds?.[0];
    if (Number.isInteger(tabId) && tabId > 0) mobileUaRulesByTab.set(tabId, rule.id);
  }
}).catch(() => {
  mobileUaRuleIds = createMobileUserAgentRuleIdAllocator();
});

async function setMobileUserAgentForTab(tabId, enabled) {
  await mobileUaRulesReady;
  const tab = await chrome.tabs.get(tabId);
  const existingRuleId = mobileUaRulesByTab.get(tabId) || null;
  if (!enabled) {
    if (existingRuleId) {
      await chrome.declarativeNetRequest.updateSessionRules(buildMobileUserAgentRuleRemoval(existingRuleId));
      mobileUaRulesByTab.delete(tabId);
      mobileUaRuleIds?.release(existingRuleId);
    }
    await chrome.tabs.reload(tabId, { bypassCache: true });
    return { ok: true, enabled: false };
  }
  if (!existingRuleId) {
    const ruleId = mobileUaRuleIds.allocate();
    try {
      const rule = buildMobileUserAgentRule({
        ruleId,
        tabId,
        tabUrl: tab?.url,
        userAgent: MOBILE_USER_AGENT,
      });
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [], addRules: [rule] });
      mobileUaRulesByTab.set(tabId, ruleId);
    } catch (error) {
      mobileUaRuleIds.release(ruleId);
      throw error;
    }
  }
  await chrome.tabs.reload(tabId, { bypassCache: true });
  return { ok: true, enabled: true };
}

function isLikelyDoodMediaHost(url) {
  try {
    return DOOD_MEDIA_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function exactExtensionPageSender(sender, pageName) {
  if (sender?.id !== chrome.runtime.id || typeof sender.url !== "string") return false;
  try {
    const senderUrl = new URL(sender.url);
    const expected = new URL(chrome.runtime.getURL(pageName));
    return senderUrl.origin === expected.origin && senderUrl.pathname === expected.pathname;
  } catch {
    return false;
  }
}


function configureDownloadMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: DOWNLOAD_MENU_ID,
      title: "Aura Media로 다운로드",
      contexts: ["video", "audio"],
    });
  });
}

function isHlsCandidate(candidate) {
  return candidate?.mediaType === "HLS_MASTER" || candidate?.mediaType === "HLS_MEDIA";
}



function clearDoodDirectForTab(tabId) {
  const prefix = `${tabId}:`;
  for (const key of doodDirectByFrame.keys()) {
    if (key.startsWith(prefix)) doodDirectByFrame.delete(key);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void mobileUaRulesReady.then(async () => {
    const ruleId = mobileUaRulesByTab.get(tabId);
    if (!ruleId) return;
    mobileUaRulesByTab.delete(tabId);
    mobileUaRuleIds?.release(ruleId);
    await chrome.declarativeNetRequest.updateSessionRules(buildMobileUserAgentRuleRemoval(ruleId)).catch(() => {});
  });
});

chrome.storage.local?.onChanged?.addListener?.((changes, areaName) => {
  if (areaName !== "local" || !changes?.auraLicense) return;
  void chrome.runtime.sendMessage({ type: "license-changed" }).catch(() => {});
});

async function queueMediaDownload(candidate) {
  const transferCandidate = await resolvePlayerCandidate(candidate);
  const jobId = crypto.randomUUID();
  await startCompanionMediaDownload({
    jobId,
    candidateId: transferCandidate.id,
    url: transferCandidate.resourceUrl,
    ...(transferCandidate.pageUrl ? { referrer: transferCandidate.pageUrl } : {}),
    title: transferCandidate.pageTitle || "미디어 다운로드",
    inputKind: transferCandidate.mediaType,
  });
  return { mode: "media-companion", jobId };
}

async function beginCandidateDownload(candidate) {
  if (isLikelyHlsSegmentUrl(candidate?.resourceUrl)) throw new Error("unsupported-media");
  if (candidate.mediaType === "PROGRESSIVE") {
    return queueMediaDownload(candidate);
  }
  if (isHlsCandidate(candidate)) {
    return queueMediaDownload(candidate);
  }
  if (candidate.mediaType === "DASH") return queueMediaDownload(candidate);
  throw new Error("unsupported-media");
}

function popupCandidate(candidate) {
  const projection = redactCandidateForUi(candidate);
  // Popup previews are optional and must not make unsolicited requests with a
  // short-lived token. HLS/DASH and tokenized progressive media use the
  // session-bound browser player instead.
  const previewUrl = candidate.mediaType === MEDIA_TYPES.PROGRESSIVE && !candidate.tokenized
    ? canonicalHttpUrl(candidate.resourceUrl)?.href || null
    : null;
  const sourceUrl = canonicalHttpUrl(candidate.pageUrl)?.href || null;
  return { ...projection, previewUrl, sourceUrl };
}

function playerCandidateHasQuery(candidate) {
  if (!looksLikePlayerPage(candidate?.pageUrl)) return false;
  try { return Boolean(new URL(candidate.resourceUrl).search); } catch { return false; }
}

function rerankTabCandidates(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0) return [];
  const tabCandidates = [...candidates.values()].filter((candidate) => candidate.tabId === tabId);
  return rankCandidates(tabCandidates, {
    frameStates: frameStatesByTab.get(tabId) || null,
    frameLayouts: frameLayoutsByTab.get(tabId) || null,
    now: Date.now(),
  });
}

function observeCandidate(candidate, { nonPersistent = false } = {}) {
  if (!candidate || isYouTubeDetectionCandidate(candidate)) return null;
  void applyTitleSelectors(candidate);
  const stored = upsertCandidate(candidates, candidate, LIMITS.candidates);
  if (nonPersistent || stored.tokenized || playerCandidateHasQuery(stored)) nonPersistentCandidates.add(stored);
  if (Number.isInteger(stored.tabId)) rerankTabCandidates(stored.tabId);
  persistCandidates();
  return stored;
}

// Sites whose real media title is not in `<title>` declare selectors in their
// profile. The background owns the registry, so it pushes them to the reporting
// frame once per tab and the content script re-reports with the better title.
const titleSelectorTabs = new Map();

async function applyTitleSelectors(candidate) {
  const tabId = candidate?.tabId;
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  const selectors = titleSelectorsForPage(candidate?.pageUrl, candidate?.siteUrl);
  if (!selectors.length) return;

  const signature = `${candidate.siteUrl || candidate.pageUrl || ""}|${selectors.join(",")}`;
  if (titleSelectorTabs.get(tabId) === signature) return;
  titleSelectorTabs.set(tabId, signature);

  await sendTabMessageWithTimeout(tabId, { type: "set-title-selectors", selectors }, 2_000);
}

function persistCandidates() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      const snapshot = [...candidates.values()]
        .filter((candidate) => !nonPersistentCandidates.has(candidate));
      void chrome.storage.session.set({ [SESSION_CANDIDATES_KEY]: snapshot }).catch(() => {});
    } catch {
      // Session storage can be unavailable briefly while the worker restarts.
    }
  }, 300);
}

if (chrome.storage?.session) {
  chrome.storage.session.get({ [SESSION_CANDIDATES_KEY]: [] }).then(({ [SESSION_CANDIDATES_KEY]: saved }) => {
    if (!Array.isArray(saved)) return;
    for (const item of saved) {
      if (isImageResourceUrl(item?.resourceUrl) || isYouTubeDetectionCandidate(item)) continue;
      const restored = upsertCandidate(candidates, item, LIMITS.candidates);
      if (playerCandidateHasQuery(restored)) nonPersistentCandidates.add(restored);
    }
  }).catch(() => {});
}

function observeResource(input, tabId) {
  const candidate = makeCandidate({ ...input, tabId: tabId || null });
  if (!candidate) return null;
  if (!candidate.main && isMainFrame(tabId, input.frameUrl)) candidate.main = true;
  return observeCandidate(candidate);
}

function isMainFrame(tabId, frameUrl) {
  if (!tabId || !frameUrl) return false;
  const frames = mainFramesByTab.get(tabId);
  if (!frames || frames.size === 0) return false;
  const key = normalizeOriginPath(frameUrl);
  return key ? frames.has(key) : false;
}

async function tabTitle(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0) return "";
  const cached = tabTitleCache.get(tabId);
  if (cached && Date.now() - cached.at < 15000) return cached.title;
  try {
    const tab = await chrome.tabs.get(tabId);
    const title = tab?.title || "";
    tabTitleCache.set(tabId, { title, at: Date.now() });
    return title;
  } catch {
    return "";
  }
}

function candidateContentType(candidate) {
  if (candidate?.mediaType === MEDIA_TYPES.DASH) return "application/dash+xml";
  if (candidate?.mediaType === MEDIA_TYPES.HLS_MASTER || candidate?.mediaType === MEDIA_TYPES.HLS_MEDIA) {
    return "application/vnd.apple.mpegurl";
  }
  return candidate?.mediaType === MEDIA_TYPES.PROGRESSIVE ? "video/mp4" : "";
}

async function refreshCandidateFromSourceFrame(candidate, { force = false } = {}) {
  if (!candidate || !Number.isInteger(candidate.tabId) || candidate.tabId <= 0
    || !Number.isInteger(candidate.frameId) || candidate.frameId < 0) return candidate;
  const shouldRefresh = force || candidate.tokenized
    || (Number.isFinite(candidate.refreshAfter) && candidate.refreshAfter <= Date.now())
    || Boolean(candidate.player)
    || (Array.isArray(candidate.evidence)
      && candidate.evidence.some((item) => item?.source === "player-adapter"));
  if (!shouldRefresh) return candidate;
  const response = await sendTabMessageWithTimeout(candidate.tabId, {
    type: "refresh-media-source",
    resourceUrl: candidate.resourceUrl,
    player: candidate.player || "",
    sessionId: candidate.sessionId || "",
  }, 3_000, { frameId: candidate.frameId });
  const resourceUrl = response?.ok ? canonicalHttpUrl(response.url)?.href : null;
  if (!resourceUrl) return candidate;
  const pageUrl = canonicalHttpUrl(response.frameUrl)?.href || candidate.pageUrl;
  const refreshed = makeCandidate({
    pageTitle: candidate.pageTitle,
    pageUrl,
    siteUrl: candidate.siteUrl || candidate.pageUrl,
    resourceUrl,
    contentType: candidateContentType(candidate),
    variants: candidate.variants || [],
    main: candidate.main,
    explicitMain: candidate.explicitMain,
    tabId: candidate.tabId,
    frameId: candidate.frameId,
    evidence: [
      ...(Array.isArray(candidate.evidence) ? candidate.evidence : []),
      {
        source: "refresh",
        player: response.player || candidate.player || "",
        sessionId: response.sessionId || candidate.sessionId || "",
        confidence: 100,
        at: response.observedAt || Date.now(),
      },
    ],
    player: response.player || candidate.player || "",
    sessionId: response.sessionId || candidate.sessionId || "",
    detectionSource: "refresh",
    confidence: 100,
    observedAt: response.observedAt || Date.now(),
  });
  if (!refreshed || refreshed.mediaType !== candidate.mediaType) return candidate;
  refreshed.id = candidate.id;
  for (const [key, item] of candidates) {
    if (item === candidate || item.id === candidate.id) candidates.delete(key);
  }
  return observeCandidate(refreshed, { nonPersistent: true }) || refreshed;
}

function popupSender(sender) {
  return exactExtensionPageSender(sender, "popup.html");
}

async function resolvePlayerCandidate(candidate) {
  const fresh = await refreshCandidateFromSourceFrame(candidate);
  if (!looksLikePlayerPage(fresh?.resourceUrl)) return fresh;
  const resolved = await playerGraphResolver.resolve(fresh.resourceUrl);
  if (!resolved?.url) return fresh;
  const resolvedCandidate = makeCandidate({
    pageTitle: fresh.pageTitle,
    pageUrl: resolved.referrer || fresh.pageUrl,
    siteUrl: fresh.siteUrl || fresh.pageUrl,
    resourceUrl: resolved.url,
    contentType: resolved.type === "hls" ? "application/vnd.apple.mpegurl" : "video/mp4",
    likelyAdvertisement: fresh.likelyAdvertisement,
    tabId: fresh.tabId,
    frameId: fresh.frameId,
    main: fresh.main,
    explicitMain: fresh.explicitMain,
    detectionSource: "player-page-resolver",
    confidence: 100,
    observedAt: Date.now(),
  });
  if (!resolvedCandidate) return fresh;
  resolvedCandidate.id = fresh.id;
  return resolvedCandidate;
}

function sendTabMessageWithTimeout(tabId, message, timeoutMs = 8000, options = null) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(null); }
    }, timeoutMs);
    const sent = options
      ? chrome.tabs.sendMessage(tabId, message, options)
      : chrome.tabs.sendMessage(tabId, message);
    sent.then((response) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(response || null); }
    }).catch(() => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
    });
  });
}

chrome.webRequest.onCompleted?.addListener(
  (details) => {
    mediaRequestDiagnostics.finish({
      tabId: details.tabId,
      url: details.url,
      statusCode: details.statusCode,
      resourceType: details.type,
      fromCache: details.fromCache === true,
    });
  },
  {
    urls: ["http://*/*", "https://*/*"],
    types: ["media", "xmlhttprequest", "other"],
  },
);

chrome.webRequest.onErrorOccurred?.addListener(
  (details) => {
    mediaRequestDiagnostics.finish({
      tabId: details.tabId,
      url: details.url,
      error: details.error,
      resourceType: details.type,
      fromCache: details.fromCache === true,
    });
  },
  {
    urls: ["http://*/*", "https://*/*"],
    types: ["media", "xmlhttprequest", "other"],
  },
);

chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    recordProgressiveRedirect(details);
    mediaRequestDiagnostics.redirect({
      tabId: details.tabId,
      url: details.url,
      redirectUrl: details.redirectUrl,
      statusCode: details.statusCode,
    });
  },
  {
    urls: ["http://*/*", "https://*/*"],
    types: ["media", "xmlhttprequest", "other"],
  },
);

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url) return;
  const url = canonicalHttpUrl(tab.url);
  if (!url) return;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
});

async function reinjectContentScripts() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { return; }
  const targets = tabs.filter((tab) => tab?.id).map((tab) => ({ tabId: tab.id }));
  if (!targets.length) return;
  await Promise.allSettled(targets.map((target) => chrome.scripting.executeScript({
    target,
    files: ["content.js"],
  })));
}

chrome.runtime.onInstalled.addListener(() => {
  configureDownloadMenu();
  void reinjectContentScripts();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  mainFramesByTab.delete(tabId);
  frameLayoutsByTab.delete(tabId);
  frameStatesByTab.delete(tabId);
  tabTitleCache.delete(tabId);
  clearDoodDirectForTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") {
    return;
  }
  if (changeInfo.status !== "loading" || !changeInfo.url) return;
  mainFramesByTab.delete(tabId);
  frameLayoutsByTab.delete(tabId);
  frameStatesByTab.delete(tabId);
  tabTitleCache.delete(tabId);
  clearDoodDirectForTab(tabId);
  for (const [key, item] of candidates) {
    if (item.tabId === tabId) candidates.delete(key);
  }
  persistCandidates();
});
configureDownloadMenu();

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== DOWNLOAD_MENU_ID || !info.srcUrl) return;
  const candidate = [...candidates.values()].find((item) => item.resourceUrl === info.srcUrl);
  if (isHlsCandidate(candidate)) {
    void beginCandidateDownload(candidate).catch(() => {});
    return;
  }
  if (candidate?.mediaType === "PROGRESSIVE") {
    void beginCandidateDownload(candidate).catch(() => {});
    return;
  }
  const url = canonicalHttpUrl(info.srcUrl);
  if (!url) return;
  const fallback = observeResource({
    pageTitle: "우클릭한 영상",
    pageUrl: url.href,
    resourceUrl: url.href,
    contentType: "video/mp4",
    detectionSource: "context-menu",
    confidence: 100,
  });
  if (fallback) void beginCandidateDownload(fallback).catch(() => {});
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    rememberQaRequestTrace(details, { phase: "request" });
    void tabTitle(details.tabId).then((title) => {
      observeResource({
        pageTitle: title,
        pageUrl: details.documentUrl || details.initiator || details.url,
        frameUrl: details.documentUrl || details.initiator || details.url,
        frameId: details.frameId,
        resourceUrl: details.url,
        contentType: details.type || "",
        fromMediaElement: details.type === "media" || isLikelyDoodMediaHost(details.url),
        detectionSource: "web-request",
        requestType: details.type || "other",
        confidence: details.type === "media" ? 78 : 45,
        observedAt: details.timeStamp,
      }, details.tabId);
    });
  },
  {
    urls: ["http://*/*", "https://*/*"],
    types: ["media", "xmlhttprequest", "other"],
  },
);

// Many video sites hide playlists behind tokenized proxy URLs that do not end
// in ".m3u8" (common on pages that also lock DevTools). Match the response
// Content-Type instead so the detector works without ever opening F12.
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const contentType = (details.responseHeaders || []).find((header) => header.name.toLowerCase() === "content-type")?.value || "";
    rememberQaRequestTrace(details, {
      phase: "headers",
      statusCode: Number.isInteger(details.statusCode) ? details.statusCode : null,
      contentType: contentType.slice(0, 128),
    });
    // A player iframe is HTML, not media, so makeCandidate intentionally drops
    // it. Resolve known player pages here instead of waiting for a media
    // request that providers such as Streamtape may not emit until much later.
    if (details.type === "sub_frame" && looksLikePlayerPage(details.url)) {
      void resolveObservedPlayerFrame(details);
    }
    if (!contentType) return;
    void tabTitle(details.tabId).then((title) => {
      observeResource({
        pageTitle: title,
        pageUrl: details.documentUrl || details.initiator || details.url,
        frameUrl: details.documentUrl || details.initiator || details.url,
        frameId: details.frameId,
        resourceUrl: details.url,
        contentType,
        fromMediaElement: details.type === "media" || isLikelyDoodMediaHost(details.url),
        detectionSource: "web-response",
        requestType: details.type || "other",
        confidence: /mpegurl|dash\+xml|^video\//i.test(contentType) ? 88 : 65,
        observedAt: details.timeStamp,
      }, details.tabId);
    });
  },
  { urls: ["http://*/*", "https://*/*"] },
  ["responseHeaders"],
);

chrome.webRequest.onCompleted?.addListener(
  (details) => {
    rememberQaRequestTrace(details, {
      phase: "completed",
      statusCode: Number.isInteger(details.statusCode) ? details.statusCode : null,
      fromCache: details.fromCache === true,
    });
  },
  { urls: ["http://*/*", "https://*/*"], types: ["media", "xmlhttprequest", "other"] },
);

chrome.webRequest.onErrorOccurred?.addListener(
  (details) => {
    rememberQaRequestTrace(details, {
      phase: "error",
      error: typeof details.error === "string" ? details.error.slice(0, 160) : "",
    });
  },
  { urls: ["http://*/*", "https://*/*"], types: ["media", "xmlhttprequest", "other"] },
);

function isExtensionUiSender(sender) {
  if (!sender?.tab) return true;
  const extensionRoot = chrome.runtime.getURL("");
  return sender.id === chrome.runtime.id
    && typeof sender.url === "string"
    && sender.url.startsWith(extensionRoot);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "mobile-ua-status" && isExtensionUiSender(sender)) {
    void mobileUaRulesReady.then(() => sendResponse({
      ok: true,
      enabled: Number.isInteger(message.tabId) && mobileUaRulesByTab.has(message.tabId),
    }));
    return true;
  }

  if (message?.type === "mobile-ua-toggle" && isExtensionUiSender(sender)) {
    if (!Number.isInteger(message.tabId) || message.tabId <= 0 || typeof message.enabled !== "boolean") {
      sendResponse({ ok: false, error: "invalid-mobile-ua-request" });
      return false;
    }
    setMobileUserAgentForTab(message.tabId, message.enabled).then(
      sendResponse,
      (error) => sendResponse({ ok: false, error: error?.message || "mobile-ua-failed" }),
    );
    return true;
  }

  if (message?.type === "companion-status" && isExtensionUiSender(sender)) {
    companionStatus().then(sendResponse);
    return true;
  }

  if (message?.type === "show-companion-ui" && isExtensionUiSender(sender)) {
    showCompanionUi().then(
      (response) => sendResponse({ ok: true, ...response }),
      (error) => sendResponse({
        ok: false,
        error: error?.message || "media-companion-unavailable",
        errorCode: error?.code || "media-companion-unavailable",
      }),
    );
    return true;
  }


  if (message?.type === "youtube-download" && isExtensionUiSender(sender)) {
    startYouTubeDownload(message.url, message.quality).then(
      (result) => sendResponse({ type: "download-result", ok: true, ...result }),
      (error) => sendResponse({ type: "download-result", ok: false, error: error?.message || "media-companion-unavailable" }),
    );
    return true;
  }

  if (message?.type === "qa-list-candidates" && Number.isInteger(sender.tab?.id)) {
    const tabId = sender.tab.id;
    rerankTabCandidates(tabId);
    const filtered = [...candidates.values()]
      .filter((candidate) => candidate.tabId === tabId
        && isDownloadableMediaType(candidate.mediaType)
        && !isLikelyHlsSegmentUrl(candidate.resourceUrl)
        && !isYouTubeDetectionCandidate(candidate))
      .sort((left, right) => (Number(right.score) - Number(left.score))
        || (Number(right.lastObservedAt) - Number(left.lastObservedAt)))
      .map(redactCandidateForUi);
    sendResponse({ ok: true, candidates: filtered });
    return false;
  }

  if (message?.type === "qa-list-request-trace" && Number.isInteger(sender.tab?.id)) {
    const tabId = sender.tab.id;
    const trace = [...qaRequestTraceByKey.values()]
      .filter((entry) => entry.tabId === tabId)
      .slice(-160)
      .map((entry) => ({ ...entry, phases: [...entry.phases] }));
    sendResponse({ ok: true, requests: trace });
    return false;
  }

  if (message?.type === "list-candidates" && popupSender(sender)) {
    (async () => {
      let activeTabId = Number.isInteger(message.tabId) && message.tabId > 0
        ? message.tabId
        : null;
      if (activeTabId === null) {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          activeTabId = tab?.id ?? null;
        } catch { /* popup may open before tabs API is ready */ }
      }
      if (Number.isInteger(activeTabId)) rerankTabCandidates(activeTabId);
      const all = [...candidates.values()]
        .filter((candidate) => isDownloadableMediaType(candidate.mediaType)
          && !isLikelyHlsSegmentUrl(candidate.resourceUrl)
          && !isYouTubeDetectionCandidate(candidate))
        .sort((left, right) => (Number(right.score) - Number(left.score))
          || (Number(right.lastObservedAt) - Number(left.lastObservedAt)))
        .map(popupCandidate);
      const filtered = activeTabId == null ? all : all.filter((candidate) => candidate.tabId === activeTabId);
      sendResponse({
        type: "candidates",
        renderMode: "text-only",
        candidates: filtered,
        rows: toTextOnlyRows(filtered),
      });
    })();
    return true;
  }


  if (message?.type === "download-candidate" && isExtensionUiSender(sender)) {
    const candidate = [...candidates.values()].find((item) => item.id === message.candidateId);
    if (!candidate) {
      sendResponse({
        type: "download-result",
        candidateId: message.candidateId,
        ok: false,
        error: "candidate-not-found",
      });
      return false;
    }

    Promise.resolve(beginCandidateDownload(candidate)).then(
      (result) => sendResponse({ type: "download-result", candidateId: candidate.id, ok: true, ...result }),
      (error) => sendResponse({
        type: "download-result",
        candidateId: candidate.id,
        ok: false,
        error: error?.code || candidateDownloadErrorCode(error),
        message: error?.message || "",
      }),
    );
    return true;
  }


  if (message?.type === "get-media-request-diagnostics" && popupSender(sender)) {
    const consumer = typeof message.consumer === "string" ? message.consumer : "";
    const limit = Number.isInteger(message.limit) ? message.limit : 100;
    sendResponse({ ok: true, requests: mediaRequestDiagnostics.list({ consumer, limit }) });
    return false;
  }

  if (message?.type === "clear-media-request-diagnostics" && popupSender(sender)) {
    mediaRequestDiagnostics.clear();
    sendResponse({ ok: true });
    return false;
  }


  if (message?.type === "download-url" && isExtensionUiSender(sender)) {
    const resourceUrl = canonicalHttpUrl(message.url);
    if (!resourceUrl) {
      sendResponse({ type: "download-result", candidateId: null, ok: false, error: "invalid-url" });
      return false;
    }
    (async () => {
      await ensureDirectMediaAccess([resourceUrl.href]);
      let targetUrl = resourceUrl.href;
      let pageReferrer = resourceUrl.href;
      let progressive = false;
      let hls = false;
      let dash = false;
      if (looksLikePlayerPage(targetUrl)) {
        // The pasted URL is likely a player page (playmogo /d/ or /e/, dood.to,
        // etc.). Resolve the embedded direct stream automatically.
        const resolved = await playerGraphResolver.resolve(targetUrl);
        if (resolved?.url) {
          targetUrl = resolved.url;
          if (resolved.type === "hls") hls = true;
          else progressive = true;
          pageReferrer = resolved.referrer || pageReferrer;
        } else {
          sendResponse({
            type: "download-result",
            candidateId: null,
            ok: false,
            error: "player-page-unresolved",
          });
          return;
        }
      } else {
        const initialType = mediaTypeForResource(resourceUrl.href);
        progressive = initialType === MEDIA_TYPES.PROGRESSIVE;
        hls = initialType === MEDIA_TYPES.HLS_MASTER || initialType === MEDIA_TYPES.HLS_MEDIA;
        dash = initialType === MEDIA_TYPES.DASH;
        if (!progressive && !hls && !dash) {
          progressive = /\.(?:mp4|webm|m4v|mp3|m4a)(?:$|[?#])/i.test(targetUrl)
            || /getfile|download|stream/i.test(targetUrl);
        }
      }
      const canonicalTarget = canonicalHttpUrl(targetUrl);
      if (!canonicalTarget) {
        sendResponse({ type: "download-result", candidateId: null, ok: false, error: "invalid-url" });
        return;
      }
      await ensureDirectMediaAccess([resourceUrl.href, pageReferrer, canonicalTarget.href]);
      const candidate = observeResource({
        pageTitle: "직접 입력한 주소",
        pageUrl: pageReferrer,
        resourceUrl: canonicalTarget.href,
        contentType: progressive ? "video/mp4"
          : dash ? "application/dash+xml" : "application/vnd.apple.mpegurl",
      });
      if (!candidate) {
        sendResponse({ type: "download-result", candidateId: null, ok: false, error: "invalid-url" });
        return;
      }
      Promise.resolve(beginCandidateDownload(candidate)).then(
        (result) => sendResponse({ type: "download-result", candidateId: candidate.id, ok: true, ...result }),
        (error) => sendResponse({
          type: "download-result",
          candidateId: candidate.id,
          ok: false,
          error: error?.code || "unsupported-media",
          message: error?.message || "",
        }),
      );
    })().catch((error) => {
      sendResponse({
        type: "download-result",
        candidateId: null,
        ok: false,
        error: error?.code || "route-preparation-failed",
      });
    });
    return true;
  }

  if (message?.type === "clear-tab" && isExtensionUiSender(sender) && Number.isInteger(message.tabId)) {
    for (const [key, item] of candidates) {
      if (item.tabId === message.tabId) candidates.delete(key);
    }
    mainFramesByTab.delete(message.tabId);
    frameLayoutsByTab.delete(message.tabId);
    frameStatesByTab.delete(message.tabId);
    persistCandidates();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "frame-media-state" && sender.tab?.id
    && Number.isInteger(sender.frameId) && sender.frameId >= 0) {
    const visibleArea = Number(message.visibleArea);
    const viewportRatio = Number(message.viewportRatio);
    const durationMs = Number(message.durationMs);
    const state = Object.freeze({
      playing: message.playing === true,
      muted: message.muted === true,
      visibleArea: Number.isFinite(visibleArea) ? Math.max(0, Math.min(100_000_000, visibleArea)) : 0,
      viewportRatio: Number.isFinite(viewportRatio) ? Math.max(0, Math.min(1, viewportRatio)) : 0,
      durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.min(24 * 60 * 60 * 1000, durationMs)) : 0,
      topFrame: message.topFrame === true || sender.frameId === 0,
      hasBlobSource: message.hasBlobSource === true,
      observedAt: Number.isFinite(message.observedAt) ? message.observedAt : Date.now(),
    });
    if (!frameStatesByTab.has(sender.tab.id)) frameStatesByTab.set(sender.tab.id, new Map());
    frameStatesByTab.get(sender.tab.id).set(sender.frameId, state);
    rerankTabCandidates(sender.tab.id);
    persistCandidates();
    return false;
  }

  if (message?.type === "main-frame" && sender.tab?.id && Array.isArray(message.urls)) {
    if (!mainFramesByTab.has(sender.tab.id)) mainFramesByTab.set(sender.tab.id, new Set());
    const frames = mainFramesByTab.get(sender.tab.id);
    frames.clear();
    for (const url of message.urls) {
      const key = normalizeOriginPath(url);
      if (key) frames.add(key);
    }
    const layouts = new Map();
    for (const frame of Array.isArray(message.frames) ? message.frames.slice(0, 64) : []) {
      const key = normalizeOriginPath(frame?.src);
      if (!key) continue;
      const visibleArea = Number(frame.area);
      const viewportRatio = Number(frame.viewportRatio);
      layouts.set(key, Object.freeze({
        visibleArea: Number.isFinite(visibleArea) ? Math.max(0, Math.min(100_000_000, visibleArea)) : 0,
        viewportRatio: Number.isFinite(viewportRatio) ? Math.max(0, Math.min(1, viewportRatio)) : 0,
        adHint: frame.adHint === true,
        order: Number.isInteger(frame.order) ? Math.max(0, frame.order) : 0,
      }));
    }
    frameLayoutsByTab.set(sender.tab.id, layouts);
    rerankTabCandidates(sender.tab.id);
    persistCandidates();
    return false;
  }

  if (message?.type === "dood-direct" && sender.tab?.id && typeof message.url === "string") {
    const directUrl = canonicalHttpUrl(message.url)?.href;
    const frameUrl = typeof message.frameUrl === "string" ? canonicalHttpUrl(message.frameUrl)?.href : "";
    if (!directUrl) return false;
    const frameId = Number.isInteger(sender.frameId) && sender.frameId >= 0 ? sender.frameId : 0;
    doodDirectByFrame.set(`${sender.tab.id}:${frameId}`, {
      url: directUrl,
      frameUrl: frameUrl || "",
      frameId,
      at: Date.now(),
    });
    return false;
  }


  if (!sender.tab?.url || sender.id !== chrome.runtime.id) return false;
  const sanitized = sanitizePageMessage({
    ...message,
    // A player iframe has its own unrelated `<title>`, so prefer the tab's
    // title for a candidate reported from inside one. Without this the job is
    // named after the player instead of the video.
    pageTitle: isPlayerFrameUrl(sender.url)
      ? sender.tab.title || message.pageTitle || ""
      : message.pageTitle || sender.tab.title || "",
    siteUrl: canonicalHttpUrl(sender.tab.url)?.href || "",
    pageUrl: canonicalHttpUrl(sender.url)?.href
      || (typeof message.frameUrl === "string" ? canonicalHttpUrl(message.frameUrl)?.href : null)
      || canonicalHttpUrl(sender.tab.url)?.href
      || "",
  });
  if (sanitized) sanitized.tabId = sender.tab.id;
  if (sanitized && Number.isInteger(sender.frameId) && sender.frameId >= 0) {
    sanitized.frameId = sender.frameId;
    sanitized.refreshable = true;
  }
  if (sanitized && isMainFrame(sender.tab.id, sender.url)) sanitized.main = true;
  observeCandidate(sanitized);
  return false;
});
