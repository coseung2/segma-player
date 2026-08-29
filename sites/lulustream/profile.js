import { DOWNLOAD_MODES } from "../../download-mode.js";
import { DOWNLOADER_IDS } from "../../downloaders/ids.js";
import { defineSiteProfile } from "../profile.js";

export const lulustreamSite = defineSiteProfile({
  id: "lulustream",
  hosts: ["luluvdo.com", "www.luluvdo.com"],
  primaryMode: DOWNLOAD_MODES.HLS_MANIFEST,
  fallbackModes: [DOWNLOAD_MODES.PLAYER_PAGE_GRAPH, DOWNLOAD_MODES.DIRECT_PROGRESSIVE],
  modules: {
    primaryDownloader: DOWNLOADER_IDS.HLS,
    fallbackDownloaders: [DOWNLOADER_IDS.PROGRESSIVE],
    providers: [],
  },
});
