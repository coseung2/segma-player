import { writable } from "svelte/store";
import { getLicense, removeLicense, verifyLicense, type LicenseDto } from "../api";

export interface LicenseState {
  license: LicenseDto | null;
  loading: boolean;
  refreshing: boolean;
  action: string | null;
  verifying: boolean;
  removing: boolean;
  error: string | null;
  notice: string | null;
}

export const licenseState = writable<LicenseState>({ license: null, loading: false, refreshing: false, action: null, verifying: false, removing: false, error: null, notice: null });

export async function loadLicense(silent = false): Promise<void> {
  licenseState.update((state) => ({ ...state, loading: !silent, refreshing: silent, error: null }));
  try {
    const license = await getLicense();
    licenseState.update((state) => ({ ...state, license, loading: false, refreshing: false }));
  } catch (error) {
    licenseState.update((state) => ({ ...state, loading: false, refreshing: false, error: error instanceof Error ? error.message : "라이선스 상태를 불러오지 못했습니다." }));
  }
}

export const refreshLicense = (): Promise<void> => loadLicense(true);

export async function verifyLicenseKey(key: string): Promise<boolean> {
  if (!key.trim()) {
    licenseState.update((state) => ({ ...state, error: "라이선스 키를 입력해 주세요." }));
    return false;
  }
  licenseState.update((state) => ({ ...state, verifying: true, action: "verify-license", error: null, notice: null }));
  try {
    const license = await verifyLicense({ key: key.trim() });
    licenseState.update((state) => ({ ...state, license, verifying: false, action: null, notice: "Segma Player Pro 인증이 완료되었습니다." }));
    return true;
  } catch (error) {
    licenseState.update((state) => ({ ...state, verifying: false, action: null, error: error instanceof Error ? error.message : "라이선스를 확인하지 못했습니다." }));
    return false;
  }
}

export async function removeLicenseKey(): Promise<void> {
  licenseState.update((state) => ({ ...state, removing: true, action: "remove-license", error: null, notice: null }));
  try {
    const license = await removeLicense();
    licenseState.update((state) => ({ ...state, license, removing: false, action: null, notice: "일반 플랜으로 전환했습니다." }));
  } catch (error) {
    licenseState.update((state) => ({ ...state, removing: false, action: null, error: error instanceof Error ? error.message : "라이선스를 제거하지 못했습니다." }));
  }
}
