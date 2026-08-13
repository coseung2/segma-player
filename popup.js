import { candidateDownloadErrorMessage } from "./download-errors.js";
import { isDownloadableMediaType } from "./candidate.js";
import { downloadJobView, retryableDownloadJob } from "./download-job-view.js";
import { PRODUCT_EDITION, UPGRADE_URL } from "./edition.js";
import { PRO_BENEFITS, productPlan, youtubeQualityAllowed } from "./product-plan.js";

const byId = (id) => document.getElementById(id);
const tabs = [...document.querySelectorAll('[role="tab"]')];
const panels = [...document.querySelectorAll('[role="tabpanel"]')];
const statusElement = byId("status");
const candidatesElement = byId("candidates");
const summaryElement = byId("summary");
const mainOnlyElement = byId("main-only");
const jobsElement = byId("download-jobs");
const popupShell = document.querySelector(".popup-shell");
const scrollMoreButton = byId("scroll-more");
let lastCandidates = [];
let scrollUpdateQueued = false;
let currentPlan = productPlan(PRODUCT_EDITION);

function renderPlan() {
  byId("plan-badge").textContent = currentPlan.label;
  byId("plan-summary").textContent = currentPlan.id === "pro"
    ? "동시 3개 · 인위적인 용량 제한 없음 · 최고 화질"
    : "동시 1개 · 파일당 1GB";
  const offer = byId("pro-offer");
  offer.hidden = currentPlan.id === "pro";
  if (offer.hidden) return;
  byId("pro-benefits").textContent = `Pro · ${PRO_BENEFITS.join(" · ")}`;
  const upgrade = byId("upgrade-link");
  if (/^https:\/\//i.test(UPGRADE_URL)) {
    upgrade.href = UPGRADE_URL;
    upgrade.hidden = false;
  } else {
    upgrade.hidden = true;
  }
  byId("license-entry").hidden = false;
  const quality = byId("youtube-quality");
  for (const option of quality.options) {
    option.disabled = !youtubeQualityAllowed(currentPlan, option.value);
  }
  if (!youtubeQualityAllowed(currentPlan, quality.value)) {
    quality.value = String(currentPlan.youtubeMaxHeight);
  }
}

async function refreshPlan() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "license-status" });
    if (response?.ok && (response.edition === "pro" || response.edition === "free")) {
      currentPlan = productPlan(response.edition);
      renderPlan();
    }
  } catch {
    // Keep the packaged-edition fallback when the background is unavailable.
  }
}

byId("license-entry")?.addEventListener("click", (event) => {
  event.preventDefault();
  void chrome.runtime.openOptionsPage().catch(() => {});
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "license-changed") void refreshPlan();
});

void refreshPlan();

function updateScrollMore() {
  scrollUpdateQueued = false;
  const remaining = popupShell.scrollHeight - popupShell.clientHeight - popupShell.scrollTop;
  scrollMoreButton.hidden = remaining <= 12;
}

function queueScrollUpdate() {
  if (scrollUpdateQueued) return;
  scrollUpdateQueued = true;
  requestAnimationFrame(updateScrollMore);
}

function text(tag, className, value) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  return node;
}

function createPreview(candidate) {
  const preview = document.createElement("div");
  preview.className = "candidate-preview";
  const url = typeof candidate.previewUrl === "string" ? candidate.previewUrl : "";
  if (candidate.mediaType === "PROGRESSIVE" && /^https?:\/\//i.test(url)) {
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.setAttribute("aria-label", `${candidate.pageTitle || "미디어"} 미리보기`);
    video.addEventListener("error", () => {
      video.remove();
      preview.append(text("span", "preview-label", "미리보기 없음"));
    }, { once: true });
    preview.append(video);
    return preview;
  }
  preview.append(text("span", "preview-label", candidate.mediaType.startsWith("HLS") ? "스트리밍 영상" : "미리보기 없음"));
  return preview;
}

function mediaTypeLabel(mediaType) {
  return {
    PROGRESSIVE: "직접 영상",
    HLS_MASTER: "스트리밍",
    HLS_MEDIA: "스트리밍",
    YOUTUBE: "YouTube",
  }[mediaType] || mediaType;
}

function showTab(name, focus = false) {
  for (const tab of tabs) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus();
  }
  for (const panel of panels) panel.hidden = panel.id !== `panel-${name}`;
  popupShell.scrollTop = 0;
  queueScrollUpdate();
  if (name === "downloads") void requestJobs();
}

