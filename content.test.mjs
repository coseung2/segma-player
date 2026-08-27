import test from "node:test";
import assert from "node:assert/strict";

let moduleCounter = 0;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countResource(sent, url) {
  return sent.filter((message) => message.type === "resource" && message.resourceUrl === url).length;
}

function mediaElement({ url, type = "video/mp4", paused = false, rect = { width: 640, height: 360 } }) {
  return Object.assign(new (globalThis.Element)(), {
    currentSrc: url,
    src: "",
    tagName: "VIDEO",
    type,
    paused,
    getBoundingClientRect: () => rect,
  });
}

function iframeElement(src, extras = {}) {
  return Object.assign(new (globalThis.Element)(), {
    src,
    getBoundingClientRect: () => ({ width: 800, height: 450 }),
    ...extras,
  });
}

function mediaNode(tagName, attributes = {}) {
  const node = Object.assign(new (globalThis.Element)(tagName), {
    currentSrc: attributes.currentSrc || '',
    src: attributes.src || '',
    type: attributes.type || '',
    paused: attributes.paused ?? true,
    muted: Boolean(attributes.muted),
    duration: attributes.duration || 0,
    getBoundingClientRect: () => attributes.rect || { width: 640, height: 360 },
  });
  for (const [name, value] of Object.entries(attributes.attrs || {})) {
    node.setAttribute(name, value);
  }
  return node;
}

function baseEnvironment({
  locationHref = "https://page.example/watch",
  doodHtml = "",
  withPerformanceObserver = false,
  runtimeHandler = null,
} = {}) {
  const sent = [];
  const posted = [];
  const resourceEntries = [];
  const videos = [];
  const scripts = [];
  const iframes = [];
  const jsonLdScripts = [];
  const metas = [];
  const attrMediaNodes = [];
  const eventHandlers = {};
  const windowEventHandlers = {};
  const mutationObservers = [];
  const performanceObservers = [];
  const documentHtml = { text: doodHtml, reads: 0 };
  const elementsById = new Map();
  let getEntriesCalls = 0;
  let onMessage = null;

  delete globalThis.__auraMediaDetectorInstalledV3;
  delete globalThis.__auraMediaDetectorInstalledV4;
  delete globalThis.__personalVpnMediaDetectorInstalledV3;
  class MockShadowRoot {
    constructor(host) {
      this.host = host;
      this.children = [];
    }

    replaceChildren(...children) {
      this.children = [...children];
    }

    append(...children) {
      this.children.push(...children);
    }
  }
  globalThis.Element = class MockElement {
    constructor(tagName = "DIV") {
      this.tagName = String(tagName).toUpperCase();
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.style = {
        setProperty(name, value) {
          this[name] = value;
        },
      };
      this.shadowRoot = null;
      this.eventHandlers = {};
      this.id = "";
      this.textContent = "";
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }

    getAttribute(name) {
      return this.attributes[name] ?? null;
    }

    append(...children) {
      this.children.push(...children);
      for (const child of children) {
        if (child?.id) elementsById.set(child.id, child);
      }
    }

    replaceChildren(...children) {
      this.children = [...children];
    }

    addEventListener(name, handler) {
      this.eventHandlers[name] = handler;
    }

    attachShadow() {
      this.shadowRoot = new MockShadowRoot(this);
      return this.shadowRoot;
    }

    remove() {
      if (this.id) elementsById.delete(this.id);
      this.removed = true;
    }
  };
  globalThis.window = globalThis;
  globalThis.top = globalThis;
  globalThis.addEventListener = (name, handler) => {
    const handlers = windowEventHandlers[name] || [];
    handlers.push(handler);
    windowEventHandlers[name] = handlers;
  };
  globalThis.removeEventListener = (name, handler) => {
    windowEventHandlers[name] = (windowEventHandlers[name] || []).filter((item) => item !== handler);
  };
  globalThis.postMessage = (message) => { posted.push(message); };
  globalThis.location = new URL(locationHref);
  globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });
  globalThis.performance = {
    getEntriesByType(type) {
      if (type === "resource") {
        getEntriesCalls += 1;
        return [...resourceEntries];
      }
      return [];
    },
  };
  const documentElement = new globalThis.Element("HTML");
  Object.defineProperty(documentElement, "outerHTML", {
    get() {
      documentHtml.reads += 1;
      return documentHtml.text;
    },
  });
  function doodSourceNodes() {
    documentHtml.reads += 1;
    const nodes = [...scripts];
    for (const match of documentHtml.text.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const src = /\bsrc=["']([^"']+)["']/i.exec(match[1])?.[1] || "";
      nodes.push({
        tagName: "SCRIPT",
        textContent: match[2],
        src,
        getAttribute: (name) => name === "src" ? src : null,
      });
    }
    for (const match of documentHtml.text.matchAll(/<a[^>]*\bhref=["']([^"']*\/pass_md5\/[^"']+)["'][^>]*>/gi)) {
      const href = match[1];
      nodes.push({
        tagName: "A",
        href: new URL(href, location.href).href,
        getAttribute: (name) => name === "href" ? href : null,
      });
    }
    return nodes;
  }
  globalThis.document = {
    title: "Test video",
    documentElement,
    createElement(tagName) {
      return new globalThis.Element(tagName);
    },
    getElementById(id) {
      return elementsById.get(id) || null;
    },
    querySelectorAll(selector) {
      if (selector === "video, audio, source") return [...videos];
      if (selector === "iframe") return [...iframes];
      if (selector === "script") return [...scripts];
      if (selector === 'script[type="application/ld+json"]') return [...jsonLdScripts];
      if (selector === 'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]') return [...metas];
      if (selector === "video, audio, source, [data-src], [data-file], [data-url], [data-video], [data-stream], [data-hls]") {
        return [...videos, ...attrMediaNodes];
      }
      if (selector === "iframe[srcdoc], iframe[src^='about:blank']" || selector === "iframe[srcdoc]") {
        return iframes.filter((frame) => frame.getAttribute?.("srcdoc") || String(frame.src || "").startsWith("about:blank"));
      }
      if (selector === "*") return [...videos, ...iframes, ...attrMediaNodes];
      if (selector === 'script, a[href*="/pass_md5/"]') return doodSourceNodes();
      return [];
    },
    addEventListener(name, handler) {
      eventHandlers[name] = handler;
    },
  };
  globalThis.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
      mutationObservers.push(this);
    }
    observe() {}
  };
  globalThis.PerformanceObserver = withPerformanceObserver
    ? class {
      constructor(callback) {
        this.callback = callback;
        performanceObservers.push(this);
      }
      observe(options) {
        this.options = options;
      }
    }
    : undefined;
  globalThis.chrome = {
    runtime: {
      sendMessage(message) {
        sent.push(message);
        return Promise.resolve(typeof runtimeHandler === "function" ? runtimeHandler(message) : undefined);
      },
      onMessage: {
        addListener(handler) {
          onMessage = handler;
        },
      },
    },
  };

  return {
    sent,
    posted,
    resourceEntries,
    videos,
    scripts,
    iframes,
    jsonLdScripts,
    metas,
    attrMediaNodes,
    eventHandlers,
    windowEventHandlers,
    mutationObservers,
    performanceObservers,
    documentHtml,
    get overlayHost() {
      return elementsById.get("aura-media-progress-host") || null;
    },
    get countScans() {
      return getEntriesCalls;
    },
    get onMessage() {
      return onMessage;
    },
  };
}

