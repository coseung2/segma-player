import Hls from "./vendor/hls.min.mjs";
import { createContextualHlsLoader } from "./contextual-hls-loader.js";
import { hlsPlaybackRecoveryDecision } from "./hls-playback-recovery.js";
import { cuesAt, cuesToSrt, decodeSubtitleBytes, findSubtitleFile, mediaIdentifier, parseSubtitle } from "./player-subtitle.js";
import { createUniqueFile } from "./save-directory.js";
import { ensureStoredSubtitleDirectory, getStoredSubtitleDirectory } from "./subtitle-folder.js";
import {
  addToCollection,
  createCollectionFolder,
  listCollectionFolders,
  replaceInCollection,
} from "./collection.js";
import { resolveEdition } from "./license.js";
import { loadLocale } from "../../i18n.js";
import { loadGeneratedSubtitle } from "./subtitle-generation.js";

const NO_SUBTITLE_MESSAGES = {
  ko: "자막을 찾지 못했습니다 — 자막 없이 재생합니다",
  en: "No subtitle found — playing without subtitles",
  ja: "字幕が見つかりません — 字幕なしで再生します",
  zh: "未找到字幕 — 将不带字幕播放",
};

const AUTO_SUBTITLE_MESSAGES = {
  ko: { generate: "자막 생성", generating: "자막 생성 중…", ready: "자막 준비됨", failed: "자막 생성 실패", empty: "인식된 대사가 없습니다", save: "SRT 저장", saved: "SRT 저장됨", folder: "자막 폴더를 먼저 선택해 주세요", saveFailed: "SRT 저장 실패" },
  en: { generate: "Generate subtitles", generating: "Generating subtitles…", ready: "Subtitles ready", failed: "Subtitle generation failed", empty: "No speech was recognized", save: "Save SRT", saved: "SRT saved", folder: "Select a subtitle folder first", saveFailed: "Could not save SRT" },
  ja: { generate: "字幕を生成", generating: "字幕を生成中…", ready: "字幕を準備しました", failed: "字幕生成に失敗しました", empty: "認識できる発話がありません", save: "SRT を保存", saved: "SRT を保存しました", folder: "先に字幕フォルダを選択してください", saveFailed: "SRT を保存できませんでした" },
  zh: { generate: "生成字幕", generating: "正在生成字幕…", ready: "字幕已准备好", failed: "字幕生成失败", empty: "没有识别到语音", save: "保存 SRT", saved: "已保存 SRT", folder: "请先选择字幕文件夹", saveFailed: "无法保存 SRT" },
};

const COLLECTION_MESSAGES = {
  ko: {
    save: "즐겨찾기에 저장",
    saved: "저장됨",
    folderLabel: "저장 폴더",
    newFolder: "새 폴더",
    folderPlaceholder: "새 폴더 이름",
    create: "만들기",
    cancel: "취소",
    confirm: "저장",
    folderCreateFailed: "폴더를 만들지 못했습니다.",
    saveFailed: "즐겨찾기에 저장하지 못했습니다.",
  },
  en: {
    save: "Save to bookmarks",
    saved: "Saved",
    folderLabel: "Save folder",
    newFolder: "New folder",
    folderPlaceholder: "New folder name",
    create: "Create",
    cancel: "Cancel",
    confirm: "Save",
    folderCreateFailed: "Could not create the folder.",
    saveFailed: "Could not save the bookmark.",
  },
  ja: {
    save: "ブックマークに保存",
    saved: "保存しました",
    folderLabel: "保存先フォルダー",
    newFolder: "新しいフォルダー",
    folderPlaceholder: "フォルダー名",
    create: "作成",
    cancel: "キャンセル",
    confirm: "保存",
    folderCreateFailed: "フォルダーを作成できませんでした。",
    saveFailed: "ブックマークを保存できませんでした。",
  },
  zh: {
    save: "保存到书签",
    saved: "已保存",
    folderLabel: "保存文件夹",
    newFolder: "新建文件夹",
    folderPlaceholder: "文件夹名称",
    create: "创建",
    cancel: "取消",
    confirm: "保存",
    folderCreateFailed: "无法创建文件夹。",
    saveFailed: "无法保存书签。",
  },
};

