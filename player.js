import Hls from "./vendor/hls.min.mjs";
import { decodeSubtitleBytes, findSubtitleFile, cuesAt, parseSrt } from "./player-subtitle.js";
import { getStoredSubtitleDirectory } from "./subtitle-folder.js";
import { addToCollection, replaceInCollection } from "./collection.js";
import { resolveEdition } from "./license.js";
import { loadLocale } from "./i18n.js";

const NO_SUBTITLE_MESSAGES = {
  ko: "자막을 찾지 못했습니다 — 자막 없이 재생합니다",
  en: "No subtitle found — playing without subtitles",
  ja: "字幕が見つかりません — 字幕なしで再生します",
  zh: "未找到字幕 — 将不带字幕播放",
};

const params = new URLSearchParams(location.search);
const mediaUrl = params.get("url") || "";
const title = params.get("title") || "";
const subtitleSession = params.get("sub") || "";
const sourceUrl = params.get("source") || "";
let proActive = false;
let refreshInProgress = false;
let noSubtitleMessage = NO_SUBTITLE_MESSAGES.ko;

const video = document.getElementById("video");
const titleElement = document.getElementById("title");
const subtitleElement = document.getElementById("subtitle");
const subtitleTag = document.getElementById("subtitle-tag");
const message = document.getElementById("message");
const saveButton = document.getElementById("save");
saveButton.hidden = true;

function showToast(text) {
  const toast = document.createElement("p");
  toast.className = "player-toast";
  toast.textContent = text;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 2800);
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

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function findFreshCandidate() {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const response = await chrome.runtime.sendMessage({ type: "list-candidates" });
    const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
    const fresh = candidates
      .filter((candidate) => /^https?:\/\//i.test(candidate?.previewUrl || ""))
      .sort((left, right) => Number(right.main) - Number(left.main))[0];
    if (fresh) return fresh;
    await wait(1000);
  }
  return null;
}

async function refreshFromSource(button) {
  if (refreshInProgress || !sourceUrl) return;
  refreshInProgress = true;
  button.disabled = true;
  button.textContent = "원본에서 다시 감지하는 중…";
  let sourceTab = null;
  try {
    sourceTab = await chrome.tabs.create({ url: sourceUrl, active: true });
    const fresh = await findFreshCandidate();
    if (!fresh?.previewUrl) {
      fail("원본 페이지에서 새 미디어 주소를 찾지 못했습니다.");
      return;
    }
    const nextTitle = title || fresh.pageTitle || "";
    await replaceInCollection(mediaUrl, {
      url: fresh.previewUrl,
      title: nextTitle,
      sourceUrl,
    });
    const nextParams = new URLSearchParams({
      collection: "1",
      url: fresh.previewUrl,
      source: sourceUrl,
    });
    if (nextTitle) nextParams.set("title", nextTitle.slice(0, 240));
    if (proActive) nextParams.set("pro", "1");
    if (sourceTab?.id) await chrome.tabs.remove(sourceTab.id).catch(() => {});
    location.replace(chrome.runtime.getURL(`player.html?${nextParams.toString()}`));
  } catch {
    fail("원본 페이지를 다시 확인하지 못했습니다.");
  } finally {
    refreshInProgress = false;
  }
}

function cleanupSessions() {
  chrome.storage.local.get(null, (all) => {
    const now = Date.now();
    const stale = Object.keys(all || {}).filter(
      (key) => key.startsWith("auraSubtitleSession:") && now - (all[key]?.at || 0) > 10 * 60 * 1000,
    );
    if (stale.length) chrome.storage.local.remove(stale);
  });
}

async function loadSubtitles() {
  let text = "";
  try {
    if (subtitleSession) {
      const stored = await chrome.storage.local.get(`auraSubtitleSession:${subtitleSession}`);
      const session = stored[`auraSubtitleSession:${subtitleSession}`];
      await chrome.storage.local.remove(`auraSubtitleSession:${subtitleSession}`);
      text = session?.text || "";
    } else if (params.get("collection") === "1") {
      const handle = await getStoredSubtitleDirectory();
      const found = await findSubtitleFile(handle, title, mediaUrl);
      if (found) {
        text = await decodeSubtitleBytes(new Uint8Array(await found.file.arrayBuffer()));
      }
    }
    const cues = parseSrt(text);
    if (!cues.length) {
      showToast(noSubtitleMessage);
      return;
    }
    subtitleTag.hidden = false;
    video.addEventListener("timeupdate", () => {
      const cue = cuesAt(cues, video.currentTime);
      subtitleElement.hidden = !cue;
      subtitleElement.textContent = cue?.text || "";
    });
    video.addEventListener("seeking", () => {
      const cue = cuesAt(cues, video.currentTime);
      subtitleElement.hidden = !cue;
      subtitleElement.textContent = cue?.text || "";
    });
  } catch {
    // Subtitle overlay is best-effort; playback continues without it.
  }
}

async function refreshPlanGate() {
  proActive = (await resolveEdition()) === "pro";
  saveButton.hidden = !proActive;
}

function startPlayback() {
  if (!mediaUrl) {
    fail("재생할 주소가 없습니다.");
    return;
  }
  if (title) titleElement.textContent = title;

  const hlsCandidate = /\.m3u8(\?|#|$)/i.test(mediaUrl) || mediaUrl.includes(".m3u8");
  if (hlsCandidate && Hls.isSupported()) {
    const hls = new Hls();
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data?.fatal) {
        if (sourceUrl) {
          fail("재생에 실패했습니다. 주소가 만료되었거나 서버에서 거부했습니다.", { refresh: true });
          return;
        }
        fail("재생에 실패했습니다. 주소가 만료되었거나 지원하지 않는 스트림입니다.");
      }
    });
    hls.loadSource(mediaUrl);
    hls.attachMedia(video);
  } else if (hlsCandidate) {
    fail("이 브라우저는 HLS 재생을 지원하지 않습니다.");
  } else {
    video.addEventListener("error", () => {
      fail("재생에 실패했습니다. 주소가 만료되었거나 서버에서 거부했습니다.", { refresh: Boolean(sourceUrl) });
    }, { once: true });
    video.src = mediaUrl;
  }
}

saveButton.addEventListener("click", async () => {
  await addToCollection({ title, url: mediaUrl, sourceUrl });
  saveButton.textContent = "저장됨";
  saveButton.disabled = true;
});

async function init() {
  const locale = await loadLocale();
  noSubtitleMessage = NO_SUBTITLE_MESSAGES[locale] || NO_SUBTITLE_MESSAGES.ko;
  cleanupSessions();
  await refreshPlanGate();
  await loadSubtitles();
  startPlayback();
}

init();
