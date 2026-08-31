import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  MEDIA_COMPANION_NATIVE_HOST,
  MEDIA_COMPANION_PROTOCOL,
  MEDIA_DOWNLOAD_CAPABILITY,
  MEDIA_DOWNLOAD_PROTOCOL,
  SUBTITLE_COMMAND_PROTOCOL,
  companionRequest,
  companionStatus,
  disconnectCompanion,
  mediaDownloadBrowserContext,
  onCompanionEvent,
  setCompanionDownloadFolder,
  startCompanionMediaDownload,
  startCompanionSubtitleJob,
} from "./companion-client.js";

const helloContract = JSON.parse(await readFile(
  new URL("./test-fixtures/companion/hello-v2.json", import.meta.url),
  "utf8",
));
const mediaDownloadContract = JSON.parse(await readFile(
  new URL("./test-fixtures/companion/media-download-v1.json", import.meta.url),
  "utf8",
));
const statusContract = JSON.parse(await readFile(
  new URL("./test-fixtures/companion/status-v2.json", import.meta.url),
  "utf8",
));
const mediaDownloadRejectionContracts = JSON.parse(await readFile(
  new URL("./test-fixtures/companion/media-download-v1-rejections.json", import.meta.url),
  "utf8",
));
const downloadFolderContract = JSON.parse(await readFile(
  new URL("./test-fixtures/companion/download-folder-v1.json", import.meta.url),
  "utf8",
));

class FakeEvent {
  constructor() {
    this.listeners = new Set();
  }

  addListener(listener) {
    this.listeners.add(listener);
  }

  emit(value) {
    for (const listener of [...this.listeners]) listener(value);
  }
}

class FakePort {
  constructor(onPost) {
    this.onMessage = new FakeEvent();
    this.onDisconnect = new FakeEvent();
    this.messages = [];
    this.disconnected = false;
    this.onPost = onPost;
  }

  postMessage(message) {
    const copy = structuredClone(message);
    this.messages.push(copy);
    this.onPost?.(this, copy);
  }

  respond(message) {
    queueMicrotask(() => this.onMessage.emit(structuredClone(message)));
  }

  disconnect() {
    if (this.disconnected) return;
    this.disconnected = true;
    this.onDisconnect.emit();
  }
}

function installFakeChrome(onPost = null, { capabilities = [], helloDelayMs = 0 } = {}) {
  const ports = [];
  let connectCount = 0;
  globalThis.chrome = {
    runtime: {
      lastError: null,
      connectNative(host) {
        connectCount += 1;
        assert.equal(host, MEDIA_COMPANION_NATIVE_HOST);
        const port = new FakePort((current, message) => {
          if (message.type === "hello") {
            const response = {
              ok: true,
              requestId: message.requestId,
              protocol: MEDIA_COMPANION_PROTOCOL,
              capabilities,
            };
            if (helloDelayMs > 0) {
              setTimeout(() => current.onMessage.emit(structuredClone(response)), helloDelayMs);
            } else {
              current.respond(response);
            }
            return;
          }
          onPost?.(current, message);
        });
        ports.push(port);
        return port;
      },
    },
  };
  return {
    ports,
    get connectCount() { return connectCount; },
  };
}

function sampleMediaDownloadInput() {
  const {
    type: _type,
    protocolVersion: _protocolVersion,
    requestId: _requestId,
    ...input
  } = mediaDownloadContract;
  return {
    ...input,
    url: `${input.url}#fragment`,
    referrer: `${input.referrer}#player`,
  };
}

function sampleInput() {
  return {
    candidateId: "candidate-123",
    sourceLanguage: "ja",
    media: {
      type: "hls",
      title: "Sample video",
      pageUrl: "https://page.example/video",
      resourceUrl: "https://media.example/master.m3u8",
      audioRenditionUrl: "https://media.example/audio.m3u8",
    },
    sourceContext: {
      tabId: 123,
      frameId: 7,
      contextLeaseId: "lease-123",
    },
  };
}

function assertCompanionCode(expected) {
  return (error) => {
    assert.equal(error?.code, expected);
    return true;
  };
}

afterEach(() => {
  disconnectCompanion();
  delete globalThis.chrome;
});

test("media-download v1 sends only the allowlisted canonical handoff payload", async () => {
  const fake = installFakeChrome((port, message) => {
    port.respond({ ok: true, requestId: message.requestId, accepted: true, jobId: "job-123" });
  }, { capabilities: [MEDIA_DOWNLOAD_CAPABILITY] });

  const response = await startCompanionMediaDownload(sampleMediaDownloadInput());
  assert.equal(response.accepted, true);
  const [hello, download] = fake.ports[0].messages;
  assert.deepEqual(hello.capabilities, undefined);
  assert.deepEqual(
    { ...download, requestId: mediaDownloadContract.requestId },
    mediaDownloadContract,
  );
  assert.deepEqual(
    Object.keys(download).sort(),
    ["acceptLanguage", "candidateId", "inputKind", "jobId", "protocolVersion", "referrer", "requestId", "title", "type", "url", "userAgent"].sort(),
  );
  assert.equal(JSON.stringify(download).match(/cookie|authorization|header|license|bytes|path/gi), null);
});

