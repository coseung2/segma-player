import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixturePath = path.join(repositoryRoot, "media-site-regressions.json");
const reportPath = path.resolve(
  repositoryRoot,
  process.env.AURA_MONITOR_REPORT || "artifacts/live-media-smoke.json",
);
const caseFilter = new Set(String(process.env.AURA_MONITOR_CASES || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean));
const headless = process.env.AURA_MONITOR_HEADLESS !== "0";
const browserChannel = process.env.AURA_MONITOR_CHANNEL || "chromium";

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

function evaluateCase(fixture, candidates) {
  const primary = candidates.find((candidate) => candidate.main && !candidate.likelyAdvertisement) || null;
  if (!primary) return { ok: false, reason: "no-non-ad-primary" };
  if (displayHost(primary) !== fixture.expected.primaryHost) {
    return {
      ok: false,
      reason: "unexpected-primary-host",
      expected: fixture.expected.primaryHost,
      actual: displayHost(primary),
    };
  }
  if (fixture.expected.primaryPlayer && primary.player !== fixture.expected.primaryPlayer) {
    return {
      ok: false,
      reason: "unexpected-primary-player",
      expected: fixture.expected.primaryPlayer,
      actual: primary.player || "",
    };
  }
  if (fixture.expected.rejectedAdvertisementHost) {
    const advertisement = candidates.find((candidate) =>
      displayHost(candidate) === fixture.expected.rejectedAdvertisementHost);
    if (advertisement?.main || (advertisement && !advertisement.likelyAdvertisement)) {
      return { ok: false, reason: "advertisement-promoted" };
    }
  }
  return { ok: true, reason: "primary-candidate-stable" };
}

async function extensionWorker(context) {
  const existing = context.serviceWorkers()[0];
  if (existing) return existing;
  return context.waitForEvent("serviceworker", { timeout: 15_000 });
}

async function candidateSnapshot(controlPage, targetUrl) {
  return controlPage.evaluate(async (pageUrl) => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find((tab) => tab.url === pageUrl)
      || tabs.find((tab) => typeof tab.url === "string" && pageUrl.startsWith(tab.url));
    const tabId = target?.id ?? null;
    if (!Number.isInteger(tabId)) return { ok: false, candidates: [] };
    const response = await chrome.runtime.sendMessage({ type: "list-candidates", tabId });
    return {
      ok: response?.type === "candidates",
      activeTabId: tabId,
      candidates: Array.isArray(response?.candidates) ? response.candidates : [],
    };
  }, targetUrl);
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("playwright-not-installed: install Playwright and a Chromium browser before live monitoring");
  }

  const allFixtures = JSON.parse(await readFile(fixturePath, "utf8"));
  const fixtures = allFixtures.filter((fixture) => !caseFilter.size || caseFilter.has(fixture.id));
  if (!fixtures.length) throw new Error("no-monitor-cases-selected");

  const profileDirectory = await mkdtemp(path.join(os.tmpdir(), "aura-media-monitor-"));
  let context = null;
  const results = [];
  try {
    context = await chromium.launchPersistentContext(profileDirectory, {
      channel: browserChannel,
      headless,
      args: [
        `--disable-extensions-except=${repositoryRoot}`,
        `--load-extension=${repositoryRoot}`,
      ],
    });
    const worker = await extensionWorker(context);
    const extensionId = new URL(worker.url()).host;
    const page = context.pages()[0] || await context.newPage();
    const controlPage = await context.newPage();
    await controlPage.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    page.setDefaultTimeout(10_000);
    controlPage.setDefaultTimeout(10_000);

    for (const fixture of fixtures) {
      const startedAt = new Date().toISOString();
      try {
        await page.goto(fixture.liveUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        if (process.env.AURA_MONITOR_AUTOPLAY === "1") {
          await page.locator("video").first().evaluate((video) => video.play().catch(() => {})).catch(() => {});
        }
        await page.waitForTimeout(Math.max(2_000, Math.min(30_000, Number(fixture.settleMs) || 10_000)));
        const snapshot = await candidateSnapshot(controlPage, page.url());
        const candidates = snapshot.candidates.map((candidate) => ({
          id: candidate.id,
          main: candidate.main,
          classification: candidate.classification,
          score: candidate.score,
          mediaType: candidate.mediaType,
          displayUrl: candidate.displayUrl,
          player: candidate.player,
          tokenized: candidate.tokenized,
          likelyAdvertisement: candidate.likelyAdvertisement,
        }));
        results.push({
          id: fixture.id,
          startedAt,
          ...evaluateCase(fixture, candidates),
          candidateCount: candidates.length,
          candidates,
        });
      } catch (error) {
        results.push({
          id: fixture.id,
          startedAt,
          ok: false,
          reason: "monitor-execution-failed",
          error: redactedError(error),
          candidateCount: 0,
          candidates: [],
        });
      }
    }
  } finally {
    await context?.close().catch(() => {});
    await rm(profileDirectory, { recursive: true, force: true });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    browserChannel,
    headless,
    ok: results.every((result) => result.ok),
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
