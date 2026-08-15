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

function isSrtFile(name) {
  return typeof name === "string" && /\.srt$/i.test(name);
}

async function walkForSubtitle(directoryHandle, identifier) {
  let best = null;
  const visit = async (handle) => {
    for await (const entry of handle.values()) {
      if (entry.kind === "directory") {
        await visit(entry);
      } else if (entry.kind === "file" && isSrtFile(entry.name)) {
        const file = await entry.getFile();
        if (subtitleNameMatches(entry.name, identifier)) {
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
  if (!identifier) return null;
  return walkForSubtitle(directoryHandle, identifier);
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
  const match = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(String(value).trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4].padEnd(3, "0"));
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

export function parseSrt(text) {
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

export function cuesAt(cues, time) {
  return cues.find((cue) => time >= cue.start && time <= cue.end) || null;
}
