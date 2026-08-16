import Hls from "./vendor/hls.min.mjs";
import { createContextualHlsLoader } from "./contextual-hls-loader.js";
import { decodeSubtitleBytes, findSubtitleFile, cuesAt, parseSubtitle } from "./player-subtitle.js";
import { getStoredSubtitleDirectory } from "./subtitle-folder.js";
import {
  addToCollection,
  createCollectionFolder,
  listCollectionFolders,
  replaceInCollection,
} from "./collection.js";
import { resolveEdition } from "./license.js";
import { loadLocale } from "./i18n.js";
import {
  loadGeneratedSubtitle,
  requestGeneratedSubtitle,
  storeGeneratedSubtitle,
  SubtitleGenerationError,
} from "./subtitle-generation.js";

const NO_SUBTITLE_MESSAGES = {
  ko: "자막을 찾지 못했습니다 — 자막 없이 재생합니다",
  en: "No subtitle found — playing without subtitles",
  ja: "字幕が見つかりません — 字幕なしで再生します",
  zh: "未找到字幕 — 将不带字幕播放",
};

const AUTO_SUBTITLE_MESSAGES = {
  ko: { generate: "자막 생성", generating: "자막 생성 중…", ready: "자막 준비됨", failed: "자막 생성 실패", empty: "인식된 대사가 없습니다" },
  en: { generate: "Generate subtitles", generating: "Generating subtitles…", ready: "Subtitles ready", failed: "Subtitle generation failed", empty: "No speech was recognized" },
  ja: { generate: "字幕を生成", generating: "字幕を生成中…", ready: "字幕を準備しました", failed: "字幕生成に失敗しました", empty: "認識できる発話がありません" },
  zh: { generate: "生成字幕", generating: "正在生成字幕…", ready: "字幕已准备好", failed: "字幕生成失败", empty: "没有识别到语音" },
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
      referrer: sourceUrl,
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

async function refreshExistingSession(sourceTab = null) {
  if (!playbackSessionId) return null;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "refresh-playback-session",
      sessionId: playbackSessionId,
      ...(Number.isInteger(sourceTab) ? { sourceTabId: sourceTab } : {}),
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

async function acquireMediaLease(url) {
  const response = await chrome.runtime.sendMessage({
    type: "prepare-media-fetch",
    url,
    referrer: exactReferrer,
    sourceContext: {
      tabId: sourceTabId,
      frameId: sourceFrameId,
      initiator: exactReferrer,
    },
  });
  if (!response?.ok || response.leaseId == null) {
    throw new Error(response?.error || "media-context-unavailable");
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

async function attemptAutomaticRefresh() {
  if (!playbackSessionId || automaticRefreshUsed) return false;
  automaticRefreshUsed = true;
  const fresh = await refreshExistingSession();
  if (!fresh) return false;
  applyPlaybackPayload(fresh);
  await startPlayback();
  return true;
}

async function handlePlaybackFailure() {
  if (recoveryInProgress) return;
  recoveryInProgress = true;
  try {
    if (await attemptAutomaticRefresh()) return;
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
    acquire: (url) => acquireMediaLease(url),
    release: (leaseId) => releaseMediaLease(leaseId),
  });
  hls = new Hls({
    loader: Loader,
    xhrSetup(xhr) {
      xhr.withCredentials = true;
    },
  });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (data?.fatal) void handlePlaybackFailure();
  });
  hls.loadSource(mediaUrl);
  hls.attachMedia(video);
}

async function startProgressivePlayback() {
  try {
    directLeaseId = await acquireMediaLease(mediaUrl);
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

function subtitleGenerationErrorMessage(error) {
  if (!(error instanceof SubtitleGenerationError)) return autoSubtitleMessages.failed;
  if (error.code === "pro-license-required") return noSubtitleMessage;
  if (error.code === "empty-subtitle") return autoSubtitleMessages.empty;
  if (error.code === "aborted") return autoSubtitleMessages.failed;
  return autoSubtitleMessages.failed;
}

async function generateSubtitles() {
  if (!proActive || generateSubtitleButton.disabled || !mediaUrl) return;
  generateSubtitleButton.disabled = true;
  generateSubtitleButton.textContent = autoSubtitleMessages.generating;
  const input = { mediaUrl, sourceUrl, title: pageTitle };
  try {
    const cached = await loadGeneratedSubtitle(input);
    const generated = cached || await requestGeneratedSubtitle(input);
    if (!cached) await storeGeneratedSubtitle(input, generated);
    if (!bindSubtitleCues(parseSubtitle(generated.vtt))) {
      showToast(autoSubtitleMessages.empty);
      return;
    }
    showToast(autoSubtitleMessages.ready);
  } catch (error) {
    showToast(subtitleGenerationErrorMessage(error));
  } finally {
    generateSubtitleButton.disabled = false;
    generateSubtitleButton.textContent = autoSubtitleMessages.generate;
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
  if (hls) {
    try { hls.destroy(); } catch { /* best effort */ }
    hls = null;
  }
  void releaseDirectLease();
});

async function init() {
  const locale = await loadLocale();
  setCollectionLocale(locale);
  noSubtitleMessage = NO_SUBTITLE_MESSAGES[locale] || NO_SUBTITLE_MESSAGES.ko;
  autoSubtitleMessages = AUTO_SUBTITLE_MESSAGES[locale] || AUTO_SUBTITLE_MESSAGES.ko;
  generateSubtitleButton.textContent = autoSubtitleMessages.generate;
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
