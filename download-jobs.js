const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function safeText(value, fallback = "") {
  return typeof value === "string" ? value.slice(0, 500) : fallback;
}

export function createDownloadJob({
  id,
  title,
  mediaType,
  candidateId = "",
  folderName = "",
  source = "media",
  retryPayload = null,
  now = Date.now(),
}) {
  if (typeof id !== "string" || !id) throw new Error("invalid-download-job-id");
  return Object.freeze({
    id,
    title: safeText(title, "미디어 다운로드"),
    mediaType: safeText(mediaType, "UNKNOWN"),
    candidateId: safeText(candidateId),
    source: source === "youtube" ? "youtube" : "media",
    status: "queued",
    statusText: "다운로드 대기 중…",
    error: "",
    errorCode: "",
    folderName: safeText(folderName),
    retryPayload: retryPayload && typeof retryPayload === "object" ? retryPayload : null,
    createdAt: now,
    updatedAt: now,
  });
}

export function updateDownloadJob(job, patch, now = Date.now()) {
  if (!job || typeof job.id !== "string") throw new Error("invalid-download-job");
  if (TERMINAL_STATUSES.has(job.status)) return job;
  const status = ["queued", "running", "paused", "completed", "failed", "cancelled"].includes(patch?.status)
    ? patch.status
    : job.status;
  return Object.freeze({
    ...job,
    title: safeText(patch?.title, job.title),
    status,
    statusText: safeText(patch?.statusText, job.statusText),
    error: safeText(patch?.error, job.error),
    errorCode: safeText(patch?.errorCode, job.errorCode),
    folderName: safeText(patch?.folderName, job.folderName),
    retryPayload: status === "completed" ? null : job.retryPayload,
    updatedAt: now,
  });
}

export function publicDownloadJobs(jobs, limit = 30) {
  return [...jobs]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, limit)
    .map(({ id, title, mediaType, candidateId, status, statusText, error, errorCode, folderName, createdAt, updatedAt, source, retryPayload }) => ({
      id, title, mediaType, candidateId, status, statusText, error, errorCode, folderName, createdAt, updatedAt, source,
      retryable: (status === "failed" || status === "cancelled") && Boolean(retryPayload),
    }));
}

export function persistedDownloadJobs(jobs, limit = 30) {
  return [...jobs]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, limit)
    .map(({ retryPayload: _retryPayload, ...job }) => job);
}

export function retryPayloadForJob(job) {
  return (job?.status === "failed" || job?.status === "cancelled")
    && job.retryPayload && typeof job.retryPayload === "object"
    ? job.retryPayload
    : null;
}

export function terminalDownloadJob(job) {
  return TERMINAL_STATUSES.has(job?.status);
}
