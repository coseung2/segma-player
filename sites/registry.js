import { asianpornSite } from "./asianporn/profile.js";
import { av19Site } from "./av19/profile.js";
import { beegSite } from "./beeg/profile.js";
import { doodSite } from "./dood/profile.js";
import { missavSite } from "./missav/profile.js";
import { onlyjerkSite } from "./onlyjerk/profile.js";
import { playmogoSite } from "./playmogo/profile.js";
import { shackledshowSite } from "./shackledshow/profile.js";
import { youtubeSite } from "./youtube/profile.js";

export const SITE_PROFILES = Object.freeze([
  missavSite,
  av19Site,
  asianpornSite,
  onlyjerkSite,
  beegSite,
  doodSite,
  playmogoSite,
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
