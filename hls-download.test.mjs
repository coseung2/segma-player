import test from "node:test";
import assert from "node:assert/strict";

const status = { textContent: "", classList: { toggle() {} } };
const startButton = { hidden: true, disabled: false, addEventListener() {} };
const hintElement = { hidden: true };
const versionElement = { textContent: "" };
let nextLeaseId = 0;
const leaseEvents = [];
const routeEvents = [];
let routeResponse = { ok: true, hosts: ["media.example"] };
let pingResponse = { ok: true, capabilities: { mediaFetchLease: 1 } };
let recordedHeaderResponse = { ok: true, headers: {} };
let decodedKeyResponse = { ok: false };
let runtimeObserver = () => {};
globalThis.document = {
  querySelector(selector) {
    if (selector === "#status") return status;
    if (selector === "#start-download") return startButton;
    if (selector === "#hint") return hintElement;
    if (selector === "#version") return versionElement;
    throw new Error(`unexpected selector: ${selector}`);
  },
};
globalThis.chrome = {
  runtime: {
    async sendMessage(message) {
      runtimeObserver(message);
      if (message.type === "ping-media-stream") return pingResponse;
      if (message.type === "get-request-headers") return recordedHeaderResponse;
      if (message.type === "decode-hls-key") return decodedKeyResponse;
      if (message.type === "ensure-media-routes") {
        routeEvents.push(message);
        return routeResponse;
      }
      if (message.type === "prepare-media-fetch") {
        leaseEvents.push({ type: "prepare", url: message.url, referrer: message.referrer });
        return { ok: true, leaseId: `lease-${++nextLeaseId}` };
      }
      if (message.type === "release-media-fetch") {
        leaseEvents.push({ type: "release", leaseId: message.leaseId });
        return { ok: true };
      }
      return { ok: true };
    },
  },
};

const {
  createDownloadContext,
  ensureCurrentBackground,
  loadRecordedHeaders,
  MAX_HLS_SEGMENTS,
  mediaChunks,
  prepareHlsKeys,
  prepareProgressiveFetch,
  progressiveFilenameFor,
  requestPageDecodedKey,
  streamFetchToWritable,
  withMediaFetchLease,
  writeChunk,
} = await import("./hls-download.js");

test("does not impose a total byte cap and allows long finite HLS playlists", () => {
  assert.equal(MAX_HLS_SEGMENTS, 10_000);
});

test("uses the detected page title for progressive download filenames", () => {
  const title = "RLMP-005 의료비 체납의 대가로 악덕 의사와 키 ● 가이 환자에게 마 ● 고가 망가질 때까지 범 × 계속 맨 국물 흘려 어머니 딸.";
  assert.equal(progressiveFilenameFor({
    pageTitle: title,
    resourceUrl: "https://cdn.example/files/token/video.mp4?expires=1",
  }), `${title}.mp4`);
  assert.equal(progressiveFilenameFor({
    pageTitle: "직접 입력한 주소",
    resourceUrl: "https://cdn.example/files/original.webm?expires=1",
  }), "original.webm");
});

test("keeps recorded request headers isolated between parallel jobs", async () => {
  const firstUrl = "https://first.example/video.mp4";
  const secondUrl = "https://second.example/video.mp4";
  const first = createDownloadContext();
  const second = createDownloadContext();
  recordedHeaderResponse = { ok: true, headers: { [firstUrl]: { Authorization: "Bearer first" } } };
  await loadRecordedHeaders(first);
  recordedHeaderResponse = { ok: true, headers: { [secondUrl]: { Authorization: "Bearer second" } } };
  await loadRecordedHeaders(second);
  const observed = new Map();
  globalThis.fetch = async (url, options) => {
    observed.set(String(url), options.headers.get("authorization"));
    return { ok: true, status: 200, text: async () => "ok" };
  };

  await Promise.all([
    withMediaFetchLease(firstUrl, "https://page.example/first", (response) => response.text(), {}, first),
    withMediaFetchLease(secondUrl, "https://page.example/second", (response) => response.text(), {}, second),
  ]);
  assert.equal(observed.get(firstUrl), "Bearer first");
  assert.equal(observed.get(secondUrl), "Bearer second");
});

