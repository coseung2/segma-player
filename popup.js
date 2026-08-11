import { candidateDownloadErrorMessage } from "./download-errors.js";
import { isDownloadableMediaType } from "./candidate.js";
import { downloadJobView } from "./download-job-view.js";
import { isSiteAllowed } from "./adblock/adblock-core.js";

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
  preview.append(text("span", "preview-label", candidate.mediaType.startsWith("HLS") ? "HLS" : "미리보기 없음"));
  return preview;
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
  if (name === "blocking") void refreshBlockingPanel();
}

for (const tab of tabs) {
  tab.addEventListener("click", () => showTab(tab.dataset.tab));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = tabs.indexOf(tab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    showTab(tabs[next].dataset.tab, true);
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
    meta.append(text("span", "badge", candidate.main ? `${candidate.mediaType} · 메인` : candidate.mediaType));
    const button = text("button", "download-button", "다운로드");
    button.type = "button";
    button.disabled = !isDownloadableMediaType(candidate.mediaType);
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "요청 중…";
      try {
        const response = await chrome.runtime.sendMessage({ type: "download-candidate", candidateId: candidate.id });
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

async function directDownload() {
  const input = byId("direct-url");
  const output = byId("direct-status");
  const button = byId("download-url");
  if (!input.value.trim()) { output.textContent = "주소를 입력해 주세요."; return; }
  button.disabled = true;
  output.textContent = "주소를 확인하는 중…";
  try {
    const response = await chrome.runtime.sendMessage({ type: "download-url", url: input.value.trim() });
    if (!response?.ok) throw new Error(candidateDownloadErrorMessage(response?.error));
    showTab("downloads");
  } catch (error) {
    output.textContent = error?.message || "다운로드를 시작하지 못했습니다.";
  } finally { button.disabled = false; }
}

async function youtubeDownload() {
  const input = byId("youtube-url");
  const output = byId("youtube-status");
  const button = byId("youtube-download");
  if (!input.value.trim()) { output.textContent = "YouTube 주소를 입력해 주세요."; return; }
  button.disabled = true;
  output.textContent = "YouTube helper를 시작하는 중…";
  try {
    const response = await chrome.runtime.sendMessage({
      type: "youtube-download",
      url: input.value.trim(),
      quality: byId("youtube-quality").value,
    });
    if (!response?.ok) throw new Error(response?.error === "invalid-youtube-url" ? "올바른 YouTube 주소가 아닙니다." : "YouTube helper를 실행하지 못했습니다.");
    showTab("downloads");
  } catch (error) {
    output.textContent = error?.message || "YouTube 다운로드를 시작하지 못했습니다.";
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

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function siteOf(tab) {
  try {
    return new URL(tab?.url || "").hostname.toLowerCase();
  } catch {
    return "";
  }
}

async function refreshBlockingPanel() {
  const site = siteOf(await activeTab());
  const siteElement = byId("blocking-site");
  const detailElement = byId("blocking-detail");
  const toggleButton = byId("blocking-toggle");
  if (!site) {
    siteElement.textContent = "사이트 정보 없음";
    detailElement.textContent = "http(s) 페이지에서만 차단 상태를 확인할 수 있습니다.";
    toggleButton.hidden = true;
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: "adblock:get-state" });
    if (!response?.ok) throw new Error("adblock-state-unavailable");
    const { settings } = response;
    const allowed = isSiteAllowed(site, settings.siteAllow);
    siteElement.textContent = site;
    detailElement.textContent = allowed
      ? "이 사이트는 허용 목록에 있어 차단하지 않습니다."
      : settings.enabled
        ? "광고·추적기 요청을 차단하고 있습니다."
        : "광고 차단이 꺼져 있습니다.";
    toggleButton.hidden = !settings.enabled;
    toggleButton.textContent = allowed ? "이 사이트에서 켜기" : "이 사이트에서 끄기";
    toggleButton.dataset.allowed = String(allowed);
    byId("stat-requests").textContent = String(settings.stats.blockedRequests);
    byId("stat-elements").textContent = String(settings.stats.hiddenElements);
    byId("stat-popups").textContent = String(settings.stats.suppressedPopups);
  } catch {
    siteElement.textContent = site;
    detailElement.textContent = "차단 상태를 불러오지 못했습니다.";
  }
}

async function toggleSiteBlocking() {
  const tab = await activeTab();
  const site = siteOf(tab);
  const toggleButton = byId("blocking-toggle");
  if (!site || !tab?.id) return;
  const allowed = toggleButton.dataset.allowed !== "true";
  toggleButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "adblock:set-site-allowed",
      site,
      allowed,
    });
    if (!response?.ok) throw new Error("adblock-toggle-failed");
    await chrome.tabs.sendMessage(tab.id, { type: "adblock:refresh" }).catch(() => {});
  } finally {
    toggleButton.disabled = false;
    await refreshBlockingPanel();
  }
}

byId("refresh").addEventListener("click", () => {
  const active = tabs.find((tab) => tab.getAttribute("aria-selected") === "true")?.dataset.tab;
  if (active === "downloads") void requestJobs(); else if (active === "detect") void requestCandidates();
});
byId("rescan").addEventListener("click", () => void rescan());
byId("download-url").addEventListener("click", () => void directDownload());
byId("youtube-download").addEventListener("click", () => void youtubeDownload());
byId("blocking-toggle").addEventListener("click", () => void toggleSiteBlocking());
byId("blocking-options").addEventListener("click", () => void chrome.runtime.openOptionsPage());
byId("direct-url").addEventListener("keydown", (event) => { if (event.key === "Enter") void directDownload(); });
byId("youtube-url").addEventListener("keydown", (event) => { if (event.key === "Enter") void youtubeDownload(); });
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

void requestJobs();
void requestCandidates();
queueScrollUpdate();
