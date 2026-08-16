// Subtitle folder handle storage. FileSystem handles cannot be JSON
// serialized, so the handle lives in IndexedDB (same pattern as the media
// save directory) and is shared by the popup addon and the folder picker page.

const DB_NAME = "aura-subtitle-directory";
const DB_VERSION = 1;
const STORE = "handles";
const KEY = "subtitleDirectory";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getStoredSubtitleDirectory() {
  try {
    const db = await openDb();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    return value || null;
  } catch {
    return null;
  }
}

export async function storeSubtitleDirectory(handle) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(handle, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch {
    return false;
  }
}

// A handle selected by earlier versions was read-only. Keep playback's read
// path untouched, but let the player request write access only when saving a
// generated SRT from a user action.
export async function ensureStoredSubtitleDirectory({ requestPermission = false } = {}) {
  const handle = await getStoredSubtitleDirectory();
  if (!handle) return null;
  try {
    const state = await handle.queryPermission?.({ mode: "readwrite" });
    if (state === "granted") return handle;
    if (requestPermission && state === "prompt") {
      return (await handle.requestPermission?.({ mode: "readwrite" })) === "granted" ? handle : null;
    }
  } catch {
    // The caller treats an unavailable handle as a non-fatal save failure.
  }
  return null;
}
