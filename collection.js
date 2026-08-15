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
  const sourceUrl = typeof entry?.sourceUrl === "string" ? entry.sourceUrl : "";
  const rest = normalized.filter((item) => item?.url !== url);
  const next = [
    {
      url,
      title: typeof entry.title === "string" ? entry.title.slice(0, 240) : "",
      sourceUrl,
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
    sourceUrl: parsed?.sourceUrl || "",
    bookmarkUrl: node.url,
    savedAt: typeof node.dateAdded === "number" ? node.dateAdded : Date.now(),
  };
}

function safeSourceUrl(value) {
  try {
    const parsed = new URL(value);
    if (!(parsed.protocol === "http:" || parsed.protocol === "https:") || parsed.username || parsed.password) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

export function buildCollectionBookmarkUrl(mediaUrl, title = "", playerUrl = null, sourceUrl = "") {
  const baseUrl = playerUrl || globalThis.chrome?.runtime?.getURL?.("player.html");
  if (!baseUrl) return mediaUrl;
  const params = new URLSearchParams({ collection: "1", url: mediaUrl });
  if (title) params.set("title", title.slice(0, 240));
  const safeSource = safeSourceUrl(sourceUrl);
  if (safeSource) params.set("source", safeSource);
  return `${baseUrl}?${params.toString()}`;
}

export function parseCollectionBookmarkUrl(value) {
  try {
    const parsed = new URL(value);
    if (!(parsed.protocol === "chrome-extension:" || parsed.protocol === "moz-extension:")) return null;
    if (parsed.pathname !== "/player.html" || parsed.searchParams.get("collection") !== "1") return null;
    const expected = globalThis.chrome?.runtime?.getURL?.("player.html");
    if (expected) {
      const expectedUrl = new URL(expected);
      if (parsed.origin !== expectedUrl.origin) return null;
    }
    const mediaUrl = parsed.searchParams.get("url") || "";
    if (!/^https?:$/i.test(new URL(mediaUrl).protocol)) return null;
    return {
      mediaUrl,
      title: parsed.searchParams.get("title") || "",
      sourceUrl: safeSourceUrl(parsed.searchParams.get("source") || ""),
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

async function folderOptions(bookmarks, parentId, parentTitle = "", seen = new Set()) {
  if (!parentId || seen.has(parentId)) return [];
  seen.add(parentId);
  const children = await bookmarks.getChildren(parentId);
  const options = [];
  for (const node of children.filter((item) => !item.url)) {
    const title = String(node.title || "").trim();
    const path = parentTitle && title ? `${parentTitle} / ${title}` : title || parentTitle;
    options.push({ id: node.id, title: path, parentId });
    options.push(...await folderOptions(bookmarks, node.id, path, seen));
  }
  return options;
}

async function resolveFolderId(bookmarks, rootId, requestedId) {
  if (!requestedId || requestedId === rootId) return rootId;
  const options = await folderOptions(bookmarks, rootId);
  return options.some((option) => option.id === String(requestedId)) ? String(requestedId) : rootId;
}

async function folderEntries(bookmarks, folderId, seen = new Set()) {
  if (!folderId || seen.has(folderId)) return [];
  seen.add(folderId);
  const children = await bookmarks.getChildren(folderId);
  const entries = [];
  for (const node of children) {
    if (typeof node.url === "string") {
      const entry = bookmarkToEntry(node);
      if (!parseCollectionBookmarkUrl(node.url)) {
        const bookmarkUrl = buildCollectionBookmarkUrl(entry.url, entry.title, null, entry.sourceUrl);
        if (bookmarkUrl !== node.url) {
          await bookmarks.update(node.id, { url: bookmarkUrl }).catch(() => null);
          entry.bookmarkUrl = bookmarkUrl;
        }
      }
      entries.push(entry);
      continue;
    }
    entries.push(...await folderEntries(bookmarks, node.id, seen));
  }
  return entries;
}

async function findBookmark(bookmarks, folderId, mediaUrl, seen = new Set()) {
  if (!folderId || seen.has(folderId)) return null;
  seen.add(folderId);
  const children = await bookmarks.getChildren(folderId);
  for (const node of children) {
    if (typeof node.url === "string" && bookmarkMediaUrl(node.url) === mediaUrl) {
      return { node, parentId: folderId };
    }
    if (!node.url) {
      const found = await findBookmark(bookmarks, node.id, mediaUrl, seen);
      if (found) return found;
    }
  }
  return null;
}

export function createBookmarkCollection(bookmarks) {
  const hasApi = Boolean(bookmarks?.getChildren && bookmarks?.create && bookmarks?.remove);
  return {
    supported: hasApi,
    async list() {
      if (!hasApi) return null;
      const folderId = await findOrCreateFolder(bookmarks);
      const entries = await folderEntries(bookmarks, folderId);
      return entries || null;
    },
    async listFolders() {
      if (!hasApi) return [];
      const folderId = await findOrCreateFolder(bookmarks);
      if (!folderId) return [];
      return [
        { id: folderId, title: COLLECTION_FOLDER_TITLE, root: true },
        ...await folderOptions(bookmarks, folderId),
      ];
    },
    async createFolder(title) {
      if (!hasApi) return null;
      const safeTitle = String(title || "").trim().slice(0, 80);
      if (!safeTitle) return null;
      const folderId = await findOrCreateFolder(bookmarks);
      if (!folderId) return null;
      const existing = (await bookmarks.getChildren(folderId))
        .find((node) => !node.url && node.title === safeTitle);
      if (existing) return existing;
      return bookmarks.create({ parentId: folderId, title: safeTitle });
    },
    async add(entry, requestedFolderId = null) {
      if (!hasApi) return null;
      const url = typeof entry?.url === "string" ? entry.url : "";
      if (!url) return null;
      const title = typeof entry.title === "string" ? entry.title.slice(0, 240) : "";
      const bookmarkUrl = buildCollectionBookmarkUrl(url, title, null, entry.sourceUrl);
      const rootId = await findOrCreateFolder(bookmarks);
      const folderId = await resolveFolderId(bookmarks, rootId, requestedFolderId);
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
      const existing = await findBookmark(bookmarks, folderId, url);
      if (!existing) return false;
      await bookmarks.remove(existing.node.id);
      return true;
    },
    async replace(oldUrl, entry) {
      if (!hasApi) return false;
      const folderId = await findOrCreateFolder(bookmarks);
      if (!folderId) return false;
      const existing = await findBookmark(bookmarks, folderId, oldUrl);
      if (!existing) return false;
      const url = typeof entry?.url === "string" ? entry.url : "";
      if (!url) return false;
      const title = typeof entry.title === "string" ? entry.title.slice(0, 240) : existing.node.title || "";
      await bookmarks.update(existing.node.id, {
        title,
        url: buildCollectionBookmarkUrl(url, title, null, entry.sourceUrl),
      });
      await bookmarks.move(existing.node.id, { parentId: existing.parentId, index: 0 }).catch(() => null);
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
    async listFolders() {
      return [{ id: "", title: COLLECTION_FOLDER_TITLE, root: true }];
    },
    async createFolder() {
      return null;
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
    async replace(oldUrl, entry) {
      const current = await this.list();
      const next = current.filter((item) => item?.url !== oldUrl);
      await chrome.storage.local.set({ [STORAGE_KEY]: mergeCollection(next, entry) });
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

export async function listCollectionFolders() {
  const collection = await getCollection();
  if (!collection?.listFolders) return [];
  return collection.listFolders();
}

export async function createCollectionFolder(title) {
  const collection = await getCollection();
  if (!collection?.createFolder) return null;
  return collection.createFolder(title);
}

export async function addToCollection(entry, folderId = null) {
  const collection = await getCollection();
  if (!collection) return null;
  return collection.add(entry, folderId);
}

export async function removeFromCollection(url) {
  const collection = await getCollection();
  if (!collection) return false;
  return collection.remove(url);
}

export async function replaceInCollection(oldUrl, entry) {
  const collection = await getCollection();
  if (!collection?.replace) return false;
  return collection.replace(oldUrl, entry);
}
