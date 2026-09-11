import { get, writable } from "svelte/store";
import {
  authorizedAssetUrl,
  generateThumbnail,
  isTauriRuntime,
  isPreviewUnavailable,
  type ThumbnailResponse,
} from "../api";
import { mediaIdentity } from "../selection-identity";

export const THUMBNAIL_CONCURRENCY = 3;

export type ThumbnailStatus = "loading" | "ready" | "error";

export interface ThumbnailRecord {
  status: ThumbnailStatus;
  url: string | null;
}

interface ThumbnailRequest {
  folder: string | null;
  fileName: string;
  key: string;
  generation: number;
}

export const thumbnailState = writable<ReadonlyMap<string, ThumbnailRecord>>(new Map());

const pending: ThumbnailRequest[] = [];
const queuedKeys = new Set<string>();
let activeRequests = 0;
let generation = 0;

function setRecord(key: string, record: ThumbnailRecord): void {
  thumbnailState.update((records) => {
    const next = new Map(records);
    next.set(key, record);
    return next;
  });
}

function markError(request: ThumbnailRequest): void {
  if (request.generation !== generation) return;
  setRecord(request.key, { status: "error", url: null });
}

function markReady(request: ThumbnailRequest, result: ThumbnailResponse): void {
  if (request.generation !== generation) return;
  if (result.fileName !== request.fileName) {
    markError(request);
    return;
  }
  const url = authorizedAssetUrl(result);
  if (!url) {
    markError(request);
    return;
  }
  setRecord(request.key, { status: "ready", url });
}

async function run(request: ThumbnailRequest): Promise<void> {
  try {
    const result = await generateThumbnail({ folder: request.folder, fileName: request.fileName });
    if (isPreviewUnavailable(result)) markError(request);
    else markReady(request, result);
  } catch {
    markError(request);
  } finally {
    activeRequests -= 1;
    pump();
  }
}

function pump(): void {
  while (activeRequests < THUMBNAIL_CONCURRENCY && pending.length > 0) {
    const request = pending.shift();
    if (!request) return;
    queuedKeys.delete(request.key);
    activeRequests += 1;
    void run(request);
  }
}

export function requestThumbnail(folder: string | null, fileName: string): void {
  const key = mediaIdentity(folder, fileName);
  const current = get(thumbnailState).get(key);
  if (current || queuedKeys.has(key)) return;

  // generate_thumbnail is a native operation. Browser preview keeps the text
  // tile fallback and must not enqueue requests it cannot fulfill.
  if (!isTauriRuntime()) return;

  const request: ThumbnailRequest = {
    folder,
    fileName,
    key,
    generation,
  };
  queuedKeys.add(key);
  setRecord(key, { status: "loading", url: null });
  pending.push(request);
  pump();
}

export function failThumbnail(key: string, url: string): void {
  const current = get(thumbnailState).get(key);
  if (current?.status === "ready" && current.url === url) {
    setRecord(key, { status: "error", url: null });
  }
}

export function resetThumbnails(): void {
  generation += 1;
  pending.length = 0;
  queuedKeys.clear();
  thumbnailState.set(new Map());
}
