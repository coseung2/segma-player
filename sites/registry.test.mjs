import assert from "node:assert/strict";
import test from "node:test";

import { makeCandidate } from "../candidate.js";
import { SITE_PROFILES, siteProfileForUrls } from "./registry.js";

test("site profiles keep module selection local to one site file", () => {
  const missav = siteProfileForUrls("https://missav123.com/ko/example");
  assert.equal(missav.id, "missav");
  assert.equal(missav.modules.primaryDownloader, "hls");
  assert.deepEqual(missav.modules.providers, ["hlsjs", "player-api"]);
  assert.deepEqual(missav.fallbackModes, ["PLAYER_API", "AUTHENTICATED_SOURCE_FRAME"]);
});

test("top-level site identity survives an external player frame and CDN URL", () => {
  const candidate = makeCandidate({
    pageTitle: "MissAV",
    siteUrl: "https://missav123.com/ko/example",
    pageUrl: "https://player.example/embed/1",
    resourceUrl: "https://surrit.com/hls/example/master.m3u8?token=secret",
    contentType: "application/vnd.apple.mpegurl",
    player: "hls.js",
    detectionSource: "player-adapter",
    tabId: 1,
    frameId: 7,
  });
  assert.equal(candidate.siteId, "missav");
  assert.equal(candidate.downloaderId, "hls");
  assert.equal(candidate.providerId, "hlsjs");
});

test("Shackledshow keeps MxDrop iframe media on the progressive downloader", () => {
  const profile = siteProfileForUrls(
    "https://shackledshow.cc/videos/1692b65a-48d5-4a6e-a477-9ed151f65568",
    "https://miixdrop.top/e/q1dz00v7aemvpl",
  );
  assert.equal(profile.id, "shackledshow");
  assert.equal(profile.modules.primaryDownloader, "progressive");
  assert.deepEqual(profile.modules.fallbackDownloaders, ["hls"]);
});

test("site registry ids and host ownership are unique", () => {
  const ids = SITE_PROFILES.map((profile) => profile.id);
  const hosts = SITE_PROFILES.flatMap((profile) => profile.hosts);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(hosts).size, hosts.length);
});
