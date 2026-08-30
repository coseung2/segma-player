import test from "node:test";
import assert from "node:assert/strict";

import { createContextualHlsLoader } from "./contextual-hls-loader.js";

class FakeLoader {
  constructor() {
    this.stats = { loaded: 0 };
    this.context = null;
    this.aborted = false;
    this.destroyed = false;
  }

  load(context, _config, callbacks) {
    this.context = context;
    this.callbacks = callbacks;
  }

  abort() {
    this.aborted = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("contextual HLS loader acquires an exact request lease before delegating", async () => {
  const order = [];
  const released = [];
  const Loader = createContextualHlsLoader(FakeLoader, {
    acquire: async (url) => {
      order.push(`acquire:${url}`);
      return "lease-1";
    },
    release: async (lease) => {
      released.push(lease);
      order.push(`release:${lease}`);
    },
  });
  const loader = new Loader({});
  let succeeded = false;
  loader.load({ url: "https://cdn.example/segment.ts?token=one" }, {}, {
    onSuccess: () => { succeeded = true; order.push("success"); },
  });
  await flush();

  assert.deepEqual(order, ["acquire:https://cdn.example/segment.ts?token=one"]);
  assert.equal(loader.inner.context.url, "https://cdn.example/segment.ts?token=one");
  loader.inner.callbacks.onSuccess({ data: new Uint8Array() }, loader.stats, loader.context, null);
  await flush();
  assert.equal(succeeded, true);
  assert.deepEqual(released, ["lease-1"]);
  assert.deepEqual(order, [
    "acquire:https://cdn.example/segment.ts?token=one",
    "release:lease-1",
    "success",
  ]);
});

test("lease acquisition failures surface through the HLS error callback", async () => {
  const Loader = createContextualHlsLoader(FakeLoader, {
    acquire: async () => { throw new Error("context-denied"); },
    release: async () => {},
  });
  const loader = new Loader({});
  let observed = null;
  loader.load({ url: "https://cdn.example/master.m3u8" }, {}, {
    onError: (error, context) => { observed = { error, context }; },
  });
  await flush();
  assert.equal(observed.error.text, "context-denied");
  assert.equal(observed.context.url, "https://cdn.example/master.m3u8");
  assert.equal(loader.inner.context, null);
});

test("abort before acquisition completes releases the lease without starting a request", async () => {
  let resolveAcquire;
  const released = [];
  const Loader = createContextualHlsLoader(FakeLoader, {
    acquire: () => new Promise((resolve) => { resolveAcquire = resolve; }),
    release: async (lease) => { released.push(lease); },
  });
  const loader = new Loader({});
  loader.load({ url: "https://cdn.example/master.m3u8" }, {}, {});
  await flush();
  loader.abort();
  resolveAcquire("lease-delayed");
  await flush();
  assert.equal(loader.inner.context, null);
  assert.deepEqual(released, ["lease-delayed"]);
});

test("a wrapped loader exception releases the already-created lease", async () => {
  class ThrowingLoader extends FakeLoader {
    load() {
      throw new Error("loader-crashed");
    }
  }
  const released = [];
  const Loader = createContextualHlsLoader(ThrowingLoader, {
    acquire: async () => "lease-throw",
    release: async (lease) => { released.push(lease); },
  });
  const loader = new Loader({});
  let observed = null;
  loader.load({ url: "https://cdn.example/master.m3u8" }, {}, {
    onError: (error) => { observed = error; },
  });
  await flush();
  assert.equal(observed.text, "loader-crashed");
  assert.deepEqual(released, ["lease-throw"]);
});

test("destroy tears down the wrapped loader and releases active state", async () => {
  const Loader = createContextualHlsLoader(FakeLoader, {
    acquire: async () => "lease-2",
    release: async () => {},
  });
  const loader = new Loader({});
  const inner = loader.inner;
  loader.load({ url: "https://cdn.example/master.m3u8" }, {}, {});
  await flush();
  loader.destroy();
  assert.equal(inner.aborted, true);
  assert.equal(inner.destroyed, true);
  assert.equal(loader.inner, null);
});
