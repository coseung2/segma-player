import test from "node:test";
import assert from "node:assert/strict";
import { GIBIBYTE, productPlan, youtubeQualityAllowed } from "./product-plan.js";

test("free edition exposes enforceable commercial limits", () => {
  assert.deepEqual(productPlan("free"), {
    id: "free",
    label: "일반",
    maxConcurrentMediaJobs: 1,
    maxDownloadBytes: 1 * GIBIBYTE,
    youtubeEnabled: true,
    youtubeMaxHeight: 1080,
    backgroundDownloads: false,
    downloadSpeedLimitBytesPerSecond: 4 * 1024 * 1024,
  });
});

test("pro edition removes the artificial byte and quality caps", () => {
  const plan = productPlan("pro");
  assert.equal(plan.maxConcurrentMediaJobs, 3);
  assert.equal(plan.maxDownloadBytes, null);
  assert.equal(plan.youtubeEnabled, true);
  assert.equal(plan.youtubeMaxHeight, null);
  assert.equal(plan.backgroundDownloads, true);
  assert.equal(plan.downloadSpeedLimitBytesPerSecond, null);
  assert.equal("koreanSubtitleTrack" in plan, false);
});

test("unknown editions fail closed to free", () => {
  assert.equal(productPlan("unknown").id, "free");
});

test("store General plan caps YouTube quality at 1080p", () => {
  const free = productPlan("free");
  assert.equal(youtubeQualityAllowed(free, "best"), false);
  assert.equal(youtubeQualityAllowed(free, "2160"), false);
  assert.equal(youtubeQualityAllowed(free, "1440"), false);
  assert.equal(youtubeQualityAllowed(free, "1080"), true);
  assert.equal(youtubeQualityAllowed(free, "720"), true);
  assert.equal(youtubeQualityAllowed(free, "480"), true);
  assert.equal(youtubeQualityAllowed(productPlan("pro"), "best"), true);
});
