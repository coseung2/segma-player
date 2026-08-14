import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MOBILE_USER_AGENT_LENGTH,
  MOBILE_USER_AGENT_RESOURCE_TYPES,
  MOBILE_USER_AGENT_RULE_ID_END,
  MOBILE_USER_AGENT_RULE_ID_START,
  buildMobileUserAgentRule,
  buildMobileUserAgentRuleRemoval,
  buildMobileUserAgentRuleUpdate,
  createMobileUserAgentRuleIdAllocator,
  isMobileUserAgentRuleId,
  isValidMobileTabContext,
  normalizeMobileUserAgent,
} from "./mobile-user-agent.js";

const MOBILE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36";

test("builds a tab-scoped DNR add rule and matching remove shape", () => {
  const ruleId = MOBILE_USER_AGENT_RULE_ID_START;
  const input = {
    ruleId,
    tabId: 17,
    tabUrl: "https://Example.com/watch",
    userAgent: MOBILE_UA,
  };
  const rule = buildMobileUserAgentRule(input);
  assert.deepEqual(rule, {
    id: ruleId,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "User-Agent", operation: "set", value: MOBILE_UA }],
    },
    condition: {
      tabIds: [17],
      resourceTypes: ["main_frame", "sub_frame", "media", "xmlhttprequest"],
    },
  });
  assert.deepEqual(buildMobileUserAgentRuleUpdate(input), { addRules: [rule] });
  assert.deepEqual(buildMobileUserAgentRuleRemoval(ruleId), { removeRuleIds: [ruleId] });
  assert.deepEqual(MOBILE_USER_AGENT_RESOURCE_TYPES, ["main_frame", "sub_frame", "media", "xmlhttprequest"]);
});

test("keeps rules isolated to their individual tabs", () => {
  const first = buildMobileUserAgentRule({
    ruleId: MOBILE_USER_AGENT_RULE_ID_START + 1,
    tabId: 4,
    tabUrl: "https://one.example/video",
    userAgent: MOBILE_UA,
  });
  const second = buildMobileUserAgentRule({
    ruleId: MOBILE_USER_AGENT_RULE_ID_START + 2,
    tabId: 5,
    tabUrl: "http://two.example/video",
    userAgent: MOBILE_UA,
  });
  assert.deepEqual(first.condition.tabIds, [4]);
  assert.deepEqual(second.condition.tabIds, [5]);
  assert.notDeepEqual(first.condition.tabIds, second.condition.tabIds);
});

test("requires a public canonical HTTP(S) tab context and a bounded header value", () => {
  for (const tabUrl of [
    "file:///tmp/video.mp4",
    "chrome://settings",
    "https://127.0.0.1/video",
    "https://user:pass@example.com/video",
    "https://example.com/video#fragment",
  ]) {
    assert.equal(isValidMobileTabContext({ tabId: 1, tabUrl }), false, tabUrl);
    assert.throws(() => buildMobileUserAgentRule({
      ruleId: MOBILE_USER_AGENT_RULE_ID_START,
      tabId: 1,
      tabUrl,
      userAgent: MOBILE_UA,
    }), /invalid-mobile-user-agent-tab-context/);
  }
  assert.throws(() => buildMobileUserAgentRule({
    ruleId: MOBILE_USER_AGENT_RULE_ID_START,
    tabId: 0,
    tabUrl: "https://example.com/video",
    userAgent: MOBILE_UA,
  }), /invalid-mobile-user-agent-tab-context/);
  assert.equal(normalizeMobileUserAgent(`${MOBILE_UA}\r\nInjected: yes`), null);
  assert.equal(normalizeMobileUserAgent("x".repeat(MAX_MOBILE_USER_AGENT_LENGTH + 1)), null);
  assert.throws(() => buildMobileUserAgentRule({
    ruleId: MOBILE_USER_AGENT_RULE_ID_START,
    tabId: 1,
    tabUrl: "https://example.com/video",
    userAgent: "x".repeat(MAX_MOBILE_USER_AGENT_LENGTH + 1),
  }), /invalid-mobile-user-agent$/);
});

test("allocates collision-safe IDs only inside the reserved range", () => {
  const start = MOBILE_USER_AGENT_RULE_ID_START + 10;
  const allocator = createMobileUserAgentRuleIdAllocator({
    start,
    end: start + 2,
    reservedIds: [start],
  });
  const first = allocator.allocate();
  const second = allocator.allocate();
  assert.equal(first, start + 1);
  assert.equal(second, start + 2);
  assert.equal(allocator.has(start), true);
  assert.equal(allocator.has(first), true);
  assert.throws(() => allocator.allocate(), /id-exhausted/);
  allocator.release(first);
  assert.equal(allocator.allocate(), first);
  assert.equal(isMobileUserAgentRuleId(MOBILE_USER_AGENT_RULE_ID_START), true);
  assert.equal(isMobileUserAgentRuleId(MOBILE_USER_AGENT_RULE_ID_END), true);
  assert.equal(isMobileUserAgentRuleId(MOBILE_USER_AGENT_RULE_ID_START - 1), false);
  assert.equal(isMobileUserAgentRuleId(MOBILE_USER_AGENT_RULE_ID_END + 1), false);
  assert.throws(() => buildMobileUserAgentRule({
    ruleId: MOBILE_USER_AGENT_RULE_ID_START - 1,
    tabId: 1,
    tabUrl: "https://example.com/video",
    userAgent: MOBILE_UA,
  }), /invalid-mobile-user-agent-rule-id/);
  assert.throws(() => buildMobileUserAgentRule({
    ruleId: MOBILE_USER_AGENT_RULE_ID_END + 1,
    tabId: 1,
    tabUrl: "https://example.com/video",
    userAgent: MOBILE_UA,
  }), /invalid-mobile-user-agent-rule-id/);
});
