import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { STORE_RUNTIME_FILES } from "./scripts/build-dev-staging.mjs";

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));
const packager = path.join(repositoryRoot, "scripts", "build-store-package.ps1");
const powershell = process.env.PWSH || "powershell.exe";
const powershellAvailable = spawnSync(
  powershell,
  ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
  { encoding: "utf8" },
).status === 0;
const retiredExpectedFiles = [
  "aes-cbc.js",
  "background.js",
  "browser-download-monitor.js",
  "companion-client.js",
  "candidate.js",
  "candidate-ranking.js",
  "content.js",
  "dash.js",
  "download-checkpoint.js",
  "download-errors.js",
  "download-job-view.js",
  "download-jobs.js",
  "download-mode.js",
  "download-policy.js",
  "downloaders/dash.js",
  "downloaders/hls.js",
  "downloaders/ids.js",
  "downloaders/progressive.js",
  "downloaders/registry.js",
  "download-scheduler.js",
  "download-worker.html",
  "download-worker.js",
  "download.js",
  "edition.js",
  "filename-template.js",
  "hls-download.js",
  "hls.js",
  "i18n.js",
  "level5-key-error.js",
  "level5-page-bridge.js",
  "license.js",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
  "manifest.json",
  "media-fetch-lease.js",
  "media-request-context.js",
  "mobile-user-agent.js",
  "native-file-writer.js",
  "options.html",
  "options.js",
  "parallel-download.js",
  "page-media-observer.js",
  "player-page-resolver.js",
  "popup.css",
  "popup.html",
  "popup.js",
  "product-plan.js",
  "qr-code.js",
  "progressive-redirect.js",
  "request-header-store.js",
  "save-directory.js",
  "providers/dood.js",
  "providers/hlsjs.js",
  "providers/ids.js",
  "providers/level5.js",
  "providers/player-api.js",
  "providers/registry.js",
  "providers/signals.js",
  "sites/asianporn/profile.js",
  "sites/av19/profile.js",
  "sites/avsee/profile.js",
  "sites/beeg/profile.js",
  "sites/dood/profile.js",
  "sites/missav/profile.js",
  "sites/onlyjerk/profile.js",
    "sites/playmogo/profile.js",
    "sites/recu/profile.js",
    "sites/jamak/profile.js",
  "sites/shackledshow/profile.js",
  "sites/profile.js",
  "sites/registry.js",
  "sites/youtube/profile.js",
  "worker-lifecycle.js",
  "youtube-server.js",
].sort();
const expectedFiles = [...STORE_RUNTIME_FILES];

function runPackager(outputDirectory, upgradeUrl = null, edition = null) {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    packager,
    "-OutputDirectory",
    outputDirectory,
  ];
  if (upgradeUrl !== null) args.push("-UpgradeUrl", upgradeUrl);
  if (edition !== null) args.push("-Edition", edition);
  const result = spawnSync(powershell, args, { encoding: "utf8" });
  return {
    ...result,
    output: `${result.stdout || ""}\n${result.stderr || ""}`,
  };
}

