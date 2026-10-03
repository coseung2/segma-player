import { get, writable } from "svelte/store";
import {
  cancelJob, listJobs, pauseJob, resumeJob, retryJob, resolveJobOutput, revealJobOutput, listLibrary, removeJobHistory,
  type JobActionCode, type JobDto, type LibraryEntryDto,
} from "../api";
import { selectMedia } from "./player";
import { actionHasSettled, canRemoveHistory, type PendingJobAction } from "../queue-policy";

export interface JobsState {
  jobs: JobDto[];
  loading: boolean;
  refreshing: boolean;
  action: string | null;
  busy: Record<string, string>;
  pending: Record<string, PendingJobAction>;
  error: string | null;
  notice: string | null;
  lastUpdated: number | null;
}

const initial: JobsState = {
  jobs: [], loading: false, refreshing: false, action: null, busy: {}, pending: {},
  error: null, notice: null, lastUpdated: null,
};

export const jobsState = writable<JobsState>(initial);
let loadSequence = 0;

export type QueueAction = JobActionCode;

export function queueActionReason(action: string): string | null {
  if (["cancel", "pause", "resume", "retry", "play", "openFolder"].includes(action)) return null;
  return "현재 Tauri 백엔드가 알 수 없는 Queue 동작을 제공했습니다.";
}

export function isQueueActionSupported(action: string): boolean {
  return queueActionReason(action) === null;
}

export interface ResolvedJobMedia {
  folder: string | null;
  entry: LibraryEntryDto;
  entries: LibraryEntryDto[];
}

export async function resolveJobMedia(job: JobDto): Promise<ResolvedJobMedia | null> {
  const output = await resolveJobOutput({ jobId: job.jobId });
  const listing = await listLibrary({ folder: output.folder });
  const entry = listing.entries.find((candidate) => candidate.fileName === output.fileName);
  return entry ? { folder: output.folder, entry, entries: listing.entries } : null;
}

export async function loadJobs(silent = false): Promise<void> {
  const sequence = ++loadSequence;
  jobsState.update((state) => ({ ...state, loading: !silent && state.lastUpdated === null, refreshing: true, error: silent ? state.error : null }));
  try {
    const response = await listJobs();
    if (sequence !== loadSequence) return;
    jobsState.update((state) => {
      const pending = { ...state.pending };
      let error = state.error;
      for (const [id, request] of Object.entries(pending)) {
        const job = response.jobs.find((item) => item.jobId === id);
        if (!job || actionHasSettled(job, request)) delete pending[id];
        else if (Date.now() - request.requestedAt > 20_000) {
          delete pending[id];
          error = "작업 상태 변경이 지연되고 있습니다. 상태를 확인한 뒤 다시 시도해 주세요.";
        }
      }
      return { ...state, jobs: response.jobs, pending, error, loading: false, refreshing: false, lastUpdated: Date.now() };
    });
  } catch (error) {
    if (sequence !== loadSequence) return;
    jobsState.update((state) => ({ ...state, loading: false, refreshing: false, error: error instanceof Error ? error.message : "다운로드 목록을 불러오지 못했습니다." }));
  }
}

export async function runJobAction(job: JobDto, action: QueueAction, onOpenPlayer?: () => void): Promise<void> {
  const state = get(jobsState);
  if (state.busy[job.jobId] || state.pending[job.jobId]) return;
  if (!job.actions.includes(action)) return;
  if (!isQueueActionSupported(action)) {
    jobsState.update((state) => ({ ...state, error: null, notice: queueActionReason(action) }));
    return;
  }
  jobsState.update((state) => ({ ...state, action: `${action}:${job.jobId}`, busy: { ...state.busy, [job.jobId]: action }, error: null, notice: null }));
  try {
    if (action === "cancel") await cancelJob({ jobId: job.jobId });
    else if (action === "pause") await pauseJob({ jobId: job.jobId });
    else if (action === "resume") await resumeJob({ jobId: job.jobId });
    else if (action === "retry") await retryJob({ jobId: job.jobId });
    else if (action === "play") {
      const resolved = await resolveJobMedia(job);
      if (!resolved) throw new Error("재생할 파일을 하나의 라이브러리 위치로 확인하지 못했습니다.");
      selectMedia(resolved.entry, resolved.folder, resolved.entries);
      onOpenPlayer?.();
    } else if (action === "openFolder") {
      await revealJobOutput({ jobId: job.jobId });
    }
    const mutation = ["cancel", "pause", "resume", "retry"].includes(action);
    if (mutation) {
      jobsState.update((state) => ({ ...state, pending: { ...state.pending, [job.jobId]: { action: action as PendingJobAction["action"], requestedAt: Date.now(), previousUpdatedAt: job.updatedAt } } }));
      await loadJobs(true);
    } else if (action === "openFolder") jobsState.update((state) => ({ ...state, notice: "파일 위치를 열었습니다." }));
  } catch (error) {
    jobsState.update((state) => ({ ...state, error: error instanceof Error ? error.message : "작업을 처리하지 못했습니다." }));
  } finally {
    jobsState.update((state) => {
      const busy = { ...state.busy };
      delete busy[job.jobId];
      return { ...state, busy, action: state.action === `${action}:${job.jobId}` ? null : state.action };
    });
  }
}

export async function removeHistory(jobIds: string[]): Promise<boolean> {
  const state = get(jobsState);
  const ids = [...new Set(jobIds)].filter((id) => state.jobs.some((job) => job.jobId === id && canRemoveHistory(job)) && !state.busy[id] && !state.pending[id]);
  if (!ids.length) return false;
  jobsState.update((state) => ({ ...state, busy: { ...state.busy, ...Object.fromEntries(ids.map((id) => [id, "remove"])) }, error: null, notice: null }));
  try {
    const response = await removeJobHistory({ jobIds: ids });
    ++loadSequence;
    const removed = new Set(response.removedIds);
    jobsState.update((state) => ({ ...state, jobs: state.jobs.filter((job) => !removed.has(job.jobId)), loading: false, refreshing: false,
      notice: response.removedIds.length ? `기록 ${response.removedIds.length}개를 삭제했습니다. 저장된 영상과 자막 파일은 그대로 있습니다.` : null,
      error: response.skippedIds.length ? "실행 중이거나 정리 중인 작업은 남겨 두었습니다. 잠시 후 다시 시도해 주세요." : null,
    }));
    await loadJobs(true);
    return response.removedIds.length > 0;
  } catch (error) {
    jobsState.update((state) => ({ ...state, error: error instanceof Error ? error.message : "다운로드 기록을 삭제하지 못했습니다." }));
    return false;
  } finally {
    jobsState.update((state) => {
      const busy = { ...state.busy };
      for (const id of ids) delete busy[id];
      return { ...state, busy };
    });
  }
}

export function startJobsPolling(intervalMs = 3000): () => void {
  let stopped = false;
  let timer: number;
  const poll = async () => {
    if (stopped) return;
    if (!document.hidden) await loadJobs(true);
    if (!stopped) timer = window.setTimeout(poll, Object.keys(get(jobsState).pending).length ? 500 : intervalMs);
  };
  const focus = () => { if (!document.hidden) void loadJobs(true); };
  timer = window.setTimeout(poll, 500);
  window.addEventListener("focus", focus);
  document.addEventListener("visibilitychange", focus);
  return () => { stopped = true; window.clearTimeout(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus); };
}
