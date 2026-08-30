import test from "node:test";
import assert from "node:assert/strict";

let moduleCounter = 0;

function licenseEnvironment() {
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
      },
    },
  };
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), options });
    if (!fetchHandler) throw new Error(`unexpected fetch: ${url}`);
    return fetchHandler(String(url));
  };
  globalThis.AbortController = class AbortController {
    constructor() {
      this.signal = { aborted: false };
    }
    abort() {
      this.signal.aborted = true;
    }
  };

  return {
    storage,
    fetchCalls,
    setFetch(handler) {
      fetchHandler = handler;
    },
  };
}

const delay = () => new Promise((resolve) => setTimeout(resolve, 0));

test("activateLicense stores an approved key and resolvePlan switches to Pro", async () => {
  const env = licenseEnvironment();
  env.setFetch(() => new Response(JSON.stringify({
    ok: true,
    edition: "pro",
    status: "approved",
    approvedAt: "2026-08-13T00:00:00.000Z",
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const mod = await import(`./license.js?test=${++moduleCounter}`);

  const result = await mod.activateLicense("am-abcdef0123456789");
  assert.deepEqual(result, { ok: true, edition: "pro", status: "approved" });
  await delay();
  assert.equal(env.storage.get("auraLicense").edition, "pro");
  assert.equal(await mod.resolveEdition(), "pro");
  assert.equal((await mod.resolvePlan()).maxConcurrentMediaJobs, null);
});

test("pending keys are reported without storing Pro", async () => {
  const env = licenseEnvironment();
  env.setFetch(() => new Response(JSON.stringify({ ok: true, edition: "free", status: "pending" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  const mod = await import(`./license.js?test=${++moduleCounter}`);

  const result = await mod.activateLicense("am-abcdef0123456789");
  assert.equal(result.ok, false);
  assert.equal(result.error, "license-pending");
  await delay();
  assert.equal(env.storage.has("auraLicense"), false);
  assert.equal(await mod.resolveEdition(), (await import("../../edition.js")).PRODUCT_EDITION);
});

test("invalid keys and unreachable servers fail closed to the packaged edition", async () => {
  const env = licenseEnvironment();
  env.setFetch(() => new Response("", { status: 503 }));
  const mod = await import(`./license.js?test=${++moduleCounter}`);

  assert.equal((await mod.activateLicense("!!")).error, "invalid-key");
  const unreachable = await mod.activateLicense("am-abcdef0123456789");
  assert.equal(unreachable.error, "license-server-unreachable");
  await delay();
  assert.equal(await mod.resolveEdition(), (await import("../../edition.js")).PRODUCT_EDITION);
});

test("refreshLicense keeps Pro only while the server still approves the key", async () => {
  const env = licenseEnvironment();
  env.storage.set("auraLicense", { key: "AM-ABCDEF0123456789ABCDEF0123456789", edition: "pro", status: "approved" });
  env.setFetch(() => new Response(JSON.stringify({ ok: true, edition: "pro", status: "approved" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  const mod = await import(`./license.js?test=${++moduleCounter}`);

  assert.equal((await mod.refreshLicense())?.key, "AM-ABCDEF0123456789ABCDEF0123456789");
  assert.equal(await mod.resolveEdition(), "pro");
  assert.equal(env.fetchCalls.length, 1);
});
