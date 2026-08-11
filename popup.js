const statusElement = document.querySelector("#status");
const summaryElement = document.querySelector("#summary");
const candidatesElement = document.querySelector("#candidates");
const refreshButton = document.querySelector("#refresh");
const rescanButton = document.querySelector("#rescan");
const testModeElement = document.querySelector("#test-mode");
const testDomainsElement = document.querySelector("#test-domains");
const saveTestSettingsButton = document.querySelector("#save-test-settings");
const testSettingsStatusElement = document.querySelector("#test-settings-status");
const directUrlElement = document.querySelector("#direct-url");
const downloadUrlButton = document.querySelector("#download-url");
const directStatusElement = document.querySelector("#direct-status");
const mainOnlyElement = document.querySelector("#main-only");
const openSettingsButton = document.querySelector("#open-settings");
const pendingDownloads = new Map();
let lastCandidates = [];
const TEST_MODE_KEY = "auraTestMode";
const TEST_DOMAINS_KEY = "auraTestDomains";

function setStatus(message) {
  statusElement.textContent = message;
}

function createText(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function normalizeTestDomain(value) {
  const input = String(value || "").trim().toLowerCase();
  if (!input) return null;
  try {
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.hostname.replace(/\.$/, "");
  } catch {
    return null;
  }
}

async function loadTestSettings() {
  const settings = await chrome.storage.local.get({ [TEST_MODE_KEY]: false, [TEST_DOMAINS_KEY]: [] });
  testModeElement.checked = Boolean(settings[TEST_MODE_KEY]);
  testDomainsElement.value = Array.isArray(settings[TEST_DOMAINS_KEY]) ? settings[TEST_DOMAINS_KEY].join("\n") : "";
}

async function saveTestSettings() {
  const domains = [...new Set(testDomainsElement.value.split(/[\s,]+/).map(normalizeTestDomain).filter(Boolean))];
  await chrome.storage.local.set({ [TEST_MODE_KEY]: testModeElement.checked, [TEST_DOMAINS_KEY]: domains });
  testDomainsElement.value = domains.join("\n");
  testSettingsStatusElement.textContent = testModeElement.checked
    ? `테스트 모드 켜짐 · ${domains.length}개 도메인`
    : "테스트 모드 꺼짐";
}

function createPreview(candidate) {
  const preview = document.createElement("div");
  preview.className = "candidate-preview";
  const previewUrl = typeof candidate.previewUrl === "string" ? candidate.previewUrl : "";
  const displayUrl = typeof candidate.displayUrl === "string" ? candidate.displayUrl : "";
  if (!previewUrl || /^(?:blob:|data:)/i.test(previewUrl)) {
    preview.classList.add("preview-fallback");
    preview.textContent = candidate.mediaType === "HLS_MASTER" || candidate.mediaType === "HLS_MEDIA"
      ? "미리보기 없음"
      : "▶";
    return preview;
  }
  try {
    const url = new URL(previewUrl);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported preview protocol");
    if (candidate.mediaType === "PROGRESSIVE") {
      const video = document.createElement("video");
      video.src = url.href;
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.loop = true;
      video.preload = "auto";
      video.setAttribute("aria-label", `${candidate.pageTitle || "미디어"} 미리보기`);
      video.addEventListener("loadeddata", () => {
        if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = Math.min(0.1, video.duration / 10);
        void video.play().catch(() => {});
      }, { once: true });
      video.addEventListener("error", () => {
        preview.classList.add("preview-fallback");
        preview.textContent = "미리보기 없음";
      }, { once: true });
      preview.append(video);
      return preview;
    }
    if (/\.(?:jpg|jpeg|png|webp|gif)$/i.test(url.pathname)) {
      const image = document.createElement("img");
      image.src = url.href;
      image.alt = `${candidate.pageTitle || "미디어"} 썸네일`;
      image.loading = "lazy";
      preview.append(image);
      return preview;
    }
  } catch {
    // Fall back to a neutral preview when the display URL is not usable.
  }
  preview.classList.add("preview-fallback");
  preview.textContent = "▶";
  return preview;
}

function renderCandidates(candidates) {
  lastCandidates = candidates;
  candidatesElement.replaceChildren();
  summaryElement.replaceChildren();
  const sorted = [...candidates].reverse();
  const mainFirst = [...sorted].sort((a, b) => (Number(b.main) - Number(a.main)));
  const isUsableMain = (candidate) => candidate.main && !String(candidate.displayUrl || "").startsWith("blob:");
  const hasMain = mainFirst.some(isUsableMain);
  const filtered = mainOnlyElement.checked && hasMain
    ? mainFirst.filter(isUsableMain)
    : mainFirst;
  summaryElement.append(
    createText("strong", "", String(filtered.length)),
    document.createTextNode(filtered.length !== sorted.length ? "개 후보 (메인만 표시)" : "개 후보 감지됨"),
  );

  if (!filtered.length) {
    const empty = createText("div", "empty-state", "");
    empty.append(createText("strong", "", "아직 미디어가 없습니다"), createText("p", "", "영상이 재생된 페이지에서 다시 감지해 보세요."));
    candidatesElement.append(empty);
    return;
  }

  for (const candidate of filtered) {
    const card = document.createElement("article");
    card.className = "candidate-card";
    card.append(
      createPreview(candidate),
      createText("h2", "candidate-title", candidate.pageTitle || "제목 없음"),
      createText("p", "candidate-origin", candidate.pageOrigin),
      createText("p", "candidate-url", candidate.displayUrl),
    );
    if (candidate.mediaType === "HLS_MASTER" || candidate.mediaType === "HLS_MEDIA") {
      card.append(createText("p", "candidate-hint", "HLS 스트림 · 화질별 항목이 여러 개 보여도 다운로드 시 최고 화질이 자동 선택됩니다."));
    }

    const meta = document.createElement("div");
    meta.className = "candidate-meta";
    meta.append(createText("span", "badge", candidate.mediaType));
    if (candidate.main) meta.append(createText("span", "badge main", "메인 영상"));
    const button = document.createElement("button");
    button.className = "download-button";
    button.type = "button";
    const canDownload = ["PROGRESSIVE", "HLS_MASTER", "HLS_MEDIA"].includes(candidate.mediaType);
    button.textContent = canDownload ? "다운로드" : "직접 저장 불가";
    button.disabled = !canDownload;
    button.addEventListener("click", () => startDownload(candidate.id, button));
    meta.append(button);
    card.append(meta);
    candidatesElement.append(card);
  }
}

async function requestCandidates() {
  setStatus("후보를 불러오는 중…");
  try {
    const response = await chrome.runtime.sendMessage({ type: "list-candidates" });
    if (response?.type !== "candidates") throw new Error("candidate response unavailable");
    renderCandidates(response.candidates || []);
    setStatus("현재 브라우저에서 감지된 미디어");
  } catch {
    setStatus("확장 서비스를 다시 시작하는 중입니다. 팝오버를 다시 열어 주세요.");
  }
}

async function startDownload(candidateId, button) {
  if (pendingDownloads.has(candidateId)) return;
  pendingDownloads.set(candidateId, button);
  button.disabled = true;
  button.textContent = "저장 중…";
  try {
    const response = await chrome.runtime.sendMessage({ type: "download-candidate", candidateId });
    pendingDownloads.delete(candidateId);
    button.disabled = false;
    button.textContent = response?.ok
      ? "저장 요청됨"
      : response?.error === "test-domain-not-allowed" ? "테스트 도메인 필요" : "다시 시도";
  } catch {
    pendingDownloads.delete(candidateId);
    button.disabled = false;
    button.textContent = "다시 시도";
  }
}

async function startUrlDownload() {
  const url = directUrlElement.value.trim();
  if (!url) {
    directStatusElement.textContent = "주소를 입력해 주세요.";
    return;
  }
  downloadUrlButton.disabled = true;
  directStatusElement.textContent = "다운로드 요청 중…";
  try {
    const response = await chrome.runtime.sendMessage({ type: "download-url", url });
    directStatusElement.textContent = response?.ok
      ? "다운로드 창을 열었습니다."
      : response?.error === "player-page-unresolved"
        ? "이 주소에서 영상을 찾지 못했습니다. 페이지를 새로고침한 뒤 영상을 재생하고, 확장 아이콘의 목록에서 다운로드해 보세요."
      : response?.error === "invalid-url"
        ? "올바른 http(s) 주소가 아닙니다."
        : "다운로드에 실패했습니다.";
  } catch {
    directStatusElement.textContent = "확장 서비스를 다시 시작한 뒤 다시 시도해 주세요.";
  } finally {
    downloadUrlButton.disabled = false;
  }
}

async function rescanCurrentPage(clear = false) {
  rescanButton.disabled = true;
  setStatus("현재 페이지를 다시 확인하는 중…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      if (clear) {
        try {
          await chrome.runtime.sendMessage({ type: "clear-tab", tabId: tab.id });
        } catch { /* best-effort clear */ }
      }
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "rescan" });
      } catch {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      }
    }
  } catch {
    setStatus("현재 페이지에 감지기를 연결하지 못했습니다.");
  }
  window.setTimeout(() => {
    rescanButton.disabled = false;
    void requestCandidates();
  }, 250);
}

refreshButton.addEventListener("click", () => void requestCandidates());
rescanButton.addEventListener("click", () => void rescanCurrentPage(true));
saveTestSettingsButton.addEventListener("click", () => void saveTestSettings());
downloadUrlButton.addEventListener("click", () => void startUrlDownload());
mainOnlyElement.addEventListener("change", () => renderCandidates(lastCandidates));
openSettingsButton.addEventListener("click", () => void chrome.runtime.openOptionsPage());
directUrlElement.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void startUrlDownload();
});
void loadTestSettings();
void rescanCurrentPage();
