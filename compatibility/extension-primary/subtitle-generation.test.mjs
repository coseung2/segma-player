import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { requestGeneratedSubtitle } from "./subtitle-generation.js";

test("a failed subtitle save retries from the generated subtitle cache", async () => {
  const worker = await readFile(new URL("./download-worker.js", import.meta.url), "utf8");
  assert.match(worker, /loadGeneratedSubtitle/);
  const job = worker.match(/async function runSubtitleJob\([\s\S]*?\n\}/)?.[0] || "";
  assert.ok(job.indexOf("loadGeneratedSubtitle(input)") < job.indexOf("requestGeneratedSubtitle"));
});

test("subtitle generation uploads browser-prepared audio instead of a remote media request", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (options.method === "POST") {
      assert.ok(options.body instanceof Blob);
      assert.equal(options.body.size, 4);
      assert.equal(options.headers.authorization, "Bearer AM-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
      assert.equal(options.headers["content-type"], "audio/mp4");
      assert.equal(options.headers["x-aura-audio-upload"], "1");
      assert.equal(options.headers["x-aura-audio-bytes"], "4");
      assert.equal(options.headers["x-aura-source-language"], "ja");
      assert.equal(options.headers["x-aura-audio-source"], "hls-audio-rendition");
      assert.equal(decodeURIComponent(options.headers["x-aura-title"]), "Test");
      return new Response(JSON.stringify({ ok: true, jobId: "job-audio-1" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }
    assert.equal(options.headers.authorization, "Bearer AM-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    return new Response(JSON.stringify({
      ok: true,
      status: "completed",
      result: {
        vtt: "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\n테스트\n",
        model: "test-model",
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const progress = [];
    const result = await requestGeneratedSubtitle({
      mediaUrl: "https://media.example/master.m3u8",
      sourceUrl: "https://site.example/watch/1",
      title: "Test",
      sourceLanguage: "ja",
      licenseKey: "AM-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      audioUpload: {
        blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/mp4" }),
        filename: "audio.m4a",
        source: "hls-audio-rendition",
      },
      onProgress: (value) => progress.push(value),
    });
    assert.equal(result.model, "test-model");
    assert.match(result.vtt, /WEBVTT/);
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /\?id=job-audio-1$/);
    assert.equal(progress[0].phase, "uploading-audio");
  } finally {
    delete globalThis.fetch;
  }
});
