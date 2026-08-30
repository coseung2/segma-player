import {
  LIMITS,
  isImageResourceUrl,
  makeCandidate,
  normalizeOriginPath,
  upsertCandidate,
} from "./candidate.js";
import { rankCandidates } from "./candidate-ranking.js";
import { looksLikePlayerPage } from "./player-page-resolver.js";

export function createCandidateRepository({
  storageSession = null,
  persistenceKey = "candidates",
  ignoreCandidate = () => false,
  onCandidate = () => {},
  now = () => Date.now(),
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancelSchedule = (handle) => clearTimeout(handle),
} = {}) {
  const candidates = new Map();
  const mainFramesByTab = new Map();
  const frameLayoutsByTab = new Map();
  const frameStatesByTab = new Map();
  const nonPersistentCandidates = new WeakSet();
  let persistTimer = null;

  function playerCandidateHasQuery(candidate) {
    if (!looksLikePlayerPage(candidate?.pageUrl)) return false;
    try { return Boolean(new URL(candidate.resourceUrl).search); } catch { return false; }
  }

  function isMainFrame(tabId, frameUrl) {
    if (!tabId || !frameUrl) return false;
    const frames = mainFramesByTab.get(tabId);
    if (!frames || frames.size === 0) return false;
    const key = normalizeOriginPath(frameUrl);
    return key ? frames.has(key) : false;
  }

  function rerankTabCandidates(tabId) {
    if (!Number.isInteger(tabId) || tabId <= 0) return [];
    const tabCandidates = [...candidates.values()].filter((candidate) => candidate.tabId === tabId);
    return rankCandidates(tabCandidates, {
      frameStates: frameStatesByTab.get(tabId) || null,
      frameLayouts: frameLayoutsByTab.get(tabId) || null,
      now: now(),
    });
  }

  function persistCandidates() {
    if (!storageSession?.set) return;
    if (persistTimer !== null) cancelSchedule(persistTimer);
    persistTimer = schedule(() => {
      persistTimer = null;
      try {
        const snapshot = [...candidates.values()]
          .filter((candidate) => !nonPersistentCandidates.has(candidate));
        void storageSession.set({ [persistenceKey]: snapshot }).catch(() => {});
      } catch {
        // Session storage can be unavailable briefly while the worker restarts.
      }
    }, 300);
  }

  function observeCandidate(candidate, { nonPersistent = false } = {}) {
    if (!candidate || ignoreCandidate(candidate)) return null;
    void onCandidate(candidate);
    const stored = upsertCandidate(candidates, candidate, LIMITS.candidates);
    if (nonPersistent || stored.tokenized || playerCandidateHasQuery(stored)) {
      nonPersistentCandidates.add(stored);
    }
    if (Number.isInteger(stored.tabId)) rerankTabCandidates(stored.tabId);
    persistCandidates();
    return stored;
  }

  function observeResource(input, tabId) {
    const candidate = makeCandidate({ ...input, tabId: tabId || null });
    if (!candidate) return null;
    if (!candidate.main && isMainFrame(tabId, input.frameUrl)) candidate.main = true;
    return observeCandidate(candidate);
  }

  function replaceCandidate(candidate, replacement, options = { nonPersistent: true }) {
    if (!candidate || !replacement) return replacement || candidate || null;
    for (const [key, item] of candidates) {
      if (item === candidate || item.id === candidate.id) candidates.delete(key);
    }
    return observeCandidate(replacement, options) || replacement;
  }

  function clearTab(tabId, { persist = true } = {}) {
    mainFramesByTab.delete(tabId);
    frameLayoutsByTab.delete(tabId);
    frameStatesByTab.delete(tabId);
    for (const [key, item] of candidates) {
      if (item.tabId === tabId) candidates.delete(key);
    }
    if (persist) persistCandidates();
  }

  async function restore() {
    if (!storageSession?.get) return 0;
    try {
      const result = await storageSession.get({ [persistenceKey]: [] });
      const saved = result?.[persistenceKey];
      if (!Array.isArray(saved)) return 0;
      let restoredCount = 0;
      for (const item of saved) {
        if (isImageResourceUrl(item?.resourceUrl) || ignoreCandidate(item)) continue;
        const restored = upsertCandidate(candidates, item, LIMITS.candidates);
        if (playerCandidateHasQuery(restored)) nonPersistentCandidates.add(restored);
        restoredCount += 1;
      }
      return restoredCount;
    } catch {
      return 0;
    }
  }

  return Object.freeze({
    candidates,
    mainFramesByTab,
    frameLayoutsByTab,
    frameStatesByTab,
    isMainFrame,
    observeCandidate,
    observeResource,
    replaceCandidate,
    rerankTabCandidates,
    persistCandidates,
    clearTab,
    restore,
  });
}
