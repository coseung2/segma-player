import test from "node:test";
import assert from "node:assert/strict";

import { hlsPlaybackRecoveryDecision } from "./hls-playback-recovery.js";

test("nonfatal internal aborts remain with hls.js instead of consuming Aura recovery", () => {
  assert.deepEqual(hlsPlaybackRecoveryDecision({ details: "aborted", fatal: false }), {
    recover: false,
    alternate: false,
    classification: "nonfatal-internal-abort",
  });
});

test("fragment network failures request an alternate candidate", () => {
  for (const details of ["fragLoadError", "fragLoadTimeOut"]) {
    assert.deepEqual(hlsPlaybackRecoveryDecision({ details, fatal: false }), {
      recover: true,
      alternate: true,
      classification: "fragment-network-failure",
    });
  }
});

test("fatal failures recover while preserving fragment-family preference", () => {
  assert.deepEqual(hlsPlaybackRecoveryDecision({ details: "manifestLoadError", fatal: true }), {
    recover: true,
    alternate: false,
    classification: "fatal-hls-error",
  });
  assert.deepEqual(hlsPlaybackRecoveryDecision({ details: "fragParsingError", fatal: true }), {
    recover: true,
    alternate: true,
    classification: "fatal-hls-error",
  });
});

test("other nonfatal events are diagnostic only", () => {
  assert.deepEqual(hlsPlaybackRecoveryDecision({ details: "bufferStalledError", fatal: false }), {
    recover: false,
    alternate: false,
    classification: "nonfatal-hls-error",
  });
});
