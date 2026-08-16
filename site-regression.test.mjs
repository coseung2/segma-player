import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { makeCandidate, normalizeOriginPath } from "./candidate.js";
import { rankCandidates } from "./candidate-ranking.js";

const fixtures = JSON.parse(await readFile(new URL("./media-site-regressions.json", import.meta.url), "utf8"));

function stateMap(value) {
  return new Map(Object.entries(value || {}).map(([frameId, state]) => [Number(frameId), state]));
}

function layoutMap(value) {
  return new Map((value || []).map((layout) => [normalizeOriginPath(layout.pageUrl), layout]));
}

for (const fixture of fixtures) {
  test(`site regression: ${fixture.id}`, () => {
    const candidates = fixture.candidates.map((candidate) => makeCandidate({
      pageTitle: candidate.pageTitle,
      pageUrl: candidate.pageUrl,
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
