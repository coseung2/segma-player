import { PROVIDER_IDS } from "./ids.js";
import { providerSignals } from "./signals.js";

export const playerApiProvider = Object.freeze({
  id: PROVIDER_IDS.PLAYER_API,
  matches(candidate = {}) {
    const signals = providerSignals(candidate);
    return signals.some((value) => value === "api-json" || value === "main-fetch" || value === "main-xhr");
  },
  policy() {
    return Object.freeze({
      preserveSourceFrame: true,
      preferSourceFrameProgressive: false,
      decodeHlsKeyInSourceFrame: false,
    });
  },
});
