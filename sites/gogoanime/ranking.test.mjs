import test from "node:test";
import assert from "node:assert/strict";
import { makeCandidate } from "../../candidate.js";
import { rankCandidates } from "../../candidate-ranking.js";
import { gogoanimeRegressions } from "./regressions.js";

function candidates(siteUrl = gogoanimeRegressions[0].liveUrl) {
  return gogoanimeRegressions[0].candidates.map((item) => makeCandidate({
    ...item, tabId: 1, siteUrl, pageUrl: siteUrl,
    detectionSource: item.source, observedAt: 1_700_000_000_000,
  }));
}

test("Gogoanime episode transport outranks a more strongly observed auxiliary video", () => {
  const ranked = rankCandidates(candidates(), { now: 1_700_000_005_000 });
  assert.equal(new URL(ranked.find((item) => item.main).resourceUrl).hostname, "rr4---sn-npoe7nl6.googlevideo.com");
});

test("Gogoanime primary preference is not applied to unrelated pages or hostname lookalikes", () => {
  const unrelated = rankCandidates(candidates("https://example.com/video"), { now: 1_700_000_005_000 });
  assert.equal(new URL(unrelated.find((item) => item.main).resourceUrl).hostname, "z6v2p9a8.bkcdn.net");
  const spoofed = candidates();
  spoofed[1].resourceUrl = "https://googlevideo.com.evil.invalid/video.mp4";
  assert.equal(rankCandidates(spoofed, { now: 1_700_000_005_000 }).find((item) => item.main).resourceUrl, spoofed[0].resourceUrl);
});
