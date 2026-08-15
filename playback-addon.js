import { decodeSubtitleBytes, findSubtitleFile } from "./player-subtitle.js";
import { getStoredSubtitleDirectory } from "./subtitle-folder.js";
import { addToCollection, listCollection, removeFromCollection } from "./collection.js";
import { resolveEdition } from "./license.js";
import { loadLocale, translator } from "./i18n.js";

const MESSAGES = {
  ko: {
    playBrowser: "재생",
    browserOpening: "브라우저에서 재생합니다",
    folderNeeded: "자막 폴더를 먼저 선택해 주세요. 열린 탭에서 폴더를 고르면 다음부터 바로 재생됩니다.",
    noSubtitle: "자막을 찾지 못했습니다 — 자막 없이 재생합니다",
    chooseFolder: "자막 폴더 선택",
    collection: "컬렉션",
    collectionEmpty: "저장한 항목이 없습니다. 재생 중 '컬렉션에 저장' 버튼으로 추가하세요.",
    collectionNote: "브라우저 즐겨찾기 'Aura Media' 폴더와 연동됩니다.",
    collectionRemove: "삭제",
    collectionLocked: "컬렉션은 Pro 전용 기능입니다.",
  },
  en: {
    playBrowser: "Play",
    browserOpening: "Opening in browser",
    folderNeeded: "Pick a subtitle folder first. Choose one in the opened tab, then play again.",
    noSubtitle: "No subtitle found — playing without subtitles",
    chooseFolder: "Choose subtitle folder",
    collection: "Collection",
    collectionEmpty: "Nothing saved yet. Use the Save button in the player to add an entry.",
    collectionNote: "Synced with the 'Aura Media' browser bookmarks folder.",
    collectionRemove: "Remove",
    collectionLocked: "The collection is a Pro feature.",
  },
  ja: {
    playBrowser: "再生",
    browserOpening: "ブラウザーで再生します",
    folderNeeded: "先に字幕フォルダーを選択してください。開いたタブで選ぶと、次回から再生できます。",
    noSubtitle: "字幕が見つかりません — 字幕なしで再生します",
    chooseFolder: "字幕フォルダーを選択",
    collection: "コレクション",
    collectionEmpty: "保存された項目はありません。再生中に「保存」ボタンで追加できます。",
    collectionNote: "ブラウザーのブックマーク「Aura Media」フォルダーと同期されます。",
    collectionRemove: "削除",
    collectionLocked: "コレクションは Pro 専用機能です。",
  },
  zh: {
    playBrowser: "播放",
    browserOpening: "正在浏览器中播放",
    folderNeeded: "请先选择字幕文件夹。在打开的标签页中选择后即可播放。",
    noSubtitle: "未找到字幕 — 将不带字幕播放",
    chooseFolder: "选择字幕文件夹",
    collection: "收藏",
    collectionEmpty: "还没有保存的项目。播放时点击“保存”按钮添加。",
    collectionNote: "与浏览器书签“Aura Media”文件夹同步。",
    collectionRemove: "删除",
    collectionLocked: "收藏是 Pro 专属功能。",
  },
};

const candidates = document.getElementById("candidates");
let t = translator();
let proActive = false;

function byId(id) {
  return document.getElementById(id);
}

function playableMediaUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

function showToast(message) {
  const toast = document.createElement("p");
  toast.className = "playback-toast";
  toast.textContent = message;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 2600);
}

async function playInBrowser(mediaUrl, title, button) {
  const handle = await getStoredSubtitleDirectory();
  if (!handle) {
    chrome.tabs.create({ url: chrome.runtime.getURL("subtitle-folder.html") });
    showToast(t("folderNeeded"));
    return;
  }
  const sessionId = crypto.randomUUID();
  try {
    const found = await findSubtitleFile(handle, title, mediaUrl);
    if (found) {
      const bytes = new Uint8Array(await found.file.arrayBuffer());
      const text = await decodeSubtitleBytes(bytes);
      await chrome.storage.local.set({
        [`auraSubtitleSession:${sessionId}`]: { text, at: Date.now() },
      });
    } else {
      showToast(t("noSubtitle"));
    }
  } catch {
    // Playback continues without subtitles when the folder is unreadable.
  }
  const params = new URLSearchParams({ url: mediaUrl });
  if (title) params.set("title", title.slice(0, 240));
  params.set("sub", sessionId);
  if (proActive) params.set("pro", "1");
  chrome.tabs.create({ url: chrome.runtime.getURL(`player.html?${params.toString()}`) });
  button.textContent = t("browserOpening");
  setTimeout(() => {
    button.textContent = t("playBrowser");
  }, 1800);
}

