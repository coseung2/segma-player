import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalPublicHttpUrl,
  createPlayerGraphResolver,
  looksLikePlayerPage,
  parseDoodResponse,
  parseStreamtapeNorobotlink,
  resolvePlayerPage,
} from "./player-page-resolver.js";

test("recognizes doodstream-style player paths", () => {
  assert.equal(looksLikePlayerPage("https://playmogo.com/d/1cp8ukd06ifc"), true);
  assert.equal(looksLikePlayerPage("https://playmogo.com/e/1cp8ukd06ifc"), true);
  assert.equal(looksLikePlayerPage("https://dood.to/e/abc123"), true);
  assert.equal(looksLikePlayerPage("https://streamtape.com/v/abc123/video.mp4"), true);
  assert.equal(looksLikePlayerPage("https://streamtape.com/e/abc123"), true);
  assert.equal(looksLikePlayerPage("https://playmogo.com/blog/post"), false);
});

test("parses Streamtape norobotlink literals without evaluating page code", () => {
  const pageUrl = "https://streamtape.com/v/abc123/video.mp4";
  const body = `
    <script>
      document.getElementById('norobotlink').innerHTML = '//streamtape.com/get_v'
        + ('xcdideo?id=sample-id&expires=123&ip=127.0.0.1&token=sample-token').substring(1).substring(2);
    </script>
  `;
  assert.deepEqual(parseStreamtapeNorobotlink(body, pageUrl), {
    url: "https://streamtape.com/get_video?id=sample-id&expires=123&ip=127.0.0.1&token=sample-token",
    referrer: pageUrl,
  });
});

test("parses plain and JSON direct-URL responses", () => {
  assert.equal(
    parseDoodResponse("https://srv123.doodcdn.io/getfile/abc/xyz?token=1&expiry=2"),
    "https://srv123.doodcdn.io/getfile/abc/xyz?token=1&expiry=2",
  );
  assert.equal(
    parseDoodResponse('{"f":"https://d000d.com/video.mp4","s":1}'),
    "https://d000d.com/video.mp4",
  );
  assert.equal(
    parseDoodResponse('"https://d000d.com/video.mp4"'),
    "https://d000d.com/video.mp4",
  );
  assert.equal(parseDoodResponse("ok"), null);
});

function okResponse(body, { contentLength = null } = {}) {
  let textCalls = 0;
  return {
    ok: true,
    headers: {
      get(name) {
        return name.toLowerCase() === "content-length" ? contentLength : null;
      },
    },
    async text() {
      textCalls += 1;
      return body;
    },
    get textCalls() {
      return textCalls;
    },
  };
}

function errorResponse() {
  return { ok: false, headers: { get: () => null }, async text() { return ""; } };
}

function redirectResponse(location, { opaque = false } = {}) {
  let cancelled = false;
  return {
    ok: false,
    status: 302,
    type: opaque ? "opaqueredirect" : "basic",
    redirected: false,
    headers: { get: (name) => !opaque && name.toLowerCase() === "location" ? location : null },
    body: { async cancel() { cancelled = true; } },
    get cancelled() { return cancelled; },
    async text() { throw new Error("redirect bodies must not be read"); },
  };
}

function routeSpy() {
  const calls = [];
  const route = async (urls) => {
    calls.push(urls);
  };
  route.calls = calls;
  return route;
}

