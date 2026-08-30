(() => {
  const API_KEY = "__segmaContentExtractionV1";
  if (globalThis[API_KEY]) return;

  const MAX_URL_BYTES = 4096;
  const IMAGE_PATH_RE = /\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i;
  const MEDIA_PATH_RE = /\.(?:m3u8|mpd|mp4|m4v|webm)$/i;
  const MEDIA_URL_RE = /https?:\/\/[^\s"'<>\\`]+(?:\.m3u8|\.mpd|\.mp4|\.m4v|\.webm)(?:\?[^\s"'<>\\`]*)?/gi;
  const MEDIA_FIELD_RE = /\b(?:video_url(?:_hd)?|streaming_url|streamingUrl|playback_url|playbackUrl|manifest_url|manifestUrl|hls_url|hlsUrl|play_url|playUrl|videoUrl|source_url|sourceUrl|contentUrl|file|src|url|source|playlist)\s*[:=]\s*(["'])((?:\\.|[^\\])*?)\1/g;

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
          if (octets.length !== 4
            || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
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
      if (words.every((word) => word === 0)
        || (words.slice(0, 7).every((word) => word === 0) && words[7] === 1)
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
    }
    return true;
  }

  function canonicalPublicHttpUrl(value, {
    baseUrl,
    maxUrlBytes = MAX_URL_BYTES,
    maxQueryBytes = 2048,
    allowHash = true,
  } = {}) {
    if (typeof value !== "string" || value.length === 0 || value.length > maxUrlBytes
      || /[\u0000-\u0020\u007f]/.test(value)) return null;
    try {
      const url = baseUrl ? new URL(value, baseUrl) : new URL(value);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || (!allowHash && url.hash)) return null;
      if ((url.protocol === "https:" && url.port && url.port !== "443")
        || (url.protocol === "http:" && url.port && url.port !== "80")) return null;
      const host = url.hostname.replace(/\.$/, "").toLowerCase();
      if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
        || !publicIpLiteral(host) || url.search.length > maxQueryBytes + 1) return null;
      url.hostname = host;
      url.port = "";
      return url;
    } catch {
      return null;
    }
  }

  function decodeRadix62(token, radix) {
    let value = 0;
    for (let index = 0; index < token.length; index += 1) {
      const code = token.charCodeAt(index);
      let digit = 0;
      if (code >= 48 && code <= 57) digit = code - 48;
      else if (code >= 97 && code <= 122) digit = code - 97 + 10;
      else if (code >= 65 && code <= 90) digit = code - 65 + 36;
      else return null;
      if (digit >= radix) return null;
      value = value * radix + digit;
    }
    return value;
  }

  function unpackPackerScripts(text) {
    if (typeof text !== "string" || text.length === 0 || text.length > 2_000_000) return "";
    const pattern = /\be[v]al\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,[^\)]+\)[\s\S]*?\}\s*\(\s*(['"])((?:\\.|[^\\])*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])((?:\\.|[^\\])*?)\5\.split\s*\(\s*['"]\|['"]\s*\)/gi;
    let match;
    const results = [];
    while ((match = pattern.exec(text))) {
      try {
        const payload = match[2].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        const radix = Number.parseInt(match[3], 10);
        const keywords = match[6].split("|");
        if (!Number.isInteger(radix) || radix < 2 || radix > 62 || !keywords.length) continue;
        results.push(payload.replace(/\b[0-9a-zA-Z]+\b/g, (token) => {
          const index = decodeRadix62(token, radix);
          if (index === null || index >= keywords.length) return token;
          return keywords[index] || token;
        }));
      } catch {
        // Ignore malformed packer blocks.
      }
    }
    return results.join("\n");
  }

  function decodeHexEscapedScript(text) {
    if (typeof text !== "string" || !text.includes("\\x")) return "";
    const results = [];
    for (const match of text.matchAll(/(?:\\x[0-9a-fA-F]{2}){6,}/g)) {
      const decoded = match[0].replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
        String.fromCharCode(Number.parseInt(hex, 16)));
      if (decoded.length <= MAX_URL_BYTES && (/^https?:\/\//i.test(decoded) || MEDIA_PATH_RE.test(decoded))) {
        results.push(decoded);
      }
    }
    return results.join("\n");
  }

  function decodeReversedUrls(text) {
    if (typeof text !== "string" || text.length === 0 || text.length > 2_000_000) return "";
    const results = [];
    for (const match of text.matchAll(/(["'])([A-Za-z0-9_.:~%/?&=+\-]{12,2048})\1/g)) {
      const candidate = match[2];
      if (candidate.includes("://") || candidate.startsWith("http")) continue;
      const reversed = [...candidate].reverse().join("");
      if (/^https?:\/\/[^\s"'<>\\`]+\.(?:m3u8|mpd|mp4|m4v|webm)(?:\?[^\s"'<>\\`]*)?$/i.test(reversed)
        || (/^https?:\/\/[^\s"'<>\\`]+/i.test(reversed)
          && /(?:^|[?&])(?:type|format|kind)=(?:hls|m3u8|dash|mpd)\b/i.test(reversed))) {
        results.push(reversed);
      }
    }
    return results.join("\n");
  }

  function decodePercentEscapedUrls(text) {
    if (typeof text !== "string" || !text.includes("%")) return "";
    const results = [];
    for (const match of text.matchAll(/(?:https?|%[0-9a-fA-F]{2})(?:[A-Za-z0-9._~:/?@!$&()*+,;=%\-]|%[0-9a-fA-F]{2}){5,4090}/g)) {
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
      if (decoded.length <= MAX_URL_BYTES && (/^https?:\/\//i.test(decoded) || MEDIA_PATH_RE.test(decoded))) {
        results.push(decoded);
      }
    }
    return results.join("\n");
  }

  function decodeBase64JsonConfigs(text) {
    if (typeof text !== "string" || text.length === 0 || text.length > 2_000_000) return "";
    const results = [];
    for (const match of text.matchAll(/(?:["']|:\s*)([A-Za-z0-9+/_-]{16,}={0,2})(?:["']|[\s;,}\]]|$)/g)) {
      const raw = match[1];
      if (raw.length > 333_336) continue;
      try {
        const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
        if (normalized.length % 4 === 1) continue;
        const decoded = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4)).trim();
        if ((decoded.startsWith("{") || decoded.startsWith("[")) && decoded.length <= 250_000) {
          results.push(decoded);
        }
      } catch {
        // Ignore invalid base64.
      }
    }
    return results.join("\n");
  }

  function deobfuscateScriptText(text) {
    if (typeof text !== "string" || !text) return "";
    return [
      unpackPackerScripts(text),
      decodeHexEscapedScript(text),
      decodeReversedUrls(text),
      decodePercentEscapedUrls(text),
      decodeBase64JsonConfigs(text),
    ].filter(Boolean).join("\n");
  }

  function canonicalMediaUrl(value, baseUrl) {
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_URL_BYTES) return "";
    try {
      const decoded = /^[A-Za-z0-9+/]{8,}={0,2}$/.test(trimmed) && !/^https?:/i.test(trimmed)
        ? atob(trimmed).trim()
        : trimmed.replace(/^["']|["']$/g, "");
      const url = canonicalPublicHttpUrl(decoded, { baseUrl });
      if (!url || url.href.length > MAX_URL_BYTES || IMAGE_PATH_RE.test(url.pathname)) return "";
      const pathname = url.pathname.toLowerCase();
      const search = url.search.toLowerCase();
      if (MEDIA_PATH_RE.test(pathname)) return url.href;
      if (/(?:^|[?&])(?:type|format|kind)=(?:hls|m3u8|dash|mpd)\b/.test(search)) return url.href;
      if (/(?:^|\/)(?:hls|playlist|manifest|get_file|getfile)(?:\/|$)/.test(pathname)) return url.href;
      return "";
    } catch {
      return "";
    }
  }

  function inferredContentType(value, baseUrl) {
    try {
      const url = canonicalPublicHttpUrl(value, { baseUrl });
      if (!url) return "video/mp4";
      const pathname = url.pathname.toLowerCase();
      const search = url.search.toLowerCase();
      if (pathname.endsWith(".mpd") || /(?:^|[?&])(?:type|format|kind)=(?:dash|mpd)\b/.test(search)) {
        return "application/dash+xml";
      }
      if (pathname.endsWith(".m3u8") || /(?:^|[?&])(?:type|format|kind)=(?:hls|m3u8)\b/.test(search)
        || /(?:^|\/)(?:hls|playlist|manifest)(?:\/|$)/.test(pathname)) {
        return "application/vnd.apple.mpegurl";
      }
      return pathname.endsWith(".webm") ? "video/webm" : "video/mp4";
    } catch {
      return "video/mp4";
    }
  }

  function scriptMediaUrls(source, baseUrl) {
    if (typeof source !== "string" || !source) return [];
    const urls = [];
    const remember = (value) => {
      const url = canonicalMediaUrl(value, baseUrl);
      if (url) urls.push(url);
    };
    const deobfuscated = deobfuscateScriptText(source);
    const target = deobfuscated ? `${source}\n${deobfuscated}` : source;
    for (const match of target.matchAll(/\bvideo_url(?:_hd)?\s*:\s*(["'])([A-Za-z0-9+/]{8,}={0,2})\1/g)) {
      try { remember(atob(match[2]).trim()); } catch { /* malformed config */ }
    }
    MEDIA_FIELD_RE.lastIndex = 0;
    let match;
    while ((match = MEDIA_FIELD_RE.exec(target))) remember(match[2].replace(/\\\//g, "/"));
    MEDIA_URL_RE.lastIndex = 0;
    while ((match = MEDIA_URL_RE.exec(target))) remember(match[0]);
    return [...new Set(urls)];
  }

  Object.defineProperty(globalThis, API_KEY, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      canonicalMediaUrl,
      canonicalPublicHttpUrl,
      decodeBase64JsonConfigs,
      decodeHexEscapedScript,
      decodePercentEscapedUrls,
      decodeReversedUrls,
      deobfuscateScriptText,
      inferredContentType,
      scriptMediaUrls,
      unpackPackerScripts,
    }),
  });
})();
