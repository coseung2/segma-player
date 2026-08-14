import { canonicalHttpUrl } from "./candidate.js";

export const MOBILE_USER_AGENT_RESOURCE_TYPES = Object.freeze([
  "main_frame",
  "sub_frame",
  "media",
  "xmlhttprequest",
]);
export const MOBILE_USER_AGENT_RULE_ID_START = 2_000_000_000;
export const MOBILE_USER_AGENT_RULE_ID_END = 2_000_999_999;
export const MAX_MOBILE_USER_AGENT_LENGTH = 512;
export const MAX_TAB_ID = 2_147_483_647;

const MAX_DNR_PRIORITY = 2_147_483_647;

export function normalizeMobileUserAgent(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_MOBILE_USER_AGENT_LENGTH
    || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

export function isValidMobileUserAgent(value) {
  return normalizeMobileUserAgent(value) !== null;
}

export function normalizeMobileTabContext({ tabId, tabUrl, pageUrl, url } = {}) {
  if (!Number.isInteger(tabId) || tabId < 1 || tabId > MAX_TAB_ID) return null;
  const rawUrl = typeof tabUrl === "string" ? tabUrl
    : typeof pageUrl === "string" ? pageUrl : url;
  const canonical = canonicalHttpUrl(rawUrl);
  if (!canonical) return null;
  return Object.freeze({ tabId, tabUrl: canonical.href });
}

export function isValidMobileTabContext(context) {
  return normalizeMobileTabContext(context) !== null;
}

export function isMobileUserAgentRuleId(ruleId) {
  return Number.isInteger(ruleId)
    && ruleId >= MOBILE_USER_AGENT_RULE_ID_START
    && ruleId <= MOBILE_USER_AGENT_RULE_ID_END;
}

function assertRuleId(ruleId) {
  if (!isMobileUserAgentRuleId(ruleId)) throw new Error("invalid-mobile-user-agent-rule-id");
}

function assertPriority(priority) {
  if (!Number.isInteger(priority) || priority < 1 || priority > MAX_DNR_PRIORITY) {
    throw new Error("invalid-mobile-user-agent-rule-priority");
  }
}

export function createMobileUserAgentRuleIdAllocator({
  start = MOBILE_USER_AGENT_RULE_ID_START,
  end = MOBILE_USER_AGENT_RULE_ID_END,
  reservedIds = [],
} = {}) {
  if (!isMobileUserAgentRuleId(start) || !isMobileUserAgentRuleId(end) || start > end) {
    throw new Error("invalid-mobile-user-agent-rule-range");
  }
  if (!reservedIds || typeof reservedIds[Symbol.iterator] !== "function") {
    throw new Error("invalid-mobile-user-agent-reserved-ids");
  }
  const blocked = new Set();
  for (const ruleId of reservedIds) {
    if (!Number.isInteger(ruleId) || ruleId < start || ruleId > end) {
      throw new Error("invalid-mobile-user-agent-reserved-id");
    }
    blocked.add(ruleId);
  }
  let next = start;
  const allocated = new Set();
  const capacity = end - start + 1;

  function nextAvailable() {
    for (let offset = 0; offset < capacity; offset += 1) {
      const candidate = start + ((next - start + offset) % capacity);
      if (!blocked.has(candidate) && !allocated.has(candidate)) {
        allocated.add(candidate);
        next = candidate === end ? start : candidate + 1;
        return candidate;
      }
    }
    throw new Error("mobile-user-agent-rule-id-exhausted");
  }

  return Object.freeze({
    allocate: nextAvailable,
    release(ruleId) {
      allocated.delete(ruleId);
    },
    has(ruleId) {
      return allocated.has(ruleId) || blocked.has(ruleId);
    },
    get size() {
      return allocated.size;
    },
  });
}

export function buildMobileUserAgentRule({
  ruleId,
  tabId,
  tabUrl,
  pageUrl,
  url,
  userAgent,
  priority = 1,
} = {}) {
  assertRuleId(ruleId);
  assertPriority(priority);
  const context = normalizeMobileTabContext({ tabId, tabUrl, pageUrl, url });
  if (!context) throw new Error("invalid-mobile-user-agent-tab-context");
  const normalizedUserAgent = normalizeMobileUserAgent(userAgent);
  if (!normalizedUserAgent) throw new Error("invalid-mobile-user-agent");
  return {
    id: ruleId,
    priority,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{
        header: "User-Agent",
        operation: "set",
        value: normalizedUserAgent,
      }],
    },
    condition: {
      tabIds: [context.tabId],
      resourceTypes: [...MOBILE_USER_AGENT_RESOURCE_TYPES],
    },
  };
}

export function buildMobileUserAgentRuleUpdate(input) {
  return { addRules: [buildMobileUserAgentRule(input)] };
}

export function buildMobileUserAgentRuleRemoval(ruleId) {
  assertRuleId(ruleId);
  return { removeRuleIds: [ruleId] };
}
