import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SITE_REGRESSION_FIXTURES } from "../sites/regressions.js";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extensionRoot = path.resolve(String(process.env.AURA_MONITOR_EXTENSION_ROOT || repositoryRoot));
const manifestPath = path.join(extensionRoot, "manifest.json");
const extensionManifest = JSON.parse(await readFile(manifestPath, "utf8"));
const extensionVersion = String(extensionManifest.version || "unknown");
const extensionName = String(extensionManifest.name || "").trim();
if (!extensionName) throw new Error("extension-name-missing");
const reportRunStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const commandLineReport = process.argv.find((argument) => argument.startsWith("--report="))?.slice("--report=".length) || "";
const reportPath = path.resolve(
  repositoryRoot,
  process.env.AURA_MONITOR_REPORT
    || commandLineReport
    || `artifacts/live-media-${extensionVersion}-${reportRunStamp}.json`,
);
const commandLineCases = process.argv.find((argument) => argument.startsWith("--cases="))?.slice("--cases=".length) || "";
const caseFilter = new Set(String(process.env.AURA_MONITOR_CASES || commandLineCases)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean));
const headless = !process.argv.includes("--headed") && process.env.AURA_MONITOR_HEADLESS !== "0";
const autoplay = process.argv.includes("--autoplay") || process.env.AURA_MONITOR_AUTOPLAY === "1";
const allowBlocked = process.argv.includes("--allow-blocked")
  || process.env.AURA_MONITOR_ALLOW_BLOCKED === "1";
const requireCompanion = process.argv.includes("--require-companion")
  || process.env.AURA_MONITOR_REQUIRE_COMPANION === "1";
const disableSandbox = process.env.AURA_MONITOR_NO_SANDBOX === "1";
const challengeWaitArgument = process.argv.find((argument) => argument === "--wait-for-challenge"
  || argument.startsWith("--wait-for-challenge="));
const challengeWaitSeconds = challengeWaitArgument
  ? Math.max(30, Math.min(600, Number(challengeWaitArgument.split("=")[1]) || 180))
  : 0;
const browserChannel = process.env.AURA_MONITOR_CHANNEL
  || (process.platform === "win32" ? "chrome" : "chromium");
const browserExecutablePath = String(process.env.AURA_MONITOR_EXECUTABLE_PATH || "").trim();
const requestedAdblockMode = process.argv.find((argument) => argument.startsWith("--adblock="))?.slice("--adblock=".length) || "";
const adblockMode = ["auto", "on", "quiet", "site-allow", "off"].includes(requestedAdblockMode) ? requestedAdblockMode : "";
const adblockRoot = String(process.env.AURA_ADBLOCK_ROOT
  || path.resolve(repositoryRoot, "..", "aura-vpn", "adblock-extension")).trim();
const headlessChromeUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const configuredMinimumProgressiveBytesValue = process.argv
  .find((argument) => argument.startsWith("--min-progressive-bytes="))
  ?.slice("--min-progressive-bytes=".length)
  || process.env.AURA_MONITOR_MIN_PROGRESSIVE_BYTES
  || "";
const configuredMinimumProgressiveBytes = configuredMinimumProgressiveBytesValue
  ? Math.max(0, Number(configuredMinimumProgressiveBytesValue) || 0)
  : null;

function minimumProgressiveBytesFor(fixture) {
  if (configuredMinimumProgressiveBytes !== null) return configuredMinimumProgressiveBytes;
  const fixtureMinimum = Number(fixture?.expected?.minimumProgressiveBytes);
  return Number.isFinite(fixtureMinimum) && fixtureMinimum >= 0 ? fixtureMinimum : 0;
}

