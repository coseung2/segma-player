"use strict";
(() => {
  const RULES = globalThis.AuraAdBlockRules;
  if (!RULES || !document.documentElement) return;

  const STORAGE_KEY = "auraAdBlock";
  const site = (() => {
    try {
      return new URL(location.href).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();

  let enabled = RULES.DEFAULT_SETTINGS.enabled;
  let filters = { ...RULES.DEFAULT_SETTINGS.filters };
  let siteAllow = [];
  let hiddenElements = 0;
  let suppressedPopups = 0;
  let applyQueued = false;

  function isAllowed() {
    if (!site) return false;
    return siteAllow.some((allowed) => site === allowed || site.endsWith(`.${allowed}`));
  }

  function flushCounts() {
    if (!hiddenElements && !suppressedPopups) return;
    const payload = { type: "adblock:increment", hiddenElements, suppressedPopups };
    hiddenElements = 0;
    suppressedPopups = 0;
    try {
      void chrome.runtime.sendMessage(payload);
    } catch {
      // Frame navigated away; counts are best-effort.
    }
  }

  function hide(element, popup) {
    if (element.dataset.auraAdblock === "1") return;
    element.dataset.auraAdblock = "1";
    element.style.setProperty("display", "none", "important");
    if (popup) suppressedPopups += 1;
    else hiddenElements += 1;
  }

  function overlayLike(element) {
    const style = window.getComputedStyle(element);
    return style.position === "fixed" || style.position === "sticky";
  }

  function applyOnce() {
    if (!enabled || isAllowed()) return;
    if (filters.ads) {
      for (const element of document.querySelectorAll(RULES.COSMETIC_SELECTORS.join(","))) {
        hide(element, false);
      }
    }
    if (filters.annoyances) {
      for (const element of document.querySelectorAll(RULES.ANNOYANCE_SELECTORS.join(","))) {
        if (overlayLike(element)) hide(element, true);
      }
    }
  }

  function scheduleApply() {
    if (applyQueued) return;
    applyQueued = true;
    setTimeout(() => {
      applyQueued = false;
      applyOnce();
    }, 250);
  }

  async function loadState() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const source = stored[STORAGE_KEY] || {};
      enabled =
        typeof source.enabled === "boolean"
          ? source.enabled
          : RULES.DEFAULT_SETTINGS.enabled;
      filters = { ...RULES.DEFAULT_SETTINGS.filters, ...(source.filters || {}) };
      siteAllow = Array.isArray(source.siteAllow) ? source.siteAllow : [];
    } catch {
      // Storage unavailable: keep defaults.
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "adblock:refresh") return;
    void loadState().then(applyOnce);
  });

  window.addEventListener("pagehide", flushCounts, { once: true });
  setInterval(flushCounts, 2000);

  void loadState().then(() => {
    applyOnce();
    const observer = new MutationObserver(scheduleApply);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
})();