test("prepares every protected HLS key before segment download can continue off-page", async () => {
  const keyUrl = "https://media.example/v/preflight-key?test=prepare-all";
  const statuses = [];
  const context = createDownloadContext({ onStatus: (message) => statuses.push(message), frameId: 23 });
  let decodeRequest = null;
  runtimeObserver = (message) => { if (message.type === "decode-hls-key") decodeRequest = message; };
  decodedKeyResponse = { ok: true, key: Array.from({ length: 16 }, (_, index) => index) };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new Uint8Array(24).buffer,
  });

  try {
    const count = await prepareHlsKeys({
      keys: [
        { uri: keyUrl, method: "AES-128", startIndex: 0 },
        { uri: keyUrl, method: "AES-128", startIndex: 5 },
      ],
    }, "https://page.example/watch", 17, context);
    assert.equal(count, 1);
    assert.equal(decodeRequest?.tabId, 17);
    assert.equal(decodeRequest?.frameId, 23);
    assert.ok(statuses.some((message) => message.includes("보호 키 1/1 준비 중")));
    assert.ok(statuses.some((message) => message.includes("원본 페이지를 벗어나도")));
  } finally {
    runtimeObserver = () => {};
  }
});

test("requests protected HLS keys from the active page loader", async () => {
  let decodeRequest = null;
  runtimeObserver = (message) => { if (message.type === "decode-hls-key") decodeRequest = message; };
  decodedKeyResponse = { ok: true, key: Array.from({ length: 16 }, (_, index) => index) };
  const key = await requestPageDecodedKey("https://media.example/v/session?p=0", 17, 23);
  assert.deepEqual(Array.from(key), Array.from({ length: 16 }, (_, index) => index));
  assert.equal(decodeRequest?.frameId, 23);
  decodedKeyResponse = { ok: false, error: "runtime-import-failed" };
  await assert.rejects(
    () => requestPageDecodedKey("https://media.example/v/session?p=0", 17, 23),
    /runtime-import-failed/,
  );
  runtimeObserver = () => {};
});

test("rejects a stale background that lacks the media-fetch lease contract", async () => {
  pingResponse = { ok: true };
  assert.equal(await ensureCurrentBackground(), false);
  pingResponse = { ok: true, capabilities: { mediaFetchLease: 1 } };
  assert.equal(await ensureCurrentBackground(), true);
});

test("holds the lease through response consumption and releases it afterwards", async () => {
  leaseEvents.length = 0;
  routeResponse = { ok: true, hosts: ["media.example"] };
  const events = [];
  globalThis.fetch = async () => {
    events.push("fetch");
    return {
      ok: true,
      status: 200,
      text: async () => {
        events.push("consume");
        assert.deepEqual(leaseEvents.map((event) => event.type), ["prepare"]);
        return "playlist";
      },
    };
  };

  const text = await withMediaFetchLease(
    "https://media.example/playlist.m3u8",
    "https://page.example/watch",
    (response) => response.text(),
  );

  assert.equal(text, "playlist");
  assert.deepEqual(events, ["fetch", "consume"]);
  assert.deepEqual(leaseEvents.map((event) => event.type), ["prepare", "release"]);
  assert.equal(leaseEvents[1].leaseId, `lease-${nextLeaseId}`);
});

test("streams readable and arrayBuffer responses locally under one lease", async () => {
  leaseEvents.length = 0;
  routeResponse = { ok: true, hosts: ["media.example"] };
  const writes = [];
  const progress = [];
  const writable = { write: async (params) => writes.push(params) };
  let responseNumber = 0;
  globalThis.fetch = async () => {
    responseNumber += 1;
    if (responseNumber === 1) {
      const values = [new Uint8Array([1, 2]), new Uint8Array([3])];
      return {
        ok: true,
        status: 200,
        body: {
          getReader() {
            return { read: async () => values.length
              ? { done: false, value: values.shift() }
              : { done: true } };
          },
        },
      };
    }
    return {
      ok: true,
      status: 200,
      body: null,
      arrayBuffer: async () => new Uint8Array([4, 5]).buffer,
    };
  };

  assert.equal(
    await streamFetchToWritable(
      "https://media.example/stream.mp4",
      "https://page.example/watch",
      writable,
      (bytes) => progress.push(bytes),
    ),
    3,
  );
  assert.equal(
    await streamFetchToWritable(
      "https://media.example/fallback.mp4",
      "https://page.example/watch",
      writable,
      (bytes) => progress.push(bytes),
    ),
    2,
  );

  assert.deepEqual(writes.map(({ type, data }) => ({ type, data: Array.from(data) })), [
    { type: "write", data: [1, 2] },
    { type: "write", data: [3] },
    { type: "write", data: [4, 5] },
  ]);
  assert.deepEqual(progress, [2, 3, 2]);
  assert.equal(leaseEvents.filter((event) => event.type === "prepare").length, 2);
  assert.equal(leaseEvents.filter((event) => event.type === "release").length, 2);
});

