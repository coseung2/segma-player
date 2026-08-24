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
import { downloaderIdForMediaType, jobModeForDownloader } from "./downloaders/ids.js";
import { candidateDownloadErrorCode } from "./download-errors.js";
import {
  DEFAULT_FILENAME_TEMPLATE,
  FILENAME_TEMPLATE_STORAGE_KEY,
  formatFilenameTemplate,
} from "./filename-template.js";
import { getStoredSaveDirectory } from "./save-directory.js";
import { moveDownloadCheckpoints } from "./download-checkpoint.js";
import {
  createDownloadJob,
  persistedDownloadJobs,
  publicDownloadJobs,
  retryPayloadForJob,
  terminalDownloadJob,
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
  canonicalMediaFetchUrl,
  createMediaFetchLeaseRegistry,
  createMediaFetchRuleIdAllocator,
  exactMediaFetchRule,
  playbackMediaFetchRule,
  MEDIA_FETCH_RULE_ID_START,
  OFFSCREEN_DOCUMENT_TAB_ID,
} from "./media-fetch-lease.js";
import {
  MOBILE_USER_AGENT_RULE_ID_START,
  buildMobileUserAgentRule,
  buildMobileUserAgentRuleRemoval,
  createMobileUserAgentRuleIdAllocator,
  isMobileUserAgentRuleId,
} from "./mobile-user-agent.js";
import { createPlayerGraphResolver, looksLikePlayerPage } from "./player-page-resolver.js";
import { createPlaybackSessionStore } from "./playback-session.js";
import { youtubeQualityAllowed } from "./product-plan.js";
import { createRequestHeaderStore } from "./request-header-store.js";
import {
  getYouTubeServerUrl,
  listYouTubeQualities,
  submitYouTubeJob,
  waitForYouTubeJob,
  youtubeJobFileUrl,
} from "./youtube-server.js";
import {
  HEARTBEAT_ALARM_NAME,
  heartbeatAlarmSpec,
  isHeartbeatPortName,
  shouldKeepWorkerAlive,
} from "./worker-lifecycle.js";
import {
  authenticatedRecoveryForProgressiveError,
  createProgressiveRedirectResolver,
  progressiveDownloadErrorMessage,
} from "./progressive-redirect.js";
import { createBrowserDownloadMonitor } from "./browser-download-monitor.js";
import {
  MEDIA_COMPANION_NATIVE_HOST,
  cancelCompanionJob,
  companionStatus,
  listCompanionJobs,
  onCompanionEvent,
  startCompanionSubtitleJob,
  startCompanionYouTubeDownload,
} from "./companion-client.js";
import {
  createMediaRequestDiagnosticStore,
  resolveMediaRequestContext,
} from "./media-request-context.js";

const candidates = new Map();
const PROGRESSIVE_REDIRECT_TARGET_LIMIT = 1000;
const PROGRESSIVE_REDIRECT_TARGET_TTL_MS = 60_000;
const requestHeaderStore = createRequestHeaderStore({ maxEntries: 1000, ttlMs: 10 * 60 * 1000 });
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
const DOWNLOAD_JOBS_KEY = "downloadJobs";
const DOWNLOAD_INTENTS_KEY = "downloadIntents";
const PLAYBACK_SESSIONS_KEY = "playbackSessions";
const DOWNLOAD_OVERLAY_KEY = "downloadOverlayJobIds";
const downloadJobs = new Map();
const downloadIntents = new Map();
const downloadOverlayJobIds = new Set();
const playbackSessions = createPlaybackSessionStore();
const youtubeBrowserDownloads = new Map();
const youtubeJobControllers = new Map();
const browserDownloadMonitor = createBrowserDownloadMonitor(chrome.downloads);
const MOBILE_USER_AGENT = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
const mobileUaRulesByTab = new Map();
let mobileUaRuleIds = null;
const workerHeartbeatPorts = new Set();

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

function hasActiveDownloadJobs() {
  return [...downloadJobs.values()].some((job) => ["queued", "running", "paused"].includes(job.status));
}

function syncWorkerLifecycleAlarm() {
  if (!chrome.alarms) return;
  const active = shouldKeepWorkerAlive({
    activeDownloads: hasActiveDownloadJobs(),
  }) || workerHeartbeatPorts.size > 0;
  if (active) chrome.alarms.create(HEARTBEAT_ALARM_NAME, heartbeatAlarmSpec().periodInMinutes
    ? { periodInMinutes: heartbeatAlarmSpec().periodInMinutes }
    : { periodInMinutes: 1 });
  else void chrome.alarms.clear(HEARTBEAT_ALARM_NAME);
}

async function configuredOutputFilename(title, extension, url = "") {
  let template = DEFAULT_FILENAME_TEMPLATE;
  try {
    const stored = await chrome.storage.local.get({ [FILENAME_TEMPLATE_STORAGE_KEY]: template });
    template = stored?.[FILENAME_TEMPLATE_STORAGE_KEY] || template;
  } catch {
    // Use the packaged default.
  }
  return formatFilenameTemplate(template, { title, ext: extension, url });
}

chrome.downloads.onChanged.addListener((delta) => {
  const jobId = youtubeBrowserDownloads.get(delta.id);
  if (!jobId) return;
  if (delta.state?.current === "complete") {
    youtubeBrowserDownloads.delete(delta.id);
    void patchDownloadJob(jobId, {
      status: "completed",
      statusText: "다운로드를 완료했습니다 (브라우저 Downloads 폴더).",
    });
  } else if (delta.state?.current === "interrupted") {
    youtubeBrowserDownloads.delete(delta.id);
    void patchDownloadJob(jobId, {
      status: "failed",
      statusText: "브라우저 다운로드가 중단되었습니다.",
      error: delta.error?.current || "download-interrupted",
    });
  } else if (Number.isFinite(delta.bytesReceived?.current)
    && Number.isFinite(delta.totalBytes?.current)
    && delta.totalBytes.current > 0) {
    const percent = Math.max(0, Math.min(100,
      Math.round((delta.bytesReceived.current / delta.totalBytes.current) * 100)));
    void patchDownloadJob(jobId, {
      status: "running",
      statusText: `내 기기로 전송 중… ${percent}%`,
    });
  }
});
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
  getRequestHeaders: (url) => requestHeaderStore.fetchHeaders(url),
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

const downloadJobsReady = chrome.storage.session.get({
  [DOWNLOAD_JOBS_KEY]: [],
  [DOWNLOAD_INTENTS_KEY]: [],
  [PLAYBACK_SESSIONS_KEY]: [],
  [DOWNLOAD_OVERLAY_KEY]: [],
}).then((stored) => {
  for (const job of stored[DOWNLOAD_JOBS_KEY] || []) {
    if (job && typeof job.id === "string") downloadJobs.set(job.id, job);
  }
  for (const intent of stored[DOWNLOAD_INTENTS_KEY] || []) {
    if (intent && typeof intent.jobId === "string" && intent.candidate && typeof intent.candidate === "object") {
      downloadIntents.set(intent.jobId, intent);
    }
  }
  for (const jobId of stored[DOWNLOAD_OVERLAY_KEY] || []) {
    if (typeof jobId === "string" && jobId) downloadOverlayJobIds.add(jobId);
  }
  playbackSessions.restore(stored[PLAYBACK_SESSIONS_KEY]);
  syncWorkerLifecycleAlarm();
  for (const job of downloadJobs.values()) {
    if (["youtube", "companion"].includes(job?.source) && !terminalDownloadJob(job)) {
      watchCompanionJob(job.id);
    }
  }
}).catch(() => {});

async function persistDownloadJobs() {
  await chrome.storage.session.set({ [DOWNLOAD_JOBS_KEY]: persistedDownloadJobs(downloadJobs.values()) });
}

async function persistDownloadIntents() {
  await chrome.storage.session.set({
    [DOWNLOAD_INTENTS_KEY]: [...downloadIntents.values()].slice(-30),
  });
}

async function persistPlaybackSessions() {
  await chrome.storage.session.set({
    [PLAYBACK_SESSIONS_KEY]: playbackSessions.serialized(),
  });
}

async function persistDownloadOverlay() {
  await chrome.storage.session.set({
    [DOWNLOAD_OVERLAY_KEY]: [...downloadOverlayJobIds].slice(-50),
  });
}

