import { downloadPreparedCandidate, prepareDownloadCandidate } from "./hls-download.js";
import { createDownloadScheduler } from "./download-scheduler.js";

const MAX_CONCURRENT_MEDIA_JOBS = 3;
const scheduler = createDownloadScheduler({ concurrency: MAX_CONCURRENT_MEDIA_JOBS });
const acceptedJobIds = new Set();

async function report(jobId, patch) {
  await chrome.runtime.sendMessage({ type: "download-job-update", jobId, patch }).catch(() => {});
}

async function run(jobId, candidate) {
  const folder = null;
  const folderName = "Downloads\\Aura Media";
  await report(jobId, { status: "running", statusText: "다운로드를 준비하는 중…", folderName });
  try {
    const prepared = await prepareDownloadCandidate(candidate, {
      folder,
      onStatus: (statusText) => void report(jobId, { status: "running", statusText }),
    });
    await report(jobId, {
      status: "running",
      statusText: "준비 완료 · 다운로드 대기 중 (페이지를 벗어나도 계속됩니다).",
      folderName,
    });
    const result = await scheduler.schedule(async () => {
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
  }
  acceptedJobIds.delete(jobId);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
  sendResponse({ ok: true, concurrency: MAX_CONCURRENT_MEDIA_JOBS });
  return false;
});
