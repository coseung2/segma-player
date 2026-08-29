import { asianpornSite } from "./asianporn/profile.js";
import { av19Site } from "./av19/profile.js";
import { avseeSite } from "./avsee/profile.js";
import { beegSite } from "./beeg/profile.js";
import { doodSite } from "./dood/profile.js";
import { jamakSite } from "./jamak/profile.js";
import { lulustreamSite } from "./lulustream/profile.js";
import { missavSite } from "./missav/profile.js";
import { onlyjerkSite } from "./onlyjerk/profile.js";
import { playmogoSite } from "./playmogo/profile.js";
import { pimpbunnySite } from "./pimpbunny/profile.js";
import { recuSite } from "./recu/profile.js";
import { shackledshowSite } from "./shackledshow/profile.js";
import { youtubeSite } from "./youtube/profile.js";

export const SITE_PROFILES = Object.freeze([
  missavSite,
  av19Site,
  avseeSite,
  asianpornSite,
  onlyjerkSite,
  beegSite,
  doodSite,
  jamakSite,
  lulustreamSite,
  playmogoSite,
  pimpbunnySite,
  recuSite,
  shackledshowSite,
  youtubeSite,
]);

function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function profileMatchesHost(profile, host) {
  return Boolean(host && profile.hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`)));
}

export function siteProfileForUrls(...values) {
  for (const value of values) {
    const host = hostOf(value);
    const profile = SITE_PROFILES.find((candidate) => profileMatchesHost(candidate, host));
    if (profile) return profile;
  }
  return null;
}

export function siteProfileForCandidate(candidate = {}, effectiveResourceUrl = "") {
  return siteProfileForUrls(
    candidate?.siteUrl,
    candidate?.pageUrl,
    effectiveResourceUrl,
    candidate?.resourceUrl,
  );
}

/// Title selectors for the page a candidate came from, or an empty list.
///
/// Match on the page/site URL only. A media host such as a CDN never carries the
/// page's heading, so keying off the resource URL would return selectors that
/// cannot resolve.
export function titleSelectorsForPage(pageUrl = "", siteUrl = "") {
  const profile = siteProfileForUrls(siteUrl, pageUrl);
  return profile?.titleSelectors ?? Object.freeze([]);
}

/// True when `frameUrl` is a player iframe whose own document title should be
/// ignored in favour of the parent page's title.
export function isPlayerFrameUrl(frameUrl = "") {
  if (!frameUrl) return false;
  let parsed;
  try {
    parsed = new URL(frameUrl);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const profile = SITE_PROFILES.find((candidate) => profileMatchesHost(candidate, host));
  if (!profile?.playerFramePaths?.length) return false;
  const path = parsed.pathname.toLowerCase();
  return profile.playerFramePaths.some((candidate) => path === candidate);
}
