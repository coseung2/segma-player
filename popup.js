import { candidateDownloadErrorMessage } from "./download-errors.js";
import { isDownloadableMediaType } from "./candidate.js";
import { downloadJobView, retryableDownloadJob } from "./download-job-view.js";
import { PRODUCT_EDITION, UPGRADE_URL } from "./edition.js";
import { PRO_BENEFITS, productPlan, youtubeQualityAllowed } from "./product-plan.js";
import { listYouTubeQualities } from "./youtube-server.js";
import { ensureSaveDirectory, getStoredSaveDirectory } from "./save-directory.js";
import { downloadPreparedCandidate, prepareDownloadCandidate, setRuntimePlan } from "./hls-download.js";
import { resolvePlan } from "./license.js";
import { parallelDownload } from "./parallel-download.js";

const byId = (id) => document.getElementById(id);
const tabs = [...document.querySelectorAll('[role="tab"]')];
const panels = [...document.querySelectorAll('[role="tabpanel"]')];
const statusElement = byId("status");
const candidatesElement = byId("candidates");
const summaryElement = byId("summary");
const mainOnlyElement = byId("main-only");
const saveStatusElements = [byId("detect-save-status"), byId("link-save-status")].filter(Boolean);
const jobContainers = [byId("detect-jobs"), byId("link-jobs")].filter(Boolean);
const activePopupJobs = new Set();
let lastCandidates = [];
let currentPlan = productPlan(PRODUCT_EDITION);
let qualityCheckTimer = null;
let lastQualityCheckUrl = "";

// Fallback only; real options come from the server probe. Kept at 1080 so a
// failed probe never shows resolutions the video may not actually have.
const STATIC_QUALITIES = ["best", "1080", "720", "480"];

function qualityLabel(value, exact = false) {
  if (value === "best") {
    return currentPlan.id === "free" ? "최고 화질 · 자동 · Pro" : "최고 화질 · 자동";
  }
  const height = Number(value);
  if (!Number.isFinite(height)) return String(value);
  const proSuffix = currentPlan.id === "free" && height > 1080 ? " · Pro" : "";
  // Detected options are the video's real heights, so they are choices
  // ("1080p"); only the fallback list works as a cap ("최대 1080p").
  return exact ? `${height}p${proSuffix}` : `최대 ${height}p${proSuffix}`;
}

