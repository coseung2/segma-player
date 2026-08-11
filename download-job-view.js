const STATUS_LABELS = Object.freeze({
  queued: "대기",
  running: "진행 중",
  completed: "완료",
  failed: "실패",
});

function boundedPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function segmentProgress(message) {
  const match = /세그먼트\s+(\d+)\s*\/\s*(\d+)/.exec(message);
  if (!match) return null;
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null;
  return { current, total, percent: boundedPercent((current / total) * 100) };
}

function stageFor(status, message) {
  if (status === "queued") return "대기열";
  if (status === "completed") return "저장 완료";
  if (status === "failed") return "중단됨";
  if (/플레이리스트|세그먼트\s+\d+개/.test(message)) return "목록 분석";
  if (/세그먼트\s+\d+\s*\//.test(message)) return "수신 · 저장";
  if (/저장 중|영상을 저장/.test(message)) return "파일 저장";
  if (/확인|준비|경로|주소/.test(message)) return "다운로드 준비";
  return "처리 중";
}

export function downloadJobView(job = {}) {
  const status = STATUS_LABELS[job.status] ? job.status : "queued";
  const message = String(status === "failed" ? (job.error || job.statusText || "다운로드에 실패했습니다.")
    : (job.statusText || STATUS_LABELS[status]));
  const segments = status === "running" ? segmentProgress(message) : null;
  let progress = { mode: "indeterminate", value: null };
  if (status === "completed") progress = { mode: "determinate", value: 100 };
  else if (status === "failed") progress = { mode: "failed", value: null };
  else if (segments) progress = { mode: "determinate", value: segments.percent };
  else if (status === "queued") progress = { mode: "queued", value: null };

  const source = job.source === "youtube" ? "YouTube" : "미디어";
  const mediaType = typeof job.mediaType === "string" && job.mediaType ? job.mediaType : "UNKNOWN";
  const folderName = typeof job.folderName === "string" ? job.folderName : "";
  return Object.freeze({
    id: typeof job.id === "string" ? job.id : "",
    title: typeof job.title === "string" && job.title ? job.title : "다운로드",
    status,
    statusLabel: STATUS_LABELS[status],
    stage: stageFor(status, message),
    message,
    progress,
    segments,
    meta: [source, mediaType, folderName].filter(Boolean).join(" · "),
  });
}
