import test from "node:test";
import assert from "node:assert/strict";
import { makeCandidate, normalizeOriginPath } from "./candidate.js";
import { rankCandidates } from "./candidate-ranking.js";
import { SITE_REGRESSION_FIXTURES as fixtures } from "./sites/regressions.js";
import { siteProfileForUrls } from "./sites/registry.js";
const PERMANENT_LIVE_TARGETS = Object.freeze([
  "https://asianporn.li/video/193189/250214-korean-bj/",
  "https://onlyjerk.net/2-asian-chicks-gets-smashed-by-latina-maximo-garcias-cock-rikakodesu-airi-minami/",
  "https://playmogo.com/d/j8k8xq9gilty",
  "https://beeg.com/-0211503327065170",
]);

function stateMap(value) {
  return new Map(Object.entries(value || {}).map(([frameId, state]) => [Number(frameId), state]));
}

function layoutMap(value) {
  return new Map((value || []).map((layout) => [normalizeOriginPath(layout.pageUrl), layout]));
}

test("permanent live media targets remain in the default monitor set", () => {
  const configured = new Set(fixtures.map((fixture) => fixture.liveUrl));
  for (const target of PERMANENT_LIVE_TARGETS) assert.equal(configured.has(target), true, target);
});

for (const fixture of fixtures) {
  test(`site target schema: ${fixture.id}`, () => {
    assert.match(fixture.id, /^[a-z0-9][a-z0-9-]+$/);
    const liveUrl = new URL(fixture.liveUrl);
    assert.equal(liveUrl.protocol, "https:");
    assert.equal(Number.isFinite(fixture.settleMs) && fixture.settleMs >= 2_000, true);
    assert.equal(typeof fixture.expected, "object");
    assert.equal(["on", "quiet", "site-allow", "off"].includes(fixture.recommendedAdblockMode), true);
    if (fixture.liveOnly) {
      assert.equal(Array.isArray(fixture.candidates), false);
      assert.equal(fixture.expected.minimumCandidateCount >= 1, true);
      assert.equal(fixture.expected.requireNonAdvertisementPrimary, true);
      if (fixture.expected.rejectedPrimaryPathPrefixes) {
        assert.equal(fixture.expected.rejectedPrimaryPathPrefixes.every((prefix) => prefix.startsWith("/")), true);
      }
    } else {
      assert.equal(Array.isArray(fixture.candidates) && fixture.candidates.length > 0, true);
      assert.equal(typeof fixture.expected.primaryHost, "string");
      if (fixture.expected.livePrimaryHostFlexible) assert.equal(typeof fixture.expected.primaryPlayer, "string");
    }
  });

  if (fixture.liveOnly) continue;
  test(`site regression: ${fixture.id}`, () => {
    const candidates = fixture.candidates.map((candidate) => makeCandidate({
      pageTitle: candidate.pageTitle,
      pageUrl: candidate.pageUrl,
      siteUrl: candidate.siteUrl || fixture.liveUrl,
      resourceUrl: candidate.resourceUrl,
      contentType: "application/vnd.apple.mpegurl",
      tabId: 1,
      frameId: candidate.frameId,
      main: candidate.main,
      detectionSource: candidate.source,
      player: candidate.player || "",
      sessionId: candidate.sessionId || "",
      confidence: candidate.confidence,
      observedAt: 1_700_000_000_000,
    }));
    assert.equal(candidates.every(Boolean), true, "fixture candidates must be valid");

    const ranked = rankCandidates(candidates, {
      frameStates: stateMap(fixture.frameStates),
      frameLayouts: layoutMap(fixture.frameLayouts),
      now: 1_700_000_005_000,
    });
    const primary = ranked.find((candidate) => candidate.main && !candidate.likelyAdvertisement);
    assert.ok(primary, "a non-ad primary candidate must be selected");
    assert.equal(new URL(primary.resourceUrl).hostname, fixture.expected.primaryHost);
    assert.equal(primary.siteId, siteProfileForUrls(fixture.liveUrl)?.id);
    if (fixture.expected.primaryPlayer) assert.equal(primary.player, fixture.expected.primaryPlayer);
    if (fixture.expected.rejectedAdvertisementHost) {
      const advertisement = ranked.find((candidate) =>
        new URL(candidate.resourceUrl).hostname === fixture.expected.rejectedAdvertisementHost);
      assert.ok(advertisement);
      assert.equal(advertisement.main, false);
      assert.equal(advertisement.likelyAdvertisement, true);
    }
  });
}
