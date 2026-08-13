import { downloadPreparedCandidate, prepareDownloadCandidate, setRuntimePlan } from "./hls-download.js";
import { parallelDownload } from "./parallel-download.js";
import { createDownloadScheduler } from "./download-scheduler.js";
import { PRODUCT_EDITION } from "./edition.js";
import { resolvePlan } from "./license.js";
import { productPlan } from "./product-plan.js";

const FALLBACK_PLAN = productPlan(PRODUCT_EDITION);
const scheduler = createDownloadScheduler({ concurrency: FALLBACK_PLAN.maxConcurrentMediaJobs });
const acceptedJobIds = new Set();
const runningJobs = new Map();
const pauseWaiters = new Map();
const PREPARATION_TIMEOUT_MS = 45_000;

async function report(jobId, patch) {
  await chrome.runtime.sendMessage({ type: "download-job-update", jobId, patch }).catch(() => {});
}

async function prepareWithTimeout(candidate, options) {
  let timer;
  try {
    return await Promise.race([
      prepareDownloadCandidate(candidate, options),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          "영상 준비 응답이 없습니다. 다른 플레이어를 재생한 뒤 다시 시도해 주세요.",
        )), PREPARATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitWhilePaused(jobId) {
  const state = runningJobs.get(jobId);
  if (state?.sourceClosed) {
    throw new Error("원래 탭이 닫혀 다운로드가 중단되었습니다. Pro에서는 백그라운드 다운로드가 지원됩니다.");
  }
  if (!state?.paused) return Promise.resolve();
  await state.lease?.suspend();
  await new Promise((resolve) => {
    let waiters = pauseWaiters.get(jobId);
    if (!waiters) {
      waiters = new Set();
      pauseWaiters.set(jobId, waiters);
    }
    waiters.add(resolve);
  });
  if (state.sourceClosed) {
    throw new Error("원래 탭이 닫혀 다운로드가 중단되었습니다. Pro에서는 백그라운드 다운로드가 지원됩니다.");
  }
  await state.lease?.resume();
}

function setPaused(jobId, paused) {
  const state = runningJobs.get(jobId);
  if (!state || state.paused === paused) return false;
  state.paused = paused;
  if (!paused) {
    const waiters = pauseWaiters.get(jobId);
    if (waiters) {
      pauseWaiters.delete(jobId);
      for (const resolve of waiters) resolve();
    }
  }
  return true;
}

async function run(jobId, candidate) {
  runningJobs.set(jobId, { paused: false, sourceClosed: false, lease: null });
  const plan = await resolvePlan();
  setRuntimePlan(plan);
  scheduler.setConcurrency(plan.maxConcurrentMediaJobs);
  const folderName = "Downloads\\Aura Media";
  await report(jobId, { status: "running", statusText: "다운로드를 준비하는 중…", folderName });
  try {
    const prepared = await prepareWithTimeout(candidate, {
      onStatus: (statusText) => void report(jobId, { status: "running", statusText }),
      pauseGate: () => waitWhilePaused(jobId),
    });
    await report(jobId, {
      status: "running",
      statusText: plan.backgroundDownloads
        ? "준비 완료 · 다운로드 대기 중 (페이지를 벗어나도 계속됩니다)."
        : "준비 완료 · 다운로드 대기 중 (원본 페이지를 열어두세요).",
      folderName,
    });
    const result = await scheduler.schedule(async (lease) => {
      const state = runningJobs.get(jobId);
      if (state) state.lease = lease;
      await waitWhilePaused(jobId);
      await report(jobId, { status: "running", statusText: "다운로드를 시작하는 중…", folderName });
      return downloadPreparedCandidate(prepared);
    });
    await report(jobId, { status: "completed", statusText: result.statusText, folderName });
  } catch (error) {
    const message = error instanceof Error ? error.message : "다운로드에 실패했습니다.";
    await report(jobId, {
      status: "failed",
      statusText: message,
      error: message,
      folderName,
    });
  } finally {
    runningJobs.delete(jobId);
    pauseWaiters.delete(jobId);
    acceptedJobIds.delete(jobId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "parallel-save" && sender.id === chrome.runtime.id) {
    if (typeof message.jobId !== "string" || typeof message.url !== "string" || !message.dirHandle) {
      sendResponse({ ok: false, error: "invalid-parallel-save" });
      return false;
    }
    void (async () => {
      try {
        await report(message.jobId, { status: "running", statusText: "병렬 수신 준비 중…" });
        const filename = typeof message.filename === "string" && message.filename ? message.filename : "YouTube 영상.mp4";
        if (!message.dirHandle) throw new Error("no-save-sink");
        const fileHandle = await message.dirHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable({ keepExistingData: true });
        const sink = {
          write: (data) => writable.write(data),
          close: () => writable.close(),
          abort: () => writable.abort(),
        };
        const result = await parallelDownload({
          url: message.url,
          filename,
          createSink: async () => sink,
          onProgress: (written, total) => {
            const percent = Math.max(0, Math.min(100, Math.round((written / total) * 100)));
            void report(message.jobId, { status: "running", statusText: `수신 중… ${percent}%` });
          },
        });
        await report(message.jobId, {
          status: "completed",
          statusText: `저장 완료 (${Math.round(result.bytes / 1048576)} MB).`,
        });
        sendResponse({ ok: true, bytes: result.bytes });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "parallel-save-failed";
        await report(message.jobId, {
          status: "failed",
          statusText: "병렬 수신 실패",
          error: detail,
        });
        sendResponse({ ok: false, error: detail });
      }
    })();
    return true;
  }
  if (message?.type === "download-pause-state"
    && sender.id === chrome.runtime.id
    && typeof message.jobId === "string") {
    if (message.sourceClosed === true) {
      const state = runningJobs.get(message.jobId);
      if (state) {
        state.sourceClosed = true;
        state.paused = false;
      }
      const waiters = pauseWaiters.get(message.jobId);
      if (waiters) {
        pauseWaiters.delete(message.jobId);
        for (const resolve of waiters) resolve();
      }
      void report(message.jobId, {
        status: "failed",
        statusText: "원래 탭이 닫혀 다운로드가 중단되었습니다. Pro에서는 백그라운드 다운로드가 지원됩니다.",
        error: "source-tab-closed",
      });
      return false;
    }
    if (setPaused(message.jobId, message.paused === true)) {
      void report(message.jobId, message.paused
        ? { status: "paused", statusText: "일시정지 — 원래 페이지로 돌아가주세요." }
        : { status: "running", statusText: "다운로드를 계속합니다…" });
    }
    return false;
  }
  if (message?.type !== "run-download-job" || sender.id !== chrome.runtime.id) return false;
  if (typeof message.jobId !== "string" || !message.candidate) {
    sendResponse({ ok: false, error: "invalid-download-job" });
    return false;
  }
  if (acceptedJobIds.has(message.jobId)) {
    sendResponse({ ok: false, error: "duplicate-download-job" });
    return false;
  }
  acceptedJobIds.add(message.jobId);
  void run(message.jobId, message.candidate);
  sendResponse({ ok: true, concurrency: scheduler.concurrency });
  return false;
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "license-changed") return false;
  void resolvePlan().then((plan) => {
    setRuntimePlan(plan);
    scheduler.setConcurrency(plan.maxConcurrentMediaJobs);
  });
  return false;
});
