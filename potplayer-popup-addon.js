import {
  buildAuraPlayerUri,
  buildAuraProbeUri,
  companionInstallerUrl,
  companionProbeStatusUrl,
  playableMediaUrl,
} from "./potplayer-protocol.js";
import { loadLocale, translator } from "./i18n.js";

const MESSAGES = {
  ko: {
    play: "▶ PotPlayer",
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
  const button = document.createElement("button");
  button.type = "button";
  button.className = "download-button potplayer-button";
  button.textContent = t("play");
  button.title = "PotPlayer에서 스트리밍 재생";
  button.setAttribute("aria-label", "PotPlayer에서 스트리밍 재생");
  button.addEventListener("click", () => {
    tryPlay(mediaUrl, title, button);
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
  await resumePendingProbe();
}

init();
