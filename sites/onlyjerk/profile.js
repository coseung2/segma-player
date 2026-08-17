import { DOWNLOAD_MODES } from "../../download-mode.js";
import { DOWNLOADER_IDS } from "../../downloaders/ids.js";
import { PROVIDER_IDS } from "../../providers/ids.js";
import { defineSiteProfile } from "../profile.js";

export const onlyjerkSite = defineSiteProfile({
  id: "onlyjerk",
  hosts: ["onlyjerk.net"],
  primaryMode: DOWNLOAD_MODES.PLAYER_API,
  fallbackModes: [DOWNLOAD_MODES.HLS_MANIFEST],
  modules: {
    primaryDownloader: DOWNLOADER_IDS.HLS,
    fallbackDownloaders: [],
    providers: [PROVIDER_IDS.PLAYER_API, PROVIDER_IDS.HLSJS],
  },
});