async function importFreshContent() {
  moduleCounter += 1;
  await import(`./content.js?test=${moduleCounter}`);
}

test("scans a visible playing media element without a runtime error", async () => {
  const env = baseEnvironment();
  env.videos.push(
    mediaElement({ url: "https://media.example/stream-token" }),
    mediaElement({ url: "https://cdn.example/cast/preview.gif", rect: { width: 900, height: 500 } }),
  );
  env.scripts.push({
    textContent: "const flashvars = { video_url: 'aHR0cHM6Ly9hc2lhbnBvcm4ubGkvZ2V0X2ZpbGUvMTEvYWJjLzI3NDg2OS5tcDQvP2JyPTE3NjQ=' };",
  });

  await import(`./content.js?test=${++moduleCounter}`);
  await delay(180);

  const media = env.sent.find((message) => message.type === "resource"
    && message.resourceUrl === "https://media.example/stream-token");
  assert.equal(media?.main, true);
  assert.equal(media?.fromMediaElement, true);
  assert.equal(media?.frameUrl, "https://page.example/watch");
  assert.equal(env.sent.some((message) => message.resourceUrl?.endsWith("preview.gif")), false);
  const configured = env.sent.find((message) => message.resourceUrl
    === "https://asianporn.li/get_file/11/abc/274869.mp4/?br=1764");
  assert.equal(configured?.main, true);
  assert.equal(configured?.fromMediaElement, true);
  assert.equal(configured?.frameUrl, "https://page.example/watch");
});

