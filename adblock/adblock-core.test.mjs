import test from "node:test";
import assert from "node:assert/strict";
import {
  ADBLOCK_RULE_ID_START,
  DEFAULT_SETTINGS,
  blockedByFilters,
  buildDnrRules,
  hostMatches,
  isSiteAllowed,
  mergeSettings,
  rollStats,
  todayKey,
  withIncrements,
} from "./adblock-core.js";
import { AD_HOSTS, FILTER_CATEGORIES, TRACKER_HOSTS } from "./adblock-rules.js";

test("hostMatches uses exact and subdomain suffix matches", () => {
  assert.equal(hostMatches("doubleclick.net", AD_HOSTS), true);
  assert.equal(hostMatches("securepubads.g.doubleclick.net", AD_HOSTS), true);
  assert.equal(hostMatches("notdoubleclick.net", AD_HOSTS), false);
  assert.equal(hostMatches("example.com", TRACKER_HOSTS), false);
  assert.equal(hostMatches("", AD_HOSTS), false);
});

test("blockedByFilters honors category switches", () => {
  const filters = { ads: true, trackers: true, annoyances: false };
  assert.equal(blockedByFilters("google-analytics.com", filters), true);
  assert.equal(
    blockedByFilters("google-analytics.com", { ...filters, trackers: false }),
    false,
  );
  assert.equal(blockedByFilters("doubleclick.net", { ...filters, ads: false }), false);
});

test("isSiteAllowed uses exact and subdomain suffix matches", () => {
  assert.equal(isSiteAllowed("www.example.com", ["example.com"]), true);
  assert.equal(isSiteAllowed("example.org", ["example.com"]), false);
  assert.equal(isSiteAllowed("", ["example.com"]), false);
});

test("rollStats resets counters when the date changes", () => {
  const today = todayKey();
  assert.deepEqual(
    rollStats({ date: "2000-01-01", blockedRequests: 9, hiddenElements: 8, suppressedPopups: 7 }),
    { date: today, blockedRequests: 0, hiddenElements: 0, suppressedPopups: 0 },
  );
  const current = { date: today, blockedRequests: 3, hiddenElements: 4, suppressedPopups: 5 };
  assert.deepEqual(rollStats(current), current);
});

test("withIncrements adds counts onto the current day", () => {
  const stats = withIncrements(
    { date: todayKey(), blockedRequests: 1, hiddenElements: 2, suppressedPopups: 3 },
    { hiddenElements: 5, suppressedPopups: 1 },
  );
  assert.deepEqual(stats, {
    date: todayKey(),
    blockedRequests: 1,
    hiddenElements: 7,
    suppressedPopups: 4,
  });
});

test("mergeSettings fills defaults and normalizes the allowlist", () => {
  const merged = mergeSettings({
    siteAllow: ["Example.COM", "example.com", "bad host"],
    filters: { annoyances: true },
  });
  assert.deepEqual(merged.filters, { ads: true, trackers: true, annoyances: true });
  assert.deepEqual(merged.siteAllow, ["example.com"]);
  assert.equal(merged.enabled, true);
});

test("buildDnrRules creates one block rule per enabled host with allowlist exclusion", () => {
  const settings = mergeSettings({ siteAllow: ["blog.example.com"] });
  const rules = buildDnrRules(settings);
  assert.ok(rules.length > 0);
  assert.ok(rules.length <= AD_HOSTS.length + TRACKER_HOSTS.length);
  assert.equal(new Set(rules.map((rule) => rule.id)).size, rules.length);
  assert.ok(rules.every((rule) => rule.id >= ADBLOCK_RULE_ID_START));
  assert.ok(rules.every((rule) => rule.action.type === "block"));
  assert.ok(rules.every((rule) => rule.condition.urlFilter.startsWith("||")));
  assert.ok(
    rules.every((rule) =>
      rule.condition.excludedInitiatorDomains.includes("blog.example.com"),
    ),
  );
  const noAllow = buildDnrRules(DEFAULT_SETTINGS);
  assert.ok(noAllow.every((rule) => rule.condition.excludedInitiatorDomains === undefined));
});

test("filter categories define the personal-use defaults", () => {
  assert.equal(FILTER_CATEGORIES.ads.defaultOn, true);
  assert.equal(FILTER_CATEGORIES.trackers.defaultOn, true);
  assert.equal(FILTER_CATEGORIES.annoyances.defaultOn, false);
  assert.equal(DEFAULT_SETTINGS.enabled, true);
});