const params = new URLSearchParams(location.search);
const requestedTitle = params.get("title") || "";
const subtitleSession = params.get("sub") || "";
const legacyCollection = params.get("collection") === "1";
let playbackSessionId = params.get("session") || "";
let mediaUrl = safeHttpUrl(params.get("url")) || "";
let sourceUrl = safeHttpUrl(params.get("source")) || "";
let pageTitle = requestedTitle;
let mediaType = "";
let sourceTabId = null;
let sourceFrameId = null;
let exactReferrer = sourceUrl;
let tokenized = hasTokenQuery(mediaUrl);
let proActive = false;
let refreshInProgress = false;
let automaticRefreshUsed = false;
let recoveryInProgress = false;
let noSubtitleMessage = NO_SUBTITLE_MESSAGES.ko;
let collectionMessages = COLLECTION_MESSAGES.ko;
let autoSubtitleMessages = AUTO_SUBTITLE_MESSAGES.ko;
let subtitleUpdate = null;
let playbackTabId = null;
let playbackLeaseId = "";
let playbackLeaseTimer = null;
let hls = null;
let directLeaseId = null;
let directLeaseHeartbeat = null;
const video = document.getElementById("video");
const titleElement = document.getElementById("title");
const subtitleElement = document.getElementById("subtitle");
const subtitleTag = document.getElementById("subtitle-tag");
const message = document.getElementById("message");
const saveButton = document.getElementById("save");
const generateSubtitleButton = document.getElementById("generate-subtitle");
const saveSubtitleButton = document.getElementById("save-subtitle");
const subtitleSourceLanguage = document.getElementById("subtitle-source-language");
const subtitleProgressElement = document.getElementById("subtitle-progress");
const collectionPicker = document.getElementById("collection-picker");
const collectionFolder = document.getElementById("collection-folder");
const collectionFolderLabel = document.getElementById("collection-folder-label");
const collectionNewFolderButton = document.getElementById("collection-new-folder");
const collectionNewFolderRow = document.getElementById("collection-new-folder-row");
const collectionNewFolderInput = document.getElementById("collection-new-folder-input");
const collectionCreateFolderButton = document.getElementById("collection-create-folder");
const collectionCancelButton = document.getElementById("collection-cancel");
const collectionConfirmButton = document.getElementById("collection-confirm");
saveButton.hidden = true;
let generatedSubtitleVtt = "";
let subtitleProgressStartedAt = 0;
let subtitleProgressTimer = null;
let activeSubtitleJobId = "";
let activeSubtitleInput = null;
let subtitleJobPollTimer = null;

