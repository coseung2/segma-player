import test from "node:test";
import assert from "node:assert/strict";
import { createUniqueFile, ensureSaveDirectory, hasReadWritePermission } from "./save-directory.js";

let storedHandle = null;
globalThis.indexedDB = {
  open() {
    const request = {
      result: {
        objectStoreNames: { contains: () => true },
        transaction: () => {
          const tx = {
            oncomplete: null,
            onerror: null,
          };
          tx.objectStore = () => ({
            get: () => {
              const req = { result: storedHandle };
              queueMicrotask(() => req.onsuccess?.());
              return req;
            },
            put: (value) => {
              storedHandle = value;
              const req = {};
              queueMicrotask(() => {
                req.onsuccess?.();
                tx.oncomplete?.();
              });
              return req;
            },
          });
          return tx;
        },
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

test("hasReadWritePermission reports only granted readwrite permission", async () => {
  assert.equal(await hasReadWritePermission(fakeHandle({ state: "granted" })), true);
  assert.equal(await hasReadWritePermission(fakeHandle({ state: "prompt" })), false);
  assert.equal(await hasReadWritePermission(fakeHandle({ state: "denied" })), false);
  assert.equal(await hasReadWritePermission(null), false);
  assert.equal(await hasReadWritePermission({ name: "no-permission-api" }), false);
});

test("ensureSaveDirectory with pick replaces the stored folder", async () => {
  storedHandle = fakeHandle({ state: "granted" });
  const newHandle = fakeHandle({ state: "granted" });
  newHandle.name = "new-folder";
  globalThis.showDirectoryPicker = async () => newHandle;
  assert.equal(await ensureSaveDirectory({ pick: true }), newHandle);
  assert.equal(storedHandle, newHandle);
  delete globalThis.showDirectoryPicker;
});

test("ensureSaveDirectory with pick returns null when the picker is cancelled", async () => {
  storedHandle = fakeHandle({ state: "granted" });
  globalThis.showDirectoryPicker = async () => {
    const error = new Error("cancelled");
    error.name = "AbortError";
    throw error;
  };
  assert.equal(await ensureSaveDirectory({ pick: true }), null);
  assert.equal(storedHandle?.name, "test-folder");
  delete globalThis.showDirectoryPicker;
});

function fakeDirectory(existing = []) {
  const files = new Map(existing.map((name) => [name, { name }]));
  return {
    files,
    async getFileHandle(name, options = {}) {
      if (files.has(name)) return files.get(name);
      if (!options.create) {
        const error = new Error("not found");
        error.name = "NotFoundError";
        throw error;
      }
      const handle = { name };
      files.set(name, handle);
      return handle;
    },
  };
}

test("createUniqueFile preserves existing downloads by numbering the new file", async () => {
  const directory = fakeDirectory(["영상 제목.mp4", "영상 제목 (1).mp4"]);
  const created = await createUniqueFile(directory, "영상 제목.mp4");
  assert.equal(created.filename, "영상 제목 (2).mp4");
  assert.equal(created.fileHandle.name, "영상 제목 (2).mp4");
  assert.equal(directory.files.has("영상 제목.mp4"), true);
  assert.equal(directory.files.has("영상 제목 (1).mp4"), true);
});

test("concurrent unique allocations cannot claim the same filename", async () => {
  const directory = fakeDirectory();
  const [first, second] = await Promise.all([
    createUniqueFile(directory, "같은 제목.mp4"),
    createUniqueFile(directory, "같은 제목.mp4"),
  ]);
  assert.deepEqual([first.filename, second.filename], ["같은 제목.mp4", "같은 제목 (1).mp4"]);
});