async function renderCollection() {
  const listElement = byId("collection-list");
  const countElement = byId("collection-count");
  const heading = document.querySelector(".collection-header h2");
  if (!listElement) return;
  if (heading) heading.textContent = t("collection");
  if (!proActive) {
    countElement.hidden = true;
    listElement.replaceChildren();
    const locked = document.createElement("p");
    locked.className = "collection-empty";
    locked.textContent = t("collectionLocked");
    listElement.append(locked);
    return;
  }
  const entries = await listCollection();
  const note = byId("collection-note");
  if (note) note.textContent = t("collectionNote");
  countElement.hidden = entries.length === 0;
  countElement.textContent = String(entries.length);
  listElement.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "collection-empty";
    empty.textContent = t("collectionEmpty");
    listElement.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "collection-row";
    const label = document.createElement("span");
    label.className = "collection-title";
    label.textContent = entry.title || entry.url;
    label.title = entry.url;
    const play = document.createElement("button");
    play.type = "button";
    play.className = "job-list-tool";
    play.textContent = t("playBrowser");
    play.addEventListener("click", () => playInBrowser(entry.url, entry.title, play));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "job-list-tool";
    remove.textContent = t("collectionRemove");
    remove.addEventListener("click", async () => {
      await removeFromCollection(entry.url);
      renderCollection();
    });
    row.append(label, play, remove);
    listElement.append(row);
  }
}

async function refreshPlanGate() {
  proActive = (await resolveEdition()) === "pro";
  renderCollection();
}

function watchBookmarkChanges() {
  if (!globalThis.chrome?.bookmarks) return;
  let refreshTimer = null;
  const schedule = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(renderCollection, 250);
  };
  chrome.bookmarks.onCreated.addListener(schedule);
  chrome.bookmarks.onRemoved.addListener(schedule);
  chrome.bookmarks.onMoved.addListener(schedule);
  chrome.bookmarks.onChanged.addListener(schedule);
}

function watchLicenseChanges() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "license-changed") refreshPlanGate();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.auraLicense) refreshPlanGate();
  });
}

function enhanceCandidateCard(card) {
  if (!(card instanceof HTMLElement) || card.dataset.playbackEnhanced === "true") return;
  card.dataset.playbackEnhanced = "true";

  const urlText = card.querySelector(".candidate-url")?.textContent || "";
  const mediaUrl = playableMediaUrl(urlText);
  if (!mediaUrl) return;

  const meta = card.querySelector(".candidate-meta");
  if (!meta) return;

  const title = card.querySelector(".candidate-title")?.textContent || "";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "download-button browser-play-button";
  button.textContent = t("playBrowser");
  button.title = "브라우저에서 자막과 함께 재생";
  button.setAttribute("aria-label", "브라우저에서 자막과 함께 재생");
  button.addEventListener("click", () => {
    playInBrowser(mediaUrl, title, button);
  });
  meta.append(button);
}

function enhanceCandidates() {
  if (!candidates) return;
  for (const card of candidates.querySelectorAll(".candidate-card")) enhanceCandidateCard(card);
}

async function init() {
  t = translator(await loadLocale());
  if (candidates) {
    const observer = new MutationObserver(enhanceCandidates);
    observer.observe(candidates, { childList: true, subtree: true });
    enhanceCandidates();
  }
  await refreshPlanGate();
  watchBookmarkChanges();
  watchLicenseChanges();
}

init();