async function rememberDownloadOverlayJob(jobId) {
  if (typeof jobId !== "string" || !jobId) return;
  downloadOverlayJobIds.add(jobId);
  await persistDownloadOverlay();
}

async function rememberDownloadIntent(jobId, candidate) {
  downloadIntents.set(jobId, Object.freeze({
    jobId,
    candidate: structuredClone(candidate),
    sourceTabId: Number.isInteger(candidate?.tabId) ? candidate.tabId : null,
    createdAt: Date.now(),
  }));
  await persistDownloadIntents();
}

async function forgetDownloadIntent(jobId) {
  if (!downloadIntents.delete(jobId)) return;
  await persistDownloadIntents().catch(() => {});
}

async function syncDownloadOverlayForTab(tabId, jobIds = []) {
  if (!Number.isInteger(tabId)) return false;
  // Existing tabs keep the old content-script closure across extension
  // updates. Inject the current guarded script before delivery so an old V3
  // listener cannot leave the tab with only the Aura-AdBlock-hidden host.
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: ["content.js"],
      injectImmediately: true,
    });
  } catch {
    // Restricted browser pages cannot host an in-page overlay.
  }
  const visibleJobIds = [...new Set([
    ...downloadOverlayJobIds,
    ...(Array.isArray(jobIds) ? jobIds : []),
  ].filter((jobId) => typeof jobId === "string" && jobId))].slice(-50);
  const overlayMessage = visibleJobIds.length
    ? { type: "show-download-overlay", jobIds: visibleJobIds }
    : { type: "hide-download-overlay" };
  const deliver = async () => {
    const response = await chrome.tabs.sendMessage(
      tabId,
      overlayMessage,
      { frameId: 0 },
    );
    return response?.ok === true;
  };
  // A download can be queued while its source tab is navigating.  Do not
  // consider a fire-and-forget message delivered: wait for the top-frame
  // content script to acknowledge it, including after a slow site injects
  // the script at document_start.
  for (const delay of [0, 250, 1_000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      if (await deliver()) return true;
    } catch {
      // The active tab may not host the content script yet.
    }
  }
  // Some sites replace the document while a download begins.  Explicitly
  // inject the already-guarded content script into frame zero, then retry the
  // acknowledgement. This does not depend on the site's own scripts or CSP.
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: ["content.js"],
      injectImmediately: true,
    });
  } catch {
    // Restricted browser pages cannot host an in-page overlay.
  }
  for (const delay of [0, 250, 1_000, 3_000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      if (await deliver()) return true;
    } catch {
      // Keep the popup/download-job UI usable if the page rejects injection.
    }
  }
  return false;
}

async function syncDownloadOverlayForAllTabs(jobIds = []) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  const eligibleTabs = tabs.filter((tab) => Number.isInteger(tab?.id)
    && /^https?:\/\//i.test(String(tab.url || "")));
  await Promise.allSettled(eligibleTabs.map((tab) => syncDownloadOverlayForTab(tab.id, jobIds)));
}

async function syncDownloadOverlayForActiveTab(changedJobId = "") {
  await downloadJobsReady;
  const targetTabIds = new Set();
  for (const [jobId, sourceTabId] of jobSourceTabs) {
    const job = downloadJobs.get(jobId);
    if (!job || (changedJobId && jobId !== changedJobId)) continue;
    if (!changedJobId && !["queued", "running", "paused"].includes(job.status)) continue;
    if (Number.isInteger(sourceTabId)) targetTabIds.add(sourceTabId);
  }
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const activeTabId = tabs[0]?.id ?? null;
    if (Number.isInteger(activeTabId)) targetTabIds.add(activeTabId);
  } catch {
    // Fall through with whatever source tabs were already collected.
  }
  for (const tabId of targetTabIds) {
    await syncDownloadOverlayForTab(tabId);
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  // The content script refreshes the shared job list after this message.
  // Keep tab activation delivery small and deterministic, as in the known
  // working link-input/YouTube path.
  void syncDownloadOverlayForTab(tabId);
});

