import {
  activeKeyForSegment,
  chooseHlsVariant,
  decryptSegment,
  hlsFileExtension,
  isHlsPlaylist,
  ivForSegment,
  parseHlsPlaylist,
} from "./hls.js";
import { filenameForDownload } from "./download.js";
import { getDownloadFolder } from "./folder-store.js";
import { level5KeyErrorMessage, normalizeLevel5KeyError } from "./level5-key-error.js";
import { createNativeFileWriter } from "./native-file-writer.js";
import { progressiveDownloadErrorMessage, replayableRecordedHeaders } from "./progressive-redirect.js";

export const MAX_HLS_SEGMENTS = 10_000;
const SUPPORTED_KEY_METHODS = new Set(["AES-128", "AES-256"]);
const DOWNLOAD_CONCURRENCY = 6;
const DOOD_MEDIA_HOST_RE = /(?:doodcdn|doimg|d000d|dood\.|playmogo|cloudatacdn)\./i;
const statusElement = document.querySelector("#status");
const startButton = document.querySelector("#start-download");
const hintElement = document.querySelector("#hint");
const versionElement = document.querySelector("#version");
const keyMaterialCache = new Map();

export function createDownloadContext({ onStatus = null, frameId = null } = {}) {
  return {
    onStatus: typeof onStatus === "function" ? onStatus : null,
    frameId: Number.isInteger(frameId) ? frameId : null,
    recordedHeadersByUrl: new Map(),
  };
}

const defaultDownloadContext = createDownloadContext();

class MediaRoutePreparationError extends Error {
  constructor(detail = "media-route-failed") {
    super(progressiveDownloadErrorMessage({ code: detail, message: detail }));
    this.name = "MediaRoutePreparationError";
    this.code = "media-route-failed";
  }
}

function setStatus(message, error = false, context = defaultDownloadContext) {
  context.onStatus?.(message, error);
  if (statusElement) {
    statusElement.textContent = message;
    statusElement.classList.toggle("error", error);
  }
}

function filenameFor(title, extension) {
  const safe = String(title || "aura-hls")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 120);
  return `${safe || "aura-hls"}.${extension}`;
}

export function progressiveFilenameFor(candidate) {
  const urlFilename = filenameForDownload(candidate?.resourceUrl || "");
  const extension = /\.([a-z0-9]{2,5})$/i.exec(urlFilename)?.[1] || "mp4";
  const title = String(candidate?.pageTitle || "").trim();
  if (!title || title === "직접 입력한 주소") {
    return /\.[a-z0-9]{2,5}$/i.test(urlFilename) ? urlFilename : `${urlFilename}.mp4`;
  }
  return filenameFor(title, extension);
}

function redactUrlForMessage(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "[주소 확인 불가]";
  }
}

function hostForMessage(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function isDoodLikeHost(url) {
  try {
    return DOOD_MEDIA_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function routeableUrl(value) {
  try {
    const url = new URL(value);
    return /^https?:$/i.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

async function ensureMediaRoutes(urls) {
  const routeUrls = [...new Set(urls.map(routeableUrl).filter(Boolean))];
  if (!routeUrls.length) return { ok: true, hosts: [] };
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: "ensure-media-routes", urls: routeUrls });
  } catch {
    throw new MediaRoutePreparationError();
  }
  if (!response?.ok) {
    throw new MediaRoutePreparationError(response?.error || "media-route-failed");
  }
  return response;
}

async function loadRecordedHeaders(context = defaultDownloadContext) {
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-request-headers" });
    if (response?.ok && response.headers && typeof response.headers === "object") {
      context.recordedHeadersByUrl.clear();
      for (const [key, value] of Object.entries(response.headers)) context.recordedHeadersByUrl.set(key, value);
    }
  } catch {
    // Fall back to cookies + Referer only.
  }
}

async function ensureCurrentBackground() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "ping-media-stream" });
    return response?.ok === true && response.capabilities?.mediaFetchLease === 1;
  } catch {
    return false;
  }
}

