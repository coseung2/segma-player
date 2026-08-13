import test from "node:test";
import assert from "node:assert/strict";
import {
  createDownloadJob,
  persistedDownloadJobs,
  publicDownloadJobs,
  retryPayloadForJob,
  updateDownloadJob,
} from "./download-jobs.js";

test("download jobs progress to a terminal state", () => {
  const queued = createDownloadJob({ id: "job-1", title: "영상", mediaType: "HLS", now: 10 });
  const running = updateDownloadJob(queued, { status: "running", statusText: "저장 중…" }, 20);
  const paused = updateDownloadJob(running, { status: "paused", statusText: "일시정지 — 원래 페이지로 돌아가주세요." }, 25);
  assert.equal(paused.status, "paused");
  assert.equal(paused.statusText, "일시정지 — 원래 페이지로 돌아가주세요.");
  const resumed = updateDownloadJob(paused, { status: "running", statusText: "다운로드를 계속합니다…" }, 28);
  assert.equal(resumed.status, "running");
  const completed = updateDownloadJob(resumed, { status: "completed", statusText: "완료" }, 30);
  assert.equal(completed.status, "completed");
  assert.equal(completed.updatedAt, 30);
  assert.equal(updateDownloadJob(completed, { status: "failed" }, 40), completed);
});

test("download job list is newest first and contains popup-safe fields", () => {
  const older = createDownloadJob({ id: "old", title: "old", mediaType: "MP4", now: 1 });
  const newer = createDownloadJob({ id: "new", title: "new", mediaType: "YOUTUBE", source: "youtube", now: 2 });
  assert.deepEqual(publicDownloadJobs([older, newer], 1), [{
    id: "new", title: "new", mediaType: "YOUTUBE", status: "queued",
    statusText: "다운로드 대기 중…", error: "", folderName: "", createdAt: 2, updatedAt: 2, source: "youtube",
    retryable: false,
  }]);
});

test("failed jobs expose retry capability without exposing the private payload", () => {
  const retryPayload = { kind: "media", candidate: { resourceUrl: "https://media.example/video.mp4" } };
  const queued = createDownloadJob({
    id: "retry-job",
    title: "영상",
    mediaType: "PROGRESSIVE",
    retryPayload,
    now: 1,
  });
  assert.equal(retryPayloadForJob(queued), null);
  const failed = updateDownloadJob(queued, { status: "failed", error: "network" }, 2);
  assert.equal(retryPayloadForJob(failed), retryPayload);
  const [publicJob] = publicDownloadJobs([failed]);
  assert.equal(publicJob.retryable, true);
  assert.equal("retryPayload" in publicJob, false);
  assert.equal("retryPayload" in persistedDownloadJobs([failed])[0], false);
  const completed = updateDownloadJob(queued, { status: "completed" }, 3);
  assert.equal(completed.retryPayload, null);
});