async function patchDownloadJob(jobId, patch) {
  await downloadJobsReady;
  const current = downloadJobs.get(jobId);
  if (!current) return null;
  const next = updateDownloadJob(current, patch);
  downloadJobs.set(jobId, next);
  if (["completed", "failed", "cancelled"].includes(next.status)) {
    await forgetDownloadIntent(jobId);
  }
  void syncDownloadOverlayForActiveTab(jobId);
  await persistDownloadJobs().catch(() => {});
  void chrome.runtime.sendMessage({ type: "download-jobs-changed" }).catch(() => {});
  syncWorkerLifecycleAlarm();
  return next;
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
const ACTIVE_COMPANION_STATUSES = new Set(["created", "preparing", "submitting", "queued", "running"]);

const companionJobPollers = new Map();

async function syncCompanionJob(jobId) {
  const listed = await listCompanionJobs();
  const remote = Array.isArray(listed?.jobs)
    ? listed.jobs.find((job) => job?.jobId === jobId)
    : null;
  if (!remote) return false;
  const current = downloadJobs.get(jobId);
  if (!current || terminalDownloadJob(current)) return true;
  const subtitleJob = remote.jobType === "subtitle" || current.source === "companion";
  const status = ["queued", "running", "completed", "failed", "cancelled"].includes(remote.status)
    ? remote.status
    : "running";
  await patchDownloadJob(jobId, {
    ...(typeof remote.title === "string" && remote.title.trim() ? { title: remote.title.trim().slice(0, 500) } : {}),
    status,
    statusText: typeof remote.statusText === "string" && remote.statusText
      ? remote.statusText
      : (subtitleJob ? "Aura Companion에서 자막 생성 중…" : "Aura Companion에서 다운로드 중…"),
    error: typeof remote.error === "string" ? remote.error.slice(0, 500) : "",
    folderName: subtitleJob ? "Downloads\\Aura Media\\Subtitles" : "Downloads\\Aura Media",
  });
  return ["completed", "failed", "cancelled"].includes(status);
}

async function restoreActiveCompanionJobs() {
  const status = await companionStatus();
  if (!status.ok) return;
  const listed = await listCompanionJobs();
  if (!Array.isArray(listed?.jobs)) return;
  for (const remote of listed.jobs) {
    if (!remote || typeof remote.jobId !== "string" || !remote.jobId) continue;
    if (!ACTIVE_COMPANION_STATUSES.has(remote.status)) continue;
    if (!downloadJobs.has(remote.jobId)) {
      const subtitleJob = remote.jobType === "subtitle";
      downloadJobs.set(remote.jobId, createDownloadJob({
        id: remote.jobId,
        title: typeof remote.title === "string" && remote.title.trim()
          ? remote.title.trim()
          : (subtitleJob ? "Aura Companion 자막" : "Aura Companion 다운로드"),
        mediaType: subtitleJob ? "SUBTITLE" : "YOUTUBE",
        source: subtitleJob ? "companion" : "youtube",
        folderName: subtitleJob ? "Downloads\\Aura Media\\Subtitles" : "Downloads\\Aura Media",
        now: Number.isFinite(Number(remote.updatedAt)) ? Number(remote.updatedAt) : Date.now(),
      }));
    }
    await syncCompanionJob(remote.jobId);
    watchCompanionJob(remote.jobId);
  }
  await persistDownloadJobs();
}

function watchCompanionJob(jobId) {
  if (companionJobPollers.has(jobId)) return;
  const poll = async () => {
    try {
      if (await syncCompanionJob(jobId)) {
        clearInterval(companionJobPollers.get(jobId));
        companionJobPollers.delete(jobId);
      }
    } catch {
      // A detached Companion job keeps running even if the browser/native port
      // briefly restarts. The next poll or extension restart will resync it.
    }
  };
  const timer = setInterval(() => { void poll(); }, 750);
  companionJobPollers.set(jobId, timer);
  void poll();
}

onCompanionEvent((message) => {
  if (message?.type !== "companion-disconnected") return;
  // Do not mark active local jobs failed: job runners are detached from the
  // native bridge and can outlive the browser. Polling resumes on reconnect.
});

void downloadJobsReady.then(() => restoreActiveCompanionJobs()).catch(() => {});

async function startYouTubeDownload(rawUrl, rawQuality = "best", { resumeFromJobId = null } = {}) {
  const url = canonicalYouTubeUrl(rawUrl);
  if (!url) throw new Error("invalid-youtube-url");
  const quality = String(rawQuality || "best");
  if (!YOUTUBE_QUALITIES.has(quality)) throw new Error("invalid-youtube-quality");
  const plan = await resolvePlan();
  if (!youtubeQualityAllowed(plan, quality)) throw new Error("pro-feature-required");

  await downloadJobsReady;
  const jobId = crypto.randomUUID();
  downloadJobs.set(jobId, createDownloadJob({
    id: jobId,
    title: "제목 확인 중…",
    mediaType: "YOUTUBE",
    source: "youtube",
    folderName: "Downloads\\Aura Media",
    retryPayload: { kind: "youtube", url, quality },
  }));
  await persistDownloadJobs();
  if (resumeFromJobId) {
    await moveDownloadCheckpoints(`youtube:${resumeFromJobId}`, `youtube:${jobId}`);
  }
  await patchDownloadJob(jobId, {
    status: "running",
    statusText: "Aura Companion에 요청하는 중…",
  });

  const companion = await companionStatus();
  if (companion.ok && companion.toolsReady !== false) {
    try {
      const accepted = await startCompanionYouTubeDownload({ jobId, url, quality });
      if (accepted?.accepted) {
        await patchDownloadJob(jobId, {
          status: "running",
          statusText: "Aura Companion에서 다운로드를 시작했습니다.",
          folderName: "Downloads\\Aura Media",
        });
        watchCompanionJob(jobId);
        return { mode: "youtube-companion", jobId };
      }
    } catch {
      // Keep the notebook/cloud path as a migration fallback until the local
      // Companion path is proven on store builds and real Windows machines.
    }
  }

  await patchDownloadJob(jobId, {
    status: "running",
    statusText: "로컬 Companion을 사용할 수 없어 서버 경로로 전환합니다…",
  });
  const serverUrl = await getYouTubeServerUrl();
  if (serverUrl) {
    const metadataTitlePromise = listYouTubeQualities(url, serverUrl).then(async (metadata) => {
      const title = metadata?.ok && typeof metadata.title === "string" ? metadata.title.trim() : "";
      if (title) await patchDownloadJob(jobId, { title });
      return title;
    }).catch(() => "");
    const controller = new AbortController();
    youtubeJobControllers.set(jobId, controller);
    try {
      const submitted = await submitYouTubeJob(url, quality, serverUrl, { signal: controller.signal });
      if (submitted.ok) {
        const waited = await waitForYouTubeJob(submitted.jobId, serverUrl, {
          signal: controller.signal,
          onProgress: (percent, { speedMBps = null, etaSeconds = null } = {}) => {
            const speed = Number.isFinite(speedMBps) ? ` · ${speedMBps.toFixed(1)}MB/s` : "";
            const eta = Number.isFinite(etaSeconds) && etaSeconds > 0 ? ` · ETA ${etaSeconds}초` : "";
            void patchDownloadJob(jobId, { status: "running", statusText: `서버 처리 중… ${percent}%${speed}${eta}` });
          },
        });
        if (controller.signal.aborted) throw new Error("download-cancelled");
        if (waited.ok) {
          const metadataTitle = typeof waited.title === "string" && waited.title.trim() ? "" : await metadataTitlePromise;
          const recognizedTitle = downloadJobs.get(jobId)?.title;
          const title = typeof waited.title === "string" && waited.title.trim()
            ? waited.title.trim()
            : (metadataTitle || (recognizedTitle && recognizedTitle !== "제목 확인 중…" ? recognizedTitle : ""));
          if (!title) throw new Error("YouTube 영상 제목을 인식하지 못했습니다. 잠시 후 다시 시도해 주세요.");
          if (waited.localFile && await isServerOnThisMachine(serverUrl)) {
            await patchDownloadJob(jobId, { title, status: "completed", statusText: "저장 완료 — 이 PC의 Downloads\\Aura Media 폴더에 저장했습니다." });
            return { mode: "youtube-local", jobId };
          }
          const fileUrl = await youtubeJobFileUrl(submitted.jobId, serverUrl);
          await patchDownloadJob(jobId, { title, status: "running", statusText: "서버 처리 완료 — 저장 준비 중…" });
          const outputFilename = await configuredOutputFilename(title, "mp4", url);
          const saveHandle = await getStoredSaveDirectory();
          if (saveHandle) {
            if (terminalDownloadJob(downloadJobs.get(jobId))) throw new Error("download-cancelled");
            await ensureDownloadWorker().catch(() => {});
            const dispatched = await chrome.runtime.sendMessage({ type: "parallel-save", jobId, url: fileUrl, filename: outputFilename }).catch(() => null);
            if (dispatched?.ok) return { mode: "youtube-parallel", jobId };
          }
          if (terminalDownloadJob(downloadJobs.get(jobId))) throw new Error("download-cancelled");
          const downloadId = await chrome.downloads.download({
            url: fileUrl,
            filename: `Aura Media/${outputFilename}`,
            conflictAction: "uniquify",
            saveAs: false,
          });
          youtubeBrowserDownloads.set(downloadId, jobId);
          await patchDownloadJob(jobId, { status: "running", statusText: "브라우저 다운로드를 시작했습니다." });
          return { mode: "youtube-browser", jobId };
        }
        const detail = typeof waited.error === "string" && waited.error ? waited.error : "job-failed";
        throw new Error(`Aura YouTube 서버 처리 실패 (${detail.slice(0, 300)})`);
      }
      if (submitted.error === "monthly-limit-reached") {
        const limit = Number.isInteger(submitted.limit) ? ` (${submitted.limit}개)` : "";
        const edition = await resolveEdition();
        if (edition === "pro") throw new Error("Pro 빌드가 YouTube 서버에 Pro 키로 인증되지 않았습니다. 설정 → Pro 라이선스에서 키를 등록하거나 다시 확인해 주세요.");
        throw new Error(`이번 달 Aura YouTube 무료 다운로드 한도를 사용했습니다${limit}. Pro 라이선스를 등록하면 제한이 풀립니다.`);
      }
    } finally {
      youtubeJobControllers.delete(jobId);
    }
  }
  await patchDownloadJob(jobId, {
    status: "failed",
    statusText: "Aura Companion과 서버에 모두 연결할 수 없습니다.",
    error: "youtube-backend-unavailable",
  });
  throw new Error("YouTube 서버에 연결할 수 없습니다. Aura Companion 설치 또는 서버 연결을 확인해 주세요.");
}

async function isServerOnThisMachine(serverUrl) {
  try {
    const parsed = new URL(serverUrl);
    let port = parsed.port ? Number(parsed.port) : (parsed.protocol === "http:" ? 80 : 443);
    if (port === 443) port = 8788; // Tailscale serve proxies to the local listener.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_500);
    timer?.unref?.();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) return false;
      const data = await response.json();
      return data?.ok === true && data?.service === "aura-youtube";
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
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
    .filter((ruleId) => Number.isInteger(ruleId) && ruleId >= MEDIA_FETCH_RULE_ID_START
      && ruleId < MOBILE_USER_AGENT_RULE_ID_START);
  if (removeRuleIds.length) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules: [] });
  }
}).catch(() => {});

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

function validDownloadWorkerSender(sender) {
  return exactExtensionPageSender(sender, "download-worker.html");
}

function validPlayerPageSender(sender) {
  return exactExtensionPageSender(sender, "player.html");
}

function validPlayerSender(sender) {
  return validPlayerPageSender(sender)
    && Number.isInteger(sender.tab?.id) && sender.tab.id > 0;
}

function mediaFetchSenderTabId(sender) {
  if (validDownloadWorkerSender(sender)) return OFFSCREEN_DOCUMENT_TAB_ID;
  if (validPlayerSender(sender)) return sender.tab.id;
  return null;
}

function validMediaFetchSender(sender) {
  return mediaFetchSenderTabId(sender) !== null;
}

