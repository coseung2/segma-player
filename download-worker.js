import { downloadPreparedCandidate, prepareDownloadCandidate, setRuntimePlan } from "./hls-download.js";
import { parallelDownload } from "./parallel-download.js";
import { createDownloadScheduler } from "./download-scheduler.js";
import { PRODUCT_EDITION } from "./edition.js";
import { resolvePlan } from "./license.js";
import { productPlan } from "./product-plan.js";
import { clearAllDownloadCheckpoints } from "./download-checkpoint.js";
import { createUniqueFile, getStoredSaveDirectory, hasReadWritePermission } from "./save-directory.js";
import {
  MIN_HEARTBEAT_CADENCE_MS,
  heartbeatPortName,
  shouldKeepWorkerAlive,
} from "./worker-lifecycle.js";

const FALLBACK_PLAN = productPlan(PRODUCT_EDITION);
const scheduler = createDownloadScheduler({ concurrency: FALLBACK_PLAN.maxConcurrentMediaJobs });
const acceptedJobIds = new Set();
const cancelledJobIds = new Set();
const runningJobs = new Map();
const pauseWaiters = new Map();
const PREPARATION_TIMEOUT_MS = 45_000;
let heartbeatPort = null;
let heartbeatTimer = null;
let heartbeatReconnectTimer = null;

function workerHasActiveWork() {
  return shouldKeepWorkerAlive({
    activeDownloads: runningJobs.size,
  });
}

function disconnectWorkerHeartbeat() {
  if (heartbeatReconnectTimer !== null) clearTimeout(heartbeatReconnectTimer);
  heartbeatReconnectTimer = null;
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  const port = heartbeatPort;
  heartbeatPort = null;
  try { port?.disconnect(); } catch { /* already disconnected */ }
}

function syncWorkerHeartbeat() {
  if (!workerHasActiveWork()) {
    disconnectWorkerHeartbeat();
    return;
  }
  if (heartbeatPort) return;
  try {
    const port = chrome.runtime.connect({ name: heartbeatPortName("download-worker") });
    heartbeatPort = port;
    port.postMessage({ active: true, at: Date.now() });
    heartbeatTimer = setInterval(() => {
      try { heartbeatPort?.postMessage({ active: workerHasActiveWork(), at: Date.now() }); } catch { /* reconnect below */ }
    }, MIN_HEARTBEAT_CADENCE_MS);
    port.onDisconnect.addListener(() => {
      if (heartbeatPort === port) heartbeatPort = null;
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      if (workerHasActiveWork()) {
        heartbeatReconnectTimer = setTimeout(() => {
          heartbeatReconnectTimer = null;
          syncWorkerHeartbeat();
        }, 1_000);
      }
    });
  } catch {
    heartbeatPort = null;
  }
}

function rememberCancelledJob(jobId) {
  cancelledJobIds.add(jobId);
  if (cancelledJobIds.size > 100) cancelledJobIds.delete(cancelledJobIds.values().next().value);
}

async function report(jobId, patch) {
  await chrome.runtime.sendMessage({ type: "download-job-update", jobId, patch }).catch(() => {});
}

function cancellationError() {
  const error = new Error("사용자가 다운로드를 취소했습니다.");
  error.code = "download-cancelled";
  return error;
}

