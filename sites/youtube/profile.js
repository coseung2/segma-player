import { DOWNLOAD_MODES } from "../../download-mode.js";
import { DOWNLOADER_IDS } from "../../downloaders/ids.js";
import { defineSiteProfile } from "../profile.js";

export const youtubeSite = defineSiteProfile({
  id: "youtube",
  hosts: ["youtube.com", "youtu.be"],
  primaryMode: DOWNLOAD_MODES.REMOTE_SERVICE,
  fallbackModes: [],
  modules: {
    primaryDownloader: DOWNLOADER_IDS.REMOTE_SERVICE,
    fallbackDownloaders: [],
    providers: [],
  },
});
