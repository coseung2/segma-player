import assert from "node:assert/strict";
import test from "node:test";

import { createDownloaderRegistry } from "./registry.js";

const registry = createDownloaderRegistry({});

test("transport registry selects one downloader from candidate media type", () => {
  assert.equal(registry.forCandidate({ mediaType: "PROGRESSIVE" }).id, "progressive");
  assert.equal(registry.forCandidate({ mediaType: "HLS_MASTER" }).id, "hls");
  assert.equal(registry.forCandidate({ mediaType: "HLS_MEDIA" }).id, "hls");
  assert.equal(registry.forCandidate({ mediaType: "DASH" }).id, "dash");
  assert.equal(registry.forCandidate({ mediaType: "UNKNOWN" }), null);
});

test("prepared downloads return to the same transport module", () => {
  assert.equal(registry.forPrepared({ type: "progressive" }).id, "progressive");
  assert.equal(registry.forPrepared({ type: "hls" }).id, "hls");
  assert.equal(registry.forPrepared({ type: "dash" }).id, "dash");
  assert.equal(registry.forPrepared({ type: "other" }), null);
});