test("blob media sources are never selected as main", async () => {
  const env = baseEnvironment();
  env.videos.push(
    mediaElement({ url: "blob:https://page.example/hls-stream", paused: false, rect: { width: 1280, height: 720 } }),
    mediaElement({ url: "https://media.example/real-stream", paused: false }),
  );

  await import(`./content.js?test=${++moduleCounter}`);
  await delay(180);

  assert.equal(env.sent.some((message) => message.type === "resource" && message.main === true), false);
  assert.equal(countResource(env.sent, "blob:https://page.example/hls-stream"), 1);
  assert.equal(countResource(env.sent, "https://media.example/real-stream"), 1);
});

test("a mutation burst and media events coalesce into one delayed scan", async () => {
  const env = baseEnvironment();
  await import(`./content.js?test=${++moduleCounter}`);
  await delay(180);

  const scansBefore = env.countScans;
  env.scripts.push({ textContent: "const unrelated = 1;" });
  for (let i = 0; i < 5; i += 1) {
    await delay(0);
    env.mutationObservers[0].callback([{ type: "childList", addedNodes: [{ tagName: "SCRIPT" }], removedNodes: [] }]);
  }
  env.eventHandlers.playing();
  await delay(0);
  assert.equal(env.countScans, scansBefore, "scan must wait for the debounce window to elapse");
  await delay(180);
  assert.equal(env.countScans, scansBefore + 1, "one burst must produce exactly one scan");
});

test("historical performance entries are not reread and inserted scripts are still detected", async () => {
  const env = baseEnvironment();
  env.resourceEntries.push(
    { name: "https://cdn.example/video1.mp4" },
    { name: "https://cdn.example/video2.mp4" },
  );
  await import(`./content.js?test=${++moduleCounter}`);
  await delay(180);

  assert.equal(countResource(env.sent, "https://cdn.example/video1.mp4"), 1);
  assert.equal(countResource(env.sent, "https://cdn.example/video2.mp4"), 1);

  env.scripts.push({
    textContent: "var cfg = { video_url: 'aHR0cHM6Ly9hc2lhbnBvcm4ubGkvZ2V0X2ZpbGUvMTEvYWJjLzI3NDg2OS5tcDQvP2JyPTE3NjQ=' };",
  });
  env.mutationObservers[0].callback([{ type: "childList", addedNodes: [{ tagName: "SCRIPT" }], removedNodes: [] }]);
  await delay(180);

  assert.equal(countResource(env.sent, "https://cdn.example/video1.mp4"), 1, "history must not be reread");
  assert.equal(countResource(env.sent, "https://cdn.example/video2.mp4"), 1, "history must not be reread");
  assert.equal(countResource(env.sent, "https://asianporn.li/get_file/11/abc/274869.mp4/?br=1764"), 1);
});

test("nested script insertion and script text changes invalidate cached player clues", async () => {
  const env = baseEnvironment();
  await import(`./content.js?test=${++moduleCounter}`);

  const first = {
    textContent: "const cfg = { video_url: 'aHR0cHM6Ly9jZG4uZXhhbXBsZS9maXJzdC5tcDQ=' };",
  };
  env.scripts.push(first);
  env.mutationObservers[0].callback([{
    type: "childList",
    target: { tagName: "DIV" },
    addedNodes: [{ tagName: "SECTION", querySelector: (selector) => selector === "script" ? first : null }],
    removedNodes: [],
  }]);
  await delay(180);
  assert.equal(countResource(env.sent, "https://cdn.example/first.mp4"), 1);

  first.textContent = "const cfg = { video_url: 'aHR0cHM6Ly9jZG4uZXhhbXBsZS9zZWNvbmQubXA0' };";
  env.mutationObservers[0].callback([{
    type: "characterData",
    target: { parentElement: { tagName: "SCRIPT" } },
  }]);
  await delay(180);
  assert.equal(countResource(env.sent, "https://cdn.example/second.mp4"), 1);
});

