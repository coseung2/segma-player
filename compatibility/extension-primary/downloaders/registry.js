import { createDashDownloader } from "./dash.js";
import { createHlsDownloader } from "./hls.js";
import { downloaderIdForMediaType, DOWNLOADER_IDS } from "../../../downloaders/ids.js";
import { createProgressiveDownloader } from "./progressive.js";

const PREPARED_TYPE_TO_ID = Object.freeze({
  progressive: DOWNLOADER_IDS.PROGRESSIVE,
  hls: DOWNLOADER_IDS.HLS,
  dash: DOWNLOADER_IDS.DASH,
});

export function createDownloaderRegistry(dependencies) {
  const downloaders = Object.freeze([
    createProgressiveDownloader(dependencies),
    createHlsDownloader(dependencies),
    createDashDownloader(dependencies),
  ]);
  const byId = new Map(downloaders.map((downloader) => [downloader.id, downloader]));

  return Object.freeze({
    downloaders,
    forCandidate(candidate = {}) {
      const id = candidate.downloaderId
        || downloaderIdForMediaType(candidate.mediaType, candidate.downloadMode);
      return byId.get(id) || null;
    },
    forPrepared(prepared = {}) {
      const id = prepared.downloaderId || PREPARED_TYPE_TO_ID[prepared.type] || DOWNLOADER_IDS.UNKNOWN;
      return byId.get(id) || null;
    },
  });
}