function harness({ ensureRoute = null, options = {} } = {}) {
  const calls = [];
  const responses = new Map();
  let clock = 0;
  const resolver = createPlayerGraphResolver({
    fetchImpl: async (url, fetchOptions) => {
      calls.push({ url, signal: fetchOptions?.signal || null, options: fetchOptions });
      const value = responses.get(url);
      return typeof value === "function" ? value(url, fetchOptions) : value || errorResponse();
    },
    ensureRoute,
    now: () => clock,
    ...options,
  });
  return {
    resolver,
    calls,
    responses,
    advance(ms) {
      clock += ms;
    },
  };
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for predicate");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const b64 = (value) => Buffer.from(value).toString("base64");

test("coalesces concurrent resolves of the same canonical URL into one traversal", async () => {
  const h = harness();
  h.responses.set("https://media.example/e/abc", okResponse(
    '<iframe src="https://cdn.example/video.mp4"></iframe>',
  ));
  const [first, second] = await Promise.all([
    h.resolver.resolve("https://media.example/e/abc"),
    h.resolver.resolve("https://media.example/e/abc"),
  ]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "https://media.example/e/abc");
  assert.deepEqual(first, {
    type: "progressive",
    url: "https://cdn.example/video.mp4",
    referrer: "https://media.example/e/abc",
    cached: false,
  });
  assert.deepEqual(second, first);
});

test("positive cache rechecks the route on hit and refetches after expiry", async () => {
  const route = routeSpy();
  const h = harness({ ensureRoute: route, options: { positiveTtlMs: 60_000 } });
  h.responses.set("https://media.example/e/abc", okResponse("https://cdn.example/video.mp4"));
  const first = await h.resolver.resolve("https://media.example/e/abc");
  assert.equal(first.cached, false);
  assert.equal(h.calls.length, 1);

  const second = await h.resolver.resolve("https://media.example/e/abc");
  assert.equal(second.cached, true);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(route.calls.at(-1), ["https://cdn.example/video.mp4"]);

  h.advance(60_001);
  const third = await h.resolver.resolve("https://media.example/e/abc");
  assert.equal(third.cached, false);
  assert.equal(h.calls.length, 2);
});

test("negative cache suppresses repeat fetches until expiry", async () => {
  const h = harness({ options: { negativeTtlMs: 15_000 } });
  h.responses.set("https://media.example/e/empty", okResponse("<html>nothing here</html>"));
  assert.equal(await h.resolver.resolve("https://media.example/e/empty"), null);
  assert.equal(h.calls.length, 1);
  assert.equal(await h.resolver.resolve("https://media.example/e/empty"), null);
  assert.equal(h.calls.length, 1);
  h.advance(15_001);
  assert.equal(await h.resolver.resolve("https://media.example/e/empty"), null);
  assert.equal(h.calls.length, 2);
});

test("stops traversing after the explicit max-node bound", async () => {
  const frames = Array.from({ length: 8 }, (_, i) => `https://media.example/e/f${i + 1}`);
  const h = harness({ options: { maxNodes: 3 } });
  h.responses.set("https://media.example/e/root", okResponse(
    frames.map((url) => `<iframe src="${url}"></iframe>`).join(""),
  ));
  for (const url of frames) h.responses.set(url, okResponse("<html>loading</html>"));
  assert.equal(await h.resolver.resolve("https://media.example/e/root"), null);
  assert.deepEqual(h.calls.map((c) => c.url), [
    "https://media.example/e/root",
    frames[0],
    frames[1],
  ]);
});

test("caps frame clues extracted from a single page", async () => {
  const frames = Array.from({ length: 5 }, (_, i) => `https://media.example/e/f${i + 1}`);
  const h = harness({ options: { maxNodes: 100, maxFrameClues: 2 } });
  h.responses.set("https://media.example/e/root", okResponse(
    frames.map((url) => `<iframe src="${url}"></iframe>`).join(""),
  ));
  for (const url of frames) h.responses.set(url, okResponse("<html>loading</html>"));
  assert.equal(await h.resolver.resolve("https://media.example/e/root"), null);
  assert.deepEqual(h.calls.map((c) => c.url), [
    "https://media.example/e/root",
    frames[0],
    frames[1],
  ]);
  assert.ok(!h.calls.some((c) => c.url === frames[2]));
});

test("visits each canonical URL once and terminates on cycles", async () => {
  const h = harness();
  h.responses.set("https://media.example/e/a", okResponse(
    '<iframe src="/e/b"></iframe><iframe src="/e/a"></iframe>',
  ));
  h.responses.set("https://media.example/e/b", okResponse('<iframe src="/e/a"></iframe>'));
  assert.equal(await h.resolver.resolve("https://media.example/e/a"), null);
  assert.deepEqual(h.calls.map((c) => c.url), [
    "https://media.example/e/a",
    "https://media.example/e/b",
  ]);
});

test("skips preview and image decoy URLs when extracting direct media", async () => {
  const h = harness();
  h.responses.set("https://media.example/e/abc", okResponse(
    'https://cdn.example/previews/clip.mp4 "https://cdn.example/real.mp4"',
  ));
  const resolved = await h.resolver.resolve("https://media.example/e/abc");
  assert.equal(resolved.type, "progressive");
  assert.equal(resolved.url, "https://cdn.example/real.mp4");
});

test("returns null when the only discovered media URL is a decoy", async () => {
  const h = harness();
  h.responses.set("https://media.example/e/abc", okResponse(
    "https://img.example/thumbnails/video.mp4",
  ));
  assert.equal(await h.resolver.resolve("https://media.example/e/abc"), null);
});

test("rejects decoy URLs returned by the dood pass endpoint", async () => {
  const h = harness();
  h.responses.set("https://media.example/d/abc", okResponse('src="/pass_md5/token"'));
  h.responses.set("https://media.example/pass_md5/token", okResponse(
    '{"f":"https://cdn.example/previews/clip.mp4"}',
  ));
  assert.equal(await h.resolver.resolve("https://media.example/d/abc"), null);
  assert.ok(h.calls.some((c) => c.url === "https://media.example/pass_md5/token"));
});

test("types direct m3u8 results as HLS and mp4 results as progressive", async () => {
  const h = harness();
  h.responses.set("https://media.example/e/hls", okResponse("https://cdn.example/master.m3u8?token=1"));
  const hls = await h.resolver.resolve("https://media.example/e/hls");
  assert.equal(hls.type, "hls");
  assert.equal(hls.url, "https://cdn.example/master.m3u8?token=1");
  h.responses.set("https://media.example/e/mp4", okResponse("https://cdn.example/clip.mp4"));
  const progressive = await h.resolver.resolve("https://media.example/e/mp4");
  assert.equal(progressive.type, "progressive");
  assert.equal(progressive.url, "https://cdn.example/clip.mp4");
});

test("does not truncate extension-suffixed decoys before a real media URL", async () => {
  const h = harness();
  h.responses.set("https://media.example/e/extensions", okResponse(`
    https://cdn.example/track.mp4.json
    https://cdn.example/real.mp4
  `));
  assert.equal((await h.resolver.resolve("https://media.example/e/extensions"))?.url,
    "https://cdn.example/real.mp4");
});

test("accepts media URLs followed by JavaScript punctuation without trimming query bytes", async () => {
  const h = harness();
  h.responses.set("https://media.example/e/punctuation", okResponse(`
    const source = https://cdn.example/real.mp4?token=abc123);
  `));
  assert.equal((await h.resolver.resolve("https://media.example/e/punctuation"))?.url,
    "https://cdn.example/real.mp4?token=abc123");
});

test("preserves a lone semicolon that may be part of a token query", async () => {
  const h = harness();
  h.responses.set("https://media.example/e/query-semicolon", okResponse(`
    https://cdn.example/real.mp4?token=abc;
  `));
  assert.equal((await h.resolver.resolve("https://media.example/e/query-semicolon"))?.url,
    "https://cdn.example/real.mp4?token=abc;");
});

test("accepts WebM media while rejecting WebP image decoys", async () => {
  const h = harness();
  h.responses.set("https://media.example/e/webm", okResponse(`
    https://cdn.example/poster.webp
    https://cdn.example/video.webm
  `));
  assert.deepEqual(await h.resolver.resolve("https://media.example/e/webm"), {
    type: "progressive",
    url: "https://cdn.example/video.webm",
    referrer: "https://media.example/e/webm",
    cached: false,
  });
});

test("resolves protocol-relative and relative media fields without evaluating scripts", async () => {
  const protocolRelative = harness();
  protocolRelative.responses.set("https://media.example/e/config", okResponse(
    `sources: [{ src: "//cdn.example/master.m3u8?token=1" }]`,
  ));
  assert.deepEqual(await protocolRelative.resolver.resolve("https://media.example/e/config"), {
    type: "hls",
    url: "https://cdn.example/master.m3u8?token=1",
    referrer: "https://media.example/e/config",
    cached: false,
  });

  const relative = harness();
  relative.responses.set("https://media.example/player/watch", okResponse(
    `player.setup({ file: "../media/video.webm" })`,
  ));
  assert.equal((await relative.resolver.resolve("https://media.example/player/watch"))?.url,
    "https://media.example/media/video.webm");
});

test("prefers a Dood pass endpoint over unrelated direct media text", async () => {
  const h = harness();
  h.responses.set("https://media.example/e/dood", okResponse(`
    <video src="https://ads.example/preroll.mp4"></video>
    <script>const token = "/pass_md5/secret";</script>
  `));
  h.responses.set("https://media.example/pass_md5/secret", okResponse(
    "https://cdn.example/getfile/video?token=fresh",
  ));
  assert.deepEqual(await h.resolver.resolve("https://media.example/e/dood"), {
    type: "progressive",
    url: "https://cdn.example/getfile/video?token=fresh",
    referrer: "https://media.example/e/dood",
    cached: false,
  });
});

test("follows provider-agnostic iframe sources with player-shaped URLs first", async () => {
  const h = harness({ options: { maxNodes: 2 } });
  h.responses.set("https://media.example/e/root", okResponse(`
    <iframe src="https://widgets.example/unrelated"></iframe>
    <iframe data-src="https://embed.example/player/abc"></iframe>
  `));
  h.responses.set("https://embed.example/player/abc", okResponse(
    "https://cdn.example/final.mp4",
  ));
  assert.equal((await h.resolver.resolve("https://media.example/e/root"))?.url,
    "https://cdn.example/final.mp4");
  assert.deepEqual(h.calls.map(({ url }) => url), [
    "https://media.example/e/root",
    "https://embed.example/player/abc",
  ]);
});

test("decodes base64 video_url clues and types them by extension", async () => {
  const h = harness();
  h.responses.set("https://media.example/d/abc", okResponse(
    `playerConfig = { video_url: "${b64("https://cdn.example/clip.mp4?t=1")}" };`,
  ));
  const progressive = await h.resolver.resolve("https://media.example/d/abc");
  assert.deepEqual(progressive, {
    type: "progressive",
    url: "https://cdn.example/clip.mp4?t=1",
    referrer: "https://media.example/d/abc",
    cached: false,
  });
  h.responses.set("https://media.example/d/def", okResponse(
    `playerConfig = { video_url_hd: "${b64("https://cdn.example/live/master.m3u8")}" };`,
  ));
  const hls = await h.resolver.resolve("https://media.example/d/def");
  assert.equal(hls.type, "hls");
  assert.equal(hls.url, "https://cdn.example/live/master.m3u8");
});

test("skips invalid and decoy base64 video_url clues", async () => {
  const h = harness();
  h.responses.set("https://media.example/d/abc", okResponse(
    `playerConfig = { video_url: "abcdabcda", video_url_hd: "${b64("https://cdn.example/previews/x.mp4")}" };`,
  ));
  assert.equal(await h.resolver.resolve("https://media.example/d/abc"), null);
});

test("rejects private, loopback, credentialed, ported, and non-http URLs", () => {
  for (const value of [
    "http://127.0.0.1/d/abc",
    "http://10.0.0.5/d/abc",
    "http://192.168.1.10/d/abc",
    "http://169.254.169.254/d/abc",
    "http://[::1]/d/abc",
    "http://[fc00::1]/d/abc",
    "http://[fe80::1]/d/abc",
    "http://[ff02::1]/d/abc",
    "http://[::ffff:127.0.0.1]/d/abc",
    "http://localhost/d/abc",
    "http://media.local/e/abc",
    "https://user:pass@media.example/e/abc",
    "https://media.example:8443/e/abc",
    "https://media.example/e/abc#frag",
    "javascript:alert(1)",
    "ftp://media.example/a.mp4",
    "",
  ]) {
    assert.equal(canonicalPublicHttpUrl(value), null, value);
  }
});

test("rejects IPv6 forms that embed private IPv4 and deprecated site-local space", () => {
  for (const value of [
    "https://[64:ff9b::a00:1]/e/x",
    "https://[64:ff9b::7f00:1]/e/x",
    "https://[2002:a00:1::]/e/x",
    "https://[::a00:1]/e/x",
    "https://[fec0::1]/e/x",
  ]) assert.equal(canonicalPublicHttpUrl(value), null, value);
  assert.equal(canonicalPublicHttpUrl("https://[64:ff9b::808:808]/e/x")?.hostname,
    "[64:ff9b::808:808]");
});

test("accepts public URLs and normalizes casing, default ports, and trailing dots", () => {
  assert.equal(
    canonicalPublicHttpUrl("https://Media.Example:443/e/abc").href,
    "https://media.example/e/abc",
  );
  assert.equal(
    canonicalPublicHttpUrl("http://media.example:80/d/abc").href,
    "http://media.example/d/abc",
  );
  assert.equal(
    canonicalPublicHttpUrl("https://media.example./e/abc").href,
    "https://media.example/e/abc",
  );
});

test("refuses to fetch non-public or credentialed start URLs", async () => {
  const h = harness();
  for (const url of [
    "http://127.0.0.1/d/abc",
    "https://user:pass@media.example/e/abc",
    "https://media.example:8443/e/abc",
  ]) {
    assert.equal(await h.resolver.resolve(url), null);
  }
  assert.equal(h.calls.length, 0);
});

test("skips frame clues pointing at private or non-default-port hosts", async () => {
  const h = harness();
  h.responses.set("https://media.example/e/root", okResponse(
    '<iframe src="http://192.168.0.4/d/private"></iframe>'
    + '<iframe src="https://media.example:9443/d/badport"></iframe>'
    + '<iframe src="/e/public"></iframe>',
  ));
  h.responses.set("https://media.example/e/public", okResponse("https://cdn.example/clip.mp4"));
  const resolved = await h.resolver.resolve("https://media.example/e/root");
  assert.equal(resolved.url, "https://cdn.example/clip.mp4");
  assert.deepEqual(h.calls.map((c) => c.url), [
    "https://media.example/e/root",
    "https://media.example/e/public",
  ]);
});

test("rejects credentialed and non-default-port direct media matches", async () => {
  const h = harness();
  h.responses.set("https://media.example/e/abc", okResponse(
    "https://user:pass@cdn.example/a.mp4 https://cdn.example:8443/b.mp4 https://cdn.example/c.mp4",
  ));
  const resolved = await h.resolver.resolve("https://media.example/e/abc");
  assert.equal(resolved.url, "https://cdn.example/c.mp4");
});

test("cache keys use the full canonical URL including query tokens", async () => {
  const h = harness({ options: { positiveTtlMs: 60_000 } });
  h.responses.set("https://media.example/e/abc?a=1", okResponse("https://cdn.example/one.mp4"));
  h.responses.set("https://media.example/e/abc?a=2", okResponse("https://cdn.example/two.mp4"));
  const one = await h.resolver.resolve("https://media.example/e/abc?a=1");
  const two = await h.resolver.resolve("https://media.example/e/abc?a=2");
  assert.equal(one.url, "https://cdn.example/one.mp4");
  assert.equal(two.url, "https://cdn.example/two.mp4");
  assert.equal(h.calls.length, 2);
  const oneAgain = await h.resolver.resolve("https://media.example:443/e/abc?a=1");
  assert.equal(oneAgain.cached, true);
  assert.equal(h.calls.length, 2);
});

test("aborting before resolve starts performs no fetch and caches nothing", async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    h.resolver.resolve("https://media.example/e/abc", { signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(h.calls.length, 0);
  assert.equal(h.resolver.positiveCacheSize, 0);
  assert.equal(h.resolver.negativeCacheSize, 0);
});

test("aborting during traversal stops fetches and caches nothing", async () => {
  const h = harness();
  let releasePage1;
  const gate = new Promise((resolve) => {
    releasePage1 = resolve;
  });
  h.responses.set("https://media.example/e/root", async () => {
    await gate;
    return okResponse('<iframe src="/e/next"></iframe>');
  });
  h.responses.set("https://media.example/e/next", okResponse("https://cdn.example/clip.mp4"));
  const controller = new AbortController();
  const pending = h.resolver.resolve("https://media.example/e/root", { signal: controller.signal });
  await waitUntil(() => h.calls.length === 1);
  releasePage1();
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(h.calls.length, 1);
  assert.equal(h.resolver.positiveCacheSize, 0);
  assert.equal(h.resolver.negativeCacheSize, 0);
});

test("validates every manual redirect before fetching the next hop", async () => {
  const redirects = new Map([
    ["https://media.example/e/redirect", "https://redirect.example/player/final"],
  ]);
  const h = harness({ options: { maxRedirectHops: 3, getRedirectTarget: (url) => redirects.get(url) || null } });
  const first = redirectResponse("https://redirect.example/player/final");
  h.responses.set("https://media.example/e/redirect", first);
  h.responses.set("https://redirect.example/player/final", okResponse(
    'file: "../media/video.mp4"',
  ));
  const resolved = await h.resolver.resolve("https://media.example/e/redirect");
  assert.equal(resolved?.url, "https://redirect.example/media/video.mp4");
  assert.equal(resolved?.referrer, "https://redirect.example/player/final");
  assert.equal(first.cancelled, true);
  assert.deepEqual(h.calls.map(({ url }) => url), [
    "https://media.example/e/redirect",
    "https://redirect.example/player/final",
  ]);
  assert.ok(h.calls.every(({ options }) => options.redirect === "manual"));
});

test("never follows a redirect to a private or loopback target", async () => {
  for (const location of ["http://127.0.0.1/admin", "http://169.254.169.254/latest/meta-data/"]) {
    const h = harness({ options: { getRedirectTarget: () => location } });
    h.responses.set("https://media.example/e/redirect", redirectResponse(null, { opaque: true }));
    assert.equal(await h.resolver.resolve("https://media.example/e/redirect"), null);
    assert.deepEqual(h.calls.map(({ url }) => url), ["https://media.example/e/redirect"]);
  }
});

test("fails closed when the browser hides a manual redirect Location", async () => {
  const h = harness();
  const opaque = redirectResponse("https://redirect.example/e/final", { opaque: true });
  h.responses.set("https://media.example/e/opaque", opaque);
  assert.equal(await h.resolver.resolve("https://media.example/e/opaque"), null);
  assert.equal(opaque.cancelled, true);
  assert.equal(h.calls.length, 1);
});

test("resolves Chrome opaque redirects through an observed public target", async () => {
  const h = harness({ options: {
    getRedirectTarget: (url) => url === "https://media.example/e/opaque"
      ? "https://redirect.example/e/final" : null,
  } });
  const opaque = redirectResponse(null, { opaque: true });
  h.responses.set("https://media.example/e/opaque", opaque);
  h.responses.set("https://redirect.example/e/final", okResponse('file: "https://cdn.example/video.mp4"'));
  assert.equal((await h.resolver.resolve("https://media.example/e/opaque"))?.url,
    "https://cdn.example/video.mp4");
  assert.equal(opaque.cancelled, true);
  assert.deepEqual(h.calls.map(({ url }) => url), [
    "https://media.example/e/opaque",
    "https://redirect.example/e/final",
  ]);
});

test("rejects an unexpected browser-followed final URL without reading it", async () => {
  const h = harness();
  let cancelled = false;
  let textCalls = 0;
  h.responses.set("https://media.example/e/unexpected-follow", {
    ok: true,
    url: "http://127.0.0.1/admin",
    redirected: true,
    headers: { get: () => null },
    body: { async cancel() { cancelled = true; } },
    async text() { textCalls += 1; return "https://cdn.example/no.mp4"; },
  });
  assert.equal(await h.resolver.resolve("https://media.example/e/unexpected-follow"), null);
  assert.equal(cancelled, true);
  assert.equal(textCalls, 0);
});

test("one coalesced caller can abort without cancelling another caller", async () => {
  const h = harness();
  let releaseFetch;
  h.responses.set("https://media.example/e/shared", () => new Promise((resolve) => {
    releaseFetch = () => resolve(okResponse("https://cdn.example/shared.mp4"));
  }));
  const controller = new AbortController();
  const first = h.resolver.resolve("https://media.example/e/shared", { signal: controller.signal });
  const second = h.resolver.resolve("https://media.example/e/shared");
  await waitUntil(() => typeof releaseFetch === "function");
  controller.abort();
  releaseFetch();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal((await second).url, "https://cdn.example/shared.mp4");
  assert.equal(h.calls.length, 1);
});

test("skips pages whose declared content-length exceeds the body bound", async () => {
  const h = harness({ options: { maxBodyBytes: 1_000 } });
  const page = okResponse("https://cdn.example/clip.mp4", { contentLength: "999999" });
  h.responses.set("https://media.example/e/root", page);
  assert.equal(await h.resolver.resolve("https://media.example/e/root"), null);
  assert.equal(page.textCalls, 0);
});

test("cancels non-success response bodies without parsing them", async () => {
  const h = harness();
  let cancelled = false;
  let textCalls = 0;
  h.responses.set("https://media.example/e/failure", {
    ok: false,
    status: 503,
    headers: { get: () => null },
    body: { async cancel() { cancelled = true; } },
    async text() { textCalls += 1; return "https://cdn.example/should-not-run.mp4"; },
  });
  assert.equal(await h.resolver.resolve("https://media.example/e/failure"), null);
  assert.equal(cancelled, true);
  assert.equal(textCalls, 0);
});

test("skips pages whose actual text length exceeds the body bound", async () => {
  const h = harness({ options: { maxBodyBytes: 100 } });
  const page = okResponse(`https://cdn.example/clip.mp4 ${"x".repeat(200)}`);
  h.responses.set("https://media.example/e/root", page);
  assert.equal(await h.resolver.resolve("https://media.example/e/root"), null);
  assert.equal(page.textCalls, 1);
});

test("cancels a streamed body as soon as the byte bound is exceeded", async () => {
  const h = harness({ options: { maxBodyBytes: 8 } });
  let reads = 0;
  let cancelled = false;
  h.responses.set("https://media.example/e/large-stream", {
    ok: true,
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          async read() {
            reads += 1;
            return reads === 1
              ? { done: false, value: new Uint8Array([1, 2, 3, 4, 5]) }
              : { done: false, value: new Uint8Array([6, 7, 8, 9, 10]) };
          },
          async cancel() { cancelled = true; },
        };
      },
    },
  });
  assert.equal(await h.resolver.resolve("https://media.example/e/large-stream"), null);
  assert.equal(reads, 2);
  assert.equal(cancelled, true);
});