test("harvests pre-playback config from data attributes, JSON-LD, and og:video", async () => {
  const env = baseEnvironment();
  env.attrMediaNodes.push(mediaNode("DIV", {
    attrs: { "data-src": "https://cdn.example/preplay/stream?type=hls&token=1" },
  }));
  env.attrMediaNodes.push(mediaNode("DIV", {
    attrs: { "data-url": "https://cdn.example/preplay/manifest?type=dash&token=2" },
  }));
  env.jsonLdScripts.push({
    textContent: JSON.stringify({
      "@type": "VideoObject",
      contentUrl: "https://cdn.example/jsonld/clip.mp4",
    }),
  });
  env.metas.push({
    getAttribute: (name) => name === "content" ? "https://cdn.example/og/stream.m3u8" : null,
  });
  env.scripts.push({
    textContent: 'player.setup({ play_url: "https://cdn.example/script/playlist.m3u8?type=hls" });',
  });
  await import(`./content.js?test=${++moduleCounter}`);
  await delay(180);
  const inlineHls = env.sent.find((message) => message.resourceUrl
    === "https://cdn.example/preplay/stream?type=hls&token=1");
  const inlineDash = env.sent.find((message) => message.resourceUrl
    === "https://cdn.example/preplay/manifest?type=dash&token=2");
  assert.equal(inlineHls?.contentType, "application/vnd.apple.mpegurl");
  assert.equal(inlineDash?.contentType, "application/dash+xml");
  assert.equal(countResource(env.sent, "https://cdn.example/jsonld/clip.mp4"), 1);
  assert.equal(countResource(env.sent, "https://cdn.example/og/stream.m3u8"), 1);
  assert.equal(countResource(env.sent, "https://cdn.example/script/playlist.m3u8?type=hls"), 1);
});

test("dynamic inline config insertions and attribute changes invalidate the pre-playback cache", async () => {
  const env = baseEnvironment();
  await import(`./content.js?test=${++moduleCounter}`);
  await delay(180);

  const node = mediaNode("DIV", {
    attrs: { "data-src": "https://cdn.example/dynamic/first.m3u8" },
  });
  env.attrMediaNodes.push(node);
  env.mutationObservers[0].callback([{
    type: "childList",
    target: { tagName: "DIV" },
    addedNodes: [node],
    removedNodes: [],
  }]);
  await delay(180);
  assert.equal(countResource(env.sent, "https://cdn.example/dynamic/first.m3u8"), 1);

  node.setAttribute("data-src", "https://cdn.example/dynamic/second.m3u8");
  env.mutationObservers[0].callback([{
    type: "attributes",
    target: node,
    attributeName: "data-src",
  }]);
  await delay(180);
  assert.equal(countResource(env.sent, "https://cdn.example/dynamic/second.m3u8"), 1);

  const meta = mediaNode("META", {
    attrs: { "content": "https://cdn.example/meta/first.mp4" },
  });
  env.metas.push(meta);
  env.mutationObservers[0].callback([{
    type: "childList",
    target: { tagName: "HEAD" },
    addedNodes: [meta],
    removedNodes: [],
  }]);
  await delay(180);
  assert.equal(countResource(env.sent, "https://cdn.example/meta/first.mp4"), 1);

  meta.setAttribute("content", "https://cdn.example/meta/second.mp4");
  env.mutationObservers[0].callback([{
    type: "attributes",
    target: meta,
    attributeName: "content",
  }]);
  await delay(180);
  assert.equal(countResource(env.sent, "https://cdn.example/meta/second.mp4"), 1);
});

test("scans shadow-root media and srcdoc iframe config", async () => {
  const env = baseEnvironment();
  const shadowVideo = mediaElement({ url: "https://cdn.example/shadow/main.mp4", paused: false });
  const host = Object.assign(new (globalThis.Element)("DIV"), {
    shadowRoot: {
      querySelectorAll(selector) {
        if (selector === "video, audio, source") return [shadowVideo];
        if (selector === "*") return [];
        if (selector === "iframe[srcdoc], iframe[src^='about:blank']") return [];
        if (selector === "iframe[srcdoc]") return [];
        if (selector === "script") return [];
        if (selector === 'script[type="application/ld+json"]') return [];
        if (selector.startsWith("meta[")) return [];
        if (selector.includes("[data-src]")) return [];
        return [];
      },
    },
  });
  env.attrMediaNodes.push(host);
  env.iframes.push(iframeElement("about:blank", {
    srcdoc: '<script>const src = "https://cdn.example/srcdoc/live.m3u8";</script>',
    getAttribute(name) {
      if (name === "srcdoc") return this.srcdoc;
      return null;
    },
  }));
  await import(`./content.js?test=${++moduleCounter}`);
  await delay(180);
  assert.equal(countResource(env.sent, "https://cdn.example/shadow/main.mp4"), 1);
  assert.equal(countResource(env.sent, "https://cdn.example/srcdoc/live.m3u8"), 1);
});