test("concurrent media downloads await one delayed hello handshake", async () => {
  const accepted = [];
  const fake = installFakeChrome((port, message) => {
    accepted.push(message.jobId);
    port.respond({
      ok: true,
      requestId: message.requestId,
      accepted: true,
      jobId: message.jobId,
    });
  }, {
    capabilities: [MEDIA_DOWNLOAD_CAPABILITY],
    helloDelayMs: 25,
  });

  const [first, second] = await Promise.all([
    startCompanionMediaDownload(sampleMediaDownloadInput()),
    startCompanionMediaDownload({
      ...sampleMediaDownloadInput(),
      jobId: "job-456",
      candidateId: "candidate-456",
    }),
  ]);

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(fake.connectCount, 1);
  assert.deepEqual(fake.ports[0].messages.map((message) => message.type), [
    "hello",
    "media-download",
    "media-download",
  ]);
  assert.deepEqual(accepted.sort(), ["job-123", "job-456"]);
});

test("hello constants match the shared native-host contract fixture", () => {
  assert.equal(MEDIA_COMPANION_PROTOCOL, helloContract.protocol);
  assert.ok(helloContract.capabilities.includes(MEDIA_DOWNLOAD_CAPABILITY));
  assert.equal(MEDIA_DOWNLOAD_PROTOCOL, mediaDownloadContract.protocolVersion);
});

test("status v2 consumes the correlated shared response envelope", async () => {
  const fake = installFakeChrome((port, message) => {
    assert.equal(message.type, "status");
    port.respond({ ...statusContract, requestId: message.requestId });
  }, { capabilities: helloContract.capabilities });

  const response = await companionStatus();
  const [, statusRequest] = fake.ports[0].messages;
  assert.match(statusRequest.requestId, /^[a-z0-9]+-[a-z0-9]+$/);
  assert.deepEqual(
    { ...response, requestId: statusContract.requestId },
    statusContract,
  );
});

test("media-download derives bounded non-secret browser request metadata", () => {
  assert.deepEqual(mediaDownloadBrowserContext({
    userAgent: "Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36",
    languages: ["ko", "en-US", "en", "ko", "invalid_language"],
  }), {
    userAgent: "Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36",
    acceptLanguage: "ko,en-US;q=0.9,en;q=0.8",
  });
  assert.deepEqual(mediaDownloadBrowserContext({
    userAgent: `bad\r\nInjected: yes`,
    languages: ["bad_language"],
  }), {});
});

test("media-download rejects secrets, bytes, paths, and arbitrary fields before connecting", () => {
  const fake = installFakeChrome(null, { capabilities: [MEDIA_DOWNLOAD_CAPABILITY] });
  const forbidden = [
    { headers: { Referer: "https://page.example" } },
    { cookies: "session=secret" },
    { authorization: "Bearer secret" },
    { mediaBytes: new Uint8Array([1, 2, 3]) },
    { licenseData: "secret" },
    { path: "C:\\Downloads\\video.mp4" },
    { downloadFolder: "C:\\Downloads" },
  ];
  for (const extra of forbidden) {
    assert.throws(
      () => startCompanionMediaDownload({ ...sampleMediaDownloadInput(), ...extra }),
      assertCompanionCode("sensitive-media-download-field-rejected"),
    );
  }
  assert.throws(
    () => startCompanionMediaDownload({ ...sampleMediaDownloadInput(), metadata: { safe: true } }),
    assertCompanionCode("invalid-media-download-command"),
  );
  assert.equal(fake.connectCount, 0);
});

test("media-download rejects non-public URLs and unsupported input kinds before connecting", () => {
  const fake = installFakeChrome(null, { capabilities: [MEDIA_DOWNLOAD_CAPABILITY] });
  for (const input of [
    { ...sampleMediaDownloadInput(), url: "http://127.0.0.1/video.mp4" },
    { ...sampleMediaDownloadInput(), referrer: "http://192.168.1.2/watch" },
    { ...sampleMediaDownloadInput(), url: "https://user:pass@media.example/video.mp4" },
    { ...sampleMediaDownloadInput(), inputKind: "BLOB" },
    { ...sampleMediaDownloadInput(), title: "x".repeat(513) },
    { ...sampleMediaDownloadInput(), userAgent: `bad\r\nInjected: yes` },
    { ...sampleMediaDownloadInput(), userAgent: "x".repeat(513) },
    { ...sampleMediaDownloadInput(), acceptLanguage: "ko\r\nInjected: yes" },
    { ...sampleMediaDownloadInput(), acceptLanguage: "ko,*;q=0.9" },
  ]) {
    assert.throws(
      () => startCompanionMediaDownload(input),
      assertCompanionCode("invalid-media-download-command"),
    );
  }
  assert.equal(fake.connectCount, 0);
});

