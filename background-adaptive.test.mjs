import test from "node:test";
import assert from "node:assert/strict";

// Behavioral integration harness for the background service worker. The
// worker's module scope binds Chrome APIs and resolvers at import time, so
// mocks are installed before the dynamic import and the tests drive the
// actual registered listeners. Evidence is behavior-level: response payloads,
// fetch counts/signals, storage snapshots, and port messages.

const runtimeId = "test-extension-id";
const workerUrl = `chrome-extension://${runtimeId}/download-worker.html`;
const runtimeListeners = { onMessage: [], onConnect: [] };
const tabsListeners = { onUpdated: [], onRemoved: [] };
const webRequestListeners = { onBeforeRedirect: [] };
const sessionStorage = new Map();
const localStorage = new Map();
const runtimeMessages = [];
const cancelledDownloadIds = [];
const downloadListeners = { created: [], changed: [] };
const downloadItems = new Map();
let lastCandidatesSnapshot = null;
let tabsSendResponse = null;
let fetchHandler = null;
const fetchCalls = [];

globalThis.fetch = async (input, options = {}) => {
  const call = { url: String(input), options, signal: options?.signal ?? null };
  fetchCalls.push(call);
  if (!fetchHandler) throw new Error(`unexpected fetch: ${call.url}`);
  return fetchHandler(call);
};

globalThis.chrome = {
  runtime: {
    id: runtimeId,
    getURL: (path) => `chrome-extension://${runtimeId}/${path}`,
    getManifest: () => ({ version: "0.0.0-test" }),
    lastError: null,
    connectNative: () => { throw new Error("unexpected native connection"); },
    sendMessage: async (message) => {
      runtimeMessages.push(message);
      return { ok: true };
    },
    onMessage: { addListener: (fn) => runtimeListeners.onMessage.push(fn) },
    onConnect: { addListener: (fn) => runtimeListeners.onConnect.push(fn) },
    onInstalled: { addListener: () => {} },
  },
  storage: {
    local: {
      get: async (defaults) => {
        if (typeof defaults === "string") return { [defaults]: localStorage.get(defaults) };
        const result = {};
        for (const [key, fallback] of Object.entries(defaults || {})) {
          result[key] = localStorage.has(key) ? localStorage.get(key) : fallback;
        }
        return result;
      },
      set: async (values) => {
        for (const [key, value] of Object.entries(values)) localStorage.set(key, value);
      },
      onChanged: { addListener: () => {} },
    },
    session: {
      get: async (defaults) => {
        const result = {};
        for (const [key, fallback] of Object.entries(defaults || {})) {
          result[key] = sessionStorage.has(key) ? sessionStorage.get(key) : fallback;
        }
        return result;
      },
      set: async (values) => {
        for (const [key, value] of Object.entries(values)) {
          sessionStorage.set(key, value);
          if (key === "candidates") lastCandidatesSnapshot = value;
        }
      },
    },
  },
  declarativeNetRequest: {
    getSessionRules: async () => [],
    updateSessionRules: async () => {},
  },
  tabs: {
    query: async () => [{ id: 1, url: "https://outer.example/", title: "Outer" }],
    get: async () => ({ title: "Outer" }),
    sendMessage: async () => tabsSendResponse,
    onUpdated: { addListener: (fn) => tabsListeners.onUpdated.push(fn) },
    onRemoved: { addListener: (fn) => tabsListeners.onRemoved.push(fn) },
    onActivated: { addListener: () => {} },
  },
  windows: { onFocusChanged: { addListener: () => {} }, WINDOW_ID_NONE: -1 },
  downloads: {
    download: async (options) => {
      downloadItems.set(1, { id: 1, url: options.url, state: "in_progress", fileSize: 0, totalBytes: -1 });
      return 1;
    },
    search: async ({ id }) => downloadItems.has(id) ? [{ ...downloadItems.get(id) }] : [],
    removeFile: async () => {},
    cancel: async (downloadId) => { cancelledDownloadIds.push(downloadId); },
    onCreated: {
      addListener: (listener) => downloadListeners.created.push(listener),
      removeListener: (listener) => {
        downloadListeners.created = downloadListeners.created.filter((item) => item !== listener);
      },
    },
    onChanged: {
      addListener: (listener) => downloadListeners.changed.push(listener),
      removeListener: (listener) => {
        downloadListeners.changed = downloadListeners.changed.filter((item) => item !== listener);
      },
    },
  },
  contextMenus: {
    removeAll: (callback) => callback?.(),
    create: () => {},
    onClicked: { addListener: () => {} },
  },
  offscreen: { hasDocument: async () => true, createDocument: async () => {} },
  scripting: { executeScript: async () => {} },
  action: { onClicked: { addListener: () => {} } },
  webRequest: {
    onSendHeaders: { addListener: () => {} },
    onBeforeRedirect: { addListener: (listener) => webRequestListeners.onBeforeRedirect.push(listener) },
    onBeforeRequest: { addListener: () => {} },
    onHeadersReceived: { addListener: () => {} },
  },
};

