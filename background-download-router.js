import { MEDIA_TYPES, canonicalHttpUrl, mediaTypeForResource } from "./candidate.js";
import { looksLikePlayerPage } from "./player-page-resolver.js";

export function createDownloadRouter({
  candidates,
  ensureDirectMediaAccess,
  playerGraphResolver,
  observeResource,
  beginCandidateDownload,
} = {}) {
  if (!candidates || typeof candidates.values !== "function") throw new TypeError("missing-candidate-store");
  if (typeof ensureDirectMediaAccess !== "function") throw new TypeError("missing-route-preparer");
  if (!playerGraphResolver || typeof playerGraphResolver.resolve !== "function") throw new TypeError("missing-player-resolver");
  if (typeof observeResource !== "function") throw new TypeError("missing-candidate-observer");
  if (typeof beginCandidateDownload !== "function") throw new TypeError("missing-companion-handoff");

  async function downloadCandidate(candidateId) {
    const candidate = [...candidates.values()].find((item) => item.id === candidateId);
    if (!candidate) {
      const error = new Error("candidate-not-found");
      error.code = "candidate-not-found";
      error.candidateId = candidateId;
      throw error;
    }
    return { candidate, result: await beginCandidateDownload(candidate) };
  }

  async function downloadUrl(rawUrl) {
    const resourceUrl = canonicalHttpUrl(rawUrl);
    if (!resourceUrl) throw Object.assign(new Error("invalid-url"), { code: "invalid-url" });
    await ensureDirectMediaAccess([resourceUrl.href]);

    let targetUrl = resourceUrl.href;
    let pageReferrer = resourceUrl.href;
    let progressive = false;
    let hls = false;
    let dash = false;
    if (looksLikePlayerPage(targetUrl)) {
      const resolved = await playerGraphResolver.resolve(targetUrl);
      if (!resolved?.url) {
        throw Object.assign(new Error("player-page-unresolved"), { code: "player-page-unresolved" });
      }
      targetUrl = resolved.url;
      hls = resolved.type === "hls";
      progressive = !hls;
      pageReferrer = resolved.referrer || pageReferrer;
    } else {
      const initialType = mediaTypeForResource(resourceUrl.href);
      progressive = initialType === MEDIA_TYPES.PROGRESSIVE;
      hls = initialType === MEDIA_TYPES.HLS_MASTER || initialType === MEDIA_TYPES.HLS_MEDIA;
      dash = initialType === MEDIA_TYPES.DASH;
      if (!progressive && !hls && !dash) {
        progressive = /\.(?:mp4|webm|m4v|mp3|m4a)(?:$|[?#])/i.test(targetUrl)
          || /getfile|download|stream/i.test(targetUrl);
      }
    }

    const canonicalTarget = canonicalHttpUrl(targetUrl);
    if (!canonicalTarget) throw Object.assign(new Error("invalid-url"), { code: "invalid-url" });
    await ensureDirectMediaAccess([resourceUrl.href, pageReferrer, canonicalTarget.href]);
    const candidate = observeResource({
      pageTitle: "직접 입력한 주소",
      pageUrl: pageReferrer,
      resourceUrl: canonicalTarget.href,
      contentType: progressive ? "video/mp4"
        : dash ? "application/dash+xml" : "application/vnd.apple.mpegurl",
    });
    if (!candidate) throw Object.assign(new Error("invalid-url"), { code: "invalid-url" });
    return { candidate, result: await beginCandidateDownload(candidate) };
  }

  return Object.freeze({ downloadCandidate, downloadUrl });
}