test("dynamically inserted media and iframe sources are detected", async () => {
  const env = baseEnvironment();
  await import(`./content.js?test=${++moduleCounter}`);
  await delay(180);

  env.videos.push(mediaElement({ url: "https://media.example/late-stream", paused: false }));
  env.iframes.push(iframeElement("https://player.example/embed/late"));
  env.mutationObservers[0].callback([
    { type: "childList", addedNodes: [{ tagName: "VIDEO" }, { tagName: "IFRAME" }], removedNodes: [] },
  ]);
  await delay(180);

  const media = env.sent.find((message) => message.type === "resource"
    && message.resourceUrl === "https://media.example/late-stream");
  assert.equal(media?.main, true);
  assert.equal(media?.frameUrl, "https://page.example/watch");
  const mainFrame = env.sent.find((message) => message.type === "main-frame");
  assert.deepEqual(mainFrame?.urls, ["https://player.example/embed/late"]);
});

test("Dood pass_md5 is cached, skipped on irrelevant mutations, and re-detected after script insertion", async () => {
  const env = baseEnvironment({ locationHref: "https://dood.example/d/abc123" });
  globalThis.fetch = async () => ({ ok: true, text: async () => "https://cdn.dood.example/direct.mp4" });
  await import(`./content.js?test=${++moduleCounter}`);
  await delay(180);

  assert.equal(env.documentHtml.reads, 1, "first scan must look for a pass_md5 clue once");
  assert.equal(env.sent.some((message) => message.type === "dood-direct"), false);

  env.mutationObservers[0].callback([{ type: "childList", addedNodes: [{ tagName: "DIV" }], removedNodes: [] }]);
  await delay(180);
  assert.equal(env.documentHtml.reads, 1, "irrelevant mutations must not re-serialize the document");

  env.documentHtml.text = '<a href="/pass_md5/9f8e7d6c5b4a">download</a>';
  env.mutationObservers[0].callback([{ type: "childList", addedNodes: [{ tagName: "SCRIPT" }], removedNodes: [] }]);
  await delay(180);

  const dood = env.sent.find((message) => message.type === "dood-direct");
  assert.equal(dood?.url, "https://cdn.dood.example/direct.mp4");
  assert.equal(dood?.frameUrl, "https://dood.example/d/abc123");
  assert.equal(countResource(env.sent, "https://cdn.dood.example/direct.mp4"), 1);

  const response = await new Promise((resolve) => {
    env.onMessage({ type: "get-dood-direct" }, {}, resolve);
  });
  assert.deepEqual(response, {
    ok: true,
    url: "https://cdn.dood.example/direct.mp4",
    frameUrl: "https://dood.example/d/abc123",
  });
});

test("Dood discovery ignores Aura diagnostic attributes and selects the real player script", async () => {
  const stale = JSON.stringify([{ resource: "https://playmogo.com/pass_md5/stale-token" }])
    .replaceAll('"', "&quot;");
  const env = baseEnvironment({
    locationHref: "https://playmogo.com/e/abc123",
    doodHtml: `<html data-aura-qa-detected-candidates="${stale}"><script>const pass = "/pass_md5/real-token";</script></html>`,
  });
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return {
      ok: true,
      headers: { get: () => "text/plain" },
      text: async () => "https://cdn.dood.example/real.mp4",
    };
  };

  await import(`./content.js?test=${++moduleCounter}`);
  await delay(0);

  assert.deepEqual(fetched, ["https://playmogo.com/pass_md5/real-token"]);
  assert.ok(env.sent.some((message) => message.type === "dood-direct"
    && message.url === "https://cdn.dood.example/real.mp4"));
});

test("Dood accepts its historical text/html MIME when the body is one exact media URL", async () => {
  const env = baseEnvironment({
    locationHref: "https://playmogo.com/e/html-response",
    doodHtml: '<script>const pass = "/pass_md5/html-token";</script>',
  });
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => "text/html; charset=UTF-8" },
    text: async () => "https://cdn.dood.example/historical-contract.mp4",
  });

  await import(`./content.js?test=${++moduleCounter}`);
  await delay(0);

  assert.ok(env.sent.some((message) => message.type === "dood-direct"
    && message.url === "https://cdn.dood.example/historical-contract.mp4"));
});

