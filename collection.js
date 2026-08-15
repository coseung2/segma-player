// Saved playback collection: the extension-side equivalent of the AVSUBS
// batch-file library. Entries stay playable as long as the media URL lives;
// the subtitle is re-matched by media identifier on every play.

const STORAGE_KEY = "auraCollection";
export const COLLECTION_CAP = 500;

export function mergeCollection(list, entry, cap = COLLECTION_CAP) {
  const normalized = Array.isArray(list) ? list : [];
  const url = typeof entry?.url === "string" ? entry.url : "";
  if (!url) return normalized;
  const rest = normalized.filter((item) => item?.url !== url);
  const next = [
    {
      url,
      title: typeof entry.title === "string" ? entry.title.slice(0, 240) : "",
      savedAt: typeof entry.savedAt === "number" ? entry.savedAt : Date.now(),
    },
    ...rest,
  ];
  return next.slice(0, cap);
}

export async function listCollection() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
  } catch {
    return [];
  }
}

export async function addToCollection(entry) {
  const next = mergeCollection(await listCollection(), entry);
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

export async function removeFromCollection(url) {
  const current = await listCollection();
  const next = current.filter((item) => item?.url !== url);
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}
