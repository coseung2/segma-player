import test from "node:test";
import assert from "node:assert/strict";

import {
  createRequestHeaderStore,
  dnrRequestHeaderOperations,
  replayHeaderViews,
  replayableFetchHeaders,
} from "./request-header-store.js";

const pageUrl = "https://player.example/watch";
const mediaUrl = (token, path = "/video.mp4") => "https://cdn.example" + path + "?token=" + token;

function context(tabId = 7, frameId = 0, initiator = pageUrl) {
  return { tabId, frameId, initiator };
}

test("same-origin exact replay separates fetch headers from DNR operations", () => {
  let now = 1_000;
  const store = createRequestHeaderStore({ now: () => now, ttlMs: 10_000 });
  const url = mediaUrl("one");
  assert.equal(store.record({
    url: "https://CDN.example:443/video.mp4?token=one",
    ...context(),
    headers: {
      Referer: pageUrl,
      Origin: "https://player.example",
      "Accept-Language": "ko-KR,ko;q=0.9",
      Authorization: "Bearer HEADER_SECRET",
      Cookie: "sid=COOKIE_SECRET",
      "X-Auth-Token": "TOKEN_SECRET",
    },
  }), true);

  const replay = store.lookup(url, context());
  assert.equal(replay.matchedBy, "exact");
  assert.deepEqual(replay.fetchHeaders, {
    "Accept-Language": "ko-KR,ko;q=0.9",
  });
  assert.deepEqual(replay.dnrRequestHeaders, [
    { header: "Referer", operation: "set", value: pageUrl },
    { header: "Origin", operation: "set", value: "https://player.example" },
    { header: "Accept-Language", operation: "set", value: "ko-KR,ko;q=0.9" },
    { header: "Authorization", operation: "set", value: "Bearer HEADER_SECRET" },
    { header: "Cookie", operation: "set", value: "sid=COOKIE_SECRET" },
    { header: "x-auth-token", operation: "set", value: "TOKEN_SECRET" },
  ]);
  assert.equal(now, 1_000);
});

test("exact token URLs stay separated and origin-path fallback withholds credentials", () => {
  const store = createRequestHeaderStore({ now: () => 100 });
  const first = mediaUrl("first");
  const second = mediaUrl("second");
  const lookupContext = context(9, 1);

  assert.equal(store.record({
    url: first,
    ...lookupContext,
    headers: { Authorization: "Bearer FIRST", Cookie: "sid=FIRST", "Accept-Language": "en-US" },
  }), true);
  assert.equal(store.record({
    url: second,
    ...lookupContext,
    headers: { Authorization: "Bearer SECOND", Cookie: "sid=SECOND", "Accept-Language": "fr-FR" },
  }), true);

  assert.equal(
    store.lookup(first, lookupContext).dnrRequestHeaders.find((entry) => entry.header === "Authorization").value,
    "Bearer FIRST",
  );
  assert.equal(
    store.lookup(second, lookupContext).dnrRequestHeaders.find((entry) => entry.header === "Authorization").value,
    "Bearer SECOND",
  );

  const fallback = store.lookup(mediaUrl("unknown"), lookupContext);
  assert.equal(fallback.matchedBy, "origin-path");
  assert.deepEqual(fallback.fetchHeaders, { "Accept-Language": "fr-FR" });
  assert.equal(fallback.dnrRequestHeaders.some((entry) => entry.header === "Authorization"), false);
  assert.equal(fallback.dnrRequestHeaders.some((entry) => entry.header === "Cookie"), false);
});

test("lookup denies a different origin even when the path and token match", () => {
  const store = createRequestHeaderStore({ now: () => 100 });
  const url = mediaUrl("same");
  assert.equal(store.record({
    url,
    ...context(),
    headers: { Authorization: "Bearer SAME", "Accept-Language": "en-US" },
  }), true);

  assert.equal(store.lookup("https://other.example/video.mp4?token=same", context()), null);
  assert.equal(store.lookup("http://cdn.example/video.mp4?token=same", context()), null);
});

test("same tab, frame, and initiator context wins among exact URL records", () => {
  const store = createRequestHeaderStore({ now: () => 100 });
  const url = mediaUrl("context");
  assert.equal(store.record({
    url,
    ...context(1, 0, "https://one.example/page"),
    headers: { "Accept-Language": "en-US" },
  }), true);
  assert.equal(store.record({
    url,
    ...context(2, 0, "https://two.example/page"),
    headers: { "Accept-Language": "fr-FR" },
  }), true);
  assert.equal(store.record({
    url,
    ...context(2, 3, "https://two.example/page"),
    headers: { "Accept-Language": "ko-KR" },
  }), true);

  assert.deepEqual(
    store.fetchHeaders(url, context(2, 3, "https://two.example/other"))["Accept-Language"],
    "ko-KR",
  );
  assert.deepEqual(
    store.fetchHeaders(url, context(2, 0, "https://two.example/other"))["Accept-Language"],
    "fr-FR",
  );
});

