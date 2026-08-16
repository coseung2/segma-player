import { canonicalHttpUrl, normalizeOriginPath } from "./candidate.js";

const SOURCE_WEIGHTS = Object.freeze({
  "player-adapter": 48,
  "media-element": 34,
  "web-response": 30,
  "main-fetch": 28,
  "main-xhr": 28,
  "web-request": 18,
  "inline-config": 16,
  performance: 8,
  manual: 60,
  "context-menu": 60,
  refresh: 44,
  unknown: 0,
});

const AD_HOST_RE = /(?:^|\.)(?:ad[sx]?|adserver|adservice|advertising|doubleclick|googlesyndication|imasdk|vast|vpaid)(?:\.|$)/i;
const AD_PATH_RE = /(?:^|[\/_\-.])(?:ads?|advert(?:isement|ising)?|banner|ima|midroll|postroll|preroll|vast|vpaid)(?:[\/_\-.]|$)/i;
const AD_TEXT_RE = /(?:^|\b)(?:advertisement|advertising|midroll|postroll|preroll|sponsored|vast|vpaid)(?:\b|$)/i;
const FRAME_STATE_TTL_MS = 30_000;

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function boundedReason(reasons, label, points) {
  if (!points) return;
  reasons.push(Object.freeze({ label, points }));
}

function evidenceSourceWeight(evidence) {
  const source = typeof evidence?.source === "string" ? evidence.source : "unknown";
  return SOURCE_WEIGHTS[source] ?? SOURCE_WEIGHTS.unknown;
}

function strongestEvidence(candidate) {
  const evidence = Array.isArray(candidate?.evidence) ? candidate.evidence : [];
  let strongest = null;
  let strongestWeight = Number.NEGATIVE_INFINITY;
  for (const item of evidence) {
    const weight = evidenceSourceWeight(item) + Math.max(0, Math.min(100, finite(item?.confidence))) / 5;
    if (weight >= strongestWeight) {
      strongest = item;
      strongestWeight = weight;
    }
  }
  return { strongest, strongestWeight: Number.isFinite(strongestWeight) ? strongestWeight : 0 };
}

export function candidateLooksLikeAdvertisement(candidate, frameLayout = null) {
  if (candidate?.likelyAdvertisement || frameLayout?.adHint) return true;
  const resource = canonicalHttpUrl(candidate?.resourceUrl);
  const page = canonicalHttpUrl(candidate?.pageUrl);
  const title = String(candidate?.pageTitle || "");
  return Boolean(
    (resource && (AD_HOST_RE.test(resource.hostname) || AD_PATH_RE.test(resource.pathname)))
    || (page && (AD_HOST_RE.test(page.hostname) || AD_PATH_RE.test(page.pathname)))
    || AD_TEXT_RE.test(title),
  );
}

function frameLayoutForCandidate(candidate, frameLayouts) {
  if (!frameLayouts || typeof frameLayouts.get !== "function") return null;
  const key = normalizeOriginPath(candidate?.pageUrl);
  return key ? frameLayouts.get(key) || null : null;
}

function frameStateForCandidate(candidate, frameStates) {
  if (!frameStates || typeof frameStates.get !== "function") return null;
  return Number.isInteger(candidate?.frameId) ? frameStates.get(candidate.frameId) || null : null;
}

