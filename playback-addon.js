import { decodeSubtitleBytes, findSubtitleFile } from "./player-subtitle.js";
import { getStoredSubtitleDirectory, storeSubtitleDirectory } from "./subtitle-folder.js";
import { resolveEdition } from "./license.js";
import { loadLocale } from "./i18n.js";

const MESSAGES = {
  ko: {
    playBrowser: "재생",
    browserOpening: "브라우저에서 재생합니다",
    playBrowserTitle: "브라우저에서 자막과 함께 재생",
    folderNeeded: "자막 폴더를 먼저 선택해 주세요. 열린 탭에서 폴더를 고르면 다음부터 바로 재생됩니다.",
    noSubtitle: "자막을 찾지 못했습니다 — 자막 없이 재생합니다",
    subtitlePro: "자막 기능은 Pro에서 사용할 수 있습니다",
    subtitleFolder: "자막 폴더",
    chooseFolder: "자막 폴더 선택",
    folderCurrent: "현재: {name}",
    folderSaved: "저장됨",
    folderPickerUnavailable: "폴더 선택을 지원하지 않는 브라우저입니다.",
    folderSelectFailed: "폴더를 선택하지 못했습니다.",
    collection: "컬렉션",
    collectionEmpty: "저장한 항목이 없습니다. 재생 중 '컬렉션에 저장' 버튼으로 추가하세요.",
    collectionNote: "브라우저 즐겨찾기 'Aura Media' 폴더와 연동됩니다.",
    collectionRemove: "삭제",
    collectionLocked: "컬렉션은 Pro 전용 기능입니다.",
    playbackUnavailable: "안전한 재생 세션을 만들지 못했습니다. 원본 페이지에서 다시 감지해 주세요.",
  },
  en: {
    playBrowser: "Play",
    browserOpening: "Opening in browser",
    playBrowserTitle: "Play with subtitles in browser",
    folderNeeded: "Pick a subtitle folder first. Choose one in the opened tab, then play again.",
    noSubtitle: "No subtitle found — playing without subtitles",
    subtitlePro: "Subtitles are available with Pro",
    subtitleFolder: "Subtitle folder",
    chooseFolder: "Choose subtitle folder",
    folderCurrent: "Current: {name}",
    folderSaved: "Saved",
    folderPickerUnavailable: "Folder selection is not supported in this browser.",
    folderSelectFailed: "Could not choose the folder.",
    collection: "Collection",
    collectionEmpty: "Nothing saved yet. Use the Save button in the player to add an entry.",
    collectionNote: "Synced with the 'Aura Media' browser bookmarks folder.",
    collectionRemove: "Remove",
    collectionLocked: "The collection is a Pro feature.",
    playbackUnavailable: "Could not create a secure playback session. Detect the media again on its source page.",
  },
  ja: {
    playBrowser: "再生",
    browserOpening: "ブラウザーで再生します",
    playBrowserTitle: "字幕付きでブラウザー再生",
    folderNeeded: "先に字幕フォルダーを選択してください。開いたタブで選ぶと、次回から再生できます。",
    noSubtitle: "字幕が見つかりません — 字幕なしで再生します",
    subtitlePro: "字幕機能は Pro で利用できます",
    subtitleFolder: "字幕フォルダー",
    chooseFolder: "字幕フォルダーを選択",
    folderCurrent: "現在: {name}",
    folderSaved: "保存しました",
    folderPickerUnavailable: "このブラウザーではフォルダー選択に対応していません。",
    folderSelectFailed: "フォルダーを選択できませんでした。",
    collection: "コレクション",
    collectionEmpty: "保存された項目はありません。再生中に「保存」ボタンで追加できます。",
    collectionNote: "ブラウザーのブックマーク「Aura Media」フォルダーと同期されます。",
    collectionRemove: "削除",
    collectionLocked: "コレクションは Pro 専用機能です。",
    playbackUnavailable: "安全な再生セッションを作成できませんでした。元のページでもう一度検出してください。",
  },
  zh: {
    playBrowser: "播放",
    browserOpening: "正在浏览器中播放",
    playBrowserTitle: "在浏览器中播放并显示字幕",
    folderNeeded: "请先选择字幕文件夹。在打开的标签页中选择后即可播放。",
    noSubtitle: "未找到字幕 — 将不带字幕播放",
    subtitlePro: "字幕功能仅限 Pro",
    subtitleFolder: "字幕文件夹",
    chooseFolder: "选择字幕文件夹",
    folderCurrent: "当前：{name}",
    folderSaved: "已保存",
    folderPickerUnavailable: "此浏览器不支持文件夹选择。",
    folderSelectFailed: "无法选择文件夹。",
    collection: "收藏",
    collectionEmpty: "还没有保存的项目。播放时点击“保存”按钮添加。",
    collectionNote: "与浏览器书签“Aura Media”文件夹同步。",
    collectionRemove: "删除",
    collectionLocked: "收藏是 Pro 专属功能。",
    playbackUnavailable: "无法创建安全播放会话。请在来源页面重新检测媒体。",
  },
};

function localTranslator(locale = "ko") {
  const active = MESSAGES[locale] || MESSAGES.ko;
  return (key, params = null) => {
    const template = active[key] ?? MESSAGES.en[key] ?? key;
    if (!params || typeof template !== "string") return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    ));
  };
}

