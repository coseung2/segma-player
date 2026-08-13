import test from "node:test";
import assert from "node:assert/strict";
import { parallelDownload } from "./parallel-download.js";

function mockFetch(totalBytes, { failRanges = new Set() } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(String(url), "http://server.test/file");
    const headers = options.headers || {};
    const range = typeof headers.get === "function" ? headers.get("range") : headers.Range;
    if (range === "bytes=0-0") {
      return new Response(new Uint8Array(0), {
        status: 206,
        headers: { "content-range": `bytes 0-0/${totalBytes}` },
      });
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(String(range || ""));
    assert.ok(match, `unexpected range ${range}`);
    const start = Number(match[1]);
    const end = Number(match[2]);
    calls.push([start, end]);
    if (failRanges.has(`${start}-${end}`)) {
      failRanges.delete(`${start}-${end}`);
      throw new Error("network-drop");
    }
    const bytes = new Uint8Array(end - start + 1).fill(start % 256);
    return new Response(bytes, {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${totalBytes}` },
    });
  };
  return calls;
}

function fakeWritable() {
  const writes = [];
  return {
    writes,
    async write(entry) {
      writes.push({ position: entry.position, length: entry.data.byteLength });
    },
    async close() {},
    async abort() {},
  };
}

function fakeDirHandle(writable) {
  return {
    async getFileHandle(name, options) {
      assert.equal(options.create, true);
      return {
        name,
        async createWritable() {
          return writable;
        },
      };
    },
  };
}

test("downloads disjoint ranges in parallel and writes at byte positions", async () => {
  const total = 20 * 1024 * 1024;
  const calls = mockFetch(total);
  const writable = fakeWritable();
  const progress = [];
  const result = await parallelDownload({
    url: "http://server.test/file",
    filename: "Test Video.mp4",
    dirHandle: fakeDirHandle(writable),
    chunkBytes: 5 * 1024 * 1024,
    onProgress: (written, all) => progress.push([written, all]),
  });
  assert.equal(result.bytes, total);
  assert.equal(result.filename, "Test Video.mp4");
  assert.equal(calls.length, 4);
  const written = writable.writes.reduce((sum, item) => sum + item.length, 0);
  assert.equal(written, total);
  assert.deepEqual(
    writable.writes.map((item) => item.position).sort((a, b) => a - b),
    [0, 5 * 1024 * 1024, 10 * 1024 * 1024, 15 * 1024 * 1024],
  );
  assert.deepEqual(progress.at(-1), [total, total]);
});

test("retries dropped ranges and still completes", async () => {
  const total = 6 * 1024 * 1024;
  const calls = mockFetch(total, { failRanges: new Set(["0-2097151"]) });
  const writable = fakeWritable();
  const result = await parallelDownload({
    url: "http://server.test/file",
    filename: "T.mp4",
    dirHandle: fakeDirHandle(writable),
    chunkBytes: 2 * 1024 * 1024,
  });
  assert.equal(result.bytes, total);
  const zeroStarts = calls.filter(([start]) => start === 0);
  assert.ok(zeroStarts.length >= 2, "dropped range should be retried");
});

test("sanitizes the output filename", async () => {
  const total = 1024 * 1024;
  mockFetch(total);
  const writable = fakeWritable();
  const result = await parallelDownload({
    url: "http://server.test/file",
    filename: `Bad/Name:*?.mp4`,
    dirHandle: fakeDirHandle(writable),
    chunkBytes: total,
  });
  assert.equal(result.filename, "Bad_Name___.mp4");
});
