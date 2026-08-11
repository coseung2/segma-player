import { canonicalHttpUrl, MEDIA_TYPES, mediaTypeForResource } from "./candidate.js";

export const DOWNLOAD_MENU_ID = "personal-vpn-download-media";

export function downloadableMediaUrl(resourceUrl) {
  const canonical = canonicalHttpUrl(resourceUrl);
  if (!canonical || mediaTypeForResource(canonical.href) !== MEDIA_TYPES.PROGRESSIVE) return null;
  return canonical.href;
}

export function filenameForDownload(resourceUrl) {
  const url = canonicalHttpUrl(resourceUrl);
  const rawName = url ? decodeURIComponent(url.pathname.split("/").pop() || "") : "";
  const name = rawName.replace(/[<>:\"/\\|?*\u0000-\u001f]/g, "_").trim();
  if (!name || name === "." || name === "..") return "aura-media.mp4";
  return name.slice(-180);
}
