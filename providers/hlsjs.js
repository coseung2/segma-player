import { PROVIDER_IDS } from "./ids.js";
import { providerSignals } from "./signals.js";

export const hlsjsProvider = Object.freeze({
  id: PROVIDER_IDS.HLSJS,
  matches(candidate = {}) {
    return providerSignals(candidate).some((value) => value === "hls.js" || value === "hlsjs");
  },
  policy() {
    return Object.freeze({
      preserveSourceFrame: false,
      preferSourceFrameProgressive: false,
      decodeHlsKeyInSourceFrame: false,
    });
  },
});
