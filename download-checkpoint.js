// Durable per-download checkpoints so an interrupted job can resume from the
// last committed byte offset instead of restarting. Saved in
// chrome.storage.local so the state survives service-worker and browser
// restarts; cleared when the download completes or the user cancels it.
//
// A download is identified by a stable checkpoint key (e.g. the detected
// candidate id) plus a scope ("main" for single-file downloads, "track-N" for
// DASH tracks) so retries and multi-track jobs keep one shared record.

const CHECKPOINT_KEY_PREFIX = "downloadCheckpoint:";

function checkpointStorageKey(key) {
  return `${CHECKPOINT_KEY_PREFIX}${key}`;
}

function sanitizeCheckpoint(value) {
  if (!value || typeof value !== "object") return null;
  const filename = typeof value.filename === "string" && value.filename ? value.filename : "";
  const bytesWritten = Number.isFinite(value.bytesWritten) && value.bytesWritten >= 0
    ? Math.floor(value.bytesWritten)
    : 0;
  const resumeFromSegment = Number.isInteger(value.resumeFromSegment) && value.resumeFromSegment >= 0
    ? value.resumeFromSegment
    : 0;
  if (!filename) return null;
  return Object.freeze({
    filename,
    bytesWritten,
    resumeFromSegment,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
  });
}

async function readScopes(storageKey) {
  const stored = await chrome.storage.local.get(storageKey);
  const value = stored?.[storageKey];
  return value && typeof value === "object" ? { ...value } : {};
}

export async function getDownloadCheckpoint(key, scope = "main") {
  if (typeof key !== "string" || !key) return null;
  try {
    const scopes = await readScopes(checkpointStorageKey(key));
    return sanitizeCheckpoint(scopes[String(scope || "main")]);
  } catch {
    return null;
  }
}

export async function setDownloadCheckpoint(key, scope = "main", checkpoint) {
  if (typeof key !== "string" || !key) return false;
  const sanitized = sanitizeCheckpoint(checkpoint);
  if (!sanitized) return false;
  try {
    const storageKey = checkpointStorageKey(key);
    const scopes = await readScopes(storageKey);
    scopes[String(scope || "main")] = sanitized;
    await chrome.storage.local.set({ [storageKey]: scopes });
    return true;
  } catch {
    return false;
  }
}

export async function clearDownloadCheckpoint(key, scope = "main") {
  if (typeof key !== "string" || !key) return false;
  try {
    const storageKey = checkpointStorageKey(key);
    const scopes = await readScopes(storageKey);
    const scopeKey = String(scope || "main");
    if (!(scopeKey in scopes)) return false;
    delete scopes[scopeKey];
    if (Object.keys(scopes).length) await chrome.storage.local.set({ [storageKey]: scopes });
    else await chrome.storage.local.remove(storageKey);
    return true;
  } catch {
    return false;
  }
}

export async function clearAllDownloadCheckpoints(key) {
  if (typeof key !== "string" || !key) return false;
  try {
    await chrome.storage.local.remove(checkpointStorageKey(key));
    return true;
  } catch {
    return false;
  }
}

export async function moveDownloadCheckpoints(fromKey, toKey) {
  if (typeof fromKey !== "string" || !fromKey || typeof toKey !== "string" || !toKey || fromKey === toKey) {
    return false;
  }
  try {
    const fromStorageKey = checkpointStorageKey(fromKey);
    const stored = await chrome.storage.local.get(fromStorageKey);
    const value = stored?.[fromStorageKey];
    if (!value || typeof value !== "object") return false;
    await chrome.storage.local.set({ [checkpointStorageKey(toKey)]: value });
    await chrome.storage.local.remove(fromStorageKey);
    return true;
  } catch {
    return false;
  }
}