function validMediaRouteSender(sender) {
  return validDownloadWorkerSender(sender);
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

async function prepareMediaFetchLease(sender, rawUrl, rawReferrer, sourceContext = {}, consumer = "media-fetch") {
  if (!validMediaFetchSender(sender)) return { ok: false, error: "unauthorized" };
  return prepareMediaFetchLeaseForTab(
    mediaFetchSenderTabId(sender),
    rawUrl,
    rawReferrer,
    sourceContext,
    false,
    consumer,
  );
}

async function prepareMediaFetchLeaseForTab(
  tabId,
  rawUrl,
  rawReferrer,
  sourceContext = {},
  playback = false,
  consumer = "media-fetch",
) {
  if (!Number.isInteger(tabId) || (tabId <= 0 && tabId !== OFFSCREEN_DOCUMENT_TAB_ID)) {
    return { ok: false, error: "invalid-tab" };
  }
  let requestContext;
  try {
    requestContext = resolveMediaRequestContext({
      url: rawUrl,
      fallbackReferrer: rawReferrer,
      sourceContext,
      consumer,
      lookupRequestHeaders: (url, context) => requestHeaderStore.lookup(url, context),
    });
  } catch (error) {
    return {
      ok: false,
      error: error?.message === "invalid-media-request-referrer" ? "invalid-referrer" : "invalid-url",
    };
  }
  const { url, referrer, requestHeaders, diagnostic } = requestContext;

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
    const isHlsPlayback = playback && /\.m3u8(?:[?#]|$)/i.test(url);
    rule = (isHlsPlayback ? playbackMediaFetchRule : exactMediaFetchRule)({
      ruleId,
      tabId,
      url,
      referrer,
      requestHeaders,
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
      tabId,
      url,
      referrer,
      ruleId,
    });
  } catch {
    await removeMediaFetchLease({ leaseId: "", ruleId });
    return { ok: false, error: "media-fetch-unavailable" };
  }
  mediaRequestDiagnostics.start({
    leaseId: lease.leaseId,
    requestTabId: tabId,
    url,
    diagnostic,
  });
  return { ok: true, leaseId: lease.leaseId, requestContext: diagnostic };
}

function validPlaybackSender(sender) {
  return sender?.id === chrome.runtime.id
    && typeof sender.url === "string"
    && sender.url.startsWith(chrome.runtime.getURL("player.html"));
}

async function preparePlaybackMediaLease(sender, message) {
  if (!validPlaybackSender(sender)) return { ok: false, error: "unauthorized" };
  const tabId = Number(message?.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) return { ok: false, error: "invalid-tab" };
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!String(tab?.url || "").startsWith(chrome.runtime.getURL("player.html"))) {
      return { ok: false, error: "invalid-tab" };
    }
  } catch {
    return { ok: false, error: "invalid-tab" };
  }
  return prepareMediaFetchLeaseForTab(tabId, message.url, message.referrer, {}, true, "playback-native");
}

async function releaseMediaFetchLeaseForTab(tabId, leaseId) {
  if (typeof leaseId !== "string" || leaseId.length === 0) return { ok: false, error: "invalid-lease" };
  const lease = mediaFetchLeases.get(leaseId);
  if (!lease || lease.tabId !== tabId) return { ok: false, error: "lease-not-found" };
  if (!await removeMediaFetchLease(lease)) return { ok: false, error: "media-fetch-release-failed" };
  return { ok: true };
}

async function releaseMediaFetchLeaseForSender(sender, leaseId) {
  if (!validMediaFetchSender(sender)) return { ok: false, error: "unauthorized" };
  return releaseMediaFetchLeaseForTab(mediaFetchSenderTabId(sender), leaseId);
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

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm?.name !== HEARTBEAT_ALARM_NAME) return;
  void cleanupStaleMediaFetchLeases();
  if (hasActiveDownloadJobs()) {
    void ensureDownloadWorker().then(() => chrome.runtime.sendMessage({ type: "download-worker-heartbeat" })).catch(() => {});
  }
  syncWorkerLifecycleAlarm();
});

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

async function hasDownloadWorkerDocument() {
  if (typeof chrome.offscreen.hasDocument === "function") {
    return chrome.offscreen.hasDocument();
  }
  const documentUrl = chrome.runtime.getURL("download-worker.html");
  if (typeof chrome.runtime.getContexts === "function") {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [documentUrl],
    });
    return contexts.length > 0;
  }
  const matchedClients = await globalThis.clients?.matchAll?.();
  return Boolean(matchedClients?.some?.((client) => client?.url === documentUrl));
}