test("TTL expiry and LRU eviction remove old context records", () => {
  let now = 0;
  const store = createRequestHeaderStore({ now: () => now, ttlMs: 100, maxEntries: 2 });
  const first = "https://cdn.example/a.mp4";
  const second = "https://cdn.example/b.mp4";
  const third = "https://cdn.example/c.mp4";

  assert.equal(store.record({ url: first, headers: { "Accept-Language": "one" } }), true);
  now = 1;
  assert.equal(store.record({ url: second, headers: { "Accept-Language": "two" } }), true);
  assert.equal(store.fetchHeaders(first)["Accept-Language"], "one");
  now = 2;
  assert.equal(store.record({ url: third, headers: { "Accept-Language": "three" } }), true);

  assert.equal(store.lookup(second), null);
  assert.equal(store.fetchHeaders(first)["Accept-Language"], "one");
  now = 101;
  assert.equal(store.lookup(first), null);
  assert.equal(store.size, 1);
  now = 103;
  assert.equal(store.size, 0);
});

test("allowlist is case-insensitive and excludes forbidden or arbitrary headers", () => {
  const views = replayHeaderViews([
    { name: "rEfErEr", value: pageUrl },
    { name: "oRiGiN", value: "https://player.example" },
    { name: "aCcEpT-LaNgUaGe", value: "en-US" },
    { name: "aUtHoRiZaTiOn", value: "Bearer ALLOWED" },
    { name: "cOoKiE", value: "sid=ALLOWED" },
    { name: "X-AUTH-TOKEN", value: "old" },
    { name: "x-auth-token", value: "new" },
    { name: "X-Signature", value: "SIGNATURE" },
    { name: "x-api-key", value: "API_KEY" },
    { name: "x-session-id", value: "SESSION" },
    { name: "Connection", value: "close" },
    { name: "Keep-Alive", value: "timeout=5" },
    { name: "Proxy-Authorization", value: "Basic SECRET" },
    { name: "Sec-Fetch-Site", value: "same-origin" },
    { name: "Sec-CH-UA", value: "browser" },
    { name: "Range", value: "bytes=0-1" },
    { name: "Host", value: "cdn.example" },
    { name: "User-Agent", value: "browser" },
    { name: "Content-Type", value: "application/json" },
    { name: "X-Random-Value", value: "arbitrary" },
  ]);

  assert.deepEqual(views.fetchHeaders, { "Accept-Language": "en-US" });
  assert.deepEqual(views.dnrRequestHeaders.map((entry) => entry.header), [
    "Referer",
    "Origin",
    "Accept-Language",
    "Authorization",
    "Cookie",
    "x-auth-token",
    "x-signature",
    "x-api-key",
    "x-session-id",
  ]);
  assert.equal(views.dnrRequestHeaders.find((entry) => entry.header === "x-auth-token").value, "new");
});

test("DNR conversion is explicit while fetch conversion remains narrow", () => {
  const headers = {
    Referer: pageUrl,
    Origin: "https://player.example",
    "Accept-Language": "de-DE",
    Authorization: "Bearer SECRET",
    Cookie: "sid=SECRET",
    "X-Access-Token": "ACCESS",
  };
  assert.deepEqual(replayableFetchHeaders(headers), { "Accept-Language": "de-DE" });
  assert.deepEqual(dnrRequestHeaderOperations(headers).map((entry) => entry.operation), [
    "set",
    "set",
    "set",
    "set",
    "set",
    "set",
  ]);
  assert.equal(dnrRequestHeaderOperations(headers).find((entry) => entry.header === "Cookie").value, "sid=SECRET");
});

test("value, count, entry-size, and total-size bounds are enforced", () => {
  let now = 0;
  const store = createRequestHeaderStore({
    now: () => now,
    maxHeadersPerEntry: 2,
    maxHeaderValueBytes: 4,
    maxEntryBytes: 20,
    maxTotalBytes: 25,
  });
  const first = "https://cdn.example/first.mp4";
  const second = "https://cdn.example/second.mp4";

  assert.equal(store.record({
    url: first,
    headers: {
      "Accept-Language": "12345",
      Authorization: "1234",
      Cookie: "1",
    },
  }), true);
  assert.deepEqual(store.dnrRequestHeaders(first).map((entry) => entry.header), ["Authorization"]);
  assert.ok(store.totalBytes <= 25);

  now = 1;
  assert.equal(store.record({
    url: second,
    headers: { Authorization: "5678" },
  }), true);
  assert.equal(store.lookup(first), null);
  assert.ok(store.totalBytes <= 25);
});

test("diagnostics expose only redacted URLs and header metadata", () => {
  const store = createRequestHeaderStore({ now: () => 100 });
  assert.equal(store.record({
    url: "https://cdn.example/video.mp4?token=URL_SECRET",
    ...context(),
    headers: {
      Authorization: "Bearer HEADER_SECRET",
      Cookie: "sid=COOKIE_SECRET",
      "Accept-Language": "en-US",
    },
  }), true);

  const diagnostics = store.diagnostics();
  const serialized = JSON.stringify(diagnostics);
  assert.doesNotMatch(serialized, /URL_SECRET|HEADER_SECRET|COOKIE_SECRET/);
  assert.equal(diagnostics.entries[0].url, "https://cdn.example/[redacted]");
  assert.deepEqual(diagnostics.entries[0].headerNames, [
    "Authorization",
    "Cookie",
    "Accept-Language",
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(diagnostics.entries[0], "headers"), false);
});
