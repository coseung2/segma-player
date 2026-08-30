import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalMediaFetchReferrer,
  canonicalMediaFetchUrl,
  createMediaFetchLeaseRegistry,
  createMediaFetchRuleIdAllocator,
  exactMediaFetchRule,
  OFFSCREEN_DOCUMENT_TAB_ID,
} from "./media-fetch-lease.js";

test("media lease rules match one complete URL, including its query token", () => {
  const url = "https://cdn.example/video/file?token=a*b&part=1";
  const rule = exactMediaFetchRule({
    ruleId: 100,
    tabId: 17,
    url,
    referrer: "https://player.example/watch?id=7",
    requestHeaders: [{ header: "Authorization", operation: "set", value: "Bearer token" }],
  });
  const matcher = new RegExp(rule.condition.regexFilter);
  assert.equal(matcher.test(url), true);
  assert.equal(matcher.test("https://cdn.example/video/file?token=a*b&part=2"), false);
  assert.equal(matcher.test("https://cdn.example/video/other?token=a*b&part=1"), false);
  assert.equal(rule.condition.isUrlFilterCaseSensitive, true);
  assert.deepEqual(rule.condition.resourceTypes, ["xmlhttprequest", "other", "media"]);
  assert.deepEqual(rule.condition.tabIds, [17]);
  assert.deepEqual(rule.action.requestHeaders, [
    { header: "Referer", operation: "set", value: "https://player.example/watch?id=7" },
    { header: "Origin", operation: "remove" },
    { header: "Authorization", operation: "set", value: "Bearer token" },
  ]);
});

test("recorded Origin is replayed exactly and duplicate context headers are collapsed", () => {
  const rule = exactMediaFetchRule({
    ruleId: 103,
    tabId: OFFSCREEN_DOCUMENT_TAB_ID,
    url: "https://media.nnvivi.site/level5/master.m3u8?token=fresh",
    referrer: "https://p.nnvivi.site/embed/39141",
    requestHeaders: [
      { header: "referer", operation: "set", value: "https://stale.example/" },
      { header: "Origin", operation: "set", value: "https://p.nnvivi.site" },
      { header: "origin", operation: "set", value: "https://p.nnvivi.site" },
      { header: "Cookie", operation: "set", value: "session=opaque" },
    ],
  });

  assert.deepEqual(rule.action.requestHeaders, [
    { header: "Referer", operation: "set", value: "https://p.nnvivi.site/embed/39141" },
    { header: "origin", operation: "set", value: "https://p.nnvivi.site" },
    { header: "Cookie", operation: "set", value: "session=opaque" },
  ]);
});

test("long tokenized URLs avoid the compiled-regex size limit", () => {
  const url = `https://cdn.example/video/file?token=${"a".repeat(1900)}`;
  const rule = exactMediaFetchRule({ ruleId: 101, tabId: 18, url });
  assert.equal(rule.condition.regexFilter, undefined);
  assert.equal(rule.condition.urlFilter, `|${url}|`);
  assert.deepEqual(rule.condition.tabIds, [18]);
});

test("offscreen downloads use Chrome's tabless request id", () => {
  const rule = exactMediaFetchRule({
    ruleId: 102,
    tabId: OFFSCREEN_DOCUMENT_TAB_ID,
    url: "https://cdn.example/video.mp4",
  });
  assert.deepEqual(rule.condition.tabIds, [-1]);

  const registry = createMediaFetchLeaseRegistry({ leaseIdFactory: () => "offscreen-lease" });
  const lease = registry.create({
    tabId: OFFSCREEN_DOCUMENT_TAB_ID,
    url: "https://cdn.example/video.mp4",
    ruleId: 102,
  });
  assert.equal(lease.tabId, -1);
  assert.equal(registry.forTab(-1).length, 1);
});

test("media lease URL and referrer validation uses the canonical HTTP contract", () => {
  assert.equal(canonicalMediaFetchUrl("https://CDN.example:443/video?token=1"), "https://cdn.example/video?token=1");
  assert.equal(canonicalMediaFetchUrl("https://cdn.example/video#fragment"), null);
  assert.equal(canonicalMediaFetchUrl("file:///video"), null);
  assert.equal(canonicalMediaFetchReferrer("https://player.example/watch"), "https://player.example/watch");
  assert.equal(canonicalMediaFetchReferrer("javascript:alert(1)"), null);
});

test("rule IDs are unique for concurrent leases and reusable only after release", () => {
  const allocator = createMediaFetchRuleIdAllocator(900);
  const first = allocator.allocate();
  const second = allocator.allocate();
  assert.notEqual(first, second);
  allocator.release(first);
  const third = allocator.allocate();
  assert.notEqual(third, second);
  assert.equal(allocator.size, 2);
});

test("lease registry binds leases to tabs and bounds stale cleanup", () => {
  const registry = createMediaFetchLeaseRegistry({
    staleAfterMs: 10,
    leaseIdFactory: (() => {
      let index = 0;
      return () => `lease-${++index}`;
    })(),
  });
  registry.create({ tabId: 7, url: "https://cdn.example/a", ruleId: 1, now: 0 });
  registry.create({ tabId: 7, url: "https://cdn.example/b", ruleId: 2, now: 0 });
  registry.create({ tabId: 8, url: "https://cdn.example/c", ruleId: 3, now: 0 });
  assert.equal(registry.forTab(7).length, 2);
  assert.deepEqual(registry.stale(20, 2).map((lease) => lease.leaseId), ["lease-1", "lease-2"]);
  assert.equal(registry.size, 3);
  assert.equal(registry.remove("lease-1")?.tabId, 7);
  assert.equal(registry.get("lease-1"), null);
});
