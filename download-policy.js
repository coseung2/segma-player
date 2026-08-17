import { downloaderIdForMediaType } from "./downloaders/ids.js";
import { PROVIDER_IDS } from "./providers/ids.js";
import { providerForCandidate } from "./providers/registry.js";
import { siteProfileForCandidate } from "./sites/registry.js";

const EMPTY_LIST = Object.freeze([]);
const DEFAULT_PROVIDER_POLICY = Object.freeze({
  preserveSourceFrame: false,
  preferSourceFrameProgressive: false,
  decodeHlsKeyInSourceFrame: false,
});

export function downloadPolicyForCandidate(candidate = {}, effectiveResourceUrl = "") {
  const site = siteProfileForCandidate(candidate, effectiveResourceUrl);
  const provider = providerForCandidate(
    candidate,
    effectiveResourceUrl,
    site?.modules?.providers || EMPTY_LIST,
  );
  const providerPolicy = provider?.policy(candidate, effectiveResourceUrl) || DEFAULT_PROVIDER_POLICY;
  const downloaderId = downloaderIdForMediaType(candidate?.mediaType, candidate?.downloadMode);
  const fallbackDownloaders = site?.modules?.fallbackDownloaders || EMPTY_LIST;
  return Object.freeze({
    siteId: site?.id || "generic",
    providerId: provider?.id || PROVIDER_IDS.GENERIC,
    adapterId: provider?.id || PROVIDER_IDS.GENERIC,
    downloaderId,
    sitePrimaryMode: site?.primaryMode || "",
    siteFallbackModes: site?.fallbackModes || EMPTY_LIST,
    siteDownloaderOrder: site
      ? Object.freeze([site.modules.primaryDownloader, ...fallbackDownloaders])
      : Object.freeze([downloaderId]),
    ...DEFAULT_PROVIDER_POLICY,
    ...providerPolicy,
  });
}
