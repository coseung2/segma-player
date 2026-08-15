import test from "node:test";
import assert from "node:assert/strict";
import { COLLECTION_FOLDER_TITLE, createBookmarkCollection, mergeCollection } from "./collection.js";

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

function mockBookmarks() {
  let nextId = 100;
  const nodes = new Map([
    ["0", { id: "0", title: "", children: ["2"] }],
    ["2", { id: "2", title: "Other bookmarks", children: [] }],
  ]);
  const api = {
    async getChildren(id) {
      const node = nodes.get(id);
      return (node?.children || []).map((childId) => {
        const child = nodes.get(childId);
        return child ? { ...child, children: undefined } : null;
      }).filter(Boolean);
    },
    async create({ parentId, title, url, index }) {
      const id = String(nextId);
      nextId += 1;
      nodes.set(id, {
        id,
        title: title || "",
        url,
        dateAdded: Date.now(),
        index: typeof index === "number" ? index : (nodes.get(parentId)?.children?.length || 0),
        children: [],
      });
      nodes.get(parentId).children.splice(
        typeof index === "number" ? index : nodes.get(parentId).children.length,
        0,
        id,
      );
      return nodes.get(id);
    },
    async update(id, patch) {
      Object.assign(nodes.get(id), patch);
      return nodes.get(id);
    },
    async move(id, { parentId, index }) {
      const parent = nodes.get(parentId);
      const oldParentId = [...nodes.entries()].find(([, node]) => node.children?.includes(id))?.[0];
      if (oldParentId) {
        nodes.get(oldParentId).children = nodes.get(oldParentId).children.filter((c) => c !== id);
      }
      parent.children.splice(index, 0, id);
      return nodes.get(id);
    },
    async remove(id) {
      const parentId = [...nodes.entries()].find(([, node]) => node.children?.includes(id))?.[0];
      if (parentId) {
        nodes.get(parentId).children = nodes.get(parentId).children.filter((c) => c !== id);
      }
      nodes.delete(id);
    },
  };
  return { api, nodes };
}

test("bookmark collection creates a folder and stores entries inside", async () => {
  const { api } = mockBookmarks();
  const collection = createBookmarkCollection(api);
  assert.equal(collection.supported, true);
  await collection.add({ url: "https://a.test/1.m3u8", title: "AAA-111" });
  await collection.add({ url: "https://a.test/2.m3u8", title: "BBB-222" });
  const entries = await collection.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].url, "https://a.test/2.m3u8");
  const folder = (await api.getChildren("2")).find((node) => !node.url);
  assert.equal(folder.title, COLLECTION_FOLDER_TITLE);
});

test("bookmark collection dedupes by url and removes entries", async () => {
  const { api } = mockBookmarks();
  const collection = createBookmarkCollection(api);
  await collection.add({ url: "https://a.test/1.m3u8", title: "AAA-111" });
  await collection.add({ url: "https://a.test/1.m3u8", title: "AAA-111 새제목" });
  const entries = await collection.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "AAA-111 새제목");
  assert.equal(await collection.remove("https://a.test/1.m3u8"), true);
  assert.equal((await collection.list()).length, 0);
  assert.equal(await collection.remove("https://a.test/missing.m3u8"), false);
});

test("bookmark collection reports unsupported without the API", () => {
  const collection = createBookmarkCollection(null);
  assert.equal(collection.supported, false);
});