test("resolves Streamtape norobotlink pages through the graph resolver", async () => {
  const h = harness();
  h.responses.set("https://streamtape.com/v/abc123/video.mp4", okResponse(`
    <script>
      document.getElementById('norobotlink').innerHTML = '//streamtape.com/get_v'
        + ('xcdideo?id=sample-id&expires=123&ip=127.0.0.1&token=sample-token').substring(1).substring(2);
    </script>
  `));
  const resolved = await h.resolver.resolve("https://streamtape.com/v/abc123/video.mp4");
  assert.deepEqual(resolved, {
    type: "progressive",
    url: "https://streamtape.com/get_video?id=sample-id&expires=123&ip=127.0.0.1&token=sample-token",
    referrer: "https://streamtape.com/v/abc123/video.mp4",
    cached: false,
  });
});

test("resolves Dood pass_md5 pages through the graph resolver", async () => {
  const h = harness();
  h.responses.set("https://playmogo.com/d/1cp8ukd06ifc", okResponse(
    '<script src="/pass_md5/tok123"></script>',
  ));
  h.responses.set("https://playmogo.com/pass_md5/tok123", okResponse(
    '{"f":"https://srv123.doodcdn.io/getfile/abc/xyz"}',
  ));
  const resolved = await h.resolver.resolve("https://playmogo.com/d/1cp8ukd06ifc");
  assert.deepEqual(resolved, {
    type: "progressive",
    url: "https://srv123.doodcdn.io/getfile/abc/xyz",
    referrer: "https://playmogo.com/d/1cp8ukd06ifc",
    cached: false,
  });
});

