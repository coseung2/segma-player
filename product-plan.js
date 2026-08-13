export const GIBIBYTE = 1024 ** 3;

const PLANS = Object.freeze({
  free: Object.freeze({
    id: "free",
    label: "일반",
    maxConcurrentMediaJobs: 1,
    maxDownloadBytes: 1 * GIBIBYTE,
    youtubeEnabled: true,
    youtubeMaxHeight: 1080,
    backgroundDownloads: false,
    downloadSpeedLimitBytesPerSecond: 4 * 1024 * 1024,
  }),
  pro: Object.freeze({
    id: "pro",
    label: "Pro",
    maxConcurrentMediaJobs: null,
    maxDownloadBytes: null,
    youtubeEnabled: true,
    youtubeMaxHeight: null,
    backgroundDownloads: true,
    downloadSpeedLimitBytesPerSecond: null,
  }),
});

export const PRO_BENEFITS = Object.freeze([
  "미디어 동시 다운로드 제한 없음",
  "파일 크기 제한 없음",
  "지원 미디어의 최고 화질 선택",
]);

export function productPlan(edition = "free") {
  return PLANS[edition] || PLANS.free;
}

export function youtubeQualityAllowed(plan, quality) {
  if (!plan?.youtubeEnabled) return false;
  if (plan?.youtubeMaxHeight === null) return true;
  if (quality === "best") return false;
  const height = Number(quality);
  return Number.isFinite(height) && height <= plan.youtubeMaxHeight;
}
