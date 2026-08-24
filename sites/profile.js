/// Site profiles select modes and modules, and may declare where the page keeps
/// its real media title. They must not implement transport, token, key, or
/// file-writing logic.
///
/// `titleSelectors` exists because some pages put a short board code in
/// `<title>` and the real media title in the body, and because a player iframe
/// has its own unrelated `<title>`. Selectors are read-only DOM hints, so this
/// stays inside the site-profile boundary.
export function defineSiteProfile({
  id,
  hosts,
  primaryMode,
  fallbackModes = [],
  modules,
  titleSelectors = [],
  playerFramePaths = [],
}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(id || ""))) throw new TypeError("invalid site id");
  const normalizedHosts = [...new Set((Array.isArray(hosts) ? hosts : [])
    .map((host) => String(host || "").toLowerCase())
    .filter(Boolean))];
  if (!normalizedHosts.length) throw new TypeError(`site ${id} requires at least one host`);
  const normalizedTitleSelectors = Object.freeze([...new Set((Array.isArray(titleSelectors) ? titleSelectors : [])
    .map((selector) => String(selector || "").trim())
    .filter((selector) => selector.length > 0 && selector.length <= 200))]);
  const normalizedPlayerFramePaths = Object.freeze([...new Set((Array.isArray(playerFramePaths) ? playerFramePaths : [])
    .map((path) => String(path || "").trim().toLowerCase())
    .filter((path) => path.startsWith("/") && path.length <= 200))]);
  return Object.freeze({
    id,
    hosts: Object.freeze(normalizedHosts),
    primaryMode,
    fallbackModes: Object.freeze([...fallbackModes]),
    titleSelectors: normalizedTitleSelectors,
    playerFramePaths: normalizedPlayerFramePaths,
    modules: Object.freeze({
      primaryDownloader: modules?.primaryDownloader || "unknown",
      fallbackDownloaders: Object.freeze([...(modules?.fallbackDownloaders || [])]),
      providers: Object.freeze([...(modules?.providers || [])]),
    }),
  });
}