test("does not fetch a media URL until route preparation succeeds", async () => {
  routeEvents.length = 0;
  leaseEvents.length = 0;
  routeResponse = { ok: true, hosts: ["media.example"] };
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    assert.equal(routeEvents.length, 1);
    assert.deepEqual(routeEvents[0].urls, [
      "https://media.example/stream.mp4",
      "https://page.example/watch",
    ]);
    return {
      ok: true,
      status: 200,
      text: async () => "media",
    };
  };

  await withMediaFetchLease(
    "https://media.example/stream.mp4",
    "https://page.example/watch",
    (response) => response.text(),
  );
  assert.equal(fetchCount, 1);
  assert.equal(leaseEvents[0].type, "prepare");
});

test("fails closed without fetching or installing a media lease after route failure", async () => {
  routeEvents.length = 0;
  leaseEvents.length = 0;
  routeResponse = { ok: false, error: "route-timeout" };
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return { ok: true, status: 200, text: async () => "must not load" };
  };

  await assert.rejects(
    withMediaFetchLease(
      "https://media.example/blocked.mp4",
      "https://page.example/watch",
      (response) => response.text(),
    ),
    (error) => error.code === "media-route-failed"
      && error.message === "미디어 경로 준비 시간이 초과되었습니다. 다시 시도해 주세요.",
  );
  assert.equal(fetchCount, 0);
  assert.deepEqual(leaseEvents, []);
  routeResponse = { ok: true, hosts: ["media.example"] };
});

test("runs the authenticated redirect probe under a lease before handing off the full fetch", async () => {
  routeEvents.length = 0;
  leaseEvents.length = 0;
  routeResponse = { ok: true, hosts: ["media.example"] };
  const initialUrl = "https://media.example/redirect?id=sample";
  const finalUrl = "https://edge.example/video.mp4";
  const referrer = "https://page.example/watch";
  const events = [];
  recordedHeaderResponse = {
    ok: true,
    headers: {
      [initialUrl]: { rAnGe: "bytes=1048576-", Authorization: "Bearer probe" },
      [finalUrl]: { RANGE: "bytes=1048576-", Authorization: "Bearer full" },
    },
  };
  await loadRecordedHeaders();
  runtimeObserver = (message) => {
    if (message.type === "ensure-media-routes") events.push(["route", message.urls[0]]);
    if (message.type === "prepare-media-fetch") events.push(["lease", message.url]);
    if (message.type === "release-media-fetch") events.push(["release", message.leaseId]);
  };
  let fetchNumber = 0;
  globalThis.fetch = async (url, options) => {
    fetchNumber += 1;
    if (fetchNumber === 1) {
      events.push(["probe", url, options]);
      assert.equal(options.headers.get("range"), "bytes=0-0");
      assert.equal(options.headers.get("authorization"), "Bearer probe");
      return {
        ok: true,
        status: 206,
        url: finalUrl,
        body: {
          cancel: async () => {
            events.push(["cancel"]);
            assert.equal(events.some(([type]) => type === "release"), false);
          },
        },
      };
    }
    events.push(["full", url, options]);
    assert.equal(url, finalUrl);
    assert.equal(options.headers.has("range"), false);
    assert.equal(options.headers.get("authorization"), "Bearer full");
    assert.ok(events.some(([type, value]) => type === "route" && value === finalUrl));
    return {
      ok: true,
      status: 200,
      body: null,
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    };
  };

  try {
    const prepared = await prepareProgressiveFetch({
      mode: "fetch",
      url: initialUrl,
      referrer,
      authenticatedProbeRequired: true,
    });
    assert.equal(prepared.url, finalUrl);
    assert.equal(prepared.authenticatedProbeRequired, false);

    const writes = [];
    await streamFetchToWritable(finalUrl, referrer, { write: async (value) => writes.push(value) });
    assert.equal(writes.length, 1);
    assert.deepEqual(events.map(([type, value]) => [type, type === "release" ? undefined : value]), [
      ["route", initialUrl],
      ["lease", initialUrl],
      ["probe", initialUrl],
      ["cancel", undefined],
      ["release", undefined],
      ["route", finalUrl],
      ["route", finalUrl],
      ["lease", finalUrl],
      ["full", finalUrl],
      ["release", undefined],
    ]);
    const preparedLeaseIds = leaseEvents
      .filter(({ type }) => type === "prepare")
      .slice(-2)
      .map((_, index) => `lease-${nextLeaseId - 1 + index}`);
    assert.deepEqual(
      leaseEvents.filter(({ type }) => type === "release").slice(-2).map(({ leaseId }) => leaseId),
      preparedLeaseIds,
    );
  } finally {
    runtimeObserver = () => {};
  }
});