function safeHttpUrl(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function hasTokenQuery(value) {
  try {
    const url = new URL(value);
    for (const name of url.searchParams.keys()) {
      if (/(?:^|[-_])(?:auth|authorization|expires?|expiry|hdnts?|jwt|key|policy|session|sig|signature|ticket|token)(?:$|[-_])/i.test(name)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function showToast(text) {
  const toast = document.createElement("p");
  toast.className = "player-toast";
  toast.textContent = text;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 2800);
}

function bindSubtitleCues(cues) {
  if (subtitleUpdate) {
    video.removeEventListener("timeupdate", subtitleUpdate);
    video.removeEventListener("seeking", subtitleUpdate);
  }
  if (!cues.length) {
    subtitleTag.hidden = true;
    return false;
  }
  subtitleUpdate = () => {
    const cue = cuesAt(cues, video.currentTime);
    subtitleElement.hidden = !cue;
    subtitleElement.textContent = cue?.text || "";
  };
  subtitleTag.hidden = false;
  video.addEventListener("timeupdate", subtitleUpdate);
  video.addEventListener("seeking", subtitleUpdate);
  subtitleUpdate();
  return true;
}

function fail(text, { refresh = false } = {}) {
  message.hidden = false;
  message.replaceChildren();
  const textElement = document.createElement("p");
  textElement.textContent = text;
  message.append(textElement);
  if (refresh && sourceUrl) {
    const refreshButton = document.createElement("button");
    refreshButton.type = "button";
    refreshButton.className = "message-action";
    refreshButton.textContent = "원본에서 새 주소 가져오기";
    refreshButton.addEventListener("click", () => refreshFromSource(refreshButton));
    message.append(refreshButton);
  }
}

async function preparePlaybackMedia() {
  if (!sourceUrl || !mediaUrl || typeof chrome.tabs?.getCurrent !== "function") return;
  try {
    const tab = await chrome.tabs.getCurrent();
    if (!Number.isInteger(tab?.id)) return;
    const response = await chrome.runtime.sendMessage({
      type: "prepare-playback-media",
      tabId: tab.id,
      url: mediaUrl,
      referrer: exactReferrer || sourceUrl,
    });
    if (!response?.ok || typeof response.leaseId !== "string") return;
    playbackTabId = tab.id;
    playbackLeaseId = response.leaseId;
    if (playbackLeaseTimer !== null) clearInterval(playbackLeaseTimer);
    playbackLeaseTimer = setInterval(() => {
      void chrome.runtime.sendMessage({
        type: "touch-playback-media",
        tabId: playbackTabId,
        leaseId: playbackLeaseId,
      }).catch(() => {});
    }, 60_000);
  } catch {
    // Playback can still proceed when a provider does not need a referrer.
  }
}

function releasePlaybackMedia() {
  if (playbackLeaseTimer !== null) {
    clearInterval(playbackLeaseTimer);
    playbackLeaseTimer = null;
  }
  if (!playbackLeaseId || !Number.isInteger(playbackTabId)) return;
  void chrome.runtime.sendMessage({
    type: "release-playback-media",
    tabId: playbackTabId,
    leaseId: playbackLeaseId,
  }).catch(() => {});
  playbackLeaseId = "";
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function playbackPayload(response) {
  const payload = response?.ok && response.session && typeof response.session === "object"
    ? response.session
    : null;
  const resourceUrl = safeHttpUrl(payload?.resourceUrl);
  const referrer = safeHttpUrl(payload?.referrer);
  if (!payload || !resourceUrl || !referrer) return null;
  return {
    ...payload,
    resourceUrl,
    referrer,
    sourceUrl: safeHttpUrl(payload.sourceUrl),
  };
}

function applyPlaybackPayload(payload) {
  playbackSessionId = typeof payload.sessionId === "string" ? payload.sessionId : playbackSessionId;
  mediaUrl = payload.resourceUrl;
  exactReferrer = payload.referrer;
  sourceUrl = payload.sourceUrl || sourceUrl;
  pageTitle = requestedTitle || payload.pageTitle || pageTitle;
  mediaType = typeof payload.mediaType === "string" ? payload.mediaType : "";
  sourceTabId = Number.isInteger(payload.tabId) ? payload.tabId : null;
  sourceFrameId = Number.isInteger(payload.frameId) ? payload.frameId : null;
  tokenized = Boolean(payload.tokenized || hasTokenQuery(mediaUrl));
  if (pageTitle) titleElement.textContent = pageTitle;
  saveButton.hidden = tokenized;
}

function replaceAddressWithSession() {
  if (!playbackSessionId) return;
  const next = new URLSearchParams({ session: playbackSessionId });
  if (requestedTitle) next.set("title", requestedTitle.slice(0, 240));
  if (subtitleSession) next.set("sub", subtitleSession);
  if (proActive) next.set("pro", "1");
  history.replaceState(null, "", `${location.pathname}?${next.toString()}`);
}

async function resolveInitialPlayback() {
  if (!playbackSessionId) return Boolean(mediaUrl);
  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: "resolve-playback-session",
      sessionId: playbackSessionId,
    });
  } catch {
    return false;
  }
  const payload = playbackPayload(response);
  if (!payload) return false;
  applyPlaybackPayload(payload);
  return true;
}

async function refreshExistingSession(sourceTab = null, alternate = false) {
  if (!playbackSessionId) return null;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "refresh-playback-session",
      sessionId: playbackSessionId,
      ...(Number.isInteger(sourceTab) ? { sourceTabId: sourceTab } : {}),
      ...(alternate ? { alternate: true } : {}),
    });
    return playbackPayload(response);
  } catch {
    return null;
  }
}

async function createSessionFromSourceTab(sourceTab) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "create-playback-session-from-tab",
      sourceTabId: sourceTab,
      sourceUrl,
      previousMediaType: mediaType,
    });
    return playbackPayload(response);
  } catch {
    return null;
  }
}

