import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { bytesToBase64, splitNativeChunks } from "./native-file-writer.js";

test("native file chunks stay below Chrome native-message limits and round-trip", () => {
  globalThis.btoa ||= (value) => Buffer.from(value, "binary").toString("base64");
  const bytes = Uint8Array.from({ length: 900_000 }, (_, index) => index % 251);
  const chunks = splitNativeChunks(bytes);
  assert.deepEqual(chunks.map((chunk) => chunk.byteLength), [393216, 393216, 113568]);
  const restored = Buffer.concat(chunks.map((chunk) => Buffer.from(bytesToBase64(chunk), "base64")));
  assert.deepEqual(restored, Buffer.from(bytes));
  assert.ok(chunks.every((chunk) => bytesToBase64(chunk).length < 1024 * 1024));
});

test("the extension save path no longer depends on the native companion", async () => {
  const [writer, background] = await Promise.all([
    readFile(new URL("./native-file-writer.js", import.meta.url), "utf8"),
    readFile(new URL("./background.js", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(writer, /connectNative/);
  assert.doesNotMatch(background, /connectNative/);
  assert.doesNotMatch(background, /com\.aura\.media_companion/);
  assert.doesNotMatch(background, /native-file-writer/);
  assert.match(background, /getStoredSaveDirectory/);
});
