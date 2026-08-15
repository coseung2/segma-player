import {
  buildAuraPlayerUri,
  buildAuraProbeUri,
  companionInstallerUrl,
  companionProbeStatusUrl,
  playableMediaUrl,
} from "./potplayer-protocol.js";
import { decodeSubtitleBytes, findSubtitleFile } from "./player-subtitle.js";
import { getStoredSubtitleDirectory } from "./subtitle-folder.js";
import { addToCollection, listCollection, removeFromCollection } from "./collection.js";
import { loadLocale, translator } from "./i18n.js";

const MESSAGES = {
  ko: {
    play: "▶ PotPlayer",
    playBrowser: "재생",
    browserOpening: "브라우저에서 재생합니다",
    folderNeeded: "자막 폴더를 먼저 선택해 주세요. 열린 탭에서 폴더를 고르면 다음부터 바로 재생됩니다.",
    noSubtitle: "자막을 찾지 못했습니다 — 자막 없이 재생합니다",
    chooseFolder: "자막 폴더 선택",
    collection: "컬렉션",
    collectionEmpty: "저장한 항목이 없습니다. 감지 카드의 '저장' 버튼으로 추가하세요.",
    collectionNote: "브라우저 즐겨찾기 'Aura Media' 폴더와 연동됩니다.",
    collectionSave: "저장",
    collectionSaved: "컬렉션에 저장됨",
    collectionRemove: "삭제",
    checking: "확인 중…",
    sent: "PotPlayer로 재생합니다",
    installTitle: "PotPlayer 연동이 필요합니다",
    installDesc:
      "팟플레이어로 스트리밍 재생하려면 연동 컴패니언을 한 번 설치해 주세요. 설치할 때 자막 폴더를 선택하면 완료됩니다.",
    installDownload: "설치 프로그램 받기",
    downloading: "설치 프로그램을 다운로드하는 중…",
    downloadDone:
      "다운로드 완료 — 다운로드 폴더에서 AuraPotPlayerSetup.exe를 실행해 주세요. 자막 폴더를 선택하면 설치가 끝납니다.",
    downloadFailed: "다운로드에 실패했습니다. 다시 시도해 주세요.",
    installVerify: "설치 완료 확인",
    verifyFailed: "아직 감지되지 않았습니다. 설치 프로그램을 실행한 뒤 다시 확인해 주세요.",
    installed: "연동 확인 완료. 이제 ▶ PotPlayer로 재생할 수 있습니다.",
  },
  en: {
    play: "▶ PotPlayer",
    playBrowser: "Play",
    browserOpening: "Opening in browser",
    folderNeeded: "Pick a subtitle folder first. Choose one in the opened tab, then play again.",
    noSubtitle: "No subtitle found — playing without subtitles",
    chooseFolder: "Choose subtitle folder",
    collection: "Collection",
    collectionEmpty: "Nothing saved yet. Use the card's Save button to add an entry.",
    collectionNote: "Synced with the 'Aura Media' browser bookmarks folder.",
    collectionSave: "Save",
    collectionSaved: "Saved to collection",
    collectionRemove: "Remove",
    checking: "Checking…",
    sent: "Opening in PotPlayer",
    installTitle: "PotPlayer companion required",
    installDesc:
      "To stream in PotPlayer, install the companion once. It will ask you to pick a subtitle folder, then you are done.",
    installDownload: "Download installer",
    downloading: "Downloading installer…",
    downloadDone:
      "Download complete — run AuraPotPlayerSetup.exe from your Downloads folder, then pick the subtitle folder.",
    downloadFailed: "Download failed. Please try again.",
    installVerify: "Check installation",
    verifyFailed: "Not detected yet. Run the installer, then check again.",
    installed: "Companion verified. You can now play with ▶ PotPlayer.",
  },
  ja: {
    play: "▶ PotPlayer",
    playBrowser: "再生",
    browserOpening: "ブラウザーで再生します",
    folderNeeded: "先に字幕フォルダーを選択してください。開いたタブで選ぶと、次回から再生できます。",
    noSubtitle: "字幕が見つかりません — 字幕なしで再生します",
    chooseFolder: "字幕フォルダーを選択",
    collection: "コレクション",
    collectionEmpty: "保存された項目はありません。カードの「保存」ボタンで追加できます。",
    collectionNote: "ブラウザーのブックマーク「Aura Media」フォルダーと同期されます。",
    collectionSave: "保存",
    collectionSaved: "コレクションに保存しました",
    collectionRemove: "削除",
    checking: "確認中…",
    sent: "PotPlayer で再生します",
    installTitle: "PotPlayer 連携が必要です",
    installDesc:
      "PotPlayer でストリーミング再生するには、連携コンパニオンのインストールが一度だけ必要です。字幕フォルダーを選ぶと完了します。",
    installDownload: "インストーラーをダウンロード",
    downloading: "インストーラーをダウンロード中…",
    downloadDone:
      "ダウンロード完了 — ダウンロードフォルダーの AuraPotPlayerSetup.exe を実行し、字幕フォルダーを選択してください。",
    downloadFailed: "ダウンロードに失敗しました。もう一度お試しください。",
    installVerify: "インストールを確認",
    verifyFailed: "まだ検出されていません。インストーラーを実行してから再確認してください。",
    installed: "連携を確認しました。▶ PotPlayer で再生できます。",
  },
  zh: {
    play: "▶ PotPlayer",
    playBrowser: "播放",
    browserOpening: "正在浏览器中播放",
    folderNeeded: "请先选择字幕文件夹。在打开的标签页中选择后即可播放。",
    noSubtitle: "未找到字幕 — 将不带字幕播放",
    chooseFolder: "选择字幕文件夹",
    collection: "收藏",
    collectionEmpty: "还没有保存的项目。点击卡片上的“保存”按钮添加。",
    collectionNote: "与浏览器书签“Aura Media”文件夹同步。",
    collectionSave: "保存",
    collectionSaved: "已保存到收藏",
    collectionRemove: "删除",
    checking: "正在确认…",
    sent: "正在用 PotPlayer 播放",
    installTitle: "需要安装 PotPlayer 组件",
    installDesc:
      "要用 PotPlayer 播放流媒体，只需安装一次组件。安装时选择字幕文件夹即可完成。",
    installDownload: "下载安装程序",
    downloading: "正在下载安装程序…",
    downloadDone:
      "下载完成 — 请从下载文件夹运行 AuraPotPlayerSetup.exe，然后选择字幕文件夹。",
    downloadFailed: "下载失败，请重试。",
    installVerify: "确认安装",
    verifyFailed: "尚未检测到。请先运行安装程序，再重新确认。",
    installed: "组件已确认，现在可以用 ▶ PotPlayer 播放。",
  },
};

