(() => {
  if (globalThis.__personalVpnMediaDetectorInstalledV3) return;
  globalThis.__personalVpnMediaDetectorInstalledV3 = true;
  const MAX_URL_BYTES = 4096;
  const MAX_TITLE_CHARACTERS = 512;
  const MAX_SEEN = 1000;
  const SCAN_DEBOUNCE_MS = 120;
  const DOOD_RETRY_BASE_MS = 5_000;
  const DOOD_RETRY_MAX_MS = 60_000;
  const DOOD_RETRY_MAX_ATTEMPTS = 4;
  const DOOD_FETCH_TIMEOUT_MS = 12_000;
  const seen = new Set();
  let scanTimer = null;
  let scanScheduled = false;
  let lastMainFrames = "";
  let lastDoodPassUrl = "";
  let doodDirectCache = null;
  let doodDirty = true;
  let doodRetryAfter = 0;
  let doodRetryAttempts = 0;
  let doodRetryTimer = null;
  let doodResolutionPromise = null;
  let scriptsDirty = true;
  let cachedEmbeddedUrls = null;
  let performanceCursorEntry = null;
  let performanceObserverActive = false;

  function send(message) {
    try {
      const promise = chrome.runtime.sendMessage(message);
      if (promise && typeof promise.catch === "function") promise.catch(() => {});
    } catch {
      // 확장 프로그램이 새로 로드되는 동안 페이지가 열려 있으면 메시지를 보낼 수 없습니다.
    }
  }

  function currentFrameUrl() {
    try {
      const url = new URL(location.href);
      if (!/^https?:$/.test(url.protocol)) return "";
      url.hash = "";
      return url.href.length <= MAX_URL_BYTES ? url.href : "";
    } catch {
      return "";
    }
  }

  function clearDoodRetry() {
    doodRetryAfter = 0;
    doodRetryAttempts = 0;
    if (doodRetryTimer !== null) {
      clearTimeout(doodRetryTimer);
      doodRetryTimer = null;
    }
  }

  function backoffDoodRetry() {
    doodRetryAttempts += 1;
    const retryDelay = Math.min(DOOD_RETRY_BASE_MS * (2 ** (doodRetryAttempts - 1)), DOOD_RETRY_MAX_MS);
    doodRetryAfter = Date.now() + retryDelay;
    if (doodRetryTimer !== null) clearTimeout(doodRetryTimer);
    if (doodRetryAttempts >= DOOD_RETRY_MAX_ATTEMPTS) {
      doodRetryTimer = null;
      return;
    }
    doodRetryTimer = setTimeout(() => {
      doodRetryTimer = null;
      if (doodDirty) scheduleScan();
    }, retryDelay);
    doodRetryTimer?.unref?.();
  }

  function report(resourceUrl, contentType = "", main = false, fromMediaElement = false) {
    if (typeof resourceUrl !== "string" || resourceUrl.length === 0 || resourceUrl.length > MAX_URL_BYTES
      || typeof contentType !== "string" || contentType.length > 128 || seen.has(resourceUrl)) return;
    seen.add(resourceUrl);
    while (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
    send({
      type: "resource",
      resourceUrl,
      contentType,
      main,
      fromMediaElement,
      frameUrl: currentFrameUrl(),
      pageTitle: [...document.title].slice(0, MAX_TITLE_CHARACTERS).join(""),
    });
  }

  function visibleArea(element) {
    if (!element || !(element instanceof Element)) return 0;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return 0;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") === 0) return 0;
    return rect.width * rect.height;
  }

  function mediaElements() {
    const result = [];
    for (const element of document.querySelectorAll("video, audio, source")) {
      const url = element.currentSrc || element.src;
      if (typeof url !== "string" || url.length === 0) continue;
      try {
        if (/\.(?:avif|gif|jpe?g|png|webp)$/i.test(new URL(url, location.href).pathname)) continue;
      } catch { /* keep browser-owned blob sources */ }
      const host = element.tagName === "SOURCE" ? element.parentElement : element;
      const area = visibleArea(host);
      result.push({
        url,
        type: element.type || "",
        area,
        playing: Boolean(area > 0 && host && "paused" in host && !host.paused),
      });
    }
    return result;
  }

  function embeddedPlayerUrls() {
    if (!scriptsDirty && cachedEmbeddedUrls !== null) return cachedEmbeddedUrls;
    const urls = [];
    const pattern = /\bvideo_url(?:_hd)?\s*:\s*(["'])([A-Za-z0-9+/]{8,}={0,2})\1/g;
    for (const script of document.querySelectorAll("script")) {
      const source = script.textContent || "";
      if (!source.includes("video_url")) continue;
      for (const match of source.matchAll(pattern)) {
        try {
          const decoded = atob(match[2]).trim();
          const url = new URL(decoded, location.href);
          if (/^https?:$/.test(url.protocol) && url.href.length <= MAX_URL_BYTES) urls.push(url.href);
        } catch {
          // Ignore unrelated or malformed player configuration values.
        }
      }
    }
    cachedEmbeddedUrls = [...new Set(urls)];
    scriptsDirty = false;
    return cachedEmbeddedUrls;
  }

  function reportMainFrames() {
    if (window.top !== window) return;
    const frames = [];
    let order = 0;
    for (const iframe of document.querySelectorAll("iframe")) {
      const src = iframe.src && !iframe.src.startsWith("about:") ? iframe.src : (iframe.dataset?.src || "");
      if (!/^https?:\/\//i.test(src)) continue;
      const area = visibleArea(iframe);
      if (area <= 0) continue;
      frames.push({ src, area, order });
      order += 1;
    }
    if (!frames.length) return;
    const top = [...frames].sort((a, b) => (b.area - a.area) || (a.order - b.order))[0];
    const url = top.src;
    if (!url || url === lastMainFrames) return;
    lastMainFrames = url;
    send({ type: "main-frame", urls: [url] });
  }

  async function resolveDoodDirectOnce(force) {
    try {
      if (!force && !doodDirty) return doodDirectCache;
      const text = document.documentElement?.outerHTML || "";
      const match = text.match(/(\/pass_md5\/[^"')\s<>]+)/);
      doodDirty = false;
      if (!match) {
        lastDoodPassUrl = "";
        doodDirectCache = null;
        return null;
      }
      const passUrl = new URL(match[1], location.href).href;
      if (!force && passUrl === lastDoodPassUrl && doodDirectCache) return doodDirectCache;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DOOD_FETCH_TIMEOUT_MS);
      timeout?.unref?.();
      try {
        const response = await fetch(passUrl, { credentials: "include", signal: controller.signal });
        if (!response.ok) {
          doodDirty = true;
          backoffDoodRetry();
          return null;
        }
        const body = (await response.text()).trim();
        let direct = body;
        if (body.startsWith("{") || body.startsWith("[")) {
          try {
            const object = JSON.parse(body);
            direct = object.f || object.url || object.src || object.file || direct;
          } catch { /* not JSON */ }
        }
        direct = String(direct).replace(/^["']|["']$/g, "").trim();
        if (!/^https?:\/\//i.test(direct) || direct.length > MAX_URL_BYTES) {
          doodDirty = true;
          backoffDoodRetry();
          return null;
        }
        lastDoodPassUrl = passUrl;
        doodDirectCache = { url: direct, frameUrl: currentFrameUrl() };
        clearDoodRetry();
        return doodDirectCache;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      doodDirty = true;
      backoffDoodRetry();
      return null;
    }
  }

  function resolveDoodDirect(force = false) {
    try {
      const pathname = new URL(location.href).pathname;
      if (!/^\/(?:[de])\//.test(pathname)) return Promise.resolve(null);
    } catch {
      return Promise.resolve(null);
    }
    if (!force && doodRetryAfter > Date.now()) return Promise.resolve(null);
    if (doodResolutionPromise) return doodResolutionPromise;
    const operation = resolveDoodDirectOnce(force).finally(() => {
      if (doodResolutionPromise === operation) doodResolutionPromise = null;
    });
    doodResolutionPromise = operation;
    return operation;
  }

  function requestLevel5Key(url) {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve({ ok: false, error: "page-bridge-timeout" });
      }, 16_000);
      function onMessage(event) {
        if (event.source !== window || event.data?.type !== "aura-level5-key-response-v1"
          || event.data.requestId !== requestId) return;
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        if (!event.data.ok || typeof event.data.key !== "string") {
          const error = typeof event.data.error === "string" && /^[a-z0-9-]{3,64}$/.test(event.data.error)
            ? event.data.error : "level5-key-unavailable";
          resolve({ ok: false, error });
          return;
        }
        try {
          const binary = atob(event.data.key);
          if (binary.length !== 16 && binary.length !== 32) throw new Error("invalid-key");
          resolve({ ok: true, key: [...binary].map((character) => character.charCodeAt(0)) });
        } catch {
          resolve({ ok: false, error: "invalid-level5-key" });
        }
      }
      window.addEventListener("message", onMessage);
      window.postMessage({ type: "aura-level5-key-request-v1", requestId, url }, "*");
    });
  }

  function handleLevel5KeyRequest(message, sendResponse) {
    if (message?.type !== "decode-level5-key" || typeof message.url !== "string") return false;
    void requestLevel5Key(message.url).then(sendResponse);
    return true;
  }

  async function reportDoodPlayer() {
    const resolved = await resolveDoodDirect();
    if (!resolved) return;
    report(resolved.url, "video/mp4", false, true);
    send({ type: "dood-direct", url: resolved.url, frameUrl: resolved.frameUrl });
  }

  function handleDoodRequest(message, sendResponse) {
    if (message?.type !== "get-dood-direct") return false;
    void resolveDoodDirect(true).then((resolved) => {
      sendResponse(resolved ? { ok: true, url: resolved.url, frameUrl: resolved.frameUrl } : { ok: false });
    });
    return true;
  }

  function handleDirectDownload(message, sendResponse) {
    if (message?.type !== "download-direct" || typeof message.url !== "string") return false;
    try {
      const url = new URL(message.url);
      if (!/^https?:$/.test(url.protocol)) {
        sendResponse({ ok: false });
        return true;
      }
      const anchor = document.createElement("a");
      anchor.href = url.href;
      if (typeof message.filename === "string" && message.filename) anchor.download = message.filename;
      anchor.referrerPolicy = "unsafe-url";
      anchor.style.display = "none";
      document.documentElement.append(anchor);
      anchor.click();
      anchor.remove();
      sendResponse({ ok: true });
    } catch {
      sendResponse({ ok: false });
    }
    return true;
  }

  function handleMessage(message, sendResponse) {
    if (message?.type === "rescan") {
      scheduleScan(true);
      return false;
    }
    if (handleLevel5KeyRequest(message, sendResponse)) return true;
    if (handleDoodRequest(message, sendResponse)) return true;
    return handleDirectDownload(message, sendResponse);
  }

  function scan() {
    const elements = mediaElements();
    let mainUrl = null;
    if (elements.length) {
      const main = [...elements].sort((a, b) => (Number(b.playing) - Number(a.playing)) || (b.area - a.area))[0];
      // hls.js-style players expose only a blob: URL on the video element.
      // Treating that blob as the main media would hide the real HLS playlist
      // behind the popover's main-only filter, so blob sources are never main.
      if (!/^blob:/i.test(main.url)) mainUrl = main.url;
    }
    for (const item of elements) report(item.url, item.type, item.url === mainUrl, true);
    for (const url of embeddedPlayerUrls()) report(url, "video/mp4", true, true);
    if (!performanceObserverActive) {
      const entries = performance.getEntriesByType("resource");
      let start = 0;
      if (performanceCursorEntry) {
        const cursorIndex = entries.indexOf(performanceCursorEntry);
        if (cursorIndex >= 0) start = cursorIndex + 1;
        // The cursor entry can be evicted from the bounded resource buffer;
        // every earlier entry is evicted too, so re-reading the remaining
        // buffer is bounded and `seen` deduplicates already-reported URLs.
      }
      for (let i = start; i < entries.length; i++) report(entries[i].name);
      if (entries.length) performanceCursorEntry = entries[entries.length - 1];
    }
    reportMainFrames();
    void reportDoodPlayer();
  }

  function markRelevantDirty(records) {
    const markNode = (node, includeDescendants = true) => {
      const tag = node?.tagName;
      const containsScript = tag === "SCRIPT" || (includeDescendants && Boolean(node?.querySelector?.("script")));
      const containsFrame = tag === "IFRAME" || tag === "EMBED"
        || (includeDescendants && Boolean(node?.querySelector?.("iframe, embed")));
      const containsPassLink = (tag === "A" && String(node?.href || node?.getAttribute?.("href") || "").includes("/pass_md5/"))
        || (includeDescendants && Boolean(node?.querySelector?.('[href*="/pass_md5/"]')));
      if (containsScript) scriptsDirty = true;
      if (containsScript || containsFrame || containsPassLink) doodDirty = true;
    };
    for (const record of records || []) {
      if (record.type === "attributes") {
        const tag = record.target?.tagName;
        if (tag === "SCRIPT") {
          scriptsDirty = true;
          doodDirty = true;
        } else if (tag === "IFRAME" || tag === "EMBED" || (tag === "A" && record.attributeName === "href")) {
          doodDirty = true;
        }
        continue;
      }
      if (record.type === "characterData") {
        const parent = record.target?.parentElement || record.target?.parentNode;
        if (parent?.tagName === "SCRIPT" || parent?.closest?.("script")) {
          scriptsDirty = true;
          doodDirty = true;
        }
        continue;
      }
      if (record.type !== "childList") continue;
      markNode(record.target, false);
      for (const node of [...(record.addedNodes || []), ...(record.removedNodes || [])]) {
        markNode(node);
      }
    }
  }

  function scheduleScan(prompt = false) {
    if (prompt) {
      if (scanTimer !== null) {
        clearTimeout(scanTimer);
        scanTimer = null;
        scanScheduled = false;
      }
      scan();
      return;
    }
    if (scanScheduled) return;
    scanScheduled = true;
    scanTimer = setTimeout(() => {
      scanScheduled = false;
      scanTimer = null;
      scan();
    }, SCAN_DEBOUNCE_MS);
  }

  if (globalThis.PerformanceObserver) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) report(entry.name);
      });
      observer.observe({ type: "resource", buffered: true });
      performanceObserverActive = true;
    } catch {
      // Buffered resource observation is unavailable; the cursor below covers it.
    }
  }
  new MutationObserver((records) => {
    markRelevantDirty(records);
    scheduleScan();
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["src", "data-src", "href"],
  });
  for (const eventName of ["play", "playing", "loadstart", "loadedmetadata"]) {
    document.addEventListener(eventName, () => scheduleScan(), true);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => handleMessage(message, sendResponse));
  scan();
})();
