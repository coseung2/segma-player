import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const STORE_RUNTIME_CONFIG_PATH = path.join(scriptDirectory, "store-runtime-files.json");

function normalizedRelativePath(value, label) {
  if (typeof value !== "string" || !value || value.includes("\\")) {
    throw new Error(`${label} must be a non-empty POSIX path: ${String(value)}`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(value)) {
    throw new Error(`${label} escapes or is not normalized: ${value}`);
  }
  return normalized;
}

export async function readStoreRuntimeFiles(configPath = STORE_RUNTIME_CONFIG_PATH) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (!config || !Array.isArray(config.files)) throw new Error("Runtime config must contain a files array.");
  const files = config.files.map((value) => normalizedRelativePath(value, "Runtime file"));
  if (new Set(files).size !== files.length) throw new Error("Runtime config contains duplicate files.");
  return Object.freeze([...files].sort());
}

function resolveRelativeSpecifier(importer, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  if (target.startsWith("../") || path.posix.isAbsolute(target)) {
    throw new Error(`${importer} imports outside the packaged runtime: ${specifier}`);
  }
  return target;
}

function javascriptReferences(source) {
  const references = [];
  const patterns = [
    /\bimport\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+[^"']*?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) references.push(match[1]);
  }
  return references;
}

function htmlReferences(source) {
  const references = [];
  for (const match of source.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    references.push(match[1]);
  }
  return references;
}

function manifestRoots(manifest) {
  const roots = new Set(["manifest.json"]);
  const add = (value) => {
    if (typeof value === "string" && value) roots.add(normalizedRelativePath(value, "Manifest entry"));
  };
  add(manifest.background?.service_worker);
  for (const script of manifest.content_scripts || []) {
    for (const value of script.js || []) add(value);
    for (const value of script.css || []) add(value);
  }
  add(manifest.action?.default_popup);
  add(manifest.options_page);
  add(manifest.options_ui?.page);
  for (const value of Object.values(manifest.icons || {})) add(value);
  for (const value of Object.values(manifest.action?.default_icon || {})) add(value);
  return roots;
}

export async function validateRuntimeGraph({ stageDirectory, runtimeFiles }) {
  const root = path.resolve(stageDirectory);
  const declared = new Set(runtimeFiles || await readStoreRuntimeFiles());
  const manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const reachable = manifestRoots(manifest);
  const queue = [...reachable];

  for (let index = 0; index < queue.length; index += 1) {
    const relativePath = queue[index];
    if (!declared.has(relativePath)) throw new Error(`Runtime entry/import is not declared: ${relativePath}`);
    const extension = path.posix.extname(relativePath).toLowerCase();
    if (extension !== ".js" && extension !== ".html") continue;
    const source = await readFile(path.join(root, relativePath), "utf8");
    const references = extension === ".js" ? javascriptReferences(source) : htmlReferences(source);
    for (const specifier of references) {
      if (/^(?:[a-z]+:|\/\/|#)/i.test(specifier)) continue;
      const relativeSpecifier = extension === ".html"
        && !specifier.startsWith("./") && !specifier.startsWith("../") && !specifier.startsWith("/")
        ? `./${specifier}`
        : specifier;
      const target = resolveRelativeSpecifier(relativePath, relativeSpecifier);
      if (!target || reachable.has(target)) continue;
      reachable.add(target);
      queue.push(target);
    }
  }

  const unreachable = [...declared].filter((value) => !reachable.has(value)).sort();
  if (unreachable.length) {
    throw new Error(`Declared runtime files are unreachable from the manifest: ${unreachable.join(",")}`);
  }
  return Object.freeze({ files: declared.size, reachable: Object.freeze([...reachable].sort()) });
}
