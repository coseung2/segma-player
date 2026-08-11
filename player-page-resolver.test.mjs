import test from "node:test";
import assert from "node:assert/strict";
import {
  looksLikePlayerPage,
  parseDoodResponse,
  parseStreamtapeNorobotlink,
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
