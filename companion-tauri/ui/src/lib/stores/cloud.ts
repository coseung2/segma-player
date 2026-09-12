import { get, writable } from "svelte/store";
import {
  cancelCloudJob, cloudStatus, listCloudItems, listCloudJobs,
  pickCloudDownloadDestination, pickCloudUpload, startCloudDelete,
  startCloudDownload, startCloudUpload,
  type CloudItemDto, type CloudJobDto, type CloudStatusDto,
} from "../api";

export interface CloudState {
  status: CloudStatusDto | null;
  items: CloudItemDto[];
  jobs: CloudJobDto[];
  loading: boolean;
  refreshing: boolean;
  action: string | null;
  error: string | null;
  notice: string | null;
  lastUpdated: number | null;
}

const initial: CloudState = {
  status: null, items: [], jobs: [], loading: false, refreshing: false,
  action: null, error: null, notice: null, lastUpdated: null,
};

export const cloudState = writable<CloudState>(initial);

let polling = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let loadSequence = 0;
let terminalSnapshot = new Set<string>();

const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

export const isCloudJobActive = (job: CloudJobDto) => ["queued", "running"].includes(job.status);
export const isCloudJobCancellable = (job: CloudJobDto) => isCloudJobActive(job);
const terminal = (job: CloudJobDto) => !isCloudJobActive(job);
const terminalKey = (job: CloudJobDto) => `${job.jobId}:${job.status}:${job.updatedAt}`;

async function refreshItems(): Promise<void> {
  const items = await listCloudItems();
  cloudState.update((state) => ({ ...state, items }));
}

export async function loadCloud(silent = false): Promise<void> {
  const sequence = ++loadSequence;
  const firstLoad = get(cloudState).lastUpdated === null;
  cloudState.update((state) => ({
    ...state,
    loading: !silent && firstLoad,
    refreshing: silent,
    error: null,
  }));
  try {
    const [status, items, jobs] = await Promise.all([
      cloudStatus(), listCloudItems(), listCloudJobs(),
    ]);
    if (sequence !== loadSequence) return;
    const nextTerminals = new Set(jobs.filter(terminal).map(terminalKey));
    const completedSinceLastLoad = [...nextTerminals].some((key) => !terminalSnapshot.has(key));
    terminalSnapshot = nextTerminals;
    cloudState.update((state) => ({
      ...state,
      status,
      items,
      jobs,
      loading: false,
      refreshing: false,
      lastUpdated: Date.now(),
    }));
    if (completedSinceLastLoad && silent) await refreshItems();
  } catch (error) {
    if (sequence !== loadSequence) return;
    cloudState.update((state) => ({
      ...state,
      loading: false,
      refreshing: false,
      error: message(error, "텔레그램 보관함을 불러오지 못했습니다."),
    }));
  }
}

async function runAction(key: string, task: () => Promise<boolean>, success: string): Promise<void> {
  if (get(cloudState).action !== null) return;
  cloudState.update((state) => ({ ...state, action: key, error: null, notice: null }));
  try {
    const accepted = await task();
    cloudState.update((state) => ({
      ...state,
      action: null,
      notice: accepted ? success : null,
    }));
    if (accepted) await loadCloud(true);
  } catch (error) {
    cloudState.update((state) => ({
      ...state,
      action: null,
      error: message(error, "클라우드 작업을 시작하지 못했습니다."),
    }));
  }
}

export function uploadCloudItem(): Promise<void> {
  return runAction("upload", async () => {
    const selection = await pickCloudUpload();
    if (!selection) return false;
    await startCloudUpload({ localPath: selection.localPath });
    return true;
  }, "업로드를 시작했습니다.");
}

export function downloadCloudItem(item: CloudItemDto): Promise<void> {
  return runAction(`download:${item.itemId}`, async () => {
    const localPath = await pickCloudDownloadDestination({ fileName: item.fileName });
    if (!localPath) return false;
    await startCloudDownload({ itemId: item.itemId, localPath });
    return true;
  }, "다운로드를 시작했습니다.");
}

export function deleteCloudItem(item: CloudItemDto): Promise<void> {
  return runAction(`delete:${item.itemId}`, async () => {
    await startCloudDelete({ itemId: item.itemId });
    return true;
  }, "삭제를 시작했습니다.");
}

export function cancelCloudTransfer(job: CloudJobDto): Promise<void> {
  if (!isCloudJobCancellable(job)) return Promise.resolve();
  return runAction(`cancel:${job.jobId}`, async () => {
    await cancelCloudJob({ jobId: job.jobId });
    return true;
  }, "취소를 요청했습니다.");
}

async function poll(): Promise<void> {
  if (!polling) return;
  await loadCloud(true);
  if (polling) pollTimer = setTimeout(() => void poll(), 1_500);
}

export function startCloudPolling(): void {
  if (polling) return;
  polling = true;
  void loadCloud().finally(() => {
    if (polling && pollTimer === null) pollTimer = setTimeout(() => void poll(), 1_500);
  });
}

export function stopCloudPolling(): void {
  polling = false;
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = null;
}
