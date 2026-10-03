import type { JobDto } from "./api";

export type QueueFilter = "all" | "active" | "paused" | "complete" | "failed" | "cancelled";
export type PendingJobAction = { action: "cancel" | "pause" | "resume" | "retry"; requestedAt: number; previousUpdatedAt: number };

export function canRemoveHistory(job: JobDto): boolean {
  return (job.jobType === "media" || job.jobType === "subtitle") && !job.active && !job.paused
    && ["completed", "failed", "cancelled"].includes(job.status);
}

export function matchesQueueFilter(job: JobDto, filter: QueueFilter): boolean {
  if (job.jobType !== "media") return false;
  return filter === "all"
    || (filter === "active" && job.active)
    || (filter === "paused" && job.paused)
    || (filter === "complete" && job.status === "completed")
    || (filter === "failed" && job.status === "failed")
    || (filter === "cancelled" && job.status === "cancelled");
}

export function actionHasSettled(job: JobDto, pending: PendingJobAction): boolean {
  if (pending.action === "cancel") return !job.active && !job.paused;
  if (pending.action === "pause") return job.paused || !job.active;
  return job.updatedAt > pending.previousUpdatedAt;
}

export function pendingActionLabel(action: string): string {
  return ({ cancel: "취소 중…", pause: "일시정지 중…", resume: "재개 중…", retry: "다시 시작 중…", remove: "기록 삭제 중…" } as Record<string, string>)[action] ?? "처리 중…";
}

/** Quality tag shown in the one-line job row, e.g. "1080p" from "[1080p] Title.mp4". */
export function jobQuality(job: Pick<JobDto, "fileName" | "title" | "inputKind">): string {
  for (const value of [job.fileName, job.title]) {
    const match = /(?:^|[\[\s(_-])(\d{3,4})p(?:\d{2})?(?=[\]\s)_.-]|$)/i.exec(value ?? "");
    if (match) return `${match[1]}p`;
  }
  const kind = (job.inputKind ?? "").toUpperCase();
  if (kind.startsWith("HLS")) return "HLS";
  if (kind === "DASH") return "DASH";
  return "";
}

/** The single-line display title: the saved file name without extension and ID tag when present. */
export function jobRowTitle(job: Pick<JobDto, "fileName" | "title">): string {
  const source = job.fileName || job.title;
  return source
    .replace(/\.(mp4|mkv|webm|m4a|mp3)$/i, "")
    .replace(/\s*\[[0-9a-f]{8}-[0-9a-f]{3}\]$/i, "")
    .replace(/^\[\d{3,4}p\]\s*/i, "")
    .trim() || job.title;
}
