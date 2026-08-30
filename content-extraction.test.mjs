import test from "node:test";
import assert from "node:assert/strict";

await import("./content-extraction.js");
const extraction = globalThis.__segmaContentExtractionV1;

test("content extraction canonicalizes media URLs and rejects image/non-http clues", () => {
  assert.equal(
    extraction.canonicalMediaUrl("/media/master.m3u8?token=x", "https://page.example/watch"),
    "https://page.example/media/master.m3u8?token=x",
  );
  assert.equal(extraction.canonicalMediaUrl("https://cdn.example/poster.jpg", "https://page.example"), "");
  assert.equal(extraction.canonicalMediaUrl("javascript:alert(1)", "https://page.example"), "");
  assert.equal(extraction.canonicalMediaUrl("http://127.0.0.1/private.m3u8", "https://page.example"), "");
  assert.equal(extraction.canonicalMediaUrl("http://192.168.1.10/private.mp4", "https://page.example"), "");
  assert.equal(extraction.canonicalMediaUrl("https://user:pass@cdn.example/video.mp4", "https://page.example"), "");
  assert.equal(extraction.canonicalMediaUrl("https://cdn.example:8443/video.mp4", "https://page.example"), "");
  assert.equal(extraction.inferredContentType("https://cdn.example/live?format=dash", "https://page.example"), "application/dash+xml");
});

test("content extraction finds packed, reversed, percent, and base64 config clues", () => {
  const packed = "eval(function(p,a,c,k,e,d){return p}('0 1=\"2://3.4/5.6\"',7,7,'var|src|https|cdn|example|packed|m3u8'.split('|'),0,{}))";
  const reversedUrl = "https://cdn.example/live/master.m3u8?token=abc&type=hls";
  const percentUrl = encodeURIComponent("https://cdn.example/video.mp4?token=abc");
  const json = Buffer.from(JSON.stringify({ manifest_url: "https://cdn.example/base64/master.mpd" })).toString("base64url");
  const urls = extraction.scriptMediaUrls([
    packed,
    `const reversed = "${[...reversedUrl].reverse().join("")}";`,
    `const percent = "${percentUrl}";`,
    `const config = "${json}";`,
  ].join("\n"), "https://page.example/watch");
  assert.ok(urls.includes("https://cdn.example/packed.m3u8"));
  assert.ok(urls.includes(reversedUrl));
  assert.ok(urls.includes("https://cdn.example/video.mp4?token=abc"));
  assert.ok(urls.includes("https://cdn.example/base64/master.mpd"));
});
