import { DOWNLOAD_MODES } from "../../download-mode.js";
import { DOWNLOADER_IDS } from "../../downloaders/ids.js";
import { PROVIDER_IDS } from "../../providers/ids.js";
import { defineSiteProfile } from "../profile.js";

// Episode pages keep the complete episode title in the article heading while
// the actual stream is behind the same-origin `/player/` iframe.
export const gogoanimeSite = defineSiteProfile({
  id: "gogoanime",
  hosts: ["gogoanime.by"],
  primaryMode: DOWNLOAD_MODES.HLS_MANIFEST,
  fallbackModes: [DOWNLOAD_MODES.PLAYER_PAGE_GRAPH],
  modules: {
    primaryDownloader: DOWNLOADER_IDS.HLS,
    fallbackDownloaders: [DOWNLOADER_IDS.PROGRESSIVE],
    providers: [PROVIDER_IDS.GENERIC],
  },
  titleSelectors: ["article h1", "h1"],
  playerFramePaths: ["/player/"],
});
