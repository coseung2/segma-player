import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const subtitlesView = fs.readFileSync(path.join(here, "routes", "SubtitlesView.svelte"), "utf8");
const playerView = fs.readFileSync(path.join(here, "routes", "PlayerView.svelte"), "utf8");
const appCss = fs.readFileSync(path.join(here, "..", "app.css"), "utf8");

test("subtitle surface refreshes once after a running job becomes terminal", () => {
  assert.match(subtitlesView, /subtitleJobWasActive = false/);
  assert.match(subtitlesView, /active \|\| subtitleJobWasActive/);
  assert.match(subtitlesView, /subtitleJobWasActive = active/);
  assert.match(subtitlesView, /setInterval\(\(\) => \{ void refreshSubtitleSurface\(\); \}, 5_000\)/);
});

test("player selection clears transient viewport modes and fullscreen preserves aspect", () => {
  assert.match(playerView, /miniPlayer = false/);
  assert.match(playerView, /else \{\s*miniPlayer = false;\s*await stageEl\.requestFullscreen\(\);/s);
  assert.match(playerView, /if \(document\.fullscreenElement\) void document\.exitFullscreen\(\)/);
  assert.match(appCss, /\.player-stage:fullscreen \{[^}]*aspect-ratio: auto;/s);
  assert.match(appCss, /\.player-view\.mini-mode \.player-stage:fullscreen \{[^}]*width: 100vw;[^}]*height: 100vh;/s);
  assert.match(appCss, /\.player-stage:fullscreen video \{[^}]*object-fit: contain;/s);
});
