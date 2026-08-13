const COMPANION_HOST = "com.aura.media_companion";
const COMPANION_PAGE = "https://aura.mdownloader.workers.dev/download.html";
import {
  checkYouTubeServer,
  getYouTubeServerUrl,
  setYouTubeServerUrl,
} from "./youtube-server.js";
import { ensureSaveDirectory, getStoredSaveDirectory } from "./save-directory.js";
const companionStatusElement = document.querySelector("#companion-status");
const installButton = document.querySelector("#companion-install");
const checkButton = document.querySelector("#companion-check");
const versionElement = document.querySelector("#version");
const licenseStatusElement = document.querySelector("#license-status");
const licenseKeyInput = document.querySelector("#license-key");
const licenseActivateButton = document.querySelector("#license-activate");
const licenseRefreshButton = document.querySelector("#license-refresh");
const licenseSection = document.querySelector("#license-section");
const ytServerUrlInput = document.querySelector("#yt-server-url");
const ytServerStatusElement = document.querySelector("#yt-server-status");
const ytServerSaveButton = document.querySelector("#yt-server-save");
const ytServerCheckButton = document.querySelector("#yt-server-check");
const parallelFolderButton = document.querySelector("#parallel-folder");
const parallelStatusElement = document.querySelector("#parallel-status");

async function refreshParallelStatus() {
  const handle = await getStoredSaveDirectory();
  parallelStatusElement.textContent = handle
    ? `저장 폴더 연결됨: ${handle.name} · 병렬 수신 사용 중`
    : "저장 폴더가 아직 없습니다. 아래 버튼으로 Downloads 안에 새 폴더를 만들어 선택하세요.";
}

parallelFolderButton.addEventListener("click", async () => {
  try {
    const handle = await ensureSaveDirectory({ pick: true });
    parallelStatusElement.textContent = handle
      ? `저장 폴더 연결됨: ${handle.name}`
      : "폴더 선택이 취소되었습니다.";
  } catch {
    parallelStatusElement.textContent = "폴더 선택이 차단됐어요. Downloads 루트 대신 새로 만든 빈 폴더를 선택해 주세요.";
  }
});

void refreshParallelStatus();


try {
  versionElement.textContent = `Aura Media Downloader v${chrome.runtime.getManifest().version} · 확장 ID ${chrome.runtime.id}`;
} catch {
  versionElement.textContent = "Aura Media Downloader";
}

function probeCompanion() {
  return new Promise((resolve) => {
    let settled = false;
    let port = null;
    const finish = (installed, detail) => {
      if (settled) return;
      settled = true;
      try { port?.disconnect(); } catch { /* already closed */ }
      resolve({ installed, detail });
    };
    try {
      port = chrome.runtime.connectNative(COMPANION_HOST);
    } catch {
      finish(false, "host-not-found");
      return;
    }
    port.onDisconnect.addListener(() => finish(false, chrome.runtime.lastError?.message || "host-not-found"));
    setTimeout(() => finish(true, ""), 700);
  });
}

async function refreshCompanionStatus() {
  companionStatusElement.textContent = "확인 중…";
  const result = await probeCompanion();
  companionStatusElement.textContent = result.installed
    ? "설치됨 — 유튜브 저장과 폴더 저장이 활성화됩니다."
    : "설치 안 됨 — 기본 다운로드는 계속 사용할 수 있습니다.";
}

installButton.addEventListener("click", () => {
  void chrome.tabs.create({ url: COMPANION_PAGE });
});
checkButton.addEventListener("click", () => void refreshCompanionStatus());

void refreshCompanionStatus();

async function refreshLicenseStatus() {
  licenseStatusElement.textContent = "확인 중…";
  try {
    const response = await chrome.runtime.sendMessage({ type: "license-status" });
    const hasKey = typeof response?.key === "string" && response.key.length > 0;
    if (response?.ok && response.edition === "pro" && hasKey) {
      // The Pro build is unlocked client-side and has a stored key, so the
      // YouTube server can issue Pro capability tokens.
      licenseSection.hidden = true;
      return;
    }
    licenseSection.hidden = false;
    licenseKeyInput.disabled = false;
    licenseActivateButton.disabled = false;
    licenseStatusElement.textContent = response?.ok && response.edition === "pro"
      ? "Pro 빌드 사용 중 — YouTube 서버 인증용 라이선스 키를 등록하세요."
      : "일반 버전 사용 중 — 키가 있으면 입력 후 등록하세요.";
  } catch {
    licenseStatusElement.textContent = "상태를 확인할 수 없습니다.";
  }
}

licenseActivateButton.addEventListener("click", async () => {
  const key = licenseKeyInput.value.trim();
  if (!key) {
    licenseStatusElement.textContent = "키를 입력해 주세요.";
    return;
  }
  licenseStatusElement.textContent = "확인 중…";
  const response = await chrome.runtime.sendMessage({ type: "license-activate", key });
  if (response?.ok) {
    licenseStatusElement.textContent = "Pro가 활성화되었습니다!";
    await refreshLicenseStatus();
  } else if (response?.error === "license-pending") {
    licenseStatusElement.textContent = "키가 등록되었습니다. 개발자 승인 후 자동으로 Pro가 적용됩니다.";
  } else if (response?.error === "invalid-key") {
    licenseStatusElement.textContent = "키 형식이 올바르지 않습니다.";
  } else if (response?.error === "license-server-unreachable") {
    licenseStatusElement.textContent = "라이선스 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.";
  } else {
    licenseStatusElement.textContent = "아직 승인되지 않은 키입니다.";
  }
});

licenseRefreshButton.addEventListener("click", async () => {
  licenseStatusElement.textContent = "확인 중…";
  try {
    const response = await chrome.runtime.sendMessage({ type: "license-refresh" });
    licenseStatusElement.textContent = response?.ok && response.edition === "pro"
      ? "Pro 활성화됨 — 동시 제한 없음, 용량 제한 없음, 백그라운드 다운로드 지원."
      : "아직 Pro가 아닙니다. 키 등록 여부를 확인해 주세요.";
  } catch {
    licenseStatusElement.textContent = "상태를 확인할 수 없습니다.";
  }
});

void refreshLicenseStatus();

async function refreshYtServerStatus() {
  const current = await getYouTubeServerUrl();
  if (ytServerUrlInput.value.trim() === "" && current) ytServerUrlInput.value = current;
  ytServerStatusElement.textContent = "연결 확인 중…";
  const result = await checkYouTubeServer(current);
  ytServerStatusElement.textContent = result.ok
    ? `연결됨 — ${result.service} (처리 중 ${result.active} · 대기 ${result.queued})`
    : `연결 안 됨 (${result.error || "unknown"}) — 컴패니언으로 자동 전환됩니다.`;
}

ytServerSaveButton.addEventListener("click", async () => {
  const result = await setYouTubeServerUrl(ytServerUrlInput.value);
  ytServerStatusElement.textContent = result.ok
    ? `저장됨 — ${result.url || "기본값으로 복귀"}`
    : "주소 형식이 올바르지 않습니다. http:// 또는 https://로 시작해야 합니다.";
});

ytServerCheckButton.addEventListener("click", () => void refreshYtServerStatus());

void refreshYtServerStatus();
