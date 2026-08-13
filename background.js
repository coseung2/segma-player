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
  redactCandidateForUi,
  sanitizePageMessage,
  toTextOnlyRows,
  upsertCandidate,
} from "./candidate.js";
import { DOWNLOAD_MENU_ID } from "./download.js";
import { candidateDownloadErrorCode } from "./download-errors.js";
import {
  createDownloadJob,
  persistedDownloadJobs,
  publicDownloadJobs,
  retryPayloadForJob,
  updateDownloadJob,
} from "./download-jobs.js";
import { normalizeLevel5KeyError } from "./level5-key-error.js";
import { PRODUCT_EDITION } from "./edition.js";
import {
  activateLicense,
  getStoredLicense,
  refreshLicense,
  resolveEdition,
  resolvePlan,
} from "./license.js";
import {
  canonicalMediaFetchReferrer,
  canonicalMediaFetchUrl,
  createMediaFetchLeaseRegistry,
  createMediaFetchRuleIdAllocator,
  exactMediaFetchRule,
  MEDIA_FETCH_RULE_ID_START,
  OFFSCREEN_DOCUMENT_TAB_ID,
} from "./media-fetch-lease.js";
import { createPlayerGraphResolver, looksLikePlayerPage } from "./player-page-resolver.js";
import { youtubeQualityAllowed } from "./product-plan.js";
import {
  getYouTubeServerUrl,
  submitYouTubeJob,
  waitForYouTubeJob,
  youtubeJobFileUrl,
} from "./youtube-server.js";
import {
  authenticatedRecoveryForProgressiveError,
  createProgressiveRedirectResolver,
  progressiveDownloadErrorMessage,
  replayableRecordedHeaders,
} from "./progressive-redirect.js";

const candidates = new Map();
const RECORDED_HEADER_LIMIT = 1000;
const PROGRESSIVE_REDIRECT_TARGET_LIMIT = 1000;
const PROGRESSIVE_REDIRECT_TARGET_TTL_MS = 60_000;
const recordedHeaders = new Map();
const progressiveRedirectTargets = new Map();
const mainFramesByTab = new Map();
const doodDirectByTab = new Map();
const nonPersistentCandidates = new WeakSet();
const SESSION_CANDIDATES_KEY = "candidates";
const tabTitleCache = new Map();
const DOWNLOAD_JOBS_KEY = "downloadJobs";
const MEDIA_COMPANION_NATIVE_HOST = "com.aura.media_companion";
const downloadJobs = new Map();
const youtubePorts = new Map();
let offscreenCreatePromise = null;
let persistTimer = null;
const DOOD_MEDIA_HOST_RE = /(?:doodcdn|doimg|d000d|dood\.|playmogo|cloudatacdn)\./i;
const MEDIA_FETCH_LEASE_TTL_MS = 10 * 60 * 1000;
const MEDIA_FETCH_STALE_SWEEP_LIMIT = 16;
const mediaFetchRuleIds = createMediaFetchRuleIdAllocator();
const mediaFetchLeases = createMediaFetchLeaseRegistry({
  staleAfterMs: MEDIA_FETCH_LEASE_TTL_MS,
});
async function ensureDirectMediaAccess(values) {
  const hosts = [...new Set((Array.isArray(values) ? values : [])
    .map((value) => canonicalHttpUrl(value)?.hostname)
    .filter(Boolean))];
  return { ok: true, hosts };
}

const progressiveRedirectResolver = createProgressiveRedirectResolver({
  ensureRoutes: ensureDirectMediaAccess,
  getRedirectTarget: (url) => progressiveRedirectTargetFor(url),
  getRequestHeaders: (url) => {
    const recorded = recordedHeaders.get(canonicalMediaFetchUrl(url));
    return replayableRecordedHeaders(recorded);
  },
});

// Shared, bounded player-graph resolver for every player-page resolution
// path. Caches are keyed by canonical URL with short TTLs; the factory's only
// clear() aborts every in-flight traversal, so tab navigation never calls it
// globally (one tab would cancel another tab's active resolution). Positive
// and negative TTLs self-expire stale entries instead.
const playerGraphResolver = createPlayerGraphResolver({
  ensureRoute: ensureDirectMediaAccess,
  getRedirectTarget: (url) => progressiveRedirectTargetFor(url),
});

const downloadJobsReady = chrome.storage.session.get({ [DOWNLOAD_JOBS_KEY]: [] }).then((stored) => {
  for (const job of stored[DOWNLOAD_JOBS_KEY] || []) {
    if (job && typeof job.id === "string") downloadJobs.set(job.id, job);
  }
}).catch(() => {});

