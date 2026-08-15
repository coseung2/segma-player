import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAuraPlayerUri,
  buildAuraProbeUri,
  companionInstallerUrl,
  companionProbeStatusUrl,
  playableMediaUrl,
} from "./potplayer-protocol.js";

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

test("PotPlayer protocol attaches an optional probe token", () => {
  const token = "a".repeat(32);
  const uri = buildAuraPlayerUri("https://cdn.example.test/v.mp4", "ABC-123 sample", { probe: token });
  const parsed = new URL(uri);
  assert.equal(parsed.host, "play");
  assert.equal(parsed.searchParams.get("probe"), token);
  assert.equal(parsed.searchParams.get("url"), "https://cdn.example.test/v.mp4");
});

test("PotPlayer probe URI uses the probe host and hex token only", () => {
  const token = "b".repeat(40);
  const uri = new URL(buildAuraProbeUri(token));
  assert.equal(uri.host, "probe");
  assert.equal(uri.searchParams.get("token"), token);
  assert.throws(() => buildAuraProbeUri("short"), /hex token/);
  assert.throws(() => buildAuraProbeUri("g".repeat(32)), /hex token/);
});

test("PotPlayer companion URLs point at the site endpoints", () => {
  assert.equal(companionInstallerUrl(), "https://aura.mdownloader.workers.dev/downloads/AuraPotPlayerSetup.exe");
  assert.equal(
    companionProbeStatusUrl("c".repeat(32)),
    "https://aura.mdownloader.workers.dev/api/potplayer-probe/status?token=" + "c".repeat(32),
  );
});