const SEEN_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_STALE_MS = 90 * 1000;
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 8000;

const candidates = document.getElementById("candidates");
let t = translator();

function byId(id) {
  return document.getElementById(id);
}

function newProbeToken() {
  return crypto.randomUUID().replace(/-/g, "");
}

async function readState() {
  return chrome.storage.local.get(["potplayerCompanionSeenAt", "potplayerPendingProbe"]);
}

async function writeState(partial) {
  return chrome.storage.local.set(partial);
}

async function probeSeen(token) {
  try {
    const response = await fetch(companionProbeStatusUrl(token), { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.seen === true;
  } catch {
    return null;
  }
}

async function pollProbe(token) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const seen = await probeSeen(token);
    if (seen === true) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return false;
}

function showToast(message) {
  const toast = document.createElement("p");
  toast.className = "potplayer-toast";
  toast.textContent = message;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 2600);
}

function fireUri(uri) {
  window.location.href = uri;
}

async function markInstalled() {
  await writeState({ potplayerCompanionSeenAt: Date.now(), potplayerPendingProbe: null });
}

async function playWithProbe(mediaUrl, title) {
  const token = newProbeToken();
  await writeState({ potplayerPendingProbe: { token, at: Date.now() } });
  fireUri(buildAuraPlayerUri(mediaUrl, title, { probe: token }));
  return pollProbe(token);
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
  chrome.tabs.create({ url: chrome.runtime.getURL(`player.html?${params.toString()}`) });
  button.textContent = t("browserOpening");
  setTimeout(() => {
    button.textContent = t("playBrowser");
  }, 1800);
}

async function tryPlay(mediaUrl, title, button) {
  const { potplayerCompanionSeenAt } = await readState();
  if (potplayerCompanionSeenAt && Date.now() - potplayerCompanionSeenAt < SEEN_CACHE_MS) {
    fireUri(buildAuraPlayerUri(mediaUrl, title));
    return;
  }
  button.disabled = true;
  button.textContent = t("checking");
  const confirmed = await playWithProbe(mediaUrl, title);
  if (confirmed) {
    await markInstalled();
    button.textContent = t("sent");
    setTimeout(() => {
      button.disabled = false;
      button.textContent = t("play");
    }, 1600);
    return;
  }
  button.disabled = false;
  button.textContent = t("play");
  showInstallCard();
}

function showInstallCard() {
  const existing = byId("potplayer-install-card");
  if (existing) {
    existing.hidden = false;
    return;
  }
  const card = document.createElement("section");
  card.id = "potplayer-install-card";
  card.className = "potplayer-install-card";
  card.setAttribute("role", "region");
  card.setAttribute("aria-label", t("installTitle"));

  const heading = document.createElement("h3");
  heading.textContent = t("installTitle");
  const description = document.createElement("p");
  description.textContent = t("installDesc");
  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.className = "primary-button";
  downloadButton.textContent = t("installDownload");
  const status = document.createElement("p");
  status.className = "potplayer-install-status";
  status.hidden = true;
  const verifyButton = document.createElement("button");
  verifyButton.type = "button";
  verifyButton.className = "job-list-tool";
  verifyButton.textContent = t("installVerify");
  verifyButton.hidden = true;
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "potplayer-install-close";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.textContent = "×";

  closeButton.addEventListener("click", () => {
    card.hidden = true;
  });
  downloadButton.addEventListener("click", () => startInstallerDownload(downloadButton, status, verifyButton));
  verifyButton.addEventListener("click", () => verifyInstall(card, verifyButton, status));

  card.append(closeButton, heading, description, downloadButton, status, verifyButton);

  const folderButton = document.createElement("button");
  folderButton.type = "button";
  folderButton.className = "job-list-tool";
  folderButton.textContent = t("chooseFolder");
  folderButton.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("subtitle-folder.html") });
  });
  card.append(folderButton);

  document.getElementById("panel-detect").append(card);
}

