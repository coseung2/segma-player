import { PROVIDER_IDS } from "./ids.js";

function mediaUrl(value) {
  try {
    const url = new URL(value);
    return (url.hostname === "googlevideo.com" || url.hostname.endsWith(".googlevideo.com")) && url.pathname === "/videoplayback" ? url : null;
  } catch { return null; }
}

// SABR/UMP URLs are streaming sessions, not standalone progressive files.
// Never rewrite their signed parameters into a guessed direct-download URL.
export function isGoogleVideoAdaptiveResource(value, contentType = "") {
  const url = mediaUrl(value);
  return Boolean(url && (url.searchParams.get("sabr") === "1" || url.searchParams.get("ump") === "1" || contentType.toLowerCase().includes("application/vnd.yt-ump")));
}

export function googleVideoIdentity(value) {
  const url = mediaUrl(value);
  if (!url) return "";
  return JSON.stringify([url.searchParams.get("id") || "", url.searchParams.get("itag") || "", url.searchParams.get("mime") || ""]);
}

export const googleVideoProvider = Object.freeze({
  id: PROVIDER_IDS.GOOGLEVIDEO,
  matches(candidate = {}, effectiveResourceUrl = "") { return Boolean(mediaUrl(effectiveResourceUrl || candidate.resourceUrl)); },
  policy() { return Object.freeze({ preserveSourceFrame: false, preferSourceFrameProgressive: false, decodeHlsKeyInSourceFrame: false }); },
});
