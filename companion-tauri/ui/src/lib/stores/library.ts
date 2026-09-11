import { get, writable } from "svelte/store";
import {
  autoOrganizeLibrary, deleteLibraryFile, listLibrary, moveLibraryFile,
  openLibraryFolder, revealLibraryFile, updateLibraryMetadata,
  type AutoOrganizeResponse, type LibraryEntryDto, type LibraryListResponse,
  type MetadataUpdateRequest,
} from "../api";

export interface LibraryState {
  data: LibraryListResponse;
  loading: boolean;
  refreshing: boolean;
  action: string | null;
  error: string | null;
  notice: string | null;
  organization: AutoOrganizeResponse | null;
}

const emptyData: LibraryListResponse = { folder: null, folders: [], entries: [], missingOutputCount: 0, usageBytes: 0 };
export const libraryState = writable<LibraryState>({
  data: emptyData, loading: false, refreshing: false, action: null, error: null, notice: null, organization: null,
});
let libraryRequestSequence = 0;

export async function loadLibrary(folder: string | null, silent = false): Promise<void> {
  const sequence = ++libraryRequestSequence;
  libraryState.update((state) => ({ ...state, loading: !silent, refreshing: silent, error: null }));
  try {
    const response = await listLibrary({ folder });
    if (sequence !== libraryRequestSequence) return;
    libraryState.update((state) => ({ ...state, data: response, loading: false, refreshing: false }));
  } catch (error) {
    if (sequence !== libraryRequestSequence) return;
    libraryState.update((state) => ({ ...state, loading: false, refreshing: false, error: error instanceof Error ? error.message : "보관함을 불러오지 못했습니다." }));
  }
}

async function withAction<T>(label: string, task: () => Promise<T>, success: string): Promise<T | undefined> {
  libraryState.update((state) => ({ ...state, action: label, error: null, notice: null }));
  try {
    const result = await task();
    libraryState.update((state) => ({ ...state, action: null, notice: success }));
    return result;
  } catch (error) {
    libraryState.update((state) => ({ ...state, action: null, error: error instanceof Error ? error.message : "보관함 작업을 처리하지 못했습니다." }));
    return undefined;
  }
}

export async function editMetadata(request: MetadataUpdateRequest): Promise<void> {
  const response = await withAction(`metadata:${request.fileName}`, () => updateLibraryMetadata(request), "메타데이터를 저장했습니다.");
  if (!response) return;
  libraryState.update((state) => ({
    ...state,
    data: { ...state.data, entries: state.data.entries.map((entry) => entry.fileName === response.fileName ? { ...entry, metadata: response.metadata } : entry) },
  }));
}

export async function revealFile(entry: LibraryEntryDto): Promise<void> {
  await withAction(`reveal:${entry.fileName}`, () => revealLibraryFile({ folder: get(libraryState).data.folder, fileName: entry.fileName }), "파일 위치를 열었습니다.");
}

export async function moveFile(entry: LibraryEntryDto, destinationFolder: string | null): Promise<void> {
  const sourceFolder = get(libraryState).data.folder;
  const response = await withAction(`move:${entry.fileName}`, () => moveLibraryFile({ sourceFolder, fileName: entry.fileName, destinationFolder }), "파일을 이동했습니다.");
  if (response) await loadLibrary(sourceFolder, true);
}

export async function recycleFile(entry: LibraryEntryDto): Promise<void> {
  const folder = get(libraryState).data.folder;
  const response = await withAction(`delete:${entry.fileName}`, () => deleteLibraryFile({ folder, fileName: entry.fileName }), "휴지통으로 이동했습니다.");
  if (response) await loadLibrary(folder, true);
}

export async function organize(apply: boolean): Promise<void> {
  const response = await withAction(`organize:${apply ? "apply" : "preview"}`, () => autoOrganizeLibrary({ apply }), apply ? "자동 정리를 적용했습니다." : "자동 정리 계획을 계산했습니다.");
  if (response) libraryState.update((state) => ({ ...state, organization: response }));
  if (apply && response) await loadLibrary(get(libraryState).data.folder, true);
}

export async function openFolder(): Promise<void> {
  await withAction("open-folder", () => openLibraryFolder({ folder: get(libraryState).data.folder }), "보관함 폴더를 열었습니다.");
}
