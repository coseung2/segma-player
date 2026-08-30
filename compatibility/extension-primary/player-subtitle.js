// Shared subtitle helpers for the browser-tab player. Pure logic only so the
// popup addon, the player page, and node tests can reuse it without DOM.

export function mediaIdentifier(value) {
  if (!value) return null;
  const match = /(?<![A-Z0-9])([A-Z]{2,10})[-_ ]?(\d{2,6})(?!\d)/i.exec(String(value));
  if (!match) return null;
  return `${match[1].toUpperCase()}-${match[2]}`;
}

export function subtitleNameMatches(name, identifier) {
  if (!name || !identifier) return false;
  const pattern = identifier.replace(/-/g, "[-_ ]?");
  return new RegExp(pattern, "i").test(String(name));
}

export function subtitleTitleKey(value) {
  return String(value || "")
    .replace(/\.srt$/i, "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 180);
}

export function subtitleTitleMatches(name, title) {
  const titleKey = subtitleTitleKey(title);
  if (titleKey.length < 8) return false;
  return subtitleTitleKey(name).includes(titleKey);
}

function isSrtFile(name) {
  return typeof name === "string" && /\.srt$/i.test(name);
}

async function walkForSubtitle(directoryHandle, identifier, title) {
  let best = null;
  const visit = async (handle) => {
    for await (const entry of handle.values()) {
      if (entry.kind === "directory") {
        await visit(entry);
      } else if (entry.kind === "file" && isSrtFile(entry.name)) {
        const file = await entry.getFile();
        if (subtitleNameMatches(entry.name, identifier) || subtitleTitleMatches(entry.name, title)) {
          if (!best || file.lastModified > best.file.lastModified) {
            best = { entry, file, name: entry.name };
          }
        }
      }
    }
  };
  await visit(directoryHandle);
  return best;
}

export async function findSubtitleFile(directoryHandle, title, mediaUrl) {
  if (!directoryHandle || typeof directoryHandle.values !== "function") return null;
  const identifier = mediaIdentifier(title) || mediaIdentifier(mediaUrl);
  if (!identifier && subtitleTitleKey(title).length < 8) return null;
  return walkForSubtitle(directoryHandle, identifier, title);
}

export async function decodeSubtitleBytes(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("euc-kr").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}

function timestampToSeconds(value) {
  const raw = String(value).trim();
  const long = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(raw);
  if (long) {
    const millis = Number(long[4].padEnd(3, "0"));
    return Number(long[1]) * 3600 + Number(long[2]) * 60 + Number(long[3]) + millis / 1000;
  }
  const short = /^(\d{1,3}):(\d{2})[,.](\d{1,3})/.exec(raw);
  if (!short) return null;
  const millis = Number(short[3].padEnd(3, "0"));
  return Number(short[1]) * 60 + Number(short[2]) + millis / 1000;
}

function parseTimedText(text) {
  const cues = [];
  const normalized = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim());
    const timing = lines.findIndex((line) => line.includes("-->"));
    if (timing < 0) continue;
    const [startRaw, endRaw] = lines[timing].split("-->");
    const start = timestampToSeconds(startRaw);
    const end = timestampToSeconds(endRaw);
    if (start === null || end === null || end <= start) continue;
    const payload = lines.slice(timing + 1).filter(Boolean).join("\n");
    if (!payload) continue;
    cues.push({ start, end, text: payload });
  }
  return cues;
}

export function parseSrt(text) {
  return parseTimedText(text);
}

export function parseVtt(text) {
  return parseTimedText(String(text || "").replace(/^\uFEFF?WEBVTT[^\n]*(?:\n|$)/i, ""));
}

export function parseSubtitle(text) {
  return /^\uFEFF?\s*WEBVTT\b/i.test(String(text || "")) ? parseVtt(text) : parseSrt(text);
}

function srtTimestamp(seconds) {
  const milliseconds = Math.max(0, Math.round(Number(seconds) * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainder = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")},${String(remainder).padStart(3, "0")}`;
}

// Generated captions arrive as WEBVTT. The subtitle-folder matcher deliberately
// uses .srt, so convert parsed cues rather than applying brittle text replaces.
export function cuesToSrt(cues) {
  const valid = (Array.isArray(cues) ? cues : []).filter((cue) => (
    Number.isFinite(cue?.start)
    && Number.isFinite(cue?.end)
    && cue.end > cue.start
    && String(cue?.text || "").trim()
  ));
  return valid.map((cue, index) => [
    String(index + 1),
    `${srtTimestamp(cue.start)} --> ${srtTimestamp(cue.end)}`,
    String(cue.text).replace(/\r\n?/g, "\n").trim().replace(/\n/g, "\r\n"),
  ].join("\r\n")).join("\r\n\r\n") + (valid.length ? "\r\n" : "");
}

export function cuesAt(cues, time) {
  return cues.find((cue) => time >= cue.start && time <= cue.end) || null;
}
