import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)));
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
