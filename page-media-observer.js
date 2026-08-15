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
  });
  const EVENT_TYPE = "aura-media-observer-event-v1";
  try {
    Object.defineProperty(root, "__auraMediaObserverProtocolV1", {
      configurable: false,
      enumerable: false,
      value: Object.freeze({
        version: 1,
        eventType: EVENT_TYPE,
        events: Object.freeze({ manifest: "manifest", media: "media" }),
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
    if (!boundedResourceUrl || !manifestLike(boundedContentType, boundedText)) return;
    const key = `${boundedResourceUrl}\u0000${boundedContentType}`;
    if (!rememberManifest(key)) return;
    postEvent({
      kind: "manifest",
      source,
      url: boundedResourceUrl,
      contentType: boundedContentType,
      text: boundedText,
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
    reportManifest(responseUrl, contentType, text.slice(0, LIMITS.maxManifestTextBytes), "xhr",
      text.length > LIMITS.maxManifestTextBytes);
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

  installFetchHook();
  installXhrHook();
})();