export function scoreCandidate(candidate, {
  frameStates = null,
  frameLayouts = null,
  now = Date.now(),
} = {}) {
  const reasons = [];
  let score = 0;
  const { strongest, strongestWeight } = strongestEvidence(candidate);
  score += strongestWeight;
  boundedReason(reasons, strongest?.source || "unknown-source", Math.round(strongestWeight));

  const evidence = Array.isArray(candidate?.evidence) ? candidate.evidence : [];
  const distinctSources = new Set(evidence.map((item) => item?.source).filter(Boolean)).size;
  const corroboration = Math.min(18, Math.max(0, distinctSources - 1) * 6);
  score += corroboration;
  boundedReason(reasons, "corroborated", corroboration);

  const playerEvidence = evidence.find((item) => item?.player);
  if (playerEvidence) {
    score += 12;
    boundedReason(reasons, `player:${playerEvidence.player}`, 12);
  }

  if (candidate?.explicitMain) {
    score += 18;
    boundedReason(reasons, "explicit-main", 18);
  }

  if (candidate?.mediaType === "HLS_MASTER" || candidate?.mediaType === "HLS_MEDIA") {
    score += 10;
    boundedReason(reasons, "manifest", 10);
  } else if (candidate?.mediaType === "DASH") {
    score += 9;
    boundedReason(reasons, "manifest", 9);
  } else if (candidate?.mediaType === "PROGRESSIVE") {
    score += 5;
    boundedReason(reasons, "direct-media", 5);
  }

  const observedFrameState = frameStateForCandidate(candidate, frameStates);
  const frameStateAgeMs = observedFrameState
    ? Math.max(0, finite(now) - finite(observedFrameState.observedAt, finite(now)))
    : Number.POSITIVE_INFINITY;
  const frameState = frameStateAgeMs <= FRAME_STATE_TTL_MS ? observedFrameState : null;
  if (frameState) {
    if (frameState.playing) {
      score += 44;
      boundedReason(reasons, "frame-playing", 44);
    }
    const area = finite(frameState.visibleArea);
    const viewportRatio = finite(frameState.viewportRatio);
    let areaScore = 0;
    if (viewportRatio >= 0.45 || area >= 900_000) areaScore = 24;
    else if (viewportRatio >= 0.2 || area >= 300_000) areaScore = 17;
    else if (viewportRatio >= 0.05 || area >= 60_000) areaScore = 8;
    score += areaScore;
    boundedReason(reasons, "visible-player-area", areaScore);

    const durationMs = finite(frameState.durationMs);
    let durationScore = 0;
    if (durationMs >= 10 * 60_000) durationScore = 18;
    else if (durationMs >= 2 * 60_000) durationScore = 13;
    else if (durationMs >= 30_000) durationScore = 7;
    else if (durationMs > 0 && durationMs < 12_000) durationScore = -18;
    score += durationScore;
    boundedReason(reasons, "duration", durationScore);

    if (frameState.playing && frameState.muted) {
      score -= 8;
      boundedReason(reasons, "muted-autoplay", -8);
    }
    if (frameState.topFrame) {
      score += 16;
      boundedReason(reasons, "top-frame", 16);
    }
  } else if (candidate?.frameId === 0) {
    score += 10;
    boundedReason(reasons, "top-frame", 10);
  }

  const layout = frameLayoutForCandidate(candidate, frameLayouts);
  if (layout) {
    const ratio = finite(layout.viewportRatio);
    let layoutScore = 0;
    if (ratio >= 0.45) layoutScore = 16;
    else if (ratio >= 0.2) layoutScore = 10;
    else if (ratio >= 0.05) layoutScore = 4;
    score += layoutScore;
    boundedReason(reasons, "iframe-area", layoutScore);
  }

  const observedAt = finite(candidate?.lastObservedAt, Date.parse(candidate?.detectedAt || ""));
  if (Number.isFinite(observedAt) && observedAt > 0) {
    const ageMs = Math.max(0, finite(now) - observedAt);
    const recency = ageMs <= 15_000 ? 8 : ageMs <= 60_000 ? 4 : 0;
    score += recency;
    boundedReason(reasons, "recent", recency);
  }

  const advertisement = candidateLooksLikeAdvertisement(candidate, layout);
  if (advertisement) {
    score -= 90;
    boundedReason(reasons, "advertisement-signals", -90);
  }

  if (candidate?.tokenized && candidate?.expiresAt && candidate.expiresAt <= finite(now) + 15_000) {
    score -= 10;
    boundedReason(reasons, "url-near-expiry", -10);
  }

  return Object.freeze({
    score: Math.round(score),
    advertisement,
    reasons: Object.freeze(reasons.slice(0, 12)),
  });
}

function samePlaybackGroup(left, right) {
  if (!left || !right || left.tabId !== right.tabId) return false;
  if (Number.isInteger(left.frameId) && Number.isInteger(right.frameId) && left.frameId === right.frameId) {
    return true;
  }
  const leftSession = String(left.sessionId || "");
  const rightSession = String(right.sessionId || "");
  return Boolean(leftSession && leftSession === rightSession && left.player === right.player);
}

export function rankCandidates(candidates, context = {}) {
  const list = Array.isArray(candidates) ? candidates : [...(candidates || [])];
  const ranked = list.map((candidate) => {
    const result = scoreCandidate(candidate, context);
    candidate.score = result.score;
    candidate.scoreReasons = result.reasons;
    candidate.likelyAdvertisement = Boolean(candidate.likelyAdvertisement || result.advertisement);
    candidate.classification = result.advertisement ? "advertisement" : "alternate";
    candidate.main = false;
    return candidate;
  }).sort((left, right) => (finite(right.score) - finite(left.score))
    || (finite(right.lastObservedAt) - finite(left.lastObservedAt)));

  const downloadable = ranked.filter((candidate) => ["PROGRESSIVE", "HLS_MASTER", "HLS_MEDIA", "DASH"].includes(candidate.mediaType));
  const nonAds = downloadable.filter((candidate) => !candidate.likelyAdvertisement);
  const primary = nonAds[0] || downloadable[0] || null;
  if (primary) {
    primary.main = true;
    primary.classification = primary.likelyAdvertisement ? "advertisement" : "primary";
    for (const candidate of downloadable) {
      if (candidate === primary || candidate.likelyAdvertisement) continue;
      if (samePlaybackGroup(candidate, primary) && finite(candidate.score) >= finite(primary.score) - 8) {
        candidate.main = true;
        candidate.classification = "primary";
      }
    }
  }
  return ranked;
}