test("Dood rejects a pass response contaminated with HTML markup", async () => {
  const env = baseEnvironment({
    locationHref: "https://playmogo.com/e/contaminated-response",
    doodHtml: '<script>const pass = "/pass_md5/contaminated-token";</script>',
  });
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => "text/html; charset=UTF-8" },
    text: async () => "https://cdn.dood.example/should-not-be-used.mp4<html></html>",
  });

  await import(`./content.js?test=${++moduleCounter}`);
  await delay(0);

  assert.equal(env.sent.some((message) => message.type === "dood-direct"), false);
  const response = await new Promise((resolve) => {
    env.onMessage({ type: "get-dood-direct" }, {}, resolve);
  });
  assert.deepEqual(response, { ok: false });
});

test("Dood backoff survives mutations while a forced request retries immediately", async () => {
  const env = baseEnvironment({
    locationHref: "https://dood.example/e/abc123#player",
    doodHtml: '<script>const pass = "/pass_md5/token";</script>',
  });
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return attempts === 1
      ? { ok: false, text: async () => "" }
      : { ok: true, text: async () => "https://cdn.dood.example/recovered.mp4" };
  };
  await import(`./content.js?test=${++moduleCounter}`);
  await delay(0);
  assert.equal(attempts, 1);

  env.documentHtml.text = '<script>const pass = "/pass_md5/token-2";</script>';
  env.mutationObservers[0].callback([{
    type: "characterData",
    target: { parentElement: { tagName: "SCRIPT" } },
  }]);
  await delay(180);
  assert.equal(attempts, 1, "a script mutation must not defeat the five-second backoff");

  const forced = await new Promise((resolve) => {
    env.onMessage({ type: "get-dood-direct" }, {}, resolve);
  });
  assert.equal(attempts, 2);
  assert.deepEqual(forced, {
    ok: true,
    url: "https://cdn.dood.example/recovered.mp4",
    frameUrl: "https://dood.example/e/abc123",
  });
  env.onMessage({ type: "rescan" }, {}, () => {});
  await delay(0);
  const recovered = env.sent.find((message) => message.type === "resource"
    && message.resourceUrl === "https://cdn.dood.example/recovered.mp4");
  assert.equal(recovered?.frameUrl, "https://dood.example/e/abc123");
});

test("Dood coalesces overlapping scans into one pass request and supplies an abort signal", async () => {
  const env = baseEnvironment({
    locationHref: "https://dood.example/e/coalesce",
    doodHtml: '<script>const pass = "/pass_md5/token";</script>',
  });
  let attempts = 0;
  let releaseFetch;
  let fetchSignal = null;
  globalThis.fetch = (_url, options) => {
    attempts += 1;
    fetchSignal = options?.signal || null;
    return new Promise((resolve) => {
      releaseFetch = () => resolve({ ok: true, text: async () => "https://cdn.dood.example/coalesced.mp4" });
    });
  };
  await import(`./content.js?test=${++moduleCounter}`);
  assert.equal(attempts, 1);
  assert.equal(fetchSignal instanceof AbortSignal, true);

  env.onMessage({ type: "rescan" }, {}, () => {});
  const forced = new Promise((resolve) => env.onMessage({ type: "get-dood-direct" }, {}, resolve));
  env.onMessage({ type: "rescan" }, {}, () => {});
  assert.equal(attempts, 1, "all overlapping scans and requests must share one fetch");
  releaseFetch();
  assert.equal((await forced).ok, true);
  await delay(0);
  assert.equal(attempts, 1);
});

test("Dood stops automatic retries after the bounded failure budget", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realDateNow = Date.now;
  const timers = [];
  globalThis.setTimeout = (callback, delayMs) => {
    const timer = { callback, delayMs, cancelled: false, unref() {} };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => { if (timer) timer.cancelled = true; };
  try {
    let now = 1_000_000;
    Date.now = () => now;
    const env = baseEnvironment({
      locationHref: "https://dood.example/e/retry-budget",
      doodHtml: '<script>const pass = "/pass_md5/token";</script>',
    });
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      return { ok: false, text: async () => "" };
    };
    const flushAsync = async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    };
    await import(`./content.js?test=${++moduleCounter}`);
    for (let expected = 1; expected < 4; expected += 1) {
      await flushAsync();
      const retry = timers.find((timer) => !timer.cancelled && timer.delayMs >= 5_000 && timer.delayMs <= 60_000);
      assert.ok(retry, `retry ${expected} must be scheduled`);
      retry.cancelled = true;
      now += retry.delayMs;
      retry.callback();
      const scan = timers.find((timer) => !timer.cancelled && timer.delayMs === 120);
      assert.ok(scan, `retry ${expected} scan must be debounced`);
      scan.cancelled = true;
      scan.callback();
      await flushAsync();
    }
    await flushAsync();
    assert.equal(attempts, 4);
    assert.equal(timers.some((timer) => !timer.cancelled && timer.delayMs >= 5_000), false,
      "the fourth failure must not create another automatic retry");
    assert.equal(env.documentHtml.reads, 4);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    Date.now = realDateNow;
  }
});

