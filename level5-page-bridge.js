(() => {
  const REQUEST = "aura-level5-key-request-v1";
  const RESPONSE = "aura-level5-key-response-v1";
  let decoderPromise = null;

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
    const sessions = [];
    for (const video of document.querySelectorAll("video")) {
      if (video?._l5?.hls?.config?.loader) sessions.push(video._l5.hls);
    }
    return sessions;
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

    for (const fragment of [
      hls?.streamController?.fragCurrent,
      hls?.streamController?.fragPrevious,
      hls?.streamController?.fragPlaying,
    ]) {
      if (!sameUrl(fragment?.decryptdata?.uri, url)) continue;
      const bytes = validKeyBytes(fragment?.decryptdata?.key);
      if (bytes) return bytes;
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
        loader.load({
          url,
          type: "key",
          responseType: "arraybuffer",
          keyInfo: { uri: url, method: "AES-128", keyFormat: "identity" },
        }, {
          timeout: 15_000,
          maxRetry: 1,
          retryDelay: 250,
          maxRetryDelay: 1_000,
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

    for (const hls of sessions) {
      try {
        const key = await loadKey(hls, url.href);
        window.postMessage({ type: RESPONSE, requestId, ok: true, key: encode(key) }, "*");
        return;
      } catch (error) {
        if (failure === "not-level5-session-key" || failure === "level5-key-unavailable") {
          failure = errorCode(error, "level5-loader-failed");
        }
        // Try another active Level5 player in this frame.
      }
    }
    window.postMessage({ type: RESPONSE, requestId, ok: false, error: failure }, "*");
  });
})();
