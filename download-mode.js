import { looksLikePlayerPage } from "./player-page-resolver.js";

export const DOWNLOAD_MODES = Object.freeze({
  DIRECT_PROGRESSIVE: "DIRECT_PROGRESSIVE",
  HLS_MANIFEST: "HLS_MANIFEST",
  DASH_MANIFEST: "DASH_MANIFEST",
  PLAYER_API: "PLAYER_API",
  PLAYER_PAGE_GRAPH: "PLAYER_PAGE_GRAPH",
  AUTHENTICATED_SOURCE_FRAME: "AUTHENTICATED_SOURCE_FRAME",
  REMOTE_SERVICE: "REMOTE_SERVICE",
  UNKNOWN: "UNKNOWN",
});

const YOUTUBE_HOST_RE = /(?:^|\.)youtube\.com$|(?:^|\.)youtu\.be$/i;

function hostOf(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ""; }
}

function evidenceList({ evidence = [], detectionSource = "", player = "" } = {}) {
  return [
    { source: detectionSource, player },
    ...(Array.isArray(evidence) ? evidence : []),
  ].filter((item) => item && typeof item === "object");
}

export function classifyDownloadMode({
  pageUrl = "",
  resourceUrl = "",
  mediaType = "",
  player = "",
  detectionSource = "",
  evidence = [],
} = {}) {
  const pageHost = hostOf(pageUrl);
  const resourceHost = hostOf(resourceUrl);
  const evidenceItems = evidenceList({ evidence, detectionSource, player });
  const players = evidenceItems.map((item) => String(item.player || "").toLowerCase());
  const sources = evidenceItems.map((item) => String(item.source || "").toLowerCase());

  if (YOUTUBE_HOST_RE.test(pageHost) || YOUTUBE_HOST_RE.test(resourceHost)) {
    return DOWNLOAD_MODES.REMOTE_SERVICE;
  }
  if (players.some((value) => value.includes("dood"))
    || sources.some((value) => value.includes("dood"))) {
    return DOWNLOAD_MODES.AUTHENTICATED_SOURCE_FRAME;
  }
  if (players.includes("level5") || sources.includes("level5")
    || (mediaType === "HLS_MASTER" || mediaType === "HLS_MEDIA")
      && sources.includes("player-adapter") && Number.isInteger(evidenceItems[0]?.frameId)) {
    return DOWNLOAD_MODES.AUTHENTICATED_SOURCE_FRAME;
  }
  if (players.includes("api-json") || sources.some((value) => value === "main-fetch" || value === "main-xhr")) {
    return DOWNLOAD_MODES.PLAYER_API;
  }
  if (looksLikePlayerPage(resourceUrl)) return DOWNLOAD_MODES.PLAYER_PAGE_GRAPH;
  if (mediaType === "HLS_MASTER" || mediaType === "HLS_MEDIA") return DOWNLOAD_MODES.HLS_MANIFEST;
  if (mediaType === "DASH") return DOWNLOAD_MODES.DASH_MANIFEST;
  if (mediaType === "PROGRESSIVE") return DOWNLOAD_MODES.DIRECT_PROGRESSIVE;
  return DOWNLOAD_MODES.UNKNOWN;
}
