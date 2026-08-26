import assert from "node:assert/strict";
import test from "node:test";

import { classifyDownloadMode, DOWNLOAD_MODES } from "./download-mode.js";

test("classifies direct progressive media", () => {
  assert.equal(classifyDownloadMode({ mediaType: "PROGRESSIVE" }), DOWNLOAD_MODES.DIRECT_PROGRESSIVE);
});

test("classifies HLS manifests by response type", () => {
  assert.equal(classifyDownloadMode({ mediaType: "HLS_MEDIA" }), DOWNLOAD_MODES.HLS_MANIFEST);
});

test("classifies Level5 HLS as an authenticated source-frame mode", () => {
  assert.equal(classifyDownloadMode({
    mediaType: "HLS_MEDIA",
    player: "level5",
    detectionSource: "player-adapter",
  }), DOWNLOAD_MODES.AUTHENTICATED_SOURCE_FRAME);
});

test("classifies JSON player APIs before generic HLS handling", () => {
  assert.equal(classifyDownloadMode({
    mediaType: "HLS_MEDIA",
    player: "api-json",
    detectionSource: "player-adapter",
  }), DOWNLOAD_MODES.PLAYER_API);
});

test("classifies player pages and remote YouTube jobs", () => {
  assert.equal(classifyDownloadMode({ resourceUrl: "https://playmogo.com/d/example" }), DOWNLOAD_MODES.PLAYER_PAGE_GRAPH);
  assert.equal(classifyDownloadMode({ pageUrl: "https://www.youtube.com/watch?v=abc" }), DOWNLOAD_MODES.REMOTE_SERVICE);
});

test("classifies hosted embed pages as player-graph work", () => {
  assert.equal(classifyDownloadMode({ resourceUrl: "https://filemoon.sx/e/abc123xyz" }), DOWNLOAD_MODES.PLAYER_PAGE_GRAPH);
  assert.equal(classifyDownloadMode({ resourceUrl: "https://cdn.example/embed/abc123xyz" }), DOWNLOAD_MODES.PLAYER_PAGE_GRAPH);
});

test("keeps provider hostname out of the generic transport classifier", () => {
  assert.equal(classifyDownloadMode({ pageUrl: "https://doodstream.com/e/example", mediaType: "PROGRESSIVE" }),
    DOWNLOAD_MODES.DIRECT_PROGRESSIVE);
});

test("classifies Dood player evidence as authenticated frame mode", () => {
  assert.equal(classifyDownloadMode({
    pageUrl: "https://doodstream.com/e/example",
    mediaType: "PROGRESSIVE",
    player: "dood",
    detectionSource: "player-adapter",
  }), DOWNLOAD_MODES.AUTHENTICATED_SOURCE_FRAME);
});
