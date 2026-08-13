import test from "node:test";
import assert from "node:assert/strict";

const runtimeId = "adaptive-test-extension";
const workerUrl = `chrome-extension://${runtimeId}/download-worker.html`;
const runtimeListeners = { onMessage: [], onConnect: [] };
const webRequestListeners = { onBeforeRedirect: [] };
const sessionStorage = new Map();
let lastCandidatesSnapshot = null;
let fetchHandler = null;
const fetchCalls = [];

function event() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
    emit(value) { for (const listener of listeners) listener(value); },
  };
}

function nativePort(name) {
  const onMessage = event();
  const onDisconnect = event();
  return {
    name,
    messages: [],
    onMessage,
    onDisconnect,
    postMessage(message) {
      this.messages.push(message);
      if (name !== "com.personalvpn.media_route" || message?.type !== "ensure-routes") return;
      const hosts = [...new Set(message.urls.map((value) => new URL(value).hostname))];
      queueMicrotask(() => onMessage.emit({
        type: "ensure-routes-result",
        requestId: message.requestId,
        ok: true,
        hosts,
        expiresAtUtc: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }));
    },
    disconnect() { onDisconnect.emit(); },
  };
}

const routePort = nativePort("com.personalvpn.media_route");
const bridgePort = nativePort("com.personalvpn.bridge");

globalThis.fetch = async (input, options = {}) => {
  const call = { url: String(input), options, signal: options.signal || null };
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
    connectNative(name) {
      if (name === "com.personalvpn.media_route") return routePort;
      if (name === "com.personalvpn.bridge") return bridgePort;
      throw new Error(`unexpected native host: ${name}`);
    },
    sendMessage: async (message) => message?.type === "run-download-job" ? { ok: true } : { ok: true },
    onMessage: { addListener: (listener) => runtimeListeners.onMessage.push(listener) },
    onConnect: { addListener: (listener) => runtimeListeners.onConnect.push(listener) },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
  },
  storage: {
    session: {
      async get(defaults) {
        return Object.fromEntries(Object.entries(defaults || {}).map(([key, fallback]) => [
          key,
          sessionStorage.has(key) ? sessionStorage.get(key) : fallback,
        ]));
      },
      async set(values) {
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
    sendMessage: async () => null,
    onUpdated: { addListener() {} },
    onRemoved: { addListener() {} },
  },
  contextMenus: {
    removeAll: (callback) => callback?.(),
    create() {},
    onClicked: { addListener() {} },
  },
  offscreen: { hasDocument: async () => true, createDocument: async () => {} },
  scripting: { executeScript: async () => {} },
  action: { onClicked: { addListener() {} } },
  webRequest: {
    onSendHeaders: { addListener() {} },
    onBeforeRedirect: { addListener: (listener) => webRequestListeners.onBeforeRedirect.push(listener) },
    onBeforeRequest: { addListener() {} },
    onHeadersReceived: { addListener() {} },
  },
};

// The service worker's stale-lease sweep must not hold the Node test process.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (callback, delay, ...args) => {
  const handle = realSetInterval(callback, delay, ...args);
  handle.unref?.();
  return handle;
};

await import("./background.js");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => delay(0);
const waitUntil = async (predicate, timeoutMs = 1000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await delay(5);
  }
};
const html = (body) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
const ok = () => new Response("", { status: 200 });
const opaqueRedirect = () => ({
  ok: false,
  status: 0,
  type: "opaqueredirect",
  url: "",
  redirected: false,
  headers: { get: () => null },
  body: { cancel: async () => {} },
});

async function sendRuntimeMessage(message, sender = {}) {
  let resolveResponse;
  const response = new Promise((resolve) => { resolveResponse = resolve; });
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
    onMessage: { addListener: (listener) => { messageListener = listener; } },
    onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
    postMessage: (message) => messages.push(message),
    start(message) {
      assert.ok(messageListener, "media-stream listener must be registered");
      return messageListener(message);
    },
    disconnect() { for (const listener of disconnectListeners) listener(); },
  };
  runtimeListeners.onConnect[0](port);
  return port;
}

test("pasted player HLS stays typed and repeated requests reuse the shared resolver", async () => {
  fetchCalls.length = 0;
  const pageUrl = "https://player.example/d/hls";
  const mediaUrl = "https://cdn.example/master.m3u8";
  fetchHandler = ({ url }) => url === pageUrl ? html(`<script>file: "${mediaUrl}"</script>`) : ok();

  const first = await sendRuntimeMessage({ type: "download-url", url: pageUrl });
  assert.equal(first.keepAlive, true);
  assert.equal(first.response.ok, true);
  assert.equal(first.response.mode, "hls");
  assert.equal(fetchCalls.filter((call) => call.url === pageUrl).length, 1);

  const second = await sendRuntimeMessage({ type: "download-url", url: pageUrl });
  assert.equal(second.response.mode, "hls");
  assert.equal(fetchCalls.filter((call) => call.url === pageUrl).length, 1,
    "the module-scope resolver must reuse its positive cache");
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
    if (url === redirectedUrl) return html(`<script>file: "${mediaUrl}"</script>`);
    return ok();
  };

  const result = await sendRuntimeMessage({ type: "download-url", url: pageUrl });
  assert.equal(result.keepAlive, true);
  assert.equal(result.response.ok, true);
  assert.equal(result.response.mode, "stream");
  assert.deepEqual(fetchCalls.slice(0, 2).map(({ url }) => url), [pageUrl, redirectedUrl]);
  assert.ok(fetchCalls.slice(0, 2).every(({ options }) => options.redirect === "manual"));
});

test("port disconnect aborts player traversal and suppresses all port output", async () => {
  fetchCalls.length = 0;
  const pageUrl = "https://player.example/d/abort";
  const directUrl = "https://cdn.example/video.mp4";
  let releaseFetch;
  let traversalSignal = null;
  const gate = new Promise((resolve) => { releaseFetch = resolve; });
  fetchHandler = (call) => {
    if (call.url === pageUrl) {
      traversalSignal = call.signal;
      return gate.then(() => html(`<script>src="${directUrl}"</script>`));
    }
    return ok();
  };

  const port = mediaStreamPort();
  port.start({ type: "start", url: directUrl, pageUrl });
  await waitUntil(() => traversalSignal !== null);
  assert.equal(traversalSignal.aborted, false);
  port.disconnect();
  await waitUntil(() => traversalSignal.aborted);
  releaseFetch();
  await settle();
  await settle();
  assert.deepEqual(port.messages, []);
});

test("resource candidates prefer canonical iframe context and reject invalid fallbacks", async () => {
  lastCandidatesSnapshot = null;
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

  runtimeListeners.onMessage[0](resource("sender", "https://message.example/player"),
    sender("https://sender.example/player"), () => {});
  runtimeListeners.onMessage[0](resource("invalid", "javascript:alert(1)"), sender(), () => {});
  runtimeListeners.onMessage[0](resource("message", "https://message.example/player"), sender(), () => {});
  await delay(350);

  const byUrl = new Map((lastCandidatesSnapshot || []).map((candidate) => [candidate.resourceUrl, candidate]));
  assert.equal(byUrl.get("https://cdn.example/sender.mp4")?.pageUrl, "https://sender.example/player");
  assert.equal(byUrl.get("https://cdn.example/invalid.mp4")?.pageUrl, "https://outer.example/watch");
  assert.equal(byUrl.get("https://cdn.example/message.mp4")?.pageUrl, "https://message.example/player");
});