async function cachedChromiumExecutable() {
  const cacheRoots = [
    String(process.env.PLAYWRIGHT_BROWSERS_PATH || "").trim(),
    process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local", "ms-playwright")
      : path.join(os.homedir(), ".cache", "ms-playwright"),
  ].filter(Boolean);
  for (const cacheRoot of [...new Set(cacheRoots)]) {
    let revisions;
    try {
      revisions = (await readdir(cacheRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => Number(right.split("-")[1]) - Number(left.split("-")[1]));
    } catch {
      continue;
    }
    for (const revision of revisions) {
      const candidates = process.platform === "win32"
        ? ["chrome-win64/chrome.exe", "chrome-win/chrome.exe"]
        : process.platform === "darwin"
          ? ["chrome-mac/Chromium.app/Contents/MacOS/Chromium"]
          : ["chrome-linux/chrome"];
      for (const relative of candidates) {
        const executable = path.join(cacheRoot, revision, ...relative.split("/"));
        try {
          await access(executable);
          return executable;
        } catch {
          // Try the next cached revision/layout.
        }
      }
    }
  }
  return "";
}

function redactedError(error) {
  const message = typeof error?.message === "string" ? error.message : String(error || "unknown-error");
  return message.replace(/https?:\/\/\S+/gi, "[url-redacted]").slice(0, 500);
}

function displayHost(candidate) {
  try {
    return new URL(String(candidate?.displayUrl || "")).hostname;
  } catch {
    return "";
  }
}

async function closePageBounded(page, timeoutMs = 3_000) {
  if (!page) return;
  await Promise.race([
    page.close({ runBeforeUnload: false }).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function displayPath(candidate) {
  try {
    return new URL(String(candidate?.displayUrl || "")).pathname;
  } catch {
    return "";
  }
}

function evaluateCase(fixture, candidates) {
  const expected = fixture.expected || {};
  const minimumCandidateCount = Number.isInteger(expected.minimumCandidateCount)
    ? Math.max(0, expected.minimumCandidateCount)
    : 1;
  if (candidates.length < minimumCandidateCount) {
    return {
      ok: false,
      reason: "insufficient-candidates",
      expected: minimumCandidateCount,
      actual: candidates.length,
    };
  }
  const primary = candidates.find((candidate) => candidate.main && !candidate.likelyAdvertisement) || null;
  if (expected.requireNonAdvertisementPrimary !== false && !primary) {
    return { ok: false, reason: "no-non-ad-primary" };
  }
  const rejectedPrimaryPath = (expected.rejectedPrimaryPathPrefixes || [])
    .find((prefix) => displayPath(primary).startsWith(prefix));
  if (rejectedPrimaryPath) {
    return {
      ok: false,
      reason: "rejected-primary-path",
      expected: rejectedPrimaryPath,
      actual: "[path-redacted]",
    };
  }
  if (expected.primaryHost && !expected.livePrimaryHostFlexible && displayHost(primary) !== expected.primaryHost) {
    return {
      ok: false,
      reason: "unexpected-primary-host",
      expected: expected.primaryHost,
      actual: displayHost(primary),
    };
  }
  if (expected.primaryPlayer && primary?.player !== expected.primaryPlayer) {
    return {
      ok: false,
      reason: "unexpected-primary-player",
      expected: expected.primaryPlayer,
      actual: primary?.player || "",
    };
  }
  if (expected.rejectedAdvertisementHost) {
    const advertisement = candidates.find((candidate) =>
      displayHost(candidate) === expected.rejectedAdvertisementHost);
    if (advertisement?.main || (advertisement && !advertisement.likelyAdvertisement)) {
      return { ok: false, reason: "advertisement-promoted" };
    }
  }
  return {
    ok: true,
    reason: expected.primaryHost ? "primary-candidate-stable" : "downloadable-primary-detected",
  };
}

async function extensionRootLoadable(root) {
  try {
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    const required = [
      manifest.background?.service_worker,
      ...Object.values(manifest.icons || {}),
      ...Object.values(manifest.action?.default_icon || {}),
    ].filter((value) => typeof value === "string" && value);
    await Promise.all(required.map((relativePath) => access(path.join(root, relativePath))));
    return true;
  } catch {
    return false;
  }
}

async function unpackedExtensionId(root) {
  const canonical = await realpath(root).catch(() => path.resolve(root));
  const digest = createHash("sha256").update(canonical).digest().subarray(0, 16);
  return [...digest].map((byte) => String.fromCharCode(
    97 + (byte >> 4),
    97 + (byte & 15),
  )).join("");
}

async function extensionIdsByName(context, definitions) {
  const pending = new Map(definitions.map((definition) => [definition.name, definition]));
  const ids = new Map();
  const deadline = Date.now() + 15_000;
  while (pending.size && Date.now() < deadline) {
    for (const worker of context.serviceWorkers()) {
      let name = "";
      try { name = await worker.evaluate(() => chrome.runtime.getManifest().name); } catch {}
      if (!pending.has(name)) continue;
      ids.set(name, new URL(worker.url()).host);
      pending.delete(name);
    }
    if (pending.size) await new Promise((resolve) => setTimeout(resolve, 250));
  }

  for (const [name, definition] of [...pending]) {
    const extensionId = await unpackedExtensionId(definition.root);
    const wakePage = await context.newPage();
    try {
      await wakePage.goto(`chrome-extension://${extensionId}/${definition.page || "popup.html"}`, {
        waitUntil: "domcontentloaded",
        timeout: 10_000,
      });
      const loadedName = await wakePage.evaluate(() => chrome.runtime.getManifest().name);
      if (loadedName === name) {
        ids.set(name, extensionId);
        pending.delete(name);
      }
    } catch {
      // The service-worker discovery error below retains the expected name.
    } finally {
      await closePageBounded(wakePage);
    }
  }

  if (pending.size) throw new Error(`extension-workers-unavailable:${[...pending.keys()].join(",")}`);
  return ids;
}

async function configureAdblock(controlPage, fixture, mode) {
  if (!mode) return null;
  const site = new URL(fixture.liveUrl).hostname;
  return controlPage.evaluate(async ({ site, mode }) => {
    const send = (message) => chrome.runtime.sendMessage(message);
    await send({ type: "adblock:set-enabled", enabled: true });
    await send({ type: "adblock:set-site-allowed", site, allowed: false });
    await send({ type: "adblock:set-site-quiet", site, quiet: false });
    if (mode === "quiet") await send({ type: "adblock:set-site-quiet", site, quiet: true });
    if (mode === "site-allow") await send({ type: "adblock:set-site-allowed", site, allowed: true });
    if (mode === "off") await send({ type: "adblock:set-enabled", enabled: false });
    const state = await send({ type: "adblock:get-state" });
    return {
      enabled: state?.settings?.enabled === true,
      siteAllowed: state?.settings?.siteAllow?.includes(site) === true,
      quiet: state?.settings?.quietSites?.includes(site) === true,
    };
  }, { site, mode });
}

async function challengeHint(page) {
  for (const frame of page.frames()) {
    const detected = await frame.evaluate(() => {
      const bodyText = String(document.body?.innerText || "").slice(0, 5000);
      if (/access denied|access restricted|checking your browser|cloudflare|captcha|turnstile|verify you are human|just a moment|접속 제한|접근 제한|서비스 이용이 제한/i
        .test(`${document.title}\n${bodyText}`)) return true;
      const selectors = [
        ".cf-turnstile",
        "#turnstile-container",
        "[name*=turnstile]",
        "iframe[src*=challenges]",
        ".captcha-player",
        ".captcha_l",
        "[class*=captcha]",
        "iframe[src*=recaptcha]",
      ];
      const elements = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
      return [...new Set(elements)].some((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden"
          && Number(style.opacity || "1") > 0 && rect.width > 0 && rect.height > 0;
      });
    }).catch(() => false);
    if (detected) return true;
  }
  return false;
}

async function waitForUserChallenge(page, navigationStatus) {
  const detected = navigationStatus === 403 || await challengeHint(page);
  if (!detected) return { detected: false, completed: false, waitedMs: 0 };
  if (!challengeWaitSeconds) return { detected: true, completed: false, waitedMs: 0 };
  const startedAt = Date.now();
  await page.bringToFront().catch(() => {});
  process.stdout.write(`LIVE_MEDIA_CHALLENGE_WAIT=${challengeWaitSeconds}\n`);
  const deadline = startedAt + challengeWaitSeconds * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    if (!await challengeHint(page)) {
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
      return { detected: true, completed: true, waitedMs: Date.now() - startedAt };
    }
  }
  return { detected: true, completed: false, timedOut: true, waitedMs: Date.now() - startedAt };
}

async function navigateWithTransientRetry(page, url) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (error) {
      const transient = /ERR_(?:CONNECTION_(?:CLOSED|RESET)|NETWORK_CHANGED)/i.test(String(error?.message || error));
      if (!transient || attempt > 0) throw error;
      await page.waitForTimeout(1_000);
    }
  }
  return null;
}

async function tabIdForUrl(controlPage, targetUrl) {
  return controlPage.evaluate(async (pageUrl) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === pageUrl)?.id ?? null;
  }, targetUrl);
}

