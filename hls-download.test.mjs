import test from "node:test";
import assert from "node:assert/strict";

globalThis.document = { querySelector: () => null };

const {
  browserDownloadFilename,
  chooseDashRepresentation,
  createCheckpointingSink,
  createDownloadContext,
  dashTracksForPlan,
  hlsDownloadConcurrencyForPlan,
  mediaChunks,
  prepareDownloadCandidate,
  prepareProgressiveFetch,
  prepareSubtitleAudioUpload,
  progressiveSession,
  requestPageDecodedKey,
  requestSourceFrameDownload,
  saveProgressive,
  tryBrowserDownloadFallback,
} = await import("./hls-download.js");

test("Companion progressive saves use bounded Range requests when the server supports them", async () => {
  globalThis.btoa ||= (value) => Buffer.from(value, "binary").toString("base64");
  const nativeMessages = [];
  const ranges = [];
  let nativeMessageListener = null;
  const nativePort = {
    onMessage: { addListener(listener) { nativeMessageListener = listener; } },
    onDisconnect: { addListener() {} },
    postMessage(message) {
      nativeMessages.push(message.type);
      queueMicrotask(() => nativeMessageListener?.({
        jobId: message.jobId,
        status: "ok",
        fileName: "video.mp4",
      }));
    },
    disconnect() {},
  };
  globalThis.chrome = {
    runtime: {
      connect: ({ name }) => {
        assert.equal(name, "native-file-writer");
        return nativePort;
      },
      sendMessage: async (message) => {
        if (message.type === "ensure-media-routes") return { ok: true };
        if (message.type === "prepare-media-fetch") return { ok: true, leaseId: "lease-native-range" };
        if (message.type === "touch-media-fetch" || message.type === "release-media-fetch") return { ok: true };
        throw new Error(`unexpected runtime message: ${message.type}`);
      },
    },
  };
  const totalBytes = 1024 * 1024;
  globalThis.fetch = async (_url, options = {}) => {
    const headers = options.headers || {};
    const range = typeof headers.get === "function" ? headers.get("range") : headers.Range;
    ranges.push(range || "");
    assert.equal(range, `bytes=0-${totalBytes - 1}`);
    return new Response(new Uint8Array(totalBytes), {
      status: 206,
      headers: { "content-range": `bytes 0-${totalBytes - 1}/${totalBytes}`, "content-type": "video/mp4" },
    });
  };
  const context = createDownloadContext({
    totalBytes,
    tabId: 17,
    frameId: 4,
    candidate: { mediaType: "PROGRESSIVE", downloadMode: "DIRECT_PROGRESSIVE" },
  });
  context.rangeSupported = true;
  let selectedFolderQueries = 0;
  const selectedFolder = {
    async queryPermission() {
      selectedFolderQueries += 1;
      return "granted";
    },
    async getFileHandle() {
      throw new Error("the selected folder must remain a fallback while Companion is available");
    },
  };
  const result = await saveProgressive(
    "https://a-delivery31.mxcontent.net/v2/video.mp4?token=redacted",
    "video.mp4",
    "https://shackledshow.cc/videos/example",
    17,
    context,
    {
      url: "https://a-delivery31.mxcontent.net/v2/video.mp4?token=redacted",
      referrer: "https://miixdrop.top/e/example",
      authenticatedProbeRequired: false,
      videoFrameId: 4,
    },
    selectedFolder,
  );
  assert.deepEqual(result, { bytes: totalBytes, native: true });
  assert.deepEqual(ranges, [`bytes=0-${totalBytes - 1}`]);
  assert.equal(nativeMessages[0], "media-open");
  assert.equal(nativeMessages.at(-1), "media-close");
  assert.ok(nativeMessages.includes("media-chunk"));
  assert.equal(selectedFolderQueries, 0);
  delete globalThis.fetch;
  delete globalThis.chrome;
});

test("Pro raises HLS segment parallelism without removing the regular edition cap", () => {
  assert.equal(hlsDownloadConcurrencyForPlan({ id: "free" }), 6);
  assert.equal(hlsDownloadConcurrencyForPlan({ id: "pro" }), 10);
});

