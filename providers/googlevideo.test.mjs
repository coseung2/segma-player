import test from "node:test";
import assert from "node:assert/strict";
import { makeCandidate, upsertCandidate } from "../candidate.js";
import { isGoogleVideoAdaptiveResource } from "./googlevideo.js";

const candidate = (query, contentType = "video/mp4") => makeCandidate({
  pageUrl: "https://gogoanime.by/player/?source=blogger", siteUrl: "https://gogoanime.by/episode/", tabId: 1, frameId: 2,
  resourceUrl: `https://rr3.googlevideo.com/videoplayback?${query}`, contentType, fromMediaElement: true,
});

test("Blogger progressive media cannot be replaced by a later SABR/UMP session", () => {
  const store = new Map();
  const mp4 = candidate("id=episode&itag=18&sig=original");
  upsertCandidate(store, mp4);
  for (const [query, mime] of [["id=episode&sabr=1&sig=adaptive", "video/mp4"], ["id=episode&ump=1", "application/octet-stream"], ["id=episode", "application/vnd.yt-ump"]]) {
    assert.equal(candidate(query, mime), null);
  }
  assert.equal(store.size, 1);
  assert.equal([...store.values()][0].resourceUrl, mp4.resourceUrl);
  assert.equal(mp4.providerId, "googlevideo");
});

test("Blogger formats and video ids remain distinct while renewed signatures update the same format", () => {
  const store = new Map();
  upsertCandidate(store, candidate("id=episode&itag=18&sig=old"));
  upsertCandidate(store, candidate("id=episode&itag=22&sig=hd"));
  upsertCandidate(store, candidate("id=another&itag=18&sig=second"));
  upsertCandidate(store, candidate("id=episode&itag=18&sig=renewed"));
  assert.equal(store.size, 3);
  assert.ok([...store.values()].some(c => c.resourceUrl.endsWith("sig=renewed")));
  assert.ok(![...store.values()].some(c => c.resourceUrl.endsWith("sig=old")));
});

test("Google streaming classification does not match unrelated hosts with similar parameters", () => {
  assert.equal(isGoogleVideoAdaptiveResource("https://googlevideo.com.evil.invalid/videoplayback?sabr=1"), false);
  assert.equal(isGoogleVideoAdaptiveResource("https://cdn.example.com/video.mp4?ump=1"), false);
});
