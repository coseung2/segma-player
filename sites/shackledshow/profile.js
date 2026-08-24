import { DOWNLOAD_MODES } from "../../download-mode.js";
import { DOWNLOADER_IDS } from "../../downloaders/ids.js";
import { defineSiteProfile } from "../profile.js";

export const shackledshowSite = defineSiteProfile({
  id: "shackledshow",
  hosts: ["shackledshow.cc"],
  primaryMode: DOWNLOAD_MODES.DIRECT_PROGRESSIVE,
  fallbackModes: [DOWNLOAD_MODES.PLAYER_PAGE_GRAPH, DOWNLOAD_MODES.HLS_MANIFEST],
  modules: {
    primaryDownloader: DOWNLOADER_IDS.PROGRESSIVE,
    fallbackDownloaders: [DOWNLOADER_IDS.HLS],
    providers: [],
  },
});
