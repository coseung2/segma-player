import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  MEDIA_COMPANION_NATIVE_HOST,
  MEDIA_COMPANION_PROTOCOL,
  SUBTITLE_COMMAND_PROTOCOL,
  companionRequest,
  disconnectCompanion,
  onCompanionEvent,
  startCompanionSubtitleJob,
} from "./companion-client.js";

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

function installFakeChrome(onPost = null) {
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
            current.respond({ ok: true, requestId: message.requestId, protocol: MEDIA_COMPANION_PROTOCOL });
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
