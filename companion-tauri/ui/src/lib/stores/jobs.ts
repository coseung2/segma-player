import { writable } from "svelte/store";
import {
  cancelJob, listJobs, pauseJob, resumeJob, retryJob, resolveJobOutput, revealJobOutput, listLibrary,
  type JobActionCode, type JobDto, type LibraryEntryDto,
} from "../api";
import { selectMedia } from "./player";

export interface JobsState {
  jobs: JobDto[];
  loading: boolean;
  refreshing: boolean;
  action: string | null;
  error: string | null;
  notice: string | null;
  lastUpdated: number | null;
}

const initial: JobsState = {
  jobs: [], loading: false, refreshing: false, action: null,
  error: null, notice: null, lastUpdated: null,
};

export const jobsState = writable<JobsState>(initial);

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
  jobsState.update((state) => ({ ...state, loading: !silent && state.lastUpdated === null, refreshing: silent, error: null }));
  try {
    const response = await listJobs();
    jobsState.update((state) => ({ ...state, jobs: response.jobs, loading: false, refreshing: false, lastUpdated: Date.now() }));
  } catch (error) {
    jobsState.update((state) => ({ ...state, loading: false, refreshing: false, error: error instanceof Error ? error.message : "다운로드 목록을 불러오지 못했습니다." }));
  }
}

export async function runJobAction(job: JobDto, action: QueueAction, onOpenPlayer?: () => void): Promise<void> {
  if (!job.actions.includes(action)) return;
  if (!isQueueActionSupported(action)) {
    jobsState.update((state) => ({ ...state, error: null, notice: queueActionReason(action) }));
    return;
  }
  jobsState.update((state) => ({ ...state, action: `${action}:${job.jobId}`, error: null, notice: null }));
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
    jobsState.update((state) => ({ ...state, action: null, notice: "작업을 요청했습니다." }));
    if (["cancel", "pause", "resume", "retry"].includes(action)) await loadJobs(true);
  } catch (error) {
    jobsState.update((state) => ({ ...state, action: null, error: error instanceof Error ? error.message : "작업을 처리하지 못했습니다." }));
  }
}

export function startJobsPolling(intervalMs = 5000): () => void {
  const timer = window.setInterval(() => { void loadJobs(true); }, intervalMs);
  return () => window.clearInterval(timer);
}
