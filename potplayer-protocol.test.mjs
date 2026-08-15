import test from "node:test";
import assert from "node:assert/strict";
import { buildAuraPlayerUri, playableMediaUrl } from "./potplayer-protocol.js";

test("PotPlayer protocol accepts http(s) media URLs", () => {
  assert.equal(playableMediaUrl("https://cdn.example.test/master.m3u8?token=a&b=c"), "https://cdn.example.test/master.m3u8?token=a&b=c");
  assert.equal(playableMediaUrl("javascript:alert(1)"), null);
  assert.equal(playableMediaUrl("file:///C:/video.mp4"), null);
});

test("PotPlayer protocol preserves the media URL and title", () => {
  const uri = buildAuraPlayerUri("https://cdn.example.test/master.m3u8?token=a&b=c", "ABC-123 sample");
  const parsed = new URL(uri);
  assert.equal(parsed.protocol, "aura-player:");
  assert.equal(parsed.host, "play");
  assert.equal(parsed.searchParams.get("url"), "https://cdn.example.test/master.m3u8?token=a&b=c");
  assert.equal(parsed.searchParams.get("title"), "ABC-123 sample");
});

test("PotPlayer protocol rejects non-network URLs", () => {
  assert.throws(() => buildAuraPlayerUri("blob:https://example.test/123"), /http\(s\)/);
});