async function startInstallerDownload(button, status, verifyButton) {
  button.disabled = true;
  status.hidden = false;
  status.textContent = t("downloading");
  let downloadId = null;
  try {
    downloadId = await chrome.downloads.download({
      url: companionInstallerUrl(),
      filename: "AuraPotPlayerSetup.exe",
      conflictAction: "overwrite",
      saveAs: false,
    });
  } catch {
    downloadId = null;
  }
  if (!downloadId) {
    status.textContent = t("downloadFailed");
    button.disabled = false;
    return;
  }
  const completed = await new Promise((resolve) => {
    const listener = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === "complete") {
        chrome.downloads.onChanged.removeListener(listener);
        resolve(true);
      } else if (delta.state?.current === "interrupted") {
        chrome.downloads.onChanged.removeListener(listener);
        resolve(false);
      }
    };
    chrome.downloads.onChanged.addListener(listener);
    setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      resolve(false);
    }, 60000);
  });
  if (!completed) {
    status.textContent = t("downloadFailed");
    button.disabled = false;
    return;
  }
  chrome.downloads.show(downloadId);
  status.textContent = t("downloadDone");
  verifyButton.hidden = false;
}

async function verifyInstall(card, button, status) {
  const token = newProbeToken();
  await writeState({ potplayerPendingProbe: { token, at: Date.now() } });
  button.disabled = true;
  button.textContent = t("checking");
  fireUri(buildAuraProbeUri(token));
  const confirmed = await pollProbe(token);
  if (confirmed) {
    await markInstalled();
    card.hidden = true;
    showToast(t("installed"));
    return;
  }
  button.disabled = false;
  button.textContent = t("installVerify");
  status.hidden = false;
  status.textContent = t("verifyFailed");
}

async function renderCollection() {
  const listElement = byId("collection-list");
  const countElement = byId("collection-count");
  const heading = document.querySelector(".collection-header h2");
  if (!listElement) return;
  if (heading) heading.textContent = t("collection");
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

async function resumePendingProbe() {
  const { potplayerPendingProbe, potplayerCompanionSeenAt } = await readState();
  if (!potplayerPendingProbe) return;
  if (Date.now() - potplayerPendingProbe.at > PENDING_STALE_MS) {
    await writeState({ potplayerPendingProbe: null });
    return;
  }
  const seen = await probeSeen(potplayerPendingProbe.token);
  if (seen) {
    await markInstalled();
    showToast(t("installed"));
  } else {
    showInstallCard();
  }
}

function enhanceCandidateCard(card) {
  if (!(card instanceof HTMLElement) || card.dataset.auraPlayerEnhanced === "true") return;
  card.dataset.auraPlayerEnhanced = "true";

  const urlText = card.querySelector(".candidate-url")?.textContent || "";
  const mediaUrl = playableMediaUrl(urlText);
  if (!mediaUrl) return;

  const meta = card.querySelector(".candidate-meta");
  if (!meta) return;

  const title = card.querySelector(".candidate-title")?.textContent || "";
  const actions = document.createElement("div");
  actions.className = "candidate-player-actions";

  const browserButton = document.createElement("button");
  browserButton.type = "button";
  browserButton.className = "download-button browser-play-button";
  browserButton.textContent = t("playBrowser");
  browserButton.title = "브라우저에서 자막과 함께 재생";
  browserButton.setAttribute("aria-label", "브라우저에서 자막과 함께 재생");
  browserButton.addEventListener("click", () => {
    playInBrowser(mediaUrl, title, browserButton);
  });

  const potButton = document.createElement("button");
  potButton.type = "button";
  potButton.className = "potplayer-button";
  potButton.textContent = t("play");
  potButton.title = "PotPlayer에서 스트리밍 재생";
  potButton.setAttribute("aria-label", "PotPlayer에서 스트리밍 재생");
  potButton.addEventListener("click", () => {
    tryPlay(mediaUrl, title, potButton);
  });

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "potplayer-button";
  saveButton.textContent = t("collectionSave");
  saveButton.title = "컬렉션에 저장";
  saveButton.setAttribute("aria-label", "컬렉션에 저장");
  saveButton.addEventListener("click", async () => {
    await addToCollection({ title, url: mediaUrl });
    showToast(t("collectionSaved"));
    renderCollection();
  });

  actions.append(browserButton, potButton, saveButton);
  meta.append(actions);
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
  await renderCollection();
  watchBookmarkChanges();
  await resumePendingProbe();
}

init();