async function refreshFromSource(button) {
  if (refreshInProgress || !sourceUrl) return;
  refreshInProgress = true;
  button.disabled = true;
  button.textContent = "원본에서 다시 감지하는 중…";
  let sourceTab = null;
  const previousMediaUrl = mediaUrl;
  try {
    sourceTab = await chrome.tabs.create({ url: sourceUrl, active: true });
    let fresh = null;
    for (let attempt = 0; attempt < 20 && !fresh; attempt += 1) {
      await wait(attempt === 0 ? 1_500 : 1_000);
      fresh = playbackSessionId
        ? await refreshExistingSession(sourceTab?.id)
        : await createSessionFromSourceTab(sourceTab?.id);
    }
    if (!fresh) {
      fail("원본 페이지에서 새 미디어 주소를 찾지 못했습니다.");
      return;
    }
    applyPlaybackPayload(fresh);
    replaceAddressWithSession();
    if (legacyCollection && !tokenized && previousMediaUrl) {
      await replaceInCollection(previousMediaUrl, {
        url: mediaUrl,
        title: pageTitle,
        sourceUrl,
      }).catch(() => {});
    }
    if (sourceTab?.id) await chrome.tabs.remove(sourceTab.id).catch(() => {});
    automaticRefreshUsed = false;
    await startPlayback();
  } catch {
    fail("원본 페이지를 다시 확인하지 못했습니다.");
  } finally {
    refreshInProgress = false;
    button.disabled = false;
  }
}

function cleanupSubtitleSessions() {
  chrome.storage.local.get(null, (all) => {
    const now = Date.now();
    const stale = Object.keys(all || {}).filter(
      (key) => key.startsWith("auraSubtitleSession:") && now - (all[key]?.at || 0) > 10 * 60 * 1000,
    );
    if (stale.length) chrome.storage.local.remove(stale);
  });
}

async function loadSubtitles() {
  if (!proActive) return;
  let text = "";
  try {
    if (subtitleSession) {
      const stored = await chrome.storage.local.get(`auraSubtitleSession:${subtitleSession}`);
      const session = stored[`auraSubtitleSession:${subtitleSession}`];
      await chrome.storage.local.remove(`auraSubtitleSession:${subtitleSession}`);
      text = session?.text || "";
    } else if (legacyCollection) {
      const handle = await getStoredSubtitleDirectory();
      const found = await findSubtitleFile(handle, pageTitle, mediaUrl);
      if (found) text = await decodeSubtitleBytes(new Uint8Array(await found.file.arrayBuffer()));
    }
    const cues = parseSubtitle(text);
    if (!cues.length) {
      showToast(noSubtitleMessage);
      return;
    }
    bindSubtitleCues(cues);
  } catch {
    // Subtitle overlay is best-effort; playback continues without it.
  }
}

async function refreshPlanGate() {
  proActive = (await resolveEdition()) === "pro";
  saveButton.hidden = tokenized;
  generateSubtitleButton.hidden = !proActive;
  subtitleSourceLanguage.hidden = !proActive;
}

function setCollectionLocale(locale) {
  collectionMessages = COLLECTION_MESSAGES[locale] || COLLECTION_MESSAGES.ko;
  saveButton.textContent = collectionMessages.save;
  collectionFolderLabel.textContent = collectionMessages.folderLabel;
  collectionNewFolderButton.textContent = collectionMessages.newFolder;
  collectionNewFolderInput.placeholder = collectionMessages.folderPlaceholder;
  collectionCreateFolderButton.textContent = collectionMessages.create;
  collectionCancelButton.textContent = collectionMessages.cancel;
  collectionConfirmButton.textContent = collectionMessages.confirm;
}

function closeCollectionPicker() {
  collectionPicker.hidden = true;
  collectionNewFolderRow.hidden = true;
  collectionNewFolderInput.value = "";
}

async function refreshCollectionFolders(selectedId = null) {
  collectionFolder.replaceChildren();
  let folders = [];
  try {
    folders = await listCollectionFolders();
  } catch {
    folders = [];
  }
  if (!folders.length) {
    folders = [{ id: "", title: "Aura Media", root: true }];
  }
  for (const folder of folders) {
    const option = document.createElement("option");
    option.value = folder.id || "";
    option.textContent = folder.title || "Aura Media";
    option.selected = selectedId !== null ? option.value === selectedId : Boolean(folder.root);
    collectionFolder.append(option);
  }
}