async function persistDownloadJobs() {
  await chrome.storage.session.set({ [DOWNLOAD_JOBS_KEY]: persistedDownloadJobs(downloadJobs.values()) });
}

async function patchDownloadJob(jobId, patch) {
  await downloadJobsReady;
  const current = downloadJobs.get(jobId);
  if (!current) return null;
  const next = updateDownloadJob(current, patch);
  downloadJobs.set(jobId, next);
  await persistDownloadJobs().catch(() => {});
  void chrome.runtime.sendMessage({ type: "download-jobs-changed" }).catch(() => {});
  return next;
}

function canonicalYouTubeUrl(value) {
  const url = canonicalHttpUrl(value);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")) return url.href;
  return null;
}

const YOUTUBE_QUALITIES = new Set(["best", "2160", "1440", "1080", "720", "480"]);

async function startYouTubeDownload(rawUrl, rawQuality = "best") {
  const url = canonicalYouTubeUrl(rawUrl);
  if (!url) throw new Error("invalid-youtube-url");
  const quality = String(rawQuality || "best");
  if (!YOUTUBE_QUALITIES.has(quality)) throw new Error("invalid-youtube-quality");
  const plan = await resolvePlan();
  if (!youtubeQualityAllowed(plan, quality)) {
    throw new Error("pro-feature-required");
  }

  const serverUrl = await getYouTubeServerUrl();
  if (serverUrl) {
    const submitted = await submitYouTubeJob(url, quality, serverUrl);
    if (submitted.ok) {
      const waited = await waitForYouTubeJob(submitted.jobId, serverUrl);
      if (waited.ok) {
        const fileUrl = youtubeJobFileUrl(submitted.jobId, serverUrl);
        const candidate = observeResource({
          pageTitle: waited.title || "YouTube 영상",
          pageUrl: url,
          resourceUrl: fileUrl,
          contentType: "video/mp4",
        });
        if (!candidate) throw new Error("unsupported-media");
        const result = await beginCandidateDownload(candidate);
        return { mode: "youtube-server", jobId: result.jobId };
      }
      const detail = typeof waited.error === "string" && waited.error ? waited.error : "job-failed";
      throw new Error(`Aura YouTube 서버 처리 실패 (${detail.slice(0, 300)})`);
    }
    if (submitted.error === "monthly-limit-reached") {
      const limit = Number.isInteger(submitted.limit) ? ` (${submitted.limit}개)` : "";
      throw new Error(`이번 달 Aura YouTube 무료 다운로드 한도를 사용했습니다${limit}. Pro 라이선스를 등록하면 제한이 풀립니다.`);
    }
    // Unreachable or transient server errors fall through to the Companion path.
  }

  await downloadJobsReady;
  const jobId = crypto.randomUUID();
  downloadJobs.set(jobId, createDownloadJob({
    id: jobId,
    title: "YouTube 영상",
    mediaType: "YOUTUBE",
    source: "youtube",
    folderName: "Downloads",
    retryPayload: { kind: "youtube", url, quality },
  }));
  await persistDownloadJobs();

  let port;
  try {
    port = chrome.runtime.connectNative(MEDIA_COMPANION_NATIVE_HOST);
  } catch {
    throw new Error("Aura Media Companion을 실행하지 못했습니다. 노트북 서버 또는 컴패니언 연결을 확인해 주세요.");
  }
  youtubePorts.set(jobId, port);
  let finished = false;
  port.onMessage.addListener((message) => {
    if (message?.jobId !== jobId) return;
    if (typeof message.title === "string" && message.title) {
      const current = downloadJobs.get(jobId);
      if (current) downloadJobs.set(jobId, Object.freeze({ ...current, title: message.title.slice(0, 500) }));
    }
    const status = ["running", "completed", "failed"].includes(message.status) ? message.status : "running";
    if (status === "completed" || status === "failed") {
      finished = true;
      queueMicrotask(() => {
        try { port.disconnect(); } catch { /* already disconnected */ }
      });
    }
    void patchDownloadJob(jobId, {
      status,
      statusText: typeof message.statusText === "string" ? message.statusText : "YouTube 다운로드 중…",
      error: typeof message.error === "string" ? message.error : "",
      folderName: "Downloads",
    });
  });
  port.onDisconnect.addListener(() => {
    youtubePorts.delete(jobId);
    const detail = chrome.runtime.lastError?.message || "media-companion-disconnected";
    if (!finished) void patchDownloadJob(jobId, {
      status: "failed",
      statusText: "Aura Media Companion을 실행하지 못했습니다.",
      error: detail,
    });
  });
  port.postMessage({ type: "youtube-download", jobId, url, quality });
  return { mode: "youtube", jobId };
}

