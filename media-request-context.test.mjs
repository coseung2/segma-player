import test from "node:test";
import assert from "node:assert/strict";

import {
  createMediaRequestDiagnosticStore,
  resolveMediaRequestContext,
} from "./media-request-context.js";

const mediaUrl = "https://cdn.example/hls/video0.jpeg?token=URL_SECRET";
const sourcePage = "https://site.example/watch/1";
const exactFrame = "https://player.example/embed/1";

function lookupWithRecordedContext() {
  return {
    matchedBy: "exact",
    dnrRequestHeaders: [
      { header: "Referer", operation: "set", value: exactFrame },
      { header: "Origin", operation: "set", value: "https://player.example" },
      { header: "Cookie", operation: "set", value: "sid=COOKIE_SECRET" },
      { header: "Authorization", operation: "set", value: "Bearer HEADER_SECRET" },
      { header: "Accept-Language", operation: "set", value: "ko-KR" },
    ],
  };
}

test("recorded request context wins over a generic playback fallback", () => {
  const resolved = resolveMediaRequestContext({
    url: mediaUrl,
    fallbackReferrer: sourcePage,
    sourceContext: { tabId: 7, frameId: 3, initiator: exactFrame },
    consumer: "playback-hls",
    lookupRequestHeaders: lookupWithRecordedContext,
  });

  assert.equal(resolved.referrer, exactFrame);
  assert.equal(resolved.diagnostic.referrerSource, "recorded");
  assert.equal(resolved.diagnostic.matchedBy, "exact");
  assert.equal(resolved.diagnostic.sourceTabId, 7);
  assert.equal(resolved.diagnostic.sourceFrameId, 3);
  assert.deepEqual(resolved.diagnostic.headerNames, [
    "Referer",
    "Origin",
    "Cookie",
    "Authorization",
    "Accept-Language",
  ]);
  assert.deepEqual(resolved.diagnostic.credentialHeaderNames, ["Cookie", "Authorization"]);
});

test("fallback referrer is used when the original request was not observed", () => {
  const resolved = resolveMediaRequestContext({
    url: "https://cdn.example/new-segment.ts",
    fallbackReferrer: exactFrame,
    sourceContext: { tabId: 7, frameId: 3, initiator: exactFrame },
    consumer: "download-hls",
    lookupRequestHeaders: () => null,
  });

  assert.equal(resolved.referrer, exactFrame);
  assert.equal(resolved.diagnostic.referrerSource, "fallback");
  assert.equal(resolved.diagnostic.matchedBy, "none");
  assert.deepEqual(resolved.requestHeaders, []);
});

test("request diagnostics never expose URLs, query values, or header values", () => {
  let now = 100;
  const store = createMediaRequestDiagnosticStore({ now: () => now });
  const resolved = resolveMediaRequestContext({
    url: mediaUrl,
    fallbackReferrer: sourcePage,
    sourceContext: { tabId: 7, frameId: 3, initiator: exactFrame },
    consumer: "playback-hls",
    lookupRequestHeaders: lookupWithRecordedContext,
  });
  assert.equal(store.start({
    leaseId: "lease-1",
    requestTabId: 41,
    url: resolved.url,
    diagnostic: resolved.diagnostic,
  }), true);
  now = 145;
  const completed = store.finish({
    tabId: 41,
    url: mediaUrl,
    statusCode: 403,
    resourceType: "xmlhttprequest",
  });

  assert.equal(completed.statusCode, 403);
  assert.equal(completed.durationMs, 45);
  assert.equal(completed.target.host, "cdn.example");
  assert.equal(completed.target.extension, "jpeg");
  assert.match(completed.target.pathHash, /^[a-f0-9]{8}$/);
  const serialized = JSON.stringify(store.list());
  assert.doesNotMatch(serialized, /URL_SECRET|COOKIE_SECRET|HEADER_SECRET|video0|watch\/1|embed\/1/);
  assert.match(serialized, /cdn\.example/);
  assert.match(serialized, /Cookie/);
});

test("redirected requests retain one diagnostic lease through the final response", () => {
  let now = 10;
  const store = createMediaRequestDiagnosticStore({ now: () => now });
  const startUrl = "https://video.example/file.mp4?token=SECRET";
  const finalUrl = "https://edge.example/file.mp4?token=OTHER_SECRET";
  const diagnostic = resolveMediaRequestContext({
    url: startUrl,
    fallbackReferrer: exactFrame,
    consumer: "playback-progressive",
  }).diagnostic;
  store.start({ leaseId: "redirected", requestTabId: 44, url: startUrl, diagnostic });
  now = 20;
  store.redirect({ tabId: 44, url: startUrl, redirectUrl: finalUrl, statusCode: 302 });
  now = 35;
  const completed = store.finish({
    tabId: 44,
    url: finalUrl,
    statusCode: 206,
    resourceType: "media",
  });
  assert.equal(completed.leaseId, "redirected");
  assert.equal(completed.statusCode, 206);
  assert.equal(completed.target.host, "edge.example");
  assert.deepEqual(completed.redirects, [{ host: "edge.example", statusCode: 302 }]);
  assert.doesNotMatch(JSON.stringify(completed), /SECRET/);
});

test("parallel identical requests are completed in lease order", () => {
  let now = 0;
  const store = createMediaRequestDiagnosticStore({ now: () => now });
  const diagnostic = resolveMediaRequestContext({
    url: mediaUrl,
    fallbackReferrer: exactFrame,
    consumer: "download-hls",
  }).diagnostic;
  store.start({ leaseId: "first", requestTabId: -1, url: mediaUrl, diagnostic });
  now = 5;
  store.start({ leaseId: "second", requestTabId: -1, url: mediaUrl, diagnostic });
  now = 10;
  assert.equal(store.finish({ tabId: -1, url: mediaUrl, statusCode: 200 }).leaseId, "first");
  now = 20;
  assert.equal(store.finish({ tabId: -1, url: mediaUrl, error: "net::ERR_ABORTED" }).leaseId, "second");
  assert.deepEqual(store.list().map((entry) => entry.leaseId), ["first", "second"]);
});
