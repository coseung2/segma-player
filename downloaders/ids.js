export const DOWNLOADER_IDS = Object.freeze({
  PROGRESSIVE: "progressive",
  HLS: "hls",
  DASH: "dash",
  REMOTE_SERVICE: "remote-service",
  UNKNOWN: "unknown",
});

export function downloaderIdForMediaType(mediaType, downloadMode = "") {
  if (downloadMode === "REMOTE_SERVICE") return DOWNLOADER_IDS.REMOTE_SERVICE;
  if (mediaType === "PROGRESSIVE") return DOWNLOADER_IDS.PROGRESSIVE;
  if (mediaType === "HLS_MASTER" || mediaType === "HLS_MEDIA") return DOWNLOADER_IDS.HLS;
  if (mediaType === "DASH") return DOWNLOADER_IDS.DASH;
  return DOWNLOADER_IDS.UNKNOWN;
}

export function jobModeForDownloader(downloaderId) {
  if (downloaderId === DOWNLOADER_IDS.PROGRESSIVE) return "stream";
  if (downloaderId === DOWNLOADER_IDS.HLS) return "hls";
  if (downloaderId === DOWNLOADER_IDS.DASH) return "dash";
  if (downloaderId === DOWNLOADER_IDS.REMOTE_SERVICE) return "remote";
  return "unknown";
}