function progressiveRedirectTargetFor(value) {
  const url = canonicalMediaFetchUrl(value);
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
  const from = canonicalMediaFetchUrl(details?.url);
  const to = canonicalMediaFetchUrl(details?.redirectUrl);
  if (!from || !to || from === to) return;
  progressiveRedirectTargets.delete(from);
  progressiveRedirectTargets.set(from, { url: to, at: Date.now() });
  while (progressiveRedirectTargets.size > PROGRESSIVE_REDIRECT_TARGET_LIMIT) {
    progressiveRedirectTargets.delete(progressiveRedirectTargets.keys().next().value);
  }
}
const mediaFetchRulesReady = chrome.declarativeNetRequest.getSessionRules().then(async (rules) => {
  const removeRuleIds = rules
    .map((rule) => rule.id)
    .filter((ruleId) => Number.isInteger(ruleId) && ruleId >= MEDIA_FETCH_RULE_ID_START);
  if (removeRuleIds.length) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules: [] });
  }
}).catch(() => {});

function isLikelyDoodMediaHost(url) {
  try {
    return DOOD_MEDIA_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function recordedHeadersForUrl(url) {
  const recorded = recordedHeaders.get(canonicalMediaFetchUrl(url));
  if (!recorded) return [];
  return Object.entries(replayableRecordedHeaders(recorded))
    .filter(([, value]) => value.length <= 2048)
    .map(([header, value]) => ({ header, operation: "set", value }));
}

function mediaFetchSenderTabId(sender) {
  if (sender?.id !== chrome.runtime.id) return null;
  if (sender.url === chrome.runtime.getURL("download-worker.html")) return OFFSCREEN_DOCUMENT_TAB_ID;
  return null;
}

function validMediaFetchSender(sender) {
  return mediaFetchSenderTabId(sender) !== null;
}

function validMediaRouteSender(sender) {
  return mediaFetchSenderTabId(sender) !== null;
}

async function removeMediaFetchLease(lease) {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [lease.ruleId],
      addRules: [],
    });
  } catch {
    return false;
  }
  mediaFetchLeases.remove(lease.leaseId);
  mediaFetchRuleIds.release(lease.ruleId);
  return true;
}

async function cleanupStaleMediaFetchLeases() {
  const stale = mediaFetchLeases.stale(Date.now(), MEDIA_FETCH_STALE_SWEEP_LIMIT);
  for (const lease of stale) {
    if (!await removeMediaFetchLease(lease)) {
      console.warn("Aura media fetch lease cleanup failed");
    }
  }
}

async function prepareMediaFetchLease(sender, rawUrl, rawReferrer) {
  if (!validMediaFetchSender(sender)) return { ok: false, error: "unauthorized" };
  const senderTabId = mediaFetchSenderTabId(sender);
  const url = canonicalMediaFetchUrl(rawUrl);
  if (!url) return { ok: false, error: "invalid-url" };
  let referrer = "";
  if (rawReferrer !== undefined && rawReferrer !== "") {
    if (typeof rawReferrer !== "string") return { ok: false, error: "invalid-referrer" };
    referrer = canonicalMediaFetchReferrer(rawReferrer) || "";
    if (!referrer) return { ok: false, error: "invalid-referrer" };
  } else {
    const recorded = recordedHeaders.get(url);
    referrer = canonicalMediaFetchReferrer(recorded?.referer || recorded?.referrer) || "";
  }

  await mediaFetchRulesReady;
  await cleanupStaleMediaFetchLeases();
  let ruleId;
  try {
    ruleId = mediaFetchRuleIds.allocate();
  } catch {
    return { ok: false, error: "media-fetch-unavailable" };
  }
  let rule;
  try {
    rule = exactMediaFetchRule({
      ruleId,
      tabId: senderTabId,
      url,
      referrer,
      requestHeaders: recordedHeadersForUrl(url),
    });
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [],
      addRules: [rule],
    });
  } catch {
    mediaFetchRuleIds.release(ruleId);
    return { ok: false, error: "media-fetch-rule-failed" };
  }

  let lease;
  try {
    lease = mediaFetchLeases.create({
      tabId: senderTabId,
      url,
      referrer,
      ruleId,
    });
  } catch {
    await removeMediaFetchLease({ leaseId: "", ruleId });
    return { ok: false, error: "media-fetch-unavailable" };
  }
  return { ok: true, leaseId: lease.leaseId };
}

