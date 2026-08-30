import test from "node:test";
import assert from "node:assert/strict";

import { createCandidateRepository } from "./background-candidate-repository.js";
import { createCompanionHandoff, isYouTubeDetectionCandidate } from "./background-companion-handoff.js";
import { createDownloadRouter } from "./background-download-router.js";
import { createProgressiveRedirectStore, createQaRequestTraceStore } from "./background-request-evidence.js";

function progressiveCandidate(overrides = {}) {
  return {
    id: "candidate-1",
    resourceUrl: "https://cdn.example/video.mp4",
    pageUrl: "https://page.example/watch",
    pageTitle: "Video",
    mediaType: "PROGRESSIVE",
    ...overrides,
  };
}

test("Companion handoff keeps media and YouTube commands bounded", async () => {
  const mediaRequests = [];
  const youtubeRequests = [];
  const handoff = createCompanionHandoff({
    resolveCandidate: async (candidate) => candidate,
    randomUuid: () => "job-1",
    browserContext: () => ({ browser: "Chrome" }),
    startMedia: async (request) => { mediaRequests.push(request); },
    startYouTube: async (request) => {
      youtubeRequests.push(request);
      return { accepted: true, jobId: request.jobId };
    },
  });

  assert.deepEqual(await handoff.beginCandidateDownload(progressiveCandidate()), {
    mode: "media-companion",
    jobId: "job-1",
  });
  assert.deepEqual(mediaRequests, [{
    jobId: "job-1",
    candidateId: "candidate-1",
    url: "https://cdn.example/video.mp4",
    referrer: "https://page.example/watch",
    title: "Video",
    inputKind: "PROGRESSIVE",
    browser: "Chrome",
  }]);
  assert.deepEqual(await handoff.startYouTubeDownload("https://youtu.be/example", "1080"), {
    mode: "youtube-companion",
    jobId: "job-1",
  });
  assert.equal(youtubeRequests[0].quality, "1080");
  await assert.rejects(() => handoff.beginCandidateDownload(progressiveCandidate({
    resourceUrl: "https://cdn.example/segment-1.ts",
    mediaType: "UNKNOWN",
  })), /unsupported-media/);
  await assert.rejects(() => handoff.startYouTubeDownload("https://example.com/video", "best"), /invalid-youtube-url/);
  assert.equal(isYouTubeDetectionCandidate({ pageUrl: "https://www.youtube.com/watch?v=x" }), true);
  assert.equal(isYouTubeDetectionCandidate({
    pageUrl: "https://blog.example/post",
    resourceUrl: "https://r1---sn.googlevideo.com/videoplayback",
  }), false);
});

test("candidate and pasted-link routes converge on the same Companion handoff", async () => {
  const candidates = new Map([["candidate-1", progressiveCandidate()]]);
  const handoffs = [];
  const observed = [];
  const router = createDownloadRouter({
    candidates,
    ensureDirectMediaAccess: async () => ({ ok: true }),
    playerGraphResolver: {
      resolve: async () => ({
        url: "https://cdn.example/resolved.m3u8",
        type: "hls",
        referrer: "https://player.example/e/abc",
      }),
    },
    observeResource: (input) => {
      observed.push(input);
      return progressiveCandidate({
        id: "candidate-link",
        resourceUrl: input.resourceUrl,
        pageUrl: input.pageUrl,
        mediaType: input.contentType.includes("mpegurl") ? "HLS_MASTER" : "PROGRESSIVE",
      });
    },
    beginCandidateDownload: async (candidate) => {
      handoffs.push(candidate);
      return { mode: "media-companion", jobId: `job-${handoffs.length}` };
    },
  });

  const ranked = await router.downloadCandidate("candidate-1");
  const pasted = await router.downloadUrl("https://player.example/e/abc");
  assert.equal(ranked.candidate.id, "candidate-1");
  assert.equal(pasted.candidate.id, "candidate-link");
  assert.deepEqual(handoffs.map((candidate) => candidate.id), ["candidate-1", "candidate-link"]);
  assert.equal(observed[0].resourceUrl, "https://cdn.example/resolved.m3u8");
  assert.equal(observed[0].pageUrl, "https://player.example/e/abc");
  await assert.rejects(() => router.downloadCandidate("missing"), { code: "candidate-not-found" });
});

test("candidate repository ranks, persists, restores, and clears per tab", async () => {
  const writes = [];
  const storageSession = {
    get: async () => ({ candidates: [] }),
    set: async (value) => { writes.push(value); },
  };
  const timers = [];
  const repository = createCandidateRepository({
    storageSession,
    now: () => 1000,
    schedule: (callback) => { timers.push(callback); return callback; },
    cancelSchedule: () => {},
  });
  const stored = repository.observeResource({
    pageTitle: "Video",
    pageUrl: "https://page.example/watch",
    frameUrl: "https://page.example/watch",
    resourceUrl: "https://cdn.example/video.mp4",
    contentType: "video/mp4",
    detectionSource: "test",
    confidence: 100,
  }, 7);
  assert.equal(stored.tabId, 7);
  assert.equal(repository.candidates.size, 1);
  assert.equal(repository.rerankTabCandidates(7).length, 1);
  timers.at(-1)();
  assert.equal(writes.at(-1).candidates.length, 1);
  repository.clearTab(7);
  assert.equal(repository.candidates.size, 0);
  timers.at(-1)();
  assert.deepEqual(writes.at(-1), { candidates: [] });
  assert.equal(await repository.restore(), 0);
});

test("request evidence stores are bounded and return defensive views", () => {
  let now = 100;
  const traces = createQaRequestTraceStore({ limit: 2, now: () => now });
  traces.remember({ tabId: 1, requestId: "a", url: "https://cdn.example/a.mp4" }, { phase: "request" });
  traces.remember({ tabId: 1, requestId: "a", url: "https://cdn.example/a.mp4" }, { phase: "headers" });
  traces.remember({ tabId: 2, requestId: "b", url: "https://cdn.example/b.mp4" }, { phase: "request" });
  traces.remember({ tabId: 3, requestId: "c", url: "https://cdn.example/c.mp4" }, { phase: "request" });
  assert.equal(traces.size, 2);
  assert.deepEqual(traces.listForTab(1), []);
  const view = traces.listForTab(2);
  view[0].phases.push("mutated");
  assert.deepEqual(traces.listForTab(2)[0].phases, ["request"]);

  const redirects = createProgressiveRedirectStore({ limit: 2, ttlMs: 10, now: () => now });
  assert.equal(redirects.record({
    url: "https://cdn.example/start",
    redirectUrl: "https://cdn.example/final.mp4",
  }), true);
  assert.equal(redirects.get("https://cdn.example/start"), "https://cdn.example/final.mp4");
  now += 11;
  assert.equal(redirects.get("https://cdn.example/start"), null);
});
