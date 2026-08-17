import assert from "node:assert/strict";
import test from "node:test";

import { downloadPolicyForCandidate } from "./download-policy.js";

test("Dood source-frame behavior is isolated behind the provider adapter", () => {
  const dood = downloadPolicyForCandidate({
    mediaType: "PROGRESSIVE",
    pageUrl: "https://doodstream.com/e/example",
    resourceUrl: "https://cdn.example/video",
    player: "dood",
  });
  assert.equal(dood.adapterId, "dood");
  assert.equal(dood.providerId, "dood");
  assert.equal(dood.downloaderId, "progressive");
  assert.equal(dood.preserveSourceFrame, true);
  assert.equal(dood.preferSourceFrameProgressive, true);

  const generic = downloadPolicyForCandidate({
    mediaType: "PROGRESSIVE",
    pageUrl: "https://example.com/watch",
    resourceUrl: "https://media.example/video.mp4",
  });
  assert.equal(generic.adapterId, "generic");
  assert.equal(generic.siteId, "generic");
  assert.equal(generic.downloaderId, "progressive");
  assert.equal(generic.preferSourceFrameProgressive, false);
});

test("site profile selects preferred providers without implementing the transport", () => {
  const missav = downloadPolicyForCandidate({
    siteUrl: "https://missav123.com/ko/example",
    pageUrl: "https://player.example/embed/1",
    resourceUrl: "https://surrit.com/hls/master.m3u8",
    mediaType: "HLS_MEDIA",
    player: "hls.js",
  });
  assert.equal(missav.siteId, "missav");
  assert.equal(missav.providerId, "hlsjs");
  assert.equal(missav.downloaderId, "hls");
  assert.deepEqual(missav.siteDownloaderOrder, ["hls", "progressive"]);
});
