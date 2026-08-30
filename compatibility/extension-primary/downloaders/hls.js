import { hlsFileExtension } from "../hls.js";
import { DOWNLOADER_IDS } from "../../../downloaders/ids.js";

export function createHlsDownloader(deps) {
  return Object.freeze({
    id: DOWNLOADER_IDS.HLS,
    preparedType: "hls",
    async prepare(candidate, context) {
      deps.setStatus("영상 정보를 확인하는 중…", false, context);
      let media;
      try {
        media = await deps.loadMediaPlaylist(candidate.resourceUrl, 0, candidate.pageUrl, context);
      } catch (error) {
        if (!deps.refreshableHttpFailure(error)) throw error;
        const refreshedCandidate = await deps.requestFreshDownloadCandidate(context);
        if (!refreshedCandidate) throw error;
        Object.assign(candidate, refreshedCandidate);
        Object.assign(context.candidate, refreshedCandidate);
        media = await deps.loadMediaPlaylist(candidate.resourceUrl, 0, candidate.pageUrl, context);
      }
      const extension = hlsFileExtension(media.initUrl, media.segments);
      const filename = deps.filenameFromTemplate(
        await deps.configuredFilenameTemplate(),
        candidate,
        candidate.pageTitle,
        extension,
        deps.filenameFor(candidate.pageTitle, extension),
      );
      deps.setStatus(`영상 정보 확인 완료 (${media.segments.length}개 구간).`, false, context);
      await deps.prepareHlsKeys(media, candidate.pageUrl, candidate.tabId, context);
      return {
        type: "hls",
        downloaderId: DOWNLOADER_IDS.HLS,
        candidate,
        context,
        filename,
        media,
      };
    },
    async download(prepared, { checkpointKey }) {
      const { candidate, context, filename, dirHandle = null } = prepared;
      await deps.saveHlsToNative(
        prepared.media,
        filename,
        candidate.pageUrl,
        candidate.tabId,
        context,
        dirHandle,
        checkpointKey,
      );
      return { statusText: "다운로드를 완료했습니다. 저장 폴더에서 확인하세요." };
    },
  });
}
