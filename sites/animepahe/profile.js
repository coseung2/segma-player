import { DOWNLOAD_MODES } from "../../download-mode.js";
import { DOWNLOADER_IDS } from "../../downloaders/ids.js";
import { PROVIDER_IDS } from "../../providers/ids.js";
import { defineSiteProfile } from "../profile.js";

// AnimePahe episode pages expose the complete title in the article heading.
// The current player is an external Blogger video iframe, so its actual MP4
// requests stay on the shared progressive downloader.
export const animepaheSite = defineSiteProfile({
  id: "animepahe",
  hosts: ["animepahe.ng", "animepahe.ch"],
  primaryMode: DOWNLOAD_MODES.DIRECT_PROGRESSIVE,
  fallbackModes: [DOWNLOAD_MODES.HLS_MANIFEST, DOWNLOAD_MODES.PLAYER_PAGE_GRAPH],
  modules: {
    primaryDownloader: DOWNLOADER_IDS.PROGRESSIVE,
    fallbackDownloaders: [DOWNLOADER_IDS.HLS],
    providers: [PROVIDER_IDS.GENERIC],
  },
  titleSelectors: ["article h1", "h1"],
});
