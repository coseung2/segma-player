import { signToken, isValidDeviceId, TOKEN_TTL_MS } from "./youtube-token.js";
import { coversExpectedAmount, sameTronAddress } from "./tron-address.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization, x-aura-audio-upload, x-aura-audio-bytes, x-aura-audio-source, x-aura-source-language, x-aura-title",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    },
  });
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = new Uint8Array(a.length);
  const right = new Uint8Array(b.length);
  for (let index = 0; index < a.length; index += 1) left[index] = a.charCodeAt(index) & 0xff;
  for (let index = 0; index < b.length; index += 1) right[index] = b.charCodeAt(index) & 0xff;
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}

function isValidLicenseKey(value) {
  return typeof value === "string" && /^AM-[0-9A-F]{36}$/.test(value);
}

const MAX_LICENSE_DEVICES = 3;

const PLAN_PERIODS = Object.freeze({
  month: { amountUsdt: 5.99, durationMs: 30 * 24 * 60 * 60 * 1000 },
  year: { amountUsdt: 49, durationMs: 365 * 24 * 60 * 60 * 1000 },
});

const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

function issueLicenseKey() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `AM-${hex.toUpperCase()}`;
}

// Per-IP token issuance throttle. The Map is per-isolate, which is enough to
// slow down free-tier scraping without keeping durable state.
const tokenRequestsByIp = new Map();

function tokenRateLimited(request, limit = 30, windowMs = 60 * 60 * 1000) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const now = Date.now();
  const list = (tokenRequestsByIp.get(ip) || []).filter((stamp) => now - stamp < windowMs);
  if (list.length >= limit) {
    tokenRequestsByIp.set(ip, list);
    return true;
  }
  list.push(now);
  tokenRequestsByIp.set(ip, list);
  return false;
}

function authorized(request, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(token, expected);
}

async function readRecord(env, key) {
  try {
    return await env.LICENSES.get(key, "json");
  } catch {
    return null;
  }
}

async function writeRecord(env, key, record) {
  await env.LICENSES.put(key, JSON.stringify(record));
}

function licenseExpired(record) {
  return typeof record?.expiresAt === "number"
    && record.expiresAt > 0
    && Date.now() > record.expiresAt;
}

const asrRequestsByIp = new Map();
const MAX_ASR_AUDIO_BYTES = 80 * 1024 * 1024;

function asrRateLimited(request, limit = 12, windowMs = 60 * 60 * 1000) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const now = Date.now();
  const list = (asrRequestsByIp.get(ip) || []).filter((stamp) => now - stamp < windowMs);
  if (list.length >= limit) {
    asrRequestsByIp.set(ip, list);
    return true;
  }
  list.push(now);
  asrRequestsByIp.set(ip, list);
  return false;
}

function isSafeAsrUrl(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) return false;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    if (parsed.username || parsed.password || parsed.hash) return false;
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")
      || hostname === "::1" || hostname === "0.0.0.0" || hostname.startsWith("127.")
      || hostname.startsWith("10.") || hostname.startsWith("192.168.")
      || /^172\.(?:1[6-9]|2\d|3[0-1])\./.test(hostname)
      || hostname.startsWith("169.254.") || hostname.startsWith("fc")
      || hostname.startsWith("fd") || hostname.startsWith("fe80:")) return false;
    return true;
  } catch {
    return false;
  }
}

async function approvedAsrLicense(env, value) {
  const key = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!isValidLicenseKey(key)) return null;
  const record = await readRecord(env, key);
  if (!record || record.status !== "approved" || licenseExpired(record)) return null;
  return key;
}

function modalAsrUrl(env, path) {
  if (typeof env.MODAL_ASR_URL !== "string" || !isSafeAsrUrl(env.MODAL_ASR_URL)) return null;
  return `${env.MODAL_ASR_URL.replace(/\/+$/, "")}${path}`;
}

async function forwardModalJson(response) {
  const text = await response.text().catch(() => "");
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object") {
    return json({ ok: false, error: response.ok ? "invalid-modal-response" : "modal-request-failed" }, response.ok ? 502 : response.status);
  }
  return json(body, response.status);
}

