import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readStoreRuntimeFiles } from "./scripts/runtime-graph.mjs";
import { categorizedNodeTests, COMPATIBILITY_DIRECTORY } from "./scripts/node-suite-config.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEXT_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".md", ".mjs", ".ps1", ".rs", ".toml"]);
const SKIP_DIRECTORIES = new Set([".codegraph", ".git", "_metadata", "artifacts", "dist", "node_modules", "target"]);

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) files.push(...await sourceFiles(path.join(directory, entry.name)));
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

test("source tree omits the retired portable-package brand name", async () => {
  const retiredName = new RegExp(["de", "no"].join(""), "i");
  for (const file of await sourceFiles(ROOT)) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, retiredName, path.relative(ROOT, file));
  }
});

test("runtime omits the retired replay-capture feature", async () => {
  const runtimeFiles = [
    "background.js",
    "content.js",
    `${COMPATIBILITY_DIRECTORY}/download-jobs.js`,
    `${COMPATIBILITY_DIRECTORY}/download-worker.js`,
    "page-media-observer.js",
    "popup.css",
    "popup.js",
  ];
  const retiredCapture = /mse-capture|MSE_CAPTURE|captureAvailable|job-capture-button|재생 캡처/;
  for (const relative of runtimeFiles) {
    const source = await readFile(path.join(ROOT, relative), "utf8");
    assert.doesNotMatch(source, retiredCapture, relative);
  }
  await assert.rejects(readFile(path.join(ROOT, "mse-capture-writer.js"), "utf8"));
});

test("Node tests have non-empty disjoint shipped and legacy categories", async () => {
  const suites = await categorizedNodeTests(ROOT);
  assert.ok(suites.shipped.length > 0);
  assert.ok(suites.legacy.length > 0);
  assert.deepEqual(suites.uncategorized, []);
  assert.equal(new Set([...suites.shipped, ...suites.legacy]).size, suites.all.length);
  assert.deepEqual([...suites.shipped, ...suites.legacy].sort(), [...suites.all]);
});

test("packaged runtime sources cannot import extension-primary compatibility", async () => {
  const runtimeFiles = await readStoreRuntimeFiles();
  for (const relativePath of runtimeFiles.filter((file) => file.endsWith(".js"))) {
    const source = await readFile(path.join(ROOT, relativePath), "utf8");
    assert.doesNotMatch(source, /(?:^|["'])\.?\/?compatibility\/extension-primary\//m, relativePath);
  }
});

test("development ZIP tooling cannot re-add extension-primary surfaces", async () => {
  const source = await readFile(path.join(ROOT, "scripts", "build-dev-package.ps1"), "utf8");
  for (const retired of [
    "popup-play.html",
    "playback-addon.js",
    "player.html",
    "player.js",
    "subtitle-folder.html",
    "subtitle-folder.js",
    "subtitle-generation.js",
  ]) {
    assert.doesNotMatch(source, new RegExp(retired.replaceAll(".", "\\.")), retired);
  }
  assert.doesNotMatch(source, /default_popup\s*=\s*['"]popup-play\.html['"]/);
  assert.doesNotMatch(source, /permissions[^\n]*bookmarks/i);
});

test("extension-primary compatibility closure resolves only to packaged shared sources", async () => {
  const { status, stdout, stderr } = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/report-compatibility-closure.mjs"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value) => { stdout += value; });
    child.stderr.setEncoding("utf8").on("data", (value) => { stderr += value; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  assert.equal(status, 0, stderr);
  const report = JSON.parse(stdout);
  assert.equal(report.sourceAssets > 0, true);
  assert.equal(report.tests > 0, true);
  assert.equal(report.runtimeAllowlist, 58);
  assert.equal(report.compatibilityInRuntime, 0);
  assert.deepEqual(report.outsideRuntime, []);
  assert.deepEqual(report.missing, []);
});
