import {
  activeKeyForSegment,
  chooseHlsVariant,
  decryptSegment,
  hlsFileExtension,
  isHlsPlaylist,
  ivForSegment,
  parseHlsPlaylist,
} from "./hls.js";
import { DashParseError, parseDashManifest } from "./dash.js";
import { filenameForDownload } from "./download.js";
import {
  DEFAULT_FILENAME_TEMPLATE,
  FILENAME_TEMPLATE_STORAGE_KEY,
  formatFilenameTemplate,
} from "./filename-template.js";
import { PRODUCT_EDITION } from "./edition.js";
import { level5KeyErrorMessage, normalizeLevel5KeyError } from "./level5-key-error.js";
import { parallelDownload } from "./parallel-download.js";
import { progressiveDownloadErrorMessage, replayableRecordedHeaders } from "./progressive-redirect.js";
import { productPlan } from "./product-plan.js";
import { createUniqueFile, getStoredSaveDirectory } from "./save-directory.js";

export const MAX_HLS_SEGMENTS = 10_000;
const SUPPORTED_KEY_METHODS = new Set(["AES-128", "AES-256"]);
const DOWNLOAD_CONCURRENCY = 6;
const CURRENT_PLAN = productPlan(PRODUCT_EDITION);
let activePlan = CURRENT_PLAN;
const DOOD_MEDIA_HOST_RE = /(?:doodcdn|doimg|d000d|dood\.|playmogo|cloudatacdn)\./i;
const keyMaterialCache = new Map();

function dashRepresentationScore(representation) {
  const pixels = Number(representation?.width || 0) * Number(representation?.height || 0);
  return pixels * 1_000_000 + Number(representation?.bandwidth || 0);
}

export function chooseDashRepresentation(representations, kind) {
  return [...(Array.isArray(representations) ? representations : [])]
    .filter((representation) => representation?.kind === kind)
    .sort((left, right) => dashRepresentationScore(right) - dashRepresentationScore(left))[0] || null;
}

function dashMediaForRepresentation(representation) {
  if (!representation || !Array.isArray(representation.segments) || !representation.segments.length) {
    throw new Error(representation?.index
      ? "이 DASH 영상은 SegmentBase 인덱스 분석이 필요해 아직 저장할 수 없습니다."
      : "DASH 영상 구간을 찾지 못했습니다.");
  }
  return {
    initUrl: representation.initialization?.url || null,
    initByterange: representation.initialization?.range || null,
    segments: representation.segments.map((segment) => segment.url),
    byteranges: representation.segments.map((segment) => segment.range || null),
    keys: [],
    mediaSequence: 0,
  };
}

export function dashTracksForPlan(plan, title = "DASH 영상") {
  const tracks = [];
  const periods = Array.isArray(plan?.periods) ? plan.periods : [];
  for (let periodIndex = 0; periodIndex < periods.length; periodIndex += 1) {
    const representations = periods[periodIndex].adaptationSets
      .flatMap((adaptation) => adaptation.representations || []);
    for (const kind of ["video", "audio"]) {
      const representation = chooseDashRepresentation(representations, kind);
      if (!representation) continue;
      const suffix = `${periods.length > 1 ? `-p${periodIndex + 1}` : ""}-${kind}`;
      tracks.push({
        kind,
        periodIndex,
        representation,
        media: dashMediaForRepresentation(representation),
        title: `${title}${suffix}`,
        extension: kind === "audio" ? "m4a" : "mp4",
        filename: filenameFor(`${title}${suffix}`, kind === "audio" ? "m4a" : "mp4"),
      });
    }
  }
  if (!tracks.length) throw new Error("DASH 비디오·오디오 트랙을 찾지 못했습니다.");
  return tracks;
}

export function setRuntimePlan(plan) {
  if (plan && typeof plan === "object") activePlan = plan;
}

export function createDownloadContext({
  onStatus = null,
  frameId = null,
  tabId = null,
  pauseGate = null,
  paceBytes = null,
  totalBytes = null,
  signal = null,
} = {}) {
  return {
    onStatus: typeof onStatus === "function" ? onStatus : null,
    pauseGate: typeof pauseGate === "function" ? pauseGate : null,
    paceBytes: typeof paceBytes === "function" ? paceBytes : null,
    totalBytes: Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : null,
    signal: signal && typeof signal === "object" ? signal : null,
    frameId: Number.isInteger(frameId) ? frameId : null,
    tabId: Number.isInteger(tabId) ? tabId : null,
    recordedHeadersByUrl: new Map(),
  };
}

