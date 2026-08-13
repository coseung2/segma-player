import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));
const packager = path.join(repositoryRoot, "scripts", "build-store-package.ps1");
const powershell = process.env.PWSH || "powershell.exe";
const expectedFiles = [
  "aes-cbc.js",
  "background.js",
  "candidate.js",
  "content.js",
  "download-errors.js",
  "download-job-view.js",
  "download-jobs.js",
  "download-scheduler.js",
  "download-worker.html",
  "download-worker.js",
  "download.js",
  "edition.js",
  "hls-download.js",
  "hls.js",
  "level5-key-error.js",
  "level5-page-bridge.js",
  "license.js",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
  "manifest.json",
  "media-fetch-lease.js",
  "native-file-writer.js",
  "options.html",
  "options.js",
  "parallel-download.js",
  "player-page-resolver.js",
  "popup.css",
  "popup.html",
  "popup.js",
  "product-plan.js",
  "progressive-redirect.js",
  "youtube-server.js",
].sort();

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

test("store packager builds and audits the exact free-edition ZIP", async () => {
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
    assert.equal(manifest.name, "Aura Media Downloader");
    assert.equal("key" in manifest, false);
    assert.equal("declarative_net_request" in manifest, false);
    assert.equal(manifest.icons["128"], "icons/icon128.png");
    assert.equal(manifest.action.default_icon["32"], "icons/icon32.png");
    assert.deepEqual(manifest.permissions, [
      "activeTab",
      "contextMenus",
      "declarativeNetRequest",
      "downloads",
      "nativeMessaging",
      "offscreen",
      "scripting",
      "storage",
      "webRequest",
    ]);
    assert.deepEqual(manifest.content_scripts, [{
      matches: ["http://*/*", "https://*/*"],
      js: ["level5-page-bridge.js"],
      run_at: "document_start",
      all_frames: true,
      world: "MAIN",
    }, {
      matches: ["http://*/*", "https://*/*"],
      js: ["content.js"],
      run_at: "document_idle",
      all_frames: true,
    }]);

    const edition = await import(`${pathToFileURL(path.join(extracted, "edition.js"))}?test=${Date.now()}`);
    const plan = await import(`${pathToFileURL(path.join(extracted, "product-plan.js"))}?test=${Date.now()}`);
    assert.equal(edition.PRODUCT_EDITION, "free");
    assert.equal(edition.UPGRADE_URL, "");
    assert.deepEqual(plan.productPlan("free"), {
      id: "free",
      label: "일반",
      maxConcurrentMediaJobs: 1,
      maxDownloadBytes: 1 * plan.GIBIBYTE,
      youtubeEnabled: true,
      youtubeMaxHeight: 1080,
      backgroundDownloads: false,
      downloadSpeedLimitBytesPerSecond: 4 * 1024 * 1024,
    });
    assert.deepEqual(plan.productPlan("pro"), {
      id: "pro",
      label: "Pro",
      maxConcurrentMediaJobs: 3,
      maxDownloadBytes: null,
      youtubeEnabled: true,
      youtubeMaxHeight: null,
      backgroundDownloads: true,
      downloadSpeedLimitBytesPerSecond: null,
    });

    const textFiles = await Promise.all(expectedFiles.filter((file) => /\.(?:js|html|css|json)$/i.test(file)).map(async (file) => [
      file,
      await readFile(path.join(extracted, file), "utf8"),
    ]));
    const forbidden = /personalvpn|personal-vpn|com\.personal|hfpkpbadllkhedocoglbggkpnbaibmcp|wherewindsmeet|redirect-block-rules|route-client|MEDIA_ROUTE_NATIVE_HOST/i;
    for (const [file, text] of textFiles) assert.doesNotMatch(text, forbidden, file);
    assert.match(textFiles.find(([file]) => file === "background.js")[1], /com\.aura\.media_companion/);
    assert.match(textFiles.find(([file]) => file === "download-worker.js")[1], /productPlan\(PRODUCT_EDITION\)/);
    assert.doesNotMatch(textFiles.find(([file]) => file === "download-worker.js")[1], /chrome\.tabs|chrome\.windows/);
    assert.match(textFiles.find(([file]) => file === "background.js")[1], /chrome\.tabs\.onActivated/);
    assert.match(textFiles.find(([file]) => file === "hls-download.js")[1], /assertDownloadWithinPlan/);
    assert.match(textFiles.find(([file]) => file === "hls-download.js")[1], /tryBrowserDownloadFallback/);
    const bridge = textFiles.find(([file]) => file === "level5-page-bridge.js")[1];
    assert.match(bridge, /cachedKey\(hls, url\.href\)/);
    assert.match(bridge, /loadKey\(hls, url\.href\)/);
    assert.doesNotMatch(bridge, /\bimport\s*\(/);
    assert.doesNotMatch(bridge, /\bWebAssembly\b|\bwasm\b|\/assets\//i);
    assert.doesNotMatch(bridge, /inlineAssetUrl|level5Decoder|decodeRuntimeKey|document\.scripts/);
    const content = textFiles.find(([file]) => file === "content.js")[1];
    assert.match(content, /function reportDoodPlayer/);
    assert.match(content, /requestLevel5Key/);
    const hls = textFiles.find(([file]) => file === "hls-download.js")[1];
    assert.match(hls, /requestPageDecodedKey/);
    assert.match(hls, /type:\s*["']decode-hls-key["']/);
    assert.match(textFiles.find(([file]) => file === "level5-key-error.js")[1], /export function normalizeLevel5KeyError/);

    for (const file of expectedFiles.filter((value) => value.endsWith(".js"))) {
      const syntax = spawnSync(process.execPath, ["--check", path.join(extracted, file)], { encoding: "utf8" });
      assert.equal(syntax.status, 0, `${file}\n${syntax.stdout || ""}\n${syntax.stderr || ""}`);
    }
    const hlsModuleUrl = pathToFileURL(path.join(extracted, "hls-download.js")).href;
    const linkProbe = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `globalThis.document={querySelector(){return null}}; await import(${JSON.stringify(hlsModuleUrl)});`,
    ], { encoding: "utf8" });
    assert.equal(linkProbe.status, 0, `staged module graph failed to link\n${linkProbe.stdout || ""}\n${linkProbe.stderr || ""}`);

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

test("store packager builds and audits the Pro test ZIP", async () => {
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

    const manifest = JSON.parse(await readFile(path.join(extracted, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.name, "Aura Media Downloader");
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
