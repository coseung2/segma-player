import { DOWNLOAD_MODES } from "../../download-mode.js";
import { DOWNLOADER_IDS } from "../../downloaders/ids.js";
import { PROVIDER_IDS } from "../../providers/ids.js";
import { defineSiteProfile } from "../profile.js";

export const asianpornSite = defineSiteProfile({
  id: "asianporn",
  hosts: ["asianporn.li"],
  primaryMode: DOWNLOAD_MODES.DIRECT_PROGRESSIVE,
  fallbackModes: [DOWNLOAD_MODES.HLS_MANIFEST],
  modules: {
    primaryDownloader: DOWNLOADER_IDS.PROGRESSIVE,
    fallbackDownloaders: [DOWNLOADER_IDS.HLS],
    providers: [PROVIDER_IDS.HLSJS],
  },
});