async function ensureDownloadWorker() {
  if (!await hasDownloadWorkerDocument()) {
    if (!offscreenCreatePromise) {
      offscreenCreatePromise = chrome.offscreen.createDocument({
        url: "download-worker.html",
        reasons: ["BLOBS"],
        justification: "Download detected media into the user-selected folder without opening a browser tab.",
      }).finally(() => { offscreenCreatePromise = null; });
    }
    await offscreenCreatePromise;
  }
  // createDocument resolves before the document has evaluated its message
  // listeners. Do not send the first job into that startup window: a subtitle
  // request would otherwise look accepted in the player, then fail instantly.
  let lastError = null;
  for (const delay of [0, 50, 150, 400, 1_000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const state = await chrome.runtime.sendMessage({ type: "download-worker-state" });
      if (state?.ok) return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("download-worker-unavailable");
}

async function dispatchMediaDownload(jobId, candidate) {
  try {
    if (terminalDownloadJob(downloadJobs.get(jobId))) return;
    const transferCandidate = await resolvePlayerCandidate(candidate);
    await ensureDownloadWorker();
    if (terminalDownloadJob(downloadJobs.get(jobId))) return;
    const accepted = await chrome.runtime.sendMessage({
      type: "run-download-job",
      jobId,
      candidate: transferCandidate,
    });
    if (!accepted?.ok && accepted?.error !== "duplicate-download-job") {
      throw new Error(accepted?.error || "worker-unavailable");
    }
  } catch (error) {
    await patchDownloadJob(jobId, {
      status: "failed",
      statusText: "다운로드 작업을 시작하지 못했습니다.",
      error: error?.message || "worker-unavailable",
    });
    jobSourceTabs.delete(jobId);
  }
}

async function startSubtitleGeneration(input) {
  const mediaUrl = canonicalHttpUrl(input?.mediaUrl)?.href || "";
  const sourceUrl = input?.sourceUrl ? canonicalHttpUrl(input.sourceUrl)?.href || "" : "";
  const audioRenditionUrl = input?.audioRenditionUrl
    ? canonicalHttpUrl(input.audioRenditionUrl)?.href || ""
    : "";
  const sourceTabId = Number.isInteger(input?.sourceTabId) && input.sourceTabId > 0 ? input.sourceTabId : null;
  const sourceFrameId = Number.isInteger(input?.sourceFrameId) && input.sourceFrameId >= 0
    ? input.sourceFrameId
    : null;
  const sourceLanguage = input?.sourceLanguage === "en" ? "en" : "ja";
  const mediaType = ["HLS_MASTER", "HLS_MEDIA", "PROGRESSIVE", "DASH"].includes(input?.mediaType)
    ? input.mediaType
    : "";
  const title = String(input?.title || "영상 자막").trim().slice(0, 240) || "영상 자막";
  if (!mediaUrl || input?.sourceUrl && !sourceUrl || input?.audioRenditionUrl && !audioRenditionUrl) {
    throw new Error("invalid-media-url");
  }
  await downloadJobsReady;
  const subtitleInput = {
    mediaUrl,
    sourceUrl,
    audioRenditionUrl,
    title,
    sourceLanguage,
    sourceTabId,
    sourceFrameId,
    mediaType,
  };

  const companion = await companionStatus();
  if (companion.ok && companion.licenseConfigured === true) {
    const accepted = await startCompanionSubtitleJob({
      candidateId: `subtitle-${crypto.randomUUID()}`,
      sourceLanguage,
      media: {
        type: mediaType.startsWith("HLS")
          ? "hls"
          : (mediaType === "DASH" ? "dash" : (mediaType === "PROGRESSIVE" ? "progressive" : "unknown")),
        title,
        pageUrl: sourceUrl,
        resourceUrl: mediaUrl,
        audioRenditionUrl,
      },
    });
    const jobId = typeof accepted?.jobId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(accepted.jobId)
      ? accepted.jobId
      : "";
    if (!accepted?.accepted || !jobId) throw new Error("subtitle-companion-start-failed");
    downloadJobs.set(jobId, createDownloadJob({
      id: jobId,
      title,
      mediaType: "SUBTITLE",
      source: "companion",
      folderName: "Downloads\\Aura Media\\Subtitles",
      retryPayload: { kind: "subtitle", input: subtitleInput },
    }));
    await persistDownloadJobs();
    await rememberDownloadOverlayJob(jobId);
    void syncDownloadOverlayForAllTabs([jobId]);
    await patchDownloadJob(jobId, {
      status: "running",
      statusText: "Aura Companion에서 자막 생성을 시작했습니다.",
    });
    watchCompanionJob(jobId);
    return { jobId, mode: "subtitle-companion" };
  }

  if ((await resolveEdition()) !== "pro") throw new Error("pro-license-required");
  await refreshLicense();
  const license = await getStoredLicense();
  if (license?.edition !== "pro" || typeof license.key !== "string" || !license.key) {
    throw new Error("pro-license-required");
  }
  const jobId = crypto.randomUUID();
  downloadJobs.set(jobId, createDownloadJob({
    id: jobId,
    title,
    mediaType: "SUBTITLE",
    folderName: "Downloads\\Aura Media",
    retryPayload: { kind: "subtitle", input: subtitleInput },
  }));
  if (sourceTabId !== null) jobSourceTabs.set(jobId, sourceTabId);
  await persistDownloadJobs();
  await rememberDownloadOverlayJob(jobId);
  void syncDownloadOverlayForAllTabs([jobId]);
  await ensureDownloadWorker();
  const accepted = await chrome.runtime.sendMessage({
    type: "run-subtitle-job",
    jobId,
    input: subtitleInput,
    licenseKey: license.key,
  });
  if (!accepted?.ok) {
    await patchDownloadJob(jobId, {
      status: "failed",
      statusText: "자막 생성 작업을 시작하지 못했습니다.",
      error: accepted?.error || "subtitle-worker-unavailable",
    });
    throw new Error(accepted?.error || "subtitle-worker-unavailable");
  }
  await patchDownloadJob(jobId, { status: "running", statusText: "자막 생성 대기 중…" });
  return { jobId };
}

// Tab-focus pausing is owned by the background service worker because the
// offscreen document cannot access chrome.tabs / chrome.windows. The worker
// only receives pause-state messages over chrome.runtime.
const jobSourceTabs = new Map();
let downloadRecoveryStarted = false;

async function recoverInterruptedMediaDownloads() {
  if (downloadRecoveryStarted) return;
  downloadRecoveryStarted = true;
  await downloadJobsReady;
  const recoverable = [...downloadJobs.values()].filter((job) =>
    ["queued", "running", "paused"].includes(job.status) && downloadIntents.has(job.id));
  if (!recoverable.length) return;
  let activeJobIds = new Set();
  try {
    await ensureDownloadWorker();
    const state = await chrome.runtime.sendMessage({ type: "download-worker-state" });
    if (state?.ok && Array.isArray(state.activeJobIds)) activeJobIds = new Set(state.activeJobIds);
  } catch {
    activeJobIds = new Set();
  }
  const plan = await resolvePlan();
  for (const job of recoverable) {
    const intent = downloadIntents.get(job.id);
    const candidate = intent?.candidate;
    if (!candidate) continue;
    const sourceTabId = Number.isInteger(intent.sourceTabId) ? intent.sourceTabId : candidate.tabId;
    if (!plan.backgroundDownloads && Number.isInteger(sourceTabId)) {
      try {
        await chrome.tabs.get(sourceTabId);
        jobSourceTabs.set(job.id, sourceTabId);
      } catch {
        await patchDownloadJob(job.id, {
          status: "failed",
          statusText: "원래 탭이 닫혀 다운로드를 복구하지 못했습니다.",
          error: "source-tab-closed",
        });
        continue;
      }
    }
    if (activeJobIds.has(job.id)) continue;
    await patchDownloadJob(job.id, {
      status: "queued",
      statusText: "중단된 다운로드를 복구하는 중…",
    });
    await dispatchMediaDownload(job.id, candidate);
  }
}

void downloadJobsReady.then(recoverInterruptedMediaDownloads).catch(() => {});

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
    void applyTabPauseState(null);
    return;
  }
  void chrome.tabs.query({ active: true, windowId })
    .then((tabs) => applyTabPauseState(tabs[0]?.id))
    .catch(() => {});
});
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
  const downloaderId = candidate.downloaderId
    || downloaderIdForMediaType(candidate.mediaType, candidate.downloadMode);
  const mode = jobModeForDownloader(downloaderId);
  const job = createDownloadJob({
    id: jobId,
    title: candidate.pageTitle || "미디어 다운로드",
    mediaType: candidate.mediaType,
    candidateId: candidate.id,
    diagnostic: {
      resource: candidate.displayUrl || "",
      mediaType: candidate.mediaType,
      downloadMode: candidate.downloadMode || "UNKNOWN",
      downloaderId,
      providerId: candidate.providerId || "generic",
      siteId: candidate.siteId || "generic",
      frameId: candidate.frameId,
      player: candidate.player,
      sessionId: candidate.sessionId,
      source: candidate.evidence?.[0]?.source,
      requestType: candidate.evidence?.[0]?.requestType,
      main: candidate.main,
      score: candidate.score,
    },
    retryPayload: { kind: "media", candidate: structuredClone(candidate) },
  });
  downloadJobs.set(jobId, job);
  if (Number.isInteger(candidate?.tabId) && candidate.tabId > 0) {
    jobSourceTabs.set(jobId, candidate.tabId);
  }
  await Promise.all([
    persistDownloadJobs(),
    rememberDownloadIntent(jobId, candidate).catch(() => {}),
    rememberDownloadOverlayJob(jobId),
  ]);
  syncWorkerLifecycleAlarm();
  void syncDownloadOverlayForAllTabs([jobId]);
  void syncDownloadOverlayForActiveTab();
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
  if (candidate.mediaType === "DASH") return queueMediaDownload(candidate);
  throw new Error("unsupported-media");
}

async function retryDownloadJob(jobId) {
  await downloadJobsReady;
  const job = downloadJobs.get(jobId);
  if (!job) throw new Error("download-job-not-found");
  const payload = retryPayloadForJob(job);
  if (!payload) throw new Error("download-job-not-retryable");
  if (payload.kind === "media" && payload.candidate) {
    return beginCandidateDownload(payload.candidate);
  }
  if (payload.kind === "youtube") {
    return startYouTubeDownload(payload.url, payload.quality, { resumeFromJobId: jobId });
  }
  if (payload.kind === "subtitle" && payload.input) {
    return startSubtitleGeneration(payload.input);
  }
  throw new Error("download-job-not-retryable");
}

async function cancelDownloadJob(jobId) {
  await downloadJobsReady;
  const job = downloadJobs.get(jobId);
  if (!job) return { ok: false, error: "download-job-not-found" };
  if (terminalDownloadJob(job)) return { ok: true, alreadyTerminal: true };

  youtubeJobControllers.get(jobId)?.abort();
  if (job.source === "youtube" || job.source === "companion") {
    await cancelCompanionJob(jobId).catch(() => null);
    const poller = companionJobPollers.get(jobId);
    if (poller) {
      clearInterval(poller);
      companionJobPollers.delete(jobId);
    }
  }
  await patchDownloadJob(jobId, {
    status: "cancelled",
    statusText: "사용자가 다운로드를 취소했습니다.",
    error: "",
  });
  jobSourceTabs.delete(jobId);
  for (const [downloadId, mappedJobId] of youtubeBrowserDownloads) {
    if (mappedJobId !== jobId) continue;
    youtubeBrowserDownloads.delete(downloadId);
    await chrome.downloads.cancel(downloadId).catch(() => {});
  }
  await chrome.runtime.sendMessage({ type: "cancel-download-worker-job", jobId }).catch(() => null);
  return { ok: true };
}

async function releasePlaybackMediaLease(sender, tabId, leaseId) {
  if (!validPlaybackSender(sender) || !Number.isInteger(tabId) || tabId <= 0) {
    return { ok: false, error: "unauthorized" };
  }
  return releaseMediaFetchLeaseForTab(tabId, leaseId);
}

function touchPlaybackMediaLease(sender, tabId, leaseId) {
  if (!validPlaybackSender(sender) || !Number.isInteger(tabId) || tabId <= 0) {
    return { ok: false, error: "unauthorized" };
  }
  if (typeof leaseId !== "string" || leaseId.length === 0) return { ok: false, error: "invalid-lease" };
  const lease = mediaFetchLeases.get(leaseId);
  if (!lease || lease.tabId !== tabId) return { ok: false, error: "lease-not-found" };
  mediaFetchLeases.touch(leaseId);
  return { ok: true };
}

