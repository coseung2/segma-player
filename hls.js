import { aesCbcDecrypt } from "./aes-cbc.js";

function splitAttributeList(value) {
  const result = {};
  let start = 0;
  let quoted = false;
  const parts = [];
  for (let index = 0; index <= value.length; index += 1) {
    const char = value[index];
    if (char === '"') quoted = !quoted;
    if ((char === "," && !quoted) || index === value.length) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim().toUpperCase();
    const raw = part.slice(separator + 1).trim();
    result[key] = raw.replace(/^"|"$/g, "");
  }
  return result;
}

function absoluteUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return null;
  }
}

function parseResolution(value) {
  const match = /^(\d+)x(\d+)$/i.exec(value || "");
  return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 0, height: 0 };
}

function parseHexIv(value) {
  const match = /^0x([0-9a-f]{32})$/i.exec(String(value || "").trim());
  if (!match) return null;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(match[1].slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function parseHlsPlaylist(text, baseUrl) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const variants = [];
  const segments = [];
  const keys = [];
  let pendingVariant = null;
  let initUrl = null;
  let encrypted = false;
  let byterange = false;
  let mediaSequence = 0;
  let currentKeyIndex = null;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pendingVariant = splitAttributeList(line.slice("#EXT-X-STREAM-INF:".length));
      continue;
    }
    if (pendingVariant && !line.startsWith("#")) {
      const resolution = parseResolution(pendingVariant.RESOLUTION);
      const uri = absoluteUrl(line, baseUrl);
      if (uri) variants.push({
        uri,
        bandwidth: Number(pendingVariant.BANDWIDTH || 0),
        width: resolution.width,
        height: resolution.height,
      });
      pendingVariant = null;
      continue;
    }
    if (line.startsWith("#EXT-X-KEY:")) {
      const attributes = splitAttributeList(line.slice("#EXT-X-KEY:".length));
      const method = String(attributes.METHOD || "").toUpperCase();
      if (method && method !== "NONE") {
        encrypted = true;
        currentKeyIndex = keys.length;
        keys.push({
          method,
          uri: absoluteUrl(attributes.URI, baseUrl),
          iv: parseHexIv(attributes.IV),
          startIndex: segments.length,
        });
      } else {
        currentKeyIndex = null;
      }
      continue;
    }
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const value = Number(line.slice("#EXT-X-MEDIA-SEQUENCE:".length).trim());
      if (Number.isInteger(value) && value >= 0) mediaSequence = value;
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      const uri = splitAttributeList(line.slice("#EXT-X-MAP:".length)).URI;
      initUrl = absoluteUrl(uri, baseUrl);
      continue;
    }
    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      byterange = true;
      continue;
    }
    if (!line.startsWith("#")) {
      const uri = absoluteUrl(line, baseUrl);
      if (uri) segments.push(uri);
    }
  }

  return { variants, segments, initUrl, encrypted, byterange, mediaSequence, keys };
}

export function isHlsPlaylist(text, contentType = "") {
  const trimmed = String(text || "").replace(/^\uFEFF/, "").trimStart();
  if (/^#EXTM3U/.test(trimmed)) return true;
  if (trimmed.includes("#EXT-X-")) return true;
  return /mpegurl|vnd\.apple\.mpegurl/i.test(String(contentType || ""));
}

export function chooseHlsVariant(variants) {
  return [...variants].sort((left, right) => {
    const leftScore = left.bandwidth || left.width * left.height;
    const rightScore = right.bandwidth || right.width * right.height;
    return rightScore - leftScore;
  })[0] || null;
}

export function hlsFileExtension(initUrl, segments) {
  if (initUrl || segments.some((url) => /\.(?:m4s|mp4)(?:$|[?#])/i.test(url))) return "mp4";
  return "ts";
}

export function activeKeyForSegment(keys, index) {
  let active = null;
  for (const key of keys) {
    if (key.startIndex <= index) active = key;
    else break;
  }
  return active;
}

export function ivForSegment(key, mediaSequence = 0, index = 0) {
  if (key?.iv) return key.iv;
  let value = BigInt(Number.isFinite(mediaSequence) ? Math.max(0, Math.floor(mediaSequence)) : 0)
    + BigInt(Math.max(0, Math.floor(index)));
  const iv = new Uint8Array(16);
  for (let position = 15; position >= 0; position -= 1) {
    iv[position] = Number(value & 0xffn);
    value >>= 8n;
  }
  return iv;
}

export async function decryptSegment(data, keyBytes, iv, importedKey = null) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength === 0 || bytes.byteLength % 16 !== 0) {
    throw new Error("암호화 세그먼트 길이가 올바르지 않습니다.");
  }
  if (!globalThis.crypto?.subtle) throw new Error("복호화 기능을 사용할 수 없습니다.");
  const algorithm = { name: "AES-CBC", iv };
  const key = importedKey || await globalThis.crypto.subtle.importKey(
    "raw",
    keyBytes,
    "AES-CBC",
    false,
    ["decrypt"],
  );
  try {
    return new Uint8Array(await globalThis.crypto.subtle.decrypt(algorithm, key, bytes));
  } catch {
    // Some encoders omit the final PKCS#7 padding block; WebCrypto rejects
    // those segments. Fall back to a pure-JS CBC decrypt that does not enforce
    // padding, and keep the decrypted bytes exactly as they are.
    try {
      return aesCbcDecrypt(bytes, keyBytes, iv);
    } catch {
      throw new Error("세그먼트 복호화에 실패했습니다 (키나 암호화 방식을 확인해 주세요).");
    }
  }
}
