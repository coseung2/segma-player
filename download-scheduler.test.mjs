import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDownloadScheduler } from "./download-scheduler.js";

test("runs up to three media jobs in parallel and drains the rest", async () => {
  const scheduler = createDownloadScheduler({ concurrency: 3 });
  let running = 0;
  let maximum = 0;
  const releases = [];
  const started = [];

  const jobs = Array.from({ length: 6 }, (_, index) => scheduler.schedule(async () => {
    running += 1;
    maximum = Math.max(maximum, running);
    started.push(index);
    await new Promise((resolve) => releases.push(resolve));
    running -= 1;
    return index;
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximum, 3);
  assert.deepEqual(started, [0, 1, 2]);
  assert.equal(scheduler.activeCount, 3);
  assert.equal(scheduler.pendingCount, 3);

  releases.splice(0, 3).forEach((release) => release());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  releases.splice(0).forEach((release) => release());
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3, 4, 5]);
  assert.equal(scheduler.activeCount, 0);
});

test("a failed media job does not stall queued jobs", async () => {
  const scheduler = createDownloadScheduler({ concurrency: 1 });
  const failed = scheduler.schedule(() => { throw new Error("failed"); });
  const completed = scheduler.schedule(() => "next");
  await assert.rejects(failed, /failed/);
  assert.equal(await completed, "next");
});

test("worker prepares page-dependent data before waiting for a transfer slot", async () => {
  const source = await readFile(new URL("./download-worker.js", import.meta.url), "utf8");
  const prepareAt = source.indexOf("const prepared = await prepareDownloadCandidate");
  const scheduleAt = source.indexOf("const result = await scheduler.schedule");
  assert.ok(prepareAt >= 0);
  assert.ok(scheduleAt > prepareAt);
  assert.equal(source.includes("let queue = Promise.resolve()"), false);
});
