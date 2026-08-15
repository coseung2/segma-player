import { localizeStatusText, translator } from "./i18n.js";

const STATUS_KEYS = Object.freeze({
  queued: "status.queued",
  running: "status.running",
  paused: "status.paused",
  completed: "status.completed",
  failed: "status.failed",
  cancelled: "status.cancelled",
});
const KOREAN_LABELS = Object.freeze({
  queued: "대기",
  running: "진행 중",
  paused: "일시정지",
  completed: "완료",
  failed: "실패",
  cancelled: "취소됨",
});
const koreanTranslator = translator("ko");

function boundedPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function segmentProgress(message) {
  const match = /저장 중…\s+(\d+)\s*\/\s*(\d+)/.exec(message);
  if (!match) return null;
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null;
  return { current, total, percent: boundedPercent((current / total) * 100) };
}

function percentProgress(message) {
  const match = /(?:저장 중|서버 처리 중|내 기기로 전송 중|수신 중)…\s+(\d{1,3})%/.exec(message);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? boundedPercent(value) : null;
}

function stageKeyFor(status, message) {
  if (status === "queued") return "stage.queue";
  if (status === "paused") return "stage.paused";
  if (status === "completed") return "stage.saved";
  if (status === "failed") return "stage.stopped";
  if (status === "cancelled") return "stage.cancelled";
  if (/영상 정보|구간\s+\d+개/.test(message)) return "stage.inspecting";
  if (/저장 중…\s+\d+\s*\//.test(message)) return "stage.saving";
  if (/저장 중|영상을 저장/.test(message)) return "stage.writing";
  if (/서버 처리/.test(message)) return "stage.server";
  if (/내 기기로 전송/.test(message)) return "stage.transfer";
  if (/확인|준비|경로|주소/.test(message)) return "stage.preparing";
  return "stage.working";
}

export function downloadJobView(job = {}, translate = koreanTranslator) {
  const t = typeof translate === "function" ? translate : koreanTranslator;
  const status = STATUS_KEYS[job.status] ? job.status : "queued";
  const rawMessage = String(status === "failed" ? (job.error || job.statusText || t("status.defaultFailure"))
    : (job.statusText || KOREAN_LABELS[status]));
  const message = localizeStatusText(t, rawMessage);
  // Progress is always parsed from the canonical Korean pipeline text so the
  // numbers stay identical in every locale.
  const segments = status === "running" ? segmentProgress(rawMessage) : null;
  let progress = { mode: "indeterminate", value: null };
  if (status === "completed") progress = { mode: "determinate", value: 100 };
  else if (status === "failed" || status === "cancelled") progress = { mode: "failed", value: null };
  else if (segments) progress = { mode: "determinate", value: segments.percent };
  else if (status === "running") {
    const percent = percentProgress(rawMessage);
    if (percent !== null) progress = { mode: "determinate", value: percent };
  }
  else if (status === "queued") progress = { mode: "queued", value: null };

  const source = job.source === "youtube" ? t("media.youtube") : t("media.fallbackTitle");
  const mediaType = typeof job.mediaType === "string" && job.mediaType ? job.mediaType : "UNKNOWN";
  const folderName = typeof job.folderName === "string" ? job.folderName : "";
  return Object.freeze({
    id: typeof job.id === "string" ? job.id : "",
    title: typeof job.title === "string" && job.title ? job.title : t("job.fallbackTitle"),
    status,
    statusLabel: t(STATUS_KEYS[status]),
    stage: t(stageKeyFor(status, rawMessage)),
    message,
    progress,
    segments,
    meta: [source, mediaType, folderName].filter(Boolean).join(" · "),
  });
}

export function retryableDownloadJob(job) {
  return (job?.status === "failed" || job?.status === "cancelled") && job.retryable === true;
}
