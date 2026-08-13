import test from "node:test";
import assert from "node:assert/strict";
import { verifyToken } from "./youtube-token.js";

const SECRET = "worker-test-secret-0123456789";
const ADMIN_TOKEN = "admin-token";
let moduleCounter = 0;

function memoryKv() {
  const map = new Map();
  return {
    async get(key, type) {
      if (!map.has(key)) return null;
      return type === "json" ? JSON.parse(map.get(key)) : map.get(key);
    },
    async put(key, value) {
      map.set(key, String(value));
    },
    async list() {
      return { keys: [...map.keys()].map((name) => ({ name })) };
    },
  };
}

function environment(kv = memoryKv(), overrides = {}) {
  return {
    YT_SERVER_SECRET: SECRET,
    ADMIN_TOKEN,
    LICENSES: kv,
    COMPANION_BUCKET: {},
    ASSETS: { fetch: async () => new Response("assets", { status: 200 }) },
    ...overrides,
  };
}

async function loadWorker() {
  const mod = await import(`./worker.js?test=${++moduleCounter}`);
  return mod.default;
}

function postToken(deviceId, key, ip = "203.0.113.1") {
  return new Request("https://aura.mdownloader.workers.dev/api/youtube-token", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ deviceId, key }),
  });
}

test("issues a free token for any valid device id", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(postToken("device-1234"), environment());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.plan, "free");
  const payload = await verifyToken(SECRET, body.token);
  assert.equal(payload.deviceId, "device-1234");
  assert.equal(payload.plan, "free");
  assert.equal(payload.keyId, null);
  assert.ok(payload.exp > Date.now());
});

test("issues a pro token only for an approved key", async () => {
  const worker = await loadWorker();
  const kv = memoryKv();
  const key = `AM-${"A".repeat(36)}`;
  await kv.put(key, JSON.stringify({ status: "approved", createdAt: new Date().toISOString() }));
  const response = await worker.fetch(postToken("device-5678", key), environment(kv));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.plan, "pro");
  const payload = await verifyToken(SECRET, body.token);
  assert.equal(payload.plan, "pro");
  assert.equal(payload.keyId, key);
});

test("rejects pending keys, unknown keys, and malformed keys", async () => {
  const worker = await loadWorker();
  const kv = memoryKv();
  const pending = `AM-${"B".repeat(36)}`;
  await kv.put(pending, JSON.stringify({ status: "pending", createdAt: new Date().toISOString() }));

  const pendingResponse = await worker.fetch(postToken("device-5678", pending), environment(kv));
  assert.equal(pendingResponse.status, 403);

  const unknown = `AM-${"C".repeat(36)}`;
  const unknownResponse = await worker.fetch(postToken("device-5678", unknown), environment(kv));
  assert.equal(unknownResponse.status, 403);

  const malformed = await worker.fetch(postToken("device-5678", "not-a-key"), environment(kv));
  assert.equal(malformed.status, 400);
});

test("rejects invalid device ids", async () => {
  const worker = await loadWorker();
  for (const deviceId of ["", "short", "bad device", "x".repeat(65)]) {
    const response = await worker.fetch(postToken(deviceId), environment());
    assert.equal(response.status, 400, `deviceId=${deviceId}`);
  }
});

test("fails closed when the signing secret is missing", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    postToken("device-1234"),
    environment(memoryKv(), { YT_SERVER_SECRET: "" }),
  );
  assert.equal(response.status, 503);
});

test("rate limits token issuance per IP", async () => {
  const worker = await loadWorker();
  const env = environment();
  for (let i = 0; i < 30; i += 1) {
    const response = await worker.fetch(postToken(`device-${String(i).padStart(8, "0")}`, undefined, "198.51.100.7"), env);
    assert.equal(response.status, 200);
  }
  const blocked = await worker.fetch(postToken("device-9999", undefined, "198.51.100.7"), env);
  assert.equal(blocked.status, 429);
  const otherIp = await worker.fetch(postToken("device-9999", undefined, "198.51.100.8"), env);
  assert.equal(otherIp.status, 200);
});
