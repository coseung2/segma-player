import { DOWNLOAD_MODES } from "../../download-mode.js";
import { DOWNLOADER_IDS } from "../../downloaders/ids.js";
import { PROVIDER_IDS } from "../../providers/ids.js";
import { defineSiteProfile } from "../profile.js";

export const doodSite = defineSiteProfile({
  id: "dood",
  hosts: ["doodstream.com", "doodcdn.io", "d000d.com"],
  primaryMode: DOWNLOAD_MODES.AUTHENTICATED_SOURCE_FRAME,
  fallbackModes: [DOWNLOAD_MODES.PLAYER_PAGE_GRAPH, DOWNLOAD_MODES.DIRECT_PROGRESSIVE],
  modules: {
    primaryDownloader: DOWNLOADER_IDS.PROGRESSIVE,
    fallbackDownloaders: [DOWNLOADER_IDS.HLS],
    providers: [PROVIDER_IDS.DOOD],
  },
});
