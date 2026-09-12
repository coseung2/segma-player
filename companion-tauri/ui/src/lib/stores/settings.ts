import { writable } from "svelte/store";
import { getSettings, openLibraryFolder, updateDownloadFolder, type SettingsDto } from "../api";

export interface SettingsState {
  settings: SettingsDto | null;
  loading: boolean;
  refreshing: boolean;
  saving: boolean;
  action: string | null;
  error: string | null;
  notice: string | null;
}

export const settingsState = writable<SettingsState>({ settings: null, loading: false, refreshing: false, saving: false, action: null, error: null, notice: null });

export async function loadSettings(silent = false): Promise<void> {
  settingsState.update((state) => ({ ...state, loading: !silent, refreshing: silent, error: null }));
  try {
    const settings = await getSettings();
    settingsState.update((state) => ({ ...state, settings, loading: false, refreshing: false }));
  } catch (error) {
    settingsState.update((state) => ({ ...state, loading: false, refreshing: false, error: error instanceof Error ? error.message : "설정을 불러오지 못했습니다." }));
  }
}

export const refreshSettings = (): Promise<void> => loadSettings(true);

export async function saveDownloadFolder(downloadFolder: string): Promise<void> {
  const folder = downloadFolder.trim();
  if (!folder) {
    settingsState.update((state) => ({ ...state, error: "다운로드 폴더를 입력해 주세요." }));
    return;
  }
  settingsState.update((state) => ({ ...state, saving: true, action: "save-folder", error: null, notice: null }));
  try {
    const settings = await updateDownloadFolder({ downloadFolder: folder });
    settingsState.update((state) => ({ ...state, settings, saving: false, action: null, notice: "다운로드 폴더를 저장했습니다." }));
  } catch (error) {
    settingsState.update((state) => ({ ...state, saving: false, action: null, error: error instanceof Error ? error.message : "다운로드 폴더를 저장하지 못했습니다." }));
  }
}

export async function openDownloadFolder(): Promise<void> {
  settingsState.update((state) => ({ ...state, action: "open-folder", error: null, notice: null }));
  try {
    await openLibraryFolder({});
    settingsState.update((state) => ({ ...state, action: null, notice: "다운로드 폴더를 열었습니다." }));
  } catch (error) {
    settingsState.update((state) => ({ ...state, action: null, error: error instanceof Error ? error.message : "폴더를 열지 못했습니다." }));
  }
}