export function createSpeedGate(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
  let windowBytes = 0;
  let windowStart = performance.now();
  return async function paceBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    windowBytes += bytes;
    const elapsed = performance.now() - windowStart;
    const allowed = (elapsed / 1000) * bytesPerSecond;
    if (windowBytes > allowed) {
      const neededMs = (windowBytes / bytesPerSecond) * 1000;
      const delayMs = Math.max(0, neededMs - elapsed);
      if (delayMs > 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (elapsed > 2000) {
      windowBytes = 0;
      windowStart = performance.now();
    }
  };
}

export function assertDownloadWithinPlan(totalBytes, nextBytes, plan = activePlan) {
  const maximum = plan?.maxDownloadBytes;
  if (maximum !== null && Number.isFinite(maximum) && totalBytes + nextBytes > maximum) {
    const error = new Error("일반 버전은 파일당 최대 1GB까지 다운로드할 수 있습니다. Pro에서는 용량 제한이 없습니다.");
    error.code = "pro-file-size-required";
    throw error;
  }
}

const defaultDownloadContext = createDownloadContext();

async function configuredFilenameTemplate() {
  try {
    const stored = await chrome.storage.local.get({ [FILENAME_TEMPLATE_STORAGE_KEY]: DEFAULT_FILENAME_TEMPLATE });
    return stored?.[FILENAME_TEMPLATE_STORAGE_KEY] || DEFAULT_FILENAME_TEMPLATE;
  } catch {
    return DEFAULT_FILENAME_TEMPLATE;
  }
}

function filenameFromTemplate(template, candidate, title, extension, fallbackFilename = "") {
  return formatFilenameTemplate(template, {
    title,
    filename: fallbackFilename,
    ext: extension,
    url: candidate?.resourceUrl || "",
  });
}

class MediaRoutePreparationError extends Error {
  constructor(detail = "media-route-failed") {
    super(progressiveDownloadErrorMessage({ code: detail, message: detail }));
    this.name = "MediaRoutePreparationError";
    this.code = "media-route-failed";
  }
}

function setStatus(message, error = false, context = defaultDownloadContext) {
  context.onStatus?.(message, error);
}

function saveProgressText(bytes, totalBytes) {
  const mb = Math.round(bytes / 1048576);
  if (Number.isFinite(totalBytes) && totalBytes > 0) {
    const percent = Math.max(0, Math.min(100, Math.round((bytes / totalBytes) * 100)));
    return `저장 중… ${percent}% (${mb} MB)`;
  }
  return `저장 중… (${mb} MB)`;
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

export function browserDownloadFilename(value) {
  const safe = String(value || "aura-media.mp4")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 120);
  if (!safe || safe.startsWith("/") || safe.includes("..")) return "aura-media.mp4";
  return safe;
}

async function probeDownloadTotalBytes(url, referrer, context = defaultDownloadContext) {
  let total = null;
  let contentType = "";
  let rangeSupported = false;
  await withMediaFetchLease(url, referrer, async (response) => {
    contentType = response.headers?.get?.("content-type") || "";
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error(`영상 요청 실패 (${response.status}): ${redactUrlForMessage(url)}`);
    }
    rangeSupported = response.status === 206;
    const contentRange = response.headers?.get?.("content-range") || "";
    const match = /\/\s*(\d+)\s*$/.exec(contentRange);
    if (match) {
      total = Number(match[1]);
    } else {
      const length = response.headers?.get?.("content-length") || "";
      if (/^\d+$/.test(length)) total = Number(length);
    }
    await response.body?.cancel?.().catch(() => {});
  }, { Range: "bytes=0-0" }, context);
  if (total === 0) {
    throw new Error("영상 서버가 빈 파일을 반환했습니다. 영상 페이지를 새로고침하고 재생한 뒤 다시 시도해 주세요.");
  }
  return {
    total: Number.isFinite(total) && total >= 0 ? total : null,
    contentType,
    rangeSupported,
  };
}