async function releaseMediaFetchLeaseForSender(sender, leaseId) {
  if (!validMediaFetchSender(sender)) return { ok: false, error: "unauthorized" };
  if (typeof leaseId !== "string" || leaseId.length === 0) {
    return { ok: false, error: "invalid-lease" };
  }
  const lease = mediaFetchLeases.get(leaseId);
  if (!lease || lease.tabId !== mediaFetchSenderTabId(sender)) return { ok: false, error: "lease-not-found" };
  if (!await removeMediaFetchLease(lease)) return { ok: false, error: "media-fetch-release-failed" };
  return { ok: true };
}

function touchMediaFetchLeaseForSender(sender, leaseId) {
  if (!validMediaFetchSender(sender)) return { ok: false, error: "unauthorized" };
  if (typeof leaseId !== "string" || leaseId.length === 0) {
    return { ok: false, error: "invalid-lease" };
  }
  const lease = mediaFetchLeases.get(leaseId);
  if (!lease || lease.tabId !== mediaFetchSenderTabId(sender)) return { ok: false, error: "lease-not-found" };
  mediaFetchLeases.touch(leaseId);
  return { ok: true };
}

async function releaseMediaFetchLeasesForTab(tabId) {
  for (const lease of mediaFetchLeases.forTab(tabId)) {
    if (!await removeMediaFetchLease(lease)) {
      console.warn("Aura media fetch tab cleanup failed");
    }
  }
}

setInterval(() => {
  void cleanupStaleMediaFetchLeases();
}, 60_000);

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

async function ensureDownloadWorker() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenCreatePromise) {
    offscreenCreatePromise = chrome.offscreen.createDocument({
      url: "download-worker.html",
      reasons: ["BLOBS"],
      justification: "Download detected media into the user-selected folder without opening a browser tab.",
    }).finally(() => { offscreenCreatePromise = null; });
  }
  await offscreenCreatePromise;
}

async function dispatchMediaDownload(jobId, candidate) {
  try {
    await ensureDownloadWorker();
    const accepted = await chrome.runtime.sendMessage({ type: "run-download-job", jobId, candidate });
    if (!accepted?.ok) throw new Error(accepted?.error || "worker-unavailable");
  } catch (error) {
    await patchDownloadJob(jobId, {
      status: "failed",
      statusText: "다운로드 작업을 시작하지 못했습니다.",
      error: error?.message || "worker-unavailable",
    });
    jobSourceTabs.delete(jobId);
  }
}

// Tab-focus pausing is owned by the background service worker because the
// offscreen document cannot access chrome.tabs / chrome.windows. The worker
// only receives pause-state messages over chrome.runtime.
const jobSourceTabs = new Map();

function sendPauseState(jobId, paused, sourceClosed = false) {
  void chrome.runtime.sendMessage({ type: "download-pause-state", jobId, paused, sourceClosed })
    .catch(() => {});
}

async function applyTabPauseState(activeTabId) {
  const plan = await resolvePlan();
  if (plan.backgroundDownloads) {
    for (const jobId of jobSourceTabs.keys()) sendPauseState(jobId, false);
    return;
  }
  for (const [jobId, sourceTabId] of jobSourceTabs) {
    sendPauseState(jobId, Number.isInteger(sourceTabId) && sourceTabId !== activeTabId);
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => void applyTabPauseState(tabId));
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    for (const jobId of jobSourceTabs.keys()) sendPauseState(jobId, true);
    return;
  }
  void chrome.tabs.query({ active: true, windowId })
    .then((tabs) => applyTabPauseState(tabs[0]?.id))
    .catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [jobId, sourceTabId] of jobSourceTabs) {
    if (sourceTabId === tabId) {
      jobSourceTabs.delete(jobId);
      sendPauseState(jobId, true, true);
    }
  }
});

function reapplyPauseState() {
  void chrome.tabs.query({ active: true, currentWindow: true })
    .then((tabs) => applyTabPauseState(tabs[0]?.id))
    .catch(() => {});
}

chrome.storage.local?.onChanged?.addListener?.((changes, areaName) => {
  if (areaName !== "local" || !changes?.auraLicense) return;
  void chrome.runtime.sendMessage({ type: "license-changed" }).catch(() => {});
  reapplyPauseState();
});

