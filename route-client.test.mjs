import test from "node:test";
import assert from "node:assert/strict";
import { createMediaRouteClient } from "./route-client.js";

function createPort() {
  const messages = [];
  const messageListeners = [];
  const disconnectListeners = [];
  return {
    messages,
    onMessage: { addListener(listener) { messageListeners.push(listener); } },
    onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
    postMessage(message) { messages.push(message); },
    respond(message) {
      for (const listener of messageListeners) listener(message);
    },
    disconnect() {
      for (const listener of disconnectListeners) listener();
    },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function validResponse(request, hosts, expiresAtMs) {
  return {
    type: "ensure-routes-result",
    requestId: request.requestId,
    ok: true,
    hosts,
    expiresAtUtc: new Date(expiresAtMs).toISOString(),
  };
}

test("rejects a successful native response without a future expiry", async () => {
  const port = createPort();
  const now = 1_800_000_000_000;
  const client = createMediaRouteClient({
    connectNative: () => port,
    now: () => now,
    randomUUID: () => "request-missing-expiry",
  });
  const pending = client.ensureRoutes(["https://media.example/video.mp4"]);
  await flush();
  port.respond({
    type: "ensure-routes-result",
    requestId: port.messages[0].requestId,
    ok: true,
    hosts: ["media.example"],
  });
  await assert.rejects(pending, (error) => error.code === "invalid-route-response");
  assert.deepEqual(client.cachedHosts(), []);
});

test("rejects a partial successful native response and does not cache the partial lease", async () => {
  const port = createPort();
  const now = 1_800_000_000_000;
  const client = createMediaRouteClient({
    connectNative: () => port,
    now: () => now,
    randomUUID: () => "request-partial-hosts",
  });
  const pending = client.ensureRoutes([
    "https://media.example/video.mp4",
    "https://cdn.example/segment.ts",
  ]);
  await flush();
  port.respond(validResponse(port.messages[0], ["media.example"], now + 1800_000));
  await assert.rejects(pending, (error) => error.code === "invalid-route-response");
  assert.deepEqual(client.cachedHosts(), []);
});

test("deduplicates overlapping requests and caches each host only until server expiry", async () => {
  const port = createPort();
  let now = 1_800_000_000_000;
  let requestNumber = 0;
  const client = createMediaRouteClient({
    connectNative: () => port,
    now: () => now,
    randomUUID: () => `request-${++requestNumber}`,
  });
  const first = client.ensureRoutes([
    "https://media.example/video.mp4",
    "https://cdn.example/segment.ts",
  ]);
  const second = client.ensureRoutes([
    "https://cdn.example/key.bin",
    "https://edge.example/init.mp4",
  ]);
  await flush();
  assert.equal(port.messages.length, 2);
  assert.deepEqual(port.messages.map((message) => message.urls), [
    ["https://media.example/video.mp4", "https://cdn.example/segment.ts"],
    ["https://edge.example/init.mp4"],
  ]);
  for (const message of port.messages) {
    port.respond(validResponse(message, message.urls.map((url) => new URL(url).hostname), now + 1800_000));
  }
  await Promise.all([first, second]);
  assert.deepEqual(client.cachedHosts().sort(), ["cdn.example", "edge.example", "media.example"]);

  await client.ensureRoutes(["https://media.example/another.mp4", "https://cdn.example/another.ts"]);
  assert.equal(port.messages.length, 2);

  now += 1800_001;
  const expired = client.ensureRoutes(["https://media.example/again.mp4"]);
  await flush();
  assert.equal(port.messages.length, 3);
  port.respond(validResponse(port.messages[2], ["media.example"], now + 1800_000));
  await expired;
});
