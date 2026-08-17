import { isStreamtapePlayerPage, looksLikePlayerPage } from "./player-page-resolver.js";
import { classifyDownloadMode } from "./download-mode.js";

export const LIMITS = Object.freeze({
  urlBytes: 4096,
  queryBytes: 2048,
  titleCharacters: 512,
  contentTypeBytes: 128,
  candidates: 500,
  variants: 128,
  evidence: 16,
});

export const MEDIA_TYPES = Object.freeze({
  PROGRESSIVE: "PROGRESSIVE",
  HLS_MASTER: "HLS_MASTER",
  HLS_MEDIA: "HLS_MEDIA",
  DASH: "DASH",
  UNKNOWN: "UNKNOWN",
});

const TOKEN_QUERY_NAME_RE = /(?:^|[-_])(?:auth|authorization|expires?|expiry|hdnts?|jwt|key|policy|session|sig|signature|ticket|token)(?:$|[-_])/i;
const EXPIRY_QUERY_NAME_RE = /^(?:e|exp|expires?|expiry|token_expiry)$/i;
const SAFE_METADATA_TOKEN_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const TEXT_TRACK_PATH_RE = /\.(?:ass|dfxp|lrc|sbv|srt|ssa|sub|ttml|vtt)$/i;
const TEXT_TRACK_CONTENT_TYPE_RE = /^(?:text\/(?:vtt|srt|ssa|ass)|application\/(?:ttml\+xml|x-ass|x-subrip|x-srt))(?:\s*;|$)/i;
const PLACEHOLDER_MEDIA_PATH_RE = /(?:^|\/)(?:blank|empty|placeholder)\.(?:m4v|mp4|webm)$/i;

export function isDownloadableMediaType(value) {
  return value === MEDIA_TYPES.PROGRESSIVE || value === MEDIA_TYPES.HLS_MASTER
    || value === MEDIA_TYPES.HLS_MEDIA || value === MEDIA_TYPES.DASH;
}

function finiteTimestamp(value) {
  if (Number.isFinite(value) && value > 0) return value;
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function queryExpiryTimestamp(value) {
  if (typeof value !== "string" || !value) return null;
  if (/^\d{10,16}$/.test(value)) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return value.length <= 10 ? number * 1000 : number;
  }
  return finiteTimestamp(value);
}

function amazonExpiryTimestamp(url) {
  const date = url.searchParams.get("X-Amz-Date") || url.searchParams.get("x-amz-date");
  const lifetime = Number(url.searchParams.get("X-Amz-Expires") || url.searchParams.get("x-amz-expires"));
  if (!date || !Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 7 * 24 * 60 * 60) return null;
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
  if (!match) return null;
  const issuedAt = Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]),
  );
  return Number.isFinite(issuedAt) ? issuedAt + lifetime * 1000 : null;
}

export function mediaUrlFreshness(resourceUrl, now = Date.now()) {
  const url = canonicalHttpUrl(resourceUrl);
  if (!url) return Object.freeze({ tokenized: false, expiresAt: null, refreshAfter: null });
  let tokenized = false;
  let expiresAt = null;
  for (const [name, value] of url.searchParams) {
    if (TOKEN_QUERY_NAME_RE.test(name) && value) tokenized = true;
    if (!EXPIRY_QUERY_NAME_RE.test(name)) continue;
    const parsed = queryExpiryTimestamp(value);
    if (parsed && (!expiresAt || parsed < expiresAt)) expiresAt = parsed;
  }
  const amazonExpiry = amazonExpiryTimestamp(url);
  if (amazonExpiry) {
    tokenized = true;
    expiresAt = expiresAt ? Math.min(expiresAt, amazonExpiry) : amazonExpiry;
  }
  const current = Number.isFinite(now) ? now : Date.now();
  const refreshAfter = expiresAt
    ? Math.max(current, expiresAt - Math.min(60_000, Math.max(15_000, (expiresAt - current) * 0.2)))
    : null;
  return Object.freeze({ tokenized, expiresAt, refreshAfter });
}

