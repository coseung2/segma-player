const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const JOB_SOURCES = new Set(["media", "youtube", "companion"]);

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
  diagnostic = null,
  retryPayload = null,
  now = Date.now(),
}) {
  if (typeof id !== "string" || !id) throw new Error("invalid-download-job-id");
  return Object.freeze({
    id,
    title: safeText(title, "미디어 다운로드"),
    mediaType: safeText(mediaType, "UNKNOWN"),
    candidateId: safeText(candidateId),
    source: JOB_SOURCES.has(source) ? source : "media",
    status: "queued",
    statusText: "다운로드 대기 중…",
    error: "",
    errorCode: "",
    folderName: safeText(folderName),
    diagnostic: diagnostic && typeof diagnostic === "object" ? Object.freeze({
      resource: safeText(diagnostic.resource),
      mediaType: safeText(diagnostic.mediaType, "UNKNOWN"),
      downloadMode: safeText(diagnostic.downloadMode, "UNKNOWN"),
      downloaderId: safeText(diagnostic.downloaderId, "unknown"),
      providerId: safeText(diagnostic.providerId, "generic"),
      siteId: safeText(diagnostic.siteId, "generic"),
      frameId: Number.isInteger(diagnostic.frameId) ? diagnostic.frameId : null,
      player: safeText(diagnostic.player),
      sessionId: safeText(diagnostic.sessionId),
      source: safeText(diagnostic.source),
      requestType: safeText(diagnostic.requestType),
      main: Boolean(diagnostic.main),
      score: Number.isFinite(diagnostic.score) ? diagnostic.score : 0,
    }) : null,
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
    .map(({ id, title, mediaType, candidateId, status, statusText, error, errorCode, folderName, diagnostic, createdAt, updatedAt, source, retryPayload }) => ({
      id, title, mediaType, candidateId, status, statusText, error, errorCode, folderName,
      ...(diagnostic ? { diagnostic } : {}),
      createdAt, updatedAt, source,
      retryable: (status === "failed" || status === "cancelled") && Boolean(retryPayload),
    }));
}

export function persistedDownloadJobs(jobs, limit = 30) {
  return [...jobs]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, limit)
    // storage.session is extension-private and survives service-worker restarts.
    // Keep the bounded retry payload here so a failed transfer can reconnect to
    // its existing checkpoint instead of forcing a brand-new download.
    .map((job) => ({ ...job }));
}

export function publicCompanionJobs(jobs, limit = 30) {
  const statusFor = (value) => {
    if (["completed", "failed", "cancelled"].includes(value)) return value;
    if (value === "paused") return "paused";
    if (["created", "preparing", "submitting", "queued"].includes(value)) return "queued";
    return "running";
  };
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => job && typeof job.jobId === "string" && job.jobId)
    .map((job) => {
      const status = statusFor(job.status);
      const createdAt = Number.isFinite(Number(job.createdAt)) ? Number(job.createdAt) : 0;
      const updatedAt = Number.isFinite(Number(job.updatedAt)) ? Number(job.updatedAt) : createdAt;
      return {
        id: safeText(job.jobId),
        title: safeText(job.title, "Segma Player 다운로드"),
        mediaType: safeText(job.inputKind, job.jobType === "youtube" ? "YOUTUBE" : "UNKNOWN"),
        candidateId: safeText(job.candidateId),
        status,
        statusText: safeText(job.statusText, "Segma Player에서 처리 중…"),
        error: safeText(job.error),
        errorCode: safeText(job.errorCode),
        folderName: "",
        createdAt,
        updatedAt,
        source: "companion",
        retryable: status === "failed" || status === "cancelled",
      };
    })
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, limit);
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
