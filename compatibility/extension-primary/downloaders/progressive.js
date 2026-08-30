import { DOWNLOADER_IDS } from "../../../downloaders/ids.js";

export function createProgressiveDownloader(deps) {
  return Object.freeze({
    id: DOWNLOADER_IDS.PROGRESSIVE,
    preparedType: "progressive",
    async prepare(candidate, context) {
      const fallbackFilename = deps.progressiveFilenameFor(candidate);
      const extension = /\.([a-z0-9]{2,5})$/i.exec(fallbackFilename)?.[1] || "mp4";
      const filename = deps.filenameFromTemplate(
        await deps.configuredFilenameTemplate(),
        candidate,
        candidate.pageTitle && candidate.pageTitle !== "직접 입력한 주소"
          ? candidate.pageTitle
          : fallbackFilename.replace(/\.[^.]+$/, ""),
        extension,
        fallbackFilename,
      );
      deps.setStatus("영상을 확인하는 중…", false, context);
      let session = await deps.prepareProgressiveFetch(
        await deps.progressiveSession(
          candidate.resourceUrl,
          candidate.pageUrl,
          candidate.tabId,
          context.signal,
          context.frameId,
        ),
        context,
      );
      deps.setStatus(deps.activePlan().backgroundDownloads
        ? "영상 준비 완료. 원본 페이지를 벗어나도 다운로드가 계속됩니다."
        : "영상 준비 완료. 다운로드가 끝날 때까지 원본 페이지를 열어두세요.", false, context);
      let probed = null;
      try {
        probed = await deps.probeDownloadTotalBytes(session.url, session.referrer, context);
      } catch {
        probed = null;
      }
      if (probed) {
        const contentType = String(probed.contentType || "");
        if (contentType && !/^(video|audio)\//i.test(contentType) && !/octet-stream/i.test(contentType)) {
          throw new Error("이 주소는 영상 파일이 아니라 웹페이지입니다. 실제 미디어 주소를 입력해 주세요.");
        }
        context.totalBytes = Number.isFinite(probed.total) && probed.total >= 0 ? probed.total : null;
        context.rangeSupported = probed.rangeSupported === true;
      }
      if (session.sourceFrameFallbackPreferred && context.rangeSupported) {
        session = await deps.prepareProgressiveFetch({
          ...session,
          sourceFrameFallbackPreferred: false,
          sourceFrameFallbackReason: null,
        }, context);
      }
      return {
        type: "progressive",
        downloaderId: DOWNLOADER_IDS.PROGRESSIVE,
        candidate,
        context,
        filename,
        session,
      };
    },
    async download(prepared, { checkpointKey }) {
      const { candidate, context, filename, dirHandle = null } = prepared;
      const result = await deps.saveProgressive(
        candidate.resourceUrl,
        filename,
        candidate.pageUrl,
        candidate.tabId,
        context,
        prepared.session,
        dirHandle,
        checkpointKey,
      );
      return {
        statusText: result.fallback
          ? `브라우저 기본 다운로드 폴더에 저장을 완료했습니다 (${Math.round(result.bytes / 1048576)} MB).`
          : `다운로드를 완료했습니다 (${Math.round(result.bytes / 1048576)} MB).`,
      };
    },
  });
}
