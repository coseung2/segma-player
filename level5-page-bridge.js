(() => {
  const REQUEST = "aura-level5-key-request-v1";
  const RESPONSE = "aura-level5-key-response-v1";
  const WRAPPED_PLAYER = Symbol("aura-level5-player-wrapped");
  let decoderPromise = null;
  const observedHlsSessions = new Set();

  function errorCode(error, fallback) {
    const code = typeof error?.message === "string" ? error.message : "";
    return /^[a-z0-9-]{3,64}$/.test(code) ? code : fallback;
  }

  function bytesFor(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
  }

  function encode(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function activeHlsSessions() {
    const sessions = [...observedHlsSessions];
    for (const video of document.querySelectorAll("video")) {
      if (video?._l5?.hls?.config?.loader && !sessions.includes(video._l5.hls)) sessions.push(video._l5.hls);
    }
    return sessions;
  }

  function rememberSession(session) {
    if (session?.hls?.config?.loader) observedHlsSessions.add(session.hls);
    return session;
  }

  function wrapLevel5Player(player) {
    if (!player || typeof player.play !== "function" || player.play[WRAPPED_PLAYER]) return player;
    const original = player.play;
    const wrapped = function auraObservedLevel5Play(...args) {
      const result = original.apply(this, args);
      if (result && typeof result.then === "function") {
        result.then(rememberSession, () => {});
      } else {
        rememberSession(result);
      }
      return result;
    };
    try { Object.defineProperty(wrapped, WRAPPED_PLAYER, { value: true }); } catch { /* best effort */ }
    try { player.play = wrapped; } catch { /* a frozen player falls back to video._l5 discovery */ }
    return player;
  }

  function observeLevel5Player() {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(window, "Level5Player"); } catch { return; }
    if (descriptor?.value) wrapLevel5Player(descriptor.value);
    if (descriptor && !descriptor.configurable) return;
    let current = descriptor?.value;
    try {
      Object.defineProperty(window, "Level5Player", {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get() { return current; },
        set(value) { current = wrapLevel5Player(value); },
      });
    } catch {
      // The player remains discoverable through video._l5 when the page owns a locked property.
    }
  }

  function sameUrl(left, right) {
    try {
      return new URL(left, location.href).href === new URL(right, location.href).href;
    } catch {
      return false;
    }
  }

  function validKeyBytes(value) {
    const bytes = bytesFor(value);
    return bytes && (bytes.byteLength === 16 || bytes.byteLength === 32) ? bytes : null;
  }

  function cachedKey(hls, url) {
    const loaders = new Set();
    if (hls?.streamController?.keyLoader) loaders.add(hls.streamController.keyLoader);
    for (const controller of hls?.networkControllers || []) {
      if (controller?.keyLoader) loaders.add(controller.keyLoader);
      if (controller?.keyUriToKeyInfo) loaders.add(controller);
    }

    for (const loader of loaders) {
      const table = loader?.keyUriToKeyInfo;
      const entries = table instanceof Map ? [...table.values()] : Object.values(table || {});
      for (const info of entries) {
        if (!sameUrl(info?.decryptdata?.uri, url)) continue;
        const bytes = validKeyBytes(info?.decryptdata?.key);
        if (bytes) return bytes;
      }
    }

    const fragments = [
      hls?.streamController?.fragCurrent,
      hls?.streamController?.fragPrevious,
      hls?.streamController?.fragPlaying,
      hls?.audioStreamController?.fragCurrent,
      hls?.audioStreamController?.fragPrevious,
    ];
    for (const level of hls?.levels || []) {
      if (Array.isArray(level?.details?.fragments)) fragments.push(...level.details.fragments);
    }
    if (Array.isArray(hls?.loadLevelObj?.details?.fragments)) {
      fragments.push(...hls.loadLevelObj.details.fragments);
    }
    for (const fragment of fragments) {
      if (!sameUrl(fragment?.decryptdata?.uri, url)) continue;
      const bytes = validKeyBytes(fragment?.decryptdata?.key);
      if (bytes) return bytes;
    }
    return null;
  }

  async function waitForCachedKey(sessions, url, timeoutMs = 1_500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const hls of sessions) {
        const key = cachedKey(hls, url);
        if (key) return key;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  function inlineAssetUrl(property, fallbackPath) {
    const expression = new RegExp(`\\b${property}\\s*:\\s*(["'])(.*?)\\1`);
    for (const script of document.scripts) {
      const match = expression.exec(script.textContent || "");
      if (!match) continue;
      try {
        const url = new URL(match[2].replace(/\\\//g, "/"), location.href);
        if (url.origin === location.origin) return url.href;
      } catch {
        // Try the same-origin fallback below.
      }
    }

    const fallback = new URL(fallbackPath, location.href);
    for (const script of document.scripts) {
      try {
        const player = new URL(script.src);
        if (player.origin !== location.origin || !/\/assets\/hls\.plyr(?:\.min)?\.js$/i.test(player.pathname)) continue;
        const version = player.searchParams.get("v");
        if (version) fallback.searchParams.set("v", version);
        break;
      } catch {
        // Ignore inline scripts and invalid src values.
      }
    }
    return fallback.href;
  }

  async function level5Decoder() {
    if (!decoderPromise) {
      decoderPromise = (async () => {
        const runtimeUrl = inlineAssetUrl("wasmJs", "/assets/runtime");
        const coreUrl = inlineAssetUrl("wasmBin", "/assets/core");
        let runtime;
        try {
          runtime = await import(runtimeUrl);
        } catch {
          throw new Error("runtime-import-failed");
        }
        if (typeof runtime.default !== "function" || typeof runtime.decode_session !== "function") {
          throw new Error("runtime-exports-missing");
        }
        try {
          await runtime.default(coreUrl);
        } catch {
          throw new Error("wasm-init-failed");
        }
        return runtime.decode_session;
      })().catch((error) => {
        decoderPromise = null;
        throw error;
      });
    }
    return decoderPromise;
  }

  async function decodeRuntimeKey(url) {
    const parsed = new URL(url);
    if (!/\/v\/session$/i.test(parsed.pathname)) throw new Error("not-level5-session-key");
    const decode = await level5Decoder();
    let response;
    try {
      response = await fetch(parsed.href, { credentials: "omit", cache: "no-store" });
    } catch {
      throw new Error("key-fetch-failed");
    }
    if (!response.ok) throw new Error(`level5-key-http-${response.status}`);
    let payload;
    try {
      payload = await response.text();
    } catch {
      throw new Error("key-response-read-failed");
    }
    let decoded;
    try {
      decoded = decode(payload);
    } catch {
      throw new Error("decode-session-failed");
    }
    const bytes = validKeyBytes(decoded);
    if (!bytes) {
      throw new Error("invalid-level5-key");
    }
    return bytes;
  }

  function loadKey(hls, url) {
    return new Promise((resolve, reject) => {
      let loader;
      try {
        const Loader = hls.config.loader;
        loader = new Loader(hls.config);
        // hls.js 1.5+ XhrLoader.load() dereferences config.loadPolicy in
        // openAndSendXhr; a bare retry object crashes with a TypeError before
        // any key request is made. Mirror hls.js's own key-load contract
        // (loadKeyHTTP) with the player's keyLoadPolicy when present.
        const policy = hls.config?.keyLoadPolicy?.default;
        const maxTimeToFirstByteMs = Number.isFinite(policy?.maxTimeToFirstByteMs)
          ? policy.maxTimeToFirstByteMs
          : 8_000;
        const maxLoadTimeMs = Number.isFinite(policy?.maxLoadTimeMs)
          ? policy.maxLoadTimeMs
          : 20_000;
        loader.load({
          url,
          type: "key",
          responseType: "arraybuffer",
          keyInfo: { uri: url, method: "AES-128", keyFormat: "identity" },
        }, {
          loadPolicy: { maxTimeToFirstByteMs, maxLoadTimeMs },
          timeout: maxLoadTimeMs,
          maxRetry: 0,
          retryDelay: 0,
          maxRetryDelay: 0,
        }, {
          onSuccess(response) {
            const bytes = bytesFor(response?.data);
            if (!bytes || (bytes.byteLength !== 16 && bytes.byteLength !== 32)) {
              reject(new Error("invalid-level5-key"));
              return;
            }
            resolve(bytes);
          },
          onError() { reject(new Error("level5-key-load-failed")); },
          onTimeout() { reject(new Error("level5-key-load-timeout")); },
          onProgress() {},
        });
      } catch (error) {
        try { loader?.abort?.(); } catch { /* ignore */ }
        reject(error);
      }
    });
  }

  observeLevel5Player();

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.data?.type !== REQUEST) return;
    const requestId = typeof event.data.requestId === "string" ? event.data.requestId : "";
    let url;
    try {
      url = new URL(event.data.url);
      if (!/^https?:$/.test(url.protocol) || !requestId) throw new Error("invalid-request");
    } catch {
      return;
    }

    const sessions = activeHlsSessions();
    for (const hls of sessions) {
      const key = cachedKey(hls, url.href);
      if (!key) continue;
      window.postMessage({ type: RESPONSE, requestId, ok: true, key: encode(key) }, "*");
      return;
    }

    let failure = "level5-key-unavailable";
    try {
      const key = await decodeRuntimeKey(url.href);
      window.postMessage({ type: RESPONSE, requestId, ok: true, key: encode(key) }, "*");
      return;
    } catch (error) {
      failure = errorCode(error, failure);
      // Older Level5 builds may not expose the runtime assets used by current players.
    }

    const delayedCached = await waitForCachedKey(sessions, url.href);
    if (delayedCached) {
      window.postMessage({ type: RESPONSE, requestId, ok: true, key: encode(delayedCached) }, "*");
      return;
    }

    for (const hls of sessions) {
      try {
        const key = await loadKey(hls, url.href);
        window.postMessage({ type: RESPONSE, requestId, ok: true, key: encode(key) }, "*");
        return;
      } catch (error) {
        const cached = cachedKey(hls, url.href);
        if (cached) {
          window.postMessage({ type: RESPONSE, requestId, ok: true, key: encode(cached) }, "*");
          return;
        }
        if (failure === "not-level5-session-key" || failure === "level5-key-unavailable") {
          failure = errorCode(error, "level5-loader-failed");
        }
        // Try another active Level5 player in this frame.
      }
    }
    window.postMessage({ type: RESPONSE, requestId, ok: false, error: failure }, "*");
  });
})();
