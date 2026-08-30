import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  availableActions,
  detailLine,
  formatBytes,
  isActive,
  jobKind,
  jobTitle,
  languagePair,
  libraryItems,
  mediaTypeLabel,
  newJobId,
  normalizeQualities,
  progressPercent,
  queueJobs,
  queueSummary,
  settingsView,
  sortJobs,
  statusView,
  subtitleJobs,
  subtitleSummary,
  toJobView,
  transferLabel,
  validateLinkInput,
} from "./companion-ui/scripts/model.js";
import {
  createCompanionClient,
  createFixtureTransport,
  createWebView2Transport,
  TransportError,
} from "./companion-ui/scripts/transport.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UI_DIRECTORY = path.join(ROOT, "companion-ui");

async function readFixture() {
  return JSON.parse(await readFile(path.join(UI_DIRECTORY, "fixtures", "jobs.json"), "utf8"));
}

test("status view maps every native download status onto a design system tone", () => {
  assert.deepEqual(statusView({ status: "queued" }), { label: "Queued", tone: "neutral" });
  assert.deepEqual(statusView({ status: "running" }), { label: "Downloading", tone: "neutral" });
  assert.deepEqual(statusView({ status: "completed" }), { label: "Complete", tone: "success" });
  assert.deepEqual(statusView({ status: "failed" }), { label: "Failed", tone: "danger" });
  assert.deepEqual(statusView({ status: "cancelled" }), { label: "Cancelled", tone: "warning" });
});

test("subtitle preparation statuses are covered and running reads as generating", () => {
  for (const status of ["created", "preparing", "submitting"]) {
    assert.deepEqual(statusView({ jobType: "subtitle", status }), { label: "Preparing", tone: "neutral" });
  }
  assert.deepEqual(statusView({ jobType: "subtitle", status: "running" }), {
    label: "Generating",
    tone: "neutral",
  });
});

test("an unknown status never throws and never claims success", () => {
  const view = statusView({ status: "teleporting" });
  assert.equal(view.tone, "neutral");
  assert.equal(view.label, "Unknown");
  assert.equal(statusView(undefined).label, "Unknown");
  assert.equal(statusView({}).label, "Unknown");
});

test("active jobs are exactly the non-terminal ones", () => {
  assert.equal(isActive({ status: "running" }), true);
  assert.equal(isActive({ status: "queued" }), true);
  assert.equal(isActive({ status: "preparing" }), true);
  assert.equal(isActive({ status: "completed" }), false);
  assert.equal(isActive({ status: "failed" }), false);
  assert.equal(isActive({ status: "cancelled" }), false);
  assert.equal(isActive({}), false);
});

test("byte formatting matches the host decimal units and rejects junk", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes(1000), "1 KB");
  assert.equal(formatBytes(38100000), "38.1 MB");
  assert.equal(formatBytes(1400000000), "1.4 GB");
  assert.equal(formatBytes(320000000), "320 MB");
  assert.equal(formatBytes(100400000), "100.4 MB");
  assert.equal(formatBytes(-1), null);
  assert.equal(formatBytes(Number.NaN), null);
  assert.equal(formatBytes("100"), null);
});

test("progress prefers the host percentage and falls back to completed over total", () => {
  assert.equal(progressPercent({ progress: 38 }), 38);
  assert.equal(progressPercent({ completed: 50, total: 200 }), 25);
  assert.equal(progressPercent({ completed: 50, total: 0 }), null);
  assert.equal(progressPercent({}), null);
  assert.equal(progressPercent({ progress: 250 }), 100);
});

test("transfer label degrades from bytes to percent to nothing", () => {
  assert.equal(transferLabel({ completed: 38100000, total: 100400000 }), "38.1 MB / 100.4 MB");
  assert.equal(transferLabel({ completed: 38100000 }), "38.1 MB");
  assert.equal(transferLabel({ progress: 7 }), "7%");
  assert.equal(transferLabel({}), null);
});