function safeMetadataToken(value, fallback = "") {
  return typeof value === "string" && SAFE_METADATA_TOKEN_RE.test(value) ? value : fallback;
}

function normalizedEvidenceItem(value, fallback = {}) {
  const source = safeMetadataToken(value?.source, safeMetadataToken(fallback.source, "unknown"));
  const player = safeMetadataToken(value?.player, safeMetadataToken(fallback.player, ""));
  const sessionId = safeMetadataToken(value?.sessionId, safeMetadataToken(fallback.sessionId, ""));
  const requestType = safeMetadataToken(value?.requestType, safeMetadataToken(fallback.requestType, ""));
  const confidenceValue = Number(value?.confidence ?? fallback.confidence);
  const confidence = Number.isFinite(confidenceValue)
    ? Math.max(0, Math.min(100, Math.round(confidenceValue)))
    : 50;
  const at = finiteTimestamp(value?.at ?? fallback.at) || Date.now();
  return Object.freeze({ source, player, sessionId, requestType, confidence, at });
}

export function normalizeCandidateEvidence(value, fallback = {}) {
  const incoming = Array.isArray(value) ? value : [];
  const evidence = incoming.slice(0, LIMITS.evidence).map((item) => normalizedEvidenceItem(item, fallback));
  if (!evidence.length) evidence.push(normalizedEvidenceItem({}, fallback));
  return evidence;
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
  return Boolean(url && /\.(?:avif|gif|ico|jpe?g|png|webp)$/i.test(url.pathname));
}

export function isKnownNonMediaResourceUrl(value, contentType = "") {
  const url = canonicalHttpUrl(value);
  if (!url) return false;
  const pathname = url.pathname.toLowerCase();
  const normalizedContentType = typeof contentType === "string" ? contentType.trim() : "";
  const explicitManifestType = /mpegurl|dash\+xml/i.test(normalizedContentType);
  return pathname === "/favicon.ico"
    || pathname.startsWith("/cdn-cgi/challenge-platform/")
    || pathname === "/cdn-cgi/rum"
    || pathname === "/cdn-cgi/speculation"
    || TEXT_TRACK_PATH_RE.test(pathname)
    || TEXT_TRACK_CONTENT_TYPE_RE.test(normalizedContentType)
    || PLACEHOLDER_MEDIA_PATH_RE.test(pathname)
    || (!explicitManifestType && /\.(?:css|eot|html?|js|json|map|otf|svg|text|ttf|txt|woff2?|xml)$/i.test(pathname));
}

export function isLikelyHlsSegmentUrl(value) {
  const url = canonicalHttpUrl(value);
  return Boolean(url && /\.(?:ts|m4s|cmfv|cmfa)$/i.test(url.pathname));
}