test("initial detection runs synchronously without debounce latency", async () => {
  const env = baseEnvironment();
  env.videos.push(mediaElement({ url: "https://media.example/immediate.mp4" }));
  await import(`./content.js?test=${++moduleCounter}`);
  assert.equal(countResource(env.sent, "https://media.example/immediate.mp4"), 1);
});

test("an explicit rescan runs prompt detection", async () => {
  const env = baseEnvironment();
  await import(`./content.js?test=${++moduleCounter}`);
  await delay(180);

  const scansBefore = env.countScans;
  env.videos.push(mediaElement({ url: "https://media.example/prompt-stream", paused: false }));
  env.onMessage({ type: "rescan" }, {}, () => {});

  assert.ok(env.sent.some((message) => message.type === "resource"
    && message.resourceUrl === "https://media.example/prompt-stream"), "rescan must detect immediately");
  assert.equal(env.countScans, scansBefore + 1);
  await delay(180);
  assert.equal(env.countScans, scansBefore + 1, "no extra scan after the prompt rescan");
});

test("download overlay acknowledges its top-frame activation after the first refresh", async () => {
  const env = baseEnvironment();
  await importFreshContent();
  const result = await new Promise((resolve) => {
    const keepAlive = env.onMessage({ type: "show-download-overlay" }, {}, resolve);
    assert.equal(keepAlive, true);
  });
  assert.deepEqual(result, { ok: true, shown: true });
  assert.ok(env.sent.some((message) => message.type === "list-download-jobs"));
});

test("download overlay keeps diagnostics on the host and renders into its ShadowRoot", async () => {
  const job = {
    id: "job-shadow-root",
    title: "Dood download",
    status: "running",
    statusText: "Running 20%",
    diagnostic: { providerId: "dood", frameId: 8 },
  };
  const env = baseEnvironment({
    runtimeHandler(message) {
      if (message.type === "list-download-jobs") return { jobs: [job] };
      if (message.type === "qa-list-candidates") return { ok: true, candidates: [] };
      if (message.type === "qa-list-request-trace") return { ok: true, requests: [] };
      return undefined;
    },
  });
  await importFreshContent();
  const result = await new Promise((resolve) => {
    const keepAlive = env.onMessage({ type: "show-download-overlay", jobIds: [job.id] }, {}, resolve);
    assert.equal(keepAlive, true);
  });

  assert.deepEqual(result, { ok: true, shown: true });
  assert.equal(JSON.parse(env.overlayHost.dataset.auraQaCandidates)[0].id, job.id);
  assert.equal(env.overlayHost.shadowRoot.children.length, 1);
  await new Promise((resolve) => env.onMessage({ type: "hide-download-overlay" }, {}, resolve));
});

test("download overlay hide message stops the local timer and removes the host", async () => {
  const env = baseEnvironment();
  await importFreshContent();
  const result = await new Promise((resolve) => {
    const keepAlive = env.onMessage({ type: "hide-download-overlay" }, {}, resolve);
    assert.equal(keepAlive, false);
  });
  assert.deepEqual(result, { ok: true, hidden: true });
});

test("an explicit rescan interrupts a pending debounce without double scanning", async () => {
  const env = baseEnvironment();
  await import(`./content.js?test=${++moduleCounter}`);
  await delay(180);

  const scansBefore = env.countScans;
  env.mutationObservers[0].callback([{ type: "childList", addedNodes: [{ tagName: "DIV" }], removedNodes: [] }]);
  env.videos.push(mediaElement({ url: "https://media.example/pending-stream", paused: false }));
  env.onMessage({ type: "rescan" }, {}, () => {});

  assert.ok(env.sent.some((message) => message.type === "resource"
    && message.resourceUrl === "https://media.example/pending-stream"));
  await delay(180);
  assert.equal(env.countScans, scansBefore + 1, "the pending timer must be cancelled");
});

