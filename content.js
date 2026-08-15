(() => {
  if (globalThis.__auraMediaDetectorInstalledV3) return;
  globalThis.__auraMediaDetectorInstalledV3 = true;
  const MAX_URL_BYTES = 4096;
  const MAX_TITLE_CHARACTERS = 512;
  const MAX_SEEN = 1000;
  const SCAN_DEBOUNCE_MS = 120;
  const DOOD_RETRY_BASE_MS = 5_000;
  const DOOD_RETRY_MAX_MS = 60_000;
  const DOOD_RETRY_MAX_ATTEMPTS = 4;
  const DOOD_FETCH_TIMEOUT_MS = 12_000;
  const DOOD_NONCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const PAGE_MEDIA_EVENT_TYPE = "aura-media-observer-event-v1";
  const seen = new Map();
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
      || typeof contentType !== "string" || contentType.length > 128) return;
    const previousType = seen.get(resourceUrl) || "";
    if (previousType && (!contentType || previousType === contentType)) return;
    seen.set(resourceUrl, contentType || previousType);
    while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
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
        direct = completeDoodDirectUrl(String(direct).replace(/^["']|["']$/g, "").trim(), text);
        if (!direct) {
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

  function doodNonce(length = 10) {
    const values = new Uint32Array(length);
    try {
      crypto.getRandomValues(values);
    } catch {
      for (let index = 0; index < values.length; index += 1) values[index] = Math.floor(Math.random() * 0x100000000);
    }
    return [...values].map((value) => DOOD_NONCE_ALPHABET[value % DOOD_NONCE_ALPHABET.length]).join("");
  }

  function completeDoodDirectUrl(value, pageSource) {
    let direct;
    try {
      direct = new URL(String(value || "").trim());
    } catch {
      return null;
    }
    if (!/^https?:$/.test(direct.protocol) || direct.href.length > MAX_URL_BYTES) return null;
    if (direct.searchParams.has("token")) return direct.href;
    const token = /[?&]token=([^&"'\s+]+)/i.exec(String(pageSource || ""))?.[1] || "";
    const leaf = direct.pathname.split("/").pop() || "";
    if (!token || /\.[a-z0-9]{2,5}$/i.test(leaf)) return direct.href;
    direct.pathname += doodNonce();
    direct.searchParams.set("token", token);
    direct.searchParams.set("expiry", String(Date.now()));
    return direct.href;
  }

  function handlePageMediaEvent(event) {
    if (event.source !== window || event.data?.type !== PAGE_MEDIA_EVENT_TYPE) return;
    const data = event.data;
    if (data.kind === "manifest") report(data.url, data.contentType || "", false, false);
    if (data.kind === "media") report(data.url, data.contentType || "application/octet-stream", false, true);
  }

  function handleLevel5KeyRequest(message, sendResponse) {
    if (message?.type !== "decode-level5-key" || typeof message.url !== "string") return false;
    void requestLevel5Key(message.url).then(sendResponse);
    return true;
  }

  function handleDoodRequest(message, sendResponse) {
    if (message?.type !== "get-dood-direct") return false;
    void resolveDoodDirect(true).then((resolved) => {
      sendResponse(resolved ? { ok: true, url: resolved.url, frameUrl: resolved.frameUrl } : { ok: false });
    });
    return true;
  }

  async function reportDoodPlayer() {
    const resolved = await resolveDoodDirect();
    if (!resolved) return;
    report(resolved.url, "video/mp4", false, true);
    send({ type: "dood-direct", url: resolved.url, frameUrl: resolved.frameUrl });
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
    if (message?.type === "show-download-overlay") {
      showDownloadOverlay();
      return false;
    }
    if (message?.type === "rescan") {
      scheduleScan(true);
      return false;
    }
    if (handleLevel5KeyRequest(message, sendResponse)) return true;
    if (handleDoodRequest(message, sendResponse)) return true;
    return handleDirectDownload(message, sendResponse);
  }

  let downloadOverlayTimer = null;
  const shownDownloadJobIds = new Set();
  const ACTIVE_DOWNLOAD_STATUSES = new Set(["queued", "running", "paused"]);

  function cleanDownloadOverlay() {
    if (downloadOverlayTimer !== null) {
      clearInterval(downloadOverlayTimer);
      downloadOverlayTimer = null;
    }
    shownDownloadJobIds.clear();
    document.getElementById("aura-download-overlay-host")?.remove();
  }

  function downloadOverlayHost() {
    let host = document.getElementById("aura-download-overlay-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "aura-download-overlay-host";
      host.setAttribute("style", "position:fixed;right:16px;bottom:16px;z-index:2147483647;width:320px;max-width:calc(100vw - 24px);font-family:system-ui,-apple-system,'Segoe UI',sans-serif;");
      document.documentElement.append(host);
    }
    return host;
  }

  // The content script is a classic script and cannot import i18n.js, so the
  // overlay keeps its own copy of the few strings it renders. The active locale
  // comes from the same storage key the popup and settings write.
  const OVERLAY_LOCALE_KEY = "auraUiLocale";
  const OVERLAY_TEXT = {
    ko: {
      heading: "다운로드", close: "다운로드 창 닫기", cancel: "취소", cancelling: "취소 중",
      fallbackTitle: "다운로드",
      queued: "대기", running: "진행 중", paused: "일시정지", completed: "완료", failed: "실패", cancelled: "취소됨",
    },
    en: {
      heading: "Downloads", close: "Close the download panel", cancel: "Cancel", cancelling: "Cancelling",
      fallbackTitle: "Download",
      queued: "Queued", running: "In progress", paused: "Paused", completed: "Done", failed: "Failed", cancelled: "Cancelled",
    },
    ja: {
      heading: "ダウンロード", close: "ダウンロード画面を閉じる", cancel: "キャンセル", cancelling: "キャンセル中",
      fallbackTitle: "ダウンロード",
      queued: "待機", running: "進行中", paused: "一時停止", completed: "完了", failed: "失敗", cancelled: "キャンセル",
    },
    zh: {
      heading: "下载", close: "关闭下载面板", cancel: "取消", cancelling: "正在取消",
      fallbackTitle: "下载",
      queued: "等待", running: "进行中", paused: "已暂停", completed: "完成", failed: "失败", cancelled: "已取消",
    },
  };
  let overlayLocale = "en";

  function normalizeOverlayLocale(value) {
    const base = String(value || "").toLowerCase().replace("_", "-").split("-")[0];
    return Object.prototype.hasOwnProperty.call(OVERLAY_TEXT, base) ? base : null;
  }

  function overlayText(key) {
    const table = OVERLAY_TEXT[overlayLocale] || OVERLAY_TEXT.en;
    return table[key] ?? OVERLAY_TEXT.en[key] ?? key;
  }

  async function syncOverlayLocale() {
    try {
      const entry = await chrome.storage.local.get(OVERLAY_LOCALE_KEY);
      const stored = normalizeOverlayLocale(entry?.[OVERLAY_LOCALE_KEY]);
      if (stored) {
        overlayLocale = stored;
        return;
      }
    } catch {
      // Storage is unavailable here; fall back to the browser UI language.
    }
    overlayLocale = normalizeOverlayLocale(navigator.language) || "en";
  }

  try {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "local" || !changes[OVERLAY_LOCALE_KEY]) return;
      const next = normalizeOverlayLocale(changes[OVERLAY_LOCALE_KEY].newValue);
      if (next) overlayLocale = next;
    });
  } catch {
    // Storage change events are optional for the overlay.
  }

  function downloadOverlayPercent(job) {
    const message = String(job?.statusText || "");
    const segments = /저장 중…\s+(\d+)\s*\/\s*(\d+)/.exec(message);
    if (segments) {
      const current = Number(segments[1]);
      const total = Number(segments[2]);
      if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
        return Math.max(0, Math.min(100, Math.round((current / total) * 100)));
      }
    }
    const percent = /(?:저장 중|서버 처리 중|내 기기로 전송 중|수신 중)…\s+(\d{1,3})%/.exec(message);
    if (percent) {
      const value = Number(percent[1]);
      if (Number.isFinite(value)) return Math.max(0, Math.min(100, value));
    }
    return null;
  }

  function buildDownloadOverlayRow(job) {
    const row = document.createElement("div");
    row.setAttribute("style", "display:flex;align-items:center;gap:8px;padding:9px 10px;border-top:1px solid #222c3a;");
    const info = document.createElement("div");
    info.setAttribute("style", "flex:1;min-width:0;");
    const title = document.createElement("div");
    title.textContent = typeof job.title === "string" && job.title ? job.title : overlayText("fallbackTitle");
    title.setAttribute("style", "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#f4f7fb;font-size:11px;font-weight:700;");
    const status = document.createElement("div");
    const label = overlayText(job.status) || overlayText("running");
    const percent = job.status === "running" ? downloadOverlayPercent(job) : null;
    const message = String(job.status === "failed" ? (job.error || job.statusText || label) : (job.statusText || label));
    status.textContent = percent !== null ? `${label} · ${percent}%` : `${label} · ${message}`;
    status.setAttribute("style", "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8f9eb2;font-size:10px;margin-top:2px;");
    if (job.status === "completed") status.style.color = "#78d99a";
    else if (job.status === "failed" || job.status === "cancelled") status.style.color = "#ff8f8f";
    info.append(title, status);
    row.append(info);
    if (ACTIVE_DOWNLOAD_STATUSES.has(job.status)) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = overlayText("cancel");
      cancel.setAttribute("style", "border:0;border-radius:6px;background:transparent;color:#d09a97;cursor:pointer;font-size:10px;font-weight:700;padding:4px 6px;");
      cancel.addEventListener("click", async () => {
        cancel.disabled = true;
        cancel.textContent = overlayText("cancelling");
        await chrome.runtime.sendMessage({ type: "cancel-download-job", jobId: job.id }).catch(() => null);
        void refreshDownloadOverlay();
      });
      row.append(cancel);
    }
    return row;
  }

  async function refreshDownloadOverlay() {
    let jobs = [];
    try {
      const response = await chrome.runtime.sendMessage({ type: "list-download-jobs" });
      jobs = Array.isArray(response?.jobs) ? response.jobs : [];
    } catch {
      // The background may be waking; the timer will retry on the next tick.
    }
    const now = Date.now();
    const recent = jobs.filter((job) => ACTIVE_DOWNLOAD_STATUSES.has(job.status)
      || (typeof job.updatedAt === "number" && now - job.updatedAt < 15 * 1000));
    for (const job of recent) shownDownloadJobIds.add(job.id);
    const visible = jobs.filter((job) => shownDownloadJobIds.has(job.id));
    if (!jobs.length) return;
    if (!visible.length) {
      cleanDownloadOverlay();
      return;
    }
    const host = downloadOverlayHost();
    host.replaceChildren();
    const panel = document.createElement("div");
    panel.setAttribute("style", "overflow:hidden;background:#10141c;border:1px solid #2a3444;border-radius:12px;box-shadow:0 12px 30px rgba(0,0,0,.45);");
    const head = document.createElement("div");
    head.setAttribute("style", "display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 10px;");
    const heading = document.createElement("div");
    heading.textContent = overlayText("heading");
    heading.setAttribute("style", "color:#f4f7fb;font-size:12px;font-weight:800;");
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", overlayText("close"));
    close.setAttribute("style", "border:0;background:transparent;color:#8b9ab0;cursor:pointer;font-size:16px;line-height:1;padding:0 2px;");
    close.addEventListener("click", cleanDownloadOverlay);
    head.append(heading, close);
    panel.append(head);
    for (const job of visible.slice(0, 3)) panel.append(buildDownloadOverlayRow(job));
    host.append(panel);
  }

  function showDownloadOverlay() {
    if (window !== window.top) return;
    void syncOverlayLocale().then(() => refreshDownloadOverlay());
    if (downloadOverlayTimer !== null) clearInterval(downloadOverlayTimer);
    downloadOverlayTimer = setInterval(() => void refreshDownloadOverlay(), 1000);
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
  window.addEventListener("message", handlePageMediaEvent);
  scan();
})();
