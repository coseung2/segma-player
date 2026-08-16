import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [addon, player, playerHtml, background, content, manifest] = await Promise.all([
  readFile(new URL("./playback-addon.js", import.meta.url), "utf8"),
  readFile(new URL("./player.js", import.meta.url), "utf8"),
  readFile(new URL("./player.html", import.meta.url), "utf8"),
  readFile(new URL("./background.js", import.meta.url), "utf8"),
  readFile(new URL("./content.js", import.meta.url), "utf8"),
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
  assert.match(player, /loader:\s*Loader/);
  assert.doesNotMatch(player, /pLoader:\s*Loader/);
  assert.match(player, /alternate:\s*true/);
  assert.match(background, /alternatePlaybackCandidateForTab/);
  assert.match(background, /const candidateTabId = Number\.isInteger\(sourceTabId\)/);
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

test("subtitle generation accepts the trusted player page without requiring a content-script tab sender", () => {
  assert.match(background, /function validPlayerPageSender\(sender\)\s*\{\s*return exactExtensionPageSender\(sender, "player\.html"\);/s);
  assert.match(background, /type === "start-subtitle-generation" && validPlayerPageSender\(sender\)/);
});

test("subtitle generation targets the source page download overlay instead of opening a browser window", () => {
  assert.match(player, /Number\.isInteger\(sourceTabId\) \? \{ sourceTabId \} : \{\}/);
  assert.match(background, /const sourceTabId = Number\.isInteger\(input\?\.sourceTabId\)/);
  assert.match(background, /jobSourceTabs\.set\(jobId, sourceTabId\)/);
  assert.match(background, /syncDownloadOverlayForActiveTab\(jobId\)/);
  assert.match(content, /showDownloadOverlay\(message\.jobIds\)/);
  assert.doesNotMatch(background, /chrome\.windows\.create\(\{/);
});

test("subtitle generation passes the background-validated Pro key to the offscreen worker", () => {
  assert.match(background, /await refreshLicense\(\);[\s\S]*const license = await getStoredLicense\(\);/);
  assert.match(background, /type:\s*"run-subtitle-job",[\s\S]*licenseKey:\s*license\.key/);
  assert.match(player, /type:\s*"start-subtitle-generation"/);
});

test("the player keeps the media visible and controls reachable at every window size", () => {
  assert.match(playerHtml, /body\s*\{[\s\S]*?overflow:\s*hidden;/);
  assert.match(playerHtml, /grid-template-rows:\s*auto minmax\(0, 1fr\);/);
  assert.match(playerHtml, /\.stage\s*\{[\s\S]*?min-height:\s*0;/);
  assert.match(playerHtml, /video\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;[\s\S]*?object-fit:\s*contain;/);
});
