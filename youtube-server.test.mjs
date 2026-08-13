import test from "node:test";
import assert from "node:assert/strict";

let moduleCounter = 0;

function serverEnvironment() {
  const local = new Map();
  const session = new Map();
  const fetchCalls = [];
  let fetchHandler = null;
  globalThis.chrome = {
    storage: {
      local: {
        async get(defaults) {
          if (typeof defaults === "string") return { [defaults]: local.get(defaults) };
          return Object.fromEntries(Object.entries(defaults || {}).map(([key, fallback]) => [
            key,
            local.has(key) ? local.get(key) : fallback,
          ]));
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) local.set(key, value);
        },
        async remove(key) {
          local.delete(key);
        },
      },
      session: {
        async get(defaults) {
          if (typeof defaults === "string") return { [defaults]: session.get(defaults) };
          return Object.fromEntries(Object.entries(defaults || {}).map(([key, fallback]) => [
            key,
            session.has(key) ? session.get(key) : fallback,
          ]));
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) session.set(key, value);
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
    local,
    session,
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

const TOKEN_BODY = {
  ok: true,
  token: "tok-1",
  exp: Date.now() + 12 * 60 * 60 * 1000,
  plan: "free",
};

test("defaults to the tailnet server and normalizes configured URLs", async () => {
  const env = serverEnvironment();
  const mod = await import(`./youtube-server.js?test=${++moduleCounter}`);

  assert.equal(await mod.getYouTubeServerUrl(),
    "https://desktop-8n966j0.tail4cbe57.ts.net");
  const saved = await mod.setYouTubeServerUrl("https://example.com:9000/");
  assert.deepEqual(saved, { ok: true, url: "https://example.com:9000" });
  assert.equal(await mod.getYouTubeServerUrl(), "https://example.com:9000");
  assert.deepEqual(await mod.setYouTubeServerUrl("ftp://bad"), { ok: false, error: "invalid-server-url" });
  assert.equal(env.local.get("auraYouTubeServer"), "https://example.com:9000");
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

test("submitYouTubeJob mints a token and posts it with the job", async () => {
  const env = serverEnvironment();
  env.local.set("auraLicense", { key: "AM-TESTKEY", edition: "pro", status: "approved" });
  env.setFetch((url, options) => {
    if (url === "https://aura.mdownloader.workers.dev/api/youtube-token") {
      const body = JSON.parse(options.body);
      assert.equal(body.deviceId, "00000000-0000-4000-8000-000000000000");
      assert.equal(body.key, "AM-TESTKEY");
      return jsonResponse(TOKEN_BODY);
    }
    assert.equal(url, "http://server.test:8788/api/youtube");
    const body = JSON.parse(options.body);
    assert.equal(body.url, "https://youtube.com/watch?v=abc");
    assert.equal(body.quality, "1080");
    assert.equal(body.deviceId, undefined);
    assert.equal(body.licenseKey, undefined);
    assert.equal(options.headers.get("authorization"), "Bearer tok-1");
    return jsonResponse({ ok: true, jobId: "job-1", status: "queued", quotaUsed: 1, quotaLimit: 10, pro: false }, 202);
  });
  const mod = await import(`./youtube-server.js?test=${++moduleCounter}`);

  const result = await mod.submitYouTubeJob("https://youtube.com/watch?v=abc", "1080", "http://server.test:8788");
  assert.deepEqual(result, { ok: true, jobId: "job-1", pro: false, quotaUsed: 1, quotaLimit: 10 });
});

test("submitYouTubeJob refreshes the token once on 401", async () => {
  const env = serverEnvironment();
  let tokenCalls = 0;
  let serverCalls = 0;
  env.setFetch((url, options) => {
    if (url === "https://aura.mdownloader.workers.dev/api/youtube-token") {
      tokenCalls += 1;
      return jsonResponse({ ...TOKEN_BODY, token: `tok-${tokenCalls}` });
    }
    serverCalls += 1;
    if (serverCalls === 1) return jsonResponse({ error: "unauthorized" }, 401);
    assert.equal(options.headers.get("authorization"), "Bearer tok-2");
    return jsonResponse({ ok: true, jobId: "job-2", status: "queued", quotaUsed: 0, quotaLimit: 10, pro: false }, 202);
  });
  const mod = await import(`./youtube-server.js?test=${++moduleCounter}`);

  const result = await mod.submitYouTubeJob("https://youtube.com/watch?v=abc", "best", "http://server.test:8788");
  assert.equal(result.ok, true);
  assert.equal(result.jobId, "job-2");
  assert.equal(tokenCalls, 2);
  assert.equal(serverCalls, 2);
});

test("submitYouTubeJob reports unauthorized when no token can be minted", async () => {
  const env = serverEnvironment();
  env.setFetch(() => jsonResponse({ ok: false, error: "rate-limited" }, 429));
  const mod = await import(`./youtube-server.js?test=${++moduleCounter}`);

  const result = await mod.submitYouTubeJob("https://youtube.com/watch?v=abc", "best", "http://server.test:8788");
  assert.deepEqual(result, { ok: false, error: "server-unauthorized" });
});

test("submitYouTubeJob surfaces the monthly quota error", async () => {
  const env = serverEnvironment();
  env.setFetch((url) => {
    if (url === "https://aura.mdownloader.workers.dev/api/youtube-token") return jsonResponse(TOKEN_BODY);
    return jsonResponse({ error: "monthly-limit-reached", used: 10, limit: 10 }, 429);
  });
  const mod = await import(`./youtube-server.js?test=${++moduleCounter}`);

  const result = await mod.submitYouTubeJob("https://youtube.com/watch?v=abc", "best", "http://server.test:8788");
  assert.equal(result.ok, false);
  assert.equal(result.error, "monthly-limit-reached");
  assert.equal(result.limit, 10);
});

test("waitForYouTubeJob polls with the bearer token until ready", async () => {
  const env = serverEnvironment();
  let calls = 0;
  env.setFetch((url, options) => {
    if (url === "https://aura.mdownloader.workers.dev/api/youtube-token") return jsonResponse(TOKEN_BODY);
    calls += 1;
    assert.equal(options.headers.get("authorization"), "Bearer tok-1");
    if (calls === 1) return jsonResponse({ id: "job-1", status: "queued" });
    return jsonResponse({ id: "job-1", status: "ready", title: "Test Video" });
  });
  const mod = await import(`./youtube-server.js?test=${++moduleCounter}`);

  const ready = await mod.waitForYouTubeJob("job-1", "http://server.test:8788", { pollMs: 1, timeoutMs: 2000 });
  assert.deepEqual(ready, { ok: true, jobId: "job-1", title: "Test Video", localFile: null });

  env.setFetch((url) => {
    if (url === "https://aura.mdownloader.workers.dev/api/youtube-token") return jsonResponse(TOKEN_BODY);
    return jsonResponse({ id: "job-1", status: "failed", error: "video-unavailable" });
  });
  const failed = await mod.waitForYouTubeJob("job-1", "http://server.test:8788", { pollMs: 1, timeoutMs: 2000 });
  assert.deepEqual(failed, { ok: false, error: "video-unavailable" });
});

test("youtubeJobFileUrl appends the capability token", async () => {
  const env = serverEnvironment();
  env.setFetch(() => jsonResponse(TOKEN_BODY));
  const mod = await import(`./youtube-server.js?test=${++moduleCounter}`);

  const fileUrl = await mod.youtubeJobFileUrl("job-1", "http://server.test:8788");
  assert.equal(fileUrl, "http://server.test:8788/api/jobs/job-1/file?t=tok-1");
});

test("listYouTubeQualities fetches and caches available heights", async () => {
  const env = serverEnvironment();
  let formatsCalls = 0;
  env.setFetch((url, options) => {
    if (url === "https://aura.mdownloader.workers.dev/api/youtube-token") return jsonResponse(TOKEN_BODY);
    assert.equal(url, "http://server.test:8788/api/youtube-formats");
    formatsCalls += 1;
    const body = JSON.parse(options.body);
    assert.equal(body.url, "https://youtube.com/watch?v=abc");
    return jsonResponse({ ok: true, qualities: [2160, 1440, 1080, 720, 480] });
  });
  const mod = await import(`./youtube-server.js?test=${++moduleCounter}`);

  const first = await mod.listYouTubeQualities("https://youtube.com/watch?v=abc", "http://server.test:8788");
  assert.deepEqual(first, { ok: true, qualities: [2160, 1440, 1080, 720, 480] });
  const second = await mod.listYouTubeQualities("https://youtube.com/watch?v=abc", "http://server.test:8788");
  assert.equal(second.cached, true);
  assert.deepEqual(second.qualities, [2160, 1440, 1080, 720, 480]);
  assert.equal(formatsCalls, 1);
});

test("listYouTubeQualities falls back when the server cannot list formats", async () => {
  const env = serverEnvironment();
  env.setFetch((url) => {
    if (url === "https://aura.mdownloader.workers.dev/api/youtube-token") return jsonResponse(TOKEN_BODY);
    return jsonResponse({ ok: false, error: "formats-unavailable" }, 502);
  });
  const mod = await import(`./youtube-server.js?test=${++moduleCounter}`);

  const result = await mod.listYouTubeQualities("https://youtu.be/abc", "http://server.test:8788");
  assert.equal(result.ok, false);
  assert.equal(result.error, "formats-unavailable");
});
