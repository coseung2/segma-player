// Saved playback collection backed by the browser bookmark folder, so it
// lives wherever bookmarks live and syncs with the browser account. The
// Chrome bookmark roots have stable ids: 0 root, 1 bar, 2 other, 3 mobile.
// When the bookmarks API is unavailable (no permission), entries fall back
// to local storage so the UI still works.

import { resolveEdition } from "./license.js";

const STORAGE_KEY = "auraCollection";
export const COLLECTION_CAP = 500;
export const COLLECTION_FOLDER_TITLE = "Aura Media";
const OTHER_BOOKMARKS_ID = "2";

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

function bookmarkToEntry(node) {
  const parsed = parseCollectionBookmarkUrl(node.url);
  return {
    id: node.id,
    url: parsed?.mediaUrl || node.url,
    title: parsed?.title || node.title || "",
    bookmarkUrl: node.url,
    savedAt: typeof node.dateAdded === "number" ? node.dateAdded : Date.now(),
  };
}

export function buildCollectionBookmarkUrl(mediaUrl, title = "", playerUrl = null) {
  const baseUrl = playerUrl || globalThis.chrome?.runtime?.getURL?.("player.html");
  if (!baseUrl) return mediaUrl;
  const params = new URLSearchParams({ collection: "1", url: mediaUrl });
  if (title) params.set("title", title.slice(0, 240));
  return `${baseUrl}?${params.toString()}`;
}

export function parseCollectionBookmarkUrl(value) {
  try {
    const parsed = new URL(value);
    if (!(parsed.protocol === "chrome-extension:" || parsed.protocol === "moz-extension:")) return null;
    if (parsed.pathname !== "/player.html" || parsed.searchParams.get("collection") !== "1") return null;
    const mediaUrl = parsed.searchParams.get("url") || "";
    if (!/^https?:$/i.test(new URL(mediaUrl).protocol)) return null;
    return {
      mediaUrl,
      title: parsed.searchParams.get("title") || "",
    };
  } catch {
    return null;
  }
}

function bookmarkMediaUrl(value) {
  return parseCollectionBookmarkUrl(value)?.mediaUrl || value;
}

async function findOrCreateFolder(bookmarks) {
  try {
    const children = await bookmarks.getChildren(OTHER_BOOKMARKS_ID);
    const existing = children.find((node) => !node.url && node.title === COLLECTION_FOLDER_TITLE);
    if (existing) return existing.id;
    const created = await bookmarks.create({
      parentId: OTHER_BOOKMARKS_ID,
      title: COLLECTION_FOLDER_TITLE,
    });
    return created.id;
  } catch {
    return null;
  }
}

async function folderEntries(bookmarks) {
  const folderId = await findOrCreateFolder(bookmarks);
  if (!folderId) return null;
  const children = await bookmarks.getChildren(folderId);
  const entries = [];
  for (const node of children.filter((item) => typeof item.url === "string")) {
    const entry = bookmarkToEntry(node);
    if (!parseCollectionBookmarkUrl(node.url)) {
      const bookmarkUrl = buildCollectionBookmarkUrl(entry.url, entry.title);
      if (bookmarkUrl !== node.url) {
        await bookmarks.update(node.id, { url: bookmarkUrl }).catch(() => null);
        entry.bookmarkUrl = bookmarkUrl;
      }
    }
    entries.push(entry);
  }
  return entries;
}

export function createBookmarkCollection(bookmarks) {
  const hasApi = Boolean(bookmarks?.getChildren && bookmarks?.create && bookmarks?.remove);
  return {
    supported: hasApi,
    async list() {
      if (!hasApi) return null;
      const entries = await folderEntries(bookmarks);
      return entries || null;
    },
    async add(entry) {
      if (!hasApi) return null;
      const url = typeof entry?.url === "string" ? entry.url : "";
      if (!url) return null;
      const title = typeof entry.title === "string" ? entry.title.slice(0, 240) : "";
      const bookmarkUrl = buildCollectionBookmarkUrl(url, title);
      const folderId = await findOrCreateFolder(bookmarks);
      if (!folderId) return null;
      const existing = (await bookmarks.getChildren(folderId))
        .find((node) => bookmarkMediaUrl(node.url) === url);
      if (existing) {
        if (title && title !== existing.title) {
          await bookmarks.update(existing.id, { title, url: bookmarkUrl }).catch(() => null);
        } else if (existing.url !== bookmarkUrl) {
          await bookmarks.update(existing.id, { url: bookmarkUrl }).catch(() => null);
        }
        await bookmarks.move(existing.id, { parentId: folderId, index: 0 }).catch(() => null);
        return existing.id;
      }
      const created = await bookmarks.create({
        parentId: folderId,
        index: 0,
        title,
        url: bookmarkUrl,
      });
      return created.id;
    },
    async remove(url) {
      if (!hasApi) return false;
      const folderId = await findOrCreateFolder(bookmarks);
      if (!folderId) return false;
      const existing = (await bookmarks.getChildren(folderId))
        .find((node) => bookmarkMediaUrl(node.url) === url);
      if (!existing) return false;
      await bookmarks.remove(existing.id);
      return true;
    },
  };
}

function storageFallback() {
  return {
    supported: true,
    async list() {
      try {
        const stored = await chrome.storage.local.get(STORAGE_KEY);
        return Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
      } catch {
        return [];
      }
    },
    async add(entry) {
      const next = mergeCollection(await this.list(), entry);
      await chrome.storage.local.set({ [STORAGE_KEY]: next });
      return next;
    },
    async remove(url) {
      const current = await this.list();
      const next = current.filter((item) => item?.url !== url);
      await chrome.storage.local.set({ [STORAGE_KEY]: next });
      return true;
    },
  };
}

export async function getCollection() {
  if ((await resolveEdition()) !== "pro") return null;
  if (globalThis.chrome?.bookmarks) {
    return createBookmarkCollection(globalThis.chrome.bookmarks);
  }
  return storageFallback();
}

export async function listCollection() {
  const collection = await getCollection();
  if (!collection) return [];
  const entries = await collection.list();
  return entries || [];
}

export async function addToCollection(entry) {
  const collection = await getCollection();
  if (!collection) return null;
  return collection.add(entry);
}

export async function removeFromCollection(url) {
  const collection = await getCollection();
  if (!collection) return false;
  return collection.remove(url);
}
