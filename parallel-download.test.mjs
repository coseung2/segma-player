import test from "node:test";
import assert from "node:assert/strict";
import { parallelDownload } from "./parallel-download.js";

function mockFetch(totalBytes, { failRanges = new Set() } = {}) {
  const calls = [];
  const delays = new Map();
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
    if (delays.has(start)) await new Promise((resolve) => setTimeout(resolve, delays.get(start)));
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
  return { calls, delays };
}

function fakeSink() {
  const chunks = [];
  return {
    chunks,
    async write(data) {
      chunks.push(data.byteLength);
    },
    async close() {},
    async abort() {},
  };
}

test("downloads disjoint ranges in parallel and writes them in order", async () => {
  const total = 20 * 1024 * 1024;
  const { calls } = mockFetch(total);
  const sink = fakeSink();
  const progress = [];
  const result = await parallelDownload({
    url: "http://server.test/file",
    filename: "Test Video.mp4",
    createSink: async () => sink,
    chunkBytes: 5 * 1024 * 1024,
    onProgress: (written, all) => progress.push([written, all]),
  });
  assert.equal(result.bytes, total);
  assert.equal(calls.length, 4);
  const written = sink.chunks.reduce((sum, length) => sum + length, 0);
  assert.equal(written, total);
  assert.deepEqual(sink.chunks, [5 * 1024 * 1024, 5 * 1024 * 1024, 5 * 1024 * 1024, 5 * 1024 * 1024]);
  assert.deepEqual(progress.at(-1), [total, total]);
});

test("buffers out-of-order arrivals and flushes in file order", async () => {
  const total = 4 * 1024 * 1024;
  const { calls, delays } = mockFetch(total);
  delays.set(0, 120); // the first range arrives last
  const sink = fakeSink();
  await parallelDownload({
    url: "http://server.test/file",
    filename: "T.mp4",
    createSink: async () => sink,
    chunkBytes: 1024 * 1024,
  });
  assert.deepEqual(
    sink.chunks,
    [1024 * 1024, 1024 * 1024, 1024 * 1024, 1024 * 1024],
    "sink must receive chunks in file order",
  );
  assert.deepEqual(calls.map(([start]) => start).sort((a, b) => a - b), [0, 1048576, 2097152, 3145728]);
});

test("retries dropped ranges and still completes", async () => {
  const total = 6 * 1024 * 1024;
  const { calls } = mockFetch(total, { failRanges: new Set(["0-2097151"]) });
  const sink = fakeSink();
  const result = await parallelDownload({
    url: "http://server.test/file",
    filename: "T.mp4",
    createSink: async () => sink,
    chunkBytes: 2 * 1024 * 1024,
  });
  assert.equal(result.bytes, total);
  const zeroStarts = calls.filter(([start]) => start === 0);
  assert.ok(zeroStarts.length >= 2, "dropped range should be retried");
});

test("resumes from a start offset and only fetches the remaining ranges", async () => {
  const total = 10 * 1024 * 1024;
  const { calls } = mockFetch(total);
  const sink = fakeSink();
  const progress = [];
  const result = await parallelDownload({
    url: "http://server.test/file",
    filename: "T.mp4",
    createSink: async () => sink,
    chunkBytes: 2 * 1024 * 1024,
    startOffset: 6 * 1024 * 1024,
    onProgress: (written, all) => progress.push([written, all]),
  });
  assert.equal(result.bytes, total);
  assert.deepEqual(calls.map(([start]) => start), [6291456, 8388608]);
  const written = sink.chunks.reduce((sum, length) => sum + length, 0);
  assert.equal(written, 4 * 1024 * 1024);
  assert.deepEqual(progress.at(-1), [total, total]);
});
