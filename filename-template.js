export const DEFAULT_FILENAME_TEMPLATE = "{title}.{ext}";
export const FILENAME_TEMPLATE_STORAGE_KEY = "auraFilenameTemplate";
export const MAX_FILENAME_LENGTH = 180;
export const MAX_FILENAME_TEMPLATE_LENGTH = 512;

export const FILENAME_TEMPLATE_TOKENS = Object.freeze([
  "title",
  "filename",
  "ext",
  "host",
  "date",
  "time",
  "year",
  "month",
  "day",
  "sequence",
]);

const TOKEN_NAMES = new Set(FILENAME_TEMPLATE_TOKENS);
const TOKEN_PATTERN = /\{([^{}]*)\}/g;
const WINDOWS_INVALID_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const WINDOWS_TRAILING_CHARACTERS = /[. ]+$/g;
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const FALLBACK_FILENAME = "aura-media";

function textValue(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function clip(value, limit) {
  return Array.from(value).slice(0, limit).join("");
}

function cleanFilename(value) {
  let result = textValue(value)
    .replace(WINDOWS_INVALID_CHARACTERS, "_")
    .trim()
    .replace(WINDOWS_TRAILING_CHARACTERS, "");
  if (!result || result === "." || result === "..") return "";
  result = clip(result, MAX_FILENAME_LENGTH).replace(WINDOWS_TRAILING_CHARACTERS, "");
  if (!result || result === "." || result === "..") return "";
  if (WINDOWS_RESERVED_BASENAME.test(result)) result = `_${result}`;
  return clip(result, MAX_FILENAME_LENGTH).replace(WINDOWS_TRAILING_CHARACTERS, "") || "";
}

export function sanitizeFilename(value, fallback = FALLBACK_FILENAME) {
  return cleanFilename(value) || cleanFilename(fallback) || FALLBACK_FILENAME;
}

export function normalizeFilenameTemplate(template) {
  if (typeof template !== "string") return DEFAULT_FILENAME_TEMPLATE;
  const normalized = clip(template, MAX_FILENAME_TEMPLATE_LENGTH).trim();
  return normalized || DEFAULT_FILENAME_TEMPLATE;
}

function extensionFromFilename(filename) {
  const value = textValue(filename);
  const separator = value.lastIndexOf(".");
  if (separator <= 0 || separator === value.length - 1) return "";
  return value.slice(separator + 1);
}

function dateValues(now) {
  const candidate = now instanceof Date ? now : new Date(now);
  const date = Number.isNaN(candidate.getTime()) ? new Date() : candidate;
  const iso = date.toISOString();
  const year = iso.slice(0, 4);
  const month = iso.slice(5, 7);
  const day = iso.slice(8, 10);
  const time = iso.slice(11, 19).replaceAll(":", "-");
  return { date: `${year}-${month}-${day}`, time, year, month, day };
}

function hostFromContext(context) {
  const supplied = textValue(context.host).trim();
  if (supplied) return supplied;
  const url = textValue(context.url);
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function sequenceValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.max(0, Math.trunc(value)));
  }
  return textValue(value).trim() || "1";
}

export function formatFilenameTemplate(template = DEFAULT_FILENAME_TEMPLATE, context = {}) {
  const values = context && typeof context === "object" ? context : {};
  const filename = textValue(values.filename);
  const extension = textValue(values.ext || values.extension).replace(/^\.+/, "")
    || extensionFromFilename(filename);
  const generated = dateValues(values.now);
  const date = textValue(values.date).trim() || generated.date;
  const time = textValue(values.time).trim() || generated.time;
  const tokenValues = {
    title: textValue(values.title || values.pageTitle).trim() || filename || FALLBACK_FILENAME,
    filename,
    ext: extension,
    host: hostFromContext(values),
    date,
    time,
    year: generated.year,
    month: generated.month,
    day: generated.day,
    sequence: sequenceValue(values.sequence),
  };
  const rendered = normalizeFilenameTemplate(template).replace(TOKEN_PATTERN, (_match, name) => {
    const token = String(name).trim().toLowerCase();
    return TOKEN_NAMES.has(token) ? tokenValues[token] : "";
  });
  return sanitizeFilename(rendered);
}