async function verifyTrc20(txHash, walletAddress, expectedAmount, apiKey) {
  try {
    const headers = apiKey ? { "TRON-PRO-API-KEY": apiKey } : {};
    const response = await fetch(
      `https://api.trongrid.io/v1/transactions/${encodeURIComponent(txHash)}/events`,
      { headers },
    );
    if (!response.ok) return { verified: false, error: `trongrid-http-${response.status}` };
    const data = await response.json();
    const events = Array.isArray(data?.data) ? data.data : [];
    if (!events.length) return { verified: false, error: "transaction-not-confirmed" };
    for (const event of events) {
      if (event.event_name !== "Transfer") continue;
      // TronGrid reports addresses as 41-prefixed hex while the configured
      // wallet is base58, so both sides are normalized before comparison.
      if (!sameTronAddress(event.contract_address, USDT_TRC20_CONTRACT)) continue;
      if (!sameTronAddress(event.result?.to, walletAddress)) continue;
      if (coversExpectedAmount(event.result?.value, expectedAmount)) return { verified: true };
    }
    return { verified: false, error: "usdt-transfer-not-found" };
  } catch (error) {
    return { verified: false, error: error?.message || "verification-failed" };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/subtitles" && request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type, authorization, x-aura-audio-upload, x-aura-audio-bytes, x-aura-audio-source, x-aura-source-language, x-aura-title",
          "access-control-allow-methods": "GET, POST, OPTIONS",
        },
      });
    }

    if (path === "/api/subtitles" && request.method === "POST") {
      if (!env.MODAL_ASR_TOKEN) return json({ ok: false, error: "asr-not-configured" }, 503);
      if (asrRateLimited(request)) return json({ ok: false, error: "rate-limited" }, 429);
      const audioUpload = request.headers.get("x-aura-audio-upload") === "1";
      if (audioUpload) {
        const authorization = request.headers.get("authorization") || "";
        const licenseKey = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
        const sourceLanguage = (request.headers.get("x-aura-source-language") || "ja").trim().toLowerCase();
        const contentType = (request.headers.get("content-type") || "application/octet-stream")
          .split(";", 1)[0].trim().toLowerCase();
        const claimedBytes = Number(request.headers.get("x-aura-audio-bytes") || 0);
        let title = "";
        try {
          title = decodeURIComponent(request.headers.get("x-aura-title") || "").trim().slice(0, 240);
        } catch {
          return json({ ok: false, error: "invalid-title" }, 400);
        }
        const audioSource = (request.headers.get("x-aura-audio-source") || "browser-audio")
          .replace(/[^a-z0-9._:-]/gi, "")
          .slice(0, 64) || "browser-audio";
        if (!["ja", "en"].includes(sourceLanguage)) {
          return json({ ok: false, error: "invalid-source-language" }, 400);
        }
        if (![
          "application/octet-stream",
          "audio/aac",
          "audio/mp4",
          "audio/mpeg",
          "audio/ogg",
          "video/mp2t",
        ].includes(contentType)) {
          return json({ ok: false, error: "invalid-audio-content-type" }, 415);
        }
        if (!Number.isInteger(claimedBytes) || claimedBytes <= 0) {
          return json({ ok: false, error: "invalid-audio-upload" }, 400);
        }
        if (claimedBytes > MAX_ASR_AUDIO_BYTES) {
          return json({ ok: false, error: "subtitle-audio-too-large" }, 413);
        }
        if (!request.body) return json({ ok: false, error: "invalid-audio-upload" }, 400);
        if (!await approvedAsrLicense(env, licenseKey)) {
          return json({ ok: false, error: "pro-license-required" }, 403);
        }
        const endpoint = modalAsrUrl(env, "/submit-audio");
        if (!endpoint) return json({ ok: false, error: "asr-not-configured" }, 503);
        try {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": contentType,
              authorization: `Bearer ${env.MODAL_ASR_TOKEN}`,
              "x-aura-title": encodeURIComponent(title),
              "x-aura-source-language": sourceLanguage,
              "x-aura-audio-source": audioSource,
              "x-aura-audio-bytes": String(claimedBytes),
            },
            body: request.body,
          });
          return forwardModalJson(response);
        } catch {
          return json({ ok: false, error: "asr-upstream-unreachable" }, 502);
        }
      }

      const body = await request.json().catch(() => null);
      const mediaUrl = typeof body?.mediaUrl === "string" ? body.mediaUrl.trim() : "";
      const sourceUrl = typeof body?.sourceUrl === "string" ? body.sourceUrl.trim() : "";
      const title = typeof body?.title === "string" ? body.title.trim().slice(0, 240) : "";
      const sourceLanguage = typeof body?.sourceLanguage === "string" ? body.sourceLanguage.trim().toLowerCase() : "ja";
      if (!isSafeAsrUrl(mediaUrl) || (sourceUrl && !isSafeAsrUrl(sourceUrl))) {
        return json({ ok: false, error: "invalid-media-url" }, 400);
      }
      if (!["ja", "en"].includes(sourceLanguage)) {
        return json({ ok: false, error: "invalid-source-language" }, 400);
      }
      if (!await approvedAsrLicense(env, body?.licenseKey)) {
        return json({ ok: false, error: "pro-license-required" }, 403);
      }
      const endpoint = modalAsrUrl(env, "/submit");
      if (!endpoint) return json({ ok: false, error: "asr-not-configured" }, 503);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${env.MODAL_ASR_TOKEN}`,
          },
          body: JSON.stringify({ mediaUrl, sourceUrl, title, sourceLanguage }),
        });
        return forwardModalJson(response);
      } catch {
        return json({ ok: false, error: "asr-upstream-unreachable" }, 502);
      }
    }

    if (path === "/api/subtitles" && request.method === "GET") {
      if (!env.MODAL_ASR_TOKEN) return json({ ok: false, error: "asr-not-configured" }, 503);
      const jobId = url.searchParams.get("id") || "";
      if (!/^[A-Za-z0-9._:-]{1,160}$/.test(jobId)) return json({ ok: false, error: "invalid-job-id" }, 400);
      const endpoint = modalAsrUrl(env, `/result/${encodeURIComponent(jobId)}`);
      if (!endpoint) return json({ ok: false, error: "asr-not-configured" }, 503);
      try {
        const response = await fetch(endpoint, {
          headers: { authorization: `Bearer ${env.MODAL_ASR_TOKEN}` },
        });
        return forwardModalJson(response);
      } catch {
        return json({ ok: false, error: "asr-upstream-unreachable" }, 502);
      }
    }

    if (path === "/api/license" && request.method === "GET") {
      const key = (url.searchParams.get("key") || "").trim().toUpperCase();
      if (!isValidLicenseKey(key)) return json({ ok: false, error: "invalid-key" }, 400);
      const deviceId = (url.searchParams.get("deviceId") || "").trim();
      const record = await readRecord(env, key);
      if (!record) return json({ ok: false, error: "invalid-key" }, 404);
      if (licenseExpired(record)) {
        return json({ ok: true, edition: "free", status: "expired", expiresAt: record.expiresAt });
      }
      if (record.status === "approved") {
        const devices = Array.isArray(record.devices)
          ? record.devices.filter((item) => typeof item === "string")
          : [];
        if (isValidDeviceId(deviceId) && !devices.includes(deviceId)) {
          if (devices.length >= MAX_LICENSE_DEVICES) {
            return json({
              ok: false,
              error: "device-limit-reached",
              devices: devices.length,
              limit: MAX_LICENSE_DEVICES,
            }, 403);
          }
          devices.push(deviceId);
          await writeRecord(env, key, { ...record, devices });
        }
        return json({
          ok: true,
          edition: "pro",
          status: "approved",
          approvedAt: typeof record.approvedAt === "string" ? record.approvedAt : null,
          expiresAt: typeof record.expiresAt === "number" ? record.expiresAt : null,
          devices: devices.length,
          limit: MAX_LICENSE_DEVICES,
        });
      }
      return json({ ok: true, edition: "free", status: "pending" });
    }

    if (path === "/api/youtube-token" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const deviceId = typeof body?.deviceId === "string" ? body.deviceId : "";
      if (!isValidDeviceId(deviceId)) return json({ ok: false, error: "invalid-device-id" }, 400);
      if (!env.YT_SERVER_SECRET) return json({ ok: false, error: "server-not-configured" }, 503);
      if (tokenRateLimited(request)) return json({ ok: false, error: "rate-limited" }, 429);

      const key = typeof body?.key === "string" ? body.key.trim().toUpperCase() : "";
      let plan = "free";
      let keyId = null;
      if (key) {
        if (!isValidLicenseKey(key)) return json({ ok: false, error: "invalid-key" }, 400);
        const record = await readRecord(env, key);
        if (!record || record.status !== "approved" || licenseExpired(record)) {
          return json({ ok: false, error: "license-not-approved" }, 403);
        }
        plan = "pro";
        keyId = key;
      }

      const exp = Date.now() + TOKEN_TTL_MS;
      const token = await signToken(env.YT_SERVER_SECRET, { deviceId, plan, keyId, exp });
      return json({ ok: true, token, exp, plan });
    }

    if (path === "/api/pay/order" && request.method === "POST") {
      const wallet = (env.USDT_TRC20_ADDRESS || "").trim();
      if (!wallet) return json({ ok: false, error: "payment-not-configured" }, 503);
      const body = await request.json().catch(() => null);
      const period = body?.period === "year" ? "year" : "month";
      const plan = PLAN_PERIODS[period];
      const orderId = crypto.randomUUID();
      const key = issueLicenseKey();
      await writeRecord(env, key, {
        status: "pending",
        createdAt: new Date().toISOString(),
        orderId,
        period,
      });
      await writeRecord(env, `order:${orderId}`, {
        key,
        period,
        amountUsdt: plan.amountUsdt,
        status: "pending",
        createdAt: Date.now(),
      });
      return json({
        ok: true,
        orderId,
        licenseKey: key,
        walletAddress: wallet,
        network: "trc20",
        amountUsdt: plan.amountUsdt,
        durationMs: plan.durationMs,
      }, 201);
    }

    if (path === "/api/pay/verify" && request.method === "POST") {
      const wallet = (env.USDT_TRC20_ADDRESS || "").trim();
      if (!wallet) return json({ ok: false, error: "payment-not-configured" }, 503);
      const body = await request.json().catch(() => null);
      const orderId = typeof body?.orderId === "string" ? body.orderId : "";
      const txHash = typeof body?.txHash === "string" ? body.txHash.trim() : "";
      if (!orderId || !txHash) return json({ ok: false, error: "invalid-request" }, 400);
      const order = await readRecord(env, `order:${orderId}`);
      if (!order) return json({ ok: false, error: "order-not-found" }, 404);
      if (order.status === "confirmed") return json({ ok: false, error: "already-confirmed" }, 409);
      const plan = PLAN_PERIODS[order.period] || PLAN_PERIODS.month;
      const result = await verifyTrc20(txHash, wallet, plan.amountUsdt, env.TRONGRID_API_KEY || "");
      if (!result.verified) return json({ ok: false, error: result.error || "verification-failed" }, 400);
      const expiresAt = Date.now() + plan.durationMs;
      const record = await readRecord(env, order.key);
      if (record) {
        await writeRecord(env, order.key, {
          ...record,
          status: "approved",
          approvedAt: new Date().toISOString(),
          expiresAt,
        });
      }
      await writeRecord(env, `order:${orderId}`, {
        ...order,
        status: "confirmed",
        confirmedAt: Date.now(),
        expiresAt,
      });
      return json({ ok: true, key: order.key, period: order.period, expiresAt });
    }

    if (path.startsWith("/api/admin/")) {
      if (!authorized(request, env)) return json({ ok: false, error: "unauthorized" }, 401);

      if (path === "/api/admin/issue" && request.method === "POST") {
        const key = issueLicenseKey();
        await writeRecord(env, key, {
          status: "pending",
          createdAt: new Date().toISOString(),
        });
        return json({ ok: true, key });
      }

      if (path === "/api/admin/approve" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        const key = String(body?.key || "").trim().toUpperCase();
        if (!isValidLicenseKey(key)) return json({ ok: false, error: "invalid-key" }, 400);
        const record = await readRecord(env, key);
        if (!record) return json({ ok: false, error: "invalid-key" }, 404);
        const next = { ...record, status: "approved", approvedAt: new Date().toISOString() };
        await writeRecord(env, key, next);
        return json({ ok: true, status: "approved", approvedAt: next.approvedAt });
      }

      if (path === "/api/admin/keys" && request.method === "GET") {
        const listing = await env.LICENSES.list();
        const keys = [];
        for (const item of listing.keys) {
          const record = await readRecord(env, item.name);
          keys.push({ key: item.name, ...(record || {}) });
        }
        keys.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
        return json({ ok: true, keys });
      }

      return json({ ok: false, error: "not-found" }, 404);
    }

    if (path.startsWith("/api/")) return json({ ok: false, error: "not-found" }, 404);

    if (path === "/downloads/AuraMediaCompanionSetup.exe"
      && (request.method === "GET" || request.method === "HEAD")) {
      const object = await env.COMPANION_BUCKET.get("AuraMediaCompanionSetup.exe");
      if (!object) return json({ ok: false, error: "not-found" }, 404);
      const headers = new Headers();
      headers.set("content-type", "application/x-msdownload");
      headers.set("content-disposition", 'attachment; filename="AuraMediaCompanionSetup.exe"');
      headers.set("content-length", String(object.size));
      headers.set("cache-control", "public, max-age=3600");
      headers.set("accept-ranges", "bytes");
      if (request.method === "HEAD") return new Response(null, { status: 200, headers });
      return new Response(object.body, { status: 200, headers });
    }

    try {
      return await env.ASSETS.fetch(request);
    } catch {
      return json({ ok: false, error: "not-found" }, 404);
    }
  },
};
