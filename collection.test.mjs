import test from "node:test";
import assert from "node:assert/strict";
import { mergeCollection } from "./collection.js";

test("collection merge dedupes by media url and prepends newest", () => {
  const first = mergeCollection([], { url: "https://a.test/1.m3u8", title: "AAA-111" });
  assert.equal(first.length, 1);
  const second = mergeCollection(first, { url: "https://a.test/2.m3u8", title: "BBB-222" });
  assert.deepEqual(second.map((item) => item.url), ["https://a.test/2.m3u8", "https://a.test/1.m3u8"]);
  const replaced = mergeCollection(second, { url: "https://a.test/1.m3u8", title: "AAA-111 새제목" });
  assert.equal(replaced.length, 2);
  assert.equal(replaced[0].title, "AAA-111 새제목");
  assert.equal(replaced.filter((item) => item.url === "https://a.test/1.m3u8").length, 1);
});

test("collection merge enforces the cap and ignores empty entries", () => {
  const list = [];
  for (let index = 0; index < 12; index += 1) {
    list.push({ url: `https://a.test/${index}.m3u8`, title: `T-${index}` });
  }
  const capped = mergeCollection(list, { url: "https://a.test/new.m3u8", title: "NEW" }, 10);
  assert.equal(capped.length, 10);
  assert.equal(capped[0].url, "https://a.test/new.m3u8");
  assert.equal(mergeCollection(list, {}).length, 12);
  assert.equal(mergeCollection("not-an-array", { url: "https://a.test/x.m3u8" }).length, 1);
});
