import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_HEARTBEAT_CADENCE_MS,
  HEARTBEAT_ALARM_NAME,
  HEARTBEAT_PORT_PREFIX,
  MAX_HEARTBEAT_CADENCE_MS,
  MAX_HEARTBEAT_STALE_AFTER_MS,
  MIN_HEARTBEAT_CADENCE_MS,
  MIN_HEARTBEAT_STALE_AFTER_MS,
  heartbeatAlarmSpec,
  heartbeatPortName,
  heartbeatStaleAfterMs,
  hasActiveWork,
  isHeartbeatPortName,
  isHeartbeatStale,
  normalizeHeartbeatCadence,
  normalizeHeartbeatStaleAfter,
  shouldKeepWorkerAlive,
} from "./worker-lifecycle.js";

test("creates bounded, namespaced heartbeat port names", () => {
  const name = heartbeatPortName("downloads");
  assert.equal(name, `${HEARTBEAT_PORT_PREFIX}downloads`);
  assert.equal(isHeartbeatPortName(name), true);
  assert.equal(isHeartbeatPortName("media-stream"), false);
  assert.equal(isHeartbeatPortName(`${HEARTBEAT_PORT_PREFIX}bad scope`), false);
  assert.throws(() => heartbeatPortName("bad scope"), /invalid-heartbeat-scope/);
  assert.equal(heartbeatPortName(17), `${HEARTBEAT_PORT_PREFIX}17`);
});

test("clamps alarm cadence and emits a Chrome alarm-compatible schedule", () => {
  assert.equal(normalizeHeartbeatCadence(1), MIN_HEARTBEAT_CADENCE_MS);
  assert.equal(normalizeHeartbeatCadence(Number.MAX_SAFE_INTEGER), MAX_HEARTBEAT_CADENCE_MS);
  assert.equal(normalizeHeartbeatCadence(Number.NaN), DEFAULT_HEARTBEAT_CADENCE_MS);
  assert.deepEqual(heartbeatAlarmSpec(DEFAULT_HEARTBEAT_CADENCE_MS), {
    name: HEARTBEAT_ALARM_NAME,
    periodInMinutes: 1,
  });
  assert.equal(heartbeatAlarmSpec(MAX_HEARTBEAT_CADENCE_MS).periodInMinutes, 5);
});

test("bounds stale detection and treats missing or old beats as stale", () => {
  assert.equal(normalizeHeartbeatStaleAfter(1), MIN_HEARTBEAT_STALE_AFTER_MS);
  assert.equal(normalizeHeartbeatStaleAfter(Number.MAX_SAFE_INTEGER), MAX_HEARTBEAT_STALE_AFTER_MS);
  assert.equal(heartbeatStaleAfterMs(MIN_HEARTBEAT_CADENCE_MS), 3 * MIN_HEARTBEAT_CADENCE_MS);
  const now = 100_000;
  const staleAfterMs = MIN_HEARTBEAT_STALE_AFTER_MS;
  assert.equal(isHeartbeatStale(now - staleAfterMs, { now, staleAfterMs }), false);
  assert.equal(isHeartbeatStale(now - staleAfterMs - 1, { now, staleAfterMs }), true);
  assert.equal(isHeartbeatStale(undefined, { now, staleAfterMs }), true);
});

test("requires keepalive for active downloads, but not idle work", () => {
  assert.equal(shouldKeepWorkerAlive({ activeDownloads: 1 }), true);
  assert.equal(shouldKeepWorkerAlive({ downloads: [{ status: "running" }] }), true);
  assert.equal(shouldKeepWorkerAlive({
    downloads: [{ status: "completed" }, { status: "cancelled" }],
  }), false);
  assert.equal(hasActiveWork({ status: "queued" }), true);
  assert.equal(hasActiveWork({ status: "failed" }), false);
  assert.equal(shouldKeepWorkerAlive(), false);
});
