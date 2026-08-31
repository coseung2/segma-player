import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("purchase UI exposes Paddle and USDT while keeping server verification", async () => {
  const [html, javascript, worker] = await Promise.all([
    readFile(new URL("./site/index.html", import.meta.url), "utf8"),
    readFile(new URL("./site/site.js", import.meta.url), "utf8"),
    readFile(new URL("./worker.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /cdn\.paddle\.com\/paddle\/v2\/paddle\.js/);
  assert.match(html, /id="pay-paddle"/);
  assert.match(html, /id="pay-usdt"/);
  assert.match(javascript, /\/api\/pay\/order/);
  assert.match(javascript, /\/api\/pay\/verify/);
  assert.match(javascript, /\/api\/pay\/paddle\/order/);
  assert.match(javascript, /\/api\/pay\/paddle\/status/);
  assert.match(javascript, /Paddle\.Checkout\.open/);
  assert.match(worker, /\/api\/pay\/paddle\/webhook/);
});