async function candidateSnapshot(controlPage, tabId) {
  return controlPage.evaluate(async (targetTabId) => {
    const tabId = Number.isInteger(targetTabId) ? targetTabId : null;
    if (!Number.isInteger(tabId)) return { ok: false, candidates: [] };
    const response = await chrome.runtime.sendMessage({ type: "list-candidates", tabId });
    return {
      ok: response?.type === "candidates",
      activeTabId: tabId,
      candidates: Array.isArray(response?.candidates) ? response.candidates : [],
    };
  }, tabId);
}

async function probeProgressiveCandidate(controlPage, candidateId) {
  return controlPage.evaluate(async (id) => chrome.runtime.sendMessage({
    type: "probe-progressive-candidate",
    candidateId: id,
  }), candidateId);
}

async function nativePlaybackSnapshot(page) {
  const frames = [];
  for (const frame of page.frames()) {
    try {
      await frame.locator("video").evaluateAll((videos) => videos.slice(0, 8).forEach((video) => {
        try {
          video.muted = true;
          void video.play().catch(() => {});
        } catch {}
      }));
    } catch {}
  }
  await page.waitForTimeout(1_500);
  for (const frame of page.frames()) {
    try {
      const states = await frame.locator("video").evaluateAll((videos) => videos.slice(0, 8).map((video) => ({
        readyState: Number(video.readyState || 0),
        paused: video.paused !== false,
        currentTime: Number(video.currentTime || 0),
        videoWidth: Number(video.videoWidth || 0),
        videoHeight: Number(video.videoHeight || 0),
        errorCode: Number(video.error?.code || 0),
      })));
      if (states.length) frames.push({ host: new URL(frame.url()).hostname, videos: states });
    } catch {}
  }
  return {
    ok: frames.some((entry) => entry.videos.some((video) => video.errorCode === 0
      && video.readyState >= 2 && video.currentTime > 0.1 && video.videoWidth > 0 && !video.paused)),
    frames,
  };
}