test("media type label uses host fields before guessing from the filename", () => {
  assert.equal(mediaTypeLabel({ inputKind: "hls" }), "HLS");
  assert.equal(mediaTypeLabel({ fileName: "clip.mp4" }), "MP4");
  assert.equal(mediaTypeLabel({}), "MEDIA");
  assert.equal(mediaTypeLabel({ jobType: "subtitle" }), "VTT");
  assert.equal(mediaTypeLabel({ jobType: "subtitle", outputFormat: "srt" }), "SRT");
});

test("job title falls back through filename to job id", () => {
  assert.equal(jobTitle({ title: "  ticket show " }), "ticket show");
  assert.equal(jobTitle({ fileName: "clip.mp4" }), "clip.mp4");
  assert.equal(jobTitle({ jobId: "abc" }), "Job abc");
  assert.equal(jobTitle({}), "Untitled job");
});

test("language pair collapses when source and target match", () => {
  assert.equal(languagePair({ sourceLanguage: "en", targetLanguage: "ko" }), "en to ko");
  assert.equal(languagePair({ sourceLanguage: "ko", targetLanguage: "ko" }), "ko");
  assert.equal(languagePair({}), null);
});

test("detail line shows the host error only for failures and never invents text", () => {
  assert.equal(
    detailLine({
      status: "failed",
      error: "The subtitle folder is not writable.",
      statusText: "Subtitle job failed.",
    }),
    "The subtitle folder is not writable.",
  );
  assert.equal(
    detailLine({ status: "running", statusText: "Downloading with yt-dlp.", error: "stale" }),
    "Downloading with yt-dlp.",
  );
  assert.equal(detailLine({ status: "running", phase: "transcribe" }), "transcribe");
  assert.equal(detailLine({ status: "running" }), null);
});

test("actions stay inside the commands the native host implements", () => {
  assert.deepEqual(availableActions({ status: "running" }), ["cancel"]);
  assert.deepEqual(availableActions({ status: "queued" }), ["cancel"]);
  assert.deepEqual(availableActions({ status: "completed", fileName: "a.mp4" }), ["reveal"]);
  assert.deepEqual(availableActions({ status: "completed" }), []);
  assert.deepEqual(availableActions({ status: "failed", error: "boom" }), []);
});

test("jobs sort newest first and split by kind", async () => {
  const fixture = await readFixture();
  const sorted = sortJobs(fixture.jobs);
  for (let index = 1; index < sorted.length; index += 1) {
    assert.ok(sorted[index - 1].updatedAt >= sorted[index].updatedAt);
  }
  assert.ok(queueJobs(fixture.jobs).every((job) => jobKind(job) === "download"));
  assert.ok(subtitleJobs(fixture.jobs).every((job) => jobKind(job) === "subtitle"));
  assert.equal(queueJobs(fixture.jobs).length + subtitleJobs(fixture.jobs).length, fixture.jobs.length);
});

test("library only lists completed download jobs that produced a media file", async () => {
  const fixture = await readFixture();
  const items = libraryItems(fixture.jobs);
  assert.ok(items.length > 0);
  for (const item of items) {
    assert.notEqual(item.fileName, "");
    const source = fixture.jobs.find((job) => job.jobId === item.id);
    assert.equal(source.status, "completed");
    assert.notEqual(source.jobType, "subtitle");
  }
  assert.equal(libraryItems([{ jobId: "x", status: "completed" }]).length, 0);
  assert.equal(libraryItems([{ jobId: "x", status: "running", fileName: "a.mp4" }]).length, 0);
  // A finished subtitle track writes a .vtt, but it is not a media item.
  assert.equal(
    libraryItems([{ jobId: "s", jobType: "subtitle", status: "completed", fileName: "a.ko.vtt" }]).length,
    0,
  );
});