test("media-download requires the advertised v1 capability and never posts a fallback command", async () => {
  const fake = installFakeChrome(() => assert.fail("media command must not be posted without capability"));
  await assert.rejects(
    startCompanionMediaDownload(sampleMediaDownloadInput()),
    assertCompanionCode("media-companion-update-required"),
  );
  assert.deepEqual(fake.ports[0].messages.map((message) => message.type), ["hello"]);
});

test("media-download requires an accepted reply for the same job", async () => {
  installFakeChrome((port, message) => {
    port.respond({ ok: true, requestId: message.requestId, accepted: true, jobId: "different-job" });
  }, { capabilities: [MEDIA_DOWNLOAD_CAPABILITY] });
  await assert.rejects(
    startCompanionMediaDownload(sampleMediaDownloadInput()),
    assertCompanionCode("media-companion-start-rejected"),
  );
});

test("media-download v1 preserves correlated native rejection codes", async () => {
  let activeContract = null;
  const uncorrelated = [];
  const removeListener = onCompanionEvent((message) => uncorrelated.push(message));
  installFakeChrome((port, message) => {
    assert.ok(activeContract, "a rejection contract is selected");
    port.respond(activeContract.response);
    port.respond({ ...activeContract.response, requestId: message.requestId });
  }, { capabilities: [MEDIA_DOWNLOAD_CAPABILITY] });

  try {
    for (const contract of mediaDownloadRejectionContracts) {
      activeContract = contract;
      await assert.rejects(
        startCompanionMediaDownload(sampleMediaDownloadInput()),
        (error) => {
          assert.equal(error.code, contract.response.errorCode, contract.name);
          assert.equal(error.message, contract.response.error, contract.name);
          return true;
        },
      );
    }
  } finally {
    removeListener();
  }
  assert.deepEqual(uncorrelated, mediaDownloadRejectionContracts.map(({ response }) => response));
});

test("download-folder command preserves input and native validation envelopes", async () => {
  const cases = [...downloadFolderContract.accepted, ...downloadFolderContract.rejected];
  let activeCase = null;
  installFakeChrome((port, message) => {
    assert.equal(message.type, "set-download-folder");
    assert.equal(message.folder, activeCase.folder);
    port.respond({ ...activeCase.response, requestId: message.requestId });
  });

  for (const contract of downloadFolderContract.accepted) {
    activeCase = contract;
    const response = await setCompanionDownloadFolder(contract.folder);
    assert.deepEqual(
      { ...response, requestId: contract.response.requestId },
      contract.response,
    );
  }
  for (const contract of downloadFolderContract.rejected) {
    activeCase = contract;
    await assert.rejects(
      setCompanionDownloadFolder(contract.folder),
      (error) => {
        assert.equal(error.code, contract.response.errorCode);
        assert.equal(error.message, contract.response.error);
        return true;
      },
    );
  }
  assert.equal(cases.length, 4);
});

test("subtitle bridge performs hello then sends the exact allowlisted command", async () => {
  const fake = installFakeChrome((port, message) => {
    port.respond({ ok: true, requestId: message.requestId, accepted: true, jobId: "subtitle-1" });
  });

  const response = await startCompanionSubtitleJob(sampleInput());
  assert.equal(response.jobId, "subtitle-1");
  assert.equal(fake.connectCount, 1);
  assert.equal(fake.ports.length, 1);

  const [hello, subtitle] = fake.ports[0].messages;
  assert.deepEqual(hello, {
    type: "hello",
    requestId: hello.requestId,
    protocol: MEDIA_COMPANION_PROTOCOL,
  });
  assert.match(hello.requestId, /^[a-z0-9]+-[a-z0-9]+$/);
  assert.notEqual(subtitle.requestId, hello.requestId);
  assert.match(subtitle.requestId, /^[a-z0-9]+-[a-z0-9]+$/);
  assert.deepEqual(subtitle, {
    protocolVersion: SUBTITLE_COMMAND_PROTOCOL,
    candidateId: "candidate-123",
    sourceLanguage: "ja",
    targetLanguage: "ko",
    mode: "generate",
    media: {
      type: "hls",
      title: "Sample video",
      pageUrl: "https://page.example/video",
      resourceUrl: "https://media.example/master.m3u8",
      audioRenditionUrl: "https://media.example/audio.m3u8",
    },
    sourceContext: {
      tabId: 123,
      frameId: 7,
      contextLeaseId: "lease-123",
    },
    type: "subtitle.create",
    requestId: subtitle.requestId,
  });
});

