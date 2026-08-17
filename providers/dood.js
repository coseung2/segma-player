import { PROVIDER_IDS } from "./ids.js";
import { hostOf, providerSignals } from "./signals.js";

const DOOD_HOST_RE = /(?:^|\.)(?:dood(?:stream|cdn)?|d000d|doimg|playmogo|cloudatacdn)\./i;

function matchesHost(value) {
  const host = hostOf(value);
  return Boolean(host && DOOD_HOST_RE.test(host));
}

export const doodProvider = Object.freeze({
  id: PROVIDER_IDS.DOOD,
  matches(candidate = {}, effectiveResourceUrl = "") {
    if (providerSignals(candidate).some((value) => value.includes("dood"))) return true;
    return [effectiveResourceUrl, candidate?.resourceUrl, candidate?.pageUrl]
      .some(matchesHost);
  },
  policy() {
    return Object.freeze({
      preserveSourceFrame: true,
      preferSourceFrameProgressive: true,
      decodeHlsKeyInSourceFrame: false,
    });
  },
});
