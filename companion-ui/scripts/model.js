// Pure view-model layer for the Aura Media Companion UI.
//
// Every function maps the native host's real payloads onto the design system's
// vocabulary. No DOM access, so this module is testable with `node --test`.
//
// Job payloads come from the `list-jobs` reply, which serializes the native
// `JobState` struct. Field names below match that struct's serde renames.

export const DOWNLOAD_STATUSES = Object.freeze([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const SUBTITLE_STATUSES = Object.freeze([
  "created",
  "preparing",
  "submitting",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const PREPARING_STATUSES = new Set(["created", "preparing", "submitting"]);

export function jobKind(job) {
  return job?.jobType === "subtitle" ? "subtitle" : "download";
}

// Tones map onto the Figma Status components: neutral -> Status / Downloading,
// success -> Status / Complete, warning -> Status / Paused, danger ->
// Status / Failed. Nothing emits a paused state because the protocol has no
// pause command; `cancelled` is the only warning-tone status.
export function statusView(job) {
  const status = typeof job?.status === "string" ? job.status.toLowerCase() : "";
  const isSubtitle = jobKind(job) === "subtitle";
  if (status === "completed") return { label: "Complete", tone: "success" };
  if (status === "failed") return { label: "Failed", tone: "danger" };
  if (status === "cancelled") return { label: "Cancelled", tone: "warning" };
  if (status === "running") {
    return { label: isSubtitle ? "Generating" : "Downloading", tone: "neutral" };
  }
  if (PREPARING_STATUSES.has(status)) return { label: "Preparing", tone: "neutral" };
  if (status === "queued") return { label: "Queued", tone: "neutral" };
  return { label: "Unknown", tone: "neutral" };
}

export function isActive(job) {
  const status = typeof job?.status === "string" ? job.status.toLowerCase() : "";
  return status !== "" && !TERMINAL_STATUSES.has(status);
}

export function formatBytes(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  if (value < 1000) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value / 1000;
  let unit = 0;
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  // One decimal, with a trailing ".0" dropped, so a round size reads "320 MB"
  // while a partial one keeps the precision the design shows ("100.4 MB").
  const rounded = scaled.toFixed(1).replace(/\.0$/, "");
  return `${rounded} ${units[unit]}`;
}

// Percent complete, or null when the host has not reported enough to know.
// `progress` is a u8 the host already clamps; completed/total is the fallback
// used by subtitle jobs that report byte counts instead.
export function progressPercent(job) {
  if (typeof job?.progress === "number" && Number.isFinite(job.progress)) {
    return Math.min(100, Math.max(0, Math.round(job.progress)));
  }
  const completed = job?.completed;
  const total = job?.total;
  if (typeof completed === "number" && typeof total === "number" && total > 0) {
    return Math.min(100, Math.max(0, Math.round((completed / total) * 100)));
  }
  return null;
}

export function transferLabel(job) {
  const completed = formatBytes(job?.completed);
  const total = formatBytes(job?.total);
  if (completed && total) return `${completed} / ${total}`;
  if (completed) return completed;
  const percent = progressPercent(job);
  return percent === null ? null : `${percent}%`;
}

export function mediaTypeLabel(job) {
  if (jobKind(job) === "subtitle") {
    const format = typeof job?.outputFormat === "string" ? job.outputFormat.trim() : "";
    return format === "" ? "VTT" : format.toUpperCase();
  }
  const inputKind = typeof job?.inputKind === "string" ? job.inputKind.trim() : "";
  if (inputKind !== "") return inputKind.toUpperCase();
  const name = typeof job?.fileName === "string" ? job.fileName : "";
  const extension = name.includes(".") ? name.split(".").pop() : "";
  return extension ? extension.toUpperCase() : "MEDIA";
}

export function jobTitle(job) {
  const title = typeof job?.title === "string" ? job.title.trim() : "";
  if (title !== "") return title;
  const fileName = typeof job?.fileName === "string" ? job.fileName.trim() : "";
  if (fileName !== "") return fileName;
  const id = typeof job?.jobId === "string" ? job.jobId : "";
  return id === "" ? "Untitled job" : `Job ${id}`;
}

export function languagePair(job) {
  const from = typeof job?.sourceLanguage === "string" ? job.sourceLanguage : "";
  const to = typeof job?.targetLanguage === "string" ? job.targetLanguage : "";
  if (from && to && from !== to) return `${from} to ${to}`;
  if (to) return to;
  if (from) return from;
  return null;
}

// The single line under a job title. Prefers the host's own statusText so the
// UI never invents a reason the backend did not report.
export function detailLine(job) {
  const error = typeof job?.error === "string" ? job.error.trim() : "";
  if (error !== "" && statusView(job).tone === "danger") return error;
  const statusText = typeof job?.statusText === "string" ? job.statusText.trim() : "";
  if (statusText !== "") return statusText;
  const phase = typeof job?.phase === "string" ? job.phase.trim() : "";
  if (phase !== "") return phase;
  return null;
}

// Actions the current protocol can actually perform.
//   cancel -> `cancel-job`, valid while the job is not terminal
//   reveal -> `open-folder`, folder level because there is no per-file reveal
// There is deliberately no retry: the host exposes no retry command, and
// re-sending `youtube-download` with a used job id is not a supported path.
export function availableActions(job) {
  if (isActive(job)) return ["cancel"];
  const fileName = typeof job?.fileName === "string" ? job.fileName : "";
  if (statusView(job).tone === "success" && fileName !== "") return ["reveal"];
  return [];
}

export function toJobView(job) {
  const status = statusView(job);
  return {
    id: typeof job?.jobId === "string" ? job.jobId : "",
    kind: jobKind(job),
    title: jobTitle(job),
    statusLabel: status.label,
    statusTone: status.tone,
    detail: detailLine(job),
    typeLabel: mediaTypeLabel(job),
    percent: progressPercent(job),
    transfer: transferLabel(job),
    language: languagePair(job),
    fileName: typeof job?.fileName === "string" ? job.fileName : null,
    active: isActive(job),
    actions: availableActions(job),
    updatedAt: typeof job?.updatedAt === "number" ? job.updatedAt : 0,
  };
}

export function sortJobs(jobs) {
  const list = Array.isArray(jobs) ? [...jobs] : [];
  return list.sort((left, right) => (right?.updatedAt ?? 0) - (left?.updatedAt ?? 0));
}

export function queueJobs(jobs) {
  return sortJobs(jobs).filter((job) => jobKind(job) === "download");
}

export function subtitleJobs(jobs) {
  return sortJobs(jobs).filter((job) => jobKind(job) === "subtitle");
}

// Library entries are completed download jobs that produced a file on disk.
// Subtitle jobs also write files, but a .vtt is not a media item, so they stay
// on the Subtitles view. This is the only library-shaped data the protocol
// exposes: there is no media-scan command and no stored duration or thumbnail.
export function libraryItems(jobs) {
  return sortJobs(jobs)
    .filter((job) => {
      if (jobKind(job) !== "download") return false;
      const status = typeof job?.status === "string" ? job.status.toLowerCase() : "";
      const fileName = typeof job?.fileName === "string" ? job.fileName.trim() : "";
      return status === "completed" && fileName !== "";
    })
    .map((job) => ({
      id: typeof job.jobId === "string" ? job.jobId : "",
      title: jobTitle(job),
      fileName: job.fileName.trim(),
      typeLabel: mediaTypeLabel(job),
      kind: jobKind(job),
      size: formatBytes(job?.total),
      updatedAt: typeof job.updatedAt === "number" ? job.updatedAt : 0,
    }));
}

export function queueSummary(jobs) {
  const downloads = queueJobs(jobs);
  const active = downloads.filter((job) => isActive(job)).length;
  const failed = downloads.filter((job) => statusView(job).tone === "danger").length;
  const parts = [active === 1 ? "1 active" : `${active} active`];
  if (failed > 0) parts.push(failed === 1 ? "1 failed" : `${failed} failed`);
  return parts.join(" · ");
}

export function subtitleSummary(jobs) {
  const list = subtitleJobs(jobs);
  const running = list.filter((job) => isActive(job)).length;
  const ready = list.filter((job) => statusView(job).tone === "success").length;
  return `${running} generating · ${ready} ready`;
}

// Maps the `status` reply onto Settings rows. Every value shown is something
// the host reported; nothing is editable because the protocol has no
// settings-write command.
export function settingsView(status) {
  const ok = status?.ok === true;
  const version = typeof status?.version === "string" ? status.version : null;
  const protocol = typeof status?.protocol === "number" ? status.protocol : null;
  const folder =
    typeof status?.downloadsFolder === "string" && status.downloadsFolder !== ""
      ? status.downloadsFolder
      : null;
  const toolsReady = status?.toolsReady === true;
  const licensed = status?.licenseConfigured === true;

  return {
    connected: ok,
    groups: [
      {
        title: "Folders",
        rows: [
          {
            title: "Downloads folder",
            value: folder ?? "Not reported by the companion",
            mono: Boolean(folder),
            control: folder ? { kind: "button", label: "Open", action: "open-folder" } : null,
          },
        ],
      },
      {
        title: "Companion link",
        rows: [
          {
            title: "Native messaging host",
            value: version ? `aura-media-companion ${version}` : "Not connected",
            mono: Boolean(version),
            control: {
              kind: "status",
              label: ok ? "Ready" : "Offline",
              tone: ok ? "success" : "danger",
            },
          },
          {
            title: "Protocol version",
            value: protocol === null ? "Unknown" : String(protocol),
            mono: protocol !== null,
            control: null,
          },
          {
            title: "Media tools",
            value: toolsReady ? "yt-dlp and ffmpeg installed" : "yt-dlp or ffmpeg missing",
            mono: false,
            control: {
              kind: "status",
              label: toolsReady ? "Ready" : "Missing",
              tone: toolsReady ? "success" : "warning",
            },
          },
        ],
      },
      {
        title: "Entitlement",
        rows: [
          {
            title: "Owner",
            value: typeof status?.entitlementOwner === "string" ? status.entitlementOwner : "Unknown",
            mono: false,
            control: null,
          },
          {
            title: "Subtitle license key",
            value: licensed
              ? "Configured in settings.json"
              : "Not configured, so subtitle jobs will fail",
            mono: false,
            control: {
              kind: "status",
              label: licensed ? "Configured" : "Missing",
              tone: licensed ? "success" : "warning",
            },
          },
        ],
      },
    ],
  };
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

// `youtube-download` is the only link-driven command the host accepts, so the
// Add link field validates against it instead of accepting any URL and failing
// later inside the native layer.
export function validateLinkInput(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "") return { ok: false, reason: "Paste a YouTube address first." };
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "That is not a valid address." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "Only http and https addresses are supported." };
  }
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) {
    return {
      ok: false,
      reason: "The companion accepts YouTube links directly. Use the browser extension for other sites.",
    };
  }
  return { ok: true, url: url.toString() };
}

// The host validates quality against 1080/720/480, so anything else reported by
// `youtube-info` is dropped rather than offered and rejected later.
export function normalizeQualities(qualities) {
  const allowed = ["1080", "720", "480"];
  const fallback = allowed.map((value) => ({ value, label: `Up to ${value}p` }));
  if (!Array.isArray(qualities)) return fallback;
  const seen = new Set();
  const output = [];
  for (const entry of qualities) {
    const raw = entry?.height ?? entry?.value ?? entry;
    const value = String(raw ?? "").replace(/[^0-9]/g, "");
    if (value === "" || seen.has(value) || !allowed.includes(value)) continue;
    seen.add(value);
    output.push({ value, label: `Up to ${value}p` });
  }
  if (output.length === 0) return fallback;
  return output.sort((left, right) => Number(right.value) - Number(left.value));
}

export function newJobId(random = Math.random) {
  const suffix = Math.floor(random() * 1e9).toString(36);
  return `ui-${Date.now().toString(36)}-${suffix}`;
}