for (const tab of tabs) {
  tab.addEventListener("click", () => showTab(tab.dataset.tab));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const visibleTabs = tabs.filter((item) => !item.hidden);
    const current = visibleTabs.indexOf(tab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? visibleTabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + visibleTabs.length) % visibleTabs.length;
    showTab(visibleTabs[Math.min(next, visibleTabs.length - 1)].dataset.tab, true);
  });
}

function renderCandidates(candidates) {
  const downloadable = candidates.filter((candidate) => isDownloadableMediaType(candidate.mediaType));
  lastCandidates = downloadable;
  const sorted = [...downloadable].reverse().sort((a, b) => Number(b.main) - Number(a.main));
  const hasMain = sorted.some((item) => item.main && !String(item.displayUrl || "").startsWith("blob:"));
  const shown = mainOnlyElement.checked && hasMain ? sorted.filter((item) => item.main) : sorted;
  summaryElement.textContent = `${shown.length}개 후보`;
  candidatesElement.replaceChildren();
  if (!shown.length) {
    candidatesElement.append(text("div", "empty-state", "영상을 재생한 뒤 다시 감지해 보세요."));
    return;
  }
  for (const candidate of shown) {
    const card = document.createElement("article");
    card.className = "candidate-card";
    card.append(
      createPreview(candidate),
      text("h2", "candidate-title", candidate.pageTitle || "제목 없음"),
      text("p", "candidate-origin", candidate.pageOrigin || ""),
      text("p", "candidate-url", candidate.displayUrl || ""),
    );
    const meta = document.createElement("div");
    meta.className = "candidate-meta";
    const label = mediaTypeLabel(candidate.mediaType);
    meta.append(text("span", "badge", candidate.main ? `${label} · 메인` : label));
    const button = text("button", "download-button", "다운로드");
    button.type = "button";
    button.disabled = !isDownloadableMediaType(candidate.mediaType);
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "요청 중…";
      try {
        button.textContent = "요청 중…";
        button.removeAttribute("aria-label");
        const response = await chrome.runtime.sendMessage({
          type: "download-candidate",
          candidateId: candidate.id,
        });
        if (!response?.ok) throw new Error(candidateDownloadErrorMessage(response?.error));
        showTab("downloads");
      } catch (error) {
        statusElement.textContent = error?.message || "다운로드를 시작하지 못했습니다.";
        button.disabled = false;
        button.textContent = "다시 시도";
      }
    });
    meta.append(button);
    card.append(meta);
    candidatesElement.append(card);
  }
}

async function requestCandidates() {
  statusElement.textContent = "현재 페이지의 미디어를 확인하는 중…";
  try {
    const response = await chrome.runtime.sendMessage({ type: "list-candidates" });
    renderCandidates(response?.candidates || []);
    statusElement.textContent = "감지된 항목에서 다운로드를 누르세요.";
  } catch {
    statusElement.textContent = "확장 서비스를 다시 로드한 뒤 시도해 주세요.";
  }
}

function renderJobs(jobs) {
  jobsElement.replaceChildren();
  if (!jobs.length) {
    jobsElement.append(text("div", "empty-state", "아직 다운로드 기록이 없습니다."));
    queueScrollUpdate();
    return;
  }
  for (const job of jobs) {
    const view = downloadJobView(job);
    const card = document.createElement("article");
    card.className = "job-card";
    const head = document.createElement("div");
    head.className = "job-head";
    const title = text("h2", "job-title", view.title);
    title.title = view.title;
    const state = text("span", `job-state ${view.status}`, view.statusLabel);
    head.append(title, state);

    const progress = document.createElement("div");
    progress.className = `job-progress ${view.progress.mode} status-${view.status}`;
    if (view.progress.mode !== "failed") {
      progress.setAttribute("role", "progressbar");
      progress.setAttribute("aria-label", `${view.title} ${view.stage}`);
      progress.setAttribute("aria-valuemin", "0");
      progress.setAttribute("aria-valuemax", "100");
      if (view.progress.value !== null) progress.setAttribute("aria-valuenow", String(view.progress.value));
    }
    const fill = document.createElement("span");
    fill.className = "job-progress-fill";
    if (view.progress.value !== null) fill.style.width = `${view.progress.value}%`;
    progress.append(fill);

    const status = text("p", "job-status", view.message);
    if (view.status === "failed") status.setAttribute("role", "alert");
    card.append(head, status, progress);
    if (retryableDownloadJob(job)) {
      const actions = document.createElement("div");
      actions.className = "job-actions";
      const feedback = text("span", "job-retry-feedback", "");
      feedback.setAttribute("aria-live", "polite");
      const retry = text("button", "job-retry-button", "재시도");
      retry.type = "button";
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        retry.textContent = "재시도 중…";
        feedback.textContent = "";
        try {
          const response = await chrome.runtime.sendMessage({ type: "retry-download-job", jobId: job.id });
          if (!response?.ok) throw new Error(response?.error || "download-job-retry-failed");
          await requestJobs();
        } catch {
          feedback.textContent = "재시도 요청에 실패했습니다.";
          retry.disabled = false;
          retry.textContent = "재시도";
        }
      });
      actions.append(feedback, retry);
      card.append(actions);
    }
    jobsElement.append(card);
  }
  queueScrollUpdate();
}