test("shows a Korean authenticated-probe error with the HTTP status", async () => {
  leaseEvents.length = 0;
  routeResponse = { ok: true, hosts: ["media.example"] };
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    url: "https://media.example/blocked.mp4",
    body: { cancel: async () => {} },
  });

  await assert.rejects(
    prepareProgressiveFetch({
      url: "https://media.example/blocked.mp4",
      referrer: "https://page.example/watch",
      authenticatedProbeRequired: true,
    }),
    /인증된 영상 확인 요청에 실패했습니다 \(HTTP 403\)/,
  );
  assert.deepEqual(leaseEvents.slice(-2).map(({ type }) => type), ["prepare", "release"]);
});

test("does not probe when the background did not request authenticated fallback", async () => {
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("must not fetch");
  };
  const session = {
    url: "https://media.example/video.mp4",
    referrer: "https://page.example/watch",
    authenticatedProbeRequired: false,
  };
  assert.equal(await prepareProgressiveFetch(session), session);
  assert.equal(fetchCount, 0);
});

test("normalizes ArrayBuffer, typed-array, and JSON object chunks for writes", async () => {
  const writes = [];
  const writable = { write: async (params) => writes.push(params) };
  await writeChunk(writable, new Uint8Array([6, 7]));
  await writeChunk(writable, new Uint8Array([8, 9]).buffer);
  await writeChunk(writable, { 0: 10, 1: 11 });

  assert.deepEqual(writes.map(({ type, data }) => ({ type, data: Array.from(data) })), [
    { type: "write", data: [6, 7] },
    { type: "write", data: [8, 9] },
    { type: "write", data: [10, 11] },
  ]);
  assert.ok(writes.every(({ data }) => data instanceof Uint8Array));
});

test("fetches segments concurrently but yields them in order", async () => {
  leaseEvents.length = 0;
  const total = 20;
  const segmentData = Array.from({ length: total }, (_, index) => new Uint8Array([index]));
  let inFlight = 0;
  let maxInFlight = 0;
  globalThis.fetch = async (url) => {
    const index = Number(new URL(String(url)).searchParams.get("i"));
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, index === 0 ? 100 : 5));
    inFlight -= 1;
    return {
      ok: true,
      status: 200,
      url: String(url),
      arrayBuffer: async () => segmentData[index].slice(),
    };
  };

  const media = {
    initUrl: null,
    segments: Array.from({ length: total }, (_, index) => `https://media.example/seg?i=${index}`),
    keys: [],
    mediaSequence: 0,
  };
  const chunks = [];
  for await (const chunk of mediaChunks(media, "https://page.example/")) {
    chunks.push(chunk);
  }
  assert.deepEqual(chunks.map((chunk) => chunk[0]), Array.from({ length: total }, (_, index) => index));
  assert.ok(maxInFlight >= 2, `expected parallel fetches, observed max ${maxInFlight}`);
});

test("propagates a segment failure while keeping other workers from hanging", async () => {
  leaseEvents.length = 0;
  globalThis.fetch = async (url) => {
    const index = Number(new URL(String(url)).searchParams.get("i"));
    await new Promise((resolve) => setTimeout(resolve, index === 5 ? 5 : 1));
    if (index === 5) return { ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) };
    return {
      ok: true,
      status: 200,
      url: String(url),
      arrayBuffer: async () => new Uint8Array([index]),
    };
  };

  const media = {
    initUrl: null,
    segments: Array.from({ length: 10 }, (_, index) => `https://media.example/seg?i=${index}`),
    keys: [],
    mediaSequence: 0,
  };
  let received = 0;
  let error = null;
  try {
    for await (const chunk of mediaChunks(media, "")) {
      assert.equal(chunk[0], received);
      received += 1;
    }
  } catch (caught) {
    error = caught;
  }
  assert.equal(error?.message, "세그먼트 6 요청 실패 (500): https://media.example/seg");
  assert.equal(received, 5);
});