function recordedFor(url, context = defaultDownloadContext) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    const exact = context.recordedHeadersByUrl.get(parsed.href);
    if (exact) return exact;
    const originPath = `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
    return context.recordedHeadersByUrl.get(originPath) || null;
  } catch {
    return null;
  }
}

function extraHeadersFor(url, context = defaultDownloadContext) {
  return replayableRecordedHeaders(recordedFor(url, context));
}

function referrerFor(url, fallback, context = defaultDownloadContext) {
  const recorded = recordedFor(url, context);
  const ref = recorded?.referer || recorded?.referrer;
  return ref && /^https?:\/\//i.test(ref) ? ref : fallback;
}

async function withMediaFetchLease(url, referrer, consume, requestHeaders = {}, context = defaultDownloadContext) {
  await ensureMediaRoutes([url, referrer]);
  const prepared = await chrome.runtime.sendMessage({
    type: "prepare-media-fetch",
    url,
    referrer,
  });
  const leaseId = prepared?.leaseId;
  if (!prepared?.ok || leaseId == null) {
    throw new Error("미디어 요청을 준비하지 못했습니다. 확장 프로그램을 다시 로드한 뒤 다시 시도해 주세요.");
  }
  const keepAlive = setInterval(() => {
    void chrome.runtime.sendMessage({ type: "touch-media-fetch", leaseId }).catch(() => {});
  }, 60_000);
  try {
    const headers = new Headers(extraHeadersFor(url, context));
    for (const [name, value] of Object.entries(requestHeaders)) headers.set(name, value);
    const response = await fetch(url, {
      credentials: "include",
      referrer,
      referrerPolicy: "unsafe-url",
      headers,
    });
    return await consume(response);
  } finally {
    clearInterval(keepAlive);
    await chrome.runtime.sendMessage({ type: "release-media-fetch", leaseId });
  }
}

async function fetchText(url, referrer, context = defaultDownloadContext) {
  const requestReferrer = referrerFor(url, referrer, context);
  let loaded;
  try {
    loaded = await withMediaFetchLease(url, requestReferrer, async (response) => ({
      ok: response.ok,
      status: response.status,
      url: response.url || url,
      contentType: response.headers?.get?.("content-type") || "",
      text: await response.text(),
    }), {}, context);
  } catch (error) {
    const host = hostForMessage(url);
    throw new Error(host
      ? `서버(${host}) 연결 실패 (${error?.message || "네트워크 오류"}). 플레이리스트 주소가 유효한지, 영상이 재생 중인지 확인해 주세요.`
      : "플레이리스트 요청 중 네트워크 오류가 발생했습니다.");
  }
  if (!loaded.ok) throw new Error(`플레이리스트 요청 실패 (${loaded.status}): ${redactUrlForMessage(url)}`);
  return {
    text: loaded.text,
    url: loaded.url,
    contentType: loaded.contentType,
  };
}

async function fetchArrayBuffer(url, referrer, label, context = defaultDownloadContext) {
  const requestReferrer = referrerFor(url, referrer, context);
  let loaded;
  try {
    loaded = await withMediaFetchLease(url, requestReferrer, async (response) => ({
      ok: response.ok,
      status: response.status,
      data: new Uint8Array(await response.arrayBuffer()),
    }), {}, context);
  } catch (error) {
    const host = hostForMessage(url);
    throw new Error(host
      ? `${label} 서버(${host}) 연결 실패 (${error?.message || "네트워크 오류"}).`
      : `${label} 요청 중 네트워크 오류가 발생했습니다.`);
  }
  if (!loaded.ok) throw new Error(`${label} 요청 실패 (${loaded.status}): ${redactUrlForMessage(url)}`);
  return loaded.data;
}

async function requestPageDecodedKey(url, videoTabId, videoFrameId = null) {
  if (!Number.isInteger(videoTabId) || videoTabId <= 0) {
    throw new Error(level5KeyErrorMessage("level5-key-unavailable"));
  }
  try {
    const response = await chrome.runtime.sendMessage({
      type: "decode-hls-key",
      url,
      tabId: videoTabId,
      frameId: videoFrameId,
    });
    const bytes = response?.ok ? toBytes(response.key) : null;
    if (bytes && (bytes.byteLength === 16 || bytes.byteLength === 32)) return bytes;
    throw new Error(level5KeyErrorMessage(normalizeLevel5KeyError(response?.error)));
  } catch (error) {
    if (typeof error?.message === "string" && error.message.startsWith("보호된 HLS 키 해독 실패:")) throw error;
    throw new Error(level5KeyErrorMessage("level5-key-unavailable"));
  }
}

async function keyMaterial(key, referrer, videoTabId = null, context = defaultDownloadContext) {
  if (!key?.uri) throw new Error("HLS 복호화 키 주소가 없습니다.");
  const cached = keyMaterialCache.get(key.uri);
  if (cached) return cached;
  let keyBytes = await fetchArrayBuffer(key.uri, referrer, "복호화 키", context);
  if (keyBytes.byteLength !== 16 && keyBytes.byteLength !== 32) {
    keyBytes = await requestPageDecodedKey(key.uri, videoTabId, context.frameId);
  }
  const importedKey = await globalThis.crypto.subtle.importKey(
    "raw",
    keyBytes,
    "AES-CBC",
    false,
    ["decrypt"],
  );
  const material = { keyBytes, importedKey };
  keyMaterialCache.set(key.uri, material);
  return material;
}

async function loadMediaPlaylist(url, depth = 0, referrer, context = defaultDownloadContext) {
  if (depth > 3) throw new Error("HLS variant nesting is too deep");
  const loaded = await fetchText(url, referrer, context);
  if (!isHlsPlaylist(loaded.text, loaded.contentType)) {
    throw new Error(`받은 응답이 m3u8 플레이리스트가 아닙니다 (${redactUrlForMessage(loaded.url)}). 직접 입력 주소라면 페이지 주소가 아니라 실제 영상 플레이리스트(m3u8) 주소를 넣어 주세요.`);
  }
  const parsed = parseHlsPlaylist(loaded.text, loaded.url);
  if (parsed.byterange) throw new Error("byterange HLS는 지원하지 않습니다.");
  for (const key of parsed.keys) {
    if (!SUPPORTED_KEY_METHODS.has(key.method)) {
      throw new Error(key.method === "SAMPLE-AES" || key.method === "SAMPLE-AES-CTR"
        ? "SAMPLE-AES(샘플 암호화/FairPlay DRM)는 지원하지 않습니다."
        : "지원하지 않는 HLS 암호화 방식입니다.");
    }
  }
  const variant = chooseHlsVariant(parsed.variants);
  if (variant) return loadMediaPlaylist(variant.uri, depth + 1, referrer, context);
  if (!parsed.segments.length) throw new Error("HLS 세그먼트를 찾지 못했습니다.");
  if (parsed.segments.length > MAX_HLS_SEGMENTS) throw new Error("세그먼트 수가 너무 많습니다.");
  await ensureMediaRoutes([
    referrer,
    parsed.initUrl,
    ...parsed.keys.map((key) => key.uri),
    ...parsed.segments,
  ]);
  return { ...parsed, baseUrl: loaded.url };
}

export async function prepareHlsKeys(media, referrer, videoTabId = null, context = defaultDownloadContext) {
  const unique = [...new Map((media?.keys || [])
    .filter((key) => key?.uri)
    .map((key) => [key.uri, key])).values()];
  for (let index = 0; index < unique.length; index += 1) {
    setStatus(`보호 키 ${index + 1}/${unique.length} 준비 중…`, false, context);
    await keyMaterial(unique[index], referrer, videoTabId, context);
  }
  if (unique.length) {
    setStatus(`보호 키 ${unique.length}개 준비 완료. 원본 페이지를 벗어나도 다운로드가 계속됩니다.`, false, context);
  }
  return unique.length;
}

async function fetchSegment(index, media, referrer, videoTabId = null, context = defaultDownloadContext) {
  const activeKey = activeKeyForSegment(media.keys, index);
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      let chunk = await fetchArrayBuffer(media.segments[index], referrer, `세그먼트 ${index + 1}`, context);
      if (activeKey) {
        const { keyBytes, importedKey } = await keyMaterial(activeKey, referrer, videoTabId, context);
        const iv = ivForSegment(activeKey, media.mediaSequence, index);
        chunk = await decryptSegment(chunk, keyBytes, iv, importedKey);
      }
      return chunk;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function* mediaChunks(media, referrer, videoTabId = null, context = defaultDownloadContext) {
  let totalBytes = 0;

  if (media.initUrl) {
    let chunk = await fetchArrayBuffer(media.initUrl, referrer, "초기화 세그먼트", context);
    const firstKey = activeKeyForSegment(media.keys, 0);
    if (firstKey) {
      const { keyBytes, importedKey } = await keyMaterial(firstKey, referrer, videoTabId, context);
      const iv = ivForSegment(firstKey, media.mediaSequence, 0);
      try {
        chunk = await decryptSegment(chunk, keyBytes, iv, importedKey);
      } catch {
        // Init sections are commonly left unencrypted; keep the raw bytes.
      }
    }
    totalBytes += chunk.byteLength;
    yield chunk;
  }

  const total = media.segments.length;
  if (total === 0) return;

  const buffer = new Map();
  const ready = new Map();
  const claimWaiters = new Set();
  const maxBuffered = Math.max(DOWNLOAD_CONCURRENCY * 2, 8);
  let consumed = 0;
  let nextFetch = 0;
  let failed = null;
  let stopped = false;

  function waitForChunk(index) {
    if (buffer.has(index)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      ready.set(index, { resolve, reject });
    });
  }

  function notifyReady(index) {
    const waiter = ready.get(index);
    if (waiter) {
      ready.delete(index);
      waiter.resolve();
    }
  }

  async function worker() {
    while (!stopped && !failed) {
      let index;
      while (true) {
        if (stopped || failed) return;
        if (nextFetch < total && nextFetch < consumed + maxBuffered) {
          index = nextFetch;
          nextFetch += 1;
          break;
        }
        if (nextFetch >= total) return;
        await new Promise((resolve) => claimWaiters.add(resolve));
      }
      try {
        const chunk = await fetchSegment(index, media, referrer, videoTabId, context);
        if (stopped || failed) return;
        buffer.set(index, chunk);
        notifyReady(index);
      } catch (error) {
        if (!failed) {
          failed = error;
          for (const waiter of ready.values()) waiter.reject(error);
          ready.clear();
        }
        return;
      }
    }
  }

  const workers = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, total) }, () => worker());
  try {
    for (let index = 0; index < total; index += 1) {
      await waitForChunk(index);
      const chunk = buffer.get(index);
      buffer.delete(index);
      consumed += 1;
      totalBytes += chunk.byteLength;
      setStatus(`세그먼트 ${index + 1}/${total} 저장 중… (${Math.round(totalBytes / 1048576)} MB, ${workers.length}개 병렬 수신)`, false, context);
      yield chunk;
      for (const resolve of claimWaiters) {
        claimWaiters.delete(resolve);
        resolve();
      }
    }
  } finally {
    stopped = true;
    for (const resolve of claimWaiters) {
      claimWaiters.delete(resolve);
      resolve();
    }
    for (const waiter of ready.values()) waiter.resolve();
    ready.clear();
  }
}

function mediaMime(media) {
  return media.initUrl ? "video/mp4" : "video/mp2t";
}

function toBytes(value) {
  if (value == null) return null;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (typeof value !== "object") return null;
  if (typeof value.length === "number") return new Uint8Array(value);
  const indexes = Object.keys(value)
    .filter((key) => /^(?:0|[1-9]\d*)$/.test(key))
    .map(Number)
    .sort((left, right) => left - right);
  if (!indexes.length) return null;
  const bytes = new Uint8Array(indexes[indexes.length - 1] + 1);
  for (const index of indexes) {
    const byte = Number(value[index]);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    bytes[index] = byte;
  }
  return bytes;
}

function describeChunk(value) {
  if (value == null) return String(value);
  const tag = Object.prototype.toString.call(value);
  const name = value.constructor?.name ? ` (${value.constructor.name})` : "";
  return `${tag}${name}`;
}

async function writeChunk(writable, value) {
  const bytes = toBytes(value);
  if (!bytes) throw new Error(`저장 데이터 형식 오류: ${describeChunk(value)}`);
  await writable.write({ type: "write", data: bytes });
}

async function ensureFolderPermission(handle) {
  const options = { mode: "readwrite" };
  try {
    if (await handle.queryPermission(options) === "granted") return true;
    return await handle.requestPermission(options) === "granted";
  } catch {
    return false;
  }
}

async function saveHlsToFolder(media, filename, folderHandle, referrer, videoTabId = null, context = defaultDownloadContext) {
  const fileHandle = await folderHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  let count = 0;
  try {
    for await (const chunk of mediaChunks(media, referrer, videoTabId, context)) {
      await writeChunk(writable, chunk);
      count += 1;
    }
  } catch (error) {
    try { await writable.abort(); } catch { /* already closed */ }
    throw error;
  }
  await writable.close();
  return count;
}

function progressiveSession(url, pageUrl, videoTabId) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "media-stream" });
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve(value);
    };
    port.onDisconnect.addListener(() => finish(null, new Error("다운로드 연결이 끊겼습니다.")));
    port.onMessage.addListener((message) => {
      if (!message) return;
      if (message.type === "fetch-required") {
        finish({
          mode: "fetch",
          url: message.url,
          referrer: message.referrer,
          authenticatedProbeRequired: message.authenticatedProbeRequired === true,
        }, null);
      } else if (message.type === "stream-error") {
        finish(null, new Error(message.message || "다운로드에 실패했습니다."));
      }
    });
    port.postMessage({ type: "start", url, pageUrl, videoTabId });
  });
}

async function cancelProbeResponse(response) {
  if (typeof response?.body?.cancel === "function") {
    await response.body.cancel();
    return;
  }
  const reader = response?.body?.getReader?.();
  if (reader?.cancel) {
    await reader.cancel();
    return;
  }
  await response?.arrayBuffer?.();
}

async function prepareProgressiveFetch(session, context = defaultDownloadContext) {
  if (!session.authenticatedProbeRequired) return session;

  let finalUrl;
  try {
    finalUrl = await withMediaFetchLease(
      session.url,
      session.referrer,
      async (response) => {
        const status = Number.isInteger(response?.status) ? response.status : null;
        const responseUrl = routeableUrl(response?.url || session.url);
        await cancelProbeResponse(response);
        if ((!response?.ok && status !== 206) || !responseUrl) {
          const statusText = status == null ? "" : ` (HTTP ${status})`;
          throw new Error(`인증된 영상 확인 요청에 실패했습니다${statusText}. 영상 페이지를 새로고침한 뒤 다시 시도해 주세요.`);
        }
        return responseUrl;
      },
      { Range: "bytes=0-0" },
      context,
    );
  } catch (error) {
    if (error?.code === "media-route-failed"
      || String(error?.message || "").startsWith("인증된 영상 확인 요청에 실패했습니다")
      || String(error?.message || "").startsWith("미디어 요청을 준비하지 못했습니다")) {
      throw error;
    }
    throw new Error("인증된 영상 확인 요청 중 네트워크 오류가 발생했습니다. 영상 페이지를 새로고침한 뒤 다시 시도해 주세요.");
  }

  await ensureMediaRoutes([finalUrl]);
  return { ...session, url: finalUrl, authenticatedProbeRequired: false };
}

async function consumeResponseBody(response, onChunk) {
  const reader = response.body?.getReader?.();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value != null) await onChunk(value);
    }
  }
  const data = await response.arrayBuffer();
  if (data != null) await onChunk(data);
}

async function streamFetchToWritable(url, referrer, writable, onProgress, context = defaultDownloadContext) {
  let totalBytes = 0;
  await withMediaFetchLease(url, referrer, async (response) => {
    if (!response.ok) {
      await consumeResponseBody(response, () => {});
      throw new Error(`영상 요청 실패 (${response.status}): ${redactUrlForMessage(url)}`);
    }
    await consumeResponseBody(response, async (value) => {
      const bytes = toBytes(value);
      if (!bytes) throw new Error(`저장 데이터 형식 오류: ${describeChunk(value)}`);
      totalBytes += bytes.byteLength;
      onProgress?.(totalBytes);
      await writeChunk(writable, bytes);
    });
  }, {}, context);
  return totalBytes;
}

async function saveProgressive(
  url,
  filename,
  pageUrl,
  videoTabId,
  folderHandle,
  pickerHandle,
  nativeFallback = false,
  context = defaultDownloadContext,
  preparedSession = null,
) {
  const session = preparedSession
    || await prepareProgressiveFetch(await progressiveSession(url, pageUrl, videoTabId), context);

  let writable = null;
  if (pickerHandle) {
    writable = await pickerHandle.createWritable();
  } else if (folderHandle) {
    if (!await ensureFolderPermission(folderHandle)) {
      throw new Error("선택한 폴더에 접근할 수 없습니다. 확장 오른쪽 클릭 → 다운로드 폴더 설정에서 다시 선택해 주세요.");
    }
    const fileHandle = await folderHandle.getFileHandle(filename, { create: true });
    writable = await fileHandle.createWritable();
  } else if (nativeFallback) {
    writable = await createNativeFileWriter(filename);
  } else {
    const handle = await window.showSaveFilePicker({
      suggestedName: filename,
      types: [{
        description: "동영상",
        accept: { "video/mp4": [".mp4", ".webm"], "application/octet-stream": [".mp4"] },
      }],
    });
    writable = await handle.createWritable();
  }
  try {
    const bytes = await streamFetchToWritable(
      session.url,
      session.referrer,
      writable,
      (value) => setStatus(`저장 중… (${Math.round(value / 1048576)} MB)`, false, context),
      context,
    );
    await writable.close();
    return { bytes };
  } catch (error) {
    try { await writable.abort(); } catch { /* already closed */ }
    if (videoTabId && isDoodLikeHost(session.url) && error?.code !== "media-route-failed" && chrome.tabs?.sendMessage) {
      try {
        const fallback = await chrome.tabs.sendMessage(videoTabId, {
          type: "download-direct",
          url: session.url,
          filename,
        });
        if (fallback?.ok) return { fallback: true };
      } catch {
        // The player page may have navigated away; keep the original error.
      }
    }
    throw error;
  }
}

async function saveHlsToHandle(media, filename, pickerHandle, referrer, videoTabId = null, context = defaultDownloadContext) {
  if (pickerHandle.name !== filename && typeof pickerHandle.move === "function") {
    try {
      await pickerHandle.move(filename);
    } catch {
      // The provisional name stays when the browser cannot rename the file.
    }
  }
  const writable = await pickerHandle.createWritable();
  let count = 0;
  try {
    for await (const chunk of mediaChunks(media, referrer, videoTabId, context)) {
      await writeChunk(writable, chunk);
      count += 1;
    }
  } catch (error) {
    try { await writable.abort(); } catch { /* already closed */ }
    throw error;
  }
  await writable.close();
  return count;
}

async function saveHlsToNative(media, filename, referrer, videoTabId = null, context = defaultDownloadContext) {
  const writable = await createNativeFileWriter(filename);
  let count = 0;
  try {
    for await (const chunk of mediaChunks(media, referrer, videoTabId, context)) {
      await writeChunk(writable, chunk);
      count += 1;
    }
    await writable.close();
    return count;
  } catch (error) {
    try { await writable.abort(); } catch { /* already closed */ }
    throw error;
  }
}

async function saveInMemory(media, filename, referrer, videoTabId = null, context = defaultDownloadContext) {
  const chunks = [];
  for await (const chunk of mediaChunks(media, referrer, videoTabId, context)) {
    const bytes = toBytes(chunk);
    if (bytes) chunks.push(bytes);
  }
  const blob = new Blob(chunks, { type: mediaMime(media) });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

export {
  ensureCurrentBackground,
  loadRecordedHeaders,
  prepareProgressiveFetch,
  requestPageDecodedKey,
  streamFetchToWritable,
  toBytes,
  withMediaFetchLease,
  writeChunk,
};

export async function prepareDownloadCandidate(candidate, { folder = null, onStatus = null } = {}) {
  if (!candidate || typeof candidate.resourceUrl !== "string") throw new Error("다운로드 후보가 올바르지 않습니다.");
  if (folder && !await ensureFolderPermission(folder)) {
    folder = null;
  }

  const context = createDownloadContext({ onStatus, frameId: candidate.frameId });
  await loadRecordedHeaders(context);
  const progressive = candidate.mediaType === "PROGRESSIVE";
  if (progressive) {
    const filename = progressiveFilenameFor(candidate);
    setStatus("영상을 확인하는 중…", false, context);
    const session = await prepareProgressiveFetch(
      await progressiveSession(candidate.resourceUrl, candidate.pageUrl, candidate.tabId),
      context,
    );
    setStatus("영상 준비 완료. 원본 페이지를 벗어나도 다운로드가 계속됩니다.", false, context);
    return {
      type: "progressive",
      candidate,
      context,
      filename,
      folder,
      session,
    };
  }

  if (candidate.mediaType !== "HLS_MASTER" && candidate.mediaType !== "HLS_MEDIA") {
    throw new Error("unsupported-media");
  }
  setStatus("플레이리스트를 확인하는 중…", false, context);
  const media = await loadMediaPlaylist(candidate.resourceUrl, 0, candidate.pageUrl, context);
  const extension = hlsFileExtension(media.initUrl, media.segments);
  const filename = filenameFor(candidate.pageTitle, extension);
  setStatus(`플레이리스트 확인 완료 (세그먼트 ${media.segments.length}개).`, false, context);
  await prepareHlsKeys(media, candidate.pageUrl, candidate.tabId, context);
  return { type: "hls", candidate, context, filename, folder, media };
}

export async function downloadPreparedCandidate(prepared) {
  if (!prepared?.candidate || !prepared.context) throw new Error("준비된 다운로드 작업이 올바르지 않습니다.");
  const { candidate, context, filename, folder } = prepared;
  if (prepared.type === "progressive") {
    const result = await saveProgressive(
      candidate.resourceUrl,
      filename,
      candidate.pageUrl,
      candidate.tabId,
      folder,
      null,
      !folder,
      context,
      prepared.session,
    );
    return {
      statusText: result.fallback
        ? "브라우저 기본 다운로드 폴더로 저장을 시작했습니다."
        : `다운로드를 완료했습니다 (${Math.round(result.bytes / 1048576)} MB).`,
    };
  }
  if (prepared.type !== "hls" || !prepared.media) throw new Error("준비된 다운로드 형식을 지원하지 않습니다.");
  const count = folder
    ? await saveHlsToFolder(prepared.media, filename, folder, candidate.pageUrl, candidate.tabId, context)
    : await saveHlsToNative(prepared.media, filename, candidate.pageUrl, candidate.tabId, context);
  return { statusText: `다운로드를 완료했습니다 (파트 ${count}개). ${folder ? folder.name : "Downloads\\Aura Media"}에서 확인하세요.` };
}

export async function downloadCandidate(candidate, options = {}) {
  return downloadPreparedCandidate(await prepareDownloadCandidate(candidate, options));
}

async function main() {
  const candidateId = new URLSearchParams(location.search).get("candidateId");
  if (!candidateId) throw new Error("다운로드 후보가 없습니다.");
  try { versionElement.textContent = `v${chrome.runtime.getManifest().version}`; } catch { /* ignore */ }
  if (!await ensureCurrentBackground()) {
    throw new Error("확장 프로그램이 새 버전으로 다시 로드되지 않았습니다. 이 탭을 닫고, 확장 프로그램을 다시 로드한 뒤 팝업에서 다운로드를 다시 눌러 주세요.");
  }
  const candidate = await chrome.runtime.sendMessage({ type: "get-candidate-for-download", candidateId });
  if (!candidate?.ok) throw new Error("다운로드 후보를 찾지 못했습니다.");
  await loadRecordedHeaders();
  const progressive = candidate.mediaType === "PROGRESSIVE";
  const folder = await getDownloadFolder().catch(() => null);

  if (!folder && !window.showSaveFilePicker) {
    if (progressive) throw new Error("이 브라우저에서는 직접 영상을 저장할 수 없습니다.");
    const media = await loadMediaPlaylist(candidate.resourceUrl, 0, candidate.pageUrl);
    const extension = hlsFileExtension(media.initUrl, media.segments);
    const filename = filenameFor(candidate.pageTitle, extension);
    await saveInMemory(media, filename, candidate.pageUrl, candidate.tabId);
    setStatus(`다운로드를 시작했습니다 (${extension.toUpperCase()}). 이 창을 닫아도 됩니다.`);
    return;
  }

  if (folder || window.showSaveFilePicker) {
    startButton.hidden = false;
    hintElement.hidden = false;
    startButton.textContent = folder ? "다운로드 시작" : "저장 위치 선택 후 다운로드";
    setStatus(folder ? `지정된 폴더에 저장됩니다: ${folder.name}` : "아래 버튼을 눌러 저장 위치를 선택하세요.");
    startButton.addEventListener("click", async () => {
      if (startButton.disabled) return;
      startButton.disabled = true;
      setStatus(progressive ? "영상을 확인하는 중…" : "플레이리스트를 확인하는 중…");
      let pickerHandle = null;
      try {
        // The save picker must be opened inside the click gesture, so it is
        // requested before any network call. HLS files are renamed afterwards
        // once the actual container (.mp4/.ts) is known.
        if (folder) {
          if (!await ensureFolderPermission(folder)) {
            throw new Error("선택한 폴더에 접근할 수 없습니다. 확장 오른쪽 클릭 → 다운로드 폴더 설정에서 다시 선택해 주세요.");
          }
        } else {
          const provisional = progressive
            ? progressiveFilenameFor(candidate)
            : filenameFor(candidate.pageTitle, "mp4");
          pickerHandle = await window.showSaveFilePicker({
            suggestedName: provisional,
            types: [{
              description: "동영상",
              accept: { "video/mp4": [".mp4", ".webm"], "application/octet-stream": [".ts"] },
            }],
          });
        }
        await loadRecordedHeaders();
        let media = null;
        let filename = "";
        if (progressive) {
          filename = progressiveFilenameFor(candidate);
          setStatus("영상을 저장하는 중…");
        } else {
          media = await loadMediaPlaylist(candidate.resourceUrl, 0, candidate.pageUrl);
          const extension = hlsFileExtension(media.initUrl, media.segments);
          filename = filenameFor(candidate.pageTitle, extension);
          setStatus(`플레이리스트 확인 완료 (세그먼트 ${media.segments.length}개).`);
        }

        if (progressive) {
          const result = await saveProgressive(
            candidate.resourceUrl,
            filename,
            candidate.pageUrl,
            candidate.tabId,
            folder || null,
            pickerHandle || null,
          );
          if (result.fallback) {
            setStatus("확장 저장이 차단되어 브라우저 다운로드로 전환했습니다. 브라우저 기본 다운로드 폴더(내 문서/Downloads)에서 확인하세요.");
          } else {
            setStatus(`다운로드를 완료했습니다 (${Math.round(result.bytes / 1048576)} MB).`);
          }
          hintElement.hidden = true;
          return;
        }

        if (folder && !pickerHandle) {
          const count = await saveHlsToFolder(media, filename, folder, candidate.pageUrl, candidate.tabId);
          setStatus(`다운로드를 완료했습니다 (파트 ${count}개). 지정된 폴더에서 확인하세요.`);
        } else {
          const count = await saveHlsToHandle(media, filename, pickerHandle, candidate.pageUrl, candidate.tabId);
          setStatus(`다운로드를 완료했습니다 (파트 ${count}개). 저장된 파일로 버퍼링 없이 재생할 수 있습니다.`);
        }
        hintElement.hidden = true;
      } catch (error) {
        if (error?.name === "AbortError") {
          setStatus("저장 위치 선택을 취소했습니다.");
          startButton.disabled = false;
          return;
        }
        setStatus(error instanceof Error ? error.message : "다운로드에 실패했습니다.", true);
        startButton.disabled = false;
      }
    });
    return;
  }
}

if (startButton) {
  void main().catch((error) => setStatus(error instanceof Error ? error.message : "HLS 다운로드에 실패했습니다.", true));
}