async function clearDownloadJobs(surface = "all") {
  await downloadJobsReady;
  let cleared = 0;
  for (const [jobId, job] of downloadJobs) {
    const jobSurface = job.candidateId ? "detect" : "link";
    if (!terminalDownloadJob(job) || (surface !== "all" && surface !== jobSurface)) continue;
    downloadJobs.delete(jobId);
    downloadIntents.delete(jobId);
    downloadOverlayJobIds.delete(jobId);
    jobSourceTabs.delete(jobId);
    cleared += 1;
  }
  if (cleared) {
    await Promise.all([
      persistDownloadJobs().catch(() => {}),
      persistDownloadIntents().catch(() => {}),
      persistDownloadOverlay().catch(() => {}),
    ]);
    void chrome.runtime.sendMessage({ type: "download-jobs-changed" }).catch(() => {});
  }
  return { ok: true, cleared };
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
  const stored = upsertCandidate(candidates, candidate, LIMITS.candidates);
  if (nonPersistent || stored.tokenized || playerCandidateHasQuery(stored)) nonPersistentCandidates.add(stored);
  if (Number.isInteger(stored.tabId)) rerankTabCandidates(stored.tabId);
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

function playbackLauncherSender(sender) {
  return exactExtensionPageSender(sender, "popup-play.html")
    || exactExtensionPageSender(sender, "popup.html");
}

function playerOwnsPlaybackSession(sender, sessionId) {
  if (!validPlayerSender(sender) || typeof sessionId !== "string") return false;
  try {
    return new URL(sender.url).searchParams.get("session") === sessionId;
  } catch {
    return false;
  }
}

function playbackMediaFamily(mediaType) {
  if (mediaType === MEDIA_TYPES.HLS_MASTER || mediaType === MEDIA_TYPES.HLS_MEDIA) return "HLS";
  return mediaType;
}

function bestPlaybackCandidateForTab(tabId, previousCandidate = null) {
  rerankTabCandidates(tabId);
  const family = playbackMediaFamily(previousCandidate?.mediaType);
  const ranked = [...candidates.values()]
    .filter((candidate) => candidate.tabId === tabId
      && isDownloadableMediaType(candidate.mediaType)
      && !candidate.likelyAdvertisement
      && !isLikelyHlsSegmentUrl(candidate.resourceUrl))
    .sort((left, right) => {
      const leftFamily = family && playbackMediaFamily(left.mediaType) === family ? 1 : 0;
      const rightFamily = family && playbackMediaFamily(right.mediaType) === family ? 1 : 0;
      return (rightFamily - leftFamily)
        || (Number(right.main) - Number(left.main))
        || (Number(right.score) - Number(left.score))
        || (Number(right.lastObservedAt) - Number(left.lastObservedAt));
    });
  return ranked[0] || null;
}

function alternatePlaybackCandidateForTab(tabId, previousCandidate = null) {
  rerankTabCandidates(tabId);
  const family = playbackMediaFamily(previousCandidate?.mediaType);
  const currentUrl = canonicalHttpUrl(previousCandidate?.resourceUrl)?.href || "";
  return [...candidates.values()]
    .filter((candidate) => candidate.tabId === tabId
      && isDownloadableMediaType(candidate.mediaType)
      && !candidate.likelyAdvertisement
      && (!family || playbackMediaFamily(candidate.mediaType) === family)
      && canonicalHttpUrl(candidate.resourceUrl)?.href !== currentUrl
      && !isLikelyHlsSegmentUrl(candidate.resourceUrl))
    .sort((left, right) => (Number(right.main) - Number(left.main))
      || (Number(right.score) - Number(left.score))
      || (Number(right.lastObservedAt) - Number(left.lastObservedAt)))[0] || null;
}

function playbackSessionPayload(session) {
  const candidate = session?.candidate;
  if (!candidate || !canonicalHttpUrl(candidate.resourceUrl) || !canonicalHttpUrl(candidate.pageUrl)) return null;
  return Object.freeze({
    sessionId: session.id,
    candidateId: candidate.id,
    resourceUrl: candidate.resourceUrl,
    referrer: candidate.pageUrl,
    pageTitle: candidate.pageTitle || "",
    mediaType: candidate.mediaType,
    tabId: Number.isInteger(candidate.tabId) ? candidate.tabId : null,
    frameId: Number.isInteger(candidate.frameId) ? candidate.frameId : null,
    player: candidate.player || "",
    playerSessionId: candidate.sessionId || "",
    tokenized: Boolean(candidate.tokenized),
    expiresAt: Number.isFinite(candidate.expiresAt) ? candidate.expiresAt : null,
    sourceUrl: session.sourceUrl || "",
  });
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

async function createPlaybackSessionForCandidate(candidateId, sourceUrl = "") {
  await downloadJobsReady;
  const candidate = [...candidates.values()].find((item) => item.id === candidateId);
  if (!candidate || !isDownloadableMediaType(candidate.mediaType)
    || isLikelyHlsSegmentUrl(candidate.resourceUrl) || candidate.likelyAdvertisement) {
    return { ok: false, error: "candidate-not-found" };
  }
  const fresh = await resolvePlayerCandidate(candidate);
  const session = playbackSessions.create(fresh, { sourceUrl });
  if (!session) return { ok: false, error: "playback-session-unavailable" };
  await persistPlaybackSessions().catch(() => {});
  const payload = playbackSessionPayload(session);
  return payload ? {
    ok: true,
    sessionId: session.id,
    pageTitle: payload.pageTitle,
    mediaType: payload.mediaType,
    tokenized: payload.tokenized,
  } : { ok: false, error: "playback-session-unavailable" };
}

async function createPlaybackSessionFromTab(sourceTabId, sourceUrl = "", previousMediaType = "") {
  await downloadJobsReady;
  if (!Number.isInteger(sourceTabId) || sourceTabId <= 0) {
    return { ok: false, error: "invalid-source-tab" };
  }
  const previousCandidate = previousMediaType ? { mediaType: previousMediaType } : null;
  const selected = bestPlaybackCandidateForTab(sourceTabId, previousCandidate);
  const candidate = selected ? await resolvePlayerCandidate(selected) : null;
  if (!candidate) return { ok: false, error: "source-media-not-detected" };
  const session = playbackSessions.create(candidate, { sourceUrl });
  if (!session) return { ok: false, error: "playback-session-unavailable" };
  await persistPlaybackSessions().catch(() => {});
  const payload = playbackSessionPayload(session);
  return payload ? { ok: true, session: payload } : { ok: false, error: "playback-session-invalid" };
}

async function resolvePlaybackSession(sessionId, {
  forceRefresh = false,
  sourceTabId = null,
  alternate = false,
} = {}) {
  await downloadJobsReady;
  let session = playbackSessions.get(sessionId);
  if (!session) return { ok: false, error: "playback-session-expired" };
  let candidate = session.candidate;
  const candidateTabId = Number.isInteger(sourceTabId) && sourceTabId > 0
    ? sourceTabId
    : candidate.tabId;
  if (Number.isInteger(candidateTabId) && candidateTabId > 0) {
    const replacement = alternate
      ? alternatePlaybackCandidateForTab(candidateTabId, candidate)
      : bestPlaybackCandidateForTab(candidateTabId, candidate);
    if (!replacement) return { ok: false, error: "source-media-not-detected" };
    let sourceUrl = session.sourceUrl;
    try {
      const tab = await chrome.tabs.get(candidateTabId);
      sourceUrl = canonicalHttpUrl(tab?.url)?.href || sourceUrl;
    } catch {
      // Keep the original source URL when the newly opened tab already closed.
    }
    const resolvedReplacement = await resolvePlayerCandidate(replacement);
    session = playbackSessions.updateCandidate(sessionId, resolvedReplacement, { sourceUrl });
  } else {
    const nearExpiry = candidate.tokenized
      && Number.isFinite(candidate.expiresAt)
      && candidate.expiresAt <= Date.now() + 30_000;
    if (forceRefresh || nearExpiry) {
      candidate = await refreshCandidateFromSourceFrame(candidate, { force: true });
      session = playbackSessions.updateCandidate(sessionId, candidate);
    }
  }
  if (!session) return { ok: false, error: "playback-session-expired" };
  await persistPlaybackSessions().catch(() => {});
  const payload = playbackSessionPayload(session);
  return payload ? { ok: true, session: payload } : { ok: false, error: "playback-session-invalid" };
}

async function closePlaybackSession(sessionId) {
  await downloadJobsReady;
  const removed = playbackSessions.remove(sessionId);
  if (removed) await persistPlaybackSessions().catch(() => {});
  return { ok: true, removed };
}

function recordRequestHeaders(details) {
  requestHeaderStore.record({
    url: details?.url,
    headers: details?.requestHeaders,
    tabId: details?.tabId,
    frameId: details?.frameId,
    initiator: details?.initiator || details?.documentUrl || "",
  });
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
  {
    urls: ["http://*/*", "https://*/*"],
    types: ["media", "xmlhttprequest", "other"],
  },
  ["requestHeaders", "extraHeaders"],
);

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
  void releaseMediaFetchLeasesForTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") {
    if (downloadOverlayJobIds.size) void syncDownloadOverlayForTab(tabId);
    return;
  }
  if (changeInfo.status !== "loading" || !changeInfo.url) return;
  mainFramesByTab.delete(tabId);
  frameLayoutsByTab.delete(tabId);
  frameStatesByTab.delete(tabId);
  tabTitleCache.delete(tabId);
  clearDoodDirectForTab(tabId);
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "mobile-ua-status" && !sender.tab) {
    void mobileUaRulesReady.then(() => sendResponse({
      ok: true,
      enabled: Number.isInteger(message.tabId) && mobileUaRulesByTab.has(message.tabId),
    }));
    return true;
  }

  if (message?.type === "mobile-ua-toggle" && !sender.tab) {
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

  if (message?.type === "cancel-download-job" && sender.id === chrome.runtime.id) {
    cancelDownloadJob(message.jobId).then(sendResponse, () => sendResponse({ ok: false, error: "cancel-failed" }));
    return true;
  }

  if (message?.type === "dismiss-download-overlay" && sender.id === chrome.runtime.id && sender.tab?.id) {
    downloadJobsReady.then(async () => {
      downloadOverlayJobIds.clear();
      await persistDownloadOverlay();
      await syncDownloadOverlayForAllTabs();
      sendResponse({ ok: true });
    }).catch(() => sendResponse({ ok: false, error: "overlay-dismiss-failed" }));
    return true;
  }

  if (message?.type === "clear-download-jobs" && !sender.tab) {
    clearDownloadJobs(message.surface === "detect" || message.surface === "link" ? message.surface : "all")
      .then(sendResponse, () => sendResponse({ ok: false, error: "clear-failed" }));
    return true;
  }

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

  if (message?.type === "list-download-jobs" && sender.id === chrome.runtime.id) {
    downloadJobsReady.then(() => sendResponse({
      type: "download-jobs",
      jobs: publicDownloadJobs(downloadJobs.values()),
    }));
    return true;
  }

  if (message?.type === "download-job-update"
    && sender.id === chrome.runtime.id
    && sender.url === chrome.runtime.getURL("download-worker.html")) {
    if (["completed", "failed", "cancelled"].includes(message.patch?.status)) {
      jobSourceTabs.delete(message.jobId);
    }
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

  if (message?.type === "start-subtitle-generation" && validPlayerPageSender(sender)) {
    startSubtitleGeneration(message.input).then(
      (result) => sendResponse({ ok: true, ...result }),
      (error) => sendResponse({ ok: false, error: error?.message || "subtitle-generation-failed" }),
    );
    return true;
  }

  if (message?.type === "create-playback-session" && playbackLauncherSender(sender)) {
    createPlaybackSessionForCandidate(message.candidateId, message.sourceUrl).then(
      sendResponse,
      () => sendResponse({ ok: false, error: "playback-session-unavailable" }),
    );
    return true;
  }

  if (message?.type === "create-playback-session-from-tab" && validPlayerSender(sender)) {
    createPlaybackSessionFromTab(
      message.sourceTabId,
      message.sourceUrl,
      typeof message.previousMediaType === "string" ? message.previousMediaType : "",
    ).then(
      sendResponse,
      () => sendResponse({ ok: false, error: "playback-session-unavailable" }),
    );
    return true;
  }

  if (message?.type === "resolve-playback-session"
    && playerOwnsPlaybackSession(sender, message.sessionId)) {
    resolvePlaybackSession(message.sessionId).then(
      sendResponse,
      () => sendResponse({ ok: false, error: "playback-session-unavailable" }),
    );
    return true;
  }

  if (message?.type === "refresh-playback-session"
    && playerOwnsPlaybackSession(sender, message.sessionId)) {
    const sourceTabId = Number.isInteger(message.sourceTabId) ? message.sourceTabId : null;
    resolvePlaybackSession(message.sessionId, {
      forceRefresh: sourceTabId === null,
      sourceTabId,
      alternate: message.alternate === true,
    }).then(
      sendResponse,
      () => sendResponse({ ok: false, error: "playback-session-refresh-failed" }),
    );
    return true;
  }

  if (message?.type === "close-playback-session"
    && playerOwnsPlaybackSession(sender, message.sessionId)) {
    closePlaybackSession(message.sessionId).then(sendResponse, () => sendResponse({ ok: false }));
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

  if (message?.type === "list-candidates" && playbackLauncherSender(sender)) {
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

  if (message?.type === "probe-progressive-candidate" && playbackLauncherSender(sender)) {
    const candidate = [...candidates.values()].find((item) => item.id === message.candidateId);
    if (!candidate || candidate.mediaType !== MEDIA_TYPES.PROGRESSIVE) {
      sendResponse({ ok: false, error: "progressive-candidate-not-found" });
      return false;
    }
    (async () => {
      const refreshed = await resolvePlayerCandidate(candidate);
      await ensureDownloadWorker();
      const probe = await chrome.runtime.sendMessage({
        type: "worker-probe-progressive-candidate",
        candidate: refreshed,
      });
      if (!probe?.ok) return { ok: false, error: probe?.error || "progressive-probe-failed" };
      return {
        ok: true,
        candidateId: candidate.id,
        totalBytes: Number.isFinite(probe.totalBytes) ? probe.totalBytes : null,
        rangeSupported: probe.rangeSupported === true,
        contentKind: ["media", "binary", "unknown"].includes(probe.contentKind) ? probe.contentKind : "unknown",
      };
    })().then(sendResponse, () => sendResponse({ ok: false, error: "progressive-probe-failed" }));
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

  if (message?.type === "refresh-download-candidate" && validMediaRouteSender(sender)) {
    const requested = message.candidate && typeof message.candidate === "object" ? message.candidate : null;
    const candidate = requested?.id
      ? [...candidates.values()].find((item) => item.id === requested.id) || requested
      : requested;
    if (!candidate || !canonicalHttpUrl(candidate.resourceUrl)) {
      sendResponse({ ok: false, error: "invalid-refresh-candidate" });
      return false;
    }
    refreshCandidateFromSourceFrame(candidate, { force: true }).then(
      (refreshed) => sendResponse({
        ok: true,
        refreshed: refreshed.resourceUrl !== candidate.resourceUrl,
        candidate: refreshed,
      }),
      () => sendResponse({ ok: false, error: "media-source-refresh-failed" }),
    );
    return true;
  }

  if (message?.type === "prepare-media-fetch") {
    prepareMediaFetchLease(
      sender,
      message.url,
      message.referrer,
      message.sourceContext,
      message.consumer,
    ).then(sendResponse);
    return true;
  }

  if (message?.type === "get-media-request-diagnostics"
    && (validPlayerPageSender(sender) || playbackLauncherSender(sender) || validDownloadWorkerSender(sender))) {
    const consumer = typeof message.consumer === "string" ? message.consumer : "";
    const limit = Number.isInteger(message.limit) ? message.limit : 100;
    sendResponse({ ok: true, requests: mediaRequestDiagnostics.list({ consumer, limit }) });
    return false;
  }

  if (message?.type === "clear-media-request-diagnostics" && playbackLauncherSender(sender)) {
    mediaRequestDiagnostics.clear();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "prepare-playback-media") {
    preparePlaybackMediaLease(sender, message).then(sendResponse);
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

  if (message?.type === "release-playback-media") {
    releasePlaybackMediaLease(sender, Number(message.tabId), message.leaseId).then(sendResponse);
    return true;
  }

  if (message?.type === "touch-playback-media") {
    sendResponse(touchPlaybackMediaLease(sender, Number(message.tabId), message.leaseId));
    return false;
  }

  if (message?.type === "decode-hls-key" && validMediaRouteSender(sender)) {
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

  if (message?.type === "download-in-source-frame" && validMediaRouteSender(sender)) {
    const tabId = Number(message.tabId);
    const frameId = message.frameId == null ? null : Number(message.frameId);
    const url = canonicalMediaFetchUrl(message.url);
    const requestId = typeof message.requestId === "string" && /^[a-z0-9-]{8,80}$/i.test(message.requestId)
      ? message.requestId : "";
    const filename = typeof message.filename === "string"
      ? message.filename.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 240)
      : "";
    if (!Number.isInteger(tabId) || tabId <= 0 || (frameId != null && (!Number.isInteger(frameId) || frameId < 0))
      || !url || !isLikelyDoodMediaHost(url) || !filename || !requestId) {
      sendResponse({ ok: false, error: "invalid-source-download" });
      return false;
    }
    const options = frameId == null ? null : { frameId };
    void browserDownloadMonitor.capture({
      requestId,
      url,
      trigger: async () => {
        const response = await sendTabMessageWithTimeout(
          tabId,
          { type: "download-direct", url, filename },
          8_000,
          options,
        );
        return response?.ok === true;
      },
    }).then(
      (result) => sendResponse({ ok: true, ...result }),
      (error) => sendResponse({ ok: false, error: error?.code || "source-frame-unavailable" }),
    );
    return true;
  }

  if (message?.type === "cancel-browser-download" && validMediaRouteSender(sender)) {
    const requestId = typeof message.requestId === "string" ? message.requestId : "";
    void browserDownloadMonitor.cancel(requestId).then((cancelled) => sendResponse({ ok: true, cancelled }));
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

  if (message?.type === "get-request-headers" && validMediaRouteSender(sender)) {
    sendResponse({ ok: true, headers: {}, capability: "dnr-contextual-replay-v1" });
    return false;
  }

  if (message?.type === "ping-media-stream" && validMediaRouteSender(sender)) {
    sendResponse({
      ok: true,
      version: chrome.runtime.getManifest().version,
      capabilities: { mediaFetchLease: 1, mediaRequestDiagnostics: 1 },
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
        devices: typeof stored?.devices === "number" ? stored.devices : null,
        limit: typeof stored?.limit === "number" ? stored.limit : null,
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
      const stored = await getStoredLicense();
      const edition = await resolveEdition();
      sendResponse({
        ok: true,
        edition,
        devices: typeof stored?.devices === "number" ? stored.devices : null,
        limit: typeof stored?.limit === "number" ? stored.limit : null,
      });
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
          const sniffed = await sniffMediaContentType(targetUrl);
          if (/mpegurl|vnd\.apple\.mpegurl/i.test(sniffed)) {
            hls = true;
          } else if (/dash\+xml/i.test(sniffed)) {
            dash = true;
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
        contentType: progressive ? "video/mp4"
          : dash ? "application/dash+xml" : "application/vnd.apple.mpegurl",
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

  if (message?.type === "browser-download" && sender.id === chrome.runtime.id) {
    const resourceUrl = canonicalHttpUrl(message.url);
    const requestId = typeof message.requestId === "string" && /^[a-z0-9-]{8,80}$/i.test(message.requestId)
      ? message.requestId : "";
    if (!resourceUrl || !requestId) {
      sendResponse({ ok: false, error: "invalid-url" });
      return false;
    }
    const rawName = typeof message.filename === "string" ? message.filename : "";
    const safeName = (rawName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\.+$/, "").trim()
      || "download.mp4").slice(0, 180);
    (async () => {
      try {
        const result = await browserDownloadMonitor.start({
          requestId,
          url: resourceUrl.href,
          options: {
            url: resourceUrl.href,
            filename: safeName,
            conflictAction: "uniquify",
            saveAs: false,
          },
        });
        sendResponse({ ok: true, ...result });
      } catch (error) {
        sendResponse({ ok: false, error: error?.code || "download-failed", message: error?.message || "" });
      }
    })();
    return true;
  }

  if (!sender.tab?.url || sender.id !== chrome.runtime.id) return false;
  const sanitized = sanitizePageMessage({
    ...message,
    pageTitle: message.pageTitle || sender.tab.title || "",
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
  if (isHeartbeatPortName(port.name) && port.sender?.id === chrome.runtime.id) {
    workerHeartbeatPorts.add(port);
    syncWorkerLifecycleAlarm();
    port.onMessage.addListener(() => syncWorkerLifecycleAlarm());
    port.onDisconnect.addListener(() => {
      workerHeartbeatPorts.delete(port);
      syncWorkerLifecycleAlarm();
    });
    return;
  }
  if (port.name === "media-stream" && validMediaRouteSender(port.sender)) {
    async function freshDoodDirect(tabId, preferredFrameId) {
      const states = frameStatesByTab.get(tabId) || new Map();
      const rankedFrameIds = [...states.entries()]
        .filter(([frameId]) => Number.isInteger(frameId) && frameId >= 0)
        .sort((left, right) => {
          const leftState = left[1] || {};
          const rightState = right[1] || {};
          if (Boolean(leftState.playing) !== Boolean(rightState.playing)) return rightState.playing ? 1 : -1;
          return Number(rightState.visibleArea || 0) - Number(leftState.visibleArea || 0);
        })
        .map(([frameId]) => frameId);
      const frameIds = [...new Set([
        ...(Number.isInteger(preferredFrameId) && preferredFrameId >= 0 ? [preferredFrameId] : []),
        ...rankedFrameIds,
      ])];
      if (!frameIds.length) frameIds.push(null);
      for (const frameId of frameIds) {
        const response = await sendTabMessageWithTimeout(
          tabId,
          { type: "get-dood-direct" },
          3_000,
          frameId == null ? null : { frameId },
        );
        const url = response?.ok && typeof response.url === "string" ? canonicalHttpUrl(response.url)?.href : null;
        const frameUrl = typeof response?.frameUrl === "string" ? canonicalHttpUrl(response.frameUrl)?.href : null;
        if (url) return { url, frameUrl, frameId };
      }
      const cacheFrameIds = Number.isInteger(preferredFrameId) && preferredFrameId >= 0
        ? [preferredFrameId]
        : rankedFrameIds;
      for (const frameId of cacheFrameIds) {
        const cached = doodDirectByFrame.get(`${tabId}:${frameId}`);
        if (cached && Date.now() - cached.at < DOOD_DIRECT_CACHE_TTL_MS) return cached;
      }
      return null;
    }

    async function resolveFreshUrl(message, signal) {
      let url = message.url;
      let referrer = typeof message.pageUrl === "string" ? message.pageUrl : "";
      let videoFrameId = Number.isInteger(message.videoFrameId) && message.videoFrameId >= 0
        ? message.videoFrameId : null;
      await ensureDirectMediaAccess([url, referrer, message.pageUrl].filter(Boolean));
      let resolvedForTransfer = false;
      if (Number.isInteger(message.videoTabId) && message.videoTabId > 0) {
        // The player iframe's content script re-resolves /pass_md5 in its own
        // context, giving a fresh token URL and the exact Referer the CDN
        // expects (the /e/ player frame, not the outer page).
        const fresh = await freshDoodDirect(message.videoTabId, videoFrameId);
        if (fresh?.url) {
          url = fresh.url;
          if (fresh.frameUrl) referrer = fresh.frameUrl;
          if (Number.isInteger(fresh.frameId)) videoFrameId = fresh.frameId;
          resolvedForTransfer = true;
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
        return { url: prepared.url, referrer: prepared.referrer, videoFrameId };
      } catch (error) {
        const recovery = authenticatedRecoveryForProgressiveError(error, { url, referrer });
        if (recovery) return { ...recovery, videoFrameId };
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
        const { url, referrer, authenticatedProbeRequired, videoFrameId } = await resolveFreshUrl(message, signal);
        if (signal.aborted || disconnected) return;
        port.postMessage({
          type: "fetch-required",
          url,
          referrer,
          ...(Number.isInteger(videoFrameId) ? { videoFrameId } : {}),
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
