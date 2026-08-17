import { DOWNLOAD_MODES } from "../../download-mode.js";
import { DOWNLOADER_IDS } from "../../downloaders/ids.js";
import { PROVIDER_IDS } from "../../providers/ids.js";
import { defineSiteProfile } from "../profile.js";

export const missavSite = defineSiteProfile({
  id: "missav",
  hosts: ["missav123.com"],
  primaryMode: DOWNLOAD_MODES.HLS_MANIFEST,
  fallbackModes: [DOWNLOAD_MODES.PLAYER_API, DOWNLOAD_MODES.AUTHENTICATED_SOURCE_FRAME],
  modules: {
    primaryDownloader: DOWNLOADER_IDS.HLS,
    fallbackDownloaders: [DOWNLOADER_IDS.PROGRESSIVE],
    providers: [PROVIDER_IDS.HLSJS, PROVIDER_IDS.PLAYER_API],
  },
});