function rebuildQualityOptions(values, exact = false) {
  const select = byId("youtube-quality");
  const current = select.value;
  select.replaceChildren();
  for (const value of values) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = qualityLabel(value, exact);
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function applyQualityGating() {
  const quality = byId("youtube-quality");
  for (const option of quality.options) {
    option.disabled = !youtubeQualityAllowed(currentPlan, option.value);
  }
  if (!youtubeQualityAllowed(currentPlan, quality.value)) {
    quality.value = String(currentPlan.youtubeMaxHeight);
  }
}

async function refreshAvailableQualities(url) {
  const result = await listYouTubeQualities(url);
  if (result.ok && Array.isArray(result.qualities) && result.qualities.length) {
    rebuildQualityOptions(["best", ...result.qualities], true);
  } else {
    rebuildQualityOptions(STATIC_QUALITIES);
  }
  applyQualityGating();
}

function renderPlan() {
  byId("plan-badge").textContent = currentPlan.label;
  byId("plan-summary").textContent = currentPlan.id === "pro"
    ? "동시 제한 없음 · 용량 제한 없음 · 최고 화질"
    : "동시 1개 · 파일당 1GB";
  const offer = byId("pro-offer");
  offer.hidden = currentPlan.id === "pro";
  if (!offer.hidden) {
    byId("pro-benefits").textContent = `Pro · ${PRO_BENEFITS.join(" · ")}`;
    const upgrade = byId("upgrade-link");
    if (/^https:\/\//i.test(UPGRADE_URL)) {
      upgrade.href = UPGRADE_URL;
      upgrade.hidden = false;
    } else {
      upgrade.hidden = true;
    }
    byId("license-entry").hidden = false;
  }
  applyQualityGating();
}

async function refreshSaveStatus() {
  const handle = await getStoredSaveDirectory();
  const text = handle
    ? `병렬 저장 준비됨 · ${handle.name}`
    : "저장 폴더 미설정 — 다운로드할 때 선택 창이 열립니다.";
  for (const el of saveStatusElements) el.textContent = text;
}

async function verifySaveFolderWritable(handle) {
  try {
    const probe = await handle.getFileHandle(".aura-write-probe", { create: true });
    const writable = await probe.createWritable();
    await writable.write(new Uint8Array([1]));
    await writable.close();
    await handle.removeEntry(".aura-write-probe").catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function ensureSaveFolder() {
  let handle = await ensureSaveDirectory();
  if (handle && await verifySaveFolderWritable(handle)) return handle;
  try {
    handle = await ensureSaveDirectory({ pick: true });
  } catch {
    handle = null;
  }
  if (handle && await verifySaveFolderWritable(handle)) return handle;
  void refreshSaveStatus();
  return null;
}

async function reportJob(jobId, patch) {
  await chrome.runtime.sendMessage({ type: "download-job-update", jobId, patch }).catch(() => {});
}

async function runCandidateInPopup(jobId, candidate, dirHandle) {
  activePopupJobs.add(jobId);
  try {
    const plan = await resolvePlan();
    setRuntimePlan(plan);
    await reportJob(jobId, { status: "running", statusText: "다운로드를 준비하는 중…" });
    const prepared = await prepareDownloadCandidate(candidate, {
      onStatus: (statusText) => void reportJob(jobId, { status: "running", statusText }),
    });
    await reportJob(jobId, { status: "running", statusText: "다운로드를 시작하는 중…" });
    const result = await downloadPreparedCandidate({ ...prepared, dirHandle });
    await reportJob(jobId, { status: "completed", statusText: result.statusText });
  } catch (error) {
    const message = error instanceof Error ? error.message : "다운로드에 실패했습니다.";
    await reportJob(jobId, { status: "failed", statusText: message, error: message });
    throw error;
  } finally {
    activePopupJobs.delete(jobId);
  }
}

function safeYouTubeTitle(title) {
  return (String(title || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\.+$/, "").trim()
    || "YouTube 영상").slice(0, 150);
}

async function runYouTubeReceptionInPopup(jobId, fileUrl, title, dirHandle) {
  activePopupJobs.add(jobId);
  try {
    const filename = `${safeYouTubeTitle(title)}.mp4`;
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable({ keepExistingData: true });
    const sink = {
      write: (data) => writable.write(data),
      close: () => writable.close(),
      abort: () => writable.abort(),
    };
    const result = await parallelDownload({
      url: fileUrl,
      filename,
      createSink: async () => sink,
      onProgress: (written, total) => {
        const percent = Math.max(0, Math.min(100, Math.round((written / total) * 100)));
        void reportJob(jobId, { status: "running", statusText: `수신 중… ${percent}%` });
      },
    });
    await reportJob(jobId, {
      status: "completed",
      statusText: `저장 완료 (${Math.round(result.bytes / 1048576)} MB).`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "병렬 수신 실패";
    await reportJob(jobId, { status: "failed", statusText: "병렬 수신 실패", error: message });
    throw error;
  } finally {
    activePopupJobs.delete(jobId);
  }
}

window.addEventListener("beforeunload", () => {
  for (const jobId of activePopupJobs) {
    void chrome.runtime.sendMessage({
      type: "download-job-update",
      jobId,
      patch: { status: "failed", statusText: "팝오버가 닫혀 다운로드가 중단되었습니다.", error: "popup-closed" },
    }).catch(() => {});
  }
});

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
  window.scrollTo(0, 0);
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
        const folder = await ensureSaveFolder();
        if (!folder) {
          throw new Error("저장 폴더가 필요합니다. 다시 누르면 폴더 선택 창이 열립니다. (Downloads 안에 새 폴더를 만들어 선택하세요)");
        }
        const response = await chrome.runtime.sendMessage({
          type: "download-candidate",
          candidateId: candidate.id,
          dirHandle: folder,
          runInPopup: true,
        });
        if (!response?.ok) throw new Error(candidateDownloadErrorMessage(response?.error));
        if (response.mode === "popup") {
          await runCandidateInPopup(response.jobId, response.candidate, folder);
        }
        void requestJobs();
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

function buildJobCard(job) {
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
  if (retryableDownloadJob(job)) {
    const statusRow = document.createElement("div");
    statusRow.className = "job-status-row";
    statusRow.append(status);
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
        const folder = await ensureSaveFolder();
        if (!folder) {
          throw new Error("저장 폴더가 필요합니다. 다시 누르면 폴더 선택 창이 열립니다.");
        }
        const response = await chrome.runtime.sendMessage({
          type: "retry-download-job",
          jobId: job.id,
          dirHandle: folder,
          runInPopup: true,
        });
        if (!response?.ok) throw new Error(response?.error || "download-job-retry-failed");
        if (response.mode === "popup") {
          if (response.kind === "youtube") {
            await runYouTubeReceptionInPopup(response.jobId, response.fileUrl, response.title || "", folder);
          } else if (response.candidate) {
            await runCandidateInPopup(response.jobId, response.candidate, folder);
          }
        }
        await requestJobs();
      } catch {
        feedback.textContent = "재시도 요청에 실패했습니다.";
        retry.disabled = false;
        retry.textContent = "재시도";
      }
    });
    actions.append(feedback, retry);
    statusRow.append(actions);
    card.append(head, statusRow, progress);
  } else {
    card.append(head, status, progress);
  }
  return card;
}

function renderJobs(jobs) {
  for (const container of jobContainers) {
    container.hidden = jobs.length === 0;
    container.replaceChildren();
    for (const job of jobs) container.append(buildJobCard(job));
  }
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
  const value = byId("direct-url").value;
  byId("youtube-quality-row").hidden = !isYouTubeUrl(value);
  if (qualityCheckTimer) {
    clearTimeout(qualityCheckTimer);
    qualityCheckTimer = null;
  }
  if (isYouTubeUrl(value) && value.trim() !== lastQualityCheckUrl) {
    qualityCheckTimer = setTimeout(() => {
      lastQualityCheckUrl = value.trim();
      void refreshAvailableQualities(value.trim());
    }, 700);
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
    const value = input.value.trim();
    const folder = await ensureSaveFolder();
    if (!folder) {
      output.textContent = "저장 폴더가 필요합니다. 다시 누르면 폴더 선택 창이 열립니다. (Downloads 안에 새 폴더를 만들어 선택하세요)";
      return;
    }
    if (isYouTubeUrl(value)) {
      const response = await chrome.runtime.sendMessage({
        type: "youtube-download",
        url: value,
        quality: byId("youtube-quality").value,
        dirHandle: folder,
        runInPopup: true,
      });
      if (!response?.ok) {
        if (response?.error === "pro-feature-required") throw new Error("이 화질은 Pro에서 사용할 수 있습니다.");
        if (response?.error === "invalid-youtube-url") throw new Error("올바른 YouTube 주소가 아닙니다.");
        const detail = typeof response?.error === "string" && response.error ? response.error : "";
        if (detail) {
          throw new Error(detail);
        }
        throw new Error("유튜브 저장에 실패했습니다. 서버 연결과 옵션의 서버 주소를 확인해 주세요.");
      }
      if (response.mode === "popup") {
        await runYouTubeReceptionInPopup(response.jobId, response.fileUrl, response.title || "", folder);
      }
    } else {
      const response = await chrome.runtime.sendMessage({
        type: "download-url",
        url: value,
        dirHandle: folder,
        runInPopup: true,
      });
      if (!response?.ok) throw new Error(candidateDownloadErrorMessage(response?.error));
      if (response.mode === "popup") {
        await runCandidateInPopup(response.jobId, response.candidate, folder);
      }
    }
    void requestJobs();
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
  if (active === "detect") void requestCandidates(); else void requestJobs();
});
byId("rescan").addEventListener("click", () => void rescan());
byId("download-url").addEventListener("click", () => void directDownload());
byId("direct-url").addEventListener("keydown", (event) => { if (event.key === "Enter") void directDownload(); });
byId("direct-url").addEventListener("input", updateLinkPanel);
mainOnlyElement.addEventListener("change", () => renderCandidates(lastCandidates));
chrome.runtime.onMessage.addListener((message) => { if (message?.type === "download-jobs-changed") void requestJobs(); });
renderPlan();
updateLinkPanel();
void refreshSaveStatus();
void requestJobs();
void requestCandidates();