async function openCollectionPicker() {
  await refreshCollectionFolders();
  collectionPicker.hidden = false;
  collectionFolder.focus();
}

async function createCollectionFolderFromPicker() {
  const title = collectionNewFolderInput.value.trim();
  if (!title) {
    collectionNewFolderInput.focus();
    return;
  }
  collectionCreateFolderButton.disabled = true;
  try {
    const folder = await createCollectionFolder(title);
    if (!folder?.id) {
      showToast(collectionMessages.folderCreateFailed);
      return;
    }
    await refreshCollectionFolders(folder.id);
    collectionNewFolderRow.hidden = true;
    collectionNewFolderInput.value = "";
  } finally {
    collectionCreateFolderButton.disabled = false;
  }
}

async function saveSelectedCollection() {
  collectionConfirmButton.disabled = true;
  try {
    if (tokenized) {
      showToast("만료되는 인증 주소는 컬렉션에 저장하지 않습니다.");
      return;
    }
    const saved = await addToCollection(
      { title: pageTitle, url: mediaUrl, sourceUrl },
      collectionFolder.value || null,
    );
    if (!saved) {
      showToast(collectionMessages.saveFailed);
      return;
    }
    saveButton.textContent = collectionMessages.saved;
    saveButton.disabled = true;
    closeCollectionPicker();
  } finally {
    collectionConfirmButton.disabled = false;
  }
}

async function acquireMediaLease(url, consumer = "playback-media") {
  const response = await chrome.runtime.sendMessage({
    type: "prepare-media-fetch",
    url,
    referrer: exactReferrer,
    consumer,
    sourceContext: {
      tabId: sourceTabId,
      frameId: sourceFrameId,
      initiator: exactReferrer,
    },
  });
  if (!response?.ok || response.leaseId == null) {
    throw new Error(response?.error || "media-context-unavailable");
  }
  if (response.requestContext && globalThis.__auraPlaybackDiagnostics) {
    const requestContexts = globalThis.__auraPlaybackDiagnostics.requestContexts;
    if (Array.isArray(requestContexts)) {
      requestContexts.push(response.requestContext);
      if (requestContexts.length > 24) requestContexts.shift();
    }
  }
  return response.leaseId;
}

async function releaseMediaLease(leaseId) {
  if (leaseId == null) return;
  await chrome.runtime.sendMessage({ type: "release-media-fetch", leaseId }).catch(() => {});
}

async function releaseDirectLease() {
  if (directLeaseHeartbeat !== null) {
    clearInterval(directLeaseHeartbeat);
    directLeaseHeartbeat = null;
  }
  const leaseId = directLeaseId;
  directLeaseId = null;
  await releaseMediaLease(leaseId);
}

async function stopPlayback() {
  video.onerror = null;
  if (hls) {
    try { hls.destroy(); } catch { /* best effort */ }
    hls = null;
  }
  await releaseDirectLease();
  try {
    video.removeAttribute("src");
    video.load();
  } catch {
    // The media element may already be detached during page shutdown.
  }
}

async function attemptAutomaticRefresh({ alternate = false } = {}) {
  if (!playbackSessionId || automaticRefreshUsed) return false;
  automaticRefreshUsed = true;
  const fresh = await refreshExistingSession(
    alternate && Number.isInteger(sourceTabId) ? sourceTabId : null,
    alternate,
  );
  if (!fresh) return false;
  applyPlaybackPayload(fresh);
  await startPlayback();
  return true;
}

async function handlePlaybackFailure({ alternate = false } = {}) {
  if (recoveryInProgress) return;
  recoveryInProgress = true;
  try {
    if (await attemptAutomaticRefresh({ alternate })) return;
    fail("재생에 실패했습니다. 주소가 만료되었거나 서버에서 거부했습니다.", {
      refresh: Boolean(sourceUrl),
    });
  } finally {
    recoveryInProgress = false;
  }
}