export function isLikelyPreviewResourceUrl(value) {
  const url = canonicalHttpUrl(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  const pathname = url.pathname.toLowerCase();
  return /(^|\.)(previews?|thumbs?|thumbnails)\.[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(host)
    || /(^|\/)(previews?|thumbs?|thumbnails|teasers?)(\/|$)/.test(pathname)
    || /[-_.\/](previews?|teasers?)[-_.]/.test(pathname);
}

export function mediaTypeForResource(resourceUrl, contentType = "") {
  const lowerType = contentType.toLowerCase();
  let pathname = "";
  try {
    const parsed = new URL(resourceUrl);
    pathname = parsed.pathname.toLowerCase();
    const explicitMediaPath = /\.(?:aac|flac|m3u8|m4a|m4v|mkv|mov|mp3|mp4|mpd|ogg|ogv|opus|ts|webm)$/i
      .test(pathname);
    const explicitManifestType = /mpegurl|dash\+xml/i.test(lowerType);
    if (isStreamtapePlayerPage(parsed.href)) return MEDIA_TYPES.UNKNOWN;
    if (looksLikePlayerPage(parsed.href) && !explicitMediaPath && !explicitManifestType) return MEDIA_TYPES.UNKNOWN;
    if (isKnownNonMediaResourceUrl(parsed.href, contentType)) return MEDIA_TYPES.UNKNOWN;
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
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function likelyAd(pageTitle, resourceUrl, pageUrl = "") {
  const value = `${pageTitle} ${pageUrl} ${resourceUrl}`.toLowerCase();
  if (["/ad/", "/ads/", "advert", "doubleclick", "preroll", "vast"].some((marker) => value.includes(marker))) {
    return true;
  }
  return [resourceUrl, pageUrl].some((value) => {
    try {
      return /(?:^|\.)(?:growcdnssedge\.com|mayzaent\.com|myavlive\.com|rallytrck\.website|saawsedge\.com|storagexhd\.com|stripchat\.(?:com|mov)|snaptrckr\.fun|tsyndicate\.com)$/i
        .test(new URL(value).hostname);
    } catch {
      return false;
    }
  });
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
    variant.audioLanguage || "",
  ].join("|"));
}

export function makeCandidate({
  pageTitle = "", pageUrl, resourceUrl, contentType = "", likelyAdvertisement = false,
  detectedAt = new Date().toISOString(), observedAt = null, variants = [], main = false,
  explicitMain = main, tabId = null, frameId = null, fromMediaElement = false,
  evidence = [], detectionSource = "", player = "", sessionId = "", requestType = "",
  confidence = null,
}) {
  if (typeof resourceUrl !== "string" || resourceUrl.length > LIMITS.urlBytes) return null;
  const blob = resourceUrl.startsWith("blob:");
  const canonical = blob ? resourceUrl : canonicalHttpUrl(resourceUrl)?.href;
  const pageCanonical = canonicalHttpUrl(pageUrl);
  const origin = pageCanonical ? `${pageCanonical.protocol}//${pageCanonical.host}` : null;
  if (!canonical || (!blob && (isImageResourceUrl(canonical) || isKnownNonMediaResourceUrl(canonical, contentType) || isLikelyHlsSegmentUrl(canonical)
    || isLikelyPreviewResourceUrl(canonical))) || !origin
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
    && !isImageResourceUrl(canonical) && !isKnownNonMediaResourceUrl(canonical, contentType)
    && !looksLikePlayerPage(canonical)) {
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
  const observationTime = finiteTimestamp(observedAt)
    || finiteTimestamp(detectedAt)
    || Date.now();
  const normalizedEvidence = normalizeCandidateEvidence(evidence, {
    source: detectionSource || (fromMediaElement ? "media-element" : "unknown"),
    player,
    sessionId,
    requestType,
    confidence: confidence ?? (fromMediaElement ? 80 : 50),
    at: observationTime,
  });
  const downloadMode = classifyDownloadMode({
    pageUrl: pageCanonical.href,
    resourceUrl: canonical,
    mediaType,
    player,
    detectionSource,
    evidence: normalizedEvidence,
  });
  const evidencePlayer = normalizedEvidence.find((item) => item.player)?.player || "";
  const evidenceSession = normalizedEvidence.find((item) => item.sessionId)?.sessionId || "";
  const freshness = blob
    ? Object.freeze({ tokenized: false, expiresAt: null, refreshAfter: null })
    : mediaUrlFreshness(canonical, observationTime);
  return {
    id: secureId(),
    tabId: tabId === null ? null : tabId,
    frameId: frameId === null ? null : frameId,
    pageTitle,
    pageOrigin: origin,
    pageUrl: pageCanonical ? pageCanonical.href : "",
    main: Boolean(main),
    explicitMain: Boolean(explicitMain || main),
    classification: "alternate",
    score: 0,
    scoreReasons: [],
    mediaType,
    downloadMode,
    resourceUrl: canonical,
    displayUrl: redactUrl(canonical),
    detectedAt: new Date(observationTime).toISOString(),
    firstObservedAt: observationTime,
    lastObservedAt: observationTime,
    observationCount: 1,
    durationMs: null,
    live: false,
    protection: "UNKNOWN",
    support: "UNKNOWN",
    variants: normalizedVariants,
    evidence: normalizedEvidence,
    player: safeMetadataToken(player, evidencePlayer) || evidencePlayer,
    sessionId: safeMetadataToken(sessionId, evidenceSession) || evidenceSession,
    tokenized: freshness.tokenized,
    expiresAt: freshness.expiresAt,
    refreshAfter: freshness.refreshAfter,
    refreshable: !blob && Number.isInteger(tabId) && Number.isInteger(frameId),
    likelyAdvertisement: Boolean(likelyAdvertisement)
      || likelyAd(pageTitle, canonical, pageCanonical?.href || ""),
  };
}

export function candidateKey(candidate) {
  const tab = candidate.tabId == null ? "" : String(candidate.tabId);
  const frame = candidate.frameId == null ? "" : String(candidate.frameId);
  return `${tab}|${frame}|${normalizeOriginPath(candidate.resourceUrl) || candidate.displayUrl}|${candidate.mediaType}`;
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
    if (candidate.pageUrl) {
      existing.pageUrl = candidate.pageUrl;
      existing.pageOrigin = candidate.pageOrigin;
    }
    existing.explicitMain = Boolean(existing.explicitMain || candidate.explicitMain || candidate.main);
    existing.downloadMode = candidate.downloadMode || existing.downloadMode || "UNKNOWN";
    existing.lastObservedAt = Math.max(
      Number(existing.lastObservedAt) || 0,
      Number(candidate.lastObservedAt) || Date.now(),
    );
    existing.firstObservedAt = Math.min(
      Number(existing.firstObservedAt) || existing.lastObservedAt,
      Number(candidate.firstObservedAt) || existing.lastObservedAt,
    );
    existing.observationCount = Math.min(1_000_000,
      Math.max(1, Number(existing.observationCount) || 1) + Math.max(1, Number(candidate.observationCount) || 1));
    existing.tokenized = Boolean(candidate.tokenized);
    existing.expiresAt = candidate.expiresAt || null;
    existing.refreshAfter = candidate.refreshAfter || null;
    existing.refreshable = Boolean(existing.refreshable || candidate.refreshable);
    existing.likelyAdvertisement = Boolean(existing.likelyAdvertisement || candidate.likelyAdvertisement);
    if (candidate.player) existing.player = candidate.player;
    if (candidate.sessionId) existing.sessionId = candidate.sessionId;
    const evidenceByKey = new Map();
    for (const item of [...(existing.evidence || []), ...(candidate.evidence || [])]) {
      const evidenceKey = `${item.source}|${item.player}|${item.sessionId}|${item.requestType}`;
      const current = evidenceByKey.get(evidenceKey);
      if (!current || Number(item.at) >= Number(current.at)) evidenceByKey.set(evidenceKey, item);
    }
    existing.evidence = [...evidenceByKey.values()]
      .sort((left, right) => Number(right.at) - Number(left.at))
      .slice(0, LIMITS.evidence);
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
    classification: typeof candidate.classification === "string" ? candidate.classification : "alternate",
    score: Number.isFinite(candidate.score) ? candidate.score : 0,
    mediaType: candidate.mediaType,
    downloadMode: candidate.downloadMode || "UNKNOWN",
    displayUrl: candidate.displayUrl,
    detectedAt: candidate.detectedAt,
    durationMs: candidate.durationMs,
    live: candidate.live,
    protection: candidate.protection,
    support: candidate.support,
    variants: candidate.variants.map(redactedVariant),
    player: safeMetadataToken(candidate.player, ""),
    tokenized: Boolean(candidate.tokenized),
    expiresAt: Number.isFinite(candidate.expiresAt) ? candidate.expiresAt : null,
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
    explicitMain: message.explicitMain,
    fromMediaElement: message.fromMediaElement,
    observedAt: message.observedAt,
    evidence: message.evidence,
    detectionSource: message.detectionSource,
    player: message.player,
    sessionId: message.sessionId,
    requestType: message.requestType,
    confidence: message.confidence,
  });
  return candidate ? { ...candidate, type: "resource" } : null;
}
