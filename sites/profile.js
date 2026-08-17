export function defineSiteProfile({ id, hosts, primaryMode, fallbackModes = [], modules }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(id || ""))) throw new TypeError("invalid site id");
  const normalizedHosts = [...new Set((Array.isArray(hosts) ? hosts : [])
    .map((host) => String(host || "").toLowerCase())
    .filter(Boolean))];
  if (!normalizedHosts.length) throw new TypeError(`site ${id} requires at least one host`);
  return Object.freeze({
    id,
    hosts: Object.freeze(normalizedHosts),
    primaryMode,
    fallbackModes: Object.freeze([...fallbackModes]),
    modules: Object.freeze({
      primaryDownloader: modules?.primaryDownloader || "unknown",
      fallbackDownloaders: Object.freeze([...(modules?.fallbackDownloaders || [])]),
      providers: Object.freeze([...(modules?.providers || [])]),
    }),
  });
}