function hlsMedia() {
  return mediaType === "HLS_MASTER" || mediaType === "HLS_MEDIA"
    || /\.m3u8(?:[?#]|$)/i.test(mediaUrl);
}

async function startHlsPlayback() {
  if (!Hls.isSupported()) {
    fail("이 브라우저는 HLS 재생을 지원하지 않습니다.");
    return;
  }
  const Loader = createContextualHlsLoader(Hls.DefaultConfig.loader, {
    acquire: (url) => acquireMediaLease(url, "playback-hls"),
    release: (leaseId) => releaseMediaLease(leaseId),
  });
  hls = new Hls({
    loader: Loader,
    xhrSetup(xhr) {
      xhr.withCredentials = true;
    },
  });
  const diagnostics = {
    mediaAttached: false,
    manifestParsed: false,
    fragmentLoading: false,
    fragmentLoaded: false,
    fragmentParsed: false,
    fragmentBuffered: false,
    requestContexts: [],
    events: [],
    error: null,
    recovery: null,
  };
  globalThis.__auraPlaybackDiagnostics = diagnostics;
  const fragmentState = (data) => ({
    sn: Number.isFinite(data?.frag?.sn) ? data.frag.sn : null,
    level: Number.isFinite(data?.frag?.level) ? data.frag.level : null,
    type: typeof data?.frag?.type === "string" ? data.frag.type : "",
  });
  const note = (event, detail = {}) => {
    diagnostics.events.push({ event, at: Date.now(), ...detail });
    if (diagnostics.events.length > 40) diagnostics.events.shift();
  };
  hls.on(Hls.Events.MEDIA_ATTACHED, () => {
    diagnostics.mediaAttached = true;
    note("media-attached");
  });
  hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
    diagnostics.manifestParsed = true;
    note("manifest-parsed", {
      levels: Array.isArray(data?.levels) ? data.levels.length : 0,
      audioTracks: Array.isArray(data?.audioTracks) ? data.audioTracks.length : 0,
    });
  });
  hls.on(Hls.Events.FRAG_LOADING, (_event, data) => {
    diagnostics.fragmentLoading = true;
    note("fragment-loading", fragmentState(data));
  });
  hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
    diagnostics.fragmentLoaded = true;
    note("fragment-loaded", fragmentState(data));
  });
  hls.on(Hls.Events.FRAG_PARSED, (_event, data) => {
    diagnostics.fragmentParsed = true;
    note("fragment-parsed", fragmentState(data));
  });
  hls.on(Hls.Events.FRAG_BUFFERED, (_event, data) => {
    diagnostics.fragmentBuffered = true;
    note("fragment-buffered", fragmentState(data));
  });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    const decision = hlsPlaybackRecoveryDecision(data);
    diagnostics.error = {
      type: String(data?.type || ""),
      details: String(data?.details || ""),
      fatal: data?.fatal === true,
      classification: decision.classification,
    };
    note("error", diagnostics.error);
    if (!decision.recover) return;
    diagnostics.recovery = {
      alternate: decision.alternate,
      classification: decision.classification,
      at: Date.now(),
    };
    void handlePlaybackFailure({ alternate: decision.alternate });
  });
  hls.loadSource(mediaUrl);
  hls.attachMedia(video);
}

function subtitleProgressLabel(phase) {
  const labels = {
    queued: "대기 중",
    "uploading-audio": "오디오 업로드 중",
    "extracting-audio": "오디오 추출 중",
    transcribing: "음성 인식 중",
    translating: "한글 번역 중",
    finalizing: "자막 정리 중",
  };
  return labels[phase] || "자막 생성 중";
}

