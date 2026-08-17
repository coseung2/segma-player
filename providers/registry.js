import { doodProvider } from "./dood.js";
import { hlsjsProvider } from "./hlsjs.js";
import { PROVIDER_IDS } from "./ids.js";
import { level5Provider } from "./level5.js";
import { playerApiProvider } from "./player-api.js";

export const PROVIDERS = Object.freeze([
  doodProvider,
  level5Provider,
  playerApiProvider,
  hlsjsProvider,
]);

export function providerForCandidate(candidate = {}, effectiveResourceUrl = "", preferredProviderIds = []) {
  const preferred = new Set(Array.isArray(preferredProviderIds) ? preferredProviderIds : []);
  const ordered = [
    ...PROVIDERS.filter((provider) => preferred.has(provider.id)),
    ...PROVIDERS.filter((provider) => !preferred.has(provider.id)),
  ];
  return ordered.find((provider) => provider.matches(candidate, effectiveResourceUrl)) || null;
}

export function providerIdForCandidate(candidate = {}, effectiveResourceUrl = "", preferredProviderIds = []) {
  return providerForCandidate(candidate, effectiveResourceUrl, preferredProviderIds)?.id
    || PROVIDER_IDS.GENERIC;
}