async function filesUnder(directory) {
  const output = [];
  async function visit(current, prefix = "") {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) await visit(path.join(current, entry.name), relative);
      else output.push(relative.replaceAll(path.sep, "/"));
    }
  }
  await visit(directory);
  return output.sort();
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function expandArchive(zipPath, destination) {
  const command = `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destination)} -Force`;
  const result = spawnSync(powershell, ["-NoProfile", "-Command", command], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout || ""}\n${result.stderr || ""}`);
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

test("store packager builds and audits the exact free-edition ZIP", async (context) => {
  if (!powershellAvailable) {
    context.skip("PowerShell is not installed in this environment");
    return;
  }
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "aura-store-package-"));
  try {
    const first = runPackager(temporaryRoot);
    assert.equal(first.status, 0, first.output);
    assert.match(first.output, /STORE_PACKAGE_OK/);
    assert.match(first.output, /WARNING=Upgrade URL is empty/);
    const zipPath = first.output.match(/^ZIP=(.+)$/m)?.[1]?.trim();
    assert.ok(zipPath, first.output);

    const extracted = path.join(temporaryRoot, "extracted");
    expandArchive(zipPath, extracted);
    assert.deepEqual(await filesUnder(extracted), expectedFiles);

    const manifest = JSON.parse(await readFile(path.join(extracted, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.minimum_chrome_version, "111");
    assert.equal(manifest.name, "Segma Player");
    assert.equal(manifest.action.default_popup, "popup.html");
    assert.equal("key" in manifest, false);
    assert.equal("declarative_net_request" in manifest, false);
    assert.equal(manifest.icons["128"], "icons/icon128.png");
    assert.equal(manifest.action.default_icon["32"], "icons/icon32.png");
    assert.deepEqual(manifest.permissions, [
      "activeTab",
      "contextMenus",
      "declarativeNetRequest",
      "nativeMessaging",
      "scripting",
      "storage",
      "webRequest",
    ]);
    assert.deepEqual(manifest.content_scripts, [{
      matches: ["http://*/*", "https://*/*"],
      js: ["page-media-observer.js", "level5-page-bridge.js"],
      run_at: "document_start",
      all_frames: true,
      world: "MAIN",
    }, {
      matches: ["http://*/*", "https://*/*"],
      js: ["content.js"],
      run_at: "document_start",
      all_frames: true,
    }]);

    const edition = await import(`${pathToFileURL(path.join(extracted, "edition.js"))}?test=${Date.now()}`);
    assert.equal(edition.PRODUCT_EDITION, "free");
    assert.equal(edition.UPGRADE_URL, "");
    assert.equal(edition.COMPANION_INSTALL_URL, "https://aura.mdownloader.workers.dev/download");

    const textFiles = await Promise.all(expectedFiles.filter((file) => /\.(?:js|html|css|json)$/i.test(file)).map(async (file) => [
      file,
      await readFile(path.join(extracted, file), "utf8"),
    ]));
    const forbidden = /personalvpn|personal-vpn|com\.personal|hfpkpbadllkhedocoglbggkpnbaibmcp|wherewindsmeet|redirect-block-rules|route-client|MEDIA_ROUTE_NATIVE_HOST/i;
    for (const [file, text] of textFiles) assert.doesNotMatch(text, forbidden, file);
    const packagedManifest = JSON.parse(textFiles.find(([file]) => file === "manifest.json")[1]);
    assert.ok(packagedManifest.permissions.includes("nativeMessaging"));
    assert.equal(packagedManifest.permissions.includes("downloads"), false);
    assert.equal(packagedManifest.permissions.includes("offscreen"), false);
    assert.doesNotMatch(textFiles.find(([file]) => file === "background.js")[1], /download-worker|native-file-writer|chrome\.downloads/);
    assert.match(textFiles.find(([file]) => file === "companion-client.js")[1], /com\.aura\.media_companion/);
    assert.match(textFiles.find(([file]) => file === "background.js")[1], /startCompanionMediaDownload/);
    const bridge = textFiles.find(([file]) => file === "level5-page-bridge.js")[1];
    assert.match(bridge, /cachedKey\(hls, url\.href\)/);
    assert.match(bridge, /loadKey\(hls, url\.href\)/);
    assert.match(bridge, /keyLoadPolicy\?\.default/);
    assert.match(bridge, /loadPolicy:\s*\{\s*maxTimeToFirstByteMs,\s*maxLoadTimeMs\s*\}/);
    assert.match(bridge, /observedHlsSessions/);
    assert.match(bridge, /observeLevel5Player\(\)/);
    assert.doesNotMatch(bridge, /\bimport\s*\(/);
    assert.doesNotMatch(bridge, /\bWebAssembly\b|\bwasm\b|\/assets\//i);
    assert.doesNotMatch(bridge, /inlineAssetUrl|level5Decoder|decodeRuntimeKey|document\.scripts/);
    const content = textFiles.find(([file]) => file === "content.js")[1];
    assert.match(content, /function reportDoodPlayer/);
    assert.match(content, /requestLevel5Key/);
    assert.match(textFiles.find(([file]) => file === "level5-key-error.js")[1], /export function normalizeLevel5KeyError/);

    for (const file of expectedFiles.filter((value) => value.endsWith(".js"))) {
      const syntax = spawnSync(process.execPath, ["--check", path.join(extracted, file)], { encoding: "utf8" });
      assert.equal(syntax.status, 0, `${file}\n${syntax.stdout || ""}\n${syntax.stderr || ""}`);
    }
    const firstHash = sha256(zipPath);
    const second = runPackager(temporaryRoot);
    assert.equal(second.status, 0, second.output);
    const secondZipPath = second.output.match(/^ZIP=(.+)$/m)?.[1]?.trim();
    assert.equal(secondZipPath, zipPath);
    assert.equal(sha256(secondZipPath), firstHash, "same inputs must produce the same ZIP bytes");

    const forbiddenBuild = runPackager(path.join(temporaryRoot, "forbidden"), "https://personalvpn.invalid/upgrade");
    assert.notEqual(forbiddenBuild.status, 0, "forbidden identifiers must fail the package audit");
    assert.match(forbiddenBuild.output, /Forbidden store identifier/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("store packager builds and audits the Pro test ZIP", async (context) => {
  if (!powershellAvailable) {
    context.skip("PowerShell is not installed in this environment");
    return;
  }
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "aura-store-pro-"));
  try {
    const first = runPackager(temporaryRoot, null, "pro");
    assert.equal(first.status, 0, first.output);
    assert.match(first.output, /STORE_PACKAGE_OK/);
    assert.match(first.output, /EDITION=pro/);
    const zipPath = first.output.match(/^ZIP=(.+)$/m)?.[1]?.trim();
    assert.ok(zipPath, first.output);
    assert.match(zipPath, /aura-media-downloader-pro-\d+\.\d+\.\d+(?:\.\d+)?\.zip$/);

    const extracted = path.join(temporaryRoot, "extracted");
    expandArchive(zipPath, extracted);
    assert.deepEqual(await filesUnder(extracted), expectedFiles);

    const edition = await import(`${pathToFileURL(path.join(extracted, "edition.js"))}?test=${Date.now()}`);
    assert.equal(edition.PRODUCT_EDITION, "pro");
    assert.equal(edition.UPGRADE_URL, "");
    assert.equal(edition.COMPANION_INSTALL_URL, "https://aura.mdownloader.workers.dev/download");

    const manifest = JSON.parse(await readFile(path.join(extracted, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.minimum_chrome_version, "111");
    assert.equal(manifest.name, "Segma Player");
    assert.equal(manifest.action.default_popup, "popup.html");
    assert.equal("key" in manifest, false);
    assert.equal("declarative_net_request" in manifest, false);

    const textFiles = await Promise.all(expectedFiles.filter((file) => /\.(?:js|html|css|json)$/i.test(file)).map(async (file) => [
      file,
      await readFile(path.join(extracted, file), "utf8"),
    ]));
    const forbidden = /personalvpn|personal-vpn|com\.personal|hfpkpbadllkhedocoglbggkpnbaibmcp|wherewindsmeet|redirect-block-rules|route-client|MEDIA_ROUTE_NATIVE_HOST/i;
    for (const [file, text] of textFiles) assert.doesNotMatch(text, forbidden, file);

    const firstHash = sha256(zipPath);
    const second = runPackager(temporaryRoot, null, "pro");
    assert.equal(second.status, 0, second.output);
    const secondZipPath = second.output.match(/^ZIP=(.+)$/m)?.[1]?.trim();
    assert.equal(secondZipPath, zipPath);
    assert.equal(sha256(secondZipPath), firstHash, "same Pro inputs must produce the same ZIP bytes");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
