import assert from "node:assert/strict";
import test from "node:test";

import { makeCandidate } from "../candidate.js";
import {
  SITE_PROFILES,
  isPlayerFrameUrl,
  siteProfileForUrls,
  titleSelectorsForPage,
} from "./registry.js";

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

test("Jamak keeps player-page resolution local while downloading the resolved media progressively", () => {
  const profile = siteProfileForUrls(
    "https://www.jamak.cc/bbs/board.php?bo_table=gallery&wr_id=83&page=5",
    "https://streamtape.com/e/2PXX3pz824FZg6X",
  );
  assert.equal(profile.id, "jamak");
  assert.equal(profile.primaryMode, "PLAYER_PAGE_GRAPH");
  assert.equal(profile.modules.primaryDownloader, "progressive");
});

test("Recu keeps mediafront archive streams on the shared HLS downloader", () => {
  const profile = siteProfileForUrls(
    "https://recu.me/ellinrose/video/195409102/play",
    "https://f62.mediafront.net/hl/ellinrose/archive/media.m3u8",
  );
  assert.equal(profile.id, "recu");
  assert.equal(profile.primaryMode, "HLS_MANIFEST");
  assert.equal(profile.modules.primaryDownloader, "hls");
  assert.deepEqual(profile.modules.fallbackDownloaders, ["progressive"]);
});

test("Gogoanime keeps the episode title and Megaplay player frame in the site profile", () => {
  const pageUrl = "https://gogoanime.by/bleach-sennen-kessen-hen-kashin-tan-episode-4-english-subbed/";
  const profile = siteProfileForUrls(pageUrl);
  assert.equal(profile.id, "gogoanime");
  assert.equal(profile.primaryMode, "HLS_MANIFEST");
  assert.equal(profile.modules.primaryDownloader, "hls");
  assert.deepEqual(titleSelectorsForPage(pageUrl), ["article h1", "h1"]);
  assert.equal(isPlayerFrameUrl("https://gogoanime.by/player/?source=embed&url=encoded"), true);
  assert.equal(isPlayerFrameUrl("https://megaplay.su/embed.php?sid=encoded"), false);
});

test("AnimePahe keeps both documented domains on the progressive Blogger-video path", () => {
  for (const host of ["animepahe.ng", "animepahe.ch"]) {
    const pageUrl = `https://${host}/sample-episode/`;
    const profile = siteProfileForUrls(pageUrl);
    assert.equal(profile.id, "animepahe");
    assert.equal(profile.primaryMode, "DIRECT_PROGRESSIVE");
    assert.equal(profile.modules.primaryDownloader, "progressive");
    assert.deepEqual(titleSelectorsForPage(pageUrl), ["article h1", "h1"]);
  }
});

test("Zoro, AniWatch, and HiAnime bookmarks share one stable site policy", () => {
  for (const url of [
    "https://zoro.to/watch/sample?ep=1",
    "https://aniwatch.to/watch/sample?ep=1",
    "https://hianime.to/watch/sample?ep=1",
    "https://hianime.me/watch/sample?ep=1",
  ]) {
    const profile = siteProfileForUrls(url);
    assert.equal(profile.id, "zoro");
    assert.equal(profile.primaryMode, "PLAYER_API");
    assert.deepEqual(profile.modules.providers, ["player-api", "hlsjs", "generic"]);
  }
});

test("site registry ids and host ownership are unique", () => {
  const ids = SITE_PROFILES.map((profile) => profile.id);
  const hosts = SITE_PROFILES.flatMap((profile) => profile.hosts);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(hosts).size, hosts.length);
});