export async function tryBrowserDownloadFallback(
  url,
  filename,
  plan = activePlan,
  referrer = "",
  context = defaultDownloadContext,
) {
  if (typeof chrome?.runtime?.sendMessage !== "function") return null;
  if (!/^https?:/i.test(String(url || ""))) return null;
  const safeName = browserDownloadFilename(filename);
  const probed = await probeDownloadTotalBytes(url, referrer, context);
  const contentType = String(probed?.contentType || "");
  if (contentType && !/^(video|audio)\//i.test(contentType) && !/octet-stream/i.test(contentType)) {
    throw new Error("이 주소는 영상 파일이 아니라 웹페이지입니다. 실제 미디어 주소를 입력해 주세요.");
  }
  const maximum = plan?.maxDownloadBytes;
  if (maximum !== null && Number.isFinite(maximum)
    && probed?.total !== null && probed?.total !== undefined) {
    assertDownloadWithinPlan(0, probed.total, plan);
  }
  const requestId = globalThis.crypto?.randomUUID?.() || `download-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cancel = () => {
    void chrome.runtime.sendMessage({ type: "cancel-browser-download", requestId }).catch(() => {});
  };
  context.signal?.addEventListener?.("abort", cancel, { once: true });
  try {
    const response = await raceWithAbort(chrome.runtime.sendMessage({
      type: "browser-download",
      requestId,
      url,
      filename: safeName,
    }), context.signal);
    if (!response?.ok || !Number.isInteger(response.downloadId) || !Number.isFinite(response.bytes) || response.bytes <= 0) {
      if (response?.error === "empty-download") {
        throw new Error("영상 서버가 빈 파일을 반환했습니다. 영상 페이지를 새로고침하고 재생한 뒤 다시 시도해 주세요.");
      }
      const detail = response?.message || response?.error || "download-failed";
      throw new Error(`브라우저 다운로드로 저장하지 못했습니다 (${detail}).`);
    }
    assertDownloadWithinPlan(0, response.bytes, plan);
    return { fallback: true, completed: true, bytes: response.bytes };
  } finally {
    context.signal?.removeEventListener?.("abort", cancel);
  }
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
    sourceContext: { tabId: context.tabId, frameId: context.frameId, initiator: referrer },
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
      signal: context.signal,
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
      ? `서버(${host}) 연결 실패 (${error?.message || "네트워크 오류"}). 주소가 올바른지, 영상이 재생 중인지 확인해 주세요.`
      : "영상 정보 요청 중 네트워크 오류가 발생했습니다.");
  }
  if (!loaded.ok) throw new Error(`영상 정보 요청 실패 (${loaded.status}): ${redactUrlForMessage(url)}`);
  return {
    text: loaded.text,
    url: loaded.url,
    contentType: loaded.contentType,
  };
}

async function fetchArrayBuffer(url, referrer, label, context = defaultDownloadContext, range = null) {
  const requestReferrer = referrerFor(url, referrer, context);
  const hasRange = range && Number.isInteger(range?.offset) && Number.isInteger(range?.length) && range.length > 0;
  const extraHeaders = hasRange ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {};
  let loaded;
  try {
    loaded = await withMediaFetchLease(url, requestReferrer, async (response) => ({
      ok: response.ok,
      status: response.status,
      data: new Uint8Array(await response.arrayBuffer()),
    }), extraHeaders, context);
  } catch (error) {
    const host = hostForMessage(url);
    throw new Error(host
      ? `${label} 서버(${host}) 연결 실패 (${error?.message || "네트워크 오류"}).`
      : `${label} 요청 중 네트워크 오류가 발생했습니다.`);
  }
  if (!loaded.ok) throw new Error(`${label} 요청 실패 (${loaded.status}): ${redactUrlForMessage(url)}`);
  let data = loaded.data;
  if (hasRange) {
    if (loaded.status === 206) {
      if (data.byteLength !== range.length) {
        throw new Error(`${label} 범위 데이터 길이가 올바르지 않습니다.`);
      }
    } else {
      // Server ignored Range; take the requested sub-range from the full body.
      data = data.subarray(range.offset, Math.min(range.offset + range.length, data.byteLength));
      if (data.byteLength !== range.length) {
        throw new Error(`${label} 범위 데이터가 부족합니다.`);
      }
    }
  }
  return data;
}

function abortError() {
  const error = new Error("사용자가 다운로드를 취소했습니다.");
  error.name = "AbortError";
  error.code = "download-cancelled";
  return error;
}

function level5KeyFailure(code) {
  const normalized = normalizeLevel5KeyError(code);
  const error = new Error(level5KeyErrorMessage(normalized));
  error.code = normalized;
  return error;
}

function raceWithAbort(promise, signal = null) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function abortableDelay(ms, signal = null) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(abortError());
    };
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function requestPageDecodedKey(url, videoTabId, videoFrameId = null, signal = null) {
  if (!Number.isInteger(videoTabId) || videoTabId <= 0) {
    throw level5KeyFailure("level5-key-unavailable");
  }
  async function ask() {
    if (signal?.aborted) throw abortError();
    const response = await raceWithAbort(chrome.runtime.sendMessage({
      type: "decode-hls-key",
      url,
      tabId: videoTabId,
      frameId: videoFrameId,
    }), signal);
    const bytes = response?.ok ? toBytes(response.key) : null;
    if (bytes && (bytes.byteLength === 16 || bytes.byteLength === 32)) return bytes;
    return { code: normalizeLevel5KeyError(response?.error) };
  }
  try {
    const first = await ask();
    if (first instanceof Uint8Array) return first;
    // The player often needs a moment to finish booting its key loader;
    // transient loader failures get one short retry before reporting.
    const transient = new Set([
      "level5-loader-failed",
      "level5-key-load-failed",
      "level5-key-load-timeout",
      "page-bridge-timeout",
      "key-fetch-failed",
      "runtime-import-failed",
    ]);
    if (transient.has(first.code)) {
      await abortableDelay(1_200, signal);
      const retried = await ask();
      if (retried instanceof Uint8Array) return retried;
      throw level5KeyFailure(retried.code || first.code);
    }
    throw level5KeyFailure(first.code);
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw error;
    if (typeof error?.message === "string" && error.message.startsWith("보호된 영상 키 확인 실패:")) throw error;
    throw level5KeyFailure("level5-key-unavailable");
  }
}

async function withParallelMediaFetchLease(url, referrer, context, run) {
  await ensureMediaRoutes([url, referrer]);
  const prepared = await chrome.runtime.sendMessage({
    type: "prepare-media-fetch",
    url,
    referrer,
    sourceContext: { tabId: context.tabId, frameId: context.frameId, initiator: referrer },
  });
  const leaseId = prepared?.leaseId;
  if (!prepared?.ok || leaseId == null) {
    throw new Error("미디어 요청을 준비하지 못했습니다. 확장 프로그램을 다시 로드한 뒤 다시 시도해 주세요.");
  }
  const keepAlive = setInterval(() => {
    void chrome.runtime.sendMessage({ type: "touch-media-fetch", leaseId }).catch(() => {});
  }, 60_000);
  try {
    return await run();
  } finally {
    clearInterval(keepAlive);
    await chrome.runtime.sendMessage({ type: "release-media-fetch", leaseId }).catch(() => {});
  }
}

async function keyMaterial(key, referrer, videoTabId = null, context = defaultDownloadContext) {
  if (!key?.uri) throw new Error("영상 보호 키 주소를 확인할 수 없습니다.");
  const cached = keyMaterialCache.get(key.uri);
  if (cached) return cached;
  let keyBytes = await fetchArrayBuffer(key.uri, referrer, "보호 키", context);
  if (keyBytes.byteLength !== 16 && keyBytes.byteLength !== 32) {
    keyBytes = await requestPageDecodedKey(key.uri, videoTabId, context.frameId, context.signal);
  }
  if (keyBytes.byteLength !== 16 && keyBytes.byteLength !== 32) {
    throw new Error("영상 보호 키를 확인하지 못했습니다. 원본 영상 탭에서 영상을 재생한 뒤 다시 시도해 주세요.");
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
  if (depth > 3) throw new Error("영상 목록 구조가 너무 복잡합니다.");
  const loaded = await fetchText(url, referrer, context);
  if (!isHlsPlaylist(loaded.text, loaded.contentType)) {
    throw new Error(`받은 응답이 영상 목록 형식이 아닙니다 (${redactUrlForMessage(loaded.url)}). 직접 입력한 주소라면 페이지 주소가 아니라 실제 미디어 주소를 넣어 주세요.`);
  }
  const parsed = parseHlsPlaylist(loaded.text, loaded.url);
  for (const key of parsed.keys) {
    if (!SUPPORTED_KEY_METHODS.has(key.method)) {
      throw new Error(key.method === "SAMPLE-AES" || key.method === "SAMPLE-AES-CTR"
        ? "DRM으로 보호된 영상은 지원하지 않습니다."
        : "지원하지 않는 영상 보호 방식입니다.");
    }
  }
  const variant = chooseHlsVariant(parsed.variants);
  if (variant) return loadMediaPlaylist(variant.uri, depth + 1, referrer, context);
  if (!parsed.segments.length) throw new Error("영상 구간을 찾지 못했습니다.");
  if (parsed.segments.length > MAX_HLS_SEGMENTS) throw new Error("영상 구간이 너무 많아 저장할 수 없습니다.");
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
    setStatus(activePlan.backgroundDownloads
      ? `보호 키 ${unique.length}개 준비 완료. 원본 페이지를 벗어나도 다운로드가 계속됩니다.`
      : `보호 키 ${unique.length}개 준비 완료. 원본 페이지를 열어두세요.`, false, context);
  }
  return unique.length;
}

async function fetchSegment(index, media, referrer, videoTabId = null, context = defaultDownloadContext) {
  const activeKey = activeKeyForSegment(media.keys, index);
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      let chunk = await fetchArrayBuffer(
        media.segments[index],
        referrer,
        `영상 ${index + 1}`,
        context,
        media.byteranges?.[index] || null,
      );
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
    let chunk = await fetchArrayBuffer(media.initUrl, referrer, "영상 시작 데이터", context, media.initByterange || null);
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
    assertDownloadWithinPlan(totalBytes, chunk.byteLength);
    totalBytes += chunk.byteLength;
    await context.pauseGate?.();
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
      assertDownloadWithinPlan(totalBytes, chunk.byteLength);
      totalBytes += chunk.byteLength;
      await context.pauseGate?.();
      setStatus(`저장 중… ${index + 1}/${total} (${Math.round(totalBytes / 1048576)} MB)`, false, context);
      await context.paceBytes?.(chunk.byteLength);
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

function progressiveSession(url, pageUrl, videoTabId, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const port = chrome.runtime.connect({ name: "media-stream" });
    let settled = false;
    const abort = () => finish(null, abortError());
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", abort);
      try { port.disconnect(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve(value);
    };
    signal?.addEventListener?.("abort", abort, { once: true });
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
    // Dood-compatible CDNs commonly allow navigation/download from their
    // player frame while rejecting extension-origin fetch probes with CORS.
    // Preserve the fresh URL and let saveProgressive use the source-frame
    // handoff instead of failing before that fallback can run.
    if (isDoodLikeHost(session.url)) {
      return {
        ...session,
        authenticatedProbeRequired: false,
        sourceFrameFallbackPreferred: true,
      };
    }
    throw new Error("인증된 영상 확인 요청 중 네트워크 오류가 발생했습니다. 영상 페이지를 새로고침한 뒤 다시 시도해 주세요.");
  }

  await ensureMediaRoutes([finalUrl]);
  return { ...session, url: finalUrl, authenticatedProbeRequired: false };
}

async function requestSourceFrameDownload(url, filename, videoTabId, videoFrameId = null, signal = null) {
  if (!Number.isInteger(videoTabId) || videoTabId <= 0 || !isDoodLikeHost(url)) return null;
  const requestId = globalThis.crypto?.randomUUID?.() || `source-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cancel = () => {
    void chrome.runtime.sendMessage({ type: "cancel-browser-download", requestId }).catch(() => {});
  };
  signal?.addEventListener?.("abort", cancel, { once: true });
  try {
    const response = await raceWithAbort(chrome.runtime.sendMessage({
      type: "download-in-source-frame",
      requestId,
      url,
      filename,
      tabId: videoTabId,
      frameId: Number.isInteger(videoFrameId) && videoFrameId >= 0 ? videoFrameId : null,
    }), signal);
    if (response?.ok && Number.isInteger(response.downloadId)
      && Number.isFinite(response.bytes) && response.bytes > 0) {
      return { fallback: true, completed: true, bytes: response.bytes };
    }
    if (response?.error === "empty-download") {
      const error = new Error("영상 서버가 빈 파일을 반환했습니다. 영상 페이지를 새로고침하고 재생한 뒤 다시 시도해 주세요.");
      error.code = "empty-download";
      throw error;
    }
    return null;
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError" || error?.code === "empty-download") throw error;
    return null;
  } finally {
    signal?.removeEventListener?.("abort", cancel);
  }
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
    const contentType = response.headers?.get?.("content-type") || "";
    if (/^text\/html/i.test(contentType)) throw new Error("웹페이지가 반환되었습니다. 실제 미디어 주소를 입력해 주세요.");
    if (!response.ok) {
      await consumeResponseBody(response, () => {});
      throw new Error(`영상 요청 실패 (${response.status}): ${redactUrlForMessage(url)}`);
    }
    await consumeResponseBody(response, async (value) => {
      const bytes = toBytes(value);
      if (!bytes) throw new Error(`저장 데이터 형식 오류: ${describeChunk(value)}`);
      assertDownloadWithinPlan(totalBytes, bytes.byteLength);
      totalBytes += bytes.byteLength;
      await context.pauseGate?.();
      onProgress?.(totalBytes);
      await writeChunk(writable, bytes);
      await context.paceBytes?.(bytes.byteLength);
    });
  }, {}, context);
  if (totalBytes === 0) throw new Error("저장된 파일이 비어 있습니다. 주소가 만료되었거나 접근 권한이 필요할 수 있습니다.");
  return totalBytes;
}

