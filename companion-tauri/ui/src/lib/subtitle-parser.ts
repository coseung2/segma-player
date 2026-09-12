export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

const MAX_CUES = 5_000;
const MAX_CUE_TEXT = 4_000;

function parseTimestamp(value: string): number | null {
  const trimmed = value.trim().replace(",", ".");
  const parts = trimmed.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const secondsPart = Number(parts[parts.length - 1]);
  const minutes = Number(parts[parts.length - 2]);
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (![secondsPart, minutes, hours].every(Number.isFinite) || secondsPart < 0 || secondsPart >= 60 || minutes < 0 || minutes >= 60 || hours < 0) return null;
  const result = hours * 3600 + minutes * 60 + secondsPart;
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function cleanCueText(lines: string[]): string {
  return lines
    .map((line) => line.replace(/<[^>]*>/g, "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_CUE_TEXT)
    .trim();
}

function timingLineIndex(lines: string[], index: number): number {
  if (lines[index]?.includes("-->")) return index;
  return lines[index + 1]?.includes("-->") ? index + 1 : -1;
}

export function parseSubtitle(text: string, format: string): SubtitleCue[] {
  if (typeof text !== "string" || !text || !["vtt", "srt"].includes(format.toLowerCase())) return [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const cues: SubtitleCue[] = [];
  let index = 0;

  while (index < lines.length && cues.length < MAX_CUES) {
    const line = lines[index].trim();
    if (!line) {
      index += 1;
      continue;
    }
    if (/^(?:WEBVTT|NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))/i.test(line)) {
      index += 1;
      while (index < lines.length && lines[index].trim()) index += 1;
      continue;
    }

    const timingIndex = timingLineIndex(lines, index);
    if (timingIndex < 0) {
      index += 1;
      continue;
    }
    const timing = lines[timingIndex].split("-->");
    const start = parseTimestamp(timing[0]);
    const end = parseTimestamp(timing[1]?.trim().split(/\s+/)[0] ?? "");
    index = timingIndex + 1;
    const body: string[] = [];
    while (index < lines.length && lines[index].trim()) {
      body.push(lines[index]);
      index += 1;
    }
    const cueText = cleanCueText(body);
    if (start !== null && end !== null && end > start && cueText) cues.push({ start, end, text: cueText });
  }

  return cues.sort((left, right) => left.start - right.start || left.end - right.end);
}

export function cueAt(cues: SubtitleCue[], time: number): SubtitleCue | null {
  if (!Number.isFinite(time) || time < 0) return null;
  return cues.find((cue) => time >= cue.start && time < cue.end) ?? null;
}

export function subtitleFormat(fileName: string, format = ""): "vtt" | "srt" | "ass" | "unknown" {
  const normalized = (format || fileName.split(".").pop() || "").toLowerCase();
  if (normalized === "vtt" || normalized === "srt" || normalized === "ass") return normalized;
  return "unknown";
}