test("checkpointing sink close is idempotent after a parallel save closes it", async () => {
  let closeCount = 0;
  const fileHandle = {
    async createWritable() {
      return {
        async write() {},
        async seek() {},
        async close() {
          closeCount += 1;
          if (closeCount > 1) throw new Error("Cannot close a CLOSED writable stream");
        },
        async abort() {},
      };
    },
  };
  const sink = await createCheckpointingSink({ fileHandle });
  await sink.close();
  await sink.close();
  assert.equal(closeCount, 1);
});

test("page-key preparation exits immediately when cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    requestPageDecodedKey("https://media.example/key", 1, 0, controller.signal),
    (error) => error?.name === "AbortError" && error?.code === "download-cancelled",
  );
});

test("page-key failures preserve a structured Level5 recovery code", async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: async () => ({ ok: false, error: "level5-loader-failed" }),
    },
  };
  await assert.rejects(
    requestPageDecodedKey("https://media.example/v/session", 1, 0),
    (error) => error?.code === "level5-loader-failed"
      && error.message.includes("보호된 영상 키 확인 실패"),
  );
  delete globalThis.chrome;
});

test("progressive preparation disconnects its runtime port when cancelled", async () => {
  let disconnects = 0;
  globalThis.chrome = {
    runtime: {
      connect: () => ({
        disconnect: () => { disconnects += 1; },
        onDisconnect: { addListener: () => {} },
        onMessage: { addListener: () => {} },
        postMessage: () => {},
      }),
    },
  };
  const controller = new AbortController();
  const pending = progressiveSession(
    "https://media.example/video.mp4",
    "https://player.example/watch",
    1,
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.equal(disconnects, 1);
});

test("progressive preparation carries the exact source frame to Dood refresh", async () => {
  let posted = null;
  let onMessage = null;
  globalThis.chrome = {
    runtime: {
      connect: () => ({
        disconnect: () => {},
        onDisconnect: { addListener: () => {} },
        onMessage: { addListener: (listener) => { onMessage = listener; } },
        postMessage: (message) => {
          posted = message;
          queueMicrotask(() => onMessage?.({
            type: "fetch-required",
            url: message.url,
            referrer: message.pageUrl,
            videoFrameId: 11,
            authenticatedProbeRequired: false,
          }));
        },
      }),
    },
  };
  const session = await progressiveSession(
    "https://cloudatacdn.example/video.mp4",
    "https://dood.example/e/player",
    21,
    null,
    7,
  );
  assert.equal(session.url, "https://cloudatacdn.example/video.mp4");
  assert.equal(posted.videoTabId, 21);
  assert.equal(posted.videoFrameId, 7);
  assert.equal(session.videoFrameId, 11, "the refreshed playing frame must replace the stale candidate frame");
  delete globalThis.chrome;
});

test("Dood progressive candidates prefer the authenticated source frame", async () => {
  const session = await prepareProgressiveFetch(
    {
      url: "https://asw188q.cloudatacdn.com/video.mp4",
      referrer: "https://dood.example/e/player",
      authenticatedProbeRequired: false,
    },
    createDownloadContext({
      tabId: 21,
      frameId: 7,
      candidate: { downloadMode: "AUTHENTICATED_SOURCE_FRAME" },
    }),
  );
  assert.equal(session.sourceFrameFallbackPreferred, true);
  assert.equal(session.sourceFrameFallbackReason, "authenticated-source-frame");
});

test("loadMediaPlaylist accepts EXT-X-BYTERANGE playlists", async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "ensure-media-routes") return { ok: true };
        if (message.type === "prepare-media-fetch") return { ok: true, leaseId: "lease-br" };
        if (message.type === "release-media-fetch") return { ok: true };
        return { ok: true };
      },
    },
  };
  globalThis.fetch = async () => new Response(
    "#EXTM3U\n#EXTINF:4,\n#EXT-X-BYTERANGE:1000@0\nseg.bin\n#EXTINF:4,\n#EXT-X-BYTERANGE:500\n",
    { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" } },
  );
  try {
    const prepared = await prepareDownloadCandidate({
      resourceUrl: "https://media.example/video/stream.m3u8",
      pageUrl: "https://media.example/",
      pageTitle: "바이트레인지 테스트",
      tabId: 1,
      mediaType: "HLS_MASTER",
    });
    assert.equal(prepared.media.byterange, true);
    assert.equal(prepared.media.segments.length, 2);
    assert.deepEqual(prepared.media.byteranges, [
      { length: 1000, offset: 0 },
      { length: 500, offset: 1000 },
    ]);
  } finally {
    delete globalThis.fetch;
    delete globalThis.chrome;
  }
});

