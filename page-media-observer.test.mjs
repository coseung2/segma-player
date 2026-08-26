import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("./page-media-observer.js", import.meta.url), "utf8");

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createEnvironment({
  manifestText = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n",
  contentType = "application/vnd.apple.mpegurl",
  responseUrl = null,
  Hls = null,
  scripts = [],
} = {}) {
  const messages = [];
  const listeners = new Map();
  const fetchCalls = [];
  const fetchPromises = [];
  const xhrInstances = [];
  const appendCalls = [];
  const endCalls = [];
  const windowObject = {};
  const location = new URL("https://page.example/watch");

  function addEventListener(type, handler) {
    const handlers = listeners.get(type) || [];
    handlers.push(handler);
    listeners.set(type, handlers);
  }

  function dispatchMessage(data, source = windowObject) {
    for (const handler of listeners.get("message") || []) handler({ source, data });
  }

  function headersFor(type, length = "") {
    return {
      get(name) {
        if (name.toLowerCase() === "content-type") return type;
        if (name.toLowerCase() === "content-length") return length;
        return "";
      },
    };
  }

  class FakeResponse {
    constructor(text, type, url = "https://cdn.example/playlist.m3u8") {
      this.url = url;
      this.headers = headersFor(type);
      this.bodyUsed = false;
      this.textValue = text;
    }

    clone() {
      const clone = new FakeResponse(this.textValue, contentType, this.url);
      clone.headers = this.headers;
      clone.text = async () => {
        clone.bodyUsed = true;
        return clone.textValue;
      };
      return clone;
    }

    async text() {
      this.bodyUsed = true;
      return this.textValue;
    }
  }

  function originalFetch(input, init) {
    fetchCalls.push({ input, init });
    const inputUrl = typeof input === "string" ? input : input?.url;
    const resolvedUrl = responseUrl || new URL(inputUrl, location.href).href;
    const result = Promise.resolve(new FakeResponse(manifestText, contentType, resolvedUrl));
    fetchPromises.push(result);
    return result;
  }

  class FakeXMLHttpRequest {
    constructor() {
      this.responseType = "";
      this.responseText = "";
      this.responseURL = "";
      this.listeners = new Map();
      this.openReturn = { opened: true };
      this.sendReturn = { sent: true };
      xhrInstances.push(this);
    }

    open(method, url) {
      this.method = method;
      this.requestUrl = url;
      return this.openReturn;
    }

    send(body) {
      this.body = body;
      return this.sendReturn;
    }

    addEventListener(type, handler) {
      const handlers = this.listeners.get(type) || [];
      handlers.push(handler);
      this.listeners.set(type, handlers);
    }

    removeEventListener(type, handler) {
      const handlers = this.listeners.get(type) || [];
      this.listeners.set(type, handlers.filter((candidate) => candidate !== handler));
    }

    getResponseHeader(name) {
      return name.toLowerCase() === "content-type" ? contentType : "";
    }

    finish() {
      for (const handler of this.listeners.get("load") || []) handler.call(this);
    }
  }

  class FakeSourceBuffer {
    appendBuffer(value) {
      appendCalls.push(value);
      return "append-return";
    }
  }

  class FakeMediaSource {
    addSourceBuffer(type) {
      const sourceBuffer = new FakeSourceBuffer();
      sourceBuffer.createdType = type;
      return sourceBuffer;
    }

    endOfStream(error) {
      endCalls.push(error);
      return "end-return";
    }
  }

  windowObject.window = windowObject;
  windowObject.globalThis = windowObject;
  windowObject.location = location;
  windowObject.document = { scripts };
  windowObject.URL = URL;
  windowObject.ArrayBuffer = ArrayBuffer;
  windowObject.ArrayBuffer.isView = ArrayBuffer.isView;
  windowObject.Uint8Array = Uint8Array;
  windowObject.TextDecoder = TextDecoder;
  windowObject.Promise = Promise;
  windowObject.Number = Number;
  windowObject.Object = Object;
  windowObject.Function = Function;
  windowObject.WeakMap = WeakMap;
  windowObject.Set = Set;
  windowObject.Map = Map;
  windowObject.Symbol = Symbol;
  windowObject.console = console;
  windowObject.setImmediate = setImmediate;
  windowObject.addEventListener = addEventListener;
  windowObject.postMessage = (message, _targetOrigin, transfer = []) => {
    messages.push({ message, transfer });
  };
  windowObject.fetch = originalFetch;
  windowObject.XMLHttpRequest = FakeXMLHttpRequest;
  windowObject.MediaSource = FakeMediaSource;
  windowObject.SourceBuffer = FakeSourceBuffer;
  if (Hls) windowObject.Hls = Hls;

  const context = vm.createContext({
    window: windowObject,
    globalThis: windowObject,
    URL,
    ArrayBuffer,
    Uint8Array,
    TextDecoder,
    Promise,
    Number,
    Object,
    Function,
    WeakMap,
    Set,
    Map,
    Symbol,
    console,
    setImmediate,
  });
  vm.runInContext(source, context, { filename: "page-media-observer.js" });

  const protocol = windowObject.__auraMediaObserverProtocolV1;
  return {
    appendCalls,
    endCalls,
    fetchCalls,
    fetchPromises,
    originalFetch,
    messages,
    protocol,
    dispatchMessage,
    xhrInstances,
    windowObject,
    FakeMediaSource,
    FakeSourceBuffer,
  };
}

