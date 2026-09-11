import { get, writable } from "svelte/store";
import {
  importSubtitle,
  isPreviewUnavailable,
  listSubtitleCapabilities,
  loadSidecarSubtitles,
  startOrGenerateSubtitle,
  syncSubtitle,
  type ImportSubtitleRequest,
  type ImportSubtitleResponse,
  type SidecarSubtitleDto,
  type StartOrGenerateSubtitleRequest,
  type SubtitleCapabilitiesDto,
  type SubtitleJobResponse,
  type SyncSubtitleRequest,
  type SyncSubtitleResponse,
} from "../api";
import { loadJobs } from "./jobs";
import { mediaIdentity } from "../selection-identity";

export type SubtitlePendingAction = "generate" | "import" | "sync" | null;

export interface SubtitleState {
  mediaIdentity: string | null;
  mediaFileName: string | null;
  subtitles: SidecarSubtitleDto[];
  loading: boolean;
  loaded: boolean;
  unavailable: boolean;
  error: string | null;
  notice: string | null;
  capabilities: SubtitleCapabilitiesDto | null;
  capabilitiesLoading: boolean;
  pendingAction: SubtitlePendingAction;
  selectedSourceLanguage: string;
  selectedTargetLanguage: string;
  importRefresh: number;
  syncOffsetSeconds: number;
}

const DEFAULT_MAX_OFFSET_SECONDS = 24 * 60 * 60;

const initial: SubtitleState = {
  mediaIdentity: null,
  mediaFileName: null,
  subtitles: [],
  loading: false,
  loaded: false,
  unavailable: false,
  error: null,
  notice: null,
  capabilities: null,
  capabilitiesLoading: false,
  pendingAction: null,
  selectedSourceLanguage: "ja",
  selectedTargetLanguage: "ko",
  importRefresh: 0,
  syncOffsetSeconds: 0,
};

export const subtitleState = writable<SubtitleState>(initial);
let requestSequence = 0;

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function updateActionState(pendingAction: SubtitlePendingAction, error: string | null, notice: string | null): void {
  subtitleState.update((state) => ({ ...state, pendingAction, error, notice }));
}

async function refreshAfterAction(folder: string | null, fileName: string): Promise<void> {
  const identity = mediaIdentity(folder, fileName);
  if (get(subtitleState).mediaIdentity !== identity) return;
  await Promise.all([loadJobs(true), loadSubtitlesFor(folder, fileName, true)]);
}

export async function loadSubtitleCapabilities(force = false): Promise<void> {
  const current = get(subtitleState);
  if (!force && (current.capabilitiesLoading || current.capabilities)) return;
  subtitleState.update((state) => ({ ...state, capabilitiesLoading: true, error: null }));
  try {
    const capabilities = await listSubtitleCapabilities();
    subtitleState.update((state) => ({
      ...state,
      capabilities,
      capabilitiesLoading: false,
      error: null,
      selectedSourceLanguage: capabilities.sourceLanguages.some((language) => language.code === state.selectedSourceLanguage)
        ? state.selectedSourceLanguage
        : capabilities.sourceLanguages[0]?.code ?? "",
      selectedTargetLanguage: capabilities.targetLanguages.some((language) => language.code === state.selectedTargetLanguage)
        ? state.selectedTargetLanguage
        : capabilities.targetLanguages[0]?.code ?? "",
      syncOffsetSeconds: Math.min(
        Math.max(state.syncOffsetSeconds, -capabilities.maxOffsetSeconds),
        capabilities.maxOffsetSeconds,
      ),
    }));
  } catch (error) {
    subtitleState.update((state) => ({
      ...state,
      capabilitiesLoading: false,
      error: errorMessage(error, "자막 기능을 확인하지 못했습니다."),
    }));
  }
}

export function setSelectedSourceLanguage(language: string): void {
  subtitleState.update((state) => ({ ...state, selectedSourceLanguage: language, error: null, notice: null }));
}

export function setSelectedTargetLanguage(language: string): void {
  subtitleState.update((state) => ({ ...state, selectedTargetLanguage: language, error: null, notice: null }));
}

export function setSyncOffsetSeconds(value: number): void {
  subtitleState.update((state) => {
    const max = state.capabilities?.maxOffsetSeconds ?? DEFAULT_MAX_OFFSET_SECONDS;
    const offset = Number.isFinite(value) ? value : 0;
    return { ...state, syncOffsetSeconds: Math.min(Math.max(offset, -max), max), error: null, notice: null };
  });
}

