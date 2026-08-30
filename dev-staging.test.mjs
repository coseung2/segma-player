import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDevStaging,
  DEV_STAGING_FILES,
  storeSafeLevel5Bridge,
} from "./scripts/build-dev-staging.mjs";

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

async function filesUnder(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await filesUnder(path.join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}

test("store bridge transform removes runtime discovery while retaining bundled key paths", async () => {
  const source = await readFile(path.join(repositoryRoot, "level5-page-bridge.js"), "utf8");
  const staged = storeSafeLevel5Bridge(source);
  assert.doesNotMatch(staged, /decoderPromise|inlineAssetUrl|level5Decoder|decodeRuntimeKey|document\.scripts/);
  assert.doesNotMatch(staged, /\bimport\s*\(|\bWebAssembly\b|\bwasm\b|\/assets\//i);
  assert.match(staged, /cachedKey\(hls, url\.href\)/);
  assert.match(staged, /loadKey\(hls, url\.href\)/);
});

test("cross-platform development staging builds an exact Pro directory without a ZIP", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "aura-dev-staging-"));
  context.after(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const stageDirectory = path.join(temporaryRoot, "staging-pro");
  const result = await buildDevStaging({
    repositoryRoot,
    outputDirectory: stageDirectory,
    edition: "pro",
    version: "9.8.7",
    companionInstallUrl: "https://aura.example/companion",
  });

  assert.equal(result.stageDirectory, stageDirectory);
  assert.equal(result.version, "9.8.7");
  assert.equal(result.edition, "pro");
  assert.equal(result.files, DEV_STAGING_FILES.length);
  assert.deepEqual(await filesUnder(stageDirectory), [...DEV_STAGING_FILES]);
  assert.equal((await readdir(temporaryRoot)).some((name) => name.endsWith(".zip")), false);

  const manifest = JSON.parse(await readFile(path.join(stageDirectory, "manifest.json"), "utf8"));
  assert.equal(manifest.version, "9.8.7");
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.equal(manifest.permissions.includes("bookmarks"), false);
  assert.equal("key" in manifest, false);
  assert.equal("declarative_net_request" in manifest, false);

  const edition = await readFile(path.join(stageDirectory, "edition.js"), "utf8");
  assert.match(edition, /PRODUCT_EDITION = "pro"/);
  assert.match(edition, /COMPANION_INSTALL_URL = "https:\/\/aura\.example\/companion"/);
  assert.match(await readFile(path.join(stageDirectory, "background.js"), "utf8"), /media-request-context\.js/);
  assert.match(await readFile(path.join(stageDirectory, "background.js"), "utf8"), /background-candidate-repository\.js/);
  assert.match(await readFile(path.join(stageDirectory, "content.js"), "utf8"), /__segmaContentExtractionV1/);
  assert.equal((await readFile(path.join(stageDirectory, "content-extraction.js"), "utf8")).length > 0, true);
  assert.deepEqual(manifest.content_scripts[1].js, ["content-extraction.js", "content.js"]);
  const stagedNames = new Set(await filesUnder(stageDirectory));
  for (const retired of [
    "playback-addon.js",
    "playback-session.js",
    "player.html",
    "player.js",
    "player-subtitle.js",
    "popup-play.html",
    "subtitle-folder.html",
    "subtitle-folder.js",
    "subtitle-generation.js",
    "subtitle-save.js",
  ]) {
    assert.equal(stagedNames.has(retired), false, `${retired} must stay out of staging`);
  }

  for (const file of [...stagedNames].filter((value) => value.endsWith(".js"))) {
    const source = await readFile(path.join(stageDirectory, file), "utf8");
    const imports = [...source.matchAll(/\bfrom\s+["'](\.\.?\/[^"']+)["']/g)]
      .map((match) => match[1]);
    for (const specifier of imports) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file.replaceAll("\\", "/")), specifier));
      assert.equal(stagedNames.has(target), true, `${file} imports missing staged module ${target}`);
    }
  }
});
