import test from "node:test";
import assert from "node:assert/strict";

globalThis.document = { querySelector: () => null };

const {
  browserDownloadFilename,
  isCompanionUnavailableError,
  prepareProgressiveFetch,
  requestSourceFrameDownload,
  tryBrowserDownloadFallback,
} = await import("./hls-download.js");

test("Dood-compatible media falls back to its source frame when an authenticated probe is CORS-blocked", async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "ensure-media-routes") return { ok: true };
        if (message.type === "prepare-media-fetch") return { ok: true, leaseId: "lease-playmogo" };
        if (message.type === "release-media-fetch") return { ok: true };
        return { ok: true };
      },
    },
  };
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  const prepared = await prepareProgressiveFetch({
    url: "https://asw188q.cloudatacdn.com/media/video.mp4",
    referrer: "https://playmogo.com/e/0tma53gi8rvo",
    authenticatedProbeRequired: true,
  });
  assert.equal(prepared.authenticatedProbeRequired, false);
  assert.equal(prepared.sourceFrameFallbackPreferred, true);
  delete globalThis.fetch;
  delete globalThis.chrome;
});

test("source-frame download requests are relayed through the background worker", async () => {
  let captured = null;
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        captured = message;
        return { ok: true };
      },
    },
  };
  assert.deepEqual(await requestSourceFrameDownload(
    "https://asw188q.cloudatacdn.com/media/video.mp4",
    "playmogo.mp4",
    17,
    3,
  ), { fallback: true });
  assert.deepEqual(captured, {
    type: "download-in-source-frame",
    url: "https://asw188q.cloudatacdn.com/media/video.mp4",
    filename: "playmogo.mp4",
    tabId: 17,
    frameId: 3,
  });
  delete globalThis.chrome;
});

test("companion unavailable error detection", () => {
  assert.equal(isCompanionUnavailableError(new Error("Aura Media Companion을 실행하지 못했습니다.")), true);
  assert.equal(isCompanionUnavailableError(new Error("기본 Downloads 저장 helper 연결이 끊겼습니다.")), true);
  assert.equal(isCompanionUnavailableError(new Error("Specified native messaging host not found.")), true);
  assert.equal(isCompanionUnavailableError(new Error("disk full")), false);
});

test("browser download filenames are sanitized", () => {
  assert.equal(browserDownloadFilename("제목: 테스트/영상.mp4"), "제목_ 테스트_영상.mp4");
  assert.equal(browserDownloadFilename("../../etc/passwd.mp4"), "aura-media.mp4");
  assert.equal(browserDownloadFilename(""), "aura-media.mp4");
  assert.equal(browserDownloadFilename("ok.webm"), "ok.webm");
});

test("browser download fallback starts a chrome.downloads job", async () => {
  let captured = null;
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "ensure-media-routes") return { ok: true };
        if (message.type === "prepare-media-fetch") return { ok: true, leaseId: "lease-1" };
        return { ok: true };
      },
    },
    downloads: {
      download: async (options) => {
        captured = options;
        return 42;
      },
    },
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 206,
    headers: new Headers({ "content-type": "video/mp4", "content-range": "bytes 0-0/2048" }),
    body: { cancel: async () => {} },
  });
  const result = await tryBrowserDownloadFallback(
    "https://cdn.example/video.mp4",
    "video.mp4",
    { maxDownloadBytes: null },
    "https://example.com/",
  );
  assert.deepEqual(result, { fallback: true, bytes: 0 });
  assert.equal(captured.url, "https://cdn.example/video.mp4");
  assert.equal(captured.filename, "video.mp4");
  assert.equal(captured.conflictAction, "uniquify");
  delete globalThis.fetch;
  delete globalThis.chrome;
});

test("browser download fallback reports a clear failure", async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "ensure-media-routes") return { ok: true };
        if (message.type === "prepare-media-fetch") return { ok: true, leaseId: "lease-2" };
        return { ok: true };
      },
    },
    downloads: {
      download: async () => {
        throw new Error("NETWORK_ERROR");
      },
    },
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 206,
    headers: new Headers({ "content-type": "video/mp4", "content-range": "bytes 0-0/2048" }),
    body: { cancel: async () => {} },
  });
  await assert.rejects(
    tryBrowserDownloadFallback("https://cdn.example/video.mp4", "video.mp4", { maxDownloadBytes: null }),
    /브라우저 다운로드로 저장하지 못했습니다/,
  );
  delete globalThis.fetch;
  delete globalThis.chrome;
});

test("browser download fallback is skipped without the downloads API", async () => {
  globalThis.chrome = {};
  assert.equal(
    await tryBrowserDownloadFallback("https://cdn.example/video.mp4", "video.mp4", { maxDownloadBytes: null }),
    null,
  );
  delete globalThis.chrome;
});

test("browser download fallback rejects a web page disguised as an mp4 URL", async () => {
  let started = false;
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "ensure-media-routes") return { ok: true };
        if (message.type === "prepare-media-fetch") return { ok: true, leaseId: "lease-1" };
        if (message.type === "release-media-fetch") return { ok: true };
        return { ok: true };
      },
    },
    downloads: {
      download: async () => {
        started = true;
        return 42;
      },
    },
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/html; charset=UTF-8", "content-length": "1024" }),
    body: { cancel: async () => {} },
  });
  await assert.rejects(
    tryBrowserDownloadFallback(
      "https://files.example/file/video.mp4",
      "video.mp4",
      { maxDownloadBytes: null },
      "https://files.example/",
    ),
    /영상 파일이 아니라 웹페이지/,
  );
  assert.equal(started, false);
  delete globalThis.fetch;
  delete globalThis.chrome;
});

test("browser download fallback accepts unknown content type when probing is inconclusive", async () => {
  let started = false;
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "ensure-media-routes") return { ok: true };
        if (message.type === "prepare-media-fetch") return { ok: true, leaseId: "lease-3" };
        return { ok: true };
      },
    },
    downloads: {
      download: async () => {
        started = true;
        return 43;
      },
    },
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 206,
    headers: new Headers({ "content-range": "bytes 0-0/2048" }),
    body: { cancel: async () => {} },
  });
  const result = await tryBrowserDownloadFallback(
    "https://files.example/download?id=1",
    "video.mp4",
    { maxDownloadBytes: null },
    "https://files.example/",
  );
  assert.deepEqual(result, { fallback: true, bytes: 0 });
  assert.equal(started, true);
  delete globalThis.fetch;
  delete globalThis.chrome;
});
