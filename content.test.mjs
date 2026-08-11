import test from "node:test";
import assert from "node:assert/strict";

test("scans a visible playing media element without a runtime error", async () => {
  const sent = [];
  class MockElement {}
  const video = new MockElement();
  Object.assign(video, {
    currentSrc: "https://media.example/stream-token",
    src: "",
    tagName: "VIDEO",
    type: "video/mp4",
    paused: false,
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
  });
  const preview = new MockElement();
  Object.assign(preview, {
    currentSrc: "https://cdn.example/cast/preview.gif",
    src: "",
    tagName: "VIDEO",
    type: "video/mp4",
    paused: false,
    getBoundingClientRect: () => ({ width: 900, height: 500 }),
  });
  const embedded = {
    textContent: "const flashvars = { video_url: 'aHR0cHM6Ly9hc2lhbnBvcm4ubGkvZ2V0X2ZpbGUvMTEvYWJjLzI3NDg2OS5tcDQvP2JyPTE3NjQ=' };",
  };

  globalThis.Element = MockElement;
  globalThis.window = globalThis;
  globalThis.top = globalThis;
  globalThis.location = new URL("https://page.example/watch");
  globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });
  globalThis.document = {
    title: "Test video",
    documentElement: {},
    querySelectorAll(selector) {
      if (selector === "video, audio, source") return [video, preview];
      if (selector === "iframe") return [];
      if (selector === "script") return [embedded];
      return [];
    },
    addEventListener() {},
  };
  globalThis.MutationObserver = class {
    observe() {}
  };
  globalThis.chrome = {
    runtime: {
      sendMessage(message) {
        sent.push(message);
        return Promise.resolve();
      },
      onMessage: { addListener() {} },
    },
  };

  await import(`./content.js?test=${Date.now()}`);
  await new Promise((resolve) => setImmediate(resolve));

  const media = sent.find((message) => message.type === "resource"
    && message.resourceUrl === "https://media.example/stream-token");
  assert.equal(media?.main, true);
  assert.equal(media?.fromMediaElement, true);
  assert.equal(sent.some((message) => message.resourceUrl?.endsWith("preview.gif")), false);
  const configured = sent.find((message) => message.resourceUrl
    === "https://asianporn.li/get_file/11/abc/274869.mp4/?br=1764");
  assert.equal(configured?.main, true);
  assert.equal(configured?.fromMediaElement, true);
});
