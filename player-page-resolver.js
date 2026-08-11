// Resolves player pages into direct media URLs without needing DevTools.

const PLAYER_PATH_RE = /^\/(?:[de])\//i;
const STREAMTAPE_HOST_RE = /(?:^|\.)streamtape\.com$/i;
const STREAMTAPE_PLAYER_PATH_RE = /^\/(?:v|e)(?:\/|$)/i;
const MAX_STREAMTAPE_EXPRESSION_BYTES = 32_768;

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
  const assignment = /getElementById\s*\(\s*(['"])norobotlink\1\s*\)\s*\.\s*innerHTML\s*=/gi;
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
    return isStreamtapePlayerPage(parsed.href) || PLAYER_PATH_RE.test(parsed.pathname);
  } catch {
    return false;
  }
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

export async function resolvePlayerPage(pageUrl, { ensureRoute = null } = {}) {
  const queue = [pageUrl];
  const visited = new Set();
  let origin = "";
  try { origin = new URL(pageUrl).origin; } catch { return null; }

  for (let index = 0; index < queue.length; index += 1) {
    const url = queue[index];
    if (visited.has(url)) continue;
    visited.add(url);

    let text = "";
    try {
      await ensureRoute?.([url]);
      const response = await fetch(url, {
        credentials: "include",
        redirect: "follow",
        referrer: url,
        referrerPolicy: "unsafe-url",
      });
      if (!response.ok) continue;
      text = await response.text();
    } catch {
      continue;
    }
    if (!text || text.length > 5_000_000) continue;

    const streamtape = parseStreamtapeNorobotlink(text, url);
    if (streamtape) return { type: "progressive", ...streamtape };

    const direct = text.match(/https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4|webm)(?:[?#][^\s"'<>\\]*)?/i);
    if (direct) return { type: "progressive", url: direct[0], referrer: url };

    const pass = text.match(/["'(\s](\/pass_md5\/[^"')\s]+)["')]/)
      || text.match(/(\/pass_md5\/[^\s"'<>]+)/);
    if (pass) {
      const passUrl = new URL(pass[1], origin).href;
      try {
        await ensureRoute?.([passUrl]);
        const response = await fetch(passUrl, { credentials: "include", redirect: "follow" });
        if (response.ok) {
          const directUrl = parseDoodResponse(await response.text());
          if (directUrl) return { type: "progressive", url: directUrl, referrer: url };
        }
      } catch {
        // Try the remaining pages before giving up.
      }
    }

    try {
      if (/^\/d\//.test(new URL(url).pathname)) {
        queue.push(`${origin}${new URL(url).pathname.replace(/^\/d\//, "/e/")}`);
      }
    } catch { /* ignore */ }

    const frameRe = /(?:src|data-src|href)=["']([^"']+\/[de]\/[A-Za-z0-9_-]+(?:[^"']*))["']/gi;
    let frame;
    while ((frame = frameRe.exec(text))) {
      try {
        queue.push(new URL(frame[1], url).href);
      } catch { /* ignore */ }
    }
  }
  return null;
}