async function queueMediaDownload(candidate) {
  await downloadJobsReady;
  const plan = await resolvePlan();
  const jobId = crypto.randomUUID();
  const mode = candidate.mediaType === "PROGRESSIVE" ? "stream" : "hls";
  const job = createDownloadJob({
    id: jobId,
    title: candidate.pageTitle || "미디어 다운로드",
    mediaType: candidate.mediaType,
    retryPayload: { kind: "media", candidate: structuredClone(candidate) },
  });
  downloadJobs.set(jobId, job);
  if (!plan.backgroundDownloads && Number.isInteger(candidate?.tabId) && candidate.tabId > 0) {
    jobSourceTabs.set(jobId, candidate.tabId);
  }
  await persistDownloadJobs();
  void dispatchMediaDownload(jobId, candidate);
  return { mode, jobId };
}

async function beginCandidateDownload(candidate) {
  if (isLikelyHlsSegmentUrl(candidate?.resourceUrl)) throw new Error("unsupported-media");
  if (candidate.mediaType === "PROGRESSIVE") {
    return queueMediaDownload(candidate);
  }
  if (isHlsCandidate(candidate)) {
    return queueMediaDownload(candidate);
  }
  throw new Error("unsupported-media");
}

async function retryDownloadJob(jobId) {
  await downloadJobsReady;
  const job = downloadJobs.get(jobId);
  if (!job) throw new Error("download-job-not-found");
  const payload = retryPayloadForJob(job);
  if (!payload) throw new Error("download-job-not-retryable");
  if (payload.kind === "media" && payload.candidate) return beginCandidateDownload(payload.candidate);
  if (payload.kind === "youtube") return startYouTubeDownload(payload.url, payload.quality);
  throw new Error("download-job-not-retryable");
}

async function sniffMediaContentType(url) {
  await ensureDirectMediaAccess([url]);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      credentials: "include",
      redirect: "follow",
    });
    if (!response.ok && response.status !== 206) return "";
    const header = response.headers?.get?.("content-type") || "";
    await response.body?.cancel?.().catch(() => {});
    return header;
  } catch {
    return "";
  }
}

function popupCandidate(candidate) {
  const projection = redactCandidateForUi(candidate);
  const previewUrl = canonicalHttpUrl(candidate.resourceUrl)?.href || null;
  return { ...projection, previewUrl };
}

function playerCandidateHasQuery(candidate) {
  if (!looksLikePlayerPage(candidate?.pageUrl)) return false;
  try { return Boolean(new URL(candidate.resourceUrl).search); } catch { return false; }
}

function observeCandidate(candidate, { nonPersistent = false } = {}) {
  if (!candidate) return null;
  const stored = upsertCandidate(candidates, candidate, LIMITS.candidates);
  if (nonPersistent || playerCandidateHasQuery(stored)) nonPersistentCandidates.add(stored);
  persistCandidates();
  return stored;
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
      if (isImageResourceUrl(item?.resourceUrl)) continue;
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

function usableRequestHeader(name, value) {
  const lower = String(name || "").toLowerCase();
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
  return ["referer", "referrer", "accept-language"].includes(lower);
}

function recordRequestHeaders(details) {
  const normalizedUrl = canonicalMediaFetchUrl(details.url);
  if (!normalizedUrl) return;
  const headers = {};
  for (const header of details.requestHeaders || []) {
    if (usableRequestHeader(header.name, header.value)) headers[header.name.toLowerCase()] = String(header.value).slice(0, 2048);
  }
  if (!Object.keys(headers).length) return;
  recordedHeaders.set(normalizedUrl, headers);
  while (recordedHeaders.size > RECORDED_HEADER_LIMIT) {
    recordedHeaders.delete(recordedHeaders.keys().next().value);
  }
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

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    recordRequestHeaders(details);
  },
  { urls: ["http://*/*", "https://*/*"] },
  ["requestHeaders"],
);

chrome.webRequest.onBeforeRedirect.addListener(
  recordProgressiveRedirect,
  { urls: ["http://*/*", "https://*/*"] },
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
  tabTitleCache.delete(tabId);
  doodDirectByTab.delete(tabId);
  void releaseMediaFetchLeasesForTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading" || !changeInfo.url) return;
  mainFramesByTab.delete(tabId);
  tabTitleCache.delete(tabId);
  doodDirectByTab.delete(tabId);
  void releaseMediaFetchLeasesForTab(tabId);
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
  });
  if (fallback) void beginCandidateDownload(fallback).catch(() => {});
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    void tabTitle(details.tabId).then((title) => {
      observeResource({
        pageTitle: title,
        pageUrl: details.documentUrl || details.initiator || details.url,
        frameUrl: details.documentUrl || details.initiator || details.url,
        frameId: details.frameId,
        resourceUrl: details.url,
        contentType: details.type || "",
        fromMediaElement: details.type === "media" || isLikelyDoodMediaHost(details.url),
      }, details.tabId);
    });
  },
  { urls: ["http://*/*", "https://*/*"] },
);

