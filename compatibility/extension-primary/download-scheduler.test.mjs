import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDownloadScheduler } from "./download-scheduler.js";

test("runs all jobs immediately when concurrency is unlimited (null)", async () => {
  const scheduler = createDownloadScheduler({ concurrency: null });
  let running = 0;
  let maximum = 0;
  const releases = [];
  const started = [];

  const jobs = Array.from({ length: 5 }, (_, index) => scheduler.schedule(async () => {
    running += 1;
    maximum = Math.max(maximum, running);
    started.push(index);
    await new Promise((resolve) => releases.push(resolve));
    running -= 1;
    return index;
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximum, 5);
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  assert.equal(scheduler.activeCount, 5);
  assert.equal(scheduler.pendingCount, 0);
  releases.forEach((release) => release());
  await Promise.all(jobs);
  assert.equal(scheduler.activeCount, 0);
});

test("setConcurrency accepts null for unlimited", () => {
  const scheduler = createDownloadScheduler({ concurrency: 1 });
  scheduler.setConcurrency(null);
  assert.equal(scheduler.concurrency, null);
});

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

test("setConcurrency raises and lowers the parallel window without losing work", async () => {
  const scheduler = createDownloadScheduler({ concurrency: 1 });
  let running = 0;
  let maximum = 0;
  const releases = [];
  const started = [];
  const jobs = Array.from({ length: 4 }, (_, index) => scheduler.schedule(async () => {
    running += 1;
    maximum = Math.max(maximum, running);
    started.push(index);
    await new Promise((resolve) => releases.push(resolve));
    running -= 1;
    return index;
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0]);
  scheduler.setConcurrency(3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2]);
  assert.equal(maximum, 3);
  assert.equal(scheduler.concurrency, 3);
  releases.splice(0, 3).forEach((release) => release());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2, 3]);
  releases.splice(0).forEach((release) => release());
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3]);

  scheduler.setConcurrency(1);
  let secondRunning = 0;
  let secondMaximum = 0;
  const secondReleases = [];
  const second = Array.from({ length: 3 }, () => scheduler.schedule(async () => {
    secondRunning += 1;
    secondMaximum = Math.max(secondMaximum, secondRunning);
    await new Promise((resolve) => secondReleases.push(resolve));
    secondRunning -= 1;
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondMaximum, 1, "lowered concurrency must serialize new work");
  while (secondReleases.length) {
    secondReleases.splice(0).forEach((release) => release());
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(second);
  assert.throws(() => scheduler.setConcurrency(0), /positive integer/);
});

test("a paused transfer releases its slot and reacquires it after the next job", async () => {
  const scheduler = createDownloadScheduler({ concurrency: 1 });
  let firstLease;
  let finishFirst;
  let firstStartedResolve;
  const firstStarted = new Promise((resolve) => { firstStartedResolve = resolve; });
  const first = scheduler.schedule(async (lease) => {
    firstLease = lease;
    firstStartedResolve();
    await new Promise((resolve) => { finishFirst = resolve; });
    return "first";
  });
  await firstStarted;

  await firstLease.suspend();
  const second = scheduler.schedule(() => "second");
  assert.equal(await second, "second");
  assert.equal(scheduler.activeCount, 0);

  await firstLease.resume();
  assert.equal(scheduler.activeCount, 1);
  finishFirst();
  assert.equal(await first, "first");
  assert.equal(scheduler.activeCount, 0);
});

test("worker prepares page-dependent data before waiting for a transfer slot", async () => {
  const source = await readFile(new URL("./download-worker.js", import.meta.url), "utf8");
  const prepareAt = source.indexOf("const prepared = await prepareWithTimeout");
  const scheduleAt = source.indexOf("const result = await scheduler.schedule");
  assert.ok(prepareAt >= 0);
  assert.ok(scheduleAt > prepareAt);
  assert.equal(source.includes("let queue = Promise.resolve()"), false);
  assert.match(source, /PREPARATION_TIMEOUT_MS = 45_000/);
});