async function saveProgressive(
  url,
  filename,
  pageUrl,
  videoTabId,
  context = defaultDownloadContext,
  preparedSession = null,
  dirHandle = null,
) {
  const session = preparedSession
    || await prepareProgressiveFetch(await progressiveSession(url, pageUrl, videoTabId, context.signal), context);
  const saveHandle = dirHandle || await getStoredSaveDirectory();
  let allocation = null;
  const allocatedFile = async () => {
    if (!saveHandle) throw new Error("no-save-sink");
    if (!allocation) allocation = await createUniqueFile(saveHandle, filename);
    return allocation;
  };
  const removeAllocatedFile = async () => {
    if (!saveHandle || !allocation?.filename || typeof saveHandle.removeEntry !== "function") return;
    await saveHandle.removeEntry(allocation.filename).catch(() => {});
    allocation = null;
  };

  if (session.sourceFrameFallbackPreferred) {
    const fallback = await requestSourceFrameDownload(
      session.url,
      filename,
      videoTabId,
      context.frameId,
      context.signal,
    );
    if (fallback) return fallback;
  }

  if (context.rangeSupported) {
    const referrer = referrerFor(session.url, session.referrer || pageUrl, context);
    const fetchImpl = (targetUrl, { headers, signal }) => {
      const all = new Headers(extraHeadersFor(targetUrl, context));
      for (const [name, value] of Object.entries(headers || {})) all.set(name, value);
      return fetch(targetUrl, {
        credentials: "include",
        referrer,
        referrerPolicy: "unsafe-url",
        headers: all,
        cache: "no-store",
        signal,
      });
    };
    try {
      const output = await allocatedFile();
      const writable = await output.fileHandle.createWritable();
      const sink = {
        write: (data) => writable.write(data),
        close: () => writable.close(),
        abort: () => writable.abort(),
      };
      const result = await withParallelMediaFetchLease(session.url, referrer, context, () => parallelDownload({
        url: session.url,
        filename: output.filename,
        createSink: async () => sink,
        fetchImpl,
        signal: context.signal,
        onProgress: (written, total) => setStatus(saveProgressText(written, total), false, context),
      }));
      return { bytes: result.bytes };
    } catch (error) {
      if (context.signal?.aborted) throw error;
      // Fall through to the single-stream path.
    }
  }

  let writable = null;
  let sinkError = null;
  if (saveHandle) {
    try {
      const output = await allocatedFile();
      writable = await output.fileHandle.createWritable();
    } catch (error) {
      writable = null;
      sinkError = error;
    }
  }
  if (!writable) {
    await removeAllocatedFile();
    const downloaded = await tryBrowserDownloadFallback(
      session.url,
      filename,
      activePlan,
      session.referrer || pageUrl,
      context,
    );
    if (downloaded) return downloaded;
    throw new Error(sinkError?.name === "NotAllowedError"
      ? "저장 폴더 권한이 만료되었습니다. 다운로드 버튼을 다시 누르면 폴더를 다시 선택합니다."
      : "저장 폴더에 쓸 수 없습니다. 다운로드 버튼을 다시 누르면 폴더 선택이 열립니다.");
  }
  try {
    const bytes = await streamFetchToWritable(
      session.url,
      session.referrer,
      writable,
      (value) => setStatus(saveProgressText(value, context.totalBytes), false, context),
      context,
    );
    await writable.close();
    return { bytes };
  } catch (error) {
    try { await writable.abort(); } catch { /* already closed */ }
    if (error?.code !== "media-route-failed") {
      const fallback = await requestSourceFrameDownload(
        session.url,
        filename,
        videoTabId,
        context.frameId,
        context.signal,
      );
      if (fallback) {
        await removeAllocatedFile();
        return fallback;
      }
    }
    await removeAllocatedFile();
    throw error;
  }
}

