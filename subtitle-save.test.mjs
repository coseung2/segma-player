import test from "node:test";
import assert from "node:assert/strict";

import { saveGeneratedSubtitleSrt } from "./subtitle-save.js";

const VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n테스트 자막\n";

test("generated subtitles use Companion before a configured browser folder", async () => {
  const writes = [];
  let folderLookups = 0;
  let closed = 0;
  const result = await saveGeneratedSubtitleSrt(
    { title: "테스트 영상", mediaUrl: "https://media.example/video.mp4" },
    VTT,
    {
      createWriter: async (filename) => ({
        name: filename,
        async write(bytes) { writes.push(new Uint8Array(bytes)); },
        async close() { closed += 1; return { fileName: filename }; },
        async abort() {},
      }),
      getDirectory: async () => { folderLookups += 1; return null; },
    },
  );
  assert.equal(result.destination, "companion");
  assert.equal(result.folderName, "Downloads\\Aura Media");
  assert.equal(result.filename, "테스트 영상.srt");
  assert.equal(folderLookups, 0);
  assert.equal(closed, 1);
  assert.match(new TextDecoder().decode(writes[0]), /테스트 자막/);
});

test("generated subtitles fall back to the authorized subtitle folder", async () => {
  let aborted = 0;
  let folderText = "";
  const result = await saveGeneratedSubtitleSrt(
    { title: "Fallback", mediaUrl: "https://media.example/video.mp4" },
    VTT,
    {
      createWriter: async () => ({
        async write() { throw new Error("native write failed"); },
        async close() {},
        async abort() { aborted += 1; },
      }),
      getDirectory: async () => ({ name: "My Subtitles" }),
      hasPermission: async () => true,
      createFile: async (_directory, filename) => ({
        filename,
        fileHandle: {
          async createWritable() {
            return {
              async write(value) { folderText = String(value); },
              async close() {},
            };
          },
        },
      }),
    },
  );
  assert.equal(aborted, 1);
  assert.equal(result.destination, "folder");
  assert.equal(result.folderName, "My Subtitles");
  assert.match(folderText, /테스트 자막/);
});

test("generated subtitles report a destination error only when Companion and folder both fail", async () => {
  await assert.rejects(
    saveGeneratedSubtitleSrt(
      { title: "No destination", mediaUrl: "https://media.example/video.mp4" },
      VTT,
      {
        createWriter: async () => { throw new Error("Companion unavailable"); },
        getDirectory: async () => null,
      },
    ),
    (error) => error?.code === "subtitle-save-permission-required",
  );
});
