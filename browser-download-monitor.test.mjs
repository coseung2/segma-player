import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserDownloadMonitor } from "./browser-download-monitor.js";

function harness() {
  const items = new Map();
  const created = new Set();
  const changed = new Set();
  const removed = [];
  const cancelled = [];
  let nextId = 1;
  const downloads = {
    onCreated: {
      addListener: (listener) => created.add(listener),
      removeListener: (listener) => created.delete(listener),
    },
    onChanged: {
      addListener: (listener) => changed.add(listener),
      removeListener: (listener) => changed.delete(listener),
    },
    async download(options) {
      const item = { id: nextId++, url: options.url, state: "in_progress", fileSize: 0, totalBytes: -1 };
      items.set(item.id, item);
      return item.id;
    },
    async search({ id }) {
      return items.has(id) ? [{ ...items.get(id) }] : [];
    },
    async removeFile(id) { removed.push(id); },
    async cancel(id) {
      cancelled.push(id);
      const item = items.get(id);
      if (item) item.state = "interrupted";
    },
  };
  return {
    downloads,
    items,
    removed,
    cancelled,
    emitCreated(item) { for (const listener of created) listener({ ...item }); },
    emitChanged(delta) { for (const listener of changed) listener(delta); },
  };
}

test("browser download completes only after Chrome reports a non-empty file", async () => {
  const h = harness();
  const monitor = createBrowserDownloadMonitor(h.downloads);
  const pending = monitor.start({
    requestId: "request-0001",
    url: "https://cdn.example/video.mp4",
    options: { url: "https://cdn.example/video.mp4", filename: "video.mp4" },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.items.set(1, { ...h.items.get(1), state: "complete", fileSize: 2048, totalBytes: 2048 });
  h.emitChanged({ id: 1, state: { current: "complete" } });
  assert.deepEqual(await pending, { downloadId: 1, bytes: 2048 });
  monitor.destroy();
});

test("browser download removes and rejects a completed zero-byte file", async () => {
  const h = harness();
  const monitor = createBrowserDownloadMonitor(h.downloads);
  const pending = monitor.start({
    requestId: "request-0002",
    url: "https://cdn.example/empty.mp4",
    options: { url: "https://cdn.example/empty.mp4", filename: "empty.mp4" },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.items.set(1, { ...h.items.get(1), state: "complete", fileSize: 0, totalBytes: 0, bytesReceived: 0 });
  h.emitChanged({ id: 1, state: { current: "complete" } });
  await assert.rejects(pending, (error) => error?.code === "empty-download");
  assert.deepEqual(h.removed, [1]);
  monitor.destroy();
});

test("source-frame capture correlates the created download and supports cancellation", async () => {
  const h = harness();
  const monitor = createBrowserDownloadMonitor(h.downloads);
  const url = "https://srv123.doodcdn.io/getfile/video?token=x";
  const pending = monitor.capture({
    requestId: "request-0003",
    url,
    trigger: async () => {
      const item = { id: 77, url, state: "in_progress", fileSize: 0, totalBytes: -1 };
      h.items.set(item.id, item);
      h.emitCreated(item);
      return true;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await monitor.cancel("request-0003"), true);
  await assert.rejects(pending, (error) => error?.code === "download-cancelled");
  assert.deepEqual(h.cancelled, [77]);
  monitor.destroy();
});