// Keep the worker's 60s lease-sweep interval from holding the test process
// open; behavior is unaffected because the sweep registry stays empty.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...args) => {
  const handle = realSetInterval(fn, ms, ...args);
  handle.unref?.();
  return handle;
};

await import("./background.js");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => delay(0);
const countFetches = (url) => fetchCalls.filter((call) => call.url === url).length;
const htmlPage = (body) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
const okResponse = () => new Response("", { status: 200 });
const opaqueRedirect = () => ({
  ok: false,
  status: 0,
  type: "opaqueredirect",
  url: "",
  redirected: false,
  headers: { get: () => null },
  body: { cancel: async () => {} },
});

function responseCollector() {
  let resolveResponse;
  const response = new Promise((resolve) => { resolveResponse = resolve; });
  return { response, resolveResponse };
}

async function downloadUrl(rawUrl) {
  const { response, resolveResponse } = responseCollector();
  const keepAlive = runtimeListeners.onMessage[0]({ type: "download-url", url: rawUrl }, {}, resolveResponse);
  assert.equal(keepAlive, true);
  return response;
}

async function runtimeMessage(message, sender = {}) {
  const { response, resolveResponse } = responseCollector();
  const keepAlive = runtimeListeners.onMessage[0](message, sender, resolveResponse);
  if (keepAlive !== true) return { keepAlive, response: undefined };
  return { keepAlive, response: await response };
}

function mediaStreamPort() {
  const messages = [];
  const disconnectListeners = [];
  let messageListener = null;
  const port = {
    name: "media-stream",
    sender: { id: runtimeId, url: workerUrl },
    messages,
    onMessage: { addListener: (fn) => { messageListener = fn; } },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    postMessage: (message) => messages.push(message),
    start(message) {
      assert.ok(messageListener, "media-stream listener must be registered");
      return messageListener(message);
    },
    disconnect() {
      for (const fn of disconnectListeners) fn();
    },
  };
  runtimeListeners.onConnect[0](port);
  return port;
}

const DIRECT_MP4 = (name) => `https://cdn.example/${name}/video.mp4`;

function fetchHandlerHtml(mediaUrl) {
  return `<script>var src="${mediaUrl}"</script>`;
}

test("pasted player URLs classify HLS and progressive through one shared resolver", async () => {
  fetchCalls.length = 0;
  const hlsPage = "https://player.example/d/hls";
  const hlsUrl = "https://cdn.example/hls/master.m3u8";
  const mp4Page = "https://player.example/d/mp4";
  const mp4Url = DIRECT_MP4("mp4");
  fetchHandler = (call) => {
    if (call.url === hlsPage) return htmlPage(fetchHandlerHtml(hlsUrl));
    if (call.url === mp4Page) return htmlPage(fetchHandlerHtml(mp4Url));
    return okResponse();
  };

  const first = await downloadUrl(hlsPage);
  assert.equal(first.ok, true);
  assert.equal(first.mode, "hls", "HLS resolution must stay typed as HLS, not relabeled progressive");
  assert.equal(countFetches(hlsPage), 1);

  const cached = await downloadUrl(hlsPage);
  assert.equal(cached.ok, true);
  assert.equal(cached.mode, "hls");
  assert.equal(countFetches(hlsPage), 1, "repeated resolution must hit the shared resolver cache");

  const progressive = await downloadUrl(mp4Page);
  assert.equal(progressive.ok, true);
  assert.equal(progressive.mode, "stream", "progressive resolution must create a progressive candidate");
  assert.equal(countFetches(mp4Page), 1);
});