async function requestJobs() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "list-download-jobs" });
    renderJobs(response?.jobs || []);
  } catch {
    renderJobs([]);
  }
}

function isYouTubeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.hostname === "youtu.be"
      || url.hostname === "youtube.com"
      || url.hostname.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

function updateLinkPanel() {
  byId("youtube-quality-row").hidden = !isYouTubeUrl(byId("direct-url").value);
}

async function directDownload() {
  const input = byId("direct-url");
  const output = byId("direct-status");
  const button = byId("download-url");
  const companionHelp = byId("companion-help");
  companionHelp.hidden = true;
  if (!input.value.trim()) { output.textContent = "주소를 입력해 주세요."; return; }
  button.disabled = true;
  output.textContent = "주소를 확인하는 중…";
  try {
    const value = input.value.trim();
    if (isYouTubeUrl(value)) {
      const response = await chrome.runtime.sendMessage({
        type: "youtube-download",
        url: value,
        quality: byId("youtube-quality").value,
      });
      if (!response?.ok) {
        if (response?.error === "pro-feature-required") throw new Error("이 화질은 Pro에서 사용할 수 있습니다.");
        if (response?.error === "invalid-youtube-url") throw new Error("올바른 YouTube 주소가 아닙니다.");
        companionHelp.hidden = false;
        throw new Error("유튜브 저장에는 PC 앱(Aura Media Companion) 설치가 필요합니다.");
      }
    } else {
      const response = await chrome.runtime.sendMessage({ type: "download-url", url: value });
      if (!response?.ok) throw new Error(candidateDownloadErrorMessage(response?.error));
    }
    showTab("downloads");
  } catch (error) {
    output.textContent = error?.message || "다운로드를 시작하지 못했습니다.";
  } finally { button.disabled = false; }
}

async function rescan() {
  const button = byId("rescan");
  button.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.runtime.sendMessage({ type: "clear-tab", tabId: tab.id }).catch(() => {});
      await chrome.tabs.sendMessage(tab.id, { type: "rescan" }).catch(async () => {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      });
    }
    window.setTimeout(() => void requestCandidates(), 250);
  } finally { button.disabled = false; }
}

byId("refresh").addEventListener("click", () => {
  const active = tabs.find((tab) => tab.getAttribute("aria-selected") === "true")?.dataset.tab;
  if (active === "downloads") void requestJobs(); else if (active === "detect") void requestCandidates();
});
byId("rescan").addEventListener("click", () => void rescan());
byId("download-url").addEventListener("click", () => void directDownload());
byId("direct-url").addEventListener("keydown", (event) => { if (event.key === "Enter") void directDownload(); });
byId("direct-url").addEventListener("input", updateLinkPanel);
byId("companion-help").addEventListener("click", (event) => {
  event.preventDefault();
  void chrome.tabs.create({ url: "https://aura.mdownloader.workers.dev/download.html" });
});
mainOnlyElement.addEventListener("change", () => renderCandidates(lastCandidates));
chrome.runtime.onMessage.addListener((message) => { if (message?.type === "download-jobs-changed") void requestJobs(); });
popupShell.addEventListener("scroll", queueScrollUpdate, { passive: true });
scrollMoreButton.addEventListener("click", () => {
  popupShell.scrollBy({
    top: Math.max(180, Math.round(popupShell.clientHeight * 0.65)),
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
});
new MutationObserver(queueScrollUpdate).observe(popupShell, { childList: true, subtree: true });

renderPlan();
updateLinkPanel();
void requestJobs();
void requestCandidates();
queueScrollUpdate();
