import { DOWNLOAD_MODES } from "../../download-mode.js";
import { DOWNLOADER_IDS } from "../../downloaders/ids.js";
import { PROVIDER_IDS } from "../../providers/ids.js";
import { defineSiteProfile } from "../profile.js";

export const playmogoSite = defineSiteProfile({
  id: "playmogo",
  hosts: ["playmogo.com"],
  primaryMode: DOWNLOAD_MODES.PLAYER_PAGE_GRAPH,
  fallbackModes: [DOWNLOAD_MODES.AUTHENTICATED_SOURCE_FRAME, DOWNLOAD_MODES.DIRECT_PROGRESSIVE],
  modules: {
    primaryDownloader: DOWNLOADER_IDS.PROGRESSIVE,
    fallbackDownloaders: [DOWNLOADER_IDS.HLS],
    providers: [PROVIDER_IDS.DOOD],
  },
});