test("pasted players resolve Chrome opaque redirects through the background observer", async () => {
  fetchCalls.length = 0;
  const pageUrl = "https://player.example/e/redirect-source";
  const redirectedUrl = "https://mirror.example/e/redirect-target";
  const mediaUrl = "https://cdn.example/redirected.mp4";
  fetchHandler = ({ url }) => {
    if (url === pageUrl) {
      webRequestListeners.onBeforeRedirect[0]({ url: pageUrl, redirectUrl: redirectedUrl });
      return opaqueRedirect();
    }
    if (url === redirectedUrl) return htmlPage(`<script>file: "${mediaUrl}"</script>`);
    return okResponse();
  };

  const result = await downloadUrl(pageUrl);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "stream");
  assert.deepEqual(fetchCalls.slice(0, 2).map(({ url }) => url), [pageUrl, redirectedUrl]);
  assert.ok(fetchCalls.slice(0, 2).every(({ options }) => options.redirect === "manual"));
});

test("media-stream starts coalesce concurrent traversals and reuse the shared cache", async () => {
  fetchCalls.length = 0;
  const pageUrl = "https://player.example/d/coalesce";
  const directUrl = DIRECT_MP4("coalesce");
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  fetchHandler = (call) => {
    if (call.url === pageUrl) return gate.then(() => htmlPage(fetchHandlerHtml(directUrl)));
    return okResponse();
  };

  const portA = mediaStreamPort();
  const portB = mediaStreamPort();
  const first = portA.start({ type: "start", url: directUrl, pageUrl });
  await settle();
  assert.equal(countFetches(pageUrl), 1, "first start must begin exactly one traversal");
  const second = portB.start({ type: "start", url: directUrl, pageUrl });
  await settle();
  assert.equal(countFetches(pageUrl), 1, "concurrent starts must coalesce on one traversal");
  releaseGate();
  await Promise.all([first, second]);
  assert.equal(portA.messages.length, 1);
  assert.equal(portB.messages.length, 1);
  assert.equal(portA.messages[0].type, "fetch-required");
  assert.equal(portB.messages[0].type, "fetch-required");
  assert.equal(portA.messages[0].url, directUrl);
  assert.equal(portB.messages[0].url, directUrl);
  assert.equal(countFetches(pageUrl), 1, "shared resolver must never duplicate the traversal");

  const portC = mediaStreamPort();
  await portC.start({ type: "start", url: directUrl, pageUrl });
  await portC.start({ type: "start", url: directUrl, pageUrl });
  assert.equal(portC.messages.length, 2, "sequential starts must reuse the shared positive cache");
  assert.equal(portC.messages[0].type, "fetch-required");
  assert.equal(portC.messages[1].type, "fetch-required");
  assert.equal(countFetches(pageUrl), 1, "sequential starts must hit the positive cache");
});

test("media-stream keeps in-frame dood priority above the static graph fallback", async () => {
  fetchCalls.length = 0;
  const pageUrl = "https://player.example/d/dood";
  let graphFetches = 0;
  fetchHandler = (call) => {
    if (call.url === pageUrl) {
      graphFetches += 1;
      return htmlPage(fetchHandlerHtml(DIRECT_MP4("static")));
    }
    return okResponse();
  };

  tabsSendResponse = { ok: true, url: "https://doodcdn.example/fresh/token.mp4", frameUrl: "https://player.example/e/dood" };
  const freshPort = mediaStreamPort();
  await freshPort.start({
    type: "start",
    url: "https://doodcdn.example/stale.mp4",
    pageUrl,
    videoTabId: 7,
  });
  assert.equal(freshPort.messages.length, 1);
  assert.equal(freshPort.messages[0].type, "fetch-required");
  assert.equal(freshPort.messages[0].url, "https://doodcdn.example/fresh/token.mp4");
  assert.equal(freshPort.messages[0].referrer, "https://player.example/e/dood");
  assert.equal(graphFetches, 0, "in-frame get-dood-direct must win over the static graph fallback");

  tabsSendResponse = null;
  runtimeListeners.onMessage[0](
    { type: "dood-direct", url: "https://doodcdn.example/cached.mp4", frameUrl: "https://player.example/e/cached" },
    { id: runtimeId, tab: { id: 7 } },
    () => {},
  );
  const cachedPort = mediaStreamPort();
  await cachedPort.start({
    type: "start",
    url: "https://doodcdn.example/stale.mp4",
    pageUrl,
    videoTabId: 7,
  });
  assert.equal(cachedPort.messages.length, 1);
  assert.equal(cachedPort.messages[0].type, "fetch-required");
  assert.equal(cachedPort.messages[0].url, "https://doodcdn.example/cached.mp4");
  assert.equal(cachedPort.messages[0].referrer, "https://player.example/e/cached");
  assert.equal(graphFetches, 0, "cached doodDirectByTab must also win over the static graph fallback");
});