export async function loadSubtitlesFor(folder: string | null, fileName: string, force = false): Promise<void> {
  const current = get(subtitleState);
  const identity = mediaIdentity(folder, fileName);
  if (!force && current.mediaIdentity === identity && (current.loading || current.loaded || current.unavailable)) return;
  const sequence = ++requestSequence;
  subtitleState.update((state) => ({
    ...state,
    mediaIdentity: identity,
    mediaFileName: fileName,
    subtitles: [],
    loading: true,
    loaded: false,
    unavailable: false,
    error: null,
    notice: null,
  }));
  try {
    const result = await loadSidecarSubtitles({ folder, fileName });
    if (sequence !== requestSequence) return;
    if (isPreviewUnavailable(result)) {
      subtitleState.update((state) => ({
        ...state,
        mediaIdentity: identity,
        mediaFileName: fileName,
        subtitles: [],
        loading: false,
        loaded: true,
        unavailable: true,
        error: null,
      }));
      return;
    }
    if (mediaIdentity(folder, result.fileName) !== identity) return;
    subtitleState.update((state) => ({
      ...state,
      mediaIdentity: identity,
      mediaFileName: result.fileName,
      subtitles: result.subtitles,
      loading: false,
      loaded: true,
      unavailable: false,
      error: null,
    }));
  } catch (error) {
    if (sequence !== requestSequence) return;
    subtitleState.update((state) => ({
      ...state,
      mediaIdentity: identity,
      mediaFileName: fileName,
      subtitles: [],
      loading: false,
      loaded: false,
      unavailable: false,
      error: errorMessage(error, "자막을 불러오지 못했습니다."),
    }));
  }
}

export async function generateSubtitleFor(request: StartOrGenerateSubtitleRequest): Promise<SubtitleJobResponse | null> {
  const identity = mediaIdentity(request.folder ?? null, request.fileName);
  updateActionState("generate", null, null);
  try {
    const response = await startOrGenerateSubtitle(request);
    await refreshAfterAction(request.folder ?? null, request.fileName);
    if (get(subtitleState).mediaIdentity === identity) updateActionState(null, null, "자막 생성 작업을 시작했습니다.");
    return response;
  } catch (error) {
    if (get(subtitleState).mediaIdentity !== identity) return null;
    updateActionState(null, errorMessage(error, "자막 생성 작업을 시작하지 못했습니다."), null);
    return null;
  }
}

export async function importSubtitleFor(request: ImportSubtitleRequest): Promise<ImportSubtitleResponse | null> {
  const identity = mediaIdentity(request.folder ?? null, request.fileName);
  updateActionState("import", null, null);
  try {
    const response = await importSubtitle(request);
    if (get(subtitleState).mediaIdentity === identity) {
      subtitleState.update((state) => ({ ...state, importRefresh: state.importRefresh + 1 }));
    }
    await refreshAfterAction(request.folder ?? null, request.fileName);
    if (get(subtitleState).mediaIdentity === identity) updateActionState(null, null, `자막을 가져왔습니다: ${response.fileName}`);
    return response;
  } catch (error) {
    if (get(subtitleState).mediaIdentity !== identity) return null;
    if (errorCode(error) === "cancelled") {
      updateActionState(null, null, "자막 가져오기를 취소했습니다.");
    } else {
      updateActionState(null, errorMessage(error, "자막을 가져오지 못했습니다."), null);
    }
    return null;
  }
}

export async function syncSubtitleFor(request: SyncSubtitleRequest): Promise<SyncSubtitleResponse | null> {
  const identity = mediaIdentity(request.folder ?? null, request.fileName);
  const max = get(subtitleState).capabilities?.maxOffsetSeconds ?? DEFAULT_MAX_OFFSET_SECONDS;
  const offsetSeconds = Math.min(Math.max(request.offsetSeconds, -max), max);
  updateActionState("sync", null, null);
  try {
    const response = await syncSubtitle({ ...request, offsetSeconds });
    await refreshAfterAction(request.folder ?? null, request.fileName);
    if (get(subtitleState).mediaIdentity === identity) updateActionState(null, null, `자막 동기화를 완료했습니다 (${offsetSeconds >= 0 ? "+" : ""}${offsetSeconds}초).`);
    return response;
  } catch (error) {
    if (get(subtitleState).mediaIdentity !== identity) return null;
    updateActionState(null, errorMessage(error, "자막을 동기화하지 못했습니다."), null);
    return null;
  }
}

export function resetSubtitles(): void {
  requestSequence += 1;
  const current = get(subtitleState);
  subtitleState.set({
    ...initial,
    capabilities: current.capabilities,
    capabilitiesLoading: current.capabilitiesLoading,
    selectedSourceLanguage: current.selectedSourceLanguage,
    selectedTargetLanguage: current.selectedTargetLanguage,
    importRefresh: current.importRefresh,
    syncOffsetSeconds: current.syncOffsetSeconds,
  });
}
