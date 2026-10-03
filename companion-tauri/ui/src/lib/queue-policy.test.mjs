import test from "node:test";
import assert from "node:assert/strict";
import { canRemoveHistory, matchesQueueFilter, actionHasSettled, jobQuality, jobRowTitle } from "./queue-policy.ts";

const job = (overrides = {}) => ({ jobType: "media", status: "completed", active: false, paused: false, updatedAt: 1, ...overrides });

test("one-line job row shows a clean title and the quality tag", () => {
  const yt = { fileName: "[1440p] ZOOM - JESSI (KINETIC TYPO).mp4", title: "ZOOM - JESSI", inputKind: null };
  assert.equal(jobQuality(yt), "1440p");
  assert.equal(jobRowTitle(yt), "ZOOM - JESSI (KINETIC TYPO)");
  const site = { fileName: "FC2-PPV-1788676 한글자막 _ 자막공방 [efbb8c0b-db6].mp4", title: "FC2", inputKind: "PROGRESSIVE" };
  assert.equal(jobQuality(site), "");
  assert.equal(jobRowTitle(site), "FC2-PPV-1788676 한글자막 _ 자막공방");
  assert.equal(jobQuality({ fileName: null, title: "Episode 8", inputKind: "HLS_MEDIA" }), "HLS");
  assert.equal(jobRowTitle({ fileName: null, title: "Episode 8" }), "Episode 8");
  assert.equal(jobQuality({ fileName: "Movie 720p60_x264.mp4", title: "", inputKind: null }), "720p");
});

test("history deletion keeps active, paused, and subtitle work", () => {
  for (const status of ["completed", "failed", "cancelled"]) assert.equal(canRemoveHistory(job({ status })), true);
  for (const candidate of [job({ active: true }), job({ paused: true }), job({ status: "queued" }), job({ jobType: "subtitle", status: "running", active: true }), job({ jobType: "cloud" })]) assert.equal(canRemoveHistory(candidate), false);
  for (const status of ["completed", "failed", "cancelled"]) assert.equal(canRemoveHistory(job({ jobType: "subtitle", status })), true);
});

test("completed missing files remain in completed filter and cancellations have a separate filter", () => {
  assert.equal(matchesQueueFilter(job({ tone: "warning", statusLabel: "파일 없음" }), "complete"), true);
  assert.equal(matchesQueueFilter(job({ status: "cancelled", tone: "warning" }), "cancelled"), true);
  assert.equal(matchesQueueFilter(job({ status: "cancelled" }), "failed"), false);
  assert.equal(matchesQueueFilter(job({ jobType: "subtitle" }), "all"), false);
});

test("cancel acknowledgement is pending until the authoritative job stops", () => {
  const pending = { action: "cancel", requestedAt: 1, previousUpdatedAt: 1 };
  assert.equal(actionHasSettled(job({ status: "running", active: true, updatedAt: 2 }), pending), false);
  assert.equal(actionHasSettled(job({ status: "paused", paused: true }), pending), false);
  assert.equal(actionHasSettled(job({ status: "cancelled" }), pending), true);
});
