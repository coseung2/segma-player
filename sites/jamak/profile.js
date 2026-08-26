import { DOWNLOAD_MODES } from "../../download-mode.js";
import { DOWNLOADER_IDS } from "../../downloaders/ids.js";
import { defineSiteProfile } from "../profile.js";

export const jamakSite = defineSiteProfile({
  id: "jamak",
  hosts: ["jamak.cc"],
  primaryMode: DOWNLOAD_MODES.PLAYER_PAGE_GRAPH,
  fallbackModes: [DOWNLOAD_MODES.DIRECT_PROGRESSIVE, DOWNLOAD_MODES.AUTHENTICATED_SOURCE_FRAME],
  modules: {
    primaryDownloader: DOWNLOADER_IDS.PROGRESSIVE,
    fallbackDownloaders: [DOWNLOADER_IDS.HLS],
    providers: [],
  },
});