test("sends the containing player page as the Dood pass referrer", async () => {
  const calls = [];
  const resolver = createPlayerGraphResolver({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/e/abc")) return okResponse('src="/pass_md5/tok"');
      return okResponse('"https://cdn.example/final.mp4"');
    },
  });
  await resolver.resolve("https://media.example/e/abc");
  assert.equal(calls[1].options.referrer, "https://media.example/e/abc");
  assert.equal(calls[1].options.referrerPolicy, "unsafe-url");
});

test("falls back from the /d/ page to its same-origin /e/ twin", async () => {
  const h = harness();
  h.responses.set("https://playmogo.com/d/abc", okResponse("<html>loading</html>"));
  h.responses.set("https://playmogo.com/e/abc", okResponse('src="/pass_md5/tok"'));
  h.responses.set("https://playmogo.com/pass_md5/tok", okResponse(
    '"https://srv123.doodcdn.io/getfile/a/b"',
  ));
  const resolved = await h.resolver.resolve("https://playmogo.com/d/abc");
  assert.equal(resolved.url, "https://srv123.doodcdn.io/getfile/a/b");
  assert.deepEqual(h.calls.map((c) => c.url), [
    "https://playmogo.com/d/abc",
    "https://playmogo.com/e/abc",
    "https://playmogo.com/pass_md5/tok",
  ]);
});