async function saveHlsToNative(media, filename, referrer, videoTabId = null, context = defaultDownloadContext, dirHandle = null) {
  const saveHandle = dirHandle || await getStoredSaveDirectory();
  if (!saveHandle) {
    throw new Error("분할 형식 영상은 저장 폴더 연결이 필요합니다. 다운로드 버튼을 다시 누르면 폴더 선택이 열립니다.");
  }
  let writable;
  let allocation = null;
  try {
    allocation = await createUniqueFile(saveHandle, filename);
    writable = await allocation.fileHandle.createWritable();
  } catch (error) {
    throw new Error(error?.name === "NotAllowedError"
      ? "저장 폴더 권한이 만료되었습니다. 다운로드 버튼을 다시 누르면 폴더를 다시 선택합니다."
      : "저장 폴더에 쓸 수 없습니다. 옵션 → 저장 폴더 변경에서 새 빈 폴더를 다시 지정해 주세요.");
  }
  let count = 0;
  let writtenBytes = 0;
  try {
    for await (const chunk of mediaChunks(media, referrer, videoTabId, context)) {
      await writeChunk(writable, chunk);
      writtenBytes += chunk.byteLength;
      count += 1;
    }
    if (writtenBytes === 0) throw new Error("저장된 파일이 비어 있습니다. 주소가 만료되었거나 접근 권한이 필요할 수 있습니다.");
    await writable.close();
    return { count };
  } catch (error) {
    try { await writable.abort(); } catch { /* already closed */ }
    if (allocation?.filename && typeof saveHandle.removeEntry === "function") {
      await saveHandle.removeEntry(allocation.filename).catch(() => {});
    }
    throw error;
  }
}

