import test from "node:test";
import assert from "node:assert/strict";
import { ensureSaveDirectory } from "./save-directory.js";

let storedHandle = null;
globalThis.indexedDB = {
  open() {
    const request = {
      result: {
        objectStoreNames: { contains: () => true },
        transaction: () => ({
          objectStore: () => ({
            get: () => {
              const req = { result: storedHandle };
              queueMicrotask(() => req.onsuccess?.());
              return req;
            },
            put: (value) => {
              storedHandle = value;
              const req = {};
              queueMicrotask(() => req.onsuccess?.());
              return req;
            },
          }),
          oncomplete: null,
        }),
      },
    };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  },
};

function fakeHandle({ state = "granted", request = "granted", requestThrows = false } = {}) {
  let current = state;
  return {
    name: "test-folder",
    async queryPermission() {
      return current;
    },
    async requestPermission() {
      if (requestThrows) throw new Error("SecurityError: user activation required");
      current = request;
      return request;
    },
  };
}

test("ensureSaveDirectory returns a handle whose permission is granted", async () => {
  storedHandle = fakeHandle({ state: "granted" });
  assert.equal(await ensureSaveDirectory(), storedHandle);
});

test("ensureSaveDirectory re-requests permission when state is prompt", async () => {
  storedHandle = fakeHandle({ state: "prompt", request: "granted" });
  assert.equal(await ensureSaveDirectory(), storedHandle);
});

test("ensureSaveDirectory never returns a handle when permission cannot be confirmed", async () => {
  storedHandle = fakeHandle({ state: "prompt", requestThrows: true });
  assert.equal(await ensureSaveDirectory(), null);

  storedHandle = fakeHandle({ state: "prompt", request: "denied" });
  assert.equal(await ensureSaveDirectory(), null);

  storedHandle = fakeHandle({ state: "denied" });
  assert.equal(await ensureSaveDirectory(), null);
});

test("ensureSaveDirectory returns null when no folder handle is stored", async () => {
  storedHandle = null;
  assert.equal(await ensureSaveDirectory(), null);
});
