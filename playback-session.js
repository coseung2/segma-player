import { canonicalHttpUrl } from "./candidate.js";

export const PLAYBACK_SESSION_LIMITS = Object.freeze({
  maxEntries: 24,
  ttlMs: 30 * 60 * 1000,
});

const SESSION_ID_RE = /^[a-f0-9-]{16,80}$/i;

function cloneValue(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function validCandidate(candidate) {
  return Boolean(candidate
    && typeof candidate === "object"
    && typeof candidate.id === "string"
    && canonicalHttpUrl(candidate.resourceUrl)
    && canonicalHttpUrl(candidate.pageUrl));
}

function candidateSnapshot(candidate) {
  if (!validCandidate(candidate)) return null;
  return {
    id: candidate.id,
    tabId: Number.isInteger(candidate.tabId) ? candidate.tabId : null,
    frameId: Number.isInteger(candidate.frameId) ? candidate.frameId : null,
    pageTitle: typeof candidate.pageTitle === "string" ? candidate.pageTitle.slice(0, 512) : "",
    pageUrl: canonicalHttpUrl(candidate.pageUrl).href,
    resourceUrl: canonicalHttpUrl(candidate.resourceUrl).href,
    mediaType: typeof candidate.mediaType === "string" ? candidate.mediaType : "UNKNOWN",
    main: candidate.main === true,
    explicitMain: candidate.explicitMain === true,
    player: typeof candidate.player === "string" ? candidate.player.slice(0, 128) : "",
    sessionId: typeof candidate.sessionId === "string" ? candidate.sessionId.slice(0, 128) : "",
    tokenized: candidate.tokenized === true,
    expiresAt: Number.isFinite(candidate.expiresAt) ? candidate.expiresAt : null,
    refreshAfter: Number.isFinite(candidate.refreshAfter) ? candidate.refreshAfter : null,
    refreshable: candidate.refreshable === true,
    likelyAdvertisement: candidate.likelyAdvertisement === true,
  };
}

function normalizedSourceUrl(value) {
  return canonicalHttpUrl(value)?.href || "";
}

function finiteTime(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function createPlaybackSessionStore({
  maxEntries = PLAYBACK_SESSION_LIMITS.maxEntries,
  ttlMs = PLAYBACK_SESSION_LIMITS.ttlMs,
  now = () => Date.now(),
  idFactory = () => crypto.randomUUID(),
} = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new TypeError("invalid-playback-session-limit");
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError("invalid-playback-session-ttl");
  if (typeof now !== "function" || typeof idFactory !== "function") {
    throw new TypeError("invalid-playback-session-factory");
  }

  const sessions = new Map();

  function currentTime() {
    const value = now();
    return Number.isFinite(value) ? value : Date.now();
  }

  function purge(at = currentTime()) {
    for (const [id, session] of sessions) {
      if (session.expiresAt <= at) sessions.delete(id);
    }
  }

  function boundedInsert(session) {
    sessions.delete(session.id);
    sessions.set(session.id, Object.freeze(session));
    while (sessions.size > maxEntries) sessions.delete(sessions.keys().next().value);
    return sessions.get(session.id);
  }

  function create(candidate, { sourceUrl = "" } = {}) {
    if (!validCandidate(candidate)) return null;
    const id = idFactory();
    if (typeof id !== "string" || !SESSION_ID_RE.test(id)) return null;
    const at = currentTime();
    purge(at);
    return boundedInsert({
      id,
      candidate: candidateSnapshot(candidate),
      sourceUrl: normalizedSourceUrl(sourceUrl),
      createdAt: at,
      lastAccessAt: at,
      expiresAt: at + ttlMs,
    });
  }

  function get(id, { touch = true } = {}) {
    if (typeof id !== "string" || !SESSION_ID_RE.test(id)) return null;
    const at = currentTime();
    purge(at);
    const current = sessions.get(id);
    if (!current) return null;
    if (!touch) return current;
    return boundedInsert({
      ...current,
      lastAccessAt: at,
      expiresAt: at + ttlMs,
    });
  }

  function updateCandidate(id, candidate, { sourceUrl } = {}) {
    if (!validCandidate(candidate)) return null;
    const current = get(id, { touch: false });
    if (!current) return null;
    const at = currentTime();
    return boundedInsert({
      ...current,
      candidate: candidateSnapshot(candidate),
      sourceUrl: sourceUrl === undefined ? current.sourceUrl : normalizedSourceUrl(sourceUrl),
      lastAccessAt: at,
      expiresAt: at + ttlMs,
    });
  }

  function remove(id) {
    return typeof id === "string" && sessions.delete(id);
  }

  function restore(values) {
    const at = currentTime();
    for (const value of Array.isArray(values) ? values : []) {
      if (!value || typeof value !== "object" || typeof value.id !== "string"
        || !SESSION_ID_RE.test(value.id) || !validCandidate(value.candidate)) continue;
      const expiresAt = finiteTime(value.expiresAt, 0);
      if (expiresAt <= at) continue;
      boundedInsert({
        id: value.id,
        candidate: candidateSnapshot(value.candidate),
        sourceUrl: normalizedSourceUrl(value.sourceUrl),
        createdAt: finiteTime(value.createdAt, at),
        lastAccessAt: finiteTime(value.lastAccessAt, at),
        expiresAt: Math.min(expiresAt, at + ttlMs),
      });
    }
    purge(at);
    return sessions.size;
  }

  function serialized() {
    purge();
    return [...sessions.values()].map((session) => cloneValue(session));
  }

  return Object.freeze({
    create,
    get,
    updateCandidate,
    remove,
    restore,
    serialized,
    purge,
    get size() { purge(); return sessions.size; },
  });
}
