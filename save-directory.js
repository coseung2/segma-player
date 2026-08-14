// Persisted save-directory handle for silent folder writes without the
// companion native host. The picker stays in this module so the popup only
// imports a helper; callers pass `pick: true` when they want the user to
// choose a new folder, and the stored handle is then reused silently.

const DB_NAME = "aura-media-save-directory";
const DB_VERSION = 1;
const STORE = "handles";
const KEY = "downloadDirectory";
let fileAllocationTail = Promise.resolve();

function numberedFilename(filename, index) {
  if (index === 0) return filename;
  const dot = filename.lastIndexOf(".");
  const hasExtension = dot > 0;
  const stem = hasExtension ? filename.slice(0, dot) : filename;
  const extension = hasExtension ? filename.slice(dot) : "";
  return `${stem} (${index})${extension}`;
}

async function fileExists(directoryHandle, filename) {
  try {
    await directoryHandle.getFileHandle(filename);
    return true;
  } catch (error) {
    if (error?.name === "NotFoundError") return false;
    throw error;
  }
}

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

// The File System Access API has no exclusive-create flag. Serialize name
// allocation in this extension context, check existing entries, then create a
// numbered sibling so an existing download is never opened for replacement.
export async function createUniqueFile(directoryHandle, filename) {
  if (!directoryHandle || typeof directoryHandle.getFileHandle !== "function") {
    throw new Error("invalid-save-directory");
  }
  const requested = String(filename || "미디어.mp4").trim() || "미디어.mp4";
  const previous = fileAllocationTail;
  let release;
  fileAllocationTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    for (let index = 0; index < 10_000; index += 1) {
      const candidate = numberedFilename(requested, index);
      if (await fileExists(directoryHandle, candidate)) continue;
      const fileHandle = await directoryHandle.getFileHandle(candidate, { create: true });
      return { fileHandle, filename: candidate };
    }
    throw new Error("available-filename-not-found");
  } finally {
    release();
  }
}

async function confirmReadWritePermission(handle) {
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

// Returns whether the handle can write right now in *this* context. The
// offscreen download worker uses this before creating files because it cannot
// request permission on its own; a popup/grant made elsewhere must already be
// in effect for the stored handle.
export async function hasReadWritePermission(handle) {
  try {
    return await handle?.queryPermission?.({ mode: "readwrite" }) === "granted";
  } catch {
    return false;
  }
}

export async function ensureSaveDirectory({ pick = false } = {}) {
  if (pick && typeof showDirectoryPicker === "function") {
    let handle = null;
    try {
      handle = await showDirectoryPicker({ id: "aura-media-save", mode: "readwrite", startIn: "downloads" });
    } catch (error) {
      if (error?.name === "AbortError") return null;
      throw error;
    }
    if (!handle) return null;
    await storeSaveDirectory(handle);
    return confirmReadWritePermission(handle);
  }

  const handle = await getStoredSaveDirectory();
  if (!handle) return null;
  const granted = await confirmReadWritePermission(handle);
  if (granted) await storeSaveDirectory(granted);
  return granted;
}
