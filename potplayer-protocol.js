export const AURA_PLAYER_SCHEME = "aura-player:";

export function playableMediaUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

export function buildAuraPlayerUri(mediaUrl, title = "") {
  const playable = playableMediaUrl(mediaUrl);
  if (!playable) throw new TypeError("PotPlayer requires an http(s) media URL");
  const params = new URLSearchParams({ url: playable });
  const normalizedTitle = typeof title === "string" ? title.trim() : "";
  if (normalizedTitle) params.set("title", normalizedTitle.slice(0, 240));
  return `${AURA_PLAYER_SCHEME}//play?${params.toString()}`;
}