test("prepares static DASH video and audio tracks for extension-only saving", async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "get-request-headers") return { ok: true, headers: {} };
        if (message.type === "ensure-media-routes") return { ok: true };
        if (message.type === "prepare-media-fetch") return { ok: true, leaseId: "dash-lease" };
        if (message.type === "release-media-fetch") return { ok: true };
        return { ok: true };
      },
    },
  };
  globalThis.fetch = async () => new Response(`<MPD mediaPresentationDuration="PT4S">
    <Period duration="PT4S">
      <AdaptationSet mimeType="video/mp4" contentType="video">
        <Representation id="v720" bandwidth="900000" width="1280" height="720">
          <SegmentTemplate duration="2" initialization="v-init.mp4" media="v-$Number$.m4s" />
        </Representation>
      </AdaptationSet>
      <AdaptationSet mimeType="audio/mp4" contentType="audio">
        <Representation id="a1" bandwidth="128000">
          <SegmentTemplate duration="2" initialization="a-init.mp4" media="a-$Number$.m4s" />
        </Representation>
      </AdaptationSet>
    </Period>
  </MPD>`, { status: 200, headers: { "content-type": "application/dash+xml" } });
  try {
    const prepared = await prepareDownloadCandidate({
      resourceUrl: "https://media.example/movie.mpd",
      pageUrl: "https://player.example/watch",
      pageTitle: "DASH 영화",
      tabId: 3,
      frameId: 1,
      mediaType: "DASH",
    });
    assert.equal(prepared.type, "dash");
    assert.deepEqual(prepared.tracks.map((track) => track.kind), ["video", "audio"]);
    assert.deepEqual(prepared.tracks.map((track) => track.media.segments.length), [2, 2]);
    assert.equal(prepared.tracks[0].filename, "DASH 영화-video.mp4");
    assert.equal(prepared.tracks[1].filename, "DASH 영화-audio.m4a");
    assert.equal(chooseDashRepresentation(prepared.tracks.map((track) => track.representation), "video").id, "v720");
    assert.equal(dashTracksForPlan(prepared.plan, "다시 선택").length, 2);
  } finally {
    delete globalThis.fetch;
    delete globalThis.chrome;
  }
});

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

test("Dood-compatible media uses source-frame fallback when authenticated range probing returns HTTP 405", async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "ensure-media-routes") return { ok: true };
        if (message.type === "prepare-media-fetch") return { ok: true, leaseId: "lease-playmogo-405" };
        if (message.type === "release-media-fetch") return { ok: true };
        return { ok: true };
      },
    },
  };
  globalThis.fetch = async () => new Response("method not allowed", { status: 405 });
  const prepared = await prepareProgressiveFetch({
    url: "https://asw188q.cloudatacdn.com/media/video.mp4",
    referrer: "https://playmogo.com/e/0tma53gi8rvo",
    authenticatedProbeRequired: true,
  });
  assert.equal(prepared.authenticatedProbeRequired, false);
  assert.equal(prepared.sourceFrameFallbackPreferred, true);
  assert.equal(prepared.sourceFrameFallbackReason, "http-405");
  delete globalThis.fetch;
  delete globalThis.chrome;
});

