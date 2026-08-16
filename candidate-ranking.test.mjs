import test from "node:test";
import assert from "node:assert/strict";

import {
  makeCandidate,
  mediaUrlFreshness,
  upsertCandidate,
} from "./candidate.js";
import { rankCandidates, scoreCandidate } from "./candidate-ranking.js";

function hlsCandidate({
  pageUrl,
  resourceUrl,
  tabId = 1,
  frameId,
  source = "web-response",
  player = "",
  sessionId = "",
  confidence = 90,
  pageTitle = "Video",
  main = false,
}) {
  return makeCandidate({
    pageTitle,
    pageUrl,
    resourceUrl,
    contentType: "application/vnd.apple.mpegurl",
    tabId,
    frameId,
    main,
    detectionSource: source,
    player,
    sessionId,
    confidence,
    observedAt: 1_700_000_000_000,
  });
}

test("MissAV-style ad iframe loses to the actively playing surrit manifest", () => {
  const advertisement = hlsCandidate({
    pageUrl: "https://ads.example/preroll/frame",
    resourceUrl: "https://ads.example/preroll/master.m3u8?token=ad",
    frameId: 2,
    source: "web-response",
    pageTitle: "Advertisement",
    main: true,
  });
  const feature = hlsCandidate({
    pageUrl: "https://missav123.com/ko/simd-012",
    resourceUrl: "https://surrit.com/hls/simd-012/master.m3u8?token=feature",
    frameId: 0,
    source: "player-adapter",
    player: "hls.js",
    sessionId: "hls:1",
    confidence: 100,
  });
  const frameStates = new Map([
    [0, { playing: true, muted: false, visibleArea: 921_600, viewportRatio: 0.7, durationMs: 2_700_000, topFrame: true }],
    [2, { playing: true, muted: true, visibleArea: 921_600, viewportRatio: 0.7, durationMs: 8_000, topFrame: false }],
  ]);
  const frameLayouts = new Map([
    ["https://ads.example/preroll/frame", { viewportRatio: 0.7, adHint: true }],
  ]);

  const ranked = rankCandidates([advertisement, feature], {
    frameStates,
    frameLayouts,
    now: 1_700_000_005_000,
  });

  assert.equal(ranked[0], feature);
  assert.equal(feature.main, true);
  assert.equal(feature.classification, "primary");
  assert.equal(advertisement.main, false);
  assert.equal(advertisement.likelyAdvertisement, true);
  assert.ok(feature.score > advertisement.score);
});

test("Level5 player evidence and exact iframe playback state outrank incidental network HLS", () => {
  const level5 = hlsCandidate({
    pageUrl: "https://p.nnvivi.site/player/39141",
    resourceUrl: "https://media.nnvivi.site/level5/master.m3u8?token=fresh",
    frameId: 7,
    source: "player-adapter",
    player: "level5",
    sessionId: "level5:3",
    confidence: 100,
  });
  const incidental = hlsCandidate({
    pageUrl: "https://av19t.com/bj/39141",
    resourceUrl: "https://metrics.example/assets/live.m3u8",
    frameId: 0,
    source: "performance",
    confidence: 35,
  });
  const frameStates = new Map([
    [7, { playing: true, muted: false, visibleArea: 640_000, viewportRatio: 0.5, durationMs: 1_800_000 }],
    [0, { playing: false, muted: false, visibleArea: 0, viewportRatio: 0, durationMs: 0, topFrame: true }],
  ]);

  rankCandidates([incidental, level5], { frameStates, now: 1_700_000_005_000 });

  assert.equal(level5.main, true);
  assert.equal(incidental.main, false);
  assert.ok(scoreCandidate(level5, { frameStates, now: 1_700_000_005_000 }).score
    > scoreCandidate(incidental, { frameStates, now: 1_700_000_005_000 }).score);
});

test("stale iframe playback state expires instead of pinning an old advertisement as primary", () => {
  const candidate = hlsCandidate({
    pageUrl: "https://ads.example/preroll/frame",
    resourceUrl: "https://cdn.example/content/master.m3u8",
    frameId: 9,
    source: "web-response",
    pageTitle: "Video",
  });
  const now = 1_700_000_100_000;
  const staleState = new Map([[9, {
    playing: true,
    muted: false,
    visibleArea: 1_000_000,
    viewportRatio: 0.8,
    durationMs: 3_600_000,
    observedAt: now - 31_000,
  }]]);

  const staleScore = scoreCandidate(candidate, { frameStates: staleState, now }).score;
  const baselineScore = scoreCandidate(candidate, { now }).score;
  assert.equal(staleScore, baselineScore);
});

test("token freshness recognizes common expiry formats without altering the original URL", () => {
  const url = "https://cdn.example/master.m3u8?token=secret&expires=2000000000";
  const freshness = mediaUrlFreshness(url, 1_900_000_000_000);
  assert.equal(freshness.tokenized, true);
  assert.equal(freshness.expiresAt, 2_000_000_000_000);
  assert.ok(freshness.refreshAfter < freshness.expiresAt);
  assert.ok(freshness.refreshAfter >= 1_900_000_000_000);
});

test("upsert preserves the newest exact token URL while merging independent evidence", () => {
  const candidates = new Map();
  const stale = hlsCandidate({
    pageUrl: "https://player.example/embed",
    resourceUrl: "https://cdn.example/master.m3u8?token=stale&expires=1900000000",
    frameId: 4,
    source: "web-response",
  });
  const fresh = hlsCandidate({
    pageUrl: "https://player.example/embed",
    resourceUrl: "https://cdn.example/master.m3u8?token=fresh&expires=2000000000",
    frameId: 4,
    source: "player-adapter",
    player: "hls.js",
    sessionId: "hls:4",
    confidence: 100,
  });

  const first = upsertCandidate(candidates, stale);
  const merged = upsertCandidate(candidates, fresh);

  assert.equal(merged, first);
  assert.equal(candidates.size, 1);
  assert.match(merged.resourceUrl, /token=fresh/);
  assert.equal(merged.evidence.some((item) => item.source === "web-response"), true);
  assert.equal(merged.evidence.some((item) => item.source === "player-adapter"), true);
  assert.doesNotMatch(merged.displayUrl, /stale|fresh/);
});