async function verifyCandidatePlayback(controlPage, context, candidate) {
  await controlPage.evaluate(async () => chrome.runtime.sendMessage({
    type: "clear-media-request-diagnostics",
  })).catch(() => null);
  const created = await controlPage.evaluate(async ({ candidateId, sourceUrl }) => chrome.runtime.sendMessage({
    type: "create-playback-session",
    candidateId,
    sourceUrl,
  }), { candidateId: candidate.id, sourceUrl: candidate.sourceUrl || "" });
  if (!created?.ok || typeof created.sessionId !== "string") {
    return { ok: false, reason: created?.error || "playback-session-unavailable" };
  }
  const controlUrl = new URL(controlPage.url());
  const extensionOrigin = `${controlUrl.protocol}//${controlUrl.host}`;
  const playerPage = await context.newPage();
  const playerResponses = [];
  const playerConsoleErrors = [];
  playerPage.on("response", (response) => {
    try {
      const url = new URL(response.url());
      if (url.protocol === "http:" || url.protocol === "https:") {
        const requestHeaders = response.request().headers();
        const responseHeaders = response.headers();
        playerResponses.push({
          host: url.hostname,
          path: url.pathname.slice(0, 160),
          status: response.status(),
          type: response.request().resourceType(),
          requestHeaderNames: Object.keys(requestHeaders).filter((name) =>
            ["origin", "referer", "range", "authorization", "cookie"].includes(name.toLowerCase())),
          responseHeaderNames: Object.keys(responseHeaders).filter((name) =>
            ["access-control-allow-origin", "content-range", "content-type", "content-length"].includes(name.toLowerCase())),
        });
      }
    } catch {}
  });
  playerPage.on("console", (message) => {
    if (message.type() === "error") playerConsoleErrors.push(redactedError(message.text()));
  });
  try {
    await playerPage.goto(`${extensionOrigin}/player.html?session=${encodeURIComponent(created.sessionId)}`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    await playerPage.waitForFunction(() => {
      const video = document.querySelector("#video");
      const message = document.querySelector("#message");
      return Boolean(video?.currentSrc || Number.isFinite(video?.duration)
        || (message && !message.hidden));
    }, null, { timeout: 15_000 }).catch(() => {});
    await playerPage.locator("#video").click({ position: { x: 40, y: 40 }, timeout: 3_000 }).catch(() => {});
    await playerPage.locator("#video").evaluate(async (video) => {
      video.muted = true;
      try { void video.play().catch(() => {}); } catch {}
    });
    await playerPage.waitForFunction(() => {
      const video = document.querySelector("#video");
      return Boolean(video && !video.error && video.readyState >= 2
        && video.videoWidth > 0 && video.currentTime > 0.1 && !video.paused);
    }, null, { timeout: 30_000 }).catch(() => {});
    const state = await playerPage.evaluate(() => {
      const video = document.querySelector("#video");
      const message = document.querySelector("#message");
      const currentSrcHost = (() => {
        try { return new URL(video?.currentSrc || "").hostname; } catch { return ""; }
      })();
      const state = {
        readyState: Number(video?.readyState || 0),
        paused: video?.paused !== false,
        currentTime: Number(video?.currentTime || 0),
        duration: Number.isFinite(video?.duration) ? Number(video.duration) : null,
        videoWidth: Number(video?.videoWidth || 0),
        videoHeight: Number(video?.videoHeight || 0),
        mediaErrorCode: Number(video?.error?.code || 0),
        currentSrcHost,
        message: message && !message.hidden ? String(message.textContent || "").slice(0, 240) : "",
        diagnostics: globalThis.__auraPlaybackDiagnostics || null,
      };
      return {
        ok: state.mediaErrorCode === 0 && state.readyState >= 2 && state.videoWidth > 0
          && state.currentTime > 0.1 && !state.paused,
        ...state,
      };
    });
    const requestDiagnostics = await controlPage.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({
        type: "get-media-request-diagnostics",
        limit: 100,
      });
      return response?.ok && Array.isArray(response.requests) ? response.requests : [];
    }).catch(() => []);
    return {
      ...state,
      responses: [...new Map(playerResponses.map((item) => [`${item.host}|${item.status}|${item.type}`, item])).values()].slice(0, 30),
      requestDiagnostics,
      consoleErrors: playerConsoleErrors.slice(0, 10),
    };
  } catch (error) {
    return { ok: false, reason: redactedError(error) };
  } finally {
    await closePageBounded(playerPage);
  }
}

