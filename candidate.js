import { isStreamtapePlayerPage } from "./player-page-resolver.js";

export const LIMITS = Object.freeze({
  urlBytes: 4096,
  queryBytes: 2048,
  titleCharacters: 512,
  contentTypeBytes: 128,
  candidates: 500,
  variants: 128,
});

export const MEDIA_TYPES = Object.freeze({
  PROGRESSIVE: "PROGRESSIVE",
  HLS_MASTER: "HLS_MASTER",
  HLS_MEDIA: "HLS_MEDIA",
  DASH: "DASH",
  UNKNOWN: "UNKNOWN",
});

export function isDownloadableMediaType(value) {
  return value === MEDIA_TYPES.PROGRESSIVE || value === MEDIA_TYPES.HLS_MASTER || value === MEDIA_TYPES.HLS_MEDIA;
}

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
      || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return false;
    if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
      return publicIpLiteral(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
    }
    return true;
  }
  return true;
}

export function canonicalHttpUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > LIMITS.urlBytes || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
    if ((url.protocol === "http:" && url.port && url.port !== "80")
      || (url.protocol === "https:" && url.port && url.port !== "443")) return null;
    const host = url.hostname.replace(/\.$/, "").toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || !publicIpLiteral(host)) return null;
    if (url.search.length > LIMITS.queryBytes + 1) return null;
    url.hostname = host;
    url.port = "";
    return url;
  } catch {
    return null;
  }
}

export function isImageResourceUrl(value) {
  const url = canonicalHttpUrl(value);
  return Boolean(url && /\.(?:avif|gif|jpe?g|png|webp)$/i.test(url.pathname));
}

export function mediaTypeForResource(resourceUrl, contentType = "") {
  const lowerType = contentType.toLowerCase();
  let pathname = "";
  try {
    const parsed = new URL(resourceUrl);
    if (isStreamtapePlayerPage(parsed.href)) return MEDIA_TYPES.UNKNOWN;
    pathname = parsed.pathname.toLowerCase();
  } catch {
    return MEDIA_TYPES.UNKNOWN;
  }
  if (pathname.endsWith(".mpd") || lowerType.includes("dash+xml")) return MEDIA_TYPES.DASH;
  if (pathname.endsWith(".m3u8") || lowerType.includes("mpegurl")) return MEDIA_TYPES.HLS_MEDIA;
  if (pathname.endsWith(".mp4") || pathname.endsWith(".webm")
    || lowerType.startsWith("video/") || lowerType.startsWith("audio/")) {
    return MEDIA_TYPES.PROGRESSIVE;
  }
  return MEDIA_TYPES.UNKNOWN;
}

function redactSearch(search) {
  const parts = search.replace(/^\?/, "").split("&").filter(Boolean).map((part) => {
    const separator = part.indexOf("=");
    const key = separator >= 0 ? part.slice(0, separator) : part;
    return `${key}=[redacted]`;
  });
  return parts.length ? `?${parts.join("&")}` : "";
}

export function redactUrl(resourceUrl) {
  if (typeof resourceUrl === "string" && resourceUrl.startsWith("blob:")) {
    try {
      return `blob:${new URL(resourceUrl).origin}/[redacted]`;
    } catch {
      return "[redacted-invalid-url]";
    }
  }
  const url = canonicalHttpUrl(resourceUrl);
  if (!url) return "[redacted-invalid-url]";
  return `${url.protocol}//${url.host}${url.pathname || "/"}${redactSearch(url.search)}`;
}

export function normalizeOriginPath(resourceUrl) {
  if (typeof resourceUrl === "string" && resourceUrl.startsWith("blob:")) {
    try {
      const url = new URL(resourceUrl);
      return `blob:${url.origin}${url.pathname}`;
    } catch {
      return null;
    }
  }
  const url = canonicalHttpUrl(resourceUrl);
  if (!url) return null;
  const path = (url.pathname || "/").replace(/\/$/, "") || "/";
  return `${url.protocol}//${url.host}${path}`;
}

