import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [addon, player, background, manifest] = await Promise.all([
  readFile(new URL("./playback-addon.js", import.meta.url), "utf8"),
  readFile(new URL("./player.js", import.meta.url), "utf8"),
  readFile(new URL("./background.js", import.meta.url), "utf8"),
  readFile(new URL("./manifest.json", import.meta.url), "utf8").then(JSON.parse),
]);

test("browser playback launches with an opaque session id instead of a token URL", () => {
  assert.match(addon, /type:\s*"create-playback-session"/);
  assert.match(addon, /new URLSearchParams\(\{\s*session:\s*playbackSession\.sessionId\s*\}\)/s);
  assert.match(addon, /if \(subtitleSessionId && subtitleLoaded\) params\.set\("sub", subtitleSessionId\)/);
  assert.doesNotMatch(addon, /new URLSearchParams\(\{\s*url:\s*mediaUrl/);
  assert.match(background, /playerOwnsPlaybackSession/);
  assert.match(background, /PLAYBACK_SESSIONS_KEY/);
});

test("HLS playback prepares an exact media context before each loader request", () => {
  assert.match(player, /createContextualHlsLoader/);
  assert.match(player, /type:\s*"prepare-media-fetch"/);
  assert.match(player, /sourceContext:\s*\{[\s\S]*tabId:[\s\S]*frameId:[\s\S]*initiator:/);
  assert.match(player, /xhr\.withCredentials\s*=\s*true/);
  assert.match(player, /type:\s*"release-media-fetch"/);
});

test("the manifest declares the minimum Chrome version required by MAIN-world scripts", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "111");
  assert.equal(manifest.content_scripts.some((script) => script.world === "MAIN"), true);
});