function eventMessages(env, kind) {
  return env.messages.filter(({ message }) => message.kind === kind).map(({ message }) => message);
}

test("fetch and XHR observation preserves original behavior without consuming original bodies", async () => {
  const env = createEnvironment();
  const originalFetch = env.originalFetch;
  const fetchResult = env.windowObject.fetch("/playlist.m3u8", { credentials: "include" });
  assert.equal(env.fetchCalls.length, 1);
  assert.equal(fetchResult, env.fetchPromises[0]);
  assert.equal(fetchResult instanceof Promise, true);
  const response = await fetchResult;
  assert.equal(response.bodyUsed, false);
  await flush();

  const xhr = new env.windowObject.XMLHttpRequest();
  assert.deepEqual(xhr.open("GET", "/xhr-playlist.m3u8", true), { opened: true });
  assert.deepEqual(xhr.send(null), { sent: true });
  xhr.responseURL = "https://cdn.example/xhr-playlist.m3u8";
  xhr.responseText = "#EXTM3U\n#EXTINF:4,\nsegment.ts";
  xhr.finish();

  const manifests = eventMessages(env, env.protocol.events.manifest);
  assert.equal(manifests.length, 2);
  assert.equal(manifests[0].source, "fetch");
  assert.equal(manifests[1].source, "xhr");
  assert.equal(manifests[0].contentType, "application/vnd.apple.mpegurl");
  assert.equal(manifests[1].url, "https://cdn.example/xhr-playlist.m3u8");
  assert.equal(env.windowObject.fetch.toString(), originalFetch.toString());
});

test("binary fetch responses expose media URLs without consuming their bodies", async () => {
  const env = createEnvironment({ contentType: "video/mp4" });
  const response = await env.windowObject.fetch("https://cdn.example/media/segment");
  assert.equal(response.bodyUsed, false);
  await flush();
  const [media] = eventMessages(env, env.protocol.events.media);
  assert.ok(media);
  assert.equal(media.url, "https://cdn.example/media/segment");
  assert.equal(media.contentType, "video/mp4");
});

test("JSON player APIs expose embedded stream URLs as refreshable player sources", async () => {
  const streamUrl = "https://cdn.example/hls/session/master.m3u8?token=short-lived";
  const env = createEnvironment({
    manifestText: JSON.stringify({
      filecode: "example",
      streaming_url: streamUrl,
      thumbnail: "https://cdn.example/thumb.jpg",
    }),
    contentType: "application/json",
    responseUrl: "https://player.example/api/stream",
  });
  const response = await env.windowObject.fetch("https://player.example/api/stream", {
    method: "POST",
  });
  assert.equal(response.bodyUsed, false);
  await flush();

  const sources = eventMessages(env, env.protocol.events.playerSource);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, streamUrl);
  assert.equal(sources[0].player, "api-json");
  assert.equal(sources[0].confidence, 98);
});

test("JSON player APIs accept extensionless HLS and extra stream keys", async () => {
  const streamUrl = "https://cdn.example/play/abc?type=hls&token=short-lived";
  const env = createEnvironment({
    manifestText: JSON.stringify({
      play_url: streamUrl,
      poster: "https://cdn.example/poster.jpg",
    }),
    contentType: "application/json",
    responseUrl: "https://player.example/api/play",
  });
  await env.windowObject.fetch("https://player.example/api/play");
  await flush();
  const sources = eventMessages(env, env.protocol.events.playerSource);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, streamUrl);
  assert.equal(sources[0].contentType, "application/vnd.apple.mpegurl");
  assert.equal(sources[0].player, "api-json");
});

test("manifest URLs are reported when the player hides the response type and body", async () => {
  const env = createEnvironment({ manifestText: "", contentType: "" });
  env.windowObject.fetch("https://surrit.example/stream/playlist.m3u8?token=short-lived");
  await flush();
  const [manifest] = eventMessages(env, env.protocol.events.manifest);
  assert.ok(manifest);
  assert.equal(manifest.url, "https://surrit.example/stream/playlist.m3u8?token=short-lived");
  assert.equal(manifest.contentType, "");
});

