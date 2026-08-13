import test from "node:test";
import assert from "node:assert/strict";

let moduleCounter = 0;

function serverEnvironment() {
  const storage = new Map();
  const fetchCalls = [];
  let fetchHandler = null;
  globalThis.chrome = {
    storage: {
      local: {
        async get(defaults) {
          if (typeof defaults === "string") return { [defaults]: storage.get(defaults) };
          return Object.fromEntries(Object.entries(defaults || {}).map(([key, fallback]) => [
            key,
            storage.has(key) ? storage.get(key) : fallback,
          ]));
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) storage.set(key, value);
        },
        async remove(key) {
          storage.delete(key);
        },
      },
    },
  };
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (!fetchHandler) throw new Error(`unexpected fetch: ${url}`);
    return fetchHandler(String(url), options);
  };
  globalThis.crypto.randomUUID = () => "00000000-0000-4000-8000-000000000000";
  return {
    storage,
    fetchCalls,
    setFetch(handler) {
      fetchHandler = handler;
    },
  };
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

test("defaults to the tailnet server and normalizes configured URLs", async () => {
  const env = serverEnvironment();
  const mod = await import(`./youtube-server.js?test=${++moduleCounter}`);

  assert.equal(await mod.getYouTubeServerUrl(),
    "https://desktop-8n966j0.tail4cbe57.ts.net");
  const saved = await mod.setYouTubeServerUrl("https://example.com:9000/");
  assert.deepEqual(saved, { ok: true, url: "https://example.com:9000" });
  assert.equal(await mod.getYouTubeServerUrl(), "https://example.com:9000");
  assert.deepEqual(await mod.setYouTubeServerUrl("ftp://bad"), { ok: false, error: "invalid-server-url" });
  assert.equal(env.storage.get("auraYouTubeServer"), "https://example.com:9000");
});

test("checkYouTubeServer reports health and unreachable states", async () => {
  const env = serverEnvironment();
  env.setFetch(() => jsonResponse({ ok: true, service: "aura-youtube", active: 1, queued: 2 }));
  const mod = await import(`./youtube-server.js?test=${++moduleCounter}`);

  const healthy = await mod.checkYouTubeServer("http://example.test:8788");
  assert.equal(healthy.ok, true);
  assert.equal(healthy.service, "aura-youtube");
  assert.equal(healthy.active, 1);

  env.setFetch(() => { throw new Error("offline"); });
  assert.deepEqual(await mod.checkYouTubeServer("http://example.test:8788"), {
    ok: false,
    error: "unreachable",
  });
});

test("submitYouTubeJob posts device id and license key and parses quota", async () => {
  const env = serverEnvironment();
  env.storage.set("auraLicense", { key: "AM-TESTKEY", edition: "pro", status: "approved" });
  env.setFetch((url, options) => {
    assert.equal(url, "http://server.test:8788/api/youtube");
    const body = JSON.parse(options.body);
    assert.equal(body.url, "https://youtube.com/watch?v=abc");
    assert.equal(body.quality, "1080");
    assert.equal(body.deviceId, "00000000-0000-4000-8000-000000000000");
    assert.equal(body.licenseKey, "AM-TESTKEY");
    return jsonResponse({ ok: true, jobId: "job-1", status: "queued", quotaUsed: 1, quotaLimit: 10, pro: false }, 202);
  });
  const mod = await import(`./youtube-server.js?test=${++moduleCounter}`);

  const result = await mod.submitYouTubeJob("https://youtube.com/watch?v=abc", "1080", "http://server.test:8788");
  assert.deepEqual(result, { ok: true, jobId: "job-1", pro: false, quotaUsed: 1, quotaLimit: 10 });
});

test("submitYouTubeJob surfaces the monthly quota error", async () => {
  const env = serverEnvironment();
  env.setFetch(() => jsonResponse({ error: "monthly-limit-reached", used: 10, limit: 10 }, 429));
  const mod = await import(`./youtube-server.js?test=${++moduleCounter}`);

  const result = await mod.submitYouTubeJob("https://youtube.com/watch?v=abc", "best", "http://server.test:8788");
  assert.equal(result.ok, false);
  assert.equal(result.error, "monthly-limit-reached");
  assert.equal(result.limit, 10);
});

test("waitForYouTubeJob polls until ready and reports failures", async () => {
  const env = serverEnvironment();
  let calls = 0;
  env.setFetch(() => {
    calls += 1;
    if (calls === 1) return jsonResponse({ id: "job-1", status: "queued" });
    return jsonResponse({ id: "job-1", status: "ready", title: "Test Video" });
  });
  const mod = await import(`./youtube-server.js?test=${++moduleCounter}`);

  const ready = await mod.waitForYouTubeJob("job-1", "http://server.test:8788", { pollMs: 1, timeoutMs: 2000 });
  assert.deepEqual(ready, { ok: true, jobId: "job-1", title: "Test Video" });

  env.setFetch(() => jsonResponse({ id: "job-1", status: "failed", error: "video-unavailable" }));
  const failed = await mod.waitForYouTubeJob("job-1", "http://server.test:8788", { pollMs: 1, timeoutMs: 2000 });
  assert.deepEqual(failed, { ok: false, error: "video-unavailable" });
});

test("youtubeJobFileUrl points at the transient file endpoint", () => {
  return import(`./youtube-server.js?test=${++moduleCounter}`).then((mod) => {
    assert.equal(
      mod.youtubeJobFileUrl("job-1", "http://server.test:8788"),
      "http://server.test:8788/api/jobs/job-1/file",
    );
  });
});