test("summaries count real fixture state", async () => {
  const fixture = await readFixture();
  assert.equal(queueSummary(fixture.jobs), "2 active · 1 failed");
  assert.equal(subtitleSummary(fixture.jobs), "1 generating · 1 ready");
  assert.equal(queueSummary([]), "0 active");
});

test("job view exposes the fields the card renders", () => {
  const view = toJobView({
    jobId: "job-1",
    status: "running",
    statusText: "Downloading with yt-dlp.",
    title: "clip",
    inputKind: "hls",
    progress: 40,
    completed: 4000000,
    total: 10000000,
    updatedAt: 5,
  });
  assert.equal(view.id, "job-1");
  assert.equal(view.kind, "download");
  assert.equal(view.statusLabel, "Downloading");
  assert.equal(view.typeLabel, "HLS");
  assert.equal(view.percent, 40);
  assert.equal(view.transfer, "4 MB / 10 MB");
  assert.deepEqual(view.actions, ["cancel"]);
});

test("settings view reflects the host status reply without inventing editable rows", () => {
  const view = settingsView({
    ok: true,
    protocol: 2,
    version: "0.3.0",
    toolsReady: false,
    downloadsFolder: "C:\\Downloads\\Aura Media",
    entitlementOwner: "companion",
    licenseConfigured: false,
  });
  assert.equal(view.connected, true);
  const rows = view.groups.flatMap((group) => group.rows);
  assert.equal(rows.find((row) => row.title === "Media tools").control.tone, "warning");
  assert.equal(rows.find((row) => row.title === "Subtitle license key").control.label, "Missing");
  assert.equal(rows.find((row) => row.title === "Downloads folder").control.action, "open-folder");

  const offline = settingsView({ ok: false });
  assert.equal(offline.connected, false);
  const offlineRows = offline.groups.flatMap((group) => group.rows);
  assert.equal(offlineRows.find((row) => row.title === "Native messaging host").control.label, "Offline");
  assert.equal(offlineRows.find((row) => row.title === "Downloads folder").control, null);
});

test("link validation only accepts YouTube because that is the host only link command", () => {
  assert.equal(validateLinkInput("https://www.youtube.com/watch?v=abc").ok, true);
  assert.equal(validateLinkInput("https://youtu.be/abc").ok, true);
  assert.equal(validateLinkInput("").ok, false);
  assert.equal(validateLinkInput("not a url").ok, false);
  assert.equal(validateLinkInput("ftp://youtube.com/x").ok, false);
  const other = validateLinkInput("https://playmogo.com/d/abc");
  assert.equal(other.ok, false);
  assert.match(other.reason, /browser extension/);
});

test("quality options stay within the host accepted heights", () => {
  assert.deepEqual(normalizeQualities([{ height: 2160 }, { height: 720 }]), [
    { value: "720", label: "Up to 720p" },
  ]);
  assert.deepEqual(normalizeQualities([]).map((option) => option.value), ["1080", "720", "480"]);
  assert.deepEqual(normalizeQualities(null).map((option) => option.value), ["1080", "720", "480"]);
  assert.equal(normalizeQualities([{ height: 720 }, { height: 720 }]).length, 1);
});

test("generated job ids are safe ascii ids", () => {
  assert.match(newJobId(() => 0.5), /^ui-[0-9a-z]+-[0-9a-z]+$/);
});

test("fixture transport answers every request kind the UI sends", async () => {
  const fixture = await readFixture();
  const client = createCompanionClient(createFixtureTransport(fixture, { now: () => 42 }));
  assert.equal((await client.status()).protocol, 2);
  assert.equal((await client.listJobs()).length, fixture.jobs.length);
  await client.openFolder();
  assert.equal((await client.youtubeInfo("https://youtu.be/abc")).title, "Sample video");
});