const candidates = document.getElementById("candidates");
let t = localTranslator();
let proActive = false;

function byId(id) {
  return document.getElementById(id);
}

function showToast(message) {
  const toast = document.createElement("p");
  toast.className = "playback-toast";
  toast.textContent = message;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 2600);
}

async function refreshSubtitleFolderSettings() {
  const panel = byId("subtitle-settings");
  const button = byId("subtitle-folder-change");
  const status = byId("subtitle-folder-status");
  const label = byId("subtitle-folder-label");
  if (panel) panel.hidden = !proActive;
  if (!button || !status) return;
  if (!proActive) return;
  if (label) label.textContent = t("subtitleFolder");
  byId("subtitle-settings")?.setAttribute("aria-label", t("subtitleFolder"));
  button.textContent = t("chooseFolder");
  const handle = await getStoredSubtitleDirectory();
  status.textContent = handle ? t("folderCurrent", { name: handle.name }) : "";
}

async function chooseSubtitleFolder() {
  if (!proActive) return;
  const button = byId("subtitle-folder-change");
  const status = byId("subtitle-folder-status");
  if (!button || !status) return;
  if (typeof window.showDirectoryPicker !== "function") {
    status.textContent = t("folderPickerUnavailable");
    chrome.tabs.create({ url: chrome.runtime.getURL("subtitle-folder.html") });
    return;
  }
  button.disabled = true;
  try {
    const handle = await window.showDirectoryPicker({ id: "aura-subtitles", mode: "read" });
    if (!await storeSubtitleDirectory(handle)) throw new Error("subtitle-folder-store-failed");
    status.textContent = t("folderCurrent", { name: handle.name });
    button.textContent = t("folderSaved");
  } catch (error) {
    if (error?.name !== "AbortError") status.textContent = t("folderSelectFailed");
  } finally {
    button.disabled = false;
    if (button.textContent === t("folderSaved")) setTimeout(() => { button.textContent = t("chooseFolder"); }, 1600);
  }
}

async function activePageUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url || "");
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}

async function playInBrowser(candidateId, title, button, sourceUrl = "", mediaHint = "") {
  const subtitleSessionId = proActive ? crypto.randomUUID() : null;
  let subtitleLoaded = false;
  if (proActive) {
    const handle = await getStoredSubtitleDirectory();
    if (handle) try {
      const found = await findSubtitleFile(handle, title, mediaHint);
      if (found) {
        const bytes = new Uint8Array(await found.file.arrayBuffer());
        const text = await decodeSubtitleBytes(bytes);
        await chrome.storage.local.set({
          [`auraSubtitleSession:${subtitleSessionId}`]: { text, at: Date.now() },
        });
        subtitleLoaded = true;
      }
    } catch {
      // Playback continues without subtitles when the folder is unreadable.
    }
  }
  if (!proActive) showToast(t("subtitlePro"));
  else if (!subtitleLoaded) showToast(t("noSubtitle"));
  let playbackSession;
  try {
    playbackSession = await chrome.runtime.sendMessage({
      type: "create-playback-session",
      candidateId,
      sourceUrl,
    });
  } catch {
    playbackSession = null;
  }
  if (!playbackSession?.ok || typeof playbackSession.sessionId !== "string") {
    showToast(t("playbackUnavailable"));
    return;
  }
  const params = new URLSearchParams({ session: playbackSession.sessionId });
  if (title) params.set("title", title.slice(0, 240));
  if (subtitleSessionId && subtitleLoaded) params.set("sub", subtitleSessionId);
  if (proActive) params.set("pro", "1");
  chrome.tabs.create({ url: chrome.runtime.getURL(`player.html?${params.toString()}`) });
  button.textContent = t("browserOpening");
  setTimeout(() => {
    button.textContent = t("playBrowser");
  }, 1800);
}

async function refreshPlanGate() {
  proActive = (await resolveEdition()) === "pro";
  await refreshSubtitleFolderSettings();
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

  const candidateId = card.dataset.candidateId || "";
  const urlText = card.dataset.mediaUrl || card.querySelector(".candidate-url")?.textContent || "";
  if (!candidateId) return;

  const meta = card.querySelector(".candidate-meta");
  if (!meta) return;

  const title = card.querySelector(".candidate-title")?.textContent || "";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "download-button browser-play-button";
  button.textContent = t("playBrowser");
  button.title = t("playBrowserTitle");
  button.setAttribute("aria-label", t("playBrowserTitle"));
  button.addEventListener("click", async () => {
    const origin = card.querySelector(".candidate-origin")?.textContent?.trim() || "";
    await playInBrowser(
      candidateId,
      title,
      button,
      card.dataset.sourceUrl || origin || await activePageUrl(),
      urlText,
    );
  });
  meta.append(button);
}

function enhanceCandidates() {
  if (!candidates) return;
  for (const card of candidates.querySelectorAll(".candidate-card")) enhanceCandidateCard(card);
}

async function init() {
  t = localTranslator(await loadLocale());
  byId("subtitle-folder-change")?.addEventListener("click", chooseSubtitleFolder);
  if (candidates) {
    const observer = new MutationObserver(enhanceCandidates);
    observer.observe(candidates, { childList: true, subtree: true });
    enhanceCandidates();
  }
  await refreshPlanGate();
  watchLicenseChanges();
}

init();
