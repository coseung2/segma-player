import { readFile, readdir, rm, mkdir, copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.dirname(scriptDirectory);

export const STORE_RUNTIME_FILES = Object.freeze([
  "aes-cbc.js",
  "background.js",
  "browser-download-monitor.js",
  "candidate.js",
  "candidate-ranking.js",
  "content.js",
  "dash.js",
  "download-checkpoint.js",
  "download-errors.js",
  "download-job-view.js",
  "download-jobs.js",
  "download-mode.js",
  "download-scheduler.js",
  "download-worker.html",
  "download-worker.js",
  "download.js",
  "edition.js",
  "filename-template.js",
  "hls-download.js",
  "hls.js",
  "i18n.js",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
  "level5-key-error.js",
  "level5-page-bridge.js",
  "license.js",
  "manifest.json",
  "media-fetch-lease.js",
  "media-request-context.js",
  "mobile-user-agent.js",
  "options.html",
  "options.js",
  "page-media-observer.js",
  "parallel-download.js",
  "playback-session.js",
  "player-page-resolver.js",
  "popup.css",
  "popup.html",
  "popup.js",
  "product-plan.js",
  "progressive-redirect.js",
  "qr-code.js",
  "request-header-store.js",
  "save-directory.js",
  "worker-lifecycle.js",
  "youtube-server.js",
].sort());

export const DEV_EXTRA_FILES = Object.freeze([
  "collection.js",
  "contextual-hls-loader.js",
  "hls-playback-recovery.js",
  "playback-addon.js",
  "player-subtitle.js",
  "player.html",
  "player.js",
  "popup-play.html",
  "subtitle-folder.html",
  "subtitle-folder.js",
  "subtitle-generation.js",
  "vendor/hls.min.mjs",
].sort());

export const DEV_STAGING_FILES = Object.freeze(
  [...new Set([...STORE_RUNTIME_FILES, ...DEV_EXTRA_FILES])].sort(),
);

const TEXT_EXTENSION = /\.(?:css|html|js|json)$/i;
const FORBIDDEN_IDENTIFIERS = [
  /personalvpn/i,
  /personal-vpn/i,
  /com\.personal/i,
  /hfpkpbadllkhedocoglbggkpnbaibmcp/i,
  /wherewindsmeet/i,
  /redirect-block-rules/i,
  /route-client/i,
  /MEDIA_ROUTE_NATIVE_HOST/i,
];

function parseArguments(argv) {
  const options = {};
  for (const argument of argv) {
    if (argument === "--help") options.help = true;
    else if (argument.startsWith("--edition=")) options.edition = argument.slice("--edition=".length);
    else if (argument.startsWith("--version=")) options.version = argument.slice("--version=".length);
    else if (argument.startsWith("--output=")) options.outputDirectory = argument.slice("--output=".length);
    else if (argument.startsWith("--upgrade-url=")) options.upgradeUrl = argument.slice("--upgrade-url=".length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function validateEdition(value) {
  if (value !== "free" && value !== "pro") throw new Error(`Invalid edition: ${value}`);
  return value;
}

function validateVersion(value) {
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`Invalid Chrome extension version: ${value}`);
  }
  return value;
}

function validateUpgradeUrl(value) {
  if (!value) return "";
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Upgrade URL must be absolute HTTPS without embedded credentials.");
  }
  return url.href;
}

async function copyRelativeFile(repositoryRoot, stageDirectory, relativePath) {
  const source = path.join(repositoryRoot, relativePath);
  const destination = path.join(stageDirectory, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

function removeFunction(text, name) {
  const pattern = new RegExp(
    `\\r?\\n  (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}\\r?\\n`,
    "m",
  );
  const next = text.replace(pattern, "\n");
  if (next === text) throw new Error(`Store bridge transform could not remove ${name}.`);
  return next;
}

export function storeSafeLevel5Bridge(source) {
  let text = source.replace(/^  let decoderPromise = null;\r?\n/m, "");
  text = removeFunction(text, "inlineAssetUrl");
  text = removeFunction(text, "level5Decoder");
  text = removeFunction(text, "decodeRuntimeKey");
  const runtimeFallback = /    let failure = "level5-key-unavailable";\r?\n    try \{\r?\n      const key = await decodeRuntimeKey\(url\.href\);[\s\S]*?^    \}\r?\n/m;
  const next = text.replace(runtimeFallback, '    let failure = "level5-key-unavailable";\n');
  if (next === text) throw new Error("Store bridge transform could not remove runtime key fallback.");
  return next;
}

function normalizeLegacyLabels(text) {
  return text
    .replaceAll("personal-vpn", "aura-media")
    .replaceAll("personalVpn", "auraMedia")
    .replaceAll("Personal VPN", "Aura Media");
}

async function stageTextTransforms(stageDirectory) {
  for (const relativePath of DEV_STAGING_FILES) {
    if (!TEXT_EXTENSION.test(relativePath)) continue;
    const destination = path.join(stageDirectory, relativePath);
    let text = await readFile(destination, "utf8");
    if (relativePath === "level5-page-bridge.js") text = storeSafeLevel5Bridge(text);
    text = normalizeLegacyLabels(text);
    await writeFile(destination, text, "utf8");
  }
}

async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(path.join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}

function expectedStorePermissions() {
  return [
    "activeTab",
    "alarms",
    "contextMenus",
    "declarativeNetRequest",
    "downloads",
    "offscreen",
    "scripting",
    "storage",
    "webRequest",
  ].sort();
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateAuditedManifest(manifest) {
  if (manifest.manifest_version !== 3) throw new Error("Store manifest must be Manifest V3.");
  if (Number(manifest.minimum_chrome_version) < 111) throw new Error("Store manifest requires Chrome 111+.");
  if (manifest.name !== "Aura Media Downloader") throw new Error("Store manifest branding mismatch.");
  if ("key" in manifest || "declarative_net_request" in manifest) {
    throw new Error("Store manifest contains a forbidden fixed key or static DNR rule.");
  }
  const permissions = [...(manifest.permissions || [])].sort();
  if (!arraysEqual(permissions, expectedStorePermissions())) {
    throw new Error("Store manifest permissions differ from the audited runtime minimum.");
  }
  const hosts = [...(manifest.host_permissions || [])].sort();
  if (!arraysEqual(hosts, ["http://*/*", "https://*/*"])) {
    throw new Error("Store manifest host permissions mismatch.");
  }
  const scripts = manifest.content_scripts || [];
  if (scripts.length !== 2
    || scripts[0]?.world !== "MAIN"
    || scripts[0]?.run_at !== "document_start"
    || scripts[0]?.all_frames !== true
    || !arraysEqual(scripts[0]?.js || [], ["page-media-observer.js", "level5-page-bridge.js"])
    || scripts[1]?.run_at !== "document_start"
    || scripts[1]?.all_frames !== true
    || "world" in scripts[1]
    || !arraysEqual(scripts[1]?.js || [], ["content.js"])) {
    throw new Error("Store manifest content scripts differ from the audited runtime.");
  }
}

async function writeEdition(stageDirectory, edition, upgradeUrl) {
  const comment = edition === "pro"
    ? "// Generated by scripts/build-dev-staging.mjs (Pro development build). Do not ship to the store."
    : "// Generated by scripts/build-dev-staging.mjs. Do not edit the staged copy.";
  await writeFile(path.join(stageDirectory, "edition.js"), [
    comment,
    `export const PRODUCT_EDITION = ${JSON.stringify(edition)};`,
    `export const UPGRADE_URL = ${JSON.stringify(upgradeUrl)};`,
    "",
  ].join("\n"), "utf8");
}

async function writeDevelopmentManifest({ repositoryRoot, stageDirectory, version }) {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "store", "manifest.json"), "utf8"));
  validateAuditedManifest(manifest);
  manifest.version = version;
  manifest.action.default_popup = "popup-play.html";
  manifest.permissions = [...new Set([...(manifest.permissions || []), "bookmarks"])].sort();
  await writeFile(path.join(stageDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function auditStage(stageDirectory, version, edition) {
  const actualFiles = await listFiles(stageDirectory);
  if (!arraysEqual(actualFiles, DEV_STAGING_FILES)) {
    const missing = DEV_STAGING_FILES.filter((value) => !actualFiles.includes(value));
    const extra = actualFiles.filter((value) => !DEV_STAGING_FILES.includes(value));
    throw new Error(`Staged files differ from the allowlist. Missing=${missing.join(",")} Extra=${extra.join(",")}`);
  }

  const manifest = JSON.parse(await readFile(path.join(stageDirectory, "manifest.json"), "utf8"));
  if (manifest.version !== version || manifest.action?.default_popup !== "popup-play.html") {
    throw new Error("Development manifest version or popup mismatch.");
  }
  if (!manifest.permissions.includes("bookmarks")) throw new Error("Development manifest is missing bookmarks permission.");

  const editionModule = await readFile(path.join(stageDirectory, "edition.js"), "utf8");
  if (!editionModule.includes(`PRODUCT_EDITION = ${JSON.stringify(edition)}`)) {
    throw new Error("Staged edition does not match the requested edition.");
  }

  for (const relativePath of actualFiles.filter((value) => TEXT_EXTENSION.test(value))) {
    const text = await readFile(path.join(stageDirectory, relativePath), "utf8");
    for (const pattern of FORBIDDEN_IDENTIFIERS) {
      if (pattern.test(text)) throw new Error(`Forbidden identifier ${pattern} found in ${relativePath}.`);
    }
  }

  const bridge = await readFile(path.join(stageDirectory, "level5-page-bridge.js"), "utf8");
  if (/\bimport\s*\(|\bWebAssembly\b|\bwasm\b|\/assets\/|inlineAssetUrl|level5Decoder|decodeRuntimeKey|document\.scripts/i.test(bridge)) {
    throw new Error("Staged page bridge contains a remote runtime or dynamic decode path.");
  }
  if (!/cachedKey\(hls, url\.href\)/.test(bridge) || !/loadKey\(hls, url\.href\)/.test(bridge)) {
    throw new Error("Staged page bridge is missing bundled cache or loader key paths.");
  }
}

export async function buildDevStaging({
  repositoryRoot = defaultRepositoryRoot,
  outputDirectory = "",
  edition = "pro",
  version = "",
  upgradeUrl = "",
} = {}) {
  const root = path.resolve(repositoryRoot);
  const selectedEdition = validateEdition(edition);
  const sourceManifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const selectedVersion = validateVersion(version || String(sourceManifest.version || ""));
  const selectedUpgradeUrl = validateUpgradeUrl(upgradeUrl);
  const stageDirectory = path.resolve(outputDirectory || path.join(
    root,
    "artifacts",
    "chrome-web-store",
    selectedEdition === "pro" ? "staging-pro" : "staging",
  ));
  if (stageDirectory === root) throw new Error("Refusing to stage into the repository root.");

  await rm(stageDirectory, { recursive: true, force: true });
  await mkdir(stageDirectory, { recursive: true });
  for (const relativePath of DEV_STAGING_FILES) {
    if (["edition.js", "manifest.json"].includes(relativePath)) continue;
    await copyRelativeFile(root, stageDirectory, relativePath);
  }
  await writeEdition(stageDirectory, selectedEdition, selectedUpgradeUrl);
  await writeDevelopmentManifest({ repositoryRoot: root, stageDirectory, version: selectedVersion });
  await stageTextTransforms(stageDirectory);
  await auditStage(stageDirectory, selectedVersion, selectedEdition);
  return Object.freeze({
    stageDirectory,
    version: selectedVersion,
    edition: selectedEdition,
    files: DEV_STAGING_FILES.length,
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: node scripts/build-dev-staging.mjs [--edition=pro|free] [--version=X.Y.Z] [--output=PATH] [--upgrade-url=https://...]\n");
    return;
  }
  const result = await buildDevStaging(options);
  process.stdout.write([
    "DEV_STAGING_OK",
    `VERSION=${result.version}`,
    `EDITION=${result.edition}`,
    `FILES=${result.files}`,
    `STAGING=${result.stageDirectory}`,
    "",
  ].join("\n"));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
