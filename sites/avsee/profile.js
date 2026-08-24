import { DOWNLOAD_MODES } from "../../download-mode.js";
import { DOWNLOADER_IDS } from "../../downloaders/ids.js";
import { PROVIDER_IDS } from "../../providers/ids.js";
import { defineSiteProfile } from "../profile.js";

// AVsee board pages put only the board code in `<title>` ("MFC-361") and the
// real media title in the post heading ("MFC-361 さな - 사나"). The player is a
// same-origin `/player/player.php` iframe whose own `<title>` is the generic
// "AVseeTV player", so a candidate detected inside that frame must take the
// parent document's title rather than the frame's.
export const avseeSite = defineSiteProfile({
  id: "avsee",
  hosts: [
    "avsee.is",
    "01.avsee.is",
    "avsee.tv",
    "www.avsee.tv",
  ],
  primaryMode: DOWNLOAD_MODES.DIRECT_PROGRESSIVE,
  fallbackModes: [DOWNLOAD_MODES.PLAYER_PAGE_GRAPH, DOWNLOAD_MODES.HLS_MANIFEST],
  modules: {
    primaryDownloader: DOWNLOADER_IDS.PROGRESSIVE,
    fallbackDownloaders: [DOWNLOADER_IDS.HLS],
    providers: [PROVIDER_IDS.GENERIC],
  },
  // Verified against the live page: the full title is the first `h2` inside
  // `div.view-content` (`<h2>MFC-361 さな - 사나</h2>`). The remaining entries are
  // layout fallbacks, ordered most specific first.
  titleSelectors: [
    ".view-content h2",
    "[itemprop='description'] h2",
    "#bo_v_con h2",
    ".view_title h2",
  ],
  playerFramePaths: ["/player/player.php"],
});
