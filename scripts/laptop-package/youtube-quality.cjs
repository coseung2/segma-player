"use strict";

const STANDARD_QUALITY_TIERS = Object.freeze([4320, 2160, 1440, 1080, 720, 480, 360, 240, 144]);

function qualityFormat() {
  return "bv*+ba/b";
}

function qualitySort(quality) {
  if (quality === "best") return null;
  const value = Number(quality);
  return Number.isFinite(value) && value > 0 ? `res:${value}` : null;
}

function isUsableVideoFormat(format) {
  const videoCodec = String(format?.vcodec || "").toLowerCase();
  if (!videoCodec || videoCodec === "none") return false;
  const searchable = [format?.ext, format?.protocol, format?.format, format?.format_note, format?.format_id]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
  return !searchable.includes("storyboard") && !searchable.includes("mhtml");
}

function labeledTier(format) {
  const match = /(?:^|\D)(\d{3,4})p(?:\d+)?(?:\D|$)/i.exec(String(format?.format_note || ""));
  return match ? Number(match[1]) : null;
}

function dimensionTier(format) {
  const dimensions = [Number(format?.width), Number(format?.height)]
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!dimensions.length) return null;
  const resolution = Math.min(...dimensions);
  return STANDARD_QUALITY_TIERS.reduce((closest, tier) => (
    Math.abs(tier - resolution) < Math.abs(closest - resolution) ? tier : closest
  ), STANDARD_QUALITY_TIERS[0]);
}

function qualityTiersFromFormats(formats) {
  const tiers = new Set();
  for (const format of Array.isArray(formats) ? formats : []) {
    if (!isUsableVideoFormat(format)) continue;
    const tier = labeledTier(format) || dimensionTier(format);
    if (tier) tiers.add(tier);
  }
  const sorted = [...tiers].sort((a, b) => b - a);
  const max = sorted[0] || 0;
  return sorted.filter((tier) => tier >= 360 || tier === max);
}

function qualityAllowedForPlan(quality, isPro, freeMaxHeight = 1080) {
  if (isPro) return true;
  if (quality === "best") return false;
  const height = Number(quality);
  return Number.isFinite(height) && height > 0 && height <= freeMaxHeight;
}

module.exports = {
  qualityAllowedForPlan,
  qualityFormat,
  qualitySort,
  qualityTiersFromFormats,
};