test("source-frame Dood handoff waits for a non-empty Chrome download", async () => {
  const url = "https://asw188q.cloudatacdn.com/getfile/video?token=fresh&expiry=1";
  tabsSendResponse = { ok: true };
  const pending = runtimeMessage({
    type: "download-in-source-frame",
    requestId: "source-request-0001",
    url,
    filename: "video.mp4",
    tabId: 7,
    frameId: 3,
  }, { id: runtimeId, url: workerUrl });
  await settle();
  const item = { id: 77, url, state: "in_progress", fileSize: 0, totalBytes: -1 };
  downloadItems.set(item.id, item);
  for (const listener of downloadListeners.created) listener({ ...item });
  await settle();
  downloadItems.set(item.id, { ...item, state: "complete", fileSize: 8192, totalBytes: 8192 });
  for (const listener of downloadListeners.changed) listener({ id: item.id, state: { current: "complete" } });
  assert.deepEqual((await pending).response, { ok: true, downloadId: 77, bytes: 8192 });
  tabsSendResponse = null;
});

test("port disconnect aborts in-flight graph resolution and suppresses port output", async () => {
  fetchCalls.length = 0;
  const pageUrl = "https://player.example/d/abort";
  const directUrl = DIRECT_MP4("abort");
  let releaseFetch;
  let seenSignal = null;
  const gate = new Promise((resolve) => { releaseFetch = resolve; });
  fetchHandler = (call) => {
    if (call.url === pageUrl) {
      seenSignal = call.signal;
      return gate.then(() => htmlPage(fetchHandlerHtml(directUrl)));
    }
    return okResponse();
  };

  const port = mediaStreamPort();
  port.start({ type: "start", url: directUrl, pageUrl });
  await settle();
  assert.ok(seenSignal, "graph traversal must receive a per-start AbortSignal");
  assert.equal(seenSignal.aborted, false);
  port.disconnect();
  await settle();
  assert.equal(seenSignal.aborted, true, "port disconnect must abort the active traversal");
  releaseFetch();
  await settle();
  await settle();
  assert.equal(port.messages.length, 0, "aborted start must not post stream-error or fetch-required");
});

test("a replacement media-stream start aborts the previous start and suppresses its output", async () => {
  fetchCalls.length = 0;
  const firstPage = "https://player.example/d/first";
  const secondPage = "https://player.example/d/second";
  const firstDirect = DIRECT_MP4("first");
  const secondDirect = DIRECT_MP4("second");
  let releaseFirst;
  let firstSignal = null;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  fetchHandler = (call) => {
    if (call.url === firstPage) {
      firstSignal = call.signal;
      return gate.then(() => htmlPage(fetchHandlerHtml(firstDirect)));
    }
    if (call.url === secondPage) return htmlPage(fetchHandlerHtml(secondDirect));
    return okResponse();
  };

  const port = mediaStreamPort();
  port.start({ type: "start", url: firstDirect, pageUrl: firstPage });
  await settle();
  assert.ok(firstSignal);
  const replaced = port.start({ type: "start", url: secondDirect, pageUrl: secondPage });
  await settle();
  assert.equal(firstSignal.aborted, true, "a new start must abort the previous start");
  await replaced;
  assert.equal(port.messages.length, 1, "only the replacing start may post output");
  assert.equal(port.messages[0].type, "fetch-required");
  assert.equal(port.messages[0].url, secondDirect);
  releaseFirst();
  await settle();
  await settle();
  assert.equal(port.messages.length, 1, "the aborted start must not post after it is released");
});

test("tab navigation does not globally abort in-flight graph traversal", async () => {
  fetchCalls.length = 0;
  const pageUrl = "https://player.example/d/nav";
  const directUrl = DIRECT_MP4("nav");
  let releaseFetch;
  let seenSignal = null;
  const gate = new Promise((resolve) => { releaseFetch = resolve; });
  fetchHandler = (call) => {
    if (call.url === pageUrl) {
      seenSignal = call.signal;
      return gate.then(() => htmlPage(fetchHandlerHtml(directUrl)));
    }
    return okResponse();
  };

  const port = mediaStreamPort();
  port.start({ type: "start", url: directUrl, pageUrl });
  await settle();
  assert.ok(seenSignal);
  for (const listener of tabsListeners.onUpdated) {
    listener(42, { status: "loading", url: "https://outer.example/next" });
  }
  assert.equal(seenSignal.aborted, false, "one tab's navigation must not abort another traversal");
  releaseFetch();
  await settle();
  await settle();
  assert.equal(port.messages.length, 1);
  assert.equal(port.messages[0].type, "fetch-required");
  assert.equal(port.messages[0].url, directUrl);
});

