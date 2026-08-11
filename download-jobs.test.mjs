import test from "node:test";
import assert from "node:assert/strict";
import { createDownloadJob, publicDownloadJobs, updateDownloadJob } from "./download-jobs.js";

test("download jobs progress to a terminal state", () => {
  const queued = createDownloadJob({ id: "job-1", title: "영상", mediaType: "HLS", now: 10 });
  const running = updateDownloadJob(queued, { status: "running", statusText: "저장 중…" }, 20);
  const completed = updateDownloadJob(running, { status: "completed", statusText: "완료" }, 30);
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
  }]);
});