test("runs evidence passes in stable order: streamtape, dood, direct, base64 video_url", async () => {
  const h1 = harness();
  h1.responses.set("https://streamtape.com/v/x", okResponse(`
    document.getElementById('norobotlink').innerHTML = '//streamtape.com/get_v'
      + ('xcdideo?id=1&expires=2&ip=3.3.3.3&token=t').substring(1).substring(2);
    https://cdn.example/first.mp4
  `));
  const streamtape = await h1.resolver.resolve("https://streamtape.com/v/x");
  assert.match(streamtape.url, /streamtape\.com\/get_video/);

  const h2 = harness();
  h2.responses.set("https://media.example/d/abc", okResponse(
    'src="/pass_md5/tok" https://cdn.example/direct.mp4',
  ));
  h2.responses.set("https://media.example/pass_md5/tok", okResponse(
    '"https://cdn.example/from-pass.mp4"',
  ));
  const dood = await h2.resolver.resolve("https://media.example/d/abc");
  assert.equal(dood.url, "https://cdn.example/from-pass.mp4");
  assert.ok(h2.calls.some((c) => c.url.includes("pass_md5")));

  const h3 = harness();
  h3.responses.set("https://media.example/d/def", okResponse(
    `https://cdn.example/direct.mp4 playerConfig = { video_url: "${b64("https://cdn.example/from-video-url.mp4")}" };`,
  ));
  const direct = await h3.resolver.resolve("https://media.example/d/def");
  assert.equal(direct.url, "https://cdn.example/direct.mp4");
});

