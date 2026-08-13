import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalHttpUrl,
  isDownloadableMediaType,
  MEDIA_TYPES,
  makeCandidate,
  mediaTypeForResource,
  sanitizePageMessage,
} from "./candidate.js";
import { downloadableMediaUrl, filenameForDownload } from "./download.js";

test("classifies real media path extensions", () => {
  assert.equal(
    mediaTypeForResource("https://media.example/video.h264.mp4?token=secret"),
    MEDIA_TYPES.PROGRESSIVE,
  );
  assert.equal(
    mediaTypeForResource("https://media.example/master.m3u8?token=secret"),
    MEDIA_TYPES.HLS_MEDIA,
  );
});

test("canonical media URLs reject IPv6 forms that embed private IPv4", () => {
  for (const value of [
    "https://[64:ff9b::a00:1]/video.mp4",
    "https://[64:ff9b::7f00:1]/video.mp4",
    "https://[2002:a00:1::]/video.mp4",
    "https://[::a00:1]/video.mp4",
    "https://[fec0::1]/video.mp4",
  ]) assert.equal(canonicalHttpUrl(value), null, value);
  assert.equal(canonicalHttpUrl("https://[64:ff9b::808:808]/video.mp4")?.hostname,
    "[64:ff9b::808:808]");
});

test("classifies tokenized playlists by response content type", () => {
  assert.equal(
    mediaTypeForResource("https://media.example/api/stream?id=123&token=secret", "application/vnd.apple.mpegurl"),
    MEDIA_TYPES.HLS_MEDIA,
  );
  assert.equal(
    mediaTypeForResource("https://media.example/api/stream?id=123&token=secret", "application/dash+xml"),
    MEDIA_TYPES.DASH,
  );
});

test("classifies audio and video response types as progressive media", () => {
  assert.equal(
    mediaTypeForResource("https://media.example/stream?id=1", "audio/mp4"),
    MEDIA_TYPES.PROGRESSIVE,
  );
  assert.equal(
    mediaTypeForResource("https://media.example/stream?id=1", "video/mp4"),
    MEDIA_TYPES.PROGRESSIVE,
  );
});

test("does not classify thumbnails containing .mp4 in the middle", () => {
  assert.equal(
    mediaTypeForResource("https://image.example/video.mp4.thumb.webp?expires=1"),
    MEDIA_TYPES.UNKNOWN,
  );
});

test("recognizes a Streamtape .mp4 player page before extension classification", () => {
  const playerUrl = "https://streamtape.com/v/goD2mWXvD3CqlJ8/0703_%281%29.mp4";
  assert.equal(mediaTypeForResource(playerUrl, "text/html"), MEDIA_TYPES.UNKNOWN);
  assert.equal(
    makeCandidate({
      pageTitle: "Streamtape",
      pageUrl: playerUrl,
      resourceUrl: playerUrl,
      contentType: "text/html",
      fromMediaElement: true,
    }),
    null,
  );
});

test("creates a direct Windows download URL for progressive media", () => {
  const resourceUrl = "https://media.example/video.mp4?token=secret";
  assert.equal(downloadableMediaUrl(resourceUrl), resourceUrl);
  assert.equal(filenameForDownload(resourceUrl), "video.mp4");
});

test("accepts extensionless media-element sources as progressive media", () => {
  const resourceUrl = "https://srv123.doodcdn.io/getfile/abc123?token=secret&expiry=1";
  const candidate = makeCandidate({
    pageTitle: "Video",
    pageUrl: "https://player.example/e/xyz",
    resourceUrl,
    contentType: "application/octet-stream",
    fromMediaElement: true,
  });
  assert.equal(candidate?.mediaType, MEDIA_TYPES.PROGRESSIVE);
  assert.equal(
    makeCandidate({
      pageTitle: "Video",
      pageUrl: "https://player.example/e/xyz",
      resourceUrl,
      contentType: "application/octet-stream",
    }),
    null,
  );
});

test("sanitizes extensionless media-element messages as progressive media", () => {
  const candidate = sanitizePageMessage({
    type: "resource",
    pageTitle: "Video",
    pageUrl: "https://player.example/e/xyz",
    resourceUrl: "https://srv123.doodcdn.io/getfile/abc123?token=secret&expiry=1",
    contentType: "application/octet-stream",
    fromMediaElement: true,
  });
  assert.equal(candidate?.mediaType, MEDIA_TYPES.PROGRESSIVE);
  assert.equal(candidate?.resourceUrl, "https://srv123.doodcdn.io/getfile/abc123?token=secret&expiry=1");
});

test("keeps blob media-element sources as UNKNOWN instead of a broken button", () => {
  const candidate = makeCandidate({
    pageTitle: "Video",
    pageUrl: "https://player.example/e/xyz",
    resourceUrl: "blob:https://player.example/7a7a0f4b-1234",
    contentType: "",
    fromMediaElement: true,
  });
  assert.equal(candidate?.mediaType, MEDIA_TYPES.UNKNOWN);
});

test("does not promote misleading preview GIF sources to downloadable video", () => {
  const candidate = makeCandidate({
    pageTitle: "Related preview",
    pageUrl: "https://page.example/watch",
    resourceUrl: "https://cdn.example/cast/preview.gif",
    contentType: "video/mp4",
    fromMediaElement: true,
  });
  assert.equal(candidate, null);
});

test("keeps the detecting iframe id on internal download candidates", () => {
  const candidate = makeCandidate({
    pageTitle: "Main player",
    pageUrl: "https://player.example/embed",
    resourceUrl: "https://cdn.example/playlist.m3u8",
    contentType: "application/vnd.apple.mpegurl",
    tabId: 7,
    frameId: 12,
  });
  assert.equal(candidate?.tabId, 7);
  assert.equal(candidate?.frameId, 12);
});

test("does not send playlists to the direct download path", () => {
  assert.equal(downloadableMediaUrl("https://media.example/master.m3u8"), null);
});

test("only progressive and HLS candidates are exposed as directly downloadable", () => {
  assert.equal(isDownloadableMediaType(MEDIA_TYPES.PROGRESSIVE), true);
  assert.equal(isDownloadableMediaType(MEDIA_TYPES.HLS_MEDIA), true);
  assert.equal(isDownloadableMediaType(MEDIA_TYPES.UNKNOWN), false);
  assert.equal(isDownloadableMediaType(MEDIA_TYPES.DASH), false);
});
