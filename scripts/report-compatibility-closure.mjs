import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COMPATIBILITY_DIRECTORY } from "./node-suite-config.mjs";
import { readStoreRuntimeFiles } from "./runtime-graph.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(scriptDirectory);

function sourceReferences(source, extension) {
  const patterns = extension === ".html"
    ? [/<(?:script|link|img|iframe)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi]
    : [
      /\bimport\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
      /\bexport\s+[^"']*?\s+from\s+["']([^"']+)["']/g,
      /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(absolute));
    else files.push(path.relative(repositoryRoot, absolute).replaceAll("\\", "/"));
  }
  return files;
}

const compatibilityRoot = path.join(repositoryRoot, ...COMPATIBILITY_DIRECTORY.split("/"));
const compatibilityFiles = await filesUnder(compatibilityRoot);
const tests = compatibilityFiles.filter((file) => file.endsWith(".test.mjs"));
const sources = compatibilityFiles.filter((file) => !file.endsWith(".test.mjs") && !file.endsWith("/README.md"));
const runtimeFiles = new Set(await readStoreRuntimeFiles());
const visited = new Set();
const external = new Set();
const missing = [];
const queue = [...sources];

while (queue.length) {
  const importer = queue.shift();
  if (visited.has(importer)) continue;
  visited.add(importer);
  const extension = path.posix.extname(importer);
  if (![".html", ".js", ".mjs"].includes(extension)) continue;
  const source = await readFile(path.join(repositoryRoot, ...importer.split("/")), "utf8");
  for (const specifier of sourceReferences(source, extension)) {
    if (/^(?:[a-z]+:|\/\/|#)/i.test(specifier)) continue;
    const relativeSpecifier = extension === ".html"
      && !specifier.startsWith(".") && !specifier.startsWith("/")
      ? `./${specifier}`
      : specifier;
    if (!relativeSpecifier.startsWith(".")) continue;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(importer), relativeSpecifier));
    try {
      await access(path.join(repositoryRoot, ...target.split("/")));
    } catch {
      missing.push(`${importer} -> ${target}`);
      continue;
    }
    if (!target.startsWith(`${COMPATIBILITY_DIRECTORY}/`)) external.add(target);
    queue.push(target);
  }
}

const shared = [...external].filter((file) => runtimeFiles.has(file)).sort();
const outsideRuntime = [...external].filter((file) => !runtimeFiles.has(file)).sort();
const values = {
  sourceAssets: sources.length,
  tests: tests.length,
  totalMoved: sources.length + tests.length,
  runtimeAllowlist: runtimeFiles.size,
  compatibilityInRuntime: [...runtimeFiles].filter((file) => file.startsWith(`${COMPATIBILITY_DIRECTORY}/`)).length,
  shared,
  outsideRuntime,
  missing,
  sources: sources.map((file) => file.slice(COMPATIBILITY_DIRECTORY.length + 1)).sort(),
  testFiles: tests.map((file) => file.slice(COMPATIBILITY_DIRECTORY.length + 1)).sort(),
};

process.stdout.write(`${JSON.stringify(values, null, 2)}\n`);
