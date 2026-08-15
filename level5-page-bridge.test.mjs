import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./level5-page-bridge.js", import.meta.url), "utf8");

// Replicates the hls.js 1.5.x XhrLoader contract: load() dereferences
// config.loadPolicy (openAndSendXhr) before issuing the request, so a bare
// retry object crashes the loader with a non-codified TypeError.
class Hls15LikeKeyLoader {
  constructor(config) {
    this.config = config;
  }

  load(context, config, callbacks) {
    if (!config?.loadPolicy) {
      throw new TypeError("Cannot read properties of undefined (reading 'maxTimeToFirstByteMs')");
    }
    assert.ok(Number.isFinite(config.loadPolicy.maxTimeToFirstByteMs));
    assert.ok(Number.isFinite(config.loadPolicy.maxLoadTimeMs));
    assert.ok(Number.isFinite(config.timeout));
    callbacks.onSuccess({
      url: context.url,
      code: 200,
      data: new Uint8Array(16).fill(0x5a).buffer,
    });
  }

  abort() {}

  destroy() {}
}

function runBridgeFor({ requestUrl, video = null, playerSession = null }) {
  return new Promise((resolve, reject) => {
    const listeners = new Set();
    const posted = [];
    let settled = false;
    const sandbox = {
      console,
      setTimeout,
      clearTimeout,
      URL,
      btoa,
      atob,
      ArrayBuffer,
      Uint8Array,
      Map,
      Set,
      location: { href: "https://player.example/watch" },
      document: {
        querySelectorAll: () => video ? [video] : [],
        scripts: [],
      },
      addEventListener(type, listener) {
        if (type === "message") listeners.add(listener);
      },
      postMessage(message) {
        posted.push(message);
        if (message?.type === "aura-level5-key-response-v1" && !settled) {
          settled = true;
          message.posted = posted;
          resolve(message);
        }
      },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: "level5-page-bridge.js" });
    // Build the event inside the context: host-constructed objects get wrapped
    // at the realm boundary, so `event.source === window` would not hold.
    const dispatch = vm.runInContext(
      "(listener, data) => listener({ source: window, data })",
      sandbox,
    );
    void (async () => {
      if (playerSession) {
        const playResult = Promise.resolve(playerSession);
        sandbox.Level5Player = { play: () => playResult };
        assert.equal(sandbox.Level5Player.play(), playResult, "the bridge must preserve the player's play result");
        await playResult;
        await Promise.resolve();
      }
      for (const listener of listeners) dispatch(listener, {
        type: "aura-level5-key-request-v1",
        requestId: "request-1",
        url: requestUrl,
      });
    })().catch(reject);
  });
}

test("loader fallback returns the decoded key under the hls.js 1.5 loadPolicy contract", async () => {
  const hls = {
    config: {
      loader: Hls15LikeKeyLoader,
      keyLoadPolicy: {
        default: { maxTimeToFirstByteMs: 8_000, maxLoadTimeMs: 20_000 },
      },
    },
  };
  const video = { _l5: { hls } };
  // The request does not match the runtime session path, so this exercises the
  // player-loader fallback the store build relies on (same failure mapping as
  // level5-key-unavailable before the loader attempt).
  const response = await runBridgeFor({
    requestUrl: "https://k.example/cast2/video/key-session?v=1&p=0",
    video,
  });

  assert.equal(response.ok, true, `expected a key, got error ${response.error}`);
  const bytes = Uint8Array.from(atob(response.key), (character) => character.charCodeAt(0));
  assert.equal(bytes.byteLength, 16);
  assert.deepEqual([...bytes], Array(16).fill(0x5a));
});

test("captures the Level5Player.play session when the player does not expose video._l5", async () => {
  const requestUrl = "https://k.example/v/session?v=video&p=0";
  const key = new Uint8Array(16).fill(0x6b);
  const hls = {
    config: { loader: Hls15LikeKeyLoader },
    streamController: {
      keyLoader: {
        keyUriToKeyInfo: new Map([[requestUrl, { decryptdata: { uri: requestUrl, key } }]]),
      },
    },
  };
  const response = await runBridgeFor({ requestUrl, playerSession: { hls } });
  assert.equal(response.ok, true, `expected a cached player key, got error ${response.error}`);
  const bytes = Uint8Array.from(atob(response.key), (character) => character.charCodeAt(0));
  assert.deepEqual([...bytes], Array(16).fill(0x6b));
});

test("reports the real Level5 HLS manifest for isolated-world detection", async () => {
  const requestUrl = "https://k.example/v/session?v=video&p=0";
  const key = new Uint8Array(16).fill(0x6b);
  const hls = {
    url: "https://k.vdnext.com/cast2/id/master.m3u8?tok=secret",
    levels: [{ url: ["https://k.vdnext.com/cast2/id/720p.m3u8?tok=secret"] }],
    config: { loader: Hls15LikeKeyLoader },
    streamController: {
      keyLoader: {
        keyUriToKeyInfo: new Map([[requestUrl, { decryptdata: { uri: requestUrl, key } }]]),
      },
    },
    on() {},
  };
  const response = await runBridgeFor({ requestUrl, playerSession: { hls } });
  const manifests = response.posted.filter((message) => message.type === "aura-media-observer-event-v1");
  assert.deepEqual(manifests.map((message) => message.url), [
    "https://k.vdnext.com/cast2/id/master.m3u8?tok=secret",
    "https://k.vdnext.com/cast2/id/720p.m3u8?tok=secret",
  ]);
});

test("Level5 bridge decodes session responses with the page runtime before loader fallback", () => {
  const runtimeDecode = source.indexOf("decodeRuntimeKey(url.href)");
  const loaderFallback = source.indexOf("for (const hls of sessions)", runtimeDecode);

  assert.notEqual(runtimeDecode, -1);
  assert.equal(loaderFallback > runtimeDecode, true);
  assert.match(source, /await import\(runtimeUrl\)/);
  assert.match(source, /runtime\.decode_session/);
  assert.match(source, /credentials:\s*"omit"/);
  assert.match(source, /cache:\s*"no-store"/);
  assert.match(source, /runtime-import-failed/);
  assert.match(source, /wasm-init-failed/);
  assert.match(source, /decode-session-failed/);
  assert.match(source, /error: failure/);
});

test("Level5 bridge reuses Hls.js decrypted key cache before requesting the key again", () => {
  const cacheLookup = source.indexOf("cachedKey(hls, url.href)");
  const runtimeFetch = source.indexOf("decodeRuntimeKey(url.href)");

  assert.equal(cacheLookup >= 0, true);
  assert.equal(runtimeFetch > cacheLookup, true);
  assert.match(source, /streamController\?\.keyLoader/);
  assert.match(source, /keyUriToKeyInfo/);
  assert.match(source, /info\?\.decryptdata\?\.key/);
  assert.match(source, /level\?\.details\?\.fragments/);
  assert.match(source, /waitForCachedKey\(sessions, url\.href\)/);
  assert.match(source, /const cached = cachedKey\(hls, url\.href\)/);
});

test("Level5 runtime assets stay on the player origin and inherit its version", () => {
  assert.match(source, /url\.origin === location\.origin/);
  assert.match(source, /player\.origin !== location\.origin/);
  assert.match(source, /fallback\.searchParams\.set\("v", version\)/);
  assert.equal(source.includes('if (!/\\/v\\/session$/i.test(parsed.pathname))'), true);
});