test("resource messages use the canonical current frame URL and reject invalid fallbacks", async () => {
  sessionStorage.delete("candidates");
  lastCandidatesSnapshot = null;
  const handler = runtimeListeners.onMessage[0];
  const sender = (url) => ({
    id: runtimeId,
    tab: { id: 11, url: "https://outer.example/watch", title: "Outer" },
    ...(url ? { url } : {}),
    frameId: 3,
  });
  const resource = (name, frameUrl) => ({
    type: "resource",
    resourceUrl: `https://cdn.example/${name}.mp4`,
    contentType: "video/mp4",
    pageTitle: "",
    frameUrl,
  });

  handler(resource("v1", "https://frame-b.example/player"), sender("https://frame-a.example/player"), () => {});
  handler(resource("v2", "javascript:alert(1)"), sender(), () => {});
  handler(resource("v3", "https://frame-c.example/player"), sender(), () => {});
  await delay(400);

  const snapshot = lastCandidatesSnapshot || [];
  const byUrl = new Map(snapshot.map((candidate) => [candidate.resourceUrl, candidate]));
  assert.equal(byUrl.get("https://cdn.example/v1.mp4")?.pageUrl, "https://frame-a.example/player",
    "sender.url must win over the raw message frameUrl");
  assert.equal(byUrl.get("https://cdn.example/v2.mp4")?.pageUrl, "https://outer.example/watch",
    "a non-canonical message frameUrl must be rejected and fall back to the tab URL");
  assert.equal(byUrl.get("https://cdn.example/v3.mp4")?.pageUrl, "https://frame-c.example/player",
    "a canonical message frameUrl must be accepted when sender.url is absent");
});

test("YouTube transport resources stay out of media detection candidates", async () => {
  const handler = runtimeListeners.onMessage[0];
  handler({ type: "clear-tab", tabId: 1 }, {}, () => {});

  handler({
    type: "resource",
    resourceUrl: "https://rr1---sn.example.googlevideo.com/videoplayback?id=video",
    contentType: "video/mp4",
    frameUrl: "https://www.youtube.com/watch?v=abc123",
  }, {
    id: runtimeId,
    tab: { id: 1, url: "https://www.youtube.com/watch?v=abc123", title: "YouTube title" },
    url: "https://www.youtube.com/watch?v=abc123",
    frameId: 0,
  }, () => {});

  handler({
    type: "resource",
    resourceUrl: "https://cdn.example/normal-video.mp4",
    contentType: "video/mp4",
    frameUrl: "https://outer.example/watch",
  }, {
    id: runtimeId,
    tab: { id: 1, url: "https://outer.example/watch", title: "Normal video" },
    url: "https://outer.example/watch",
    frameId: 0,
  }, () => {});

  const listed = await runtimeMessage({ type: "list-candidates" }, {});
  assert.equal(listed.response.candidates.some((candidate) => candidate.previewUrl?.includes("googlevideo.com")), false);
  assert.equal(listed.response.candidates.some((candidate) => candidate.previewUrl === "https://cdn.example/normal-video.mp4"), true);
  assert.equal(listed.response.candidates.find((candidate) => candidate.previewUrl === "https://cdn.example/normal-video.mp4")?.sourceUrl,
    "https://outer.example/watch");
});

test("license activation flips the background plan without reinstalling", async () => {
  fetchCalls.length = 0;
  runtimeMessages.length = 0;
  localStorage.delete("auraLicense");
  const packagedEdition = (await import("./edition.js")).PRODUCT_EDITION;
  fetchHandler = () => new Response(JSON.stringify({
    ok: true,
    edition: "pro",
    status: "approved",
    approvedAt: "2026-08-13T00:00:00.000Z",
  }), { status: 200, headers: { "content-type": "application/json" } });

  const before = await runtimeMessage({ type: "license-status" }, { id: runtimeId });
  assert.equal(before.keepAlive, true);
  assert.equal(before.response.ok, true);
  assert.equal(before.response.edition, packagedEdition,
    "without a stored key the packaged edition must win");

  const activated = await runtimeMessage({ type: "license-activate", key: "am-abcdef0123456789" }, { id: runtimeId });
  assert.equal(activated.keepAlive, true);
  assert.equal(activated.response.ok, true);
  assert.equal(activated.response.edition, "pro");
  assert.equal(localStorage.get("auraLicense")?.edition, "pro");

  const after = await runtimeMessage({ type: "license-status" }, { id: runtimeId });
  assert.equal(after.response.edition, "pro");
  assert.ok(runtimeMessages.some((message) => message.type === "license-changed"));
});

