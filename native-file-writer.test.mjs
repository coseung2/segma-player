import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { bytesToBase64, createNativeFileWriter, splitNativeChunks } from "./native-file-writer.js";

test("native file chunks stay below Chrome native-message limits and round-trip", () => {
  globalThis.btoa ||= (value) => Buffer.from(value, "binary").toString("base64");
  const bytes = Uint8Array.from({ length: 900_000 }, (_, index) => index % 251);
  const chunks = splitNativeChunks(bytes);
  assert.deepEqual(chunks.map((chunk) => chunk.byteLength), [393216, 393216, 113568]);
  const restored = Buffer.concat(chunks.map((chunk) => Buffer.from(bytesToBase64(chunk), "base64")));
  assert.deepEqual(restored, Buffer.from(bytes));
  assert.ok(chunks.every((chunk) => bytesToBase64(chunk).length < 1024 * 1024));
});

test("the retired native writer stays unreachable from the thin extension runtime", async () => {
  const [writer, background, companion, downloader, staging] = await Promise.all([
    readFile(new URL("./native-file-writer.js", import.meta.url), "utf8"),
    readFile(new URL("./background.js", import.meta.url), "utf8"),
    readFile(new URL("./companion-client.js", import.meta.url), "utf8"),
    readFile(new URL("./hls-download.js", import.meta.url), "utf8"),
    readFile(new URL("./scripts/build-dev-staging.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(writer, /native-file-writer/);
  assert.doesNotMatch(background, /connectNative|native-file-writer|getStoredSaveDirectory/);
  assert.match(companion, /com\.aura\.media_companion/);
  assert.doesNotMatch(staging, /"native-file-writer\.js"/);
  const hlsSave = downloader.match(/async function saveHlsToNative\([\s\S]*?\n\}/)?.[0] || "";
  assert.ok(hlsSave.indexOf("saveHlsWithCompanion") < hlsSave.indexOf("getStoredSaveDirectory"));
});

test("native writer keeps the extension job id and sends manager metadata", async () => {
  const messages = [];
  let messageListener = null;
  globalThis.chrome = {
    runtime: {
      connect: ({ name }) => {
        assert.equal(name, "native-file-writer");
        return {
          onMessage: { addListener(listener) { messageListener = listener; } },
          onDisconnect: { addListener() {} },
          postMessage(message) {
            messages.push(message);
            queueMicrotask(() => messageListener({ ...message, status: "ok", fileName: "clip.mp4" }));
          },
          disconnect() {},
        };
      },
    },
  };
  const writer = await createNativeFileWriter("clip.mp4", {
    jobId: "extension-job-42",
    title: "Playmogo clip",
    inputKind: "PROGRESSIVE",
    total: 1_234_567,
  });
  await writer.close();
  assert.deepEqual(messages[0], {
    type: "media-open",
    jobId: "extension-job-42",
    filename: "clip.mp4",
    title: "Playmogo clip",
    inputKind: "PROGRESSIVE",
    total: 1_234_567,
    showUi: true,
    resumeFileName: "",
    resumeFrom: undefined,
  });
  assert.equal(messages[1].jobId, "extension-job-42");
  delete globalThis.chrome;
});

test("native writer resumes a partial file and suspends it without deleting", async () => {
  globalThis.btoa ||= (value) => Buffer.from(value, "binary").toString("base64");
  const messages = [];
  let messageListener = null;
  globalThis.chrome = {
    runtime: {
      connect: () => ({
        onMessage: { addListener(listener) { messageListener = listener; } },
        onDisconnect: { addListener() {} },
        postMessage(message) {
          messages.push(message);
          const bytesWritten = message.type === "media-open" ? 4096
            : message.type === "media-chunk" ? 4096 + Buffer.from(message.data, "base64").byteLength
              : 5120;
          queueMicrotask(() => messageListener({
            ...message,
            status: message.type === "media-suspend" ? "suspended" : "ok",
            fileName: "clip.mp4",
            bytesWritten,
          }));
        },
        disconnect() {},
      }),
    },
  };
  const committed = [];
  const writer = await createNativeFileWriter("clip.mp4", {
    jobId: "resume-job",
    resumeFileName: "clip.mp4",
    resumeFrom: 4096,
    onCommitted: (bytes) => committed.push(bytes),
  });
  assert.equal(writer.committedBytes, 4096);
  await writer.write(new Uint8Array(1024));
  assert.equal(writer.committedBytes, 5120);
  assert.deepEqual(committed, [5120]);
  assert.equal(await writer.suspend(), 5120);
  assert.deepEqual(messages.map((message) => message.type), [
    "media-open",
    "media-chunk",
    "media-suspend",
  ]);
  delete globalThis.chrome;
});
