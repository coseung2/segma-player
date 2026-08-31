import test from "node:test";
import assert from "node:assert/strict";
import { verifyToken } from "./youtube-token.js";
import { verifyPaddleWebhookSignature } from "./paddle-payment.js";

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

async function ownAsrJob(kv, jobId, licenseKey) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(licenseKey));
  const owner = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  await kv.put(`asr-job-owner:${jobId}`, JSON.stringify({ owner }));
}

function environment(kv = memoryKv(), overrides = {}) {
  return {
    YT_SERVER_SECRET: SECRET,
    ADMIN_TOKEN,
    LICENSES: kv,
    COMPANION_BUCKET: {},
    ASSETS: {
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/404.html") return new Response("custom-404", { status: 200 });
        if (path === "/index.html") return new Response("index", { status: 200 });
        return new Response("custom-404", { status: 404 });
      },
    },
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

test("pro subtitle jobs are proxied without exposing the worker secret", async () => {
  const worker = await loadWorker();
  const kv = memoryKv();
  const key = `AM-${"D".repeat(36)}`;
  await kv.put(key, JSON.stringify({ status: "approved", createdAt: new Date().toISOString() }));
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (request, options) => {
    calls.push({ request: String(request), options });
    return new Response(JSON.stringify({ ok: true, jobId: "fc-123" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const response = await worker.fetch(new Request("https://aura.mdownloader.workers.dev/api/subtitles", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.30" },
      body: JSON.stringify({
        mediaUrl: "https://cdn.example.test/video.mp4",
        sourceUrl: "https://example.test/watch/1",
        title: "Sample",
        sourceLanguage: "en",
        licenseKey: key,
      }),
    }), environment(kv, {
      MODAL_ASR_URL: "https://aura-asr.modal.run",
      MODAL_ASR_TOKEN: "modal-secret",
    }));
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, jobId: "fc-123" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].request, "https://aura-asr.modal.run/submit");
    assert.equal(calls[0].options.headers.authorization, "Bearer modal-secret");
    assert.equal(JSON.parse(calls[0].options.body).licenseKey, undefined);
    assert.equal(JSON.parse(calls[0].options.body).sourceLanguage, "en");
    const owner = await kv.get("asr-job-owner:fc-123", "json");
    assert.match(owner.owner, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(owner).includes(key), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("browser-prepared subtitle audio is proxied to the CPU audio ingest endpoint", async () => {
  const worker = await loadWorker();
  const kv = memoryKv();
  const key = `AM-${"F".repeat(36)}`;
  await kv.put(key, JSON.stringify({ status: "approved", createdAt: new Date().toISOString() }));
  const audio = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/mp4" });
  const originalFetch = globalThis.fetch;
  let forwarded = null;
  globalThis.fetch = async (request, options) => {
    const bytes = new Uint8Array(await new Response(options.body).arrayBuffer());
    forwarded = { request: String(request), options, bytes };
    return new Response(JSON.stringify({ ok: true, jobId: "audio-job-1" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const response = await worker.fetch(new Request("https://aura.mdownloader.workers.dev/api/subtitles", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.31",
        "content-type": "audio/mp4",
        authorization: `Bearer ${key}`,
        "x-aura-audio-upload": "1",
        "x-aura-audio-bytes": "4",
        "content-length": "4",
        "x-aura-audio-source": "hls-audio-rendition",
        "x-aura-source-language": "ja",
        "x-aura-title": encodeURIComponent("Audio sample"),
      },
      body: audio,
    }), environment(kv, {
      MODAL_ASR_URL: "https://aura-asr.modal.run",
      MODAL_ASR_TOKEN: "modal-secret",
    }));
    assert.equal(response.status, 202);
    assert.equal(forwarded.request, "https://aura-asr.modal.run/submit-audio");
    assert.equal(forwarded.options.headers.authorization, "Bearer modal-secret");
    assert.equal(forwarded.options.headers["content-type"], "audio/mp4");
    assert.equal(decodeURIComponent(forwarded.options.headers["x-aura-title"]), "Audio sample");
    assert.equal(forwarded.options.headers["x-aura-source-language"], "ja");
    assert.equal(forwarded.options.headers["x-aura-audio-bytes"], "4");
    assert.equal(forwarded.options.headers["content-length"], "4");
    assert.deepEqual([...forwarded.bytes], [1, 2, 3, 4]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("subtitle proxy rejects private media addresses and handles preflight", async () => {
  const worker = await loadWorker();
  const invalid = await worker.fetch(new Request("https://aura.mdownloader.workers.dev/api/subtitles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mediaUrl: "http://127.0.0.1/video.mp4", licenseKey: `AM-${"E".repeat(36)}` }),
  }), environment(memoryKv(), {
    MODAL_ASR_URL: "https://aura-asr.modal.run",
    MODAL_ASR_TOKEN: "modal-secret",
  }));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, "invalid-media-url");
  const options = await worker.fetch(new Request("https://aura.mdownloader.workers.dev/api/subtitles", {
    method: "OPTIONS",
  }), environment());
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("access-control-allow-origin"), "*");
  assert.match(options.headers.get("access-control-allow-methods"), /\bDELETE\b/);
});

test("subtitle audio proxy enforces exact Content-Length and the 80 MiB boundary before upload", async () => {
  const worker = await loadWorker();
  const kv = memoryKv();
  const key = `AM-${"B".repeat(36)}`;
  await kv.put(key, JSON.stringify({ status: "approved", createdAt: new Date().toISOString() }));
  const env = environment(kv, {
    MODAL_ASR_URL: "https://aura-asr.modal.run",
    MODAL_ASR_TOKEN: "modal-secret",
  });
  const originalFetch = globalThis.fetch;
  const forwarded = [];
  globalThis.fetch = async (request, options) => {
    forwarded.push({ request: String(request), options });
    return new Response(JSON.stringify({ ok: true, jobId: "audio-boundary-job" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  };
  const request = ({ claimedBytes, contentLength, body = new Uint8Array([1, 2, 3, 4]), ip }) => new Request(
    "https://aura.mdownloader.workers.dev/api/subtitles",
    {
      method: "POST",
      headers: {
        "cf-connecting-ip": ip,
        "content-type": "audio/mp4",
        authorization: `Bearer ${key}`,
        "x-aura-audio-upload": "1",
        "x-aura-audio-bytes": String(claimedBytes),
        "content-length": String(contentLength),
      },
      body,
    },
  );
  try {
    const mismatch = await worker.fetch(request({
      claimedBytes: 5,
      contentLength: 4,
      ip: "203.0.113.41",
    }), env);
    assert.equal(mismatch.status, 400);
    assert.deepEqual(await mismatch.json(), { ok: false, error: "audio-size-mismatch" });
    assert.equal(forwarded.length, 0, "a mismatched request must not reach Modal");

    const maxBytes = 80 * 1024 * 1024;
    const bounded = await worker.fetch(request({
      claimedBytes: maxBytes,
      contentLength: maxBytes,
      ip: "203.0.113.42",
    }), env);
    assert.equal(bounded.status, 202);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].options.headers["content-length"], String(maxBytes));
    assert.equal(forwarded[0].options.headers["x-aura-audio-bytes"], String(maxBytes));

    const oversized = await worker.fetch(request({
      claimedBytes: maxBytes + 1,
      contentLength: maxBytes + 1,
      ip: "203.0.113.43",
    }), env);
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { ok: false, error: "subtitle-audio-too-large" });
    assert.equal(forwarded.length, 1, "an oversized request must be rejected before upload");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("subtitle result polling requires an approved license and forwards only the Modal credential", async () => {
  const worker = await loadWorker();
  const kv = memoryKv();
  const key = `AM-${"7".repeat(36)}`;
  await kv.put(key, JSON.stringify({ status: "approved", createdAt: new Date().toISOString() }));
  await ownAsrJob(kv, "fc-poll", key);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (request, options) => {
    calls.push({ request: String(request), options });
    return new Response(JSON.stringify({ ok: true, status: "running", progress: 25 }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const env = environment(kv, {
      MODAL_ASR_URL: "https://aura-asr.modal.run",
      MODAL_ASR_TOKEN: "modal-secret",
    });
    const unauthorized = await worker.fetch(
      new Request("https://aura.mdownloader.workers.dev/api/subtitles?id=fc-poll"),
      env,
    );
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { ok: false, error: "unauthorized" });
    assert.equal(calls.length, 0);

    const authorized = await worker.fetch(new Request(
      "https://aura.mdownloader.workers.dev/api/subtitles?id=fc-poll",
      { headers: { authorization: `Bearer ${key}` } },
    ), env);
    assert.equal(authorized.status, 202);
    assert.deepEqual(await authorized.json(), { ok: true, status: "running", progress: 25 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].request, "https://aura-asr.modal.run/result/fc-poll");
    assert.equal(calls[0].options.headers.authorization, "Bearer modal-secret");
    assert.equal(calls[0].request.includes(key), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("subtitle status and cancellation reject a different approved license owner", async () => {
  const worker = await loadWorker();
  const kv = memoryKv();
  const ownerKey = `AM-${"8".repeat(36)}`;
  const otherKey = `AM-${"9".repeat(36)}`;
  await kv.put(ownerKey, JSON.stringify({ status: "approved" }));
  await kv.put(otherKey, JSON.stringify({ status: "approved" }));
  await ownAsrJob(kv, "fc-owned", ownerKey);
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("unexpected");
  };
  try {
    const env = environment(kv, {
      MODAL_ASR_URL: "https://aura-asr.modal.run",
      MODAL_ASR_TOKEN: "modal-secret",
    });
    for (const method of ["GET", "DELETE"]) {
      const response = await worker.fetch(new Request(
        "https://aura.mdownloader.workers.dev/api/subtitles?id=fc-owned",
        { method, headers: { authorization: `Bearer ${otherKey}` } },
      ), env);
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { ok: false, error: "subtitle-job-not-owned" });
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authorized subtitle cancellation is proxied with only the Modal credential", async () => {
  const worker = await loadWorker();
  const kv = memoryKv();
  const key = `AM-${"1".repeat(36)}`;
  await kv.put(key, JSON.stringify({ status: "approved", createdAt: new Date().toISOString() }));
  await ownAsrJob(kv, "fc-123", key);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (request, options) => {
    calls.push({ request: String(request), options });
    return new Response(JSON.stringify({ ok: true, status: "cancelled" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const response = await worker.fetch(new Request(
      "https://aura.mdownloader.workers.dev/api/subtitles?id=fc-123",
      { method: "DELETE", headers: { authorization: `Bearer ${key}` } },
    ), environment(kv, {
      MODAL_ASR_URL: "https://aura-asr.modal.run",
      MODAL_ASR_TOKEN: "modal-secret",
    }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const responseText = await response.text();
    assert.deepEqual(JSON.parse(responseText), { ok: true, status: "cancelled" });
    assert.equal(responseText.includes("modal-secret"), false);
    assert.equal(responseText.includes(key), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].request, "https://aura-asr.modal.run/cancel/fc-123");
    assert.equal(calls[0].options.method, "DELETE");
    assert.equal(calls[0].options.headers.authorization, "Bearer modal-secret");
    assert.equal(calls[0].options.body, undefined);
    assert.equal(calls[0].request.includes(key), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("subtitle cancellation rejects missing and unsafe job ids before contacting Modal", async () => {
  const worker = await loadWorker();
  const kv = memoryKv();
  const key = `AM-${"2".repeat(36)}`;
  await kv.put(key, JSON.stringify({ status: "approved", createdAt: new Date().toISOString() }));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("Modal must not be contacted for an invalid job id");
  };
  try {
    for (const query of ["", "?id=bad%2Fid", `?id=${"x".repeat(161)}`]) {
      const response = await worker.fetch(new Request(
        `https://aura.mdownloader.workers.dev/api/subtitles${query}`,
        { method: "DELETE", headers: { authorization: `Bearer ${key}` } },
      ), environment(kv, {
        MODAL_ASR_URL: "https://aura-asr.modal.run",
        MODAL_ASR_TOKEN: "modal-secret",
      }));
      assert.equal(response.status, 400, query || "missing id");
      assert.deepEqual(await response.json(), { ok: false, error: "invalid-job-id" });
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("subtitle cancellation rejects callers without an approved license", async () => {
  const worker = await loadWorker();
  const kv = memoryKv();
  const pendingKey = `AM-${"3".repeat(36)}`;
  await kv.put(pendingKey, JSON.stringify({ status: "pending", createdAt: new Date().toISOString() }));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("unexpected");
  };
  try {
    for (const authorization of ["", `Bearer ${pendingKey}`, "Bearer not-a-license"]) {
      const headers = authorization ? { authorization } : {};
      const response = await worker.fetch(new Request(
        "https://aura.mdownloader.workers.dev/api/subtitles?id=fc-unauthorized",
        { method: "DELETE", headers },
      ), environment(kv, {
        MODAL_ASR_URL: "https://aura-asr.modal.run",
        MODAL_ASR_TOKEN: "modal-secret",
      }));
      assert.equal(response.status, 401, authorization || "missing authorization");
      assert.deepEqual(await response.json(), { ok: false, error: "unauthorized" });
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("subtitle cancellation is rate limited before excess Modal calls", async () => {
  const worker = await loadWorker();
  const kv = memoryKv();
  const key = `AM-${"6".repeat(36)}`;
  await kv.put(key, JSON.stringify({ status: "approved", createdAt: new Date().toISOString() }));
  await ownAsrJob(kv, "fc-rate-limited", key);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: true, status: "cancelled" }), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const env = environment(kv, {
      MODAL_ASR_URL: "https://aura-asr.modal.run",
      MODAL_ASR_TOKEN: "modal-secret",
    });
    const request = () => new Request(
      "https://aura.mdownloader.workers.dev/api/subtitles?id=fc-rate-limited",
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${key}`,
          "cf-connecting-ip": "198.51.100.60",
        },
      },
    );
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await worker.fetch(request(), env);
      assert.equal(response.status, 200, `attempt ${attempt + 1}`);
    }
    const blocked = await worker.fetch(request(), env);
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), { ok: false, error: "rate-limited" });
    assert.equal(calls, 12);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("subtitle cancellation preserves upstream failures and reports an unreachable Modal", async () => {
  const worker = await loadWorker();
  const kv = memoryKv();
  const key = `AM-${"4".repeat(36)}`;
  await kv.put(key, JSON.stringify({ status: "approved", createdAt: new Date().toISOString() }));
  await ownAsrJob(kv, "fc-failure", key);
  const env = environment(kv, {
    MODAL_ASR_URL: "https://aura-asr.modal.run",
    MODAL_ASR_TOKEN: "modal-secret",
  });
  const request = () => new Request(
    "https://aura.mdownloader.workers.dev/api/subtitles?id=fc-failure",
    { method: "DELETE", headers: { authorization: `Bearer ${key}` } },
  );
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ ok: false, error: "job-cancellation-failed" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
    const upstreamFailure = await worker.fetch(request(), env);
    assert.equal(upstreamFailure.status, 500);
    assert.deepEqual(await upstreamFailure.json(), { ok: false, error: "job-cancellation-failed" });

    globalThis.fetch = async () => { throw new Error("network down"); };
    const unreachable = await worker.fetch(request(), env);
    assert.equal(unreachable.status, 502);
    assert.deepEqual(await unreachable.json(), { ok: false, error: "asr-upstream-unreachable" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("subtitle cancellation keeps an already-completed job completed and is idempotent", async () => {
  const worker = await loadWorker();
  const kv = memoryKv();
  const key = `AM-${"5".repeat(36)}`;
  await kv.put(key, JSON.stringify({ status: "approved", createdAt: new Date().toISOString() }));
  await ownAsrJob(kv, "fc-completed", key);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: true, status: "completed" }), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const env = environment(kv, {
      MODAL_ASR_URL: "https://aura-asr.modal.run",
      MODAL_ASR_TOKEN: "modal-secret",
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await worker.fetch(new Request(
        "https://aura.mdownloader.workers.dev/api/subtitles?id=fc-completed",
        { method: "DELETE", headers: { authorization: `Bearer ${key}` } },
      ), env);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, status: "completed" });
    }
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("license endpoint enforces three devices per key", async () => {
  const worker = await loadWorker();
  const kv = memoryKv();
  const key = `AM-${"A".repeat(36)}`;
  await kv.put(key, JSON.stringify({ status: "approved", createdAt: new Date().toISOString() }));
  const licenseUrl = (deviceId) => `https://aura.mdownloader.workers.dev/api/license?key=${key}&deviceId=${deviceId}`;

  const first = await (await worker.fetch(new Request(licenseUrl("device-0001")), environment(kv))).json();
  assert.equal(first.ok, true);
  assert.equal(first.devices, 1);
  assert.equal(first.limit, 3);

  const same = await (await worker.fetch(new Request(licenseUrl("device-0001")), environment(kv))).json();
  assert.equal(same.devices, 1);

  const second = await (await worker.fetch(new Request(licenseUrl("device-0002")), environment(kv))).json();
  assert.equal(second.devices, 2);

  const third = await (await worker.fetch(new Request(licenseUrl("device-0003")), environment(kv))).json();
  assert.equal(third.devices, 3);

  const fourth = await worker.fetch(new Request(licenseUrl("device-0004")), environment(kv));
  assert.equal(fourth.status, 403);
  const fourthBody = await fourth.json();
  assert.equal(fourthBody.error, "device-limit-reached");
  assert.equal(fourthBody.devices, 3);
  assert.equal(fourthBody.limit, 3);
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

test("serves the custom 404 page for missing assets", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("https://aura.mdownloader.workers.dev/downloads/nope.zip"),
    environment(),
  );
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "custom-404");
});

function payOrder(period = "month") {
  return new Request("https://aura.mdownloader.workers.dev/api/pay/order", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ period }),
  });
}

function payVerify(orderId, txHash) {
  return new Request("https://aura.mdownloader.workers.dev/api/pay/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderId, txHash }),
  });
}

function paddleOrder(period = "month") {
  return new Request("https://aura.mdownloader.workers.dev/api/pay/paddle/order", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ period }),
  });
}

async function paddleSignature(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}:${rawBody}`));
  const signature = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `ts=${timestamp};h1=${signature}`;
}

const PAY_WALLET = "TGwSFr1JQhMz9bn2RfqQs4zJfRwv7rcWK5";
const PAY_WALLET_HEX = "0x4c731cfcd08b7729df01b11fab04d44126aabd8f";
const USDT_CONTRACT_HEX = "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c";

function tronGridStub(events) {
  return async () => new Response(JSON.stringify({ data: events }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("confirms a real TronGrid transfer whose address is reported as hex", async () => {
  const worker = await loadWorker();
  const kv = memoryKv();
  const originalFetch = globalThis.fetch;
  // TronGrid reports `to` and `contract_address` in 41-prefixed hex form while
  // the configured wallet is base58; both must still match.
  globalThis.fetch = tronGridStub([{
    event_name: "Transfer",
    contract_address: USDT_CONTRACT_HEX,
    result: { to: PAY_WALLET_HEX, value: "5990000" },
  }]);
  try {
    const created = await worker.fetch(payOrder("month"), environment(kv, { USDT_TRC20_ADDRESS: PAY_WALLET }));
    assert.equal(created.status, 201);
    const order = await created.json();
    assert.equal(order.amountUsdt, 5.99);

    const verified = await worker.fetch(
      payVerify(order.orderId, "a".repeat(64)),
      environment(kv, { USDT_TRC20_ADDRESS: PAY_WALLET }),
    );
    assert.equal(verified.status, 200);
    const body = await verified.json();
    assert.equal(body.ok, true);
    assert.equal(body.key, order.licenseKey);
    assert.ok(body.expiresAt > Date.now());

    const record = await kv.get(order.licenseKey, "json");
    assert.equal(record.status, "approved");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects a transfer to another wallet, the wrong token, or a short amount", async () => {
  const cases = [
    {
      name: "different recipient",
      events: [{ event_name: "Transfer", contract_address: USDT_CONTRACT_HEX, result: { to: "0x1196931d2ee2c2770115dba52082bae7ebff6d3a", value: "5990000" } }],
    },
    {
      name: "non-USDT contract",
      events: [{ event_name: "Transfer", contract_address: "0x1111111111111111111111111111111111111111", result: { to: PAY_WALLET_HEX, value: "5990000" } }],
    },
    {
      name: "underpaid",
      events: [{ event_name: "Transfer", contract_address: USDT_CONTRACT_HEX, result: { to: PAY_WALLET_HEX, value: "1000000" } }],
    },
  ];
  for (const { name, events } of cases) {
    const worker = await loadWorker();
    const kv = memoryKv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = tronGridStub(events);
    try {
      const created = await worker.fetch(payOrder("month"), environment(kv, { USDT_TRC20_ADDRESS: PAY_WALLET }));
      const order = await created.json();
      const verified = await worker.fetch(
        payVerify(order.orderId, "b".repeat(64)),
        environment(kv, { USDT_TRC20_ADDRESS: PAY_WALLET }),
      );
      assert.equal(verified.status, 400, name);
      const body = await verified.json();
      assert.equal(body.error, "usdt-transfer-not-found", name);
      const record = await kv.get(order.licenseKey, "json");
      assert.equal(record.status, "pending", name);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test("reports an unconfirmed transaction separately from a missing transfer", async () => {
  const worker = await loadWorker();
  const kv = memoryKv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = tronGridStub([]);
  try {
    const created = await worker.fetch(payOrder("year"), environment(kv, { USDT_TRC20_ADDRESS: PAY_WALLET }));
    const order = await created.json();
    assert.equal(order.amountUsdt, 49);
    const verified = await worker.fetch(
      payVerify(order.orderId, "c".repeat(64)),
      environment(kv, { USDT_TRC20_ADDRESS: PAY_WALLET }),
    );
    assert.equal(verified.status, 400);
    assert.equal((await verified.json()).error, "transaction-not-confirmed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a confirmed order cannot be redeemed twice", async () => {
  const worker = await loadWorker();
  const kv = memoryKv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = tronGridStub([{
    event_name: "Transfer",
    contract_address: USDT_CONTRACT_HEX,
    result: { to: PAY_WALLET_HEX, value: "49000000" },
  }]);
  try {
    const created = await worker.fetch(payOrder("year"), environment(kv, { USDT_TRC20_ADDRESS: PAY_WALLET }));
    const order = await created.json();
    const first = await worker.fetch(payVerify(order.orderId, "d".repeat(64)), environment(kv, { USDT_TRC20_ADDRESS: PAY_WALLET }));
    assert.equal(first.status, 200);
    const second = await worker.fetch(payVerify(order.orderId, "d".repeat(64)), environment(kv, { USDT_TRC20_ADDRESS: PAY_WALLET }));
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error, "already-confirmed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Paddle webhook signatures verify the untouched raw request body", async () => {
  const secret = "pdl_ntfset_test_secret";
  const rawBody = JSON.stringify({ event_type: "transaction.completed", data: { id: "txn_123" } });
  const timestamp = Math.floor(Date.now() / 1000);
  const header = await paddleSignature(rawBody, secret, timestamp);
  assert.equal(await verifyPaddleWebhookSignature({ rawBody, signatureHeader: header, secret }), true);
  assert.equal(await verifyPaddleWebhookSignature({ rawBody: `${rawBody} `, signatureHeader: header, secret }), false);
});

test("Paddle checkout order and completed webhook approve the same Pro license", async () => {
  const worker = await loadWorker();
  const kv = memoryKv();
  const secret = "pdl_ntfset_test_secret";
  const env = environment(kv, {
    PADDLE_CLIENT_TOKEN: "test_012345678901234567890123456",
    PADDLE_PRICE_MONTH: "pri_012345678901234567890123",
    PADDLE_PRICE_YEAR: "pri_987654321098765432109876",
    PADDLE_WEBHOOK_SECRET: secret,
  });
  const created = await worker.fetch(paddleOrder("month"), env);
  assert.equal(created.status, 201);
  const order = await created.json();
  assert.equal(order.environment, "sandbox");
  assert.equal(order.priceId, env.PADDLE_PRICE_MONTH);

  const event = JSON.stringify({
    event_type: "transaction.completed",
    data: {
      id: "txn_012345678901234567890123",
      custom_data: { segma_order_id: order.orderId },
      items: [{ price: { id: env.PADDLE_PRICE_MONTH }, quantity: 1 }],
    },
  });
  const webhook = await worker.fetch(new Request(
    "https://aura.mdownloader.workers.dev/api/pay/paddle/webhook",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "paddle-signature": await paddleSignature(event, secret),
      },
      body: event,
    },
  ), env);
  assert.equal(webhook.status, 200);
  assert.equal((await webhook.json()).ok, true);

  const status = await worker.fetch(new Request(
    `https://aura.mdownloader.workers.dev/api/pay/paddle/status?orderId=${order.orderId}`,
  ), env);
  const body = await status.json();
  assert.equal(body.status, "confirmed");
  assert.equal(body.key, order.licenseKey);
  assert.ok(body.expiresAt > Date.now());

  const license = await kv.get(order.licenseKey, "json");
  assert.equal(license.status, "approved");
  assert.equal(license.paymentProvider, "paddle");
});

test("Paddle webhook rejects an unexpected price for a pending order", async () => {
  const worker = await loadWorker();
  const kv = memoryKv();
  const secret = "pdl_ntfset_test_secret";
  const env = environment(kv, {
    PADDLE_CLIENT_TOKEN: "test_012345678901234567890123456",
    PADDLE_PRICE_MONTH: "pri_012345678901234567890123",
    PADDLE_PRICE_YEAR: "pri_987654321098765432109876",
    PADDLE_WEBHOOK_SECRET: secret,
  });
  const order = await (await worker.fetch(paddleOrder("month"), env)).json();
  const event = JSON.stringify({
    event_type: "transaction.completed",
    data: {
      id: "txn_012345678901234567890123",
      custom_data: { segma_order_id: order.orderId },
      items: [{ price: { id: env.PADDLE_PRICE_YEAR }, quantity: 1 }],
    },
  });
  const response = await worker.fetch(new Request(
    "https://aura.mdownloader.workers.dev/api/pay/paddle/webhook",
    {
      method: "POST",
      headers: { "paddle-signature": await paddleSignature(event, secret) },
      body: event,
    },
  ), env);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "unexpected-price");
  assert.equal((await kv.get(order.licenseKey, "json")).status, "pending");
});
