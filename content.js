(() => {
  const RESCAN_EVENT_TYPE = "aura-media-detector-rescan-v1";
  if (globalThis.__auraMediaDetectorInstalledV4) return;
  globalThis.__auraMediaDetectorInstalledV4 = true;
  const extraction = globalThis.__segmaContentExtractionV1;
  if (!extraction) throw new Error("content-extraction-unavailable");
  const MAX_URL_BYTES = 4096;
  const MAX_TITLE_CHARACTERS = 512;
  const MAX_SEEN = 1000;
  const SCAN_DEBOUNCE_MS = 120;
  const DOOD_RETRY_BASE_MS = 5_000;
  const DOOD_RETRY_MAX_MS = 60_000;
  const DOOD_RETRY_MAX_ATTEMPTS = 4;
  const DOOD_FETCH_TIMEOUT_MS = 12_000;
  const DOOD_NONCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const DOOD_PASS_PATH_RE = /\/pass_md5\/[a-z0-9._~%/-]{1,2048}/i;
  const DOOD_PASS_PATH_EXACT_RE = /^\/pass_md5\/[a-z0-9._~%/-]{1,2048}$/i;
  const DOOD_SOURCE_NODE_LIMIT = 256;
  const DOOD_SOURCE_TEXT_LIMIT = 1_000_000;
  const MEDIA_CONFIG_NODE_LIMIT = 96;
  const MEDIA_CONFIG_TEXT_LIMIT = 250_000;
  const MEDIA_CONFIG_TOTAL_TEXT_LIMIT = 1_000_000;
  const SHADOW_HOST_LIMIT = 48;
  const SHADOW_WALK_LIMIT = 400;
  const SRCDOC_FRAME_LIMIT = 8;
  const SRCDOC_TEXT_LIMIT = 120_000;
  const INLINE_MEDIA_ATTRS = Object.freeze([
    "src", "data-src", "data-file", "data-url", "data-video", "data-stream", "data-hls", "href",
  ]);
  const INLINE_JSONLD_TYPES = Object.freeze([
    "videoobject", "movie", "tvepisode", "clip", "mediaobject",
  ]);
  const PAGE_MEDIA_EVENT_TYPE = "aura-media-observer-event-v1";
  const LEVEL5_MEDIA_DISCOVERY_REQUEST = "aura-level5-media-discovery-request-v1";
  const PAGE_MEDIA_SNAPSHOT_REQUEST_TYPE = "aura-media-observer-snapshot-request-v1";
  const MAX_RECENT_REPORTS = 256;
  const seen = new Map();
  const recentReports = new Map();
  const pendingSnapshots = new Map();
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
  let lastFrameStateSignature = "";
  let lastFrameStateAt = 0;

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

  // Some pages keep only a short board code in `<title>` and the real media
  // title in the body. Read-only DOM selectors are supplied per site by the
  // background, which owns the site registry; the content script never decides
  // which site it is on.
  let titleSelectors = [];

  function documentTitle() {
    return [...document.title].slice(0, MAX_TITLE_CHARACTERS).join("");
  }

  function selectorTitle() {
    for (const selector of titleSelectors) {
      let element = null;
      try {
        element = document.querySelector(selector);
      } catch {
        continue;
      }
      const text = String(element?.textContent || "").replace(/\s+/g, " ").trim();
      // A heading that merely repeats the document title adds nothing, so keep
      // looking for one that is actually more specific.
      if (text && text !== documentTitle().trim()) {
        return [...text].slice(0, MAX_TITLE_CHARACTERS).join("");
      }
    }
    return "";
  }

  function resolvedPageTitle() {
    return selectorTitle() || documentTitle();
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

  function safeMetadataToken(value, fallback = "") {
    return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value)
      ? value
      : fallback;
  }

  function reportKey(resourceUrl, metadata = {}) {
    return [
      resourceUrl,
      safeMetadataToken(metadata.detectionSource, "unknown"),
      safeMetadataToken(metadata.player, ""),
      safeMetadataToken(metadata.sessionId, ""),
      safeMetadataToken(metadata.requestType, ""),
    ].join("|");
  }

  function rememberReport(record) {
    const key = reportKey(record.resourceUrl, record);
    recentReports.delete(key);
    recentReports.set(key, record);
    while (recentReports.size > MAX_RECENT_REPORTS) {
      recentReports.delete(recentReports.keys().next().value);
    }
  }

  function report(resourceUrl, contentType = "", main = false, fromMediaElement = false, metadata = {}) {
    if (typeof resourceUrl !== "string" || resourceUrl.length === 0 || resourceUrl.length > MAX_URL_BYTES
      || typeof contentType !== "string" || contentType.length > 128) return;
    const detectionSource = safeMetadataToken(
      metadata.detectionSource,
      fromMediaElement ? "media-element" : "unknown",
    );
    const player = safeMetadataToken(metadata.player, "");
    const sessionId = safeMetadataToken(metadata.sessionId, "");
    const requestType = safeMetadataToken(metadata.requestType, "");
    const confidence = Number.isFinite(metadata.confidence)
      ? Math.max(0, Math.min(100, Math.round(metadata.confidence)))
      : (fromMediaElement ? 80 : 50);
    const observedAt = Number.isFinite(metadata.observedAt) ? metadata.observedAt : Date.now();
    const key = reportKey(resourceUrl, { detectionSource, player, sessionId, requestType });
    const previousType = seen.get(key) || "";
    if (previousType && (!contentType || previousType === contentType) && metadata.force !== true) return;
    seen.set(key, contentType || previousType);
    while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
    const record = {
      type: "resource",
      resourceUrl,
      contentType,
      main,
      explicitMain: Boolean(main),
      fromMediaElement,
      detectionSource,
      player,
      sessionId,
      requestType,
      confidence,
      observedAt,
      frameUrl: currentFrameUrl(),
      pageTitle: resolvedPageTitle(),
    };
    rememberReport(record);
    send(record);
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
    collectMediaElementsFromRoot(document, result);
    return result;
  }

  function collectMediaElementsFromRoot(root, result, remaining = 32) {
    if (!root || remaining <= 0) return remaining;
    let leftover = remaining;
    let elements = [];
    try {
      elements = [...(root.querySelectorAll?.("video, audio, source") || [])];
    } catch {
      return leftover;
    }
    for (const element of elements) {
      leftover = pushMediaElement(element, result, leftover);
      if (leftover <= 0) return leftover;
    }
    leftover = collectShadowMediaElements(root, result, leftover);
    leftover = collectSrcdocMediaElements(root, result, leftover);
    return leftover;
  }

  function pushMediaElement(element, result, remaining) {
    if (!element || remaining <= 0) return remaining;
    const url = element.currentSrc || element.src || element.getAttribute?.("src")
      || element.getAttribute?.("data-src") || "";
    if (typeof url !== "string" || url.length === 0) return remaining;
    try {
      if (/\.(?:avif|gif|jpe?g|png|webp)$/i.test(new URL(url, location.href).pathname)) return remaining;
    } catch { /* keep browser-owned blob sources */ }
    const host = String(element.tagName || "").toUpperCase() === "SOURCE" ? element.parentElement : element;
    const area = visibleArea(host);
    const playing = Boolean(area > 0 && host && "paused" in host && !host.paused);
    const durationSeconds = Number(host?.duration);
    result.push({
      url,
      type: element.type || element.getAttribute?.("type") || "",
      area,
      playing,
      muted: Boolean(host?.muted),
      durationMs: Number.isFinite(durationSeconds) && durationSeconds > 0
        ? Math.min(24 * 60 * 60 * 1000, Math.round(durationSeconds * 1000))
        : 0,
    });
    return remaining - 1;
  }

  function collectShadowMediaElements(root, result, remaining) {
    if (!root || remaining <= 0) return remaining;
    let leftover = remaining;
    let seen = 0;
    try {
      const hosts = root.querySelectorAll?.("*") || [];
      let walked = 0;
      for (const host of hosts) {
        walked += 1;
        if (walked > SHADOW_WALK_LIMIT) break;
        const shadow = host.shadowRoot;
        if (!shadow) continue;
        leftover = collectMediaElementsFromRoot(shadow, result, leftover);
        seen += 1;
        if (seen >= SHADOW_HOST_LIMIT || leftover <= 0) return leftover;
      }
    } catch {
      return leftover;
    }
    return leftover;
  }

  function collectSrcdocMediaElements(root, result, remaining) {
    if (!root || remaining <= 0) return remaining;
    let leftover = remaining;
    let frames = [];
    try {
      frames = [...(root.querySelectorAll?.("iframe[srcdoc], iframe[src^='about:blank']") || [])]
        .slice(0, SRCDOC_FRAME_LIMIT);
    } catch {
      return leftover;
    }
    for (const frame of frames) {
      try {
        const nested = frame.contentDocument;
        if (nested) leftover = collectMediaElementsFromRoot(nested, result, leftover);
      } catch {
        // Cross-origin about:blank clones stay closed to the parent detector.
      }
      if (leftover <= 0) return leftover;
    }
    return leftover;
  }

  function viewportArea() {
    const width = Number(globalThis.innerWidth || document.documentElement?.clientWidth || 0);
    const height = Number(globalThis.innerHeight || document.documentElement?.clientHeight || 0);
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? width * height
      : 0;
  }

  function reportFrameMediaState(elements) {
    const strongest = [...elements].sort((left, right) =>
      (Number(right.playing) - Number(left.playing)) || (right.area - left.area))[0] || null;
    const area = strongest?.area || 0;
    const viewport = viewportArea();
    const state = {
      type: "frame-media-state",
      frameUrl: currentFrameUrl(),
      playing: Boolean(strongest?.playing),
      muted: Boolean(strongest?.muted),
      visibleArea: Math.max(0, Math.round(area)),
      viewportRatio: viewport > 0 ? Math.max(0, Math.min(1, area / viewport)) : 0,
      durationMs: strongest?.durationMs || 0,
      topFrame: window === window.top,
      hasBlobSource: elements.some((item) => /^blob:/i.test(item.url)),
      observedAt: Date.now(),
    };
    const signature = JSON.stringify([
      state.frameUrl,
      state.playing,
      state.muted,
      Math.round(state.visibleArea / 10_000),
      Math.round(state.viewportRatio * 100),
      Math.round(state.durationMs / 1000),
      state.hasBlobSource,
    ]);
    const now = Date.now();
    if (signature === lastFrameStateSignature && now - lastFrameStateAt < 15_000) return;
    lastFrameStateSignature = signature;
    lastFrameStateAt = now;
    send(state);
  }

  function embeddedPlayerUrls() {
    if (!scriptsDirty && cachedEmbeddedUrls !== null) return cachedEmbeddedUrls;
    const urls = [];
    collectEmbeddedPlayerUrlsFromRoot(document, urls);
    cachedEmbeddedUrls = [...new Set(urls)];
    scriptsDirty = false;
    return cachedEmbeddedUrls;
  }

  function collectEmbeddedPlayerUrlsFromRoot(root, urls) {
    if (!root) return;
    collectAttributeMediaUrls(root, urls);
    collectMetaMediaUrls(root, urls);
    collectJsonLdMediaUrls(root, urls);
    collectInlineScriptMediaUrls(root, urls);
    collectSrcdocConfigUrls(root, urls);
  }

  function rememberEmbeddedUrl(urls, raw) {
    const url = canonicalInlineMediaUrl(raw);
    if (url) urls.push(url);
  }

  function canonicalInlineMediaUrl(value) {
    return extraction.canonicalMediaUrl(value, location.href);
  }

  function inferredInlineContentType(value) {
    return extraction.inferredContentType(value, location.href);
  }

  function collectAttributeMediaUrls(root, urls) {
    let nodes = [];
    try {
      nodes = [...(root.querySelectorAll?.("video, audio, source, [data-src], [data-file], [data-url], [data-video], [data-stream], [data-hls]") || [])]
        .slice(0, MEDIA_CONFIG_NODE_LIMIT);
    } catch {
      return;
    }
    for (const node of nodes) {
      for (const name of INLINE_MEDIA_ATTRS) {
        rememberEmbeddedUrl(urls, node.getAttribute?.(name));
      }
    }
  }

  function collectMetaMediaUrls(root, urls) {
    let nodes = [];
    try {
      nodes = [...(root.querySelectorAll?.('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]') || [])]
        .slice(0, 16);
    } catch {
      return;
    }
    for (const node of nodes) rememberEmbeddedUrl(urls, node.getAttribute?.("content"));
  }

  function collectJsonLdMediaUrls(root, urls) {
    let scripts = [];
    try {
      scripts = [...(root.querySelectorAll?.('script[type="application/ld+json"]') || [])]
        .slice(0, 8);
    } catch {
      return;
    }
    for (const script of scripts) {
      const source = String(script.textContent || "").slice(0, MEDIA_CONFIG_TEXT_LIMIT);
      if (!source) continue;
      rememberJsonLdMediaUrls(source, urls);
    }
  }

  function rememberJsonLdMediaUrls(source, urls) {
    const typeMatch = /"@type"\s*:\s*"([^"]+)"/i.exec(source);
    const type = String(typeMatch?.[1] || "").toLowerCase();
    if (type && !INLINE_JSONLD_TYPES.includes(type)) return;
    const pattern = /"(?:contentUrl|embedUrl)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
    let match;
    while ((match = pattern.exec(source))) {
      rememberEmbeddedUrl(urls, match[1].replace(/\\\//g, "/"));
    }
  }

  function collectInlineScriptMediaUrls(root, urls) {
    let scripts = [];
    try {
      scripts = [...(root.querySelectorAll?.("script") || [])].slice(0, MEDIA_CONFIG_NODE_LIMIT);
    } catch {
      return;
    }
    let remainingText = MEDIA_CONFIG_TOTAL_TEXT_LIMIT;
    for (const script of scripts) {
      if (remainingText <= 0) break;
      const source = String(script.textContent || "");
      if (!source) continue;
      const bounded = source.slice(0, Math.min(MEDIA_CONFIG_TEXT_LIMIT, remainingText));
      remainingText -= bounded.length;
      rememberInlineScriptMediaUrls(bounded, urls);
    }
  }

  function rememberInlineScriptMediaUrls(source, urls) {
    for (const url of extraction.scriptMediaUrls(source, location.href)) rememberEmbeddedUrl(urls, url);
  }

  function collectSrcdocConfigUrls(root, urls) {
    let frames = [];
    try {
      frames = [...(root.querySelectorAll?.("iframe[srcdoc]") || [])].slice(0, SRCDOC_FRAME_LIMIT);
    } catch {
      return;
    }
    for (const frame of frames) {
      const srcdoc = String(frame.getAttribute?.("srcdoc") || "").slice(0, SRCDOC_TEXT_LIMIT);
      if (srcdoc) rememberInlineScriptMediaUrls(srcdoc, urls);
      try {
        const nested = frame.contentDocument;
        if (nested) collectEmbeddedPlayerUrlsFromRoot(nested, urls);
      } catch {
        // Closed srcdoc documents still expose their attribute text above.
      }
    }
  }

  function reportMainFrames() {
    if (window.top !== window) return;
    const frames = [];
    const viewport = viewportArea();
    let order = 0;
    for (const iframe of document.querySelectorAll("iframe")) {
      const src = iframe.src && !iframe.src.startsWith("about:")
        ? iframe.src
        : (iframe.dataset?.src || iframe.getAttribute?.("data-src") || "");
      if (!/^https?:\/\//i.test(src)) continue;
      const area = visibleArea(iframe);
      if (area <= 0) continue;
      const hint = `${src} ${iframe.title || ""} ${iframe.name || ""} ${iframe.id || ""}`;
      frames.push({
        src,
        area: Math.round(area),
        viewportRatio: viewport > 0 ? Math.max(0, Math.min(1, area / viewport)) : 0,
        adHint: /(?:^|[\W_])(?:ads?|advert|banner|preroll|vast|vpaid)(?:[\W_]|$)/i.test(hint),
        order,
      });
      order += 1;
    }
    if (!frames.length) return;
    const sorted = [...frames].sort((a, b) => (b.area - a.area) || (a.order - b.order));
    const signature = JSON.stringify(sorted.map((frame) => [
      frame.src,
      Math.round(frame.area / 10_000),
      Math.round(frame.viewportRatio * 100),
      frame.adHint,
    ]));
    if (signature === lastMainFrames) return;
    lastMainFrames = signature;
    send({ type: "main-frame", urls: [sorted[0].src], frames: sorted });
  }

  function doodPlayerClue() {
    let pageOrigin;
    try {
      pageOrigin = new URL(location.href).origin;
    } catch {
      return null;
    }
    const nodes = [...(document.querySelectorAll?.('script, a[href*="/pass_md5/"]') || [])]
      .slice(0, DOOD_SOURCE_NODE_LIMIT);
    const sourceParts = [];
    let passUrl = "";
    let sourceLength = 0;
    for (const node of nodes) {
      const tagName = String(node?.tagName || "").toUpperCase();
      const values = tagName === "A"
        ? [node.getAttribute?.("href"), node.href]
        : [node.textContent, node.getAttribute?.("src"), node.src];
      for (const value of values) {
        const source = typeof value === "string" ? value : "";
        if (!source) continue;
        if (sourceLength < DOOD_SOURCE_TEXT_LIMIT) {
          const part = source.slice(0, DOOD_SOURCE_TEXT_LIMIT - sourceLength);
          sourceParts.push(part);
          sourceLength += part.length;
        }
        if (passUrl) continue;
        const clue = DOOD_PASS_PATH_RE.exec(source)?.[0] || "";
        if (!clue) continue;
        try {
          const parsed = new URL(clue, location.href);
          if (parsed.origin !== pageOrigin || parsed.username || parsed.password || parsed.search || parsed.hash
            || !DOOD_PASS_PATH_EXACT_RE.test(parsed.pathname) || parsed.href.length > MAX_URL_BYTES) continue;
          passUrl = parsed.href;
        } catch {
          // Keep searching bounded, trusted player nodes.
        }
      }
    }
    return passUrl ? { passUrl, playerSource: sourceParts.join("\n") } : null;
  }

  async function resolveDoodDirectOnce(force) {
    try {
      if (!force && !doodDirty) return doodDirectCache;
      const clue = doodPlayerClue();
      doodDirty = false;
      if (!clue) {
        lastDoodPassUrl = "";
        doodDirectCache = null;
        return null;
      }
      const { passUrl, playerSource } = clue;
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
        direct = completeDoodDirectUrl(String(direct).replace(/^["']|["']$/g, "").trim(), playerSource);
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
    const raw = String(value || "").trim();
    if (!raw || raw.length > MAX_URL_BYTES || /[\s<>"']/.test(raw)) return null;
    let direct;
    try {
      direct = new URL(raw);
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

  function sameOriginPath(left, right) {
    try {
      const leftUrl = new URL(left);
      const rightUrl = new URL(right);
      return leftUrl.origin === rightUrl.origin && leftUrl.pathname === rightUrl.pathname;
    } catch {
      return false;
    }
  }

  function refreshRecordScore(record, request) {
    let score = Number(record.observedAt) || 0;
    if (request.sessionId && record.sessionId === request.sessionId) score += 1_000_000_000_000_000;
    if (request.player && record.player === request.player) score += 500_000_000_000_000;
    if (sameOriginPath(record.resourceUrl, request.resourceUrl)) score += 250_000_000_000_000;
    if (record.detectionSource === "player-adapter") score += 100_000_000_000_000;
    if (/^blob:/i.test(record.resourceUrl)) score -= 2_000_000_000_000_000;
    return score;
  }

  function bestRefreshRecord(request, collected = []) {
    const pool = [...recentReports.values(), ...collected]
      .filter((record) => typeof record?.resourceUrl === "string" && /^https?:/i.test(record.resourceUrl));
    return pool.sort((left, right) => refreshRecordScore(right, request) - refreshRecordScore(left, request))[0] || null;
  }

  function finishSnapshot(requestId) {
    const pending = pendingSnapshots.get(requestId);
    if (!pending) return;
    pendingSnapshots.delete(requestId);
    clearTimeout(pending.timer);
    const best = bestRefreshRecord(pending.request, pending.collected);
    pending.sendResponse(best ? {
      ok: true,
      url: best.resourceUrl,
      frameUrl: currentFrameUrl(),
      player: best.player || "",
      sessionId: best.sessionId || "",
      observedAt: best.observedAt || Date.now(),
    } : { ok: false, error: "media-source-unavailable" });
  }

  function handlePageMediaEvent(event) {
    if (event.source !== window || event.data?.type !== PAGE_MEDIA_EVENT_TYPE) return;
    const data = event.data;
    if (data.kind === "snapshot-complete" && typeof data.requestId === "string") {
      finishSnapshot(data.requestId);
      return;
    }
    if (!["manifest", "media", "player-source"].includes(data.kind)) return;
    const detectionSource = data.kind === "player-source"
      ? "player-adapter"
      : data.source === "fetch" ? "main-fetch" : data.source === "xhr" ? "main-xhr" : "unknown";
    const record = {
      resourceUrl: data.url,
      contentType: data.contentType || (data.kind === "media" ? "application/octet-stream" : ""),
      detectionSource,
      player: safeMetadataToken(data.player, ""),
      sessionId: safeMetadataToken(data.sessionId, ""),
      requestType: safeMetadataToken(data.source, ""),
      confidence: Number.isFinite(data.confidence)
        ? data.confidence
        : (data.kind === "player-source" ? 95 : data.kind === "media" ? 90 : 85),
      observedAt: Number.isFinite(data.observedAt) ? data.observedAt : Date.now(),
    };
    if (typeof data.requestId === "string") {
      const pending = pendingSnapshots.get(data.requestId);
      if (pending) pending.collected.push(record);
    }
    report(record.resourceUrl, record.contentType, false, data.kind === "media", record);
  }

  function handleRefreshMediaSource(message, sendResponse) {
    if (message?.type !== "refresh-media-source" || typeof message.resourceUrl !== "string") return false;
    const request = {
      resourceUrl: message.resourceUrl,
      player: safeMetadataToken(message.player, ""),
      sessionId: safeMetadataToken(message.sessionId, ""),
    };
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => finishSnapshot(requestId), 1_500);
    pendingSnapshots.set(requestId, { request, collected: [], sendResponse, timer });
    scheduleScan(true);
    window.postMessage({
      type: PAGE_MEDIA_SNAPSHOT_REQUEST_TYPE,
      requestId,
      resourceUrl: request.resourceUrl,
      player: request.player,
      sessionId: request.sessionId,
    }, "*");
    return true;
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
    report(resolved.url, "video/mp4", false, true, {
      detectionSource: "player-adapter",
      player: "dood",
      confidence: 100,
    });
    send({ type: "dood-direct", url: resolved.url, frameUrl: resolved.frameUrl });
  }

  function handleMessage(message, sendResponse) {
    if (message?.type === "rescan") {
      performExplicitRescan();
      sendResponse({ ok: true });
      return false;
    }
    // The background owns the site registry, so it tells this frame where the
    // page keeps its real media title. Applying it triggers a rescan so an
    // already-reported candidate gets the corrected title.
    if (message?.type === "set-title-selectors") {
      titleSelectors = Array.isArray(message.selectors)
        ? message.selectors
          .map((selector) => String(selector || "").trim())
          .filter((selector) => selector.length > 0 && selector.length <= 200)
          .slice(0, 8)
        : [];
      scheduleScan(true);
      sendResponse({
        ok: true,
        applied: titleSelectors.length,
        pageTitle: resolvedPageTitle(),
      });
      return false;
    }
    if (handleRefreshMediaSource(message, sendResponse)) return true;
    if (handleLevel5KeyRequest(message, sendResponse)) return true;
    return handleDoodRequest(message, sendResponse);
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
    for (const item of elements) report(item.url, item.type, item.url === mainUrl, true, {
      detectionSource: "media-element",
      confidence: item.playing ? 96 : 80,
    });
    for (const url of embeddedPlayerUrls()) report(url, inferredInlineContentType(url), true, true, {
      detectionSource: "inline-config",
      confidence: 82,
    });
    reportFrameMediaState(elements);
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
      for (let i = start; i < entries.length; i++) report(entries[i].name, "", false, false, {
        detectionSource: "performance",
        confidence: 35,
      });
      if (entries.length) performanceCursorEntry = entries[entries.length - 1];
    }
    reportMainFrames();
    void reportDoodPlayer();
  }

  function performExplicitRescan() {
    // The popup clears the background candidate list before asking every frame
    // to scan again. Clear the content-side dedupe as well, otherwise an
    // unchanged media URL is silently suppressed and the button appears dead.
    seen.clear();
    scriptsDirty = true;
    doodDirty = true;
    scheduleScan(true);

    // MAIN-world player adapters retain sources that a video element exposes
    // only as blob:. Ask them to replay their bounded source snapshot too.
    try {
      window.postMessage({
        type: PAGE_MEDIA_SNAPSHOT_REQUEST_TYPE,
        requestId: crypto.randomUUID(),
      }, "*");
    } catch {
      // DOM/media-element scanning above still covers ordinary progressive media.
    }
  }

  function markRelevantDirty(records) {
    const markNode = (node, includeDescendants = true) => {
      const tag = node?.tagName;
      const containsScript = tag === "SCRIPT" || (includeDescendants && Boolean(node?.querySelector?.("script")));
      const containsFrame = tag === "IFRAME" || tag === "EMBED"
        || (includeDescendants && Boolean(node?.querySelector?.("iframe, embed")));
      const containsPassLink = (tag === "A" && String(node?.href || node?.getAttribute?.("href") || "").includes("/pass_md5/"))
        || (includeDescendants && Boolean(node?.querySelector?.('[href*="/pass_md5/"]')));
      const containsMediaHost = tag === "VIDEO" || tag === "AUDIO" || tag === "SOURCE"
        || (includeDescendants && Boolean(node?.querySelector?.("video, audio, source")));
      const containsInlineConfig = ["data-src", "data-file", "data-url", "data-video", "data-stream", "data-hls"]
        .some((name) => Boolean(node?.getAttribute?.(name)))
        || tag === "META"
        || (includeDescendants && Boolean(node?.querySelector?.(
          "[data-src], [data-file], [data-url], [data-video], [data-stream], [data-hls], meta[property='og:video'], meta[property='og:video:url'], meta[property='og:video:secure_url'], meta[name='twitter:player:stream']",
        )));
      if (containsScript || containsFrame || containsMediaHost || containsInlineConfig) scriptsDirty = true;
      if (containsScript || containsFrame || containsPassLink || containsMediaHost) doodDirty = true;
    };
    for (const record of records || []) {
      if (record.type === "attributes") {
        const tag = record.target?.tagName;
        if (tag === "SCRIPT") {
          scriptsDirty = true;
          doodDirty = true;
        } else if (["data-src", "data-file", "data-url", "data-video", "data-stream", "data-hls", "srcdoc"].includes(record.attributeName)
          || (tag === "META" && record.attributeName === "content")) {
          scriptsDirty = true;
          if (tag === "IFRAME" || tag === "EMBED") doodDirty = true;
        } else if (tag === "IFRAME" || tag === "EMBED" || tag === "VIDEO" || tag === "AUDIO"
          || tag === "SOURCE" || (tag === "A" && record.attributeName === "href")) {
          scriptsDirty = true;
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
        for (const entry of list.getEntries()) report(entry.name, "", false, false, {
          detectionSource: "performance",
          confidence: 35,
        });
      });
      observer.observe({ type: "resource", buffered: true });
      performanceObserverActive = true;
    } catch {
      // Buffered resource observation is unavailable; the cursor below covers it.
    }
  }
  const documentObserver = new MutationObserver((records) => {
    markRelevantDirty(records);
    // Dood-compatible pages can close or replace themselves before
    // document_idle. Resolve as soon as the parser inserts /pass_md5/ config.
    if (doodDirty) void reportDoodPlayer();
    scheduleScan();
  });
  documentObserver.observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["src", "data-src", "data-file", "data-url", "data-video", "data-stream", "data-hls", "href", "srcdoc", "content"],
  });
  for (const eventName of ["play", "playing", "loadstart", "loadedmetadata"]) {
    document.addEventListener(eventName, () => scheduleScan(), true);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => handleMessage(message, sendResponse));
  window.addEventListener("message", handlePageMediaEvent);
  window.addEventListener(RESCAN_EVENT_TYPE, performExplicitRescan);
  window.postMessage({ type: LEVEL5_MEDIA_DISCOVERY_REQUEST }, "*");
  try {
    const frameStateHeartbeat = setInterval(() => reportFrameMediaState(mediaElements()), 15_000);
    frameStateHeartbeat?.unref?.();
  } catch {
    // Some test or embedded realms do not expose interval timers.
  }
  scan();
})();