test("postRequest remains the sole requestId owner", async () => {
  let posted;
  installFakeChrome((port, message) => {
    posted = message;
    port.respond({ ok: true, requestId: message.requestId });
  });

  await companionRequest("status", { requestId: "caller-selected" }, { timeoutMs: 100 });
  assert.notEqual(posted.requestId, "caller-selected");
  assert.match(posted.requestId, /^[a-z0-9]+-[a-z0-9]+$/);
});

test("incomplete source context is omitted", async () => {
  let posted;
  installFakeChrome((port, message) => {
    posted = message;
    port.respond({ ok: true, requestId: message.requestId });
  });
  const input = sampleInput();
  input.sourceContext = { tabId: 123, frameId: 7 };

  await startCompanionSubtitleJob(input);
  assert.equal(Object.hasOwn(posted, "sourceContext"), false);
});

test("invalid subtitle inputs reject before native connection", () => {
  const fake = installFakeChrome();
  const cases = [
    [{ ...sampleInput(), candidateId: "../candidate" }, "invalid-subtitle-request-id"],
    [{ ...sampleInput(), candidateId: "x".repeat(129) }, "invalid-subtitle-request-id"],
    [{ ...sampleInput(), sourceLanguage: "fr" }, "unsupported-subtitle-language"],
    [{ ...sampleInput(), media: { ...sampleInput().media, resourceUrl: "ftp://media.example/video" } }, "invalid-subtitle-media"],
    [{ ...sampleInput(), media: { ...sampleInput().media, resourceUrl: "https://media.example/bad path" } }, "invalid-subtitle-media"],
    [{ ...sampleInput(), media: { ...sampleInput().media, resourceUrl: "http://127.0.0.1/private" } }, "invalid-subtitle-media"],
    [{ ...sampleInput(), media: { ...sampleInput().media, resourceUrl: "https://user:pass@media.example/video" } }, "invalid-subtitle-media"],
    [{ ...sampleInput(), media: { ...sampleInput().media, resourceUrl: "https://media.example/video#secret" } }, "invalid-subtitle-media"],
    [{ ...sampleInput(), media: { ...sampleInput().media, title: "한".repeat(171) } }, "invalid-subtitle-media"],
    [{ ...sampleInput(), sourceContext: { tabId: -1, frameId: 0, contextLeaseId: "lease-1" } }, "invalid-subtitle-context"],
    [{ ...sampleInput(), media: { ...sampleInput().media, unexpected: true } }, "invalid-subtitle-command"],
    [{ ...sampleInput(), requestId: "caller-selected" }, "invalid-subtitle-command"],
  ];

  for (const [input, code] of cases) {
    assert.throws(() => startCompanionSubtitleJob(input), assertCompanionCode(code));
  }
  assert.equal(fake.connectCount, 0);
});

test("secret, header-like, and media-byte fields reject before native connection", () => {
  const fake = installFakeChrome();
  const cases = [
    { ...sampleInput(), licenseKey: "secret" },
    { ...sampleInput(), cookies: "session=secret" },
    { ...sampleInput(), Authorization: "Bearer secret" },
    { ...sampleInput(), headers: { Referer: "https://page.example" } },
    { ...sampleInput(), mediaBytes: new Uint8Array([1, 2, 3]) },
    { ...sampleInput(), media: { ...sampleInput().media, requestHeaders: { Referer: "https://page.example" } } },
  ];

  for (const input of cases) {
    assert.throws(() => startCompanionSubtitleJob(input), assertCompanionCode("sensitive-header-rejected"));
  }
  assert.equal(fake.connectCount, 0);
});

test("native subtitle errors preserve the companion error code and message", async () => {
  installFakeChrome((port, message) => {
    port.respond({
      ok: false,
      requestId: message.requestId,
      errorCode: "subtitle-job-persist-failed",
      error: "job state could not be persisted",
    });
  });

  await assert.rejects(
    startCompanionSubtitleJob(sampleInput()),
    (error) => {
      assert.equal(error.code, "subtitle-job-persist-failed");
      assert.equal(error.message, "job state could not be persisted");
      return true;
    },
  );
});

test("timed out requests are removed so late replies become events", async () => {
  const fake = installFakeChrome();
  const events = [];
  const removeListener = onCompanionEvent((message) => events.push(message));

  await assert.rejects(
    companionRequest("no-response", {}, { timeoutMs: 15 }),
    assertCompanionCode("media-companion-timeout"),
  );
  const lateRequest = fake.ports[0].messages[1];
  fake.ports[0].onMessage.emit({ ok: true, requestId: lateRequest.requestId, late: true });
  removeListener();

  assert.deepEqual(events, [{ ok: true, requestId: lateRequest.requestId, late: true }]);
});
