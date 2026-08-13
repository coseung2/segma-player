// Persisted save-directory handle for silent folder writes without the
// companion native host. The picker stays in this module so the popup only
// imports a helper; the handle is granted once and then reused.

const DB_NAME = "aura-media-save-directory";
const DB_VERSION = 1;
const STORE = "handles";
const KEY = "downloadDirectory";

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

export async function getStoredSaveDirectory() {
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

export async function storeSaveDirectory(handle) {
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

export async function ensureSaveDirectory({ pick = false } = {}) {
  let handle = await getStoredSaveDirectory();
  if (!handle && pick && typeof showDirectoryPicker === "function") {
    try {
      handle = await showDirectoryPicker({ id: "aura-media-save", mode: "readwrite", startIn: "downloads" });
      if (handle) await storeSaveDirectory(handle);
    } catch (error) {
      if (error?.name === "AbortError") return null;
      throw error;
    }
  }
  if (!handle) return null;
  try {
    const state = await handle.queryPermission?.({ mode: "readwrite" });
    if (state === "granted") return handle;
    if (state === "prompt") {
      const requested = await handle.requestPermission?.({ mode: "readwrite" });
      if (requested === "granted") return handle;
    }
  } catch {
    // Permission could not be confirmed in this context; the caller decides
    // whether to open the picker again.
  }
  return null;
}
