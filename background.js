import {
  LIMITS,
  MEDIA_TYPES,
  canonicalHttpUrl,
  isDownloadableMediaType,
  isLikelyHlsSegmentUrl,
  makeCandidate,
  mediaTypeForResource,
  normalizeOriginPath,
  redactCandidateForUi,
  sanitizePageMessage,
  toTextOnlyRows,
} from "./candidate.js";
import { createCandidateRepository } from "./background-candidate-repository.js";
import { createCompanionHandoff, isYouTubeDetectionCandidate } from "./background-companion-handoff.js";
import { createDownloadRouter } from "./background-download-router.js";
import { createPlayerResolutionCoordinator } from "./background-player-resolution.js";
import { createProgressiveRedirectStore, createQaRequestTraceStore } from "./background-request-evidence.js";
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
  looksLikePlayerPage,
} from "./player-page-resolver.js";
import {
  companionStatus,
  showCompanionUi,
} from "./companion-client.js";
import { createMediaRequestDiagnosticStore } from "./media-request-context.js";
import { isPlayerFrameUrl, titleSelectorsForPage } from "./sites/registry.js";

const mediaRequestDiagnostics = createMediaRequestDiagnosticStore();
const qaRequestTrace = createQaRequestTraceStore();
const progressiveRedirects = createProgressiveRedirectStore();
const doodDirectByFrame = new Map();
const DOOD_DIRECT_CACHE_TTL_MS = 60_000;
const tabTitleCache = new Map();
const MOBILE_USER_AGENT = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
const mobileUaRulesByTab = new Map();
let mobileUaRuleIds = null;

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

// Sites whose real media title is not in `<title>` declare selectors in their
// profile. The background owns the registry, so it pushes them to the reporting
// frame once per tab and the content script re-reports with the better title.
const titleSelectorTabs = new Map();
const resolvedTitleByTab = new Map();

function validResolvedPageTitle(value) {
  const title = typeof value === "string" ? value.trim() : "";
  return title && [...title].length <= LIMITS.titleCharacters
    && !/[\u0000-\u001f\u007f]/.test(title)
    ? title
    : "";
}

function applyResolvedTitleToTab(tabId, pageTitle) {
  const title = validResolvedPageTitle(pageTitle);
  if (!title) return;
  resolvedTitleByTab.set(tabId, title);
  for (const candidate of candidates.values()) {
    if (candidate.tabId === tabId && titleSelectorsForPage(candidate.pageUrl, candidate.siteUrl).length) {
      candidate.pageTitle = title;
    }
  }
  rerankTabCandidates(tabId);
  persistCandidates();
}

async function applyTitleSelectors(candidate) {
  const tabId = candidate?.tabId;
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  const selectors = titleSelectorsForPage(candidate?.pageUrl, candidate?.siteUrl);
  if (!selectors.length) return;

  const cachedTitle = resolvedTitleByTab.get(tabId);
  if (cachedTitle) candidate.pageTitle = cachedTitle;

  const signature = `${candidate.siteUrl || candidate.pageUrl || ""}|${selectors.join(",")}`;
  if (titleSelectorTabs.get(tabId) === signature) return;
  titleSelectorTabs.set(tabId, signature);

  const response = await sendTabMessageWithTimeout(
    tabId,
    { type: "set-title-selectors", selectors },
    2_000,
    { frameId: 0 },
  );
  applyResolvedTitleToTab(tabId, response?.pageTitle);
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

function popupSender(sender) {
  return exactExtensionPageSender(sender, "popup.html");
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

const candidateRepository = createCandidateRepository({
  storageSession: chrome.storage?.session,
  ignoreCandidate: isYouTubeDetectionCandidate,
  onCandidate: applyTitleSelectors,
});
const {
  candidates,
  mainFramesByTab,
  frameLayoutsByTab,
  frameStatesByTab,
  isMainFrame,
  observeCandidate,
  observeResource,
  rerankTabCandidates,
  persistCandidates,
} = candidateRepository;
void candidateRepository.restore();

const playerResolution = createPlayerResolutionCoordinator({
  ensureRoute: ensureDirectMediaAccess,
  getRedirectTarget: (url) => progressiveRedirects.get(url),
  tabTitle,
  observeResource,
  replaceCandidate: candidateRepository.replaceCandidate,
  sendTabMessage: sendTabMessageWithTimeout,
});
const {
  resolver: playerGraphResolver,
  resolveObservedPlayerFrame,
  refreshCandidateFromSourceFrame,
  resolvePlayerCandidate,
} = playerResolution;
const {
  beginCandidateDownload,
  startYouTubeDownload,
} = createCompanionHandoff({ resolveCandidate: resolvePlayerCandidate });
const downloadRouter = createDownloadRouter({
  candidates,
  ensureDirectMediaAccess,
  playerGraphResolver,
  observeResource,
  beginCandidateDownload,
});

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
    progressiveRedirects.record(details);
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
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content-extraction.js", "content.js"],
  });
});

async function reinjectContentScripts() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { return; }
  const targets = tabs.filter((tab) => tab?.id).map((tab) => ({ tabId: tab.id }));
  if (!targets.length) return;
  await Promise.allSettled(targets.map((target) => chrome.scripting.executeScript({
    target,
    files: ["content-extraction.js", "content.js"],
  })));
}

chrome.runtime.onInstalled.addListener(() => {
  configureDownloadMenu();
  void reinjectContentScripts();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  candidateRepository.clearTab(tabId);
  tabTitleCache.delete(tabId);
  titleSelectorTabs.delete(tabId);
  resolvedTitleByTab.delete(tabId);
  clearDoodDirectForTab(tabId);
  qaRequestTrace.clearTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") {
    return;
  }
  if (changeInfo.status !== "loading" || !changeInfo.url) return;
  candidateRepository.clearTab(tabId);
  tabTitleCache.delete(tabId);
  titleSelectorTabs.delete(tabId);
  resolvedTitleByTab.delete(tabId);
  clearDoodDirectForTab(tabId);
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
    qaRequestTrace.remember(details, { phase: "request" });
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
    qaRequestTrace.remember(details, {
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
    qaRequestTrace.remember(details, {
      phase: "completed",
      statusCode: Number.isInteger(details.statusCode) ? details.statusCode : null,
      fromCache: details.fromCache === true,
    });
  },
  { urls: ["http://*/*", "https://*/*"], types: ["media", "xmlhttprequest", "other"] },
);

chrome.webRequest.onErrorOccurred?.addListener(
  (details) => {
    qaRequestTrace.remember(details, {
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
    const trace = qaRequestTrace.listForTab(tabId);
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
    Promise.resolve(downloadRouter.downloadCandidate(message.candidateId)).then(
      ({ candidate, result }) => sendResponse({ type: "download-result", candidateId: candidate.id, ok: true, ...result }),
      (error) => sendResponse({
        type: "download-result",
        candidateId: error?.candidateId || message.candidateId,
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
    Promise.resolve(downloadRouter.downloadUrl(message.url)).then(
      ({ candidate, result }) => sendResponse({ type: "download-result", candidateId: candidate.id, ok: true, ...result }),
      (error) => sendResponse({
        type: "download-result",
        candidateId: null,
        ok: false,
        error: error?.code || "route-preparation-failed",
        message: error?.message || "",
      }),
    );
    return true;
  }

  if (message?.type === "clear-tab" && isExtensionUiSender(sender) && Number.isInteger(message.tabId)) {
    candidateRepository.clearTab(message.tabId);
    titleSelectorTabs.delete(message.tabId);
    resolvedTitleByTab.delete(message.tabId);
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