test("manifest observations stay bounded and non-manifest text is ignored", async () => {
  const huge = "#EXTM3U\n" + "x".repeat(envLimit("maxManifestTextBytes") + 50);
  const env = createEnvironment({ manifestText: huge, contentType: "text/plain" });
  env.windowObject.fetch("https://cdn.example/large.txt");
  await flush();
  const [manifest] = eventMessages(env, env.protocol.events.manifest);
  assert.ok(manifest);
  assert.equal("text" in manifest, false);
  assert.equal(manifest.truncated, true);
  assert.equal(manifest.url.length <= env.protocol.limits.maxUrlBytes, true);
  assert.equal(manifest.contentType.length <= env.protocol.limits.maxContentTypeBytes, true);

  const ignored = createEnvironment({ manifestText: "ordinary response", contentType: "text/plain" });
  ignored.windowObject.fetch("https://cdn.example/not-a-manifest.txt");
  await flush();
  assert.equal(eventMessages(ignored, ignored.protocol.events.manifest).length, 0);
});

function envLimit(name) {
  return createEnvironment().protocol.limits[name];
}

test("manifest observation leaves MediaSource and SourceBuffer methods untouched", () => {
  const env = createEnvironment();
  const originalAdd = env.FakeMediaSource.prototype.addSourceBuffer;
  const originalEnd = env.FakeMediaSource.prototype.endOfStream;
  const originalAppend = env.FakeSourceBuffer.prototype.appendBuffer;
  assert.equal(env.windowObject.MediaSource.prototype.addSourceBuffer, originalAdd);
  assert.equal(env.windowObject.MediaSource.prototype.endOfStream, originalEnd);
  assert.equal(env.windowObject.SourceBuffer.prototype.appendBuffer, originalAppend);

  const mediaSource = new env.FakeMediaSource();
  const sourceBuffer = mediaSource.addSourceBuffer("video/mp4");
  assert.equal(sourceBuffer.appendBuffer(new Uint8Array([1, 2, 3])), "append-return");
  assert.equal(mediaSource.endOfStream(), "end-return");
  assert.equal(env.appendCalls.length, 1);
  assert.equal(env.endCalls.length, 1);
  assert.deepEqual(env.messages.filter(({ message }) => message.kind !== "manifest"), []);
});

test("hls.js adapter reports the loadSource manifest and serves bounded refresh snapshots", () => {
  class FakeHls {
    loadSource(url) {
      this.url = url;
      return "loaded";
    }

    startLoad() {
      return "started";
    }
  }

  const env = createEnvironment({ Hls: FakeHls });
  const hls = new env.windowObject.Hls();
  const manifestUrl = "https://surrit.com/hls/simd-012/master.m3u8?token=fresh";
  assert.equal(hls.loadSource(manifestUrl), "loaded");

  const sources = eventMessages(env, env.protocol.events.playerSource);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, manifestUrl);
  assert.equal(sources[0].player, "hls.js");
  assert.match(sources[0].sessionId, /^hls\.js:/);
  assert.equal(sources[0].confidence, 100);

  env.dispatchMessage({
    type: "aura-media-observer-snapshot-request-v1",
    requestId: "refresh-request-0001",
    resourceUrl: manifestUrl,
    player: "hls.js",
    sessionId: sources[0].sessionId,
  });

  const snapshots = eventMessages(env, env.protocol.events.playerSource)
    .filter((message) => message.requestId === "refresh-request-0001");
  const completed = eventMessages(env, env.protocol.events.snapshotComplete)
    .find((message) => message.requestId === "refresh-request-0001");
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].snapshot, true);
  assert.equal(completed?.count, 1);
});

test("reports the inline Level5 HLS source before the player exposes its session", () => {
  const env = createEnvironment({
    scripts: [{
      textContent: String.raw`(async () => {
        await window.Level5Player.play({
          video,
          url: "https:\/\/k.vdnext.com\/cast2\/id\/v.html?tok=secret&exp=123",
        });
      })();`,
    }],
  });
  const [sourceMessage] = eventMessages(env, env.protocol.events.playerSource);
  assert.ok(sourceMessage);
  assert.equal(sourceMessage.url, "https://k.vdnext.com/cast2/id/v.html?tok=secret&exp=123");
  assert.equal(sourceMessage.contentType, "application/vnd.apple.mpegurl");
  assert.equal(sourceMessage.player, "level5");
  assert.equal(sourceMessage.confidence, 100);
});

test("the observer does not replace JSON or Array prototype behavior and avoids forbidden capabilities", () => {
  const originalParse = JSON.parse;
  const originalPush = Array.prototype.push;
  vm.runInNewContext(source, { window: {}, globalThis: {} });
  assert.equal(JSON.parse, originalParse);
  assert.equal(Array.prototype.push, originalPush);
  assert.equal(/\beval\s*\(/.test(source), false);
  assert.equal(/\bJSON\.parse\b/.test(source), false);
  assert.equal(/\b(?:localStorage|sessionStorage|indexedDB)\b/.test(source), false);
  assert.equal(/\.(?:play|pause|seekTo|currentTime)\s*\(/.test(source), false);
  assert.equal(/\b(?:import|export)\s/.test(source), false);
});
