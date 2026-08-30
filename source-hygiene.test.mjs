import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    "download-jobs.js",
    "download-worker.js",
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