function elapsedSubtitleTime() {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - subtitleProgressStartedAt) / 1000));
  return `${String(Math.floor(elapsedSeconds / 60)).padStart(2, "0")}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
}

function renderSubtitleProgress({ phase = "queued", progress = 0, completed = 0, total = 0 } = {}) {
  if (!subtitleProgressStartedAt) return;
  const percent = Number.isFinite(progress) && progress > 0 ? ` ${Math.min(99, Math.floor(progress))}%` : "";
  const count = phase === "translating" && total > 0 ? ` (${completed}/${total})` : "";
  subtitleProgressElement.textContent = `${subtitleProgressLabel(phase)}${percent}${count} · ${elapsedSubtitleTime()}`;
  subtitleProgressElement.hidden = false;
}

function startSubtitleProgress() {
  subtitleProgressStartedAt = Date.now();
  renderSubtitleProgress();
  subtitleProgressTimer = setInterval(() => renderSubtitleProgress(), 1000);
}

function stopSubtitleProgress() {
  if (subtitleProgressTimer !== null) clearInterval(subtitleProgressTimer);
  subtitleProgressTimer = null;
  subtitleProgressStartedAt = 0;
  subtitleProgressElement.hidden = true;
  subtitleProgressElement.textContent = "";
}

async function startProgressivePlayback() {
  try {
    directLeaseId = await acquireMediaLease(mediaUrl, "playback-progressive");
  } catch {
    await handlePlaybackFailure();
    return;
  }
  directLeaseHeartbeat = setInterval(() => {
    if (directLeaseId == null) return;
    void chrome.runtime.sendMessage({
      type: "touch-media-fetch",
      leaseId: directLeaseId,
    }).catch(() => {});
  }, 60_000);
  video.onerror = () => { void handlePlaybackFailure(); };
  video.src = mediaUrl;
  video.load();
}

async function startPlayback() {
  await stopPlayback();
  message.hidden = true;
  if (!mediaUrl) {
    fail("재생할 주소가 없습니다.");
    return;
  }
  if (pageTitle) titleElement.textContent = pageTitle;
  if (mediaType === "DASH" || /\.mpd(?:[?#]|$)/i.test(mediaUrl)) {
    fail("DASH 브라우저 재생은 아직 지원하지 않습니다. 다운로드 기능을 이용해 주세요.");
    return;
  }
  if (hlsMedia()) await startHlsPlayback();
  else await startProgressivePlayback();
}

async function refreshSubtitleJob() {
  if (!activeSubtitleJobId || !activeSubtitleInput) return;
  const response = await chrome.runtime.sendMessage({ type: "list-download-jobs" }).catch(() => null);
  const job = response?.jobs?.find((item) => item.id === activeSubtitleJobId);
  if (!job) return;
  if (["queued", "running", "paused"].includes(job.status)) {
    subtitleProgressElement.textContent = `${job.statusText || "자막 생성 중…"} · ${elapsedSubtitleTime()}`;
    subtitleProgressElement.hidden = false;
    return;
  }
  const input = activeSubtitleInput;
  activeSubtitleJobId = "";
  activeSubtitleInput = null;
  if (subtitleJobPollTimer !== null) clearInterval(subtitleJobPollTimer);
  subtitleJobPollTimer = null;
  stopSubtitleProgress();
  generateSubtitleButton.disabled = false;
  generateSubtitleButton.textContent = autoSubtitleMessages.generate;
  if (job.status !== "completed") {
    showToast(job.error || autoSubtitleMessages.failed);
    return;
  }
  const generated = await loadGeneratedSubtitle(input);
  if (!generated?.vtt || !bindSubtitleCues(parseSubtitle(generated.vtt))) {
    showToast(autoSubtitleMessages.empty);
    return;
  }
  generatedSubtitleVtt = generated.vtt;
  saveSubtitleButton.hidden = false;
  showToast(autoSubtitleMessages.ready);
}

function generatedSubtitleFilename() {
  const title = String(pageTitle || "aura-subtitle")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 120);
  const identifier = mediaIdentifier(pageTitle) || mediaIdentifier(mediaUrl);
  return `${title || identifier || "aura-subtitle"}.srt`;
}

async function saveGeneratedSrt({ requestPermission = false } = {}) {
  if (!generatedSubtitleVtt) return "";
  const directory = await ensureStoredSubtitleDirectory({ requestPermission });
  if (!directory) return "";
  const srt = cuesToSrt(parseSubtitle(generatedSubtitleVtt));
  if (!srt) throw new Error("empty-srt");
  const { fileHandle, filename } = await createUniqueFile(directory, generatedSubtitleFilename());
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(srt);
  } finally {
    await writable.close();
  }
  return filename;
}

async function generateSubtitles() {
  if (!proActive || generateSubtitleButton.disabled || !mediaUrl) return;
  generateSubtitleButton.disabled = true;
  generateSubtitleButton.textContent = autoSubtitleMessages.generating;
  startSubtitleProgress();
  const input = {
    mediaUrl,
    sourceUrl,
    title: pageTitle,
    sourceLanguage: subtitleSourceLanguage.value === "en" ? "en" : "ja",
    mediaType,
    ...(Number.isInteger(sourceTabId) ? { sourceTabId } : {}),
    ...(Number.isInteger(sourceFrameId) ? { sourceFrameId } : {}),
  };
  try {
    const cached = await loadGeneratedSubtitle(input);
    if (cached?.vtt) {
      generatedSubtitleVtt = cached.vtt;
      if (!bindSubtitleCues(parseSubtitle(cached.vtt))) throw new Error("empty-subtitle");
      saveSubtitleButton.hidden = false;
      stopSubtitleProgress();
      generateSubtitleButton.disabled = false;
      generateSubtitleButton.textContent = autoSubtitleMessages.generate;
      showToast(autoSubtitleMessages.ready);
      return;
    }
    const started = await chrome.runtime.sendMessage({ type: "start-subtitle-generation", input });
    if (!started?.ok || !started.jobId) throw new Error(started?.error || "subtitle-generation-failed");
    activeSubtitleJobId = started.jobId;
    activeSubtitleInput = input;
    subtitleJobPollTimer = setInterval(() => { void refreshSubtitleJob(); }, 1500);
    await refreshSubtitleJob();
    showToast("자막 생성은 다운로드 작업창에서 계속됩니다.");
  } catch (error) {
    stopSubtitleProgress();
    generateSubtitleButton.disabled = false;
    generateSubtitleButton.textContent = autoSubtitleMessages.generate;
    showToast(error?.message === "pro-license-required" ? noSubtitleMessage : autoSubtitleMessages.failed);
  }
}

saveButton.addEventListener("click", () => {
  if (tokenized) {
    showToast("만료되는 인증 주소는 컬렉션에 저장하지 않습니다.");
    return;
  }
  void openCollectionPicker();
});
generateSubtitleButton.addEventListener("click", generateSubtitles);
saveSubtitleButton.addEventListener("click", async () => {
  saveSubtitleButton.disabled = true;
  try {
    const filename = await saveGeneratedSrt({ requestPermission: true });
    showToast(filename ? `${filename} ${autoSubtitleMessages.saved}` : autoSubtitleMessages.folder);
  } catch {
    showToast(autoSubtitleMessages.saveFailed);
  } finally {
    saveSubtitleButton.disabled = false;
  }
});
window.addEventListener("pagehide", releasePlaybackMedia, { once: true });
collectionNewFolderButton.addEventListener("click", () => {
  collectionNewFolderRow.hidden = false;
  collectionNewFolderInput.focus();
});
collectionCreateFolderButton.addEventListener("click", createCollectionFolderFromPicker);
collectionNewFolderInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") createCollectionFolderFromPicker();
});
collectionCancelButton.addEventListener("click", closeCollectionPicker);
collectionConfirmButton.addEventListener("click", saveSelectedCollection);

window.addEventListener("pagehide", () => {
  if (subtitleJobPollTimer !== null) clearInterval(subtitleJobPollTimer);
  subtitleJobPollTimer = null;
  if (hls) {
    try { hls.destroy(); } catch { /* best effort */ }
    hls = null;
  }
  void releaseDirectLease();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "download-jobs-changed") void refreshSubtitleJob();
});

async function init() {
  const locale = await loadLocale();
  setCollectionLocale(locale);
  noSubtitleMessage = NO_SUBTITLE_MESSAGES[locale] || NO_SUBTITLE_MESSAGES.ko;
  autoSubtitleMessages = AUTO_SUBTITLE_MESSAGES[locale] || AUTO_SUBTITLE_MESSAGES.ko;
  generateSubtitleButton.textContent = autoSubtitleMessages.generate;
  saveSubtitleButton.textContent = autoSubtitleMessages.save;
  cleanupSubtitleSessions();
  await refreshPlanGate();
  if (!await resolveInitialPlayback()) {
    fail("안전한 재생 세션이 만료되었거나 재생 주소가 올바르지 않습니다.", {
      refresh: Boolean(sourceUrl),
    });
    return;
  }
  await refreshPlanGate();
  await loadSubtitles();
  await startPlayback();
}

init();