export {
  ensureCurrentBackground,
  loadRecordedHeaders,
  prepareProgressiveFetch,
  progressiveSession,
  requestSourceFrameDownload,
  requestPageDecodedKey,
  streamFetchToWritable,
  toBytes,
  withMediaFetchLease,
  writeChunk,
};

export async function prepareDownloadCandidate(candidate, {
  onStatus = null,
  pauseGate = null,
  paceBytes = null,
  signal = null,
} = {}) {
  if (!candidate || typeof candidate.resourceUrl !== "string") throw new Error("다운로드 후보가 올바르지 않습니다.");

  const context = createDownloadContext({
    onStatus,
    pauseGate,
    paceBytes: paceBytes || createSpeedGate(activePlan.downloadSpeedLimitBytesPerSecond),
    signal,
    frameId: candidate.frameId,
    tabId: candidate.tabId,
  });
  await loadRecordedHeaders(context);
  const progressive = candidate.mediaType === "PROGRESSIVE";
  if (progressive) {
    const fallbackFilename = progressiveFilenameFor(candidate);
    const extension = /\.([a-z0-9]{2,5})$/i.exec(fallbackFilename)?.[1] || "mp4";
    const filename = filenameFromTemplate(
      await configuredFilenameTemplate(),
      candidate,
      candidate.pageTitle && candidate.pageTitle !== "직접 입력한 주소" ? candidate.pageTitle : fallbackFilename.replace(/\.[^.]+$/, ""),
      extension,
      fallbackFilename,
    );
    setStatus("영상을 확인하는 중…", false, context);
    const session = await prepareProgressiveFetch(
      await progressiveSession(candidate.resourceUrl, candidate.pageUrl, candidate.tabId, context.signal),
      context,
    );
    setStatus(activePlan.backgroundDownloads
      ? "영상 준비 완료. 원본 페이지를 벗어나도 다운로드가 계속됩니다."
      : "영상 준비 완료. 다운로드가 끝날 때까지 원본 페이지를 열어두세요.", false, context);
    let probed = null;
    try { probed = await probeDownloadTotalBytes(session.url, session.referrer, context); } catch { probed = null; }
    if (probed) {
      const contentType = String(probed.contentType || "");
      if (contentType && !/^(video|audio)\//i.test(contentType) && !/octet-stream/i.test(contentType)) {
        throw new Error("이 주소는 영상 파일이 아니라 웹페이지입니다. 실제 미디어 주소를 입력해 주세요.");
      }
      context.totalBytes = Number.isFinite(probed.total) && probed.total >= 0 ? probed.total : null;
      context.rangeSupported = probed.rangeSupported === true;
    }
    return {
      type: "progressive",
      candidate,
      context,
      filename,
      session,
    };
  }

  if (candidate.mediaType === "DASH") {
    setStatus("DASH 영상 정보를 확인하는 중…", false, context);
    const loaded = await fetchText(candidate.resourceUrl, candidate.pageUrl, context);
    let plan;
    try {
      plan = parseDashManifest(loaded.text, loaded.url);
    } catch (error) {
      if (error instanceof DashParseError) {
        const wrapped = new Error(`DASH 정보를 분석하지 못했습니다 (${error.code}).`);
        wrapped.code = `dash-${error.code}`;
        throw wrapped;
      }
      throw error;
    }
    const filenameTemplate = await configuredFilenameTemplate();
    const tracks = dashTracksForPlan(plan, candidate.pageTitle || "DASH 영상").map((track) => ({
      ...track,
      filename: filenameFromTemplate(filenameTemplate, candidate, track.title, track.extension, track.filename),
    }));
    await ensureMediaRoutes(tracks.flatMap((track) => [
      track.media.initUrl,
      ...track.media.segments,
    ]));
    const segments = tracks.reduce((sum, track) => sum + track.media.segments.length, 0);
    setStatus(`DASH 정보 확인 완료 · ${tracks.length}개 트랙 · ${segments}개 구간.`, false, context);
    return { type: "dash", candidate, context, plan, tracks };
  }

  if (candidate.mediaType !== "HLS_MASTER" && candidate.mediaType !== "HLS_MEDIA") {
    throw new Error("unsupported-media");
  }
  setStatus("영상 정보를 확인하는 중…", false, context);
  const media = await loadMediaPlaylist(candidate.resourceUrl, 0, candidate.pageUrl, context);
  const extension = hlsFileExtension(media.initUrl, media.segments);
  const filename = filenameFromTemplate(
    await configuredFilenameTemplate(),
    candidate,
    candidate.pageTitle,
    extension,
    filenameFor(candidate.pageTitle, extension),
  );
  setStatus(`영상 정보 확인 완료 (${media.segments.length}개 구간).`, false, context);
  await prepareHlsKeys(media, candidate.pageUrl, candidate.tabId, context);
  return { type: "hls", candidate, context, filename, media };
}