test("bounds cache entries and evicts the oldest key", async () => {
  const h = harness({ options: { maxCacheEntries: 2, positiveTtlMs: 60_000 } });
  for (const id of ["a", "b", "c"]) {
    h.responses.set(`https://media.example/e/${id}`, okResponse(`https://cdn.example/${id}.mp4`));
    await h.resolver.resolve(`https://media.example/e/${id}`);
  }
  assert.equal(h.resolver.positiveCacheSize, 2);
  const again = await h.resolver.resolve("https://media.example/e/a");
  assert.equal(again.cached, false);
  assert.equal(h.calls.length, 4);
});

test("positive cache entry is dropped and re-resolved when the route recheck fails", async () => {
  let failRoute = false;
  const route = async (urls) => {
    if (failRoute && urls.includes("https://cdn.example/clip.mp4")) throw new Error("route failed");
  };
  const h = harness({ ensureRoute: route, options: { positiveTtlMs: 60_000 } });
  h.responses.set("https://media.example/e/abc", okResponse("https://cdn.example/clip.mp4"));
  assert.equal((await h.resolver.resolve("https://media.example/e/abc")).cached, false);
  failRoute = true;
  const second = await h.resolver.resolve("https://media.example/e/abc");
  assert.equal(second.cached, false);
  assert.equal(h.calls.length, 2);
});

