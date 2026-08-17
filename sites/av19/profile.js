import { DOWNLOAD_MODES } from "../../download-mode.js";
import { DOWNLOADER_IDS } from "../../downloaders/ids.js";
import { PROVIDER_IDS } from "../../providers/ids.js";
import { defineSiteProfile } from "../profile.js";

export const av19Site = defineSiteProfile({
  id: "av19",
  hosts: ["av19t.com", "p.nnvivi.site", "k.vdnext.com"],
  primaryMode: DOWNLOAD_MODES.AUTHENTICATED_SOURCE_FRAME,
  fallbackModes: [DOWNLOAD_MODES.HLS_MANIFEST],
  modules: {
    primaryDownloader: DOWNLOADER_IDS.HLS,
    fallbackDownloaders: [],
    providers: [PROVIDER_IDS.LEVEL5, PROVIDER_IDS.HLSJS],
  },
});
