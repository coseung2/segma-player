(() => {
  "use strict";

  const root = typeof window === "object" && window
    ? window
    : (typeof globalThis === "object" && globalThis ? globalThis : null);
  if (!root) return;

  const INSTALLED_KEY = "__auraMediaObserverInstalledV1";
  try {
    if (root[INSTALLED_KEY]) return;
    Object.defineProperty(root, INSTALLED_KEY, {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    });
  } catch {
    return;
  }

  const LIMITS = Object.freeze({
    maxUrlBytes: 4_096,
    maxContentTypeBytes: 128,
    maxManifestTextBytes: 1_048_576,
    maxManifestReports: 256,
    maxPlayerReports: 256,
    maxPlayerSourcesPerPass: 64,
  });
  const EVENT_TYPE = "aura-media-observer-event-v1";
  const SNAPSHOT_REQUEST_TYPE = "aura-media-observer-snapshot-request-v1";
  try {
    Object.defineProperty(root, "__auraMediaObserverProtocolV1", {
      configurable: false,
      enumerable: false,
      value: Object.freeze({
        version: 1,
        eventType: EVENT_TYPE,
        events: Object.freeze({
          manifest: "manifest",
          media: "media",
          playerSource: "player-source",
          snapshotComplete: "snapshot-complete",
        }),
        limits: LIMITS,
      }),
      writable: false,
    });
  } catch {
    // The observer itself can still operate if a hostile page owns this name.
  }

  const WRAPPED_KEY = "__auraMediaObserverWrappedV1";
  const nativeToString = Function.prototype.toString;
  const xhrState = new WeakMap();
  const reportedManifestKeys = new Set();
  const reportedManifestOrder = [];
  const playerSessionIds = new WeakMap();
  const playerSourceRecords = new Map();
  const playerSourceOrder = [];
  let nextPlayerSessionId = 1;
  let playerDiscoveryPasses = 0;
  let playerDiscoveryTimer = null;

  function isObject(value) {
    return (typeof value === "object" && value !== null) || typeof value === "function";
  }

  function boundedString(value, limit) {
    if (typeof value !== "string" || value.length > limit) return "";
    if (/[\u0000-\u001f\u007f]/.test(value)) return "";
    return value;
  }

  function boundedUrl(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > LIMITS.maxUrlBytes
      || /[\u0000-\u0020\u007f]/.test(value)) return "";
    try {
      const base = typeof root.location?.href === "string" ? root.location.href : undefined;
      const parsed = new URL(value, base);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
      parsed.hash = "";
      return parsed.href.length <= LIMITS.maxUrlBytes ? parsed.href : "";
    } catch {
      return "";
    }
  }

  function headerValue(headers, name) {
    try {
      if (headers && typeof headers.get === "function") return headers.get(name) || "";
      if (headers && typeof headers[name] === "string") return headers[name];
    } catch {
      // A page-owned Headers-like object must not affect the player.
    }
    return "";
  }

  function responseUrl(response, fallback) {
    return boundedUrl(typeof response?.url === "string" && response.url ? response.url : fallback);
  }

  function mimeType(value) {
    return boundedString(typeof value === "string" ? value : "", LIMITS.maxContentTypeBytes);
  }

  function manifestLike(contentType, text) {
    const lowerType = contentType.toLowerCase();
    if (/(?:mpegurl|dash\+xml|smooth-streaming|vnd\.apple|application\/xml|text\/xml)/i.test(lowerType)) {
      return true;
    }
    return /#EXTM3U|#EXT-X-[A-Z0-9-]+|<MPD(?:\s|>)|<SmoothStreamingMedia(?:\s|>)/i.test(text);
  }

  function manifestUrlLike(url) {
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      return pathname.endsWith(".m3u8") || pathname.endsWith(".mpd");
    } catch {
      return false;
    }
  }

  function mediaLike(contentType) {
    return /^(?:video|audio)\//i.test(contentType)
      || /(?:octet-stream|mp4|webm|quicktime)/i.test(contentType);
  }

  function rememberManifest(key) {
    if (reportedManifestKeys.has(key)) return false;
    reportedManifestKeys.add(key);
    reportedManifestOrder.push(key);
    while (reportedManifestOrder.length > LIMITS.maxManifestReports) {
      reportedManifestKeys.delete(reportedManifestOrder.shift());
    }
    return true;
  }

  function postEvent(payload, transfer = []) {
    if (typeof root.postMessage !== "function") return false;
    const message = Object.assign({ type: EVENT_TYPE }, payload);
    try {
      if (transfer.length) root.postMessage(message, "*", transfer);
      else root.postMessage(message, "*");
      return true;
    } catch {
      return false;
    }
  }

  function reportManifest(url, contentType, text, source, truncated = false) {
    const boundedResourceUrl = boundedUrl(url);
    const boundedContentType = mimeType(contentType);
    const boundedText = typeof text === "string"
      ? text.slice(0, LIMITS.maxManifestTextBytes)
      : "";
    if (!boundedResourceUrl || (!manifestUrlLike(boundedResourceUrl)
      && !manifestLike(boundedContentType, boundedText))) return;
    const key = `${boundedResourceUrl}\u0000${boundedContentType}`;
    if (!rememberManifest(key)) return;
    postEvent({
      kind: "manifest",
      source,
      url: boundedResourceUrl,
      contentType: boundedContentType,
      // The isolated detector only needs the canonical URL and MIME type.
      // Keeping playlist bodies out of the page bridge reduces message volume
      // and avoids retaining media metadata longer than necessary.
      truncated: Boolean(truncated || (typeof text === "string" && text.length > boundedText.length)),
    });
  }

  function reportMedia(url, contentType, source) {
    const boundedResourceUrl = boundedUrl(url);
    const boundedContentType = mimeType(contentType);
    if (!boundedResourceUrl || !mediaLike(boundedContentType)) return;
    const key = `media\u0000${boundedResourceUrl}\u0000${boundedContentType}`;
    if (!rememberManifest(key)) return;
    postEvent({
      kind: "media",
      source,
      url: boundedResourceUrl,
      contentType: boundedContentType,
    });
  }

  function safeToken(value, fallback = "") {
    return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value)
      ? value
      : fallback;
  }

  function playerSessionId(value, prefix = "player") {
    if (!isObject(value)) return "";
    const existing = playerSessionIds.get(value);
    if (existing) return existing;
    const sessionId = `${safeToken(prefix, "player")}:${nextPlayerSessionId++}`;
    playerSessionIds.set(value, sessionId);
    return sessionId;
  }

  function playerSourceKey(record) {
    return `${record.player}\u0000${record.sessionId}\u0000${record.url}`;
  }

  function rememberPlayerSource(record) {
    const key = playerSourceKey(record);
    if (!playerSourceRecords.has(key)) playerSourceOrder.push(key);
    playerSourceRecords.set(key, record);
    while (playerSourceOrder.length > LIMITS.maxPlayerReports) {
      const oldest = playerSourceOrder.shift();
      playerSourceRecords.delete(oldest);
    }
  }

  function emitPlayerSource(record, extra = {}) {
    return postEvent({
      kind: "player-source",
      source: "player-adapter",
      url: record.url,
      contentType: record.contentType,
      player: record.player,
      sessionId: record.sessionId,
      confidence: record.confidence,
      observedAt: record.observedAt,
      ...extra,
    });
  }

  function reportPlayerSource(url, {
    player = "generic",
    session = null,
    sessionId = "",
    contentType = "",
    confidence = 90,
  } = {}) {
    const boundedResourceUrl = boundedUrl(url);
    if (!boundedResourceUrl) return false;
    const normalizedPlayer = safeToken(player, "generic");
    const normalizedSession = safeToken(sessionId, "")
      || playerSessionId(session, normalizedPlayer);
    const normalizedContentType = mimeType(contentType);
    const normalizedConfidence = Number.isFinite(confidence)
      ? Math.max(0, Math.min(100, Math.round(confidence)))
      : 90;
    const record = Object.freeze({
      url: boundedResourceUrl,
      contentType: normalizedContentType,
      player: normalizedPlayer,
      sessionId: normalizedSession,
      confidence: normalizedConfidence,
      observedAt: Date.now(),
    });
    const key = playerSourceKey(record);
    const previous = playerSourceRecords.get(key);
    rememberPlayerSource(record);
    if (previous && previous.url === record.url && previous.contentType === record.contentType) return true;
    return emitPlayerSource(record);
  }

  function sourceEntries(value, depth = 0, result = []) {
    if (result.length >= LIMITS.maxPlayerSourcesPerPass || depth > 3 || value == null) return result;
    if (typeof value === "string") {
      result.push({ url: value, contentType: "" });
      return result;
    }
    if (Array.isArray(value)) {
      for (const item of value) sourceEntries(item, depth + 1, result);
      return result;
    }
    if (!isObject(value)) return result;
    let url = "";
    let contentType = "";
    try {
      url = typeof value.src === "string" ? value.src
        : typeof value.file === "string" ? value.file
          : typeof value.url === "string" ? value.url
            : typeof value.streaming_url === "string" ? value.streaming_url
              : typeof value.streamingUrl === "string" ? value.streamingUrl
                : typeof value.playback_url === "string" ? value.playback_url
                  : typeof value.playbackUrl === "string" ? value.playbackUrl
                    : typeof value.manifest_url === "string" ? value.manifest_url
                      : typeof value.manifestUrl === "string" ? value.manifestUrl : "";
      contentType = typeof value.type === "string" ? value.type
        : typeof value.mimeType === "string" ? value.mimeType : "";
    } catch {
      return result;
    }
    if (url) result.push({ url, contentType });
    for (const name of [
      "source",
      "sources",
      "playlist",
      "levels",
      "tracks",
      "media",
      "config",
      "stream",
      "streams",
      "streaming",
      "playback",
      "manifest",
      "hls",
    ]) {
      try {
        if (value[name] !== undefined && value[name] !== value) sourceEntries(value[name], depth + 1, result);
      } catch {
        // A player-owned getter must not affect playback.
      }
    }
    return result;
  }

  function reportSourceEntries(value, options) {
    const seen = new Set();
    for (const entry of sourceEntries(value)) {
      const url = boundedUrl(entry.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      reportPlayerSource(url, { ...options, contentType: entry.contentType || options?.contentType || "" });
    }
  }

  function decodedStructuredUrl(value) {
    if (typeof value !== "string" || value.length > LIMITS.maxUrlBytes * 2) return "";
    const decoded = value
      .replace(/\\\//g, "/")
      .replace(/\\u([0-9a-f]{4})/gi, (_match, code) => String.fromCharCode(Number.parseInt(code, 16)))
      .replace(/\\\\/g, "\\");
    return boundedUrl(decoded);
  }

  function inferredStructuredContentType(url) {
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname.toLowerCase();
      const search = parsed.search.toLowerCase();
      if (pathname.endsWith(".mpd") || /(?:^|[?&])(?:type|format|kind)=(?:dash|mpd)\b/.test(search)) {
        return "application/dash+xml";
      }
      if (pathname.endsWith(".m3u8") || /(?:^|[?&])(?:type|format|kind)=(?:hls|m3u8)\b/.test(search)
        || /(?:^|\/)(?:hls|playlist|manifest)(?:\/|$)/.test(pathname)) {
        return "application/vnd.apple.mpegurl";
      }
      if (pathname.endsWith(".webm")) return "video/webm";
      if (pathname.endsWith(".mp4") || pathname.endsWith(".m4v")) return "video/mp4";
      if (/\.(?:aac|m4a|mp3|ogg|opus)$/i.test(pathname)) return "audio/mpeg";
    } catch {
      return "";
    }
    return "";
  }

  function decodeRadix62(token, radix) {
    let val = 0;
    for (let i = 0; i < token.length; i += 1) {
      const code = token.charCodeAt(i);
      let digit = 0;
      if (code >= 48 && code <= 57) digit = code - 48;
      else if (code >= 97 && code <= 122) digit = code - 97 + 10;
      else if (code >= 65 && code <= 90) digit = code - 65 + 36;
      else return null;
      if (digit >= radix) return null;
      val = val * radix + digit;
    }
    return val;
  }

  function unpackPackerScripts(text) {
    if (typeof text !== "string" || text.length === 0 || text.length > 2_000_000) return "";
    const pattern = /\be[v]al\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,[^\)]+\)[\s\S]*?\}\s*\(\s*(['"])((?:\\.|[^\\])*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])((?:\\.|[^\\])*?)\5\.split\s*\(\s*['"]\|['"]\s*\)/gi;
    let match;
    const results = [];
    while ((match = pattern.exec(text))) {
      try {
        const payload = match[2]
          .replace(/\\'/g, "'")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
        const radix = Number.parseInt(match[3], 10);
        const count = Number.parseInt(match[4], 10);
        const keywords = match[6].split("|");
        if (!Number.isInteger(radix) || radix < 2 || radix > 62 || !keywords.length) continue;
        const unpacked = payload.replace(/\b[0-9a-zA-Z]+\b/g, (token) => {
          const index = decodeRadix62(token, radix);
          if (index === null || index >= keywords.length) return token;
          const word = keywords[index];
          return word !== "" ? word : token;
        });
        results.push(unpacked);
      } catch {
        // Ignore malformed packer blocks
      }
    }
    return results.join("\n");
  }

  function decodeHexEscapedScript(text) {
    if (typeof text !== "string" || !text.includes("\\x")) return "";
    const hexRe = /(?:\\x[0-9a-fA-F]{2}){6,}/g;
    let match;
    const results = [];
    while ((match = hexRe.exec(text))) {
      try {
        const decoded = match[0].replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
          String.fromCharCode(Number.parseInt(hex, 16))
        );
        if (decoded.length <= 4096 && (/^https?:\/\//i.test(decoded) || /\.(?:m3u8|mpd|mp4|m4v|webm)/i.test(decoded))) {
          results.push(decoded);
        }
      } catch {
        // Ignore malformed hex blocks
      }
    }
    return results.join("\n");
  }

  function decodeReversedUrls(text) {
    if (typeof text !== "string" || text.length === 0 || text.length > 2_000_000) return "";
    const pattern = /(["'])([A-Za-z0-9_.:~%/?&=+\-]{12,2048})\1/g;
    let match;
    const results = [];
    while ((match = pattern.exec(text))) {
      const candidate = match[2];
      if (candidate.includes("://") || candidate.startsWith("http")) continue;
      const reversed = candidate.split("").reverse().join("");
      if (/^https?:\/\/[^\s"'<>\\`]+\.(?:m3u8|mpd|mp4|m4v|webm)(?:\?[^\s"'<>\\`]*)?$/i.test(reversed)
        || (/^https?:\/\/[^\s"'<>\\`]+/i.test(reversed) && /(?:^|[?&])(?:type|format|kind)=(?:hls|m3u8|dash|mpd)\b/i.test(reversed))) {
        results.push(reversed);
      }
    }
    return results.join("\n");
  }

  function decodePercentEscapedUrls(text) {
    if (typeof text !== "string" || !text.includes("%")) return "";
    const percentRe = /(?:https?|%[0-9a-fA-F]{2})(?:[A-Za-z0-9._~:/?@!$&()*+,;=%\-]|%[0-9a-fA-F]{2}){5,4090}/g;
    let match;
    const results = [];
    while ((match = percentRe.exec(text))) {
      try {
        let decoded = match[0];
        for (let pass = 0; pass < 2 && decoded.includes("%"); pass += 1) {
          try {
            const next = decodeURIComponent(decoded);
            if (next === decoded) break;
            decoded = next;
          } catch {
            break;
          }
        }
        if (decoded.length <= 4096 && (/^https?:\/\//i.test(decoded) || /\.(?:m3u8|mpd|mp4|m4v|webm)/i.test(decoded))) {
          results.push(decoded);
        }
      } catch {
        // Ignore invalid percent encoding
      }
    }
    return results.join("\n");
  }

  function decodeBase64JsonConfigs(text) {
    if (typeof text !== "string" || text.length === 0 || text.length > 2_000_000) return "";
    const b64Re = /(?:["']|:\s*)([A-Za-z0-9+/_-]{16,}={0,2})(?:["']|[\s;,}\]]|$)/g;
    let match;
    const results = [];
    while ((match = b64Re.exec(text))) {
      try {
        const rawB64 = match[1];
        if (rawB64.length > 333_336) continue;
        let decoded = "";
        try {
          const normalized = rawB64.replace(/-/g, "+").replace(/_/g, "/");
          if (normalized.length % 4 === 1) continue;
          const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
          decoded = atob(padded).trim();
        } catch {
          continue;
        }
        if ((decoded.startsWith("{") || decoded.startsWith("[")) && decoded.length <= 250_000) {
          results.push(decoded);
        }
      } catch {
        // Ignore invalid base64
      }
    }
    return results.join("\n");
  }

  function deobfuscateScriptText(text) {
    if (typeof text !== "string" || !text) return "";
    const unpacked = unpackPackerScripts(text);
    const decodedHex = decodeHexEscapedScript(text);
    const reversed = decodeReversedUrls(text);
    const percent = decodePercentEscapedUrls(text);
    const b64Json = decodeBase64JsonConfigs(text);
    return [unpacked, decodedHex, reversed, percent, b64Json].filter(Boolean).join("\n");
  }

  function reportStructuredSources(text) {
    if (typeof text !== "string") return;
    const trimmed = text.trim();
    const deobfuscated = deobfuscateScriptText(text);
    const sourceTexts = [];
    if (trimmed[0] === "{" || trimmed[0] === "[") {
      sourceTexts.push({ text: trimmed, player: "api-json", confidence: 98 });
    }
    if (deobfuscated) {
      sourceTexts.push({ text: deobfuscated, player: "static-config", confidence: 94 });
    }
    if (!sourceTexts.length) return;
    const pattern = /"(?:streaming_url|streamingUrl|playback_url|playbackUrl|manifest_url|manifestUrl|hls_url|hlsUrl|play_url|playUrl|video_url|videoUrl|source_url|sourceUrl|playlist|file|src|url|source)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
    let reported = 0;
    const reportedUrls = new Set();
    for (const source of sourceTexts) {
      pattern.lastIndex = 0;
      for (const match of source.text.matchAll(pattern)) {
        const url = decodedStructuredUrl(match[1]);
        const contentType = inferredStructuredContentType(url);
        if (!url || !contentType || reportedUrls.has(url)) continue;
        reportPlayerSource(url, {
          player: source.player,
          contentType,
          confidence: source.confidence,
        });
        reportedUrls.add(url);
        reported += 1;
        if (reported >= LIMITS.maxPlayerSourcesPerPass) return;
      }
    }
    if (!deobfuscated) return;
    const directRe = /https?:\/\/[^\s"'<>\\`]+/gi;
    for (const match of deobfuscated.matchAll(directRe)) {
      const url = boundedUrl(match[0]);
      const contentType = inferredStructuredContentType(url);
      if (!url || !contentType || reportedUrls.has(url)) continue;
      reportPlayerSource(url, {
        player: "static-config",
        contentType,
        confidence: 94,
      });
      reportedUrls.add(url);
      reported += 1;
      if (reported >= LIMITS.maxPlayerSourcesPerPass) return;
    }
  }

  async function readBoundedText(response) {
    const contentLength = Number.parseInt(headerValue(response?.headers, "content-length"), 10);
    if (Number.isInteger(contentLength) && contentLength > LIMITS.maxManifestTextBytes) {
      return { text: "", truncated: true };
    }

    const body = response?.body;
    if (body && typeof body.getReader === "function") {
      let reader;
      let text = "";
      let bytesRead = 0;
      let truncated = false;
      try {
        reader = body.getReader();
        const decoder = typeof TextDecoder === "function" ? new TextDecoder() : null;
        while (true) {
          const step = await reader.read();
          if (!step || step.done) break;
          const value = step.value;
          const byteLength = Number.isInteger(value?.byteLength) ? value.byteLength : 0;
          const remaining = LIMITS.maxManifestTextBytes - bytesRead;
          if (byteLength > remaining) {
            if (remaining > 0 && decoder && value) {
              text += decoder.decode(value.subarray ? value.subarray(0, remaining) : value, { stream: true });
            }
            bytesRead = LIMITS.maxManifestTextBytes;
            truncated = true;
            try { await reader.cancel(); } catch { /* ignore cancellation failures */ }
            break;
          }
          bytesRead += byteLength;
          if (decoder && value) text += decoder.decode(value, { stream: true });
          if (bytesRead >= LIMITS.maxManifestTextBytes) {
            truncated = true;
            try { await reader.cancel(); } catch { /* ignore cancellation failures */ }
            break;
          }
        }
        if (decoder && !truncated) text += decoder.decode();
        return { text: text.slice(0, LIMITS.maxManifestTextBytes), truncated };
      } catch {
        return { text: "", truncated: false };
      } finally {
        try { reader?.releaseLock?.(); } catch { /* ignore release failures */ }
      }
    }

    if (typeof response?.text !== "function") return { text: "", truncated: false };
    try {
      const text = await response.text();
      if (typeof text !== "string") return { text: "", truncated: false };
      return {
        text: text.slice(0, LIMITS.maxManifestTextBytes),
        truncated: text.length > LIMITS.maxManifestTextBytes,
      };
    } catch {
      return { text: "", truncated: false };
    }
  }

  async function observeFetchResponse(response, fallbackUrl) {
    if (!isObject(response)) return;
    const url = responseUrl(response, fallbackUrl);
    if (!url) return;
    const contentType = mimeType(headerValue(response.headers, "content-type"));
    if (mediaLike(contentType)) {
      reportMedia(url, contentType, "fetch");
      return;
    }
    const clone = typeof response.clone === "function" ? (() => {
      try { return response.clone(); } catch { return null; }
    })() : null;
    if (!clone) return;
    const body = await readBoundedText(clone);
    reportManifest(url, contentType, body.text, "fetch", body.truncated);
    reportStructuredSources(body.text);
  }

  function fetchUrl(input) {
    if (typeof input === "string") return boundedUrl(input);
    if (input && typeof input.url === "string") return boundedUrl(input.url);
    if (input && typeof input.href === "string") return boundedUrl(input.href);
    return "";
  }

  function observeFetchPromise(result, requestUrl) {
    if (!result || typeof result.then !== "function") return;
    try {
      const observed = result.then((response) => {
        void observeFetchResponse(response, requestUrl).catch(() => {});
      }, () => {});
      if (observed && typeof observed.catch === "function") observed.catch(() => {});
    } catch {
      // A custom thenable must not alter fetch behavior.
    }
  }

  function preserveNativeShape(wrapper, original) {
    try {
      Object.defineProperty(wrapper, "name", {
        configurable: true,
        value: original.name,
      });
    } catch { /* best effort */ }
    try {
      Object.defineProperty(wrapper, "length", {
        configurable: true,
        value: original.length,
      });
    } catch { /* best effort */ }
    try {
      Object.defineProperty(wrapper, "toString", {
        configurable: true,
        value() { return nativeToString.call(original); },
      });
    } catch { /* best effort */ }
    try {
      Object.defineProperty(wrapper, WRAPPED_KEY, {
        configurable: false,
        enumerable: false,
        value: true,
        writable: false,
      });
    } catch { /* best effort */ }
    return wrapper;
  }

  function installOwnFunction(target, name, makeWrapper) {
    if (!target) return;
    let original;
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(target, name);
      original = descriptor?.value || target[name];
    } catch {
      return;
    }
    if (typeof original !== "function" || original[WRAPPED_KEY]) return;
    const wrapper = preserveNativeShape(makeWrapper(original), original);
    try {
      if (descriptor && "value" in descriptor) {
        Object.defineProperty(target, name, { ...descriptor, value: wrapper });
      } else {
        target[name] = wrapper;
      }
    } catch {
      // A page may expose a non-configurable host method. Leave it untouched.
    }
  }

  function installFetchHook() {
    installOwnFunction(root, "fetch", (original) => function auraObservedFetch(...args) {
      const requestUrl = fetchUrl(args[0]);
      const result = original.apply(this, args);
      if (requestUrl) observeFetchPromise(result, requestUrl);
      return result;
    });
  }

  function xhrResponseTypeIsText(xhr) {
    try {
      return !xhr.responseType || xhr.responseType === "text";
    } catch {
      return false;
    }
  }

  function observeXhr(xhr, requestUrl) {
    let text = "";
    let contentType = "";
    let responseUrl = requestUrl;
    try {
      contentType = typeof xhr.getResponseHeader === "function"
        ? xhr.getResponseHeader("content-type") || ""
        : "";
      if (typeof xhr.responseURL === "string" && xhr.responseURL) responseUrl = xhr.responseURL;
      if (mediaLike(contentType)) {
        reportMedia(responseUrl, contentType, "xhr");
        return;
      }
      if (!xhrResponseTypeIsText(xhr)) return;
      text = typeof xhr.responseText === "string" ? xhr.responseText : "";
    } catch {
      return;
    }
    const boundedText = text.slice(0, LIMITS.maxManifestTextBytes);
    reportManifest(responseUrl, contentType, boundedText, "xhr",
      text.length > LIMITS.maxManifestTextBytes);
    reportStructuredSources(boundedText);
  }

  function installXhrHook() {
    const Xhr = root.XMLHttpRequest;
    const prototype = Xhr?.prototype;
    if (!prototype) return;

    installOwnFunction(prototype, "open", (original) => function auraObservedXhrOpen(...args) {
      const result = original.apply(this, args);
      const previous = xhrState.get(this);
      try {
        if (previous?.listener && typeof this.removeEventListener === "function") {
          this.removeEventListener("load", previous.listener);
        }
      } catch {
        // A reused XHR may expose a page-owned event implementation.
      }
      const requestUrl = fetchUrl(args[1]);
      xhrState.set(this, { requestUrl, listener: null });
      return result;
    });

    installOwnFunction(prototype, "send", (original) => function auraObservedXhrSend(...args) {
      const state = xhrState.get(this);
      if (state && typeof this.addEventListener === "function") {
        try {
          if (state.listener && typeof this.removeEventListener === "function") {
            this.removeEventListener("load", state.listener);
          }
          state.listener = () => observeXhr(this, state.requestUrl);
          this.addEventListener("load", state.listener);
        } catch {
          state.listener = null;
        }
      }
      return original.apply(this, args);
    });
  }

  function reportHlsSession(hls, player = "hls.js", confidence = 98) {
    if (!isObject(hls)) return;
    const options = {
      player,
      session: hls,
      contentType: "application/vnd.apple.mpegurl",
      confidence,
    };
    try { reportPlayerSource(hls.url, options); } catch { /* player-owned getter */ }
    try { reportPlayerSource(hls.sourceUrl, options); } catch { /* player-owned getter */ }
    try { reportSourceEntries(hls.levels, options); } catch { /* player-owned getter */ }
    try { reportSourceEntries(hls.audioTracks, { ...options, confidence: confidence - 4 }); } catch { /* player-owned getter */ }
    try { reportSourceEntries(hls.subtitleTracks, { ...options, confidence: confidence - 10 }); } catch { /* player-owned getter */ }
    try { reportSourceEntries(hls.loadLevelObj, options); } catch { /* player-owned getter */ }
  }

  function installHlsAdapter(Hls, player = "hls.js") {
    const prototype = Hls?.prototype;
    if (!prototype) return;
    installOwnFunction(prototype, "loadSource", (original) => function auraObservedHlsLoadSource(...args) {
      reportPlayerSource(args[0], {
        player,
        session: this,
        contentType: "application/vnd.apple.mpegurl",
        confidence: 100,
      });
      const result = original.apply(this, args);
      reportHlsSession(this, player, 100);
      return result;
    });
    installOwnFunction(prototype, "startLoad", (original) => function auraObservedHlsStartLoad(...args) {
      reportHlsSession(this, player, 98);
      return original.apply(this, args);
    });
  }

  function inspectVideoJsPlayer(player) {
    if (!isObject(player)) return;
    const options = { player: "video.js", session: player, confidence: 95 };
    try { reportSourceEntries(player.currentSources?.(), options); } catch { /* optional API */ }
    try { reportSourceEntries(player.currentSource?.(), options); } catch { /* optional API */ }
    try {
      const source = player.src?.();
      if (typeof source === "string") reportPlayerSource(source, options);
      else reportSourceEntries(source, options);
    } catch { /* optional API */ }
    try {
      const tech = player.tech?.({ IWillNotUseThisInPlugins: true });
      reportHlsSession(tech?.vhs || tech?.hls, "video.js", 98);
    } catch { /* optional API */ }
  }

  function inspectVideoJs() {
    const videojs = root.videojs;
    if (!videojs) return;
    try {
      const players = videojs.getPlayers?.();
      for (const player of Object.values(players || {})) inspectVideoJsPlayer(player);
    } catch {
      // A custom videojs facade must not affect the page.
    }
  }

  function inspectJwPlayer(player) {
    if (!isObject(player)) return;
    const options = { player: "jwplayer", session: player, confidence: 96 };
    try { reportSourceEntries(player.getPlaylistItem?.(), options); } catch { /* optional API */ }
    try { reportSourceEntries(player.getPlaylist?.(), options); } catch { /* optional API */ }
    try { reportSourceEntries(player.getConfig?.(), options); } catch { /* optional API */ }
    installOwnFunction(player, "setup", (original) => function auraObservedJwSetup(...args) {
      reportSourceEntries(args[0], { player: "jwplayer", session: this, confidence: 98 });
      const result = original.apply(this, args);
      inspectJwPlayer(result || this);
      return result;
    });
  }

  function installJwPlayerAdapter() {
    installOwnFunction(root, "jwplayer", (original) => function auraObservedJwPlayer(...args) {
      const player = original.apply(this, args);
      inspectJwPlayer(player);
      return player;
    });
    try {
      const players = root.jwplayer?.api?.players;
      for (const player of Array.isArray(players) ? players : Object.values(players || {})) inspectJwPlayer(player);
    } catch {
      // Ignore nonstandard registries.
    }
  }

  function inspectPlyr(player, media = null) {
    if (!isObject(player)) return;
    const options = { player: "plyr", session: player, confidence: 90 };
    try { reportSourceEntries(player.source, options); } catch { /* optional API */ }
    try { reportSourceEntries(player.config?.sources, options); } catch { /* optional API */ }
    try { reportSourceEntries(player.media?.querySelectorAll?.("source"), options); } catch { /* optional API */ }
    try {
      const source = player.media?.currentSrc || player.media?.src || media?.currentSrc || media?.src;
      reportPlayerSource(source, options);
    } catch { /* optional API */ }
  }

  function inspectMediaElements() {
    const documentObject = root.document;
    if (!documentObject?.querySelectorAll) return;
    let elements = [];
    try { elements = [...documentObject.querySelectorAll("video, audio")]; } catch { return; }
    for (const media of elements) {
      try {
        const level5Hls = media?._l5?.hls;
        if (level5Hls) reportHlsSession(level5Hls, "level5", 100);
      } catch { /* optional Level5 internals */ }
      try {
        const attachedHls = media?._hls || media?.hls || media?.__hls;
        if (attachedHls) reportHlsSession(attachedHls, "hls.js", 98);
      } catch { /* optional hls.js attachment */ }
      try {
        const plyr = media?.plyr || media?._plyr || media?.__plyr;
        if (plyr) inspectPlyr(plyr, media);
      } catch { /* optional Plyr attachment */ }
    }
  }

  function reportInlineLevel5Sources() {
    let scripts = [];
    try { scripts = [...(root.document?.scripts || [])]; } catch { return; }
    const sourcePattern = /\burl\s*:\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/g;
    for (const script of scripts) {
      const text = typeof script?.textContent === "string" ? script.textContent : "";
      if (!/Level5Player\s*\.\s*play\s*\(/.test(text)) continue;
      let match;
      while ((match = sourcePattern.exec(text))) {
        const raw = match[2].replace(/\\\//g, "/");
        try {
          const url = new URL(raw, root.location?.href);
          if (!/^https?:$/.test(url.protocol) || url.href.length > LIMITS.maxUrlBytes) continue;
          reportPlayerSource(url.href, {
            player: "level5",
            contentType: "application/vnd.apple.mpegurl",
            confidence: 100,
          });
        } catch {
          // Ignore non-URL player options.
        }
      }
    }
  }

  function discoverPlayerAdapters() {
    playerDiscoveryPasses += 1;
    try { reportInlineLevel5Sources(); } catch { /* optional inline config */ }
    try { installHlsAdapter(root.Hls, "hls.js"); } catch { /* optional player */ }
    try { installHlsAdapter(root.hls?.constructor, "hls.js"); } catch { /* optional player */ }
    try { inspectVideoJs(); } catch { /* optional player */ }
    try { installJwPlayerAdapter(); } catch { /* optional player */ }
    try { inspectMediaElements(); } catch { /* optional player */ }
    if (playerDiscoveryPasses >= 60 && playerDiscoveryTimer !== null) {
      try { root.clearInterval?.(playerDiscoveryTimer); } catch { /* ignore */ }
      playerDiscoveryTimer = null;
    }
  }

  function snapshotMatches(record, request) {
    const player = safeToken(request?.player, "");
    const sessionId = safeToken(request?.sessionId, "");
    if (player && record.player !== player) return false;
    // The same player session may rotate CDN hosts or manifest paths while
    // refreshing a short-lived token. A stable session id is stronger than the
    // old URL shape, so do not reject that rotation here.
    if (sessionId) return record.sessionId === sessionId;
    if (typeof request?.resourceUrl !== "string" || !request.resourceUrl) return true;
    const requested = boundedUrl(request.resourceUrl);
    if (!requested) return true;
    try {
      const left = new URL(record.url);
      const right = new URL(requested);
      return left.origin === right.origin && left.pathname === right.pathname;
    } catch {
      return true;
    }
  }

  function handleSnapshotRequest(event) {
    if (event.source !== root || event.data?.type !== SNAPSHOT_REQUEST_TYPE) return;
    const requestId = safeToken(event.data.requestId, "");
    if (!requestId) return;
    discoverPlayerAdapters();
    let count = 0;
    for (const record of playerSourceRecords.values()) {
      if (!snapshotMatches(record, event.data)) continue;
      emitPlayerSource(record, { requestId, snapshot: true });
      count += 1;
      if (count >= LIMITS.maxPlayerSourcesPerPass) break;
    }
    postEvent({ kind: "snapshot-complete", requestId, count });
  }

  installFetchHook();
  installXhrHook();
  discoverPlayerAdapters();
  try { root.addEventListener?.("message", handleSnapshotRequest); } catch { /* optional */ }
  for (const eventName of ["DOMContentLoaded", "load", "play", "playing", "loadedmetadata"]) {
    try { root.addEventListener?.(eventName, discoverPlayerAdapters, true); } catch { /* optional */ }
  }
  try {
    if (typeof root.setInterval === "function") {
      playerDiscoveryTimer = root.setInterval(discoverPlayerAdapters, 1_000);
    }
  } catch {
    playerDiscoveryTimer = null;
  }
})();
