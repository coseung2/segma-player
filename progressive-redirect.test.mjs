import test from "node:test";
import assert from "node:assert/strict";

import {
  authenticatedRecoveryForProgressiveError,
  createProgressiveRedirectResolver,
  progressiveDownloadErrorMessage,
  replayableRecordedHeaders,
} from "./progressive-redirect.js";

const initialUrl = "https://streamtape.com/get_video?id=sample&token=secret";
const finalUrl = "https://edge.tapecontent.net/video.mp4";
const referrer = "https://streamtape.com/v/sample/video.mp4";

function routeResult() {
  return { ok: true, expiresAtUtc: new Date(Date.now() + 300_000).toISOString() };
}

test("orders initial route, bounded probe, final route, and full fetch", async () => {
  const events = [];
  const resolver = createProgressiveRedirectResolver({
    ensureRoutes: async (urls) => {
      events.push(["route", urls[0]]);
      return routeResult();
    },
    fetchImpl: async (url, options) => {
      events.push(["probe", url, options]);
      return {
        ok: true,
        status: 206,
        url: finalUrl,
        body: { cancel: async () => events.push(["cancel"]) },
      };
    },
  });

  const prepared = await resolver.resolve({
    url: initialUrl,
    referrer,
    requestHeaders: { Authorization: "Bearer sample", rAnGe: "bytes=1048576-" },
  });
  events.push(["full", prepared.url, prepared.referrer]);

  assert.deepEqual(events.map(([type, value]) => [type, value]), [
    ["route", initialUrl],
    ["probe", initialUrl],
    ["cancel", undefined],
    ["route", finalUrl],
    ["full", finalUrl],
  ]);
  assert.equal(events[1][2].headers.Authorization, "Bearer sample");
  assert.equal(events[1][2].headers.Range, "bytes=0-0");
  assert.equal(new Headers(events[1][2].headers).get("range"), "bytes=0-0");
  assert.equal(events[1][2].referrer, referrer);
  assert.equal(prepared.referrer, referrer);
});

test("filters recorded Range case-insensitively before replay or DNR rule conversion", () => {
  const replayable = replayableRecordedHeaders({
    rAnGe: "bytes=1048576-",
    Authorization: "Bearer sample",
  });
  const dnrRequestHeaders = Object.entries(replayable)
    .map(([header, value]) => ({ header, operation: "set", value }));

  assert.equal(new Headers(replayable).has("range"), false);
  assert.deepEqual(dnrRequestHeaders, [
    { header: "Authorization", operation: "set", value: "Bearer sample" },
  ]);
});

test("requests authenticated recovery only for media probe failures", () => {
  const session = { url: initialUrl, referrer };
  assert.deepEqual(
    authenticatedRecoveryForProgressiveError({ code: "media-probe-failed" }, session),
    { ...session, authenticatedProbeRequired: true },
  );
  assert.equal(authenticatedRecoveryForProgressiveError({ code: "route-timeout" }, session), null);
});

test("maps coded progressive failures to Korean while preserving useful Korean messages", () => {
  assert.equal(progressiveDownloadErrorMessage({ code: "invalid-probe-url", message: "invalid-probe-url" }), "영상 주소가 올바르지 않습니다.");
  assert.equal(progressiveDownloadErrorMessage({ code: "invalid-probe-referrer", message: "invalid-probe-referrer" }), "영상 페이지 주소가 올바르지 않습니다.");
  assert.equal(progressiveDownloadErrorMessage({ code: "route-timeout", message: "route-timeout" }), "미디어 경로 준비 시간이 초과되었습니다. 다시 시도해 주세요.");
  assert.equal(progressiveDownloadErrorMessage({ code: "invalid-route-url", message: "invalid-route-url" }), "미디어 경로 주소가 올바르지 않습니다.");
  assert.equal(progressiveDownloadErrorMessage(new Error("이미 유용한 한국어 오류입니다.")), "이미 유용한 한국어 오류입니다.");
});

test("does not start a full fetch when final route preparation fails", async () => {
  const events = [];
  let fullFetches = 0;
  const resolver = createProgressiveRedirectResolver({
    ensureRoutes: async (urls) => {
      events.push(["route", urls[0]]);
      if (urls[0] === finalUrl) throw new Error("final route rejected");
      return routeResult();
    },
    fetchImpl: async (url) => {
      events.push(["probe", url]);
      return {
        ok: true,
        status: 206,
        url: finalUrl,
        body: { cancel: async () => events.push(["cancel"]) },
      };
    },
  });

  await assert.rejects(
    (async () => {
      const prepared = await resolver.resolve({ url: initialUrl, referrer });
      fullFetches += 1;
      return prepared;
    })(),
    /final route rejected/,
  );
  assert.equal(fullFetches, 0);
  assert.deepEqual(events.map(([type, value]) => [type, value]), [
    ["route", initialUrl],
    ["probe", initialUrl],
    ["cancel", undefined],
    ["route", finalUrl],
  ]);
});
