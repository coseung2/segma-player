import { DOWNLOAD_MODES } from "../../download-mode.js";
import { DOWNLOADER_IDS } from "../../downloaders/ids.js";
import { PROVIDER_IDS } from "../../providers/ids.js";
import { defineSiteProfile } from "../profile.js";

// Zoro was successively branded as AniWatch and HiAnime. Keep the last
// documented official host family under one stable site id so old bookmarks
// and any restored domains retain the same detection policy.
export const zoroSite = defineSiteProfile({
  id: "zoro",
  hosts: [
    "zoro.to",
    "z.to",
    "z.is",
    "aniwatch.to",
    "hianime.to",
    "hianime.nz",
    "hianime.bz",
    "hianime.do",
    "hianime.pe",
    "hianime.cx",
    "hianime.tv",
    "hianime.me",
  ],
  primaryMode: DOWNLOAD_MODES.PLAYER_API,
  fallbackModes: [DOWNLOAD_MODES.HLS_MANIFEST, DOWNLOAD_MODES.PLAYER_PAGE_GRAPH, DOWNLOAD_MODES.DIRECT_PROGRESSIVE],
  modules: {
    primaryDownloader: DOWNLOADER_IDS.HLS,
    fallbackDownloaders: [DOWNLOADER_IDS.PROGRESSIVE, DOWNLOADER_IDS.DASH],
    providers: [PROVIDER_IDS.PLAYER_API, PROVIDER_IDS.HLSJS, PROVIDER_IDS.GENERIC],
  },
  titleSelectors: [
    ".film-name.dynamic-name",
    ".ani_detail-stage .film-name",
    "h1.film-name",
    "h1",
  ],
});