test("license refresh rechecks an approved key", async () => {
  fetchCalls.length = 0;
  localStorage.set("auraLicense", {
    key: "AM-ABCDEF0123456789ABCDEF0123456789",
    edition: "pro",
    status: "approved",
  });
  fetchHandler = () => new Response(JSON.stringify({ ok: true, edition: "pro", status: "approved" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const refreshed = await runtimeMessage({ type: "license-refresh" }, { id: runtimeId });
  assert.equal(refreshed.keepAlive, true);
  assert.equal(refreshed.response.ok, true);
  assert.equal(refreshed.response.edition, "pro");
});

test("youtube downloads route through the remote server when configured", async () => {
  fetchCalls.length = 0;
  localStorage.delete("auraLicense");
  localStorage.set("auraYouTubeServer", "https://server.test");
  fetchHandler = (call) => {
    if (call.url === "https://aura.mdownloader.workers.dev/api/youtube-token") {
      return new Response(JSON.stringify({
        ok: true,
        token: "tok-1",
        exp: Date.now() + 12 * 60 * 60 * 1000,
        plan: "free",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (call.url === "https://server.test/api/youtube") {
      const body = JSON.parse(String(call.options.body || "{}"));
      assert.equal(body.quality, "1080");
      return new Response(JSON.stringify({
        ok: true,
        jobId: "job-1",
        status: "queued",
        quotaUsed: 1,
        quotaLimit: 10,
        pro: false,
      }), { status: 202, headers: { "content-type": "application/json" } });
    }
    if (call.url === "https://server.test/api/youtube-formats") {
      return new Response(JSON.stringify({
        ok: true,
        qualities: [1080, 720],
        title: "Recognized Video",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (call.url === "https://server.test/api/jobs/job-1") {
      return new Response(JSON.stringify({ id: "job-1", status: "ready" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${call.url}`);
  };

  const result = await runtimeMessage(
    { type: "youtube-download", url: "https://youtube.com/watch?v=abc", quality: "1080" },
    {},
  );
  assert.equal(result.keepAlive, true);
  assert.equal(result.response.ok, true);
  // Without a stored folder handle the flow falls back to the browser download.
  assert.equal(result.response.mode, "youtube-browser");
  await delay(400);
  const stored = sessionStorage.get("downloadJobs") || [];
  const storedJob = stored.find((job) => job.source === "youtube"
    && job.status === "running" && job.title === "Recognized Video");
  assert.ok(storedJob);

  const cancelled = await runtimeMessage({ type: "cancel-download-job", jobId: storedJob.id }, { id: runtimeId });
  assert.equal(cancelled.response.ok, true);
  assert.deepEqual(cancelledDownloadIds, [1]);
  assert.equal((sessionStorage.get("downloadJobs") || []).find((job) => job.id === storedJob.id)?.status, "cancelled");

  const cleared = await runtimeMessage({ type: "clear-download-jobs", surface: "link" }, {});
  assert.equal(cleared.response.ok, true);
  assert.equal(cleared.response.cleared >= 1, true);
  assert.equal((sessionStorage.get("downloadJobs") || []).some((job) => job.id === storedJob.id), false);
});

test("youtube downloads fail with a server error when the server is unreachable", async () => {
  fetchCalls.length = 0;
  localStorage.delete("auraLicense");
  localStorage.set("auraYouTubeServer", "https://server.test");
  fetchHandler = () => { throw new Error("offline"); };

  const result = await runtimeMessage(
    { type: "youtube-download", url: "https://youtube.com/watch?v=abc", quality: "best" },
    {},
  );
  assert.equal(result.keepAlive, true);
  assert.equal(result.response.ok, false);
  assert.match(result.response.error || "", /YouTube 서버에 연결할 수 없습니다|서버 주소를 확인/);
});
