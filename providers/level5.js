import { PROVIDER_IDS } from "./ids.js";
import { providerSignals } from "./signals.js";

export const level5Provider = Object.freeze({
  id: PROVIDER_IDS.LEVEL5,
  matches(candidate = {}) {
    return providerSignals(candidate).some((value) => value === "level5" || value.includes("level5"));
  },
  policy() {
    return Object.freeze({
      preserveSourceFrame: true,
      preferSourceFrameProgressive: false,
      decodeHlsKeyInSourceFrame: true,
    });
  },
});
