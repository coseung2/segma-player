// Resolves player pages into direct media URLs without needing DevTools.

const PLAYER_PATH_RE = /^\/(?:[de])\//i;
const STREAMTAPE_HOST_RE = /(?:^|\.)streamtape\.com$/i;
const STREAMTAPE_PLAYER_PATH_RE = /^\/(?:v|e)(?:\/|$)/i;
const MAX_STREAMTAPE_EXPRESSION_BYTES = 32_768;
const GENERIC_PLAYER_PATH_RE = /(?:^|\/)(?:embed|e|v|player|watch)(?:[-_/]|$)/i;
const GENERIC_PLAYER_ID_RE = /(?:^|\/)(?:embed|player)\/[A-Za-z0-9_-]{4,}(?:\/|$)/i;
const FILEMOON_HOST_RE = /(?:^|\.)(?:filemoon\.(?:sx|to|nl|in|com)|fmoonenc\.com)$/i;
const MIXDROP_HOST_RE = /(?:^|\.)(?:mixdrop\.(?:co|to|ag|sx|my)|mdy48tn97\.com)$/i;
const VOE_HOST_RE = /(?:^|\.)(?:voe\.(?:sx|to)|jilliandescribecompany\.com)$/i;
const FILEMOON_MEDIA_RE = /https?:\/\/[^\s"'<>\\`]+\.(?:m3u8|mp4)(?:\?[^\s"'<>\\`]*)?/i;
const MIXDROP_MDKEY_RE = /\bMDCore\.wurl\s*=\s*(["'])([^"']+)\1/i;
const VOE_HLS_RE = /\b(?:hls|source|file)\s*[:=]\s*(["'])(https?:\/\/[^"']+\.m3u8[^"']*)\1/i;
const VOE_PROMPT_RE = /window\.prompt\s*\(\s*(["'])([^"']+)\1/i;

// Explicit bounds for bounded player-graph traversal, caching, and URL
// validation. Defaults keep the resolver a cheap, deterministic fallback for
// on-demand static player-page resolution.
export const PLAYER_GRAPH_LIMITS = Object.freeze({
  maxBodyBytes: 5_000_000,
  maxNodes: 12,
  maxFrameClues: 64,
  maxRedirectHops: 8,
  maxCacheEntries: 64,
  positiveTtlMs: 60_000,
  negativeTtlMs: 15_000,
  maxUrlBytes: 4096,
  maxQueryBytes: 2048,
  maxBase64ClueBytes: 8192,
});

// Result "type" values. "hls" marks direct HLS playlists discovered by the
// graph resolver; the legacy resolvePlayerPage() wrapper intentionally maps
// every result back to "progressive" to keep its existing contract.
const RESULT_TYPES = Object.freeze({
  PROGRESSIVE: "progressive",
  HLS: "hls",
});

function readStringLiteral(source, start) {
  const quote = source[start];
  if (quote !== "'" && quote !== '"') return null;
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === quote) return { value, next: index + 1 };
    if (character !== "\\") {
      value += character;
      continue;
    }
    const escaped = source[index + 1];
    if (!escaped) return null;
    if (escaped === "n") value += "\n";
    else if (escaped === "r") value += "\r";
    else if (escaped === "t") value += "\t";
    else if (escaped === "b") value += "\b";
    else if (escaped === "f") value += "\f";
    else if (escaped === "v") value += "\v";
    else if (escaped === "x") {
      const hex = source.slice(index + 2, index + 4);
      if (!/^[0-9a-f]{2}$/i.test(hex)) return null;
      value += String.fromCharCode(Number.parseInt(hex, 16));
      index += 2;
    } else if (escaped === "u") {
      const hex = source.slice(index + 2, index + 6);
      if (!/^[0-9a-f]{4}$/i.test(hex)) return null;
      value += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
    } else if (escaped === "\n") {
      // Line continuations do not contribute a character to the literal.
    } else {
      value += escaped;
    }
    index += 1;
  }
  return null;
}

function skipWhitespace(source, start) {
  let index = start;
  while (/\s/.test(source[index] || "")) index += 1;
  return index;
}

function applySubstringChain(source, start, value) {
  let index = start;
  while (true) {
    index = skipWhitespace(source, index);
    const match = /^\.substring\s*\(\s*(\d{1,6})\s*\)/i.exec(source.slice(index));
    if (!match) return { value, next: index };
    value = value.substring(Number(match[1]));
    index += match[0].length;
  }
}

function playerPageReferrer(pageUrl) {
  try {
    const url = new URL(pageUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) return null;
    return url.href;
  } catch {
    return null;
  }
}

function streamtapeGetVideoResult(value, pageUrl) {
  const referrer = playerPageReferrer(pageUrl);
  if (!referrer) return null;
  try {
    const url = new URL(value, referrer);
    const hostname = url.hostname.replace(/\.$/, "").toLowerCase();
    if (!["http:", "https:"].includes(url.protocol) || !STREAMTAPE_HOST_RE.test(hostname)
      || !/^\/get_video(?:\/|$)/i.test(url.pathname) || url.username || url.password || url.hash) return null;
    return { url: url.href, referrer };
  } catch {
    return null;
  }
}

export function parseStreamtapeNorobotlink(body, pageUrl) {
  const source = String(body || "");
  if (!source || source.length > 5_000_000) return null;
  // Streamtape rotates the decoy element name. Older pages used
  // `norobotlink`; the current player writes several candidates to
  // `ideoolink`, `botlink`, and `robotlink`. Every parsed expression still has
  // to resolve to the same-origin `/get_video` endpoint below, so accepting
  // the known element names does not promote arbitrary script text.
  const assignment = /getElementById\s*\(\s*(['"])(?:norobotlink|robotlink|botlink|ideoolink|videolink)\1\s*\)\s*\.\s*innerHTML\s*=/gi;
  let match;
  while ((match = assignment.exec(source))) {
    const expression = source.slice(match.index + match[0].length, match.index + match[0].length + MAX_STREAMTAPE_EXPRESSION_BYTES);
    let index = skipWhitespace(expression, 0);
    const prefix = readStringLiteral(expression, index);
    if (!prefix) continue;
    index = skipWhitespace(expression, prefix.next);
    if (expression[index] !== "+") continue;
    index = skipWhitespace(expression, index + 1);
    if (expression[index] !== "(") continue;
    index = skipWhitespace(expression, index + 1);
    const suffix = readStringLiteral(expression, index);
    if (!suffix) continue;
    index = skipWhitespace(expression, suffix.next);
    if (expression[index] !== ")") continue;
    const transformed = applySubstringChain(expression, index + 1, suffix.value);
    index = skipWhitespace(expression, transformed.next);
    if (expression[index] !== ";") continue;
    const result = streamtapeGetVideoResult(prefix.value + transformed.value, pageUrl);
    if (result) return result;
  }
  return null;
}

export function isStreamtapePlayerPage(url) {
  try {
    const parsed = new URL(url);
    return STREAMTAPE_HOST_RE.test(parsed.hostname) && STREAMTAPE_PLAYER_PATH_RE.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function looksLikePlayerPage(url) {
  try {
    const parsed = new URL(url);
    return isKnownHostedPlayerPage(parsed.href) || PLAYER_PATH_RE.test(parsed.pathname)
      || GENERIC_PLAYER_ID_RE.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function isFilemoonPlayerPage(url) {
  try {
    const parsed = new URL(url);
    return FILEMOON_HOST_RE.test(parsed.hostname) && GENERIC_PLAYER_PATH_RE.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function isMixdropPlayerPage(url) {
  try {
    const parsed = new URL(url);
    return MIXDROP_HOST_RE.test(parsed.hostname) && GENERIC_PLAYER_PATH_RE.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function isVoePlayerPage(url) {
  try {
    const parsed = new URL(url);
    return VOE_HOST_RE.test(parsed.hostname) && GENERIC_PLAYER_PATH_RE.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isKnownHostedPlayerPage(url) {
  return isStreamtapePlayerPage(url) || isFilemoonPlayerPage(url)
    || isMixdropPlayerPage(url) || isVoePlayerPage(url);
}

export function parseDoodResponse(body) {
  const trimmed = String(body || "").trim();
  let candidate = trimmed;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const object = JSON.parse(trimmed);
      candidate = object.f || object.url || object.src || object.file || object.download_url || trimmed;
    } catch {
      // Not JSON; keep the raw text.
    }
  }
  candidate = String(candidate).replace(/^["']|["']$/g, "").trim();
  if (/^https?:\/\//i.test(candidate) && !/\s/.test(candidate)) return candidate;
  return null;
}

const DOOD_NONCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function doodNonce(length = 10) {
  const values = new Uint32Array(length);
  try {
    globalThis.crypto.getRandomValues(values);
  } catch {
    for (let index = 0; index < values.length; index += 1) values[index] = Math.floor(Math.random() * 0x100000000);
  }
  return [...values].map((value) => DOOD_NONCE_ALPHABET[value % DOOD_NONCE_ALPHABET.length]).join("");
}

export function completeDoodDirectUrl(value, pageSource, { nonce = null, now = Date.now } = {}) {
  let direct;
  try {
    direct = new URL(String(value || "").trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(direct.protocol) || direct.searchParams.has("token")) return direct.href;
  const token = /[?&]token=([^&"'\s+]+)/i.exec(String(pageSource || ""))?.[1] || "";
  const leaf = direct.pathname.split("/").pop() || "";
  if (!token || /\.[a-z0-9]{2,5}$/i.test(leaf)) return direct.href;
  direct.pathname += typeof nonce === "string" && nonce ? nonce : doodNonce();
  direct.searchParams.set("token", token);
  direct.searchParams.set("expiry", String(now()));
  return direct.href;
}

// Local mirror of candidate.js's public-URL security contract. candidate.js
// imports isStreamtapePlayerPage from this module, so importing it back here
// would create a cycle; this validator keeps the same properties: public
// http(s) only, no credentials or fragments, default ports only, bounded
// lengths, and no private/loopback/reserved IP literals (IPv4 and IPv6).
function publicIpLiteral(hostname) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    const octets = hostname.split(".").map(Number);
    if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
    const [a, b, c] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0 && c === 0));
  }
  if (hostname.includes(":")) {
    const lower = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const halves = lower.split("::");
    if (halves.length > 2) return false;
    const parseHalf = (half) => half ? half.split(":").map((part) => {
      if (part.includes(".")) {
        const octets = part.split(".").map(Number);
        if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
        return [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      return [Number.parseInt(part, 16)];
    }).flat() : [];
    const left = parseHalf(halves[0]);
    const right = parseHalf(halves[1] || "");
    if (!left || !right || left.includes(null) || right.includes(null)) return false;
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return false;
    const words = [...left, ...Array(Math.max(0, missing)).fill(0), ...right];
    if (words.length !== 8) return false;
    const first = words[0];
    if (words.every((word) => word === 0) || words.slice(0, 7).every((word) => word === 0) && words[7] === 1
      || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
      || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00) return false;
    if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
      return publicIpLiteral(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
    }
    if (words.slice(0, 6).every((word) => word === 0)) {
      return publicIpLiteral(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
    }
    if (words[0] === 0x0064 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0)) {
      return publicIpLiteral(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
    }
    if (words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 0x0001) return false;
    if (words[0] === 0x2002) {
      return publicIpLiteral(`${words[1] >> 8}.${words[1] & 255}.${words[2] >> 8}.${words[2] & 255}`);
    }
    return true;
  }
  return true;
}

export function canonicalPublicHttpUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > PLAYER_GRAPH_LIMITS.maxUrlBytes
    || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) return null;
    if ((url.protocol === "http:" && url.port && url.port !== "80")
      || (url.protocol === "https:" && url.port && url.port !== "443")) return null;
    const host = url.hostname.replace(/\.$/, "").toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
      || !publicIpLiteral(host)) return null;
    if (url.search.length > PLAYER_GRAPH_LIMITS.maxQueryBytes + 1) return null;
    url.hostname = host;
    url.port = "";
    return url;
  } catch {
    return null;
  }
}

// Decoy checks mirror candidate.js's image/preview/segment exclusions so the
// resolver never reports thumbnails, preview clips, or HLS segments as media.
function isImageResourceUrl(url) {
  return /\.(?:avif|gif|jpe?g|png|webp)$/i.test(url.pathname);
}

function isLikelyPreviewResourceUrl(url) {
  const host = url.hostname.toLowerCase();
  const pathname = url.pathname.toLowerCase();
  return /(^|\.)(previews?|thumbs?|thumbnails)\.[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(host)
    || /(^|\/)(previews?|thumbs?|thumbnails|teasers?)(\/|$)/.test(pathname)
    || /[-_.\/](previews?|teasers?)[-_.]/.test(pathname);
}

function isLikelyHlsSegmentUrl(url) {
  return /\.(?:ts|m4s|cmfv|cmfa)$/i.test(url.pathname);
}

function isRejectedMediaUrl(url) {
  return isImageResourceUrl(url) || isLikelyPreviewResourceUrl(url) || isLikelyHlsSegmentUrl(url);
}

// Bounds fetched page text: skip by declared content-length when available,
// then by the actual text length after reading. Returns null for oversized
// bodies so callers treat them like pages without usable evidence.
async function boundedResponseText(response, maxBodyBytes) {
  let declared = Number.NaN;
  try {
    const header = response?.headers?.get?.("content-length");
    if (header) declared = Number.parseInt(header, 10);
  } catch {
    // Malformed or missing headers fall back to the text-length bound.
  }
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    try { await response?.body?.cancel?.(); } catch { /* best-effort cleanup */ }
    return null;
  }

  const reader = response?.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      bytes += chunk.byteLength;
      if (bytes > maxBodyBytes) {
        try { await reader.cancel(); } catch { /* best-effort cleanup */ }
        return null;
      }
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    return text;
  }

  const text = await response.text();
  if (typeof text !== "string" || text.length > maxBodyBytes) return null;
  return new TextEncoder().encode(text).byteLength <= maxBodyBytes ? text : null;
}

async function cancelResponseBody(response) {
  try {
    if (typeof response?.body?.cancel === "function") {
      await response.body.cancel();
      return;
    }
    const reader = response?.body?.getReader?.();
    await reader?.cancel?.();
  } catch {
    // Response cleanup is best effort after the URL and status are known.
  }
}

function abortReason(signal) {
  return signal?.reason || new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

async function fetchPublicResponse(startUrl, {
  ensureRoute,
  fetchImpl,
  signal,
  referrer = startUrl,
  maxRedirectHops,
  getRedirectTarget,
}) {
  let current = canonicalPublicHttpUrl(startUrl);
  let currentReferrer = canonicalPublicHttpUrl(referrer)?.href || current?.href || "";
  if (!current) return null;
  const visited = new Set([current.href]);

  for (let hop = 0; hop <= maxRedirectHops; hop += 1) {
    throwIfAborted(signal);
    let response;
    try {
      if (typeof ensureRoute === "function") await ensureRoute([current.href]);
      throwIfAborted(signal);
      response = await fetchImpl(current.href, {
        credentials: "include",
        // Chrome intentionally hides Location on redirect:"manual" responses.
        // The extension's webRequest observer supplies that Location through
        // getRedirectTarget; other runtimes may expose the header directly.
        // Keeping every hop manual ensures private targets are rejected before
        // the browser makes a request to them.
        redirect: "manual",
        ...(currentReferrer ? { referrer: currentReferrer, referrerPolicy: "unsafe-url" } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch {
      if (signal?.aborted) throw abortReason(signal);
      return null;
    }

    const reportedUrl = typeof response?.url === "string" && response.url
      ? canonicalPublicHttpUrl(response.url)
      : current;
    if (!reportedUrl) {
      await cancelResponseBody(response);
      return null;
    }

    if (response?.redirected || reportedUrl.href !== current.href) {
      await cancelResponseBody(response);
      return null;
    }

    const status = Number(response?.status);
    const redirectResponse = response?.type === "opaqueredirect"
      || (Number.isFinite(status) && status >= 300 && status < 400);
    if (redirectResponse) {
      let location = response?.headers?.get?.("location");
      if ((!location || response?.type === "opaqueredirect") && typeof getRedirectTarget === "function") {
        try { location = await getRedirectTarget(current.href); } catch { location = null; }
      }
      await cancelResponseBody(response);
      if (hop >= maxRedirectHops || typeof location !== "string" || !location) return null;
      let next;
      try {
        next = canonicalPublicHttpUrl(new URL(location, current.href).href);
      } catch {
        return null;
      }
      if (!next || visited.has(next.href)) return null;
      currentReferrer = current.href;
      current = next;
      visited.add(current.href);
      continue;
    }

    if (!response?.ok) {
      await cancelResponseBody(response);
      return null;
    }
    return { response, url: current.href };
  }
  return null;
}

// Awaits a shared promise while honoring the caller's own AbortSignal without
// cancelling the shared traversal for other coalesced callers.
function abortableAwait(promise, signal) {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      rejectPromise(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        rejectPromise(error);
      },
    );
  });
}

// Direct media URL pass: first canonical, non-decoy http(s) match in text
// order. HLS playlists are typed as "hls"; mp4/webm as "progressive".
function directMediaResult(text, pageUrl) {
  const directRe = /https?:\/\/[^\s"'<>\\`]+/gi;
  for (const match of text.matchAll(directRe)) {
    // Raw URLs are often followed by JavaScript or prose punctuation. Trim
    // only characters that cannot be part of the media extension itself;
    // query-string bytes remain intact and are validated below.
    const raw = match[0];
    let candidate = raw;
    const punctuation = /[.,;)\]}]+$/.exec(candidate)?.[0] || "";
    if (punctuation && !(punctuation === ";" && candidate.includes("?"))) {
      candidate = candidate.slice(0, -punctuation.length);
    }
    const result = mediaResultForValue(candidate, pageUrl);
    if (result) return result;
  }

  // Common player configs use protocol-relative or relative values in
  // src/file/url/source fields. Parse only quoted values with a known media
  // extension; never evaluate surrounding JavaScript.
  const fieldRe = /\b(?:src|data-src|file|url|source|playlist)\s*(?:=|:)\s*(["'])([^"']+)\1/gi;
  for (const match of text.matchAll(fieldRe)) {
    const result = mediaResultForValue(match[2], pageUrl);
    if (result) return result;
  }
  return null;
}

function mediaResultForValue(value, pageUrl) {
  let canonical;
  try {
    canonical = canonicalPublicHttpUrl(new URL(value, pageUrl).href);
  } catch {
    return null;
  }
  if (!canonical || isRejectedMediaUrl(canonical)
    || !/\.(?:m3u8|mp4|webm)$/i.test(canonical.pathname)) return null;
  const type = /\.m3u8$/i.test(canonical.pathname) ? RESULT_TYPES.HLS : RESULT_TYPES.PROGRESSIVE;
  return { type, url: canonical.href, referrer: pageUrl };
}

function decodeRadix62(token, radix) {
  let val = 0;
  for (let i = 0; i < token.length; i += 1) {
    const code = token.charCodeAt(i);
    let digit = 0;
    if (code >= 48 && code <= 57) digit = code - 48;
    else if (code >= 97 && code <= 122) digit = code - 97 + 10;
    else if (code >= 65 && code <= 90) digit = code - 65 + 36;
    else return null;
    if (digit >= radix) return null;
    val = val * radix + digit;
  }
  return val;
}

export function unpackPackerScripts(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 2_000_000) return "";
  const pattern = /\be[v]al\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,[^\)]+\)[\s\S]*?\}\s*\(\s*(['"])((?:\\.|[^\\])*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])((?:\\.|[^\\])*?)\5\.split\s*\(\s*['"]\|['"]\s*\)/gi;
  let match;
  const results = [];
  while ((match = pattern.exec(text))) {
    try {
      const payload = match[2]
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
      const radix = Number.parseInt(match[3], 10);
      const count = Number.parseInt(match[4], 10);
      const keywords = match[6].split("|");
      if (!Number.isInteger(radix) || radix < 2 || radix > 62 || !keywords.length) continue;
      const unpacked = payload.replace(/\b[0-9a-zA-Z]+\b/g, (token) => {
        const index = decodeRadix62(token, radix);
        if (index === null || index >= keywords.length) return token;
        const word = keywords[index];
        return word !== "" ? word : token;
      });
      results.push(unpacked);
    } catch {
      // Ignore malformed packer blocks
    }
  }
  return results.join("\n");
}

export function decodeHexEscapedScript(text) {
  if (typeof text !== "string" || !text.includes("\\x")) return "";
  const hexRe = /(?:\\x[0-9a-fA-F]{2}){6,}/g;
  let match;
  const results = [];
  while ((match = hexRe.exec(text))) {
    try {
      const decoded = match[0].replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
        String.fromCharCode(Number.parseInt(hex, 16))
      );
      if (decoded.length <= 4096 && (/^https?:\/\//i.test(decoded) || /\.(?:m3u8|mpd|mp4|m4v|webm)/i.test(decoded))) {
        results.push(decoded);
      }
    } catch {
      // Ignore malformed hex blocks
    }
  }
  return results.join("\n");
}

export function decodeReversedUrls(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 2_000_000) return "";
  const pattern = /(["'])([A-Za-z0-9_.:~%/?&=+\-]{12,2048})\1/g;
  let match;
  const results = [];
  while ((match = pattern.exec(text))) {
    const candidate = match[2];
    if (candidate.includes("://") || candidate.startsWith("http")) continue;
    const reversed = candidate.split("").reverse().join("");
    if (/^https?:\/\/[^\s"'<>\\`]+\.(?:m3u8|mpd|mp4|m4v|webm)(?:\?[^\s"'<>\\`]*)?$/i.test(reversed)
      || (/^https?:\/\/[^\s"'<>\\`]+/i.test(reversed) && /(?:^|[?&])(?:type|format|kind)=(?:hls|m3u8|dash|mpd)\b/i.test(reversed))) {
      results.push(reversed);
    }
  }
  return results.join("\n");
}

export function decodePercentEscapedUrls(text) {
  if (typeof text !== "string" || !text.includes("%")) return "";
  const percentRe = /(?:https?|%[0-9a-fA-F]{2})(?:[A-Za-z0-9._~:/?@!$&()*+,;=%\-]|%[0-9a-fA-F]{2}){5,4090}/g;
  let match;
  const results = [];
  while ((match = percentRe.exec(text))) {
    try {
      let decoded = match[0];
      for (let pass = 0; pass < 2 && decoded.includes("%"); pass += 1) {
        try {
          const next = decodeURIComponent(decoded);
          if (next === decoded) break;
          decoded = next;
        } catch {
          break;
        }
      }
      if (decoded.length <= 4096 && (/^https?:\/\//i.test(decoded) || /\.(?:m3u8|mpd|mp4|m4v|webm)/i.test(decoded))) {
        results.push(decoded);
      }
    } catch {
      // Ignore invalid percent encoding
    }
  }
  return results.join("\n");
}

export function decodeBase64JsonConfigs(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 2_000_000) return "";
  const b64Re = /(?:["']|:\s*)([A-Za-z0-9+/_-]{16,}={0,2})(?:["']|[\s;,}\]]|$)/g;
  let match;
  const results = [];
  while ((match = b64Re.exec(text))) {
    try {
      const rawB64 = match[1];
      if (rawB64.length > 333_336) continue;
      let decoded = "";
      try {
        const normalized = rawB64.replace(/-/g, "+").replace(/_/g, "/");
        if (normalized.length % 4 === 1) continue;
        const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
        decoded = atob(padded).trim();
      } catch {
        continue;
      }
      if ((decoded.startsWith("{") || decoded.startsWith("[")) && decoded.length <= 250_000) {
        results.push(decoded);
      }
    } catch {
      // Ignore invalid base64
    }
  }
  return results.join("\n");
}

export function deobfuscateScriptText(text) {
  if (typeof text !== "string" || !text) return "";
  const unpacked = unpackPackerScripts(text);
  const decodedHex = decodeHexEscapedScript(text);
  const reversed = decodeReversedUrls(text);
  const percent = decodePercentEscapedUrls(text);
  const b64Json = decodeBase64JsonConfigs(text);
  return [unpacked, decodedHex, reversed, percent, b64Json].filter(Boolean).join("\n");
}

function hostedPlayerResult(text, pageUrl) {
  if (isFilemoonPlayerPage(pageUrl)) {
    const match = String(text || "").match(FILEMOON_MEDIA_RE);
    if (match) return mediaResultForValue(match[0], pageUrl);
  }
  if (isMixdropPlayerPage(pageUrl)) {
    const match = MIXDROP_MDKEY_RE.exec(String(text || ""));
    if (match?.[2]) {
      const raw = match[2].startsWith("//") ? `https:${match[2]}` : match[2];
      return mediaResultForValue(raw, pageUrl);
    }
  }
  if (isVoePlayerPage(pageUrl)) {
    const hls = VOE_HLS_RE.exec(String(text || ""));
    if (hls?.[2]) return mediaResultForValue(hls[2], pageUrl);
    const prompt = VOE_PROMPT_RE.exec(String(text || ""));
    if (prompt?.[2] && /\.(?:m3u8|mp4|webm)$/i.test(prompt[2])) {
      return mediaResultForValue(prompt[2], pageUrl);
    }
  }
  return null;
}

// Base64 video_url/video_url_hd player-config clues (same shape content.js
// reads from live player pages), decoded without eval and validated.
function base64VideoUrlResult(text, pageUrl) {
  const videoUrlRe = /\bvideo_url(?:_hd)?\s*:\s*(["'])([A-Za-z0-9+/]{8,}={0,2})\1/g;
  for (const match of text.matchAll(videoUrlRe)) {
    if (match[2].length > PLAYER_GRAPH_LIMITS.maxBase64ClueBytes) continue;
    let decoded;
    try {
      decoded = atob(match[2]).trim();
    } catch {
      continue;
    }
    let canonical;
    try {
      canonical = canonicalPublicHttpUrl(new URL(decoded, pageUrl).href);
    } catch {
      continue;
    }
    if (!canonical || isRejectedMediaUrl(canonical)) continue;
    const type = /\.m3u8$/i.test(canonical.pathname) ? RESULT_TYPES.HLS : RESULT_TYPES.PROGRESSIVE;
    return { type, url: canonical.href, referrer: pageUrl };
  }
  return null;
}

// Dood pass_md5 fallback: fetch the token endpoint and parse its direct URL.
// Authenticated in-frame Dood resolution stays in content.js; this is the
// on-demand static page fallback only.
async function doodPassResult(text, pageUrl, {
  ensureRoute, fetchImpl, signal, maxBodyBytes, maxRedirectHops, getRedirectTarget,
}) {
  const pass = text.match(/["'(\s](\/pass_md5\/[^"')\s]+)["')]/)
    || text.match(/(\/pass_md5\/[^\s"'<>]+)/);
  if (!pass) return null;
  let passUrl;
  try {
    const canonical = canonicalPublicHttpUrl(new URL(pass[1], pageUrl).href);
    if (!canonical) return null;
    passUrl = canonical.href;
  } catch {
    return null;
  }
  try {
    const loaded = await fetchPublicResponse(passUrl, {
      ensureRoute,
      fetchImpl,
      signal,
      referrer: pageUrl,
      maxRedirectHops,
      getRedirectTarget,
    });
    if (!loaded) return null;
    const body = await boundedResponseText(loaded.response, maxBodyBytes);
    if (body === null) return null;
    const direct = completeDoodDirectUrl(parseDoodResponse(body), text);
    if (!direct) return null;
    const canonical = canonicalPublicHttpUrl(direct);
    if (!canonical || isRejectedMediaUrl(canonical)) return null;
    return { type: RESULT_TYPES.PROGRESSIVE, url: canonical.href, referrer: pageUrl };
  } catch {
    if (signal?.aborted) throw abortReason(signal);
    return null;
  }
}

function likelyPlayerFrameUrl(url) {
  return looksLikePlayerPage(url.href)
    || GENERIC_PLAYER_PATH_RE.test(url.pathname);
}

// Follow actual iframe/embed sources regardless of provider-specific path.
// Known player-shaped URLs are enqueued first so a bounded walk does not spend
// its node budget on unrelated widgets that appear earlier in the document.
function frameClueUrls(text, pageUrl, maxFrameClues) {
  const preferred = [];
  const fallback = [];
  const seen = new Set();
  const add = (rawValue) => {
    let canonical;
    try {
      canonical = canonicalPublicHttpUrl(new URL(rawValue, pageUrl).href);
    } catch {
      return;
    }
    if (!canonical || seen.has(canonical.href)) return;
    const target = likelyPlayerFrameUrl(canonical) ? preferred : fallback;
    if (target.length >= maxFrameClues) return;
    seen.add(canonical.href);
    target.push(canonical.href);
  };

  const tagRe = /<(?:iframe|embed)\b[^>]*>/gi;
  let tag;
  while ((tag = tagRe.exec(text))) {
    const attribute = /\b(?:src|data-src)\s*=\s*(["'])([^"']+)\1/i.exec(tag[0]);
    if (attribute) add(attribute[2]);
  }

  // Keep compatibility with player links/config attributes that are not on an
  // iframe element, while still requiring a recognizable /d/ or /e/ path.
  const legacyRe = /(?:src|data-src|href)\s*=\s*["']([^"']*\/[de]\/[A-Za-z0-9_-]+(?:[^"']*))["']/gi;
  let legacy;
  while ((legacy = legacyRe.exec(text))) add(legacy[1]);
  return [...preferred, ...fallback].slice(0, maxFrameClues);
}

/**
 * Creates a bounded, deterministic player-graph resolver.
 *
 * resolve() walks nested player pages in BFS order with fixed evidence passes
 * per page: Streamtape norobotlink, Dood pass_md5, direct media URL, base64
 * video_url clue, then node expansion (/d/ to /e/ twin plus frame clues).
 * Results are typed ({ type: "progressive" } or { type: "hls" }) and carry the
 * referrer page. Concurrent resolves of the same canonical URL share one
 * traversal; positive and negative results are cached with short TTLs, and
 * positive cache hits recheck the route. Passing an AbortSignal stops the
 * traversal (aborted results are never cached). Fetch and parse behavior is
 * fully deterministic: no eval, no remote rules, no API/model calls.
 */
export function createPlayerGraphResolver({
  fetchImpl = globalThis.fetch,
  ensureRoute = null,
  getRedirectTarget = null,
  now = () => Date.now(),
  positiveTtlMs = PLAYER_GRAPH_LIMITS.positiveTtlMs,
  negativeTtlMs = PLAYER_GRAPH_LIMITS.negativeTtlMs,
  maxNodes = PLAYER_GRAPH_LIMITS.maxNodes,
  maxFrameClues = PLAYER_GRAPH_LIMITS.maxFrameClues,
  maxRedirectHops = PLAYER_GRAPH_LIMITS.maxRedirectHops,
  maxBodyBytes = PLAYER_GRAPH_LIMITS.maxBodyBytes,
  maxCacheEntries = PLAYER_GRAPH_LIMITS.maxCacheEntries,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (ensureRoute !== null && typeof ensureRoute !== "function") throw new TypeError("ensureRoute must be a function");
  if (getRedirectTarget !== null && typeof getRedirectTarget !== "function") {
    throw new TypeError("getRedirectTarget must be a function");
  }
  const boundOptions = {
    positiveTtlMs, negativeTtlMs, maxNodes, maxFrameClues, maxRedirectHops, maxBodyBytes, maxCacheEntries,
  };
  for (const [name, value] of Object.entries(boundOptions)) {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive finite number`);
  }
  for (const name of ["maxNodes", "maxFrameClues", "maxRedirectHops", "maxCacheEntries"]) {
    if (!Number.isInteger(boundOptions[name])) throw new TypeError(`${name} must be an integer`);
  }

  const positiveCache = new Map();
  const negativeCache = new Map();
  const inflight = new Map();

  function setBounded(map, key, value) {
    map.set(key, value);
    while (map.size > maxCacheEntries) map.delete(map.keys().next().value);
  }

  async function traverse(startUrl, signal) {
    const queue = [startUrl];
    const visited = new Set([startUrl]);
    for (let index = 0; index < queue.length; index += 1) {
      if (index >= maxNodes) break;
      const url = queue[index];
      throwIfAborted(signal);
      const loaded = await fetchPublicResponse(url, {
        ensureRoute, fetchImpl, signal, referrer: url, maxRedirectHops, getRedirectTarget,
      });
      if (!loaded) continue;
      const pageUrl = loaded.url;
      const text = await boundedResponseText(loaded.response, maxBodyBytes);
      if (text === null) continue;
      throwIfAborted(signal);

      visited.add(pageUrl);
      const deobfuscated = deobfuscateScriptText(text);
      const fullText = deobfuscated ? `${text}\n${deobfuscated}` : text;

      const streamtape = parseStreamtapeNorobotlink(text, pageUrl);
      if (streamtape) {
        const canonical = canonicalPublicHttpUrl(streamtape.url);
        if (canonical) {
          throwIfAborted(signal);
          return { type: RESULT_TYPES.PROGRESSIVE, url: canonical.href, referrer: streamtape.referrer };
        }
      }

      const pass = await doodPassResult(text, pageUrl, {
        ensureRoute, fetchImpl, signal, maxBodyBytes, maxRedirectHops, getRedirectTarget,
      });
      if (pass) {
        throwIfAborted(signal);
        return pass;
      }

      const hosted = hostedPlayerResult(fullText, pageUrl);
      if (hosted) {
        throwIfAborted(signal);
        return hosted;
      }

      const direct = directMediaResult(fullText, pageUrl);
      if (direct) {
        throwIfAborted(signal);
        return direct;
      }

      const videoUrl = base64VideoUrlResult(fullText, pageUrl);
      if (videoUrl) {
        throwIfAborted(signal);
        return videoUrl;
      }

      try {
        const parsed = new URL(pageUrl);
        if (/^\/d\//i.test(parsed.pathname)) {
          const twin = canonicalPublicHttpUrl(`${parsed.origin}${parsed.pathname.replace(/^\/d\//i, "/e/")}`);
          if (twin && !visited.has(twin.href)) {
            visited.add(twin.href);
            queue.push(twin.href);
          }
        }
      } catch {
        // Ignore malformed node URLs; nodes were canonical at enqueue time.
      }

      for (const frameUrl of frameClueUrls(fullText, pageUrl, maxFrameClues)) {
        if (!visited.has(frameUrl)) {
          visited.add(frameUrl);
          queue.push(frameUrl);
        }
      }
    }
    return null;
  }

  function waitForInflight(entry, signal) {
    throwIfAborted(signal);
    entry.waiters += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.waiters -= 1;
      if (!entry.settled && entry.waiters === 0) entry.controller.abort();
    };
    const waited = abortableAwait(entry.promise, signal);
    return waited.finally(release);
  }

  function resolveFresh(key, startUrl, signal) {
    const existing = inflight.get(key);
    if (existing) return waitForInflight(existing, signal);
    const controller = new AbortController();
    const entry = { controller, waiters: 0, settled: false, promise: null };
    const promise = traverse(startUrl, controller.signal).then((result) => {
      throwIfAborted(controller.signal);
      if (result) {
        setBounded(positiveCache, key, { ...result, expiresAtMs: now() + positiveTtlMs });
        return { ...result, cached: false };
      }
      setBounded(negativeCache, key, { expiresAtMs: now() + negativeTtlMs });
      return null;
    }).finally(() => {
      entry.settled = true;
      if (inflight.get(key) === entry) inflight.delete(key);
    });
    entry.promise = promise;
    inflight.set(key, entry);
    return waitForInflight(entry, signal);
  }

  async function resolve(pageUrl, { signal = null } = {}) {
    const start = canonicalPublicHttpUrl(pageUrl);
    if (!start) return null;
    throwIfAborted(signal);
    const key = start.href;
    if (inflight.has(key)) return waitForInflight(inflight.get(key), signal);
    const currentTime = now();
    const cached = positiveCache.get(key);
    if (cached && cached.expiresAtMs > currentTime) {
      if (typeof ensureRoute === "function") {
        try {
          await ensureRoute([cached.url]);
        } catch {
          positiveCache.delete(key);
          return resolveFresh(key, start.href, signal);
        }
        throwIfAborted(signal);
      }
      return { url: cached.url, referrer: cached.referrer, type: cached.type, cached: true };
    }
    if (cached) positiveCache.delete(key);
    const negative = negativeCache.get(key);
    if (negative && negative.expiresAtMs > currentTime) return null;
    if (negative) negativeCache.delete(key);
    return resolveFresh(key, start.href, signal);
  }

  return Object.freeze({
    resolve,
    clear() {
      positiveCache.clear();
      negativeCache.clear();
      for (const entry of inflight.values()) entry.controller.abort();
      inflight.clear();
    },
    get positiveCacheSize() {
      return positiveCache.size;
    },
    get negativeCacheSize() {
      return negativeCache.size;
    },
  });
}

// Legacy compatibility entrypoint. Same signature and result shape as before
// ({ type: "progressive", url, referrer } or null, never throws); every
// discovered media URL, including HLS playlists, keeps the legacy
// "progressive" label. The graph resolver is the typed, cached, cancellable
// API for new consumers.
export async function resolvePlayerPage(pageUrl, { ensureRoute = null } = {}) {
  try {
    const resolver = createPlayerGraphResolver({ ensureRoute });
    const resolved = await resolver.resolve(pageUrl);
    if (!resolved) return null;
    return { type: RESULT_TYPES.PROGRESSIVE, url: resolved.url, referrer: resolved.referrer };
  } catch {
    return null;
  }
}
