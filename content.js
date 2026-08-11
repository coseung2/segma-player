(() => {
  if (globalThis.__personalVpnMediaDetectorInstalledV3) return;
  globalThis.__personalVpnMediaDetectorInstalledV3 = true;
  const MAX_URL_BYTES = 4096;
  const MAX_TITLE_CHARACTERS = 512;
  const MAX_SEEN = 1000;
  const seen = new Set();
  let scanQueued = false;
  let lastMainFrames = "";
  let lastDoodPassUrl = "";
  let doodDirectCache = null;

  function send(message) {
    try {
      const promise = chrome.runtime.sendMessage(message);
      if (promise && typeof promise.catch === "function") promise.catch(() => {});
    } catch {
      // 확장 프로그램이 새로 로드되는 동안 페이지가 열려 있으면 메시지를 보낼 수 없습니다.
    }
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

  async function resolveDoodDirect(force = false) {
    try {
      const pathname = new URL(location.href).pathname;
      if (!/^\/(?:[de])\//.test(pathname)) return null;
      const text = document.documentElement?.outerHTML || "";
      const match = text.match(/(\/pass_md5\/[^"')\s<>]+)/);
      if (!match) return null;
      const passUrl = new URL(match[1], location.href).href;
      if (!force && passUrl === lastDoodPassUrl && doodDirectCache) return doodDirectCache;
      const response = await fetch(passUrl, { credentials: "include" });
      if (!response.ok) return null;
      const body = (await response.text()).trim();
      let direct = body;
      if (body.startsWith("{") || body.startsWith("[")) {
        try {
          const object = JSON.parse(body);
          direct = object.f || object.url || object.src || object.file || direct;
        } catch { /* not JSON */ }
      }
      direct = String(direct).replace(/^["']|["']$/g, "").trim();
      if (!/^https?:\/\//i.test(direct) || direct.length > MAX_URL_BYTES) return null;
      lastDoodPassUrl = passUrl;
      doodDirectCache = { url: direct, frameUrl: location.href };
      return doodDirectCache;
    } catch {
      return null;
    }
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
      queueScan();
      return false;
    }
    if (handleDoodRequest(message, sendResponse)) return true;
    return handleDirectDownload(message, sendResponse);
  }

  function scan() {
    scanQueued = false;
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
    for (const entry of performance.getEntriesByType("resource")) report(entry.name);
    reportMainFrames();
    void reportDoodPlayer();
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    queueMicrotask(scan);
  }

  queueScan();
  if (globalThis.PerformanceObserver) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) report(entry.name);
    });
    observer.observe({ type: "resource", buffered: true });
  }
  new MutationObserver(queueScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "data-src"],
  });
  for (const eventName of ["play", "playing", "loadstart", "loadedmetadata"]) {
    document.addEventListener(eventName, () => queueScan(), true);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => handleMessage(message, sendResponse));
})();
