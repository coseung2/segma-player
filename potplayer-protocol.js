export const AURA_PLAYER_SCHEME = "aura-player:";
export const COMPANION_SITE = "https://aura.mdownloader.workers.dev";
export const COMPANION_INSTALLER_PATH = "/downloads/AuraPotPlayerSetup.exe";
export const COMPANION_PROBE_PATH = "/api/potplayer-probe";
export const COMPANION_PROBE_STATUS_PATH = "/api/potplayer-probe/status";

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

export function buildAuraPlayerUri(mediaUrl, title = "", options = {}) {
  const playable = playableMediaUrl(mediaUrl);
  if (!playable) throw new TypeError("PotPlayer requires an http(s) media URL");
  const params = new URLSearchParams({ url: playable });
  const normalizedTitle = typeof title === "string" ? title.trim() : "";
  if (normalizedTitle) params.set("title", normalizedTitle.slice(0, 240));
  const probeToken = options?.probe;
  if (typeof probeToken === "string" && /^[a-f0-9]{32,64}$/.test(probeToken)) {
    params.set("probe", probeToken);
  }
  return `${AURA_PLAYER_SCHEME}//play?${params.toString()}`;
}

export function buildAuraProbeUri(token) {
  if (typeof token !== "string" || !/^[a-f0-9]{32,64}$/.test(token)) {
    throw new TypeError("PotPlayer probe requires a 32-64 hex token");
  }
  return `${AURA_PLAYER_SCHEME}//probe?token=${encodeURIComponent(token)}`;
}

export function companionInstallerUrl() {
  return `${COMPANION_SITE}${COMPANION_INSTALLER_PATH}`;
}

export function companionProbeStatusUrl(token) {
  if (typeof token !== "string" || !/^[a-f0-9]{32,64}$/.test(token)) {
    throw new TypeError("PotPlayer probe status requires a 32-64 hex token");
  }
  return `${COMPANION_SITE}${COMPANION_PROBE_STATUS_PATH}?token=${encodeURIComponent(token)}`;
}