test("fixture cancel and download mutate state so the UI shows a transition", async () => {
  const fixture = await readFixture();
  const client = createCompanionClient(createFixtureTransport(fixture, { now: () => 99 }));

  await client.cancelJob("job-running");
  const cancelled = (await client.listJobs()).find((job) => job.jobId === "job-running");
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(availableActions(cancelled), []);

  await client.startYouTubeDownload({ jobId: "job-new", url: "https://youtu.be/abc", quality: "720" });
  assert.equal((await client.listJobs()).find((job) => job.jobId === "job-new").status, "queued");

  assert.equal(fixture.jobs.find((job) => job.jobId === "job-running").status, "running");
});

test("a rejected reply becomes a TransportError carrying the host message", async () => {
  const client = createCompanionClient({
    kind: "stub",
    request: async () => ({
      ok: false,
      error: "지원하지 않는 Aura Companion 요청입니다.",
      errorCode: "unsupported-request",
    }),
  });
  await assert.rejects(
    () => client.listJobs(),
    (error) => {
      assert.ok(error instanceof TransportError);
      assert.equal(error.code, "unsupported-request");
      assert.match(error.message, /Aura Companion/);
      return true;
    },
  );
});

test("cancelling a job that vanished surfaces an error instead of silently passing", async () => {
  const fixture = await readFixture();
  const client = createCompanionClient(createFixtureTransport(fixture));
  await assert.rejects(() => client.cancelJob("missing"), TransportError);
});

test("webview transport resolves by request id and rejects when the bridge is absent", async () => {
  const listeners = [];
  const posted = [];
  const webview = {
    postMessage(value) {
      posted.push(JSON.parse(value));
    },
    addEventListener(_type, listener) {
      listeners.push(listener);
    },
  };
  const transport = createWebView2Transport(webview, { timeoutMs: 1000 });
  const pending = transport.request("status");
  assert.equal(posted[0].type, "status");
  listeners[0]({ data: JSON.stringify({ requestId: posted[0].requestId, ok: true, protocol: 2 }) });
  assert.equal((await pending).protocol, 2);
  assert.throws(() => createWebView2Transport(null), TransportError);
});

test("webview transport times out rather than hanging forever", async () => {
  const transport = createWebView2Transport({ postMessage() {}, addEventListener() {} }, { timeoutMs: 10 });
  await assert.rejects(
    () => transport.request("status"),
    (error) => {
      assert.equal(error.code, "timeout");
      return true;
    },
  );
});

test("the UI uses only design tokens, no raw hex or rgb values", async () => {
  const css = await readFile(path.join(UI_DIRECTORY, "styles", "app.css"), "utf8");
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, "app.css must not hardcode hex colors");
  assert.doesNotMatch(css, /\brgba?\(/, "app.css must not hardcode rgb colors");

  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]));
  const tokens = await readFile(path.join(UI_DIRECTORY, "styles", "tokens.css"), "utf8");
  const defined = new Set([...tokens.matchAll(/^\s{2}(--[a-z0-9-]+):/gm)].map((match) => match[1]));
  const missing = [...used].filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], `undefined tokens: ${missing.join(", ")}`);
});

test("the UI token file stays identical to the exported design system", async () => {
  const uiTokens = await readFile(path.join(UI_DIRECTORY, "styles", "tokens.css"), "utf8");
  const exported = await readFile(path.join(ROOT, "design-system", "tokens", "tokens.css"), "utf8");
  assert.equal(uiTokens, exported);
});

test("the shell markup keeps a strict CSP and no inline script", async () => {
  const html = await readFile(path.join(UI_DIRECTORY, "index.html"), "utf8");
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/, "no inline script tags");
  assert.doesNotMatch(html, /\son[a-z]+=/i, "no inline event handlers");
});

test("rendering never uses innerHTML, which would let host text inject markup", async () => {
  for (const file of ["render.js", "app.js", "model.js", "transport.js"]) {
    const source = await readFile(path.join(UI_DIRECTORY, "scripts", file), "utf8");
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/, file);
  }
});