export async function downloadPreparedCandidate(prepared) {
  if (!prepared?.candidate || !prepared.context) throw new Error("준비된 다운로드 작업이 올바르지 않습니다.");
  const { candidate, context, filename, dirHandle = null } = prepared;
  if (prepared.type === "progressive") {
    const result = await saveProgressive(
      candidate.resourceUrl,
      filename,
      candidate.pageUrl,
      candidate.tabId,
      context,
      prepared.session,
      dirHandle,
    );
    return {
      statusText: result.fallback
        ? `브라우저 기본 다운로드 폴더에 저장을 완료했습니다 (${Math.round(result.bytes / 1048576)} MB).`
        : `다운로드를 완료했습니다 (${Math.round(result.bytes / 1048576)} MB).`,
    };
  }
  if (prepared.type === "dash" && Array.isArray(prepared.tracks)) {
    for (let index = 0; index < prepared.tracks.length; index += 1) {
      const track = prepared.tracks[index];
      setStatus(`DASH ${track.kind === "audio" ? "오디오" : "비디오"} 저장 중… ${index + 1}/${prepared.tracks.length}`, false, context);
      await saveHlsToNative(track.media, track.filename, candidate.pageUrl, candidate.tabId, context, dirHandle);
    }
    return {
      statusText: prepared.tracks.length > 1
        ? `DASH 다운로드를 완료했습니다. 비디오·오디오 ${prepared.tracks.length}개 파일로 저장했습니다.`
        : "DASH 다운로드를 완료했습니다.",
    };
  }
  if (prepared.type !== "hls" || !prepared.media) throw new Error("준비된 다운로드 형식을 지원하지 않습니다.");
  const saved = await saveHlsToNative(prepared.media, filename, candidate.pageUrl, candidate.tabId, context, dirHandle);
  return {
    statusText: "다운로드를 완료했습니다. 저장 폴더에서 확인하세요.",
  };
}

export async function downloadCandidate(candidate, options = {}) {
  return downloadPreparedCandidate(await prepareDownloadCandidate(candidate, options));
}
