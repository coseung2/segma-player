import { canonicalHttpUrl, isLikelyHlsSegmentUrl } from "./candidate.js";
import {
  mediaDownloadBrowserContext,
  startCompanionMediaDownload,
  startCompanionYouTubeDownload,
} from "./companion-client.js";

const YOUTUBE_QUALITIES = new Set([
  "best", "4320", "2160", "1440", "1080", "720", "480", "360", "240", "144",
]);

export function canonicalYouTubeUrl(value) {
  const url = canonicalHttpUrl(value);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")
    ? url.href
    : null;
}

export function isYouTubeDetectionCandidate(candidate) {
  // googlevideo.com also backs non-YouTube embedded players. Suppress only
  // actual YouTube page/resource candidates so those progressive streams stay visible.
  if (canonicalYouTubeUrl(candidate?.pageUrl) || canonicalYouTubeUrl(candidate?.siteUrl)) return true;
  const resource = canonicalHttpUrl(candidate?.resourceUrl);
  if (!resource) return false;
  const host = resource.hostname.toLowerCase();
  return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be";
}

export function createCompanionHandoff({
  resolveCandidate,
  randomUuid = () => crypto.randomUUID(),
  browserContext = mediaDownloadBrowserContext,
  startMedia = startCompanionMediaDownload,
  startYouTube = startCompanionYouTubeDownload,
} = {}) {
  if (typeof resolveCandidate !== "function") throw new TypeError("missing-candidate-resolver");

  async function queueMediaDownload(candidate) {
    const transferCandidate = await resolveCandidate(candidate);
    const jobId = randomUuid();
    await startMedia({
      jobId,
      candidateId: transferCandidate.id,
      url: transferCandidate.resourceUrl,
      ...(transferCandidate.pageUrl ? { referrer: transferCandidate.pageUrl } : {}),
      title: transferCandidate.pageTitle || "미디어 다운로드",
      inputKind: transferCandidate.mediaType,
      ...browserContext(),
    });
    return { mode: "media-companion", jobId };
  }

  async function beginCandidateDownload(candidate) {
    if (isLikelyHlsSegmentUrl(candidate?.resourceUrl)) throw new Error("unsupported-media");
    if (candidate?.mediaType === "PROGRESSIVE"
      || candidate?.mediaType === "HLS_MASTER"
      || candidate?.mediaType === "HLS_MEDIA"
      || candidate?.mediaType === "DASH") {
      return queueMediaDownload(candidate);
    }
    throw new Error("unsupported-media");
  }

  async function startYouTubeDownload(rawUrl, rawQuality = "best") {
    const url = canonicalYouTubeUrl(rawUrl);
    if (!url) throw new Error("invalid-youtube-url");
    const quality = String(rawQuality || "best");
    if (!YOUTUBE_QUALITIES.has(quality)) throw new Error("invalid-youtube-quality");
    const jobId = randomUuid();
    const accepted = await startYouTube({ jobId, url, quality });
    if (accepted?.accepted !== true || accepted?.jobId !== jobId) {
      const error = new Error("Segma Player가 YouTube 다운로드 작업을 수락하지 않았습니다.");
      error.code = "media-companion-start-rejected";
      throw error;
    }
    return { mode: "youtube-companion", jobId };
  }

  return Object.freeze({ beginCandidateDownload, queueMediaDownload, startYouTubeDownload });
}
