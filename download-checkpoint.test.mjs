import test from "node:test";
import assert from "node:assert/strict";
import {
  clearAllDownloadCheckpoints,
  clearDownloadCheckpoint,
  getDownloadCheckpoint,
  setDownloadCheckpoint,
} from "./download-checkpoint.js";

const storage = new Map();

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (typeof keys === "string") {
          const value = storage.get(keys);
          return value === undefined ? {} : { [keys]: value };
        }
        return {};
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) storage.set(key, value);
      },
      async remove(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const key of list) storage.delete(key);
      },
    },
  },
};

test.beforeEach(() => storage.clear());

test("getDownloadCheckpoint returns null when nothing is stored", async () => {
  assert.equal(await getDownloadCheckpoint("media:abc"), null);
  assert.equal(await getDownloadCheckpoint(""), null);
  assert.equal(await getDownloadCheckpoint(null), null);
});

test("setDownloadCheckpoint then getDownloadCheckpoint round-trips", async () => {
  const checkpoint = {
    filename: "video.mp4",
    bytesWritten: 123456,
    resumeFromSegment: 42,
  };
  assert.equal(await setDownloadCheckpoint("media:abc", "main", checkpoint), true);
  const loaded = await getDownloadCheckpoint("media:abc", "main");
  assert.equal(loaded.filename, "video.mp4");
  assert.equal(loaded.bytesWritten, 123456);
  assert.equal(loaded.resumeFromSegment, 42);
  assert.equal(Number.isFinite(loaded.updatedAt), true);
});

test("scopes stay independent within one checkpoint key", async () => {
  await setDownloadCheckpoint("media:abc", "main", {
    filename: "video.mp4",
    bytesWritten: 100,
    resumeFromSegment: 10,
  });
  await setDownloadCheckpoint("media:abc", "track-0", {
    filename: "video_audio.m4a",
    bytesWritten: 200,
    resumeFromSegment: 20,
  });
  assert.equal((await getDownloadCheckpoint("media:abc", "main")).bytesWritten, 100);
  assert.equal((await getDownloadCheckpoint("media:abc", "track-0")).bytesWritten, 200);
  assert.equal(await getDownloadCheckpoint("media:abc", "track-1"), null);
});

test("clearDownloadCheckpoint removes one scope and keeps the rest", async () => {
  await setDownloadCheckpoint("media:abc", "main", {
    filename: "video.mp4",
    bytesWritten: 100,
    resumeFromSegment: 10,
  });
  await setDownloadCheckpoint("media:abc", "track-0", {
    filename: "video_audio.m4a",
    bytesWritten: 200,
    resumeFromSegment: 20,
  });
  assert.equal(await clearDownloadCheckpoint("media:abc", "main"), true);
  assert.equal(await getDownloadCheckpoint("media:abc", "main"), null);
  assert.equal((await getDownloadCheckpoint("media:abc", "track-0")).filename, "video_audio.m4a");
});

test("clearDownloadCheckpoint removes the storage key when the last scope is gone", async () => {
  await setDownloadCheckpoint("media:abc", "main", {
    filename: "video.mp4",
    bytesWritten: 100,
    resumeFromSegment: 10,
  });
  assert.equal(await clearDownloadCheckpoint("media:abc", "main"), true);
  assert.equal(storage.size, 0);
});

test("clearAllDownloadCheckpoints removes every scope for a key", async () => {
  await setDownloadCheckpoint("media:abc", "main", {
    filename: "video.mp4",
    bytesWritten: 100,
    resumeFromSegment: 10,
  });
  await setDownloadCheckpoint("media:abc", "track-0", {
    filename: "video_audio.m4a",
    bytesWritten: 200,
    resumeFromSegment: 20,
  });
  assert.equal(await clearAllDownloadCheckpoints("media:abc"), true);
  assert.equal(await getDownloadCheckpoint("media:abc", "main"), null);
  assert.equal(await getDownloadCheckpoint("media:abc", "track-0"), null);
  assert.equal(storage.size, 0);
});

test("setDownloadCheckpoint rejects checkpoints without a filename", async () => {
  assert.equal(await setDownloadCheckpoint("media:abc", "main", { bytesWritten: 10 }), false);
  assert.equal(await getDownloadCheckpoint("media:abc", "main"), null);
});