test("PerformanceObserver reports resource entries without DOM scan iteration", async () => {
  const env = baseEnvironment({ withPerformanceObserver: true });
  await import(`./content.js?test=${++moduleCounter}`);
  await delay(180);

  assert.equal(env.countScans, 0, "scans must not iterate performance history while the observer is active");
  assert.equal(env.performanceObservers.length, 1);
  assert.deepEqual(env.performanceObservers[0].options, { type: "resource", buffered: true });

  env.performanceObservers[0].callback({ getEntries: () => [{ name: "https://cdn.example/observed.mp4" }] });
  const observed = env.sent.find((message) => message.type === "resource"
    && message.resourceUrl === "https://cdn.example/observed.mp4");
  assert.ok(observed);
  assert.equal(observed.frameUrl, "https://page.example/watch");

  env.mutationObservers[0].callback([{ type: "childList", addedNodes: [{ tagName: "DIV" }], removedNodes: [] }]);
  await delay(180);
  assert.equal(env.countScans, 0, "DOM scans must not reread performance history");
});

test("Dood pass_md5 base response is completed with the player token handshake", async () => {
  const env = baseEnvironment({
    locationHref: "https://playmogo.com/e/lm4az4bcghg8",
    doodHtml: '<script>fetch("/pass_md5/secret").then(data => data + makePlay() + "?token=fresh123&expiry=" + Date.now())</script>',
  });
  globalThis.fetch = async () => ({ ok: true, text: async () => "https://srv123.doodcdn.io/getfile/abc/" });
  await import(`./content.js?test=${++moduleCounter}`);
  await delay(0);

  const dood = env.sent.find((message) => message.type === "dood-direct");
  assert.match(dood?.url || "", /^https:\/\/srv123\.doodcdn\.io\/getfile\/abc\/[A-Za-z0-9]{10}\?token=fresh123&expiry=\d+$/);
  assert.equal(dood?.frameUrl, "https://playmogo.com/e/lm4az4bcghg8");
});

test("MAIN-world observations bridge detected manifests", async () => {
  const env = baseEnvironment({ runtimeHandler: () => ({ ok: true }) });
  await importFreshContent();
  const dispatch = (data) => {
    for (const handler of env.windowEventHandlers.message || []) handler({ source: globalThis, data });
  };
  dispatch({
    type: "aura-media-observer-event-v1",
    kind: "manifest",
    url: "https://media.example/hidden.mpd",
    contentType: "application/dash+xml",
  });
  assert.equal(countResource(env.sent, "https://media.example/hidden.mpd"), 1);
  assert.equal(env.sent.some((message) => /^mse-capture-/.test(message.type || "")), false);
});

test("player-adapter metadata is preserved and refresh snapshots return the latest token URL", async () => {
  const env = baseEnvironment({ runtimeHandler: () => ({ ok: true }) });
  await importFreshContent();
  const dispatch = (data) => {
    for (const handler of env.windowEventHandlers.message || []) handler({ source: globalThis, data });
  };
  const staleUrl = "https://media.nnvivi.site/level5/master.m3u8?token=stale";
  dispatch({
    type: "aura-media-observer-event-v1",
    kind: "player-source",
    source: "player-adapter",
    url: staleUrl,
    contentType: "application/vnd.apple.mpegurl",
    player: "level5",
    sessionId: "level5:1",
    confidence: 100,
    observedAt: 1_700_000_000_000,
  });
  const observed = env.sent.find((message) => message.resourceUrl === staleUrl);
  assert.equal(observed?.detectionSource, "player-adapter");
  assert.equal(observed?.player, "level5");
  assert.equal(observed?.sessionId, "level5:1");

  const responsePromise = new Promise((resolve) => {
    const keepAlive = env.onMessage({
      type: "refresh-media-source",
      resourceUrl: staleUrl,
      player: "level5",
      sessionId: "level5:1",
    }, {}, resolve);
    assert.equal(keepAlive, true);
  });
  const request = env.posted.find((message) => message.type === "aura-media-observer-snapshot-request-v1");
  assert.ok(request?.requestId);
  const freshUrl = "https://media.nnvivi.site/level5/master.m3u8?token=fresh";
  dispatch({
    type: "aura-media-observer-event-v1",
    kind: "player-source",
    source: "player-adapter",
    requestId: request.requestId,
    snapshot: true,
    url: freshUrl,
    contentType: "application/vnd.apple.mpegurl",
    player: "level5",
    sessionId: "level5:1",
    confidence: 100,
    observedAt: 1_700_000_010_000,
  });
  dispatch({
    type: "aura-media-observer-event-v1",
    kind: "snapshot-complete",
    requestId: request.requestId,
    count: 1,
  });

  const refreshed = await responsePromise;
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.url, freshUrl);
  assert.equal(refreshed.frameUrl, "https://page.example/watch");
});