async function completedChromeDownloadBytes(controlPage, exactUrl, startedAt, minimumBytes) {
  const initial = await controlPage.evaluate(async ({ url, since }) => {
    const expectedHost = new URL(url).hostname;
    const items = await chrome.downloads.search({ startedAfter: since });
    return items.find((item) => [item.url, item.finalUrl].some((value) => {
      try { return new URL(value).hostname === expectedHost; } catch { return false; }
    })) || null;
  }, { url: exactUrl, since: startedAt });
  if (!initial) return null;
  const deadline = Date.now() + 60_000;
  let item = initial;
  let receivedBytes = Math.max(Number(item?.bytesReceived) || 0, Number(item?.fileSize) || 0);
  while (item?.state === "in_progress" && receivedBytes <= minimumBytes && Date.now() < deadline) {
    await controlPage.waitForTimeout(1_000);
    item = await controlPage.evaluate(async (id) => (await chrome.downloads.search({ id }))[0] || null, item.id);
    receivedBytes = Math.max(Number(item?.bytesReceived) || 0, Number(item?.fileSize) || 0);
  }
  const bytes = item?.state === "complete"
    ? Math.max(Number(item.fileSize) || 0, Number(item.totalBytes) || 0)
    : receivedBytes > minimumBytes ? receivedBytes : null;
  if (Number.isInteger(item?.id)) {
    await controlPage.evaluate(async (id) => {
      await chrome.downloads.cancel(id).catch(() => {});
      await chrome.downloads.removeFile(id).catch(() => {});
      await chrome.downloads.erase({ id }).catch(() => {});
    }, item.id);
  }
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("playwright-not-installed: install Playwright and a Chromium browser before live monitoring");
  }

  const fixtures = SITE_REGRESSION_FIXTURES
    .filter((fixture) => !caseFilter.size || caseFilter.has(fixture.id));
  if (!fixtures.length) throw new Error("no-monitor-cases-selected");
  const adblockAvailable = await extensionRootLoadable(adblockRoot);
  const activeAdblockMode = adblockMode
    || (adblockAvailable && fixtures.some((fixture) => fixture.recommendedAdblockMode) ? "auto" : "");
  if (adblockMode && !adblockAvailable) throw new Error("requested-adblock-extension-unavailable");

  const profileDirectory = await mkdtemp(path.join(os.tmpdir(), "aura-media-monitor-"));
  const cachedExecutablePath = browserExecutablePath ? "" : await cachedChromiumExecutable();
  const resolvedExecutablePath = browserExecutablePath || cachedExecutablePath;
  let context = null;
  let companionStatus = { ok: false, errorCode: "not-checked" };
  const results = [];
  try {
    if (challengeWaitSeconds && headless) throw new Error("challenge-wait-requires-headed");
    const extensionRoots = activeAdblockMode ? [extensionRoot, adblockRoot] : [extensionRoot];
    const extensionArgument = extensionRoots.join(",");
    context = await chromium.launchPersistentContext(profileDirectory, {
      ...(resolvedExecutablePath
        ? { executablePath: resolvedExecutablePath }
        : { channel: browserChannel }),
      headless,
      acceptDownloads: true,
      downloadsPath: path.join(profileDirectory, "downloads"),
      ...(headless ? {
        userAgent: headlessChromeUserAgent,
      } : {}),
      args: [
        `--disable-extensions-except=${extensionArgument}`,
        `--load-extension=${extensionArgument}`,
        ...(headless ? [`--user-agent=${headlessChromeUserAgent}`] : []),
        ...(autoplay ? ["--autoplay-policy=no-user-gesture-required"] : []),
        ...(disableSandbox ? [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-crash-reporter",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ] : []),
      ],
    });
    const bootstrapPage = context.pages()[0] || await context.newPage();
    await bootstrapPage.goto("https://example.com/", {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    const extensionDefinitions = [
      { name: extensionName, root: extensionRoot, page: "popup.html" },
      ...(activeAdblockMode
        ? [{ name: "Aura AdBlock", root: adblockRoot, page: "popup.html" }]
        : []),
    ];
    const extensionIds = await extensionIdsByName(context, extensionDefinitions);
    const extensionId = extensionIds.get(extensionName);
    const controlPage = await context.newPage();
    await controlPage.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    controlPage.setDefaultTimeout(10_000);
    companionStatus = await controlPage.evaluate(async () => {
      const status = await chrome.runtime.sendMessage({ type: "companion-status" });
      return {
        ok: status?.ok === true,
        protocol: Number(status?.protocol) || null,
        version: typeof status?.version === "string" ? status.version : "",
        toolsReady: status?.toolsReady === true,
        capabilities: Array.isArray(status?.capabilities)
          ? status.capabilities.filter((value) => typeof value === "string")
          : [],
        errorCode: typeof status?.errorCode === "string" ? status.errorCode : "",
        error: typeof status?.error === "string" ? status.error.slice(0, 160) : "",
      };
    }).catch((error) => ({
      ok: false,
      errorCode: String(error?.message || "companion-status-failed").slice(0, 160),
    }));
    let adblockControlPage = null;
    if (activeAdblockMode) {
      const adblockExtensionId = extensionIds.get("Aura AdBlock");
      adblockControlPage = await context.newPage();
      await adblockControlPage.goto(`chrome-extension://${adblockExtensionId}/popup.html`, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      adblockControlPage.setDefaultTimeout(10_000);
    }
    await bootstrapPage.close().catch(() => {});

    for (const fixture of fixtures) {
      const startedAt = new Date().toISOString();
      const fixtureAdblockMode = activeAdblockMode === "auto"
        ? fixture.recommendedAdblockMode || "on"
        : activeAdblockMode;
      const progressiveMinimumBytes = minimumProgressiveBytesFor(fixture);
      const recommendationSatisfiedWithoutExtension = !fixtureAdblockMode
        && fixture.recommendedAdblockMode === "site-allow";
      const environment = {
        recommendedAdblockMode: fixture.recommendedAdblockMode || "",
        appliedAdblockMode: fixtureAdblockMode || "not-loaded",
        effectiveTrafficMode: recommendationSatisfiedWithoutExtension
          ? "site-allow-equivalent"
          : fixtureAdblockMode || "not-loaded",
        matchesRecommendation: !fixture.recommendedAdblockMode
          || fixture.recommendedAdblockMode === fixtureAdblockMode
          || recommendationSatisfiedWithoutExtension,
      };
      const mediaResponses = [];
      let page = null;
      const observeResponse = (response) => {
        try {
          const request = response.request();
          const url = new URL(response.url());
          if (request.resourceType() !== "media" && !/\.(?:m3u8|mp4|mpd)(?:$|[/?])/i.test(url.pathname)) return;
          mediaResponses.push({ host: url.hostname, resourceType: request.resourceType(), status: response.status() });
          if (mediaResponses.length > 50) mediaResponses.shift();
        } catch {}
      };
      try {
        const adblockState = await configureAdblock(adblockControlPage, fixture, fixtureAdblockMode);
        page = await context.newPage();
        page.setDefaultTimeout(10_000);
        const markerUrl = `https://example.com/?aura-monitor=${encodeURIComponent(fixture.id)}-${Date.now()}`;
        await page.goto(markerUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
        const caseTabId = await tabIdForUrl(controlPage, markerUrl);
        if (!Number.isInteger(caseTabId)) throw new Error("monitor-tab-unavailable");
        page.on("response", observeResponse);
        let resolveNavigationDownload;
        const navigationDownloadEvent = new Promise((resolve) => { resolveNavigationDownload = resolve; });
        page.once("download", resolveNavigationDownload);
        const navigationResponse = await navigateWithTransientRetry(page, fixture.liveUrl);
        const navigationHeaders = await navigationResponse?.allHeaders?.().catch(() => ({})) || {};
        const navigationContentRange = String(navigationHeaders["content-range"] || "");
        const navigationLength = String(navigationHeaders["content-length"] || "");
        const navigationRangeTotal = /\/\s*(\d+)\s*$/.exec(navigationContentRange)?.[1] || "";
        const navigationTotalBytes = /^\d+$/.test(navigationRangeTotal) ? Number(navigationRangeTotal)
          : /^\d+$/.test(navigationLength) ? Number(navigationLength) : null;
        const navigationContentType = String(navigationHeaders["content-type"] || "");
        const navigationIsMedia = /^(?:video|audio)\//i.test(navigationContentType)
          || /octet-stream/i.test(navigationContentType)
          || /attachment/i.test(String(navigationHeaders["content-disposition"] || ""));
        const challenge = await waitForUserChallenge(page, navigationResponse?.status() ?? null);
        if (autoplay) {
          for (const frame of page.frames().slice(1)) {
            const safeToClick = await frame.evaluate(() => {
              const text = String(document.body?.innerText || "").slice(0, 3000);
              return location.hostname !== "challenges.cloudflare.com"
                && !/cloudflare|captcha|turnstile|verify you are human|just a moment/i.test(`${document.title}\n${text}`);
            }).catch(() => false);
            if (safeToClick) {
              await frame.locator("body").click({ position: { x: 80, y: 80 }, timeout: 2_000 }).catch(() => {});
            }
          }
          await page.waitForTimeout(1_000);
          for (const frame of page.frames()) {
            await frame.locator("video").evaluateAll((videos) => videos.slice(0, 8).forEach((video) => {
              try {
                video.muted = true;
                void video.play().catch(() => {});
              } catch {}
            })).catch(() => {});
          }
        }
        await page.waitForTimeout(Math.max(2_000, Math.min(30_000, Number(fixture.settleMs) || 10_000)));
        const navigationDownload = await Promise.race([
          navigationDownloadEvent,
          page.waitForTimeout(100).then(() => null),
        ]);
        let navigationDownloadBytes = null;
        if (navigationDownload) {
          const downloadedPath = await Promise.race([
            navigationDownload.path(),
            page.waitForTimeout(5_000).then(() => null),
          ]).catch(() => null);
          if (downloadedPath) {
            navigationDownloadBytes = Number((await stat(downloadedPath)).size);
          }
        }
        const pageState = await page.evaluate(() => {
          const hostOf = (value) => {
            try { return new URL(String(value || ""), location.href).hostname; } catch { return ""; }
          };
          const bodyText = String(document.body?.innerText || "").slice(0, 5000);
          return {
            finalHost: location.hostname,
            readyState: document.readyState,
            videoCount: document.querySelectorAll("video").length,
            iframeHosts: [...new Set([...document.querySelectorAll("iframe")]
              .map((frame) => hostOf(frame.src)).filter(Boolean))].slice(0, 20),
            challengeHint: /access denied|access restricted|checking your browser|cloudflare|captcha|turnstile|verify you are human|just a moment|접속 제한|접근 제한|서비스 이용이 제한/i
              .test(`${document.title}\n${bodyText}`),
          };
        });
        pageState.status = navigationResponse?.status() ?? null;
        pageState.navigationHost = (() => {
          try { return new URL(navigationResponse?.url() || "").hostname; } catch { return ""; }
        })();
        pageState.challengeHint = pageState.challengeHint || await challengeHint(page);
        pageState.challenge = challenge;
        pageState.openPageHosts = [...new Set(context.pages().map((openPage) => {
          try { return new URL(openPage.url()).hostname; } catch { return ""; }
        }).filter(Boolean))];
        pageState.frames = [];
        for (const frame of page.frames()) {
          try {
            pageState.frames.push(await frame.evaluate(() => {
              const hostOf = (value) => {
                try { return new URL(String(value || ""), location.href).hostname; } catch { return ""; }
              };
              return {
                host: location.hostname,
                videoCount: document.querySelectorAll("video").length,
                currentMediaHosts: [...new Set([...document.querySelectorAll("video")]
                  .flatMap((video) => [video.currentSrc, video.src, ...[...video.querySelectorAll("source")].map((source) => source.src)])
                  .map(hostOf).filter(Boolean))].slice(0, 20),
                hasHlsRuntime: typeof globalThis.Hls === "function",
                hasLevel5Runtime: typeof globalThis.Level5Player === "function",
              };
            }));
          } catch {}
        }
        pageState.mediaResponses = [...new Map(mediaResponses.map((item) => [`${item.host}|${item.resourceType}|${item.status}`, item])).values()];
        pageState.nativePlayback = await nativePlaybackSnapshot(page);
        const snapshot = await candidateSnapshot(controlPage, caseTabId);
        const candidates = snapshot.candidates.map((candidate) => ({
          id: candidate.id,
          main: candidate.main,
          classification: candidate.classification,
          score: candidate.score,
          mediaType: candidate.mediaType,
          displayUrl: candidate.displayUrl,
          sourceUrl: candidate.sourceUrl,
          player: candidate.player,
          tokenized: candidate.tokenized,
          likelyAdvertisement: candidate.likelyAdvertisement,
        }));
        const reportedCandidates = candidates.map(({ displayUrl, sourceUrl, ...candidate }) => ({
          ...candidate,
          displayHost: displayHost({ displayUrl }),
          displayPath: displayPath({ displayUrl }).slice(0, 160),
        }));
        const expectedFinalHosts = new Set([
          new URL(fixture.liveUrl).hostname,
          ...(fixture.expected?.allowedFinalHosts || []),
        ]);
        const reachedExpectedPage = expectedFinalHosts.has(pageState.finalHost)
          || expectedFinalHosts.has(pageState.navigationHost);
        let evaluation = reachedExpectedPage
          ? evaluateCase(fixture, candidates)
          : {
              ok: false,
              reason: "unexpected-final-page",
              expected: [...expectedFinalHosts],
              actual: pageState.finalHost,
            };
        if (pageState.challengeHint && !challenge.completed) {
          evaluation = {
            ok: false,
            blocked: true,
            reason: "site-challenge",
          };
        } else if (evaluation.ok && !environment.matchesRecommendation) {
          evaluation = {
            ok: false,
            blocked: true,
            reason: "environment-mismatch",
            expectedAdblockMode: environment.recommendedAdblockMode,
            actualAdblockMode: environment.appliedAdblockMode,
          };
        }
        const primary = candidates.find((candidate) => candidate.main && !candidate.likelyAdvertisement) || null;
        let progressiveProbe = null;
        if (evaluation.ok && primary?.mediaType === "PROGRESSIVE") {
          const probe = await probeProgressiveCandidate(controlPage, primary.id);
          const exactNavigationCandidate = primary.displayUrl === navigationResponse?.url();
          const navigationFallback = exactNavigationCandidate && navigationIsMedia
            && Number.isFinite(navigationTotalBytes) ? navigationTotalBytes : null;
          const downloadedFallback = exactNavigationCandidate && Number.isFinite(navigationDownloadBytes)
            ? navigationDownloadBytes : null;
          const totalBytes = Number.isFinite(probe?.totalBytes) ? probe.totalBytes
            : downloadedFallback ?? navigationFallback;
          const sourceFrameFallback = probe?.sourceFrameFallback === true;
          progressiveProbe = {
            ok: sourceFrameFallback || (totalBytes !== null && totalBytes > progressiveMinimumBytes),
            totalBytes,
            minimumBytesExclusive: progressiveMinimumBytes,
            source: sourceFrameFallback ? "source-frame-fallback"
              : Number.isFinite(probe?.totalBytes) ? "authenticated-range"
                : downloadedFallback !== null ? "received-navigation-download"
                  : navigationFallback !== null ? "exact-navigation-response" : "inconclusive",
            sourceFrameFallback,
            fallbackReason: sourceFrameFallback ? String(probe?.fallbackReason || "probe-unavailable") : "",
            rangeSupported: probe?.rangeSupported === true || Boolean(navigationContentRange),
            contentKind: probe?.contentKind
              || (navigationIsMedia || downloadedFallback !== null ? "media" : "unknown"),
            error: totalBytes !== null || sourceFrameFallback
              ? ""
              : String(probe?.error || "progressive-probe-failed"),
          };
          if (!progressiveProbe.ok) {
            evaluation = {
              ok: false,
              reason: totalBytes === null ? "progressive-size-unknown" : "progressive-too-small",
              expectedGreaterThanBytes: progressiveMinimumBytes,
              actualBytes: totalBytes,
            };
          }
        }
        results.push({
          id: fixture.id,
          startedAt,
          adblockMode: fixtureAdblockMode || "not-loaded",
          adblockState,
          environment,
          page: pageState,
          ...evaluation,
          progressiveProbe,
          candidateCount: candidates.length,
          candidates: reportedCandidates,
        });
      } catch (error) {
        results.push({
          id: fixture.id,
          startedAt,
          adblockMode: fixtureAdblockMode || "not-loaded",
          environment,
          ok: false,
          reason: "monitor-execution-failed",
          error: redactedError(error),
          candidateCount: 0,
          candidates: [],
        });
      } finally {
        page?.off("response", observeResponse);
        await closePageBounded(page);
      }
    }
  } finally {
    if (context) {
      const closed = await Promise.race([
        context.close().then(() => true).catch(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 8_000)),
      ]);
      if (!closed) await context.browser()?.close().catch(() => {});
    }
    await rm(profileDirectory, { recursive: true, force: true });
  }

  const companionReady = companionStatus.ok === true
    && companionStatus.toolsReady === true
    && companionStatus.capabilities?.includes("media-download-v1");
  const rawOk = results.every((result) => result.ok) && (!requireCompanion || companionReady);
  const reportOk = results.every((result) => result.ok || (allowBlocked && result.blocked === true))
    && (!requireCompanion || companionReady);
  const report = {
    generatedAt: new Date().toISOString(),
    extensionVersion,
    browserChannel,
    browserExecutable: browserExecutablePath
      ? "custom"
      : cachedExecutablePath
        ? "playwright-cache"
        : "channel",
    headless,
    autoplay,
    allowBlocked,
    requireCompanion,
    companionReady,
    companionStatus,
    challengeWaitSeconds,
    minimumProgressiveBytes: configuredMinimumProgressiveBytes,
    adblockMode: activeAdblockMode || "not-loaded",
    adblockAvailable,
    ok: reportOk,
    rawOk,
    results,
  };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`LIVE_MEDIA_SMOKE_REPORT=${reportPath}\n`);
  process.stdout.write(`LIVE_MEDIA_SMOKE_OK=${report.ok}\n`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${redactedError(error)}\n`);
  process.exitCode = 2;
});
