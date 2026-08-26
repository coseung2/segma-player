import test from "node:test";
import assert from "node:assert/strict";
import {
  createDownloadJob,
  persistedDownloadJobs,
  publicCompanionJobs,
  publicDownloadJobs,
  retryPayloadForJob,
  terminalDownloadJob,
  updateDownloadJob,
} from "./download-jobs.js";

test("download jobs progress to a terminal state", () => {
  const queued = createDownloadJob({
    id: "job-1",
    title: "영상",
    mediaType: "HLS",
    candidateId: "candidate-1",
    now: 10,
  });
  const running = updateDownloadJob(queued, {
    title: "인식된 영상 제목",
    status: "running",
    statusText: "저장 중…",
  }, 20);
  assert.equal(running.title, "인식된 영상 제목");
  assert.equal(running.candidateId, "candidate-1");
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
    id: "new", title: "new", mediaType: "YOUTUBE", candidateId: "", status: "queued",
    statusText: "다운로드 대기 중…", error: "", errorCode: "", folderName: "", createdAt: 2, updatedAt: 2, source: "youtube",
    retryable: false,
  }]);
});

test("Companion jobs are the authoritative popup-safe job projection", () => {
  assert.deepEqual(publicCompanionJobs([
    {
      jobId: "media-1",
      jobType: "media-download",
      candidateId: "candidate-1",
      inputKind: "HLS_MASTER",
      title: "Detected video",
      status: "running",
      statusText: "42%",
      createdAt: 10,
      updatedAt: 20,
      progress: 42,
      fileName: "private-name.mp4",
    },
    {
      jobId: "media-2",
      inputKind: "PROGRESSIVE",
      status: "failed",
      error: "network",
      createdAt: 30,
      updatedAt: 40,
    },
  ]), [
    {
      id: "media-2", title: "Segma Player 다운로드", mediaType: "PROGRESSIVE", candidateId: "",
      status: "failed", statusText: "Segma Player에서 처리 중…", error: "network", errorCode: "",
      folderName: "", createdAt: 30, updatedAt: 40, source: "companion", retryable: true,
    },
    {
      id: "media-1", title: "Detected video", mediaType: "HLS_MASTER", candidateId: "candidate-1",
      status: "running", statusText: "42%", error: "", errorCode: "", folderName: "",
      createdAt: 10, updatedAt: 20, source: "companion", retryable: false,
    },
  ]);
});

test("download jobs preserve Companion ownership without accepting arbitrary sources", () => {
  assert.equal(createDownloadJob({ id: "subtitle-1", source: "companion" }).source, "companion");
  assert.equal(createDownloadJob({ id: "unknown-1", source: "untrusted" }).source, "media");
});

test("download job diagnostics expose only redacted candidate metadata", () => {
  const job = createDownloadJob({
    id: "diagnostic-job",
    title: "AV19",
    mediaType: "PROGRESSIVE",
    candidateId: "candidate-1",
    diagnostic: {
      resource: "https://media.example/cast2/abc/video.mp4?token=[redacted]",
      mediaType: "PROGRESSIVE",
      downloadMode: "AUTHENTICATED_SOURCE_FRAME",
      downloaderId: "progressive",
      providerId: "level5",
      siteId: "av19",
      frameId: 2,
      player: "nnvivi",
      sessionId: "session-1",
      source: "media-element",
      requestType: "media",
      main: false,
      score: 41,
    },
  });
  assert.deepEqual(publicDownloadJobs([job])[0].diagnostic, {
    resource: "https://media.example/cast2/abc/video.mp4?token=[redacted]",
    mediaType: "PROGRESSIVE",
    downloadMode: "AUTHENTICATED_SOURCE_FRAME",
    downloaderId: "progressive",
    providerId: "level5",
    siteId: "av19",
    frameId: 2,
    player: "nnvivi",
    sessionId: "session-1",
    source: "media-element",
    requestType: "media",
    main: false,
    score: 41,
  });
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
  assert.deepEqual(persistedDownloadJobs([failed])[0].retryPayload, retryPayload);
  const completed = updateDownloadJob(queued, { status: "completed" }, 3);
  assert.equal(completed.retryPayload, null);

  const cancelled = updateDownloadJob(queued, { status: "cancelled", statusText: "사용자가 취소했습니다." }, 4);
  assert.equal(publicDownloadJobs([cancelled])[0].retryable, true);
  assert.equal(retryPayloadForJob(cancelled), retryPayload);
  assert.equal(terminalDownloadJob(cancelled), true);
  assert.equal(terminalDownloadJob(queued), false);
});