export function pageOrigin(pageUrl) {
  const url = canonicalHttpUrl(pageUrl);
  return url ? `${url.protocol}//${url.host}` : null;
}

function secureId() {
  if (!globalThis.crypto?.randomUUID) throw new Error("secure random UUID is unavailable");
  return globalThis.crypto.randomUUID();
}

function likelyAd(pageTitle, resourceUrl) {
  const value = `${pageTitle} ${resourceUrl}`.toLowerCase();
  return ["/ad/", "/ads/", "advert", "doubleclick", "preroll", "vast"].some((marker) => value.includes(marker));
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}

export function variantIdentity(variant) {
  const resource = normalizeOriginPath(variant.resourceUrl) || "invalid-resource";
  const resolution = variant.resolution && typeof variant.resolution === "object"
    ? `${variant.resolution.width || ""}x${variant.resolution.height || ""}` : "";
  return fnv1a([
    resource, resolution, variant.bandwidth || "", variant.frameRate || "", variant.codecs || "",
    variant.audioLanguage || "", variant.subtitleLanguage || "",
  ].join("|"));
}

export function makeCandidate({
  pageTitle = "", pageUrl, resourceUrl, contentType = "", likelyAdvertisement = false,
  detectedAt = new Date().toISOString(), variants = [], main = false, tabId = null,
  frameId = null, fromMediaElement = false,
}) {
  if (typeof resourceUrl !== "string" || resourceUrl.length > LIMITS.urlBytes) return null;
  const blob = resourceUrl.startsWith("blob:");
  const canonical = blob ? resourceUrl : canonicalHttpUrl(resourceUrl)?.href;
  const pageCanonical = canonicalHttpUrl(pageUrl);
  const origin = pageCanonical ? `${pageCanonical.protocol}//${pageCanonical.host}` : null;
  if (!canonical || (!blob && isImageResourceUrl(canonical)) || !origin
    || typeof pageTitle !== "string" || [...pageTitle].length > LIMITS.titleCharacters
    || /[\u0000-\u001f\u007f]/.test(pageTitle) || typeof contentType !== "string"
    || contentType.length > LIMITS.contentTypeBytes || !Array.isArray(variants) || variants.length > LIMITS.variants
    || (tabId !== null && (!Number.isInteger(tabId) || tabId <= 0))
    || (frameId !== null && (!Number.isInteger(frameId) || frameId < 0))) return null;
  let mediaType = mediaTypeForResource(canonical, contentType);
  // Video/audio elements and browser "media" network requests are media by
  // definition. Hosts such as DoodStream serve direct MP4 files from URLs with
  // no ".mp4" extension and an application/octet-stream Content-Type, which
  // extension/content-type matching alone would drop.
  if (mediaType === MEDIA_TYPES.UNKNOWN && fromMediaElement && !blob
    && !isImageResourceUrl(canonical) && !isStreamtapePlayerPage(canonical)) {
    mediaType = MEDIA_TYPES.PROGRESSIVE;
  }
  if (mediaType === MEDIA_TYPES.UNKNOWN && !blob) return null;
  const normalizedVariants = [];
  for (const variant of variants) {
    if (!variant || typeof variant !== "object") return null;
    const variantUrl = canonicalHttpUrl(variant.resourceUrl);
    if (!variantUrl) return null;
    normalizedVariants.push({
      ...variant,
      resourceUrl: variantUrl.href,
      displayUrl: redactUrl(variantUrl.href),
    });
  }
  return {
    id: secureId(),
    tabId: tabId === null ? null : tabId,
    frameId: frameId === null ? null : frameId,
    pageTitle,
    pageOrigin: origin,
    pageUrl: pageCanonical ? pageCanonical.href : "",
    main: Boolean(main),
    mediaType,
    resourceUrl: canonical,
    displayUrl: redactUrl(canonical),
    detectedAt: String(detectedAt).slice(0, 64),
    durationMs: null,
    live: false,
    protection: "UNKNOWN",
    support: "UNKNOWN",
    variants: normalizedVariants,
    likelyAdvertisement: Boolean(likelyAdvertisement) || likelyAd(pageTitle, canonical),
  };
}

