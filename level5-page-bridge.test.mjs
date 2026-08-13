import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./level5-page-bridge.js", import.meta.url), "utf8");

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
