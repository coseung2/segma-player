import assert from "node:assert/strict";
import test from "node:test";
import { downloadJobView } from "./download-job-view.js";

test("derives truthful progress only from segment counts", () => {
  const segmented = downloadJobView({
    status: "running",
    statusText: "세그먼트 25/100 저장 중… (12 MB, 6개 병렬 수신)",
  });
  assert.deepEqual(segmented.progress, { mode: "determinate", value: 25 });
  assert.deepEqual(segmented.segments, { current: 25, total: 100, percent: 25 });

  const unknown = downloadJobView({ status: "running", statusText: "영상을 확인하는 중…" });
  assert.deepEqual(unknown.progress, { mode: "indeterminate", value: null });
});

test("uses errors for failed jobs and terminal progress for completed jobs", () => {
  const failed = downloadJobView({ status: "failed", statusText: "실패", error: "키 해독 실패" });
  assert.equal(failed.message, "키 해독 실패");
  assert.deepEqual(failed.progress, { mode: "failed", value: null });

  const completed = downloadJobView({ status: "completed", statusText: "다운로드 완료" });
  assert.deepEqual(completed.progress, { mode: "determinate", value: 100 });
});