// Many video sites hide playlists behind tokenized proxy URLs that do not end
// in ".m3u8" (common on pages that also lock DevTools). Match the response
// Content-Type instead so the detector works without ever opening F12.
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const contentType = (details.responseHeaders || []).find((header) => header.name.toLowerCase() === "content-type")?.value || "";
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
      }, details.tabId);
    });
  },
  { urls: ["http://*/*", "https://*/*"] },
  ["responseHeaders"],
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "retry-download-job" && !sender.tab) {
    retryDownloadJob(message.jobId).then(
      (result) => sendResponse({ type: "download-result", ok: true, ...result }),
      (error) => sendResponse({
        type: "download-result",
        ok: false,
        error: error?.message || "download-job-retry-failed",
      }),
    );
    return true;
  }

  if (message?.type === "list-download-jobs" && !sender.tab) {
    downloadJobsReady.then(() => sendResponse({
      type: "download-jobs",
      jobs: publicDownloadJobs(downloadJobs.values()),
    }));
    return true;
  }

  if (message?.type === "download-job-update"
    && sender.id === chrome.runtime.id
    && sender.url === chrome.runtime.getURL("download-worker.html")) {
    if (["completed", "failed"].includes(message.patch?.status)) jobSourceTabs.delete(message.jobId);
    patchDownloadJob(message.jobId, message.patch).then(
      (job) => sendResponse({ ok: Boolean(job) }),
      () => sendResponse({ ok: false }),
    );
    return true;
  }

  if (message?.type === "youtube-download" && !sender.tab) {
    startYouTubeDownload(message.url, message.quality).then(
      (result) => sendResponse({ type: "download-result", ok: true, ...result }),
      (error) => sendResponse({ type: "download-result", ok: false, error: error?.message || "media-companion-unavailable" }),
    );
    return true;
  }

  if (message?.type === "list-candidates" && !sender.tab) {
    (async () => {
      let activeTabId = null;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        activeTabId = tab?.id ?? null;
      } catch { /* popup may open before tabs API is ready */ }
      const all = [...candidates.values()]
        .filter((candidate) => isDownloadableMediaType(candidate.mediaType)
          && !isLikelyHlsSegmentUrl(candidate.resourceUrl))
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

  if (message?.type === "download-candidate" && !sender.tab) {
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
        error: candidateDownloadErrorCode(error),
      }),
    );
    return true;
  }

  if (message?.type === "prepare-media-fetch") {
    prepareMediaFetchLease(sender, message.url, message.referrer).then(sendResponse);
    return true;
  }

  if (message?.type === "release-media-fetch") {
    releaseMediaFetchLeaseForSender(sender, message.leaseId).then(sendResponse);
    return true;
  }

  if (message?.type === "touch-media-fetch") {
    sendResponse(touchMediaFetchLeaseForSender(sender, message.leaseId));
    return false;
  }

  if (message?.type === "decode-hls-key" && validMediaFetchSender(sender)) {
    const tabId = Number(message.tabId);
    const frameId = Number(message.frameId);
    const url = canonicalMediaFetchUrl(message.url);
    if (!Number.isInteger(tabId) || tabId <= 0 || !Number.isInteger(frameId) || frameId < 0 || !url) {
      sendResponse({ ok: false, error: "invalid-key-request" });
      return false;
    }
    sendTabMessageWithTimeout(tabId, { type: "decode-level5-key", url }, 18_000, { frameId }).then(
      (response) => sendResponse(response?.ok ? response
        : { ok: false, error: normalizeLevel5KeyError(response?.error) }),
      () => sendResponse({ ok: false, error: "page-bridge-timeout" }),
    );
    return true;
  }

  if (message?.type === "download-in-source-frame" && validMediaFetchSender(sender)) {
    const tabId = Number(message.tabId);
    const frameId = message.frameId == null ? null : Number(message.frameId);
    const url = canonicalMediaFetchUrl(message.url);
    const filename = typeof message.filename === "string"
      ? message.filename.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 240)
      : "";
    if (!Number.isInteger(tabId) || tabId <= 0 || (frameId != null && (!Number.isInteger(frameId) || frameId < 0))
      || !url || !isLikelyDoodMediaHost(url) || !filename) {
      sendResponse({ ok: false, error: "invalid-source-download" });
      return false;
    }
    const options = frameId == null ? null : { frameId };
    sendTabMessageWithTimeout(tabId, { type: "download-direct", url, filename }, 8_000, options).then(
      (response) => sendResponse(response?.ok ? { ok: true } : { ok: false, error: "source-frame-unavailable" }),
      () => sendResponse({ ok: false, error: "source-frame-unavailable" }),
    );
    return true;
  }

  if (message?.type === "ensure-media-routes") {
    if (!validMediaRouteSender(sender)) {
      sendResponse({ ok: false, error: "unauthorized" });
      return false;
    }
    ensureDirectMediaAccess(message.urls).then(
      (result) => sendResponse(result),
      (error) => sendResponse({ ok: false, error: error?.code || "route-preparation-failed" }),
    );
    return true;
  }

  if (message?.type === "get-request-headers" && validMediaFetchSender(sender)) {
    const headers = {};
    for (const [originPath, value] of recordedHeaders) headers[originPath] = value;
    sendResponse({ ok: true, headers });
    return false;
  }

  if (message?.type === "ping-media-stream" && validMediaFetchSender(sender)) {
    sendResponse({
      ok: true,
      version: chrome.runtime.getManifest().version,
      capabilities: { mediaFetchLease: 1 },
    });
    return false;
  }

  if (message?.type === "license-status" && sender.id === chrome.runtime.id) {
    void (async () => {
      const stored = await getStoredLicense();
      const edition = await resolveEdition();
      sendResponse({
        ok: true,
        edition,
        status: stored?.status || "none",
        key: typeof stored?.key === "string" ? stored.key : "",
      });
    })();
    return true;
  }

  if (message?.type === "license-activate" && sender.id === chrome.runtime.id) {
    const key = typeof message.key === "string" ? message.key : "";
    void (async () => {
      const result = await activateLicense(key);
      if (result.ok) {
        void chrome.runtime.sendMessage({ type: "license-changed" }).catch(() => {});
        reapplyPauseState();
      }
      sendResponse(result);
    })();
    return true;
  }

  if (message?.type === "license-refresh" && sender.id === chrome.runtime.id) {
    void (async () => {
      await refreshLicense();
      const edition = await resolveEdition();
      sendResponse({ ok: true, edition });
    })();
    return true;
  }

  if (message?.type === "download-url" && !sender.tab) {
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
        if (!progressive && !hls) {
          const sniffed = await sniffMediaContentType(targetUrl);
          if (/mpegurl|vnd\.apple\.mpegurl/i.test(sniffed)) {
            hls = true;
          } else if (/^video\//i.test(sniffed) || /octet-stream/i.test(sniffed) || /^audio\//i.test(sniffed)) {
            progressive = true;
          } else if (!sniffed) {
            progressive = /\.(?:mp4|webm)(?:$|[?#])/i.test(targetUrl)
              || /getfile|download|stream/i.test(targetUrl);
          }
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
        contentType: progressive ? "video/mp4" : "application/vnd.apple.mpegurl",
      });
      if (!candidate) {
        sendResponse({ type: "download-result", candidateId: null, ok: false, error: "invalid-url" });
        return;
      }
      Promise.resolve(beginCandidateDownload(candidate)).then(
        (result) => sendResponse({ type: "download-result", candidateId: candidate.id, ok: true, ...result }),
        () => sendResponse({ type: "download-result", candidateId: candidate.id, ok: false, error: "unsupported-media" }),
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

  if (message?.type === "clear-tab" && !sender.tab && Number.isInteger(message.tabId)) {
    for (const [key, item] of candidates) {
      if (item.tabId === message.tabId) candidates.delete(key);
    }
    persistCandidates();
    sendResponse({ ok: true });
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
    let changed = false;
    for (const candidate of candidates.values()) {
      if (candidate.tabId !== sender.tab.id || candidate.main || !isDownloadableMediaType(candidate.mediaType)) continue;
      const key = normalizeOriginPath(candidate.pageUrl);
      if (key && frames.has(key)) {
        candidate.main = true;
        changed = true;
      }
    }
    if (changed) persistCandidates();
    return false;
  }

  if (message?.type === "dood-direct" && sender.tab?.id && typeof message.url === "string") {
    const directUrl = canonicalHttpUrl(message.url)?.href;
    const frameUrl = typeof message.frameUrl === "string" ? canonicalHttpUrl(message.frameUrl)?.href : "";
    if (!directUrl) return false;
    doodDirectByTab.set(sender.tab.id, {
      url: directUrl,
      frameUrl: frameUrl || "",
      at: Date.now(),
    });
    return false;
  }

  if (!sender.tab?.url || sender.id !== chrome.runtime.id) return false;
  const sanitized = sanitizePageMessage({
    ...message,
    pageTitle: message.pageTitle || sender.tab.title || "",
    pageUrl: canonicalHttpUrl(sender.url)?.href
      || (typeof message.frameUrl === "string" ? canonicalHttpUrl(message.frameUrl)?.href : null)
      || canonicalHttpUrl(sender.tab.url)?.href
      || "",
  });
  if (sanitized) sanitized.tabId = sender.tab.id;
  if (sanitized && Number.isInteger(sender.frameId) && sender.frameId >= 0) sanitized.frameId = sender.frameId;
  if (sanitized && isMainFrame(sender.tab.id, sender.url)) sanitized.main = true;
  observeCandidate(sanitized);
  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "native-file-writer"
    && port.sender?.id === chrome.runtime.id
    && port.sender?.url === chrome.runtime.getURL("download-worker.html")) {
    let relayClosed = false;
    let writerPort;
    try {
      writerPort = chrome.runtime.connectNative(MEDIA_COMPANION_NATIVE_HOST);
    } catch {
      port.disconnect();
      return;
    }
    port.onMessage.addListener((message) => {
      if (relayClosed) return;
      try { writerPort.postMessage(message); } catch { port.disconnect(); }
    });
    writerPort.onMessage.addListener((message) => {
      if (relayClosed) return;
      try { port.postMessage(message); } catch { writerPort.disconnect(); }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (relayClosed) return;
      relayClosed = true;
      try { writerPort.disconnect(); } catch { /* already disconnected */ }
    });
    writerPort.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (relayClosed) return;
      relayClosed = true;
      try { port.disconnect(); } catch { /* already disconnected */ }
    });
    return;
  }

  if (port.name === "media-stream" && validMediaFetchSender(port.sender)) {
    async function resolveFreshUrl(message, signal) {
      let url = message.url;
      let referrer = typeof message.pageUrl === "string" ? message.pageUrl : "";
      await ensureDirectMediaAccess([url, referrer, message.pageUrl].filter(Boolean));
      let resolvedForTransfer = false;
      if (Number.isInteger(message.videoTabId) && message.videoTabId > 0) {
        // The player iframe's content script re-resolves /pass_md5 in its own
        // context, giving a fresh token URL and the exact Referer the CDN
        // expects (the /e/ player frame, not the outer page).
        const fresh = await sendTabMessageWithTimeout(message.videoTabId, { type: "get-dood-direct" });
        const freshUrl = fresh?.ok && typeof fresh.url === "string" ? canonicalHttpUrl(fresh.url)?.href : null;
        const freshFrameUrl = typeof fresh?.frameUrl === "string" ? canonicalHttpUrl(fresh.frameUrl)?.href : null;
        if (freshUrl) {
          url = freshUrl;
          if (freshFrameUrl) referrer = freshFrameUrl;
          resolvedForTransfer = true;
        } else {
          const cached = doodDirectByTab.get(message.videoTabId);
          if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
            url = cached.url;
            if (cached.frameUrl) referrer = cached.frameUrl;
            resolvedForTransfer = true;
          }
        }
      }
      if (!resolvedForTransfer && typeof message.pageUrl === "string" && looksLikePlayerPage(message.pageUrl)) {
        const resolved = await playerGraphResolver.resolve(message.pageUrl, { signal });
        if (resolved?.url) {
          url = resolved.url;
          referrer = resolved.referrer || referrer;
        }
      }
      try {
        const prepared = await progressiveRedirectResolver.resolve({ url, referrer });
        return { url: prepared.url, referrer: prepared.referrer };
      } catch (error) {
        const recovery = authenticatedRecoveryForProgressiveError(error, { url, referrer });
        if (recovery) return recovery;
        throw error;
      }
    }

    let activeController = null;
    let disconnected = false;
    port.onDisconnect.addListener(() => {
      disconnected = true;
      if (activeController) activeController.abort();
    });
    port.onMessage.addListener(async (message) => {
      if (message?.type !== "start" || typeof message.url !== "string") return;
      const controller = new AbortController();
      if (activeController) activeController.abort();
      activeController = controller;
      const signal = controller.signal;
      try {
        const { url, referrer, authenticatedProbeRequired } = await resolveFreshUrl(message, signal);
        if (signal.aborted || disconnected) return;
        port.postMessage({
          type: "fetch-required",
          url,
          referrer,
          ...(authenticatedProbeRequired ? { authenticatedProbeRequired: true } : {}),
        });
      } catch (error) {
        if (signal.aborted || disconnected) return;
        port.postMessage({
          type: "stream-error",
          message: progressiveDownloadErrorMessage(error),
        });
      }
    });
    return;
  }

});