test("subtitle preparation uploads only a separate HLS audio rendition", async () => {
  const requested = [];
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "prepare-media-fetch") return { ok: true, leaseId: `lease-${requested.length}` };
        if (message.type === "release-media-fetch") return { ok: true };
        if (message.type === "ensure-media-routes") return { ok: true };
        return { ok: true };
      },
    },
  };
  globalThis.fetch = async (url) => {
    const value = String(url);
    requested.push(value);
    if (value.endsWith("master.m3u8")) {
      return new Response(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Japanese",LANGUAGE="ja",DEFAULT=YES,URI="audio/ja.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,AUDIO="audio"
video/1080.m3u8`, { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" } });
    }
    if (value.endsWith("audio/ja.m3u8")) {
      return new Response("#EXTM3U\n#EXTINF:4,\na0.ts\n#EXTINF:4,\na1.ts\n", {
        status: 200,
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    }
    if (value.endsWith("audio/a0.ts")) return new Response(new Uint8Array([1, 2]), { status: 200 });
    if (value.endsWith("audio/a1.ts")) return new Response(new Uint8Array([3, 4]), { status: 200 });
    throw new Error(`unexpected fetch: ${value}`);
  };
  try {
    const prepared = await prepareSubtitleAudioUpload({
      mediaUrl: "https://media.example/root/master.m3u8",
      sourceUrl: "https://site.example/watch/1",
      sourceTabId: 7,
      sourceFrameId: 3,
      mediaType: "HLS_MASTER",
      sourceLanguage: "ja",
    });
    assert.equal(prepared.source, "hls-audio-rendition");
    assert.equal(prepared.bytes, 4);
    assert.equal(prepared.filename, "aura-subtitle-audio.ts");
    assert.deepEqual([...new Uint8Array(await prepared.blob.arrayBuffer())], [1, 2, 3, 4]);
    assert.equal(requested.some((url) => url.includes("video/1080.m3u8")), false);
  } finally {
    delete globalThis.fetch;
    delete globalThis.chrome;
  }
});

test("mediaChunks resumes from a segment checkpoint", async () => {
  const requested = [];
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "prepare-media-fetch") return { ok: true, leaseId: "lease-resume" };
        if (message.type === "release-media-fetch") return { ok: true };
        return { ok: true };
      },
    },
  };
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    const index = Number(/s(\d+)/.exec(String(url))?.[1]);
    return new Response(new Uint8Array([index + 1]), { status: 200 });
  };
  try {
    const media = {
      initUrl: null,
      segments: [
        "https://media.example/video/s0.ts",
        "https://media.example/video/s1.ts",
        "https://media.example/video/s2.ts",
        "https://media.example/video/s3.ts",
      ],
      keys: [],
      mediaSequence: 0,
      byteranges: null,
    };
    const chunks = [];
    for await (const chunk of mediaChunks(
      media,
      "https://media.example/",
      1,
      createDownloadContext(),
      { resumeFromSegment: 2, startingBytes: 5 },
    )) {
      chunks.push(new Uint8Array(chunk));
    }
    assert.equal(chunks.length, 2);
    assert.deepEqual([...chunks[0]], [3]);
    assert.deepEqual([...chunks[1]], [4]);
    assert.equal(requested.includes("https://media.example/video/s0.ts"), false);
    assert.equal(requested.includes("https://media.example/video/s1.ts"), false);
    assert.equal(requested.includes("https://media.example/video/s2.ts"), true);
    assert.equal(requested.includes("https://media.example/video/s3.ts"), true);
  } finally {
    delete globalThis.fetch;
    delete globalThis.chrome;
  }
});

test("403 segment failures refresh the exact Level5 manifest from the source frame and continue", async () => {
  const requested = [];
  let refreshRequests = 0;
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "ensure-media-routes") return { ok: true };
        if (message.type === "prepare-media-fetch") return { ok: true, leaseId: crypto.randomUUID() };
        if (message.type === "release-media-fetch" || message.type === "touch-media-fetch") return { ok: true };
        if (message.type === "refresh-download-candidate") {
          refreshRequests += 1;
          return {
            ok: true,
            candidate: {
              ...message.candidate,
              resourceUrl: "https://media.nnvivi.site/video/master.m3u8?token=fresh",
              pageUrl: "https://p.nnvivi.site/embed/39141",
              player: "level5",
              sessionId: "level5:1",
            },
          };
        }
        return { ok: true };
      },
    },
  };
  globalThis.fetch = async (url) => {
    const value = String(url);
    requested.push(value);
    if (value.includes("master.m3u8?token=fresh")) {
      return new Response(
        "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4,\ns0.ts?token=fresh\n#EXTINF:4,\ns1.ts?token=fresh\n",
        { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" } },
      );
    }
    if (value.includes("token=stale")) return new Response(new Uint8Array(), { status: 403 });
    if (value.includes("s0.ts?token=fresh")) return new Response(new Uint8Array([1]), { status: 200 });
    if (value.includes("s1.ts?token=fresh")) return new Response(new Uint8Array([2]), { status: 200 });
    throw new Error(`unexpected fetch: ${value}`);
  };

  try {
    const candidate = {
      id: "candidate-level5",
      resourceUrl: "https://media.nnvivi.site/video/master.m3u8?token=stale",
      pageUrl: "https://p.nnvivi.site/embed/39141",
      pageTitle: "Level5",
      tabId: 7,
      frameId: 3,
      mediaType: "HLS_MEDIA",
      player: "level5",
      sessionId: "level5:1",
    };
    const media = {
      initUrl: null,
      initByterange: null,
      segments: [
        "https://media.nnvivi.site/video/s0.ts?token=stale",
        "https://media.nnvivi.site/video/s1.ts?token=stale",
      ],
      keys: [],
      variants: [],
      mediaSequence: 0,
      byteranges: [null, null],
      baseUrl: candidate.resourceUrl,
    };
    const context = createDownloadContext({ tabId: 7, frameId: 3, candidate });
    const chunks = [];
    for await (const chunk of mediaChunks(media, candidate.pageUrl, 7, context)) {
      chunks.push([...new Uint8Array(chunk)]);
    }

    assert.deepEqual(chunks, [[1], [2]]);
    assert.equal(refreshRequests, 1);
    assert.equal(media.segments.every((url) => url.includes("token=fresh")), true);
    assert.equal(context.candidate.resourceUrl.includes("token=fresh"), true);
    assert.equal(requested.some((url) => url.includes("master.m3u8?token=fresh")), true);
  } finally {
    delete globalThis.fetch;
    delete globalThis.chrome;
  }
});

test("source-frame download requests are relayed through the background worker", async () => {
  let captured = null;
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        captured = message;
        return { ok: true, downloadId: 41, bytes: 4096 };
      },
    },
  };
  assert.deepEqual(await requestSourceFrameDownload(
    "https://asw188q.cloudatacdn.com/media/video.mp4",
    "playmogo.mp4",
    17,
    3,
  ), { fallback: true, completed: true, bytes: 4096 });
  assert.deepEqual({ ...captured, requestId: "[request-id]" }, {
    type: "download-in-source-frame",
    requestId: "[request-id]",
    url: "https://asw188q.cloudatacdn.com/media/video.mp4",
    filename: "playmogo.mp4",
    tabId: 17,
    frameId: 3,
  });
  delete globalThis.chrome;
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
        if (message.type === "browser-download") {
          captured = message;
          return { ok: true, downloadId: 42, bytes: 2048 };
        }
        return { ok: true };
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
  assert.deepEqual(result, { fallback: true, completed: true, bytes: 2048 });
  assert.equal(captured.url, "https://cdn.example/video.mp4");
  assert.equal(captured.filename, "video.mp4");
  assert.equal(captured.type, "browser-download");
  assert.match(captured.requestId, /^[a-z0-9-]{8,}$/i);
  delete globalThis.fetch;
  delete globalThis.chrome;
});

test("browser download fallback reports a clear failure", async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "ensure-media-routes") return { ok: true };
        if (message.type === "prepare-media-fetch") return { ok: true, leaseId: "lease-2" };
        if (message.type === "browser-download") return { ok: false, error: "NETWORK_ERROR" };
        return { ok: true };
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

test("browser download fallback rejects a zero-byte probe before creating a file", async () => {
  let started = false;
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "ensure-media-routes") return { ok: true };
        if (message.type === "prepare-media-fetch") return { ok: true, leaseId: "lease-empty" };
        if (message.type === "release-media-fetch") return { ok: true };
        if (message.type === "browser-download") started = true;
        return { ok: true };
      },
    },
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 206,
    headers: new Headers({ "content-type": "video/mp4", "content-range": "bytes 0-0/0" }),
    body: { cancel: async () => {} },
  });
  await assert.rejects(
    tryBrowserDownloadFallback("https://cdn.example/empty.mp4", "empty.mp4", { maxDownloadBytes: null }),
    /빈 파일/,
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
        if (message.type === "browser-download") {
          started = true;
          return { ok: true, downloadId: 43, bytes: 2048 };
        }
        return { ok: true };
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
  assert.deepEqual(result, { fallback: true, completed: true, bytes: 2048 });
  assert.equal(started, true);
  delete globalThis.fetch;
  delete globalThis.chrome;
});