export function candidateKey(candidate) {
  const tab = candidate.tabId == null ? "" : String(candidate.tabId);
  return `${tab}|${normalizeOriginPath(candidate.resourceUrl) || candidate.displayUrl}|${candidate.mediaType}`;
}

export function upsertCandidate(candidates, candidate, limit = LIMITS.candidates) {
  const key = candidateKey(candidate);
  const existing = candidates.get(key);
  if (existing) {
    candidates.delete(key);
    existing.resourceUrl = candidate.resourceUrl;
    existing.displayUrl = candidate.displayUrl;
    if (candidate.tabId != null) existing.tabId = candidate.tabId;
    if (candidate.frameId != null) existing.frameId = candidate.frameId;
    if (candidate.pageTitle) existing.pageTitle = candidate.pageTitle;
    if (candidate.pageUrl) existing.pageUrl = candidate.pageUrl;
    if (candidate.main) existing.main = true;
    for (const incoming of candidate.variants) {
      const identity = variantIdentity(incoming);
      const current = existing.variants.find((variant) => variantIdentity(variant) === identity);
      if (current) {
        current.resourceUrl = incoming.resourceUrl;
        current.displayUrl = redactUrl(incoming.resourceUrl);
      } else if (existing.variants.length < LIMITS.variants) {
        existing.variants.push(incoming);
      }
    }
    candidates.set(key, existing);
    return existing;
  }
  candidates.set(key, candidate);
  while (candidates.size > limit) candidates.delete(candidates.keys().next().value);
  return candidate;
}

function redactedVariant(variant) {
  return {
    identity: variantIdentity(variant),
    displayUrl: redactUrl(variant.resourceUrl),
    resolution: variant.resolution || null,
    bandwidth: variant.bandwidth || null,
    codecs: typeof variant.codecs === "string" ? variant.codecs.slice(0, 256) : null,
    audioLanguage: typeof variant.audioLanguage === "string" ? variant.audioLanguage.slice(0, 32) : null,
    subtitleLanguage: typeof variant.subtitleLanguage === "string" ? variant.subtitleLanguage.slice(0, 32) : null,
  };
}

export function redactCandidateForUi(candidate) {
  const pageTitle = /https?:\/\//i.test(candidate.pageTitle)
    || /(?:^|[?&\s])(token|sig|key|auth)=/i.test(candidate.pageTitle)
    ? "[redacted-title]" : candidate.pageTitle;
  return {
    id: candidate.id,
    tabId: candidate.tabId == null ? null : candidate.tabId,
    pageTitle,
    pageOrigin: candidate.pageOrigin,
    main: Boolean(candidate.main),
    mediaType: candidate.mediaType,
    displayUrl: candidate.displayUrl,
    detectedAt: candidate.detectedAt,
    durationMs: candidate.durationMs,
    live: candidate.live,
    protection: candidate.protection,
    support: candidate.support,
    variants: candidate.variants.map(redactedVariant),
    likelyAdvertisement: candidate.likelyAdvertisement,
  };
}

export function toTextOnlyRows(candidates) {
  return candidates.map((candidate) => Object.freeze({
    titleText: String(candidate.pageTitle),
    originText: String(candidate.pageOrigin),
    mediaTypeText: String(candidate.mediaType),
    urlText: String(candidate.displayUrl),
  }));
}

export function sanitizePageMessage(message) {
  if (!message || message.type !== "resource") return null;
  const candidate = makeCandidate({
    pageTitle: message.pageTitle,
    pageUrl: message.pageUrl,
    resourceUrl: message.resourceUrl,
    contentType: message.contentType,
    main: message.main,
    fromMediaElement: message.fromMediaElement,
  });
  return candidate ? { ...candidate, type: "resource" } : null;
}
