import { MEDIA_TYPES, canonicalHttpUrl, makeCandidate } from "./candidate.js";
import {
  createPlayerGraphResolver,
  isStreamtapePlayerPage,
  looksLikePlayerPage,
} from "./player-page-resolver.js";

export function createPlayerResolutionCoordinator({
  ensureRoute,
  getRedirectTarget,
  tabTitle,
  observeResource,
  replaceCandidate,
  sendTabMessage,
  now = () => Date.now(),
} = {}) {
  for (const [name, value] of Object.entries({
    ensureRoute, tabTitle, observeResource, replaceCandidate, sendTabMessage,
  })) {
    if (typeof value !== "function") throw new TypeError(`missing-player-resolution-${name}`);
  }

  // One bounded resolver is shared by observed frames, pasted links, and
  // candidate handoff. Its cache TTLs isolate navigation without global aborts.
  const resolver = createPlayerGraphResolver({ ensureRoute, getRedirectTarget });

  async function resolveObservedPlayerFrame(details) {
    if (details?.type !== "sub_frame" || !looksLikePlayerPage(details?.url)
      || !Number.isInteger(details?.tabId) || details.tabId <= 0
      || !Number.isInteger(details?.frameId) || details.frameId < 0) return null;
    const resolved = await resolver.resolve(details.url);
    if (!resolved?.url) return null;
    const title = await tabTitle(details.tabId);
    return observeResource({
      pageTitle: title,
      pageUrl: resolved.referrer || details.url,
      siteUrl: details.initiator || details.documentUrl || details.url,
      frameUrl: details.url,
      frameId: details.frameId,
      resourceUrl: resolved.url,
      contentType: resolved.type === "hls" ? "application/vnd.apple.mpegurl" : "video/mp4",
      detectionSource: "player-page-resolver",
      player: isStreamtapePlayerPage(details.url) ? "streamtape" : "player-page",
      requestType: "sub_frame",
      confidence: 100,
      observedAt: details.timeStamp,
    }, details.tabId);
  }

  function candidateContentType(candidate) {
    if (candidate?.mediaType === MEDIA_TYPES.DASH) return "application/dash+xml";
    if (candidate?.mediaType === MEDIA_TYPES.HLS_MASTER || candidate?.mediaType === MEDIA_TYPES.HLS_MEDIA) {
      return "application/vnd.apple.mpegurl";
    }
    return candidate?.mediaType === MEDIA_TYPES.PROGRESSIVE ? "video/mp4" : "";
  }

  async function refreshCandidateFromSourceFrame(candidate, { force = false } = {}) {
    if (!candidate || !Number.isInteger(candidate.tabId) || candidate.tabId <= 0
      || !Number.isInteger(candidate.frameId) || candidate.frameId < 0) return candidate;
    const shouldRefresh = force || candidate.tokenized
      || (Number.isFinite(candidate.refreshAfter) && candidate.refreshAfter <= now())
      || Boolean(candidate.player)
      || (Array.isArray(candidate.evidence)
        && candidate.evidence.some((item) => item?.source === "player-adapter"));
    if (!shouldRefresh) return candidate;
    const response = await sendTabMessage(candidate.tabId, {
      type: "refresh-media-source",
      resourceUrl: candidate.resourceUrl,
      player: candidate.player || "",
      sessionId: candidate.sessionId || "",
    }, 3_000, { frameId: candidate.frameId });
    const resourceUrl = response?.ok ? canonicalHttpUrl(response.url)?.href : null;
    if (!resourceUrl) return candidate;
    const pageUrl = canonicalHttpUrl(response.frameUrl)?.href || candidate.pageUrl;
    const observedAt = response.observedAt || now();
    const refreshed = makeCandidate({
      pageTitle: candidate.pageTitle,
      pageUrl,
      siteUrl: candidate.siteUrl || candidate.pageUrl,
      resourceUrl,
      contentType: candidateContentType(candidate),
      variants: candidate.variants || [],
      main: candidate.main,
      explicitMain: candidate.explicitMain,
      tabId: candidate.tabId,
      frameId: candidate.frameId,
      evidence: [
        ...(Array.isArray(candidate.evidence) ? candidate.evidence : []),
        {
          source: "refresh",
          player: response.player || candidate.player || "",
          sessionId: response.sessionId || candidate.sessionId || "",
          confidence: 100,
          at: observedAt,
        },
      ],
      player: response.player || candidate.player || "",
      sessionId: response.sessionId || candidate.sessionId || "",
      detectionSource: "refresh",
      confidence: 100,
      observedAt,
    });
    if (!refreshed || refreshed.mediaType !== candidate.mediaType) return candidate;
    refreshed.id = candidate.id;
    return replaceCandidate(candidate, refreshed, { nonPersistent: true });
  }

  async function resolvePlayerCandidate(candidate) {
    const fresh = await refreshCandidateFromSourceFrame(candidate);
    if (!looksLikePlayerPage(fresh?.resourceUrl)) return fresh;
    const resolved = await resolver.resolve(fresh.resourceUrl);
    if (!resolved?.url) return fresh;
    const resolvedCandidate = makeCandidate({
      pageTitle: fresh.pageTitle,
      pageUrl: resolved.referrer || fresh.pageUrl,
      siteUrl: fresh.siteUrl || fresh.pageUrl,
      resourceUrl: resolved.url,
      contentType: resolved.type === "hls" ? "application/vnd.apple.mpegurl" : "video/mp4",
      likelyAdvertisement: fresh.likelyAdvertisement,
      tabId: fresh.tabId,
      frameId: fresh.frameId,
      main: fresh.main,
      explicitMain: fresh.explicitMain,
      detectionSource: "player-page-resolver",
      confidence: 100,
      observedAt: now(),
    });
    if (!resolvedCandidate) return fresh;
    resolvedCandidate.id = fresh.id;
    return resolvedCandidate;
  }

  return Object.freeze({
    resolver,
    resolveObservedPlayerFrame,
    refreshCandidateFromSourceFrame,
    resolvePlayerCandidate,
  });
}
