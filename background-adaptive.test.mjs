import test from "node:test";
import assert from "node:assert/strict";

// Behavioral integration harness for the background service worker. The
// worker's module scope binds Chrome APIs and resolvers at import time, so
// mocks are installed before the dynamic import and the tests drive the
// actual registered listeners. Evidence is behavior-level: response payloads,
// fetch counts/signals, storage snapshots, and port messages.

const runtimeId = "test-extension-id";
const workerUrl = `chrome-extension://${runtimeId}/download-worker.html`;
const popupSender = { id: runtimeId, url: `chrome-extension://${runtimeId}/popup.html` };
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
let tabsSendHandler = null;
let fetchHandler = null;
let nativeConnectHandler = null;
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
    connectNative: (...args) => {
      if (!nativeConnectHandler) throw new Error("unexpected native connection");
      return nativeConnectHandler(...args);
    },
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
    sendMessage: async (...args) => tabsSendHandler ? tabsSendHandler(...args) : tabsSendResponse,
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

function nativeCompanionPort(responder) {
  const messageListeners = [];
  const disconnectListeners = [];
  let disconnected = false;
  return {
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    postMessage(message) {
      queueMicrotask(() => {
        if (disconnected) return;
        const response = responder(message);
        for (const listener of messageListeners) {
          listener({ ...response, requestId: message.requestId });
        }
      });
    },
    disconnect() {
      if (disconnected) return;
      disconnected = true;
      for (const listener of disconnectListeners) listener();
    },
  };
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

test.skip("legacy pasted-link execution test: resolution now hands off to Companion", async () => {
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

test.skip("legacy opaque-redirect execution test: Companion now owns transfer", async () => {
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

test.skip("legacy media-stream port is removed from the thin extension", async () => {
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

test.skip("legacy media-stream Dood priority path is removed", async () => {
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
    { id: runtimeId, tab: { id: 7 }, frameId: 3 },
    () => {},
  );
  const cachedPort = mediaStreamPort();
  await cachedPort.start({
    type: "start",
    url: "https://doodcdn.example/stale.mp4",
    pageUrl,
    videoTabId: 7,
    videoFrameId: 3,
  });
  assert.equal(cachedPort.messages.length, 1);
  assert.equal(cachedPort.messages[0].type, "fetch-required");
  assert.equal(cachedPort.messages[0].url, "https://doodcdn.example/cached.mp4");
  assert.equal(cachedPort.messages[0].referrer, "https://player.example/e/cached");
  assert.equal(graphFetches, 0, "the same-frame Dood cache must win over the static graph fallback");
});

test.skip("legacy media-stream Dood rebind path is removed", async () => {
  const handler = runtimeListeners.onMessage[0];
  handler({ type: "frame-media-state", playing: false, visibleArea: 10, observedAt: Date.now() },
    { id: runtimeId, tab: { id: 19 }, frameId: 3 }, () => {});
  handler({ type: "frame-media-state", playing: true, visibleArea: 500_000, observedAt: Date.now() },
    { id: runtimeId, tab: { id: 19 }, frameId: 8 }, () => {});
  tabsSendHandler = async (_tabId, message, options) => {
    if (message.type !== "get-dood-direct" || options?.frameId !== 8) return null;
    return { ok: true, url: "https://doodcdn.example/current/token.mp4", frameUrl: "https://player.example/e/current" };
  };
  fetchHandler = () => okResponse();
  const port = mediaStreamPort();
  await port.start({
    type: "start",
    url: "https://doodcdn.example/stale/token.mp4",
    pageUrl: "https://playmogo.com/d/replaced-frame",
    videoTabId: 19,
    videoFrameId: 3,
  });
  assert.equal(port.messages[0].url, "https://doodcdn.example/current/token.mp4");
  assert.equal(port.messages[0].referrer, "https://player.example/e/current");
  assert.equal(port.messages[0].videoFrameId, 8);
  tabsSendHandler = null;
});

test.skip("legacy source-frame Chrome download is removed", async () => {
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

test.skip("legacy media-stream port disconnect path is removed", async () => {
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

test.skip("legacy replacement media-stream path is removed", async () => {
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

test.skip("legacy media-stream navigation path is removed", async () => {
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

  const listed = await runtimeMessage({ type: "list-candidates" }, popupSender);
  assert.equal(listed.response.candidates.some((candidate) => candidate.previewUrl?.includes("googlevideo.com")), false);
  assert.equal(listed.response.candidates.some((candidate) => candidate.previewUrl === "https://cdn.example/normal-video.mp4"), true);
  assert.equal(listed.response.candidates.find((candidate) => candidate.previewUrl === "https://cdn.example/normal-video.mp4")?.sourceUrl,
    "https://outer.example/watch");
});

test("trusted popup tooling can inspect an explicit target tab without making it active", async () => {
  const handler = runtimeListeners.onMessage[0];
  handler({ type: "clear-tab", tabId: 2 }, {}, () => {});
  handler({
    type: "resource",
    resourceUrl: "https://cdn.example/tab-two.mp4",
    contentType: "video/mp4",
    frameUrl: "https://two.example/watch",
  }, {
    id: runtimeId,
    tab: { id: 2, url: "https://two.example/watch", title: "Tab two" },
    url: "https://two.example/watch",
    frameId: 0,
  }, () => {});

  const listed = await runtimeMessage({ type: "list-candidates", tabId: 2 }, popupSender);
  assert.equal(listed.response.type, "candidates");
  assert.equal(listed.response.candidates.length, 1);
  assert.equal(listed.response.candidates[0].tabId, 2);
  assert.equal(listed.response.candidates[0].previewUrl, "https://cdn.example/tab-two.mp4");
});

test.skip("legacy browser playback sessions are no longer part of the extension", async () => {
  const handler = runtimeListeners.onMessage[0];
  handler({ type: "clear-tab", tabId: 1 }, {}, () => {});
  const tokenUrl = "https://cdn.example/master.m3u8?token=opaque-value";
  handler({
    type: "resource",
    resourceUrl: tokenUrl,
    contentType: "application/vnd.apple.mpegurl",
    frameUrl: "https://player.example/embed/1",
    detectionSource: "player-adapter",
    player: "hls.js",
    sessionId: "hls.js:1",
    confidence: 100,
  }, {
    id: runtimeId,
    tab: { id: 1, url: "https://outer.example/watch", title: "Video" },
    url: "https://player.example/embed/1",
    frameId: 4,
  }, () => {});

  const listed = await runtimeMessage({ type: "list-candidates" }, popupSender);
  const candidate = listed.response.candidates.find((item) =>
    item.mediaType?.startsWith("HLS") && item.player === "hls.js");
  assert.ok(candidate);
  assert.equal(candidate.previewUrl, null, "tokenized streams must not issue popup preview requests");

  const created = await runtimeMessage({
    type: "create-playback-session",
    candidateId: candidate.id,
    sourceUrl: "https://outer.example/watch",
  }, {
    id: runtimeId,
    url: `chrome-extension://${runtimeId}/popup-play.html`,
  });
  assert.equal(created.response.ok, true);
  assert.equal("resourceUrl" in created.response, false, "launcher response must not expose the token URL");
  const sessionId = created.response.sessionId;

  const wrongPlayer = await runtimeMessage({
    type: "resolve-playback-session",
    sessionId,
  }, {
    id: runtimeId,
    tab: { id: 91 },
    url: `chrome-extension://${runtimeId}/player.html?session=another-session-id`,
  });
  assert.equal(wrongPlayer.keepAlive, false);

  const playerSender = {
    id: runtimeId,
    tab: { id: 91 },
    url: `chrome-extension://${runtimeId}/player.html?session=${sessionId}`,
  };
  const resolved = await runtimeMessage({
    type: "resolve-playback-session",
    sessionId,
  }, playerSender);
  assert.equal(resolved.response.ok, true);
  assert.equal(resolved.response.session.resourceUrl, tokenUrl);
  assert.equal(resolved.response.session.referrer, "https://player.example/embed/1");

  const lease = await runtimeMessage({
    type: "prepare-media-fetch",
    url: tokenUrl,
    referrer: "https://player.example/embed/1",
    sourceContext: { tabId: 1, frameId: 4, initiator: "https://player.example/embed/1" },
  }, playerSender);
  assert.equal(lease.response.ok, true);
  const released = await runtimeMessage({
    type: "release-media-fetch",
    leaseId: lease.response.leaseId,
  }, playerSender);
  assert.equal(released.response.ok, true);
});

test.skip("license activation moved to Segma Player", async () => {
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

test.skip("license refresh moved to Segma Player", async () => {
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

test.skip("legacy remote YouTube server path moved to Companion", async () => {
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

test.skip("legacy remote YouTube server failure path moved to Companion", async () => {
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

test("Blogger googlevideo media remains detectable when embedded by Gogoanime", async () => {
  const handler = runtimeListeners.onMessage[0];
  handler({ type: "clear-tab", tabId: 1 }, popupSender, () => {});
  let exactHeading = "Futsutsuka na Akujo dewa Gozaimasu ga: Suuguu Chouso Torikae Den Episode 8 English Subbed";
  let titleSelectorRequests = 0;
  tabsSendHandler = async (_tabId, message, options) => {
    if (message?.type === "set-title-selectors") {
      assert.deepEqual(options, { frameId: 0 });
      titleSelectorRequests += 1;
      return { ok: true, pageTitle: exactHeading };
    }
    return null;
  };

  handler({
    type: "resource",
    resourceUrl: "https://rr4---sn-npoe7nl6.googlevideo.com/videoplayback?id=blogger-video",
    contentType: "video/mp4",
    main: true,
    frameUrl: "https://gogoanime.by/player/?source=blogger&url=encoded",
  }, {
    id: runtimeId,
    tab: {
      id: 1,
      url: "https://gogoanime.by/futsutsuka-na-akujo-dewa-gozaimasu-ga-suuguu-chouso-torikae-den-episode-8-english-subbed/",
      title: "Futsutsuka na Akujo dewa Gozaimasu ga: Suuguu Chouso Torikae Den Episode 8 English Subbed - Gogoanime",
    },
    url: "https://gogoanime.by/player/?source=blogger&url=encoded",
    frameId: 228,
  }, () => {});

  await settle();

  const listed = await runtimeMessage({ type: "list-candidates" }, popupSender);
  assert.equal(listed.response.candidates.length, 1);
  assert.equal(listed.response.candidates[0].siteId, "gogoanime");
  assert.equal(listed.response.candidates[0].mediaType, "PROGRESSIVE");
  assert.equal(listed.response.candidates[0].pageTitle, exactHeading);
  assert.equal(listed.response.candidates[0].sourceUrl,
    "https://gogoanime.by/player/?source=blogger&url=encoded");

  handler({ type: "clear-tab", tabId: 1 }, popupSender, () => {});
  exactHeading = "Bleach: Sennen Kessen-hen - Kashin-tan Episode 4 English Subbed";
  handler({
    type: "resource",
    resourceUrl: "https://rr4---sn-npoe7nl6.googlevideo.com/videoplayback?id=blogger-video-next",
    contentType: "video/mp4",
    main: true,
    frameUrl: "https://gogoanime.by/player/?source=blogger&url=next",
  }, {
    id: runtimeId,
    tab: {
      id: 1,
      url: "https://gogoanime.by/bleach-sennen-kessen-hen-kashin-tan-episode-4-english-subbed/",
      title: "Bleach: Sennen Kessen-hen - Kashin-tan Episode 4 English Subbed - Gogoanime",
    },
    url: "https://gogoanime.by/player/?source=blogger&url=next",
    frameId: 229,
  }, () => {});

  await settle();

  const rescanned = await runtimeMessage({ type: "list-candidates" }, popupSender);
  assert.equal(rescanned.response.candidates.length, 1);
  assert.equal(rescanned.response.candidates[0].pageTitle, exactHeading,
    "explicit rescan must not reuse the previous page's resolved heading");
  assert.equal(titleSelectorRequests, 2,
    "explicit rescan must request the current page heading again");
  tabsSendHandler = null;
});

test.skip("legacy extension subtitle handoff is now Companion-only outside the extension", async () => {
  localStorage.delete("auraLicense");
  runtimeMessages.length = 0;
  fetchCalls.length = 0;
  fetchHandler = (call) => { throw new Error(`unexpected fetch: ${call.url}`); };
  const nativeMessages = [];
  const jobId = "subtitle-native-1";
  const port = nativeCompanionPort((message) => {
    nativeMessages.push(message);
    if (message.type === "hello") return { ok: true, protocol: 2 };
    if (message.type === "status") {
      return { ok: true, protocol: 2, entitlementOwner: "companion", licenseConfigured: true };
    }
    if (message.type === "subtitle.create") {
      assert.match(message.candidateId, /^subtitle-[A-Za-z0-9-]+$/);
      assert.equal(message.sourceLanguage, "ja");
      assert.equal(message.targetLanguage, "ko");
      assert.deepEqual(message.media, {
        type: "hls",
        title: "Companion subtitle test",
        pageUrl: "https://page.example/watch/1",
        resourceUrl: "https://media.example/master.m3u8",
        audioRenditionUrl: "",
      });
      assert.equal(JSON.stringify(message).includes("licenseKey"), false);
      return { ok: true, accepted: true, jobId, status: "preparing" };
    }
    if (message.type === "list-jobs") {
      return {
        ok: true,
        jobs: [{
          jobId,
          jobType: "subtitle",
          status: "running",
          statusText: "Subtitle generation is running.",
          title: "Companion subtitle test",
          updatedAt: Date.now(),
        }],
      };
    }
    if (message.type === "cancel-job") return { ok: true, cancelled: true, jobId };
    throw new Error(`unexpected native message: ${message.type}`);
  });
  nativeConnectHandler = (host) => {
    assert.equal(host, "com.aura.media_companion");
    return port;
  };

  try {
    const result = await runtimeMessage({
      type: "start-subtitle-generation",
      input: {
        mediaUrl: "https://media.example/master.m3u8",
        sourceUrl: "https://page.example/watch/1",
        title: "Companion subtitle test",
        sourceLanguage: "ja",
        mediaType: "HLS_MASTER",
        sourceTabId: 71,
        sourceFrameId: 4,
      },
    }, {
      id: runtimeId,
      tab: { id: 71 },
      url: `chrome-extension://${runtimeId}/player.html?session=subtitle-test`,
    });
    assert.equal(result.keepAlive, true);
    assert.deepEqual(result.response, { ok: true, jobId, mode: "subtitle-companion" });
    await settle();
    await settle();

    const stored = (sessionStorage.get("downloadJobs") || []).find((job) => job.id === jobId);
    assert.equal(stored?.source, "companion");
    assert.equal(stored?.mediaType, "SUBTITLE");
    assert.equal(stored?.folderName, "Downloads\\Aura Media\\Subtitles");
    assert.equal(runtimeMessages.some((message) => message.type === "run-subtitle-job"), false);
    assert.equal(nativeMessages.some((message) => message.type === "subtitle.create"), true);

    const cancelled = await runtimeMessage({ type: "cancel-download-job", jobId }, { id: runtimeId });
    assert.equal(cancelled.response.ok, true);
    assert.equal(nativeMessages.some((message) => message.type === "cancel-job" && message.jobId === jobId), true);
    assert.equal((sessionStorage.get("downloadJobs") || []).find((job) => job.id === jobId)?.status, "cancelled");
  } finally {
    nativeConnectHandler = null;
    port.disconnect();
  }
});

test.skip("legacy extension subtitle failure fallback is removed", async () => {
  localStorage.delete("auraLicense");
  runtimeMessages.length = 0;
  fetchCalls.length = 0;
  fetchHandler = (call) => { throw new Error(`unexpected fetch: ${call.url}`); };
  const nativeMessages = [];
  const port = nativeCompanionPort((message) => {
    nativeMessages.push(message);
    if (message.type === "hello") return { ok: true, protocol: 2 };
    if (message.type === "status") {
      return { ok: true, protocol: 2, entitlementOwner: "companion", licenseConfigured: true };
    }
    if (message.type === "subtitle.create") {
      return { ok: false, errorCode: "subtitle-job-start-failed", error: "Companion start failed." };
    }
    throw new Error(`unexpected native message: ${message.type}`);
  });
  nativeConnectHandler = () => port;

  try {
    const result = await runtimeMessage({
      type: "start-subtitle-generation",
      input: {
        mediaUrl: "https://media.example/video.mp4",
        sourceUrl: "https://page.example/watch/2",
        title: "Companion failure test",
        sourceLanguage: "en",
        mediaType: "PROGRESSIVE",
      },
    }, {
      id: runtimeId,
      tab: { id: 72 },
      url: `chrome-extension://${runtimeId}/player.html?session=subtitle-failure-test`,
    });
    assert.equal(result.response.ok, false);
    assert.equal(result.response.error, "Companion start failed.");
    assert.equal(nativeMessages.some((message) => message.type === "subtitle.create"), true);
    assert.equal(runtimeMessages.some((message) => message.type === "run-subtitle-job"), false);
    assert.equal(fetchCalls.length, 0);
  } finally {
    nativeConnectHandler = null;
    port.disconnect();
  }
});

test.skip("legacy extension subtitle migration fallback is removed", async () => {
  const licenseKey = "AM-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  localStorage.set("auraLicense", { key: licenseKey, edition: "pro", status: "approved" });
  runtimeMessages.length = 0;
  fetchCalls.length = 0;
  fetchHandler = (call) => {
    assert.match(call.url, /^https:\/\/aura\.mdownloader\.workers\.dev\/api\/license\?/);
    return new Response(JSON.stringify({ ok: true, edition: "pro", status: "approved" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const nativeMessages = [];
  const port = nativeCompanionPort((message) => {
    nativeMessages.push(message);
    if (message.type === "hello") return { ok: true, protocol: 2 };
    if (message.type === "status") {
      return { ok: true, protocol: 2, entitlementOwner: "companion", licenseConfigured: false };
    }
    throw new Error(`unexpected native message: ${message.type}`);
  });
  nativeConnectHandler = () => port;

  try {
    const result = await runtimeMessage({
      type: "start-subtitle-generation",
      input: {
        mediaUrl: "https://media.example/video.mp4",
        sourceUrl: "https://page.example/watch/3",
        title: "Extension fallback test",
        sourceLanguage: "ja",
        mediaType: "PROGRESSIVE",
      },
    }, {
      id: runtimeId,
      tab: { id: 73 },
      url: `chrome-extension://${runtimeId}/player.html?session=subtitle-fallback-test`,
    });
    assert.equal(result.response.ok, true);
    assert.equal(typeof result.response.jobId, "string");
    assert.equal(result.response.mode, undefined);
    assert.equal(nativeMessages.some((message) => message.type === "subtitle.create"), false);
    const legacyCommand = runtimeMessages.find((message) => message.type === "run-subtitle-job");
    assert.equal(legacyCommand?.licenseKey, licenseKey);

    const cancelled = await runtimeMessage({
      type: "cancel-download-job",
      jobId: result.response.jobId,
    }, { id: runtimeId });
    assert.equal(cancelled.response.ok, true);
  } finally {
    nativeConnectHandler = null;
    port.disconnect();
  }
});
