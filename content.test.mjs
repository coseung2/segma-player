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

  globalThis.Element = MockElement;
  globalThis.window = globalThis;
  globalThis.top = globalThis;
  globalThis.location = new URL("https://page.example/watch");
  globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });
  globalThis.document = {
    title: "Test video",
    documentElement: {},
    querySelectorAll(selector) {
      if (selector === "video, audio, source") return [video];
      if (selector === "iframe") return [];
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
});
