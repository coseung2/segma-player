const CLIENT_TOKEN_RE = /^(test|live)_[A-Za-z0-9_-]{20,}$/;
const PRICE_ID_RE = /^pri_[A-Za-z0-9]{20,}$/;

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function paddleCheckoutConfig(env, period) {
  const clientToken = String(env?.PADDLE_CLIENT_TOKEN || "").trim();
  const priceId = String(
    period === "year" ? env?.PADDLE_PRICE_YEAR : env?.PADDLE_PRICE_MONTH,
  ).trim();
  if (!CLIENT_TOKEN_RE.test(clientToken) || !PRICE_ID_RE.test(priceId)) return null;
  return {
    clientToken,
    priceId,
    environment: clientToken.startsWith("test_") ? "sandbox" : "production",
  };
}

export function paddleTransactionMatchesPrice(transaction, expectedPriceId) {
  const items = Array.isArray(transaction?.items) ? transaction.items : [];
  if (items.length !== 1) return false;
  const item = items[0];
  return item?.price?.id === expectedPriceId && Number(item?.quantity) === 1;
}

export async function verifyPaddleWebhookSignature({
  rawBody,
  signatureHeader,
  secret,
  nowMs = Date.now(),
  toleranceSeconds = 300,
}) {
  if (typeof rawBody !== "string" || typeof signatureHeader !== "string" || typeof secret !== "string" || !secret) {
    return false;
  }

  let timestamp = null;
  const signatures = [];
  for (const part of signatureHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "ts" && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === "h1" && /^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || !signatures.length) return false;

  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}:${rawBody}`),
  );
  const expected = hex(new Uint8Array(digest));
  return signatures.some((signature) => constantTimeEqual(signature, expected));
}
