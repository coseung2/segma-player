import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  qualityAllowedForPlan,
  qualityFormat,
  qualitySort,
  qualityTiersFromFormats,
} = require("./youtube-quality.cjs");

test("bounded YouTube quality keeps split streams available and caps with yt-dlp res sorting", () => {
  assert.equal(qualityFormat("1080"), "bv*+ba/b");
  assert.equal(qualitySort("1080"), "res:1080");
  assert.equal(qualitySort("best"), null);
});

test("format probe exposes standard user-facing tiers instead of raw encoder heights", () => {
  const tiers = qualityTiersFromFormats([
    { format_id: "audio", vcodec: "none", height: null },
    { format_id: "sb0", vcodec: "images", ext: "mhtml", width: 160, height: 90, format_note: "storyboard" },
    { format_id: "v1", vcodec: "av01", width: 498, height: 886, format_note: "480p" },
    { format_id: "v2", vcodec: "vp9", width: 1920, height: 1080, format_note: "1080p60" },
    { format_id: "v3", vcodec: "avc1", width: 1280, height: 720 },
  ]);
  assert.deepEqual(tiers, [1080, 720, 480]);
  assert.equal(tiers.includes(886), false);
  assert.deepEqual(qualityTiersFromFormats([
    { format_id: "vertical", vcodec: "av01", width: 498, height: 886 },
  ]), [480]);
});

test("free YouTube requests are server-enforced at 1080p", () => {
  assert.equal(qualityAllowedForPlan("1080", false), true);
  assert.equal(qualityAllowedForPlan("1440", false), false);
  assert.equal(qualityAllowedForPlan("best", false), false);
  assert.equal(qualityAllowedForPlan("best", true), true);
});
