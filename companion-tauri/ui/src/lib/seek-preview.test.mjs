import assert from "node:assert/strict";
import test from "node:test";
import { createSeekPreview, previewTimestamp } from "./seek-preview.ts";

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function harness(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const requests = [];
  const states = [];
  let identity = "one\0clip.mp4";
  const controller = createSeekPreview((target) => new Promise((resolve, reject) => {
    requests.push({ target, resolve, reject });
  }), (state) => states.push(state), (key) => key === identity);
  const request = (time, folder = "one") => controller.request({
    identity: `${folder}\0clip.mp4`, folder, fileName: "clip.mp4", timestampSeconds: time, durationSeconds: 10,
  });
  return { controller, requests, states, request, switchTo: (folder) => { identity = `${folder}\0clip.mp4`; } };
}

test("hover churn within one native cache slot still displays the actual frame", async (t) => {
  const h = harness(t);
  h.request(2.05);
  t.mock.timers.tick(0);
  for (const time of [2.1, 2.2, 2.3, 2.49]) h.request(time);
  h.requests[0].resolve({ url: "asset://frame-2.jpg", timestampSeconds: 2 });
  await settle();
  assert.deepEqual(h.states.at(-1), { status: "ready", frame: { url: "asset://frame-2.jpg", timestampSeconds: 2 } });
  h.request(2.15);
  t.mock.timers.tick(1000);
  assert.equal(h.states.at(-1).frame.url, "asset://frame-2.jpg");
  assert.equal(h.requests.length, 1);
  h.controller.clear();
});

test("moving across slots queues only the latest target and never displays an old frame", async (t) => {
  const h = harness(t);
  h.request(1);
  t.mock.timers.tick(0);
  for (let time = 2; time <= 8; time++) h.request(time);
  t.mock.timers.tick(1000);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.states.at(-1), { status: "loading", frame: null });
  h.requests[0].resolve({ url: "asset://old.jpg", timestampSeconds: 1 });
  await settle();
  assert.equal(h.states.at(-1).frame, null);
  t.mock.timers.tick(0);
  assert.equal(h.requests[1].target.timestampSeconds, 8);
  h.requests[1].resolve({ url: "asset://latest.jpg", timestampSeconds: 8 });
  await settle();
  assert.equal(h.states.at(-1).frame.url, "asset://latest.jpg");
  h.controller.clear();
});

test("leave then reenter the same slot rejects the old response", async (t) => {
  const h = harness(t);
  h.request(2);
  t.mock.timers.tick(0);
  h.controller.clear();
  assert.equal(h.states.at(-1).status, "idle");
  h.request(2);
  h.requests[0].resolve({ url: "asset://old.jpg", timestampSeconds: 2 });
  await settle();
  assert.equal(h.states.at(-1).frame, null);
  t.mock.timers.tick(180);
  h.requests[1].resolve({ url: "asset://fresh.jpg", timestampSeconds: 2 });
  await settle();
  assert.equal(h.states.at(-1).frame.url, "asset://fresh.jpg");
  h.controller.clear();
});

test("same-named file in another folder cannot receive a stale response even before effect cleanup", async (t) => {
  const h = harness(t);
  h.request(2);
  t.mock.timers.tick(0);
  h.switchTo("two");
  h.requests[0].resolve({ url: "asset://wrong-folder.jpg", timestampSeconds: 2 });
  await settle();
  assert.equal(h.states.at(-1).frame, null);
  h.controller.clear();
  h.request(3, "two");
  t.mock.timers.tick(180);
  h.requests[1].resolve({ url: "asset://two.jpg", timestampSeconds: 3 });
  await settle();
  assert.equal(h.states.at(-1).frame.url, "asset://two.jpg");
  h.controller.clear();
});

test("missing engine and extraction failures show unavailable and recover at a new target", async (t) => {
  const h = harness(t);
  h.request(0);
  t.mock.timers.tick(0);
  h.requests[0].resolve(null);
  await settle();
  assert.deepEqual(h.states.at(-1), { status: "unavailable", frame: null });
  h.request(1);
  t.mock.timers.tick(180);
  h.requests[1].reject(new Error("ffmpeg failed"));
  await settle();
  assert.equal(h.states.at(-1).status, "unavailable");
  h.request(2);
  t.mock.timers.tick(180);
  h.requests[2].resolve({ url: "asset://recovered.jpg", timestampSeconds: 2 });
  await settle();
  assert.equal(h.states.at(-1).frame.url, "asset://recovered.jpg");
  h.controller.clear();
});

test("short videos and final-frame timestamps use a decodable earlier slot", () => {
  assert.equal(previewTimestamp(1.52, 1.52), 1);
  assert.equal(previewTimestamp(0.1, 0.1), 0);
  assert.equal(previewTimestamp(999, 10), 9.5);
  assert.equal(previewTimestamp(-1, 10), 0);
});
