import { DASH_ERROR_CODES, DashParseError, parseDashManifest } from "../dash.js";
import { DOWNLOADER_IDS } from "./ids.js";

function safeFilename(title, extension) {
  const safe = String(title || "DASH 영상")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 120);
  return `${safe || "DASH 영상"}.${extension}`;
}

function representationScore(representation) {
  const pixels = Number(representation?.width || 0) * Number(representation?.height || 0);
  return pixels * 1_000_000 + Number(representation?.bandwidth || 0);
}

export function chooseDashRepresentation(representations, kind) {
  return [...(Array.isArray(representations) ? representations : [])]
    .filter((representation) => representation?.kind === kind)
    .sort((left, right) => representationScore(right) - representationScore(left))[0] || null;
}

function mediaForRepresentation(representation) {
  if (!representation || !Array.isArray(representation.segments) || !representation.segments.length) {
    throw new Error(representation?.index
      ? "이 DASH 영상은 SegmentBase 인덱스 분석이 필요해 아직 저장할 수 없습니다."
      : "DASH 영상 구간을 찾지 못했습니다.");
  }
  return {
    initUrl: representation.initialization?.url || null,
    initByterange: representation.initialization?.range || null,
    segments: representation.segments.map((segment) => segment.url),
    byteranges: representation.segments.map((segment) => segment.range || null),
    keys: [],
    mediaSequence: 0,
  };
}

export function dashTracksForPlan(plan, title = "DASH 영상") {
  const tracks = [];
  const periods = Array.isArray(plan?.periods) ? plan.periods : [];
  for (let periodIndex = 0; periodIndex < periods.length; periodIndex += 1) {
    const representations = periods[periodIndex].adaptationSets
      .flatMap((adaptation) => adaptation.representations || []);
    for (const kind of ["video", "audio"]) {
      const representation = chooseDashRepresentation(representations, kind);
      if (!representation) continue;
      const suffix = `${periods.length > 1 ? `-p${periodIndex + 1}` : ""}-${kind}`;
      const extension = kind === "audio" ? "m4a" : "mp4";
      tracks.push({
        kind,
        periodIndex,
        representation,
        media: mediaForRepresentation(representation),
        title: `${title}${suffix}`,
        extension,
        filename: safeFilename(`${title}${suffix}`, extension),
      });
    }
  }
  if (!tracks.length) throw new Error("DASH 비디오·오디오 트랙을 찾지 못했습니다.");
  return tracks;
}

export function createDashDownloader(deps) {
  return Object.freeze({
    id: DOWNLOADER_IDS.DASH,
    preparedType: "dash",
    async prepare(candidate, context) {
      deps.setStatus("DASH 영상 정보를 확인하는 중…", false, context);
      const loaded = await deps.fetchText(candidate.resourceUrl, candidate.pageUrl, context);
      let plan;
      try {
        plan = parseDashManifest(loaded.text, loaded.url);
      } catch (error) {
        if (error instanceof DashParseError) {
          const wrapped = new Error(error.code === DASH_ERROR_CODES.DRM_PROTECTED
            ? "DRM으로 보호된 DASH 영상은 지원하지 않습니다."
            : `DASH 정보를 분석하지 못했습니다 (${error.code}).`);
          wrapped.code = `dash-${error.code}`;
          throw wrapped;
        }
        throw error;
      }
      const filenameTemplate = await deps.configuredFilenameTemplate();
      const tracks = dashTracksForPlan(plan, candidate.pageTitle || "DASH 영상").map((track) => ({
        ...track,
        filename: deps.filenameFromTemplate(
          filenameTemplate,
          candidate,
          track.title,
          track.extension,
          track.filename,
        ),
      }));
      await deps.ensureMediaRoutes(tracks.flatMap((track) => [
        track.media.initUrl,
        ...track.media.segments,
      ]));
      const segments = tracks.reduce((sum, track) => sum + track.media.segments.length, 0);
      deps.setStatus(`DASH 정보 확인 완료 · ${tracks.length}개 트랙 · ${segments}개 구간.`, false, context);
      return { type: "dash", downloaderId: DOWNLOADER_IDS.DASH, candidate, context, plan, tracks };
    },
    async download(prepared, { checkpointKey }) {
      const { candidate, context, dirHandle = null } = prepared;
      for (let index = 0; index < prepared.tracks.length; index += 1) {
        const track = prepared.tracks[index];
        deps.setStatus(
          `DASH ${track.kind === "audio" ? "오디오" : "비디오"} 저장 중… ${index + 1}/${prepared.tracks.length}`,
          false,
          context,
        );
        await deps.saveHlsToNative(
          track.media,
          track.filename,
          candidate.pageUrl,
          candidate.tabId,
          context,
          dirHandle,
          checkpointKey,
          `track-${index}`,
        );
      }
      return {
        statusText: prepared.tracks.length > 1
          ? `DASH 다운로드를 완료했습니다. 비디오·오디오 ${prepared.tracks.length}개 파일로 저장했습니다.`
          : "DASH 다운로드를 완료했습니다.",
      };
    },
  });
}