async function prepareWithTimeout(candidate, options, signal = null) {
  let timer;
  let abortListener = null;
  try {
    return await Promise.race([
      prepareDownloadCandidate(candidate, options),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          "영상 준비 응답이 없습니다. 다른 플레이어를 재생한 뒤 다시 시도해 주세요.",
        )), PREPARATION_TIMEOUT_MS);
      }),
      new Promise((_, reject) => {
        abortListener = () => reject(cancellationError());
        if (signal?.aborted) abortListener();
        else signal?.addEventListener?.("abort", abortListener, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", abortListener);
  }
}

async function waitWhilePaused(jobId) {
  const state = runningJobs.get(jobId);
  if (state?.cancelled || state?.controller?.signal.aborted) throw cancellationError();
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
  if (state.cancelled || state.controller?.signal.aborted) throw cancellationError();
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
  const controller = new AbortController();
  runningJobs.set(jobId, { paused: false, sourceClosed: false, cancelled: false, lease: null, controller });
  syncWorkerHeartbeat();
  const plan = await resolvePlan();
  setRuntimePlan(plan);
  scheduler.setConcurrency(plan.maxConcurrentMediaJobs);
  const folderName = "Downloads\\Aura Media";
  await report(jobId, { status: "running", statusText: "다운로드를 준비하는 중…", folderName });
  try {
    const prepared = await prepareWithTimeout(candidate, {
      onStatus: (statusText) => void report(jobId, { status: "running", statusText }),
      pauseGate: () => waitWhilePaused(jobId),
      signal: controller.signal,
    }, controller.signal);
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
    const cancelled = controller.signal.aborted || error?.code === "download-cancelled";
    const message = error instanceof Error ? error.message : "다운로드에 실패했습니다.";
    if (cancelled && typeof candidate?.id === "string") {
      await clearAllDownloadCheckpoints(`media:${candidate.id}`).catch(() => {});
    }
    await report(jobId, {
      status: cancelled ? "cancelled" : "failed",
      statusText: message,
      error: cancelled ? "" : message,
      errorCode: cancelled ? "" : (typeof error?.code === "string" ? error.code : ""),
      folderName,
    });
  } finally {
    runningJobs.delete(jobId);
    syncWorkerHeartbeat();
    pauseWaiters.delete(jobId);
    acceptedJobIds.delete(jobId);
  }
}

async function runParallelSave(message) {
  const controller = new AbortController();
  runningJobs.set(message.jobId, { cancelled: false, controller, kind: "parallel" });
  syncWorkerHeartbeat();
  let directoryHandle = null;
  let allocatedFilename = "";
  try {
    await report(message.jobId, { status: "running", statusText: "저장 준비 중…" });
    directoryHandle = await getStoredSaveDirectory();
    if (!directoryHandle) {
      throw new Error("저장 폴더 권한이 없습니다. 다운로드 버튼을 다시 눌러 폴더를 선택해 주세요.");
    }
    if (!(await hasReadWritePermission(directoryHandle))) {
      const error = new Error("저장 폴더 권한이 만료되었습니다. 다운로드 버튼을 다시 눌러 폴더를 선택해 주세요.");
      error.code = "save-permission-required";
      throw error;
    }
    const filename = typeof message.filename === "string" && message.filename ? message.filename : "YouTube 영상.mp4";
    let allocation;
    try {
      allocation = await createUniqueFile(directoryHandle, filename);
    } catch (error) {
      const permissionExpired = error?.name === "NotAllowedError";
      const allocationFailure = new Error(permissionExpired
        ? "저장 폴더 권한이 만료되었습니다. 다운로드 버튼을 다시 눌러 폴더를 선택해 주세요."
        : "저장 폴더에 새 파일을 만들 수 없습니다.");
      if (permissionExpired) allocationFailure.code = "save-permission-required";
      throw allocationFailure;
    }
    allocatedFilename = allocation.filename;
    const writable = await allocation.fileHandle.createWritable();
    const sink = {
      write: (data) => writable.write(data),
      close: () => writable.close(),
      abort: () => writable.abort(),
    };
    const result = await parallelDownload({
      url: message.url,
      filename: allocatedFilename,
      createSink: async () => sink,
      signal: controller.signal,
      onProgress: (written, total) => {
        const percent = Math.max(0, Math.min(100, Math.round((written / total) * 100)));
        void report(message.jobId, { status: "running", statusText: `저장 중… ${percent}%` });
      },
    });
    await report(message.jobId, {
      status: "completed",
      statusText: `저장 완료 · ${allocatedFilename} (${Math.round(result.bytes / 1048576)} MB)`,
    });
  } catch (error) {
    if (directoryHandle && allocatedFilename) {
      await directoryHandle.removeEntry?.(allocatedFilename).catch(() => {});
    }
    const cancelled = controller.signal.aborted || error?.code === "download-cancelled";
    const detail = cancelled ? "사용자가 다운로드를 취소했습니다."
      : (error instanceof Error ? error.message : "parallel-save-failed");
    await report(message.jobId, {
      status: cancelled ? "cancelled" : "failed",
      statusText: cancelled ? detail : "저장 실패",
      error: cancelled ? "" : detail,
    });
  } finally {
    runningJobs.delete(message.jobId);
    syncWorkerHeartbeat();
    acceptedJobIds.delete(message.jobId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "download-worker-heartbeat" && sender.id === chrome.runtime.id) {
    syncWorkerHeartbeat();
    sendResponse({ ok: true, active: workerHasActiveWork() });
    return false;
  }
  if (message?.type === "cancel-download-worker-job"
    && sender.id === chrome.runtime.id
    && typeof message.jobId === "string") {
    const state = runningJobs.get(message.jobId);
    rememberCancelledJob(message.jobId);
    if (!state) {
      sendResponse({ ok: true, pending: true });
      return false;
    }
    state.cancelled = true;
    state.paused = false;
    state.controller?.abort();
    const waiters = pauseWaiters.get(message.jobId);
    if (waiters) {
      pauseWaiters.delete(message.jobId);
      for (const resolve of waiters) resolve();
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "parallel-save" && sender.id === chrome.runtime.id) {
    if (typeof message.jobId !== "string" || typeof message.url !== "string") {
      sendResponse({ ok: false, error: "invalid-parallel-save" });
      return false;
    }
    if (acceptedJobIds.has(message.jobId)) {
      sendResponse({ ok: false, error: "duplicate-download-job" });
      return false;
    }
    if (cancelledJobIds.has(message.jobId)) {
      sendResponse({ ok: false, error: "download-cancelled" });
      return false;
    }
    acceptedJobIds.add(message.jobId);
    void runParallelSave(message);
    sendResponse({ ok: true });
    return false;
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
  if (cancelledJobIds.has(message.jobId)) {
    sendResponse({ ok: false, error: "download-cancelled" });
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
