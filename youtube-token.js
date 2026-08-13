// HMAC-SHA256 capability tokens shared by the license worker (issuer) and
// the notebook YouTube server (verifier). The token binds a device id and a
// plan, so the server never trusts client-supplied identity or quota state.
// Works in Cloudflare Workers (nodejs_compat) and Node >= 18.

export const TOKEN_VERSION = 1;
export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_INDEX = new Map([...B64].map((ch, index) => [ch, index]));

export function isValidDeviceId(value) {
  return typeof value === "string" && /^[A-Za-z0-9-]{8,64}$/.test(value);
}

function b64urlEncode(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "";
    out += i + 2 < bytes.length ? B64[c & 63] : "";
  }
  return out;
}

function b64urlDecode(value) {
  const bytes = [];
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "=") break;
    const index = B64_INDEX.get(ch);
    if (index === undefined) throw new Error("invalid-base64url");
    bytes.push(index);
  }
  const out = new Uint8Array(Math.floor((bytes.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let wrote = 0;
  for (const six of bytes) {
    acc = (acc << 6) | six;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[wrote] = (acc >> bits) & 0xff;
      wrote += 1;
    }
  }
  return out;
}

async function hmacSha256(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, data);
  return new Uint8Array(signature);
}

function timingSafeEqualBytes(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

export async function signToken(secret, payload) {
  if (typeof secret !== "string" || secret.length < 16) throw new Error("missing-secret");
  const body = JSON.stringify({ v: TOKEN_VERSION, ...payload });
  const encoded = b64urlEncode(encoder.encode(body));
  const signature = await hmacSha256(secret, encoder.encode(encoded));
  return `${encoded}.${b64urlEncode(signature)}`;
}

export async function verifyToken(secret, token, { now = Date.now() } = {}) {
  if (typeof secret !== "string" || !secret || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  let payload = null;
  try {
    payload = JSON.parse(decoder.decode(b64urlDecode(parts[0])));
  } catch {
    return null;
  }
  if (!payload || payload.v !== TOKEN_VERSION) return null;
  let provided = null;
  try {
    provided = b64urlDecode(parts[1]);
  } catch {
    return null;
  }
  const expected = await hmacSha256(secret, encoder.encode(parts[0]));
  if (!timingSafeEqualBytes(expected, provided)) return null;
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  if (!isValidDeviceId(payload.deviceId)) return null;
  if (payload.plan !== "free" && payload.plan !== "pro") return null;
  return payload;
}
