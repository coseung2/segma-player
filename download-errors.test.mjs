import test from "node:test";
import assert from "node:assert/strict";

import {
  candidateDownloadErrorCode,
  candidateDownloadErrorLabel,
  candidateDownloadErrorMessage,
} from "./download-errors.js";

test("preserves route failures instead of collapsing them to unsupported media", () => {
  assert.equal(candidateDownloadErrorCode({ code: "route-unavailable" }), "route-unavailable");
  assert.equal(candidateDownloadErrorCode(new Error("route-timeout")), "route-timeout");
  assert.equal(candidateDownloadErrorCode(new Error("other failure")), "unsupported-media");
});

test("shows actionable Korean network guidance for legacy route failures", () => {
  assert.equal(candidateDownloadErrorLabel("route-unavailable"), "네트워크 확인");
  assert.match(candidateDownloadErrorMessage("route-unavailable"), /네트워크 연결/);
  assert.match(candidateDownloadErrorMessage("route-timeout"), /시간이 초과/);
});
