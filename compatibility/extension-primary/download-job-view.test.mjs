import assert from "node:assert/strict";
import test from "node:test";
import { downloadJobView, retryableDownloadJob } from "./download-job-view.js";

test("derives truthful progress only from segment counts", () => {
  const segmented = downloadJobView({
    status: "running",
    statusText: "저장 중… 25/100 (12 MB)",
  });
  assert.deepEqual(segmented.progress, { mode: "determinate", value: 25 });
  assert.deepEqual(segmented.segments, { current: 25, total: 100, percent: 25 });

  const unknown = downloadJobView({ status: "running", statusText: "영상을 확인하는 중…" });
  assert.deepEqual(unknown.progress, { mode: "indeterminate", value: null });

  const checking = downloadJobView({ status: "running", statusText: "영상 정보 확인 완료 (100개 구간)." });
  assert.equal(checking.stage, "영상 확인");
});

test("derives determinate progress from save percentage text", () => {
  const saving = downloadJobView({ status: "running", statusText: "저장 중… 42% (13 MB)" });
  assert.deepEqual(saving.progress, { mode: "determinate", value: 42 });
  const noTotal = downloadJobView({ status: "running", statusText: "저장 중… (13 MB)" });
  assert.deepEqual(noTotal.progress, { mode: "indeterminate", value: null });
});

test("uses errors for failed jobs and terminal progress for completed jobs", () => {
  const failed = downloadJobView({ status: "failed", statusText: "실패", error: "키 해독 실패" });
  assert.equal(failed.message, "키 해독 실패");
  assert.deepEqual(failed.progress, { mode: "failed", value: null });

  const completed = downloadJobView({ status: "completed", statusText: "다운로드 완료" });
  assert.deepEqual(completed.progress, { mode: "determinate", value: 100 });

  const cancelled = downloadJobView({ status: "cancelled", statusText: "사용자가 다운로드를 취소했습니다." });
  assert.equal(cancelled.statusLabel, "취소됨");
  assert.equal(cancelled.stage, "취소됨");
  assert.deepEqual(cancelled.progress, { mode: "failed", value: null });
});

test("paused jobs show the return-to-page notice", () => {
  const paused = downloadJobView({
    status: "paused",
    statusText: "일시정지 — 원래 페이지로 돌아가주세요.",
  });
  assert.equal(paused.statusLabel, "일시정지");
  assert.equal(paused.stage, "일시정지");
  assert.equal(paused.message, "일시정지 — 원래 페이지로 돌아가주세요.");
  assert.deepEqual(paused.progress, { mode: "indeterminate", value: null });
});

test("offers retry only for failed or cancelled jobs explicitly marked retryable", () => {
  assert.equal(retryableDownloadJob({ status: "failed", retryable: true }), true);
  assert.equal(retryableDownloadJob({ status: "cancelled", retryable: true }), true);
  assert.equal(retryableDownloadJob({ status: "failed", retryable: false }), false);
  assert.equal(retryableDownloadJob({ status: "running", retryable: true }), false);
});