test("resolvePlayerPage preserves the legacy progressive shape for HLS results", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return String(url) === "https://media.example/e/hls"
      ? okResponse("https://cdn.example/master.m3u8")
      : errorResponse();
  };
  try {
    const resolved = await resolvePlayerPage("https://media.example/e/hls");
    assert.deepEqual(resolved, {
      type: "progressive",
      url: "https://cdn.example/master.m3u8",
      referrer: "https://media.example/e/hls",
    });
    assert.deepEqual(calls, ["https://media.example/e/hls"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolvePlayerPage resolves Dood pass pages through the graph engine", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const bodies = {
      "https://playmogo.com/d/abc": okResponse('src="/pass_md5/tok"'),
      "https://playmogo.com/pass_md5/tok": okResponse('"https://srv123.doodcdn.io/getfile/a/b"'),
    };
    return bodies[String(url)] || errorResponse();
  };
  try {
    const resolved = await resolvePlayerPage("https://playmogo.com/d/abc");
    assert.deepEqual(resolved, {
      type: "progressive",
      url: "https://srv123.doodcdn.io/getfile/a/b",
      referrer: "https://playmogo.com/d/abc",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolvePlayerPage returns null for invalid or non-public pages without fetching", async () => {
  assert.equal(await resolvePlayerPage("not a url"), null);
  assert.equal(await resolvePlayerPage("http://127.0.0.1/d/abc"), null);
  assert.equal(await resolvePlayerPage("https://user:pass@media.example/e/abc"), null);
});
