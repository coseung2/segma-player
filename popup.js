import {
  LOCALE_NAMES,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  applyStaticTranslations,
  loadLocale,
  normalizeLocale,
  saveLocale,
  translator,
} from "./i18n.js";

import { COMPANION_INSTALL_URL } from "./edition.js";
const MEDIA_DOWNLOAD_CAPABILITY = "media-download-v1";

let t = translator();

const byId = (id) => document.getElementById(id);
const tabs = [...document.querySelectorAll('[role="tab"]')];
const panels = [...document.querySelectorAll('[role="tabpanel"]')];
const statusElement = byId("status");
const candidatesElement = byId("candidates");
const summaryElement = byId("summary");
const mainOnlyElement = byId("main-only");
const companionStatusElement = byId("companion-status");
const companionHelpElement = byId("companion-help");
const companionOpenElement = byId("companion-open");

let lastCandidates = [];
const RESCAN_EVENT_TYPE = "aura-media-detector-rescan-v1";

function sendBackground(message) {
  return chrome.runtime.sendMessage(message);
}

function isDownloadableMediaType(value) {
  return value === "PROGRESSIVE" || value === "HLS_MASTER" || value === "HLS_MEDIA" || value === "DASH";
}

function text(tag, className, value) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  return node;
}

function closeLocaleMenu() {
  byId("locale-menu").hidden = true;
  byId("locale").setAttribute("aria-expanded", "false");
}

function renderLocaleMenu() {
  const menu = byId("locale-menu");
  menu.replaceChildren();
  for (const locale of SUPPORTED_LOCALES) {
    const option = text("button", "locale-option", LOCALE_NAMES[locale]);
    option.type = "button";
    option.setAttribute("role", "menuitemradio");
    option.setAttribute("aria-checked", String(locale === t.locale));
    option.addEventListener("click", async () => {
      closeLocaleMenu();
      if (locale === t.locale) return;
      await saveLocale(locale);
      applyLocale(locale);
    });
    menu.append(option);
  }
}

function showTab(name, focus = false) {
  for (const tab of tabs) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus();
  }
  for (const panel of panels) panel.hidden = panel.id !== `panel-${name}`;
  window.scrollTo(0, 0);
}

function mediaTypeLabel(mediaType) {
  return {
    PROGRESSIVE: t("media.progressive"),
    HLS_MASTER: t("media.stream"),
    HLS_MEDIA: t("media.stream"),
    DASH: t("media.stream"),
    YOUTUBE: t("media.youtube"),
  }[mediaType] || mediaType;
}

function setDirectStatus(message = "") {
  const output = byId("direct-status");
  output.textContent = message;
  output.hidden = !message;
}

function handoffErrorMessage(response, fallbackKey) {
  const detail = typeof response?.message === "string" && response.message
    ? response.message
    : (typeof response?.error === "string" ? response.error : "");
  if (response?.error === "invalid-youtube-url") return t("link.invalidYouTube");
  if (response?.error === "invalid-url") return t("link.needAddress");
  if (detail && !/^[a-z0-9-]+$/i.test(detail)) return detail;
  return t(fallbackKey);
}

function companionNeedsUpdate(status) {
  if (!status?.ok) return false;
  if (status.updateRequired === true || status.needsUpdate === true) return true;
  const capabilities = Array.isArray(status.capabilities) ? status.capabilities : [];
  if (!capabilities.length) return false;
  return !capabilities.includes(MEDIA_DOWNLOAD_CAPABILITY);
}

function configuredInstallUrl() {
  return /^https:\/\//i.test(COMPANION_INSTALL_URL) ? COMPANION_INSTALL_URL : "";
}

function renderCompanionStatus(status) {
  const installUrl = configuredInstallUrl();
  companionOpenElement.disabled = false;
  companionHelpElement.hidden = true;
  companionHelpElement.removeAttribute("href");
  companionStatusElement.classList.remove("is-error", "is-ready");

  if (status?.ok && companionNeedsUpdate(status)) {
    companionStatusElement.textContent = t("companion.update");
    companionStatusElement.classList.add("is-error");
    if (installUrl) {
      companionHelpElement.href = installUrl;
      companionHelpElement.textContent = t("companion.updateAction");
      companionHelpElement.hidden = false;
    }
    return;
  }

  if (status?.ok) {
    companionStatusElement.textContent = t("companion.connected");
    companionStatusElement.classList.add("is-ready");
    return;
  }

  companionStatusElement.textContent = t("companion.unavailable");
  companionStatusElement.classList.add("is-error");
  if (installUrl) {
    companionHelpElement.href = installUrl;
    companionHelpElement.textContent = t("companion.install");
    companionHelpElement.hidden = false;
  }
}

async function refreshCompanionStatus() {
  companionStatusElement.textContent = t("companion.checking");
  companionStatusElement.classList.remove("is-error", "is-ready");
  companionHelpElement.hidden = true;
  try {
    const status = await sendBackground({ type: "companion-status" });
    renderCompanionStatus(status);
  } catch {
    renderCompanionStatus({ ok: false });
  }
}

async function openCompanion() {
  companionOpenElement.disabled = true;
  try {
    const response = await sendBackground({ type: "show-companion-ui" });
    if (!response?.ok) throw new Error(response?.error || "media-companion-unavailable");
  } catch {
    companionStatusElement.textContent = t("companion.openFailed");
    companionStatusElement.classList.add("is-error");
    companionStatusElement.classList.remove("is-ready");
    const installUrl = configuredInstallUrl();
    if (installUrl) {
      companionHelpElement.href = installUrl;
      companionHelpElement.textContent = t("companion.install");
      companionHelpElement.hidden = false;
    }
  } finally {
    companionOpenElement.disabled = false;
  }
}

function renderCandidates(candidates) {
  const downloadable = (Array.isArray(candidates) ? candidates : []).filter((candidate) =>
    isDownloadableMediaType(candidate.mediaType) && !candidate.likelyAdvertisement);
  lastCandidates = downloadable;
  const sorted = [...downloadable].sort((a, b) =>
    (Number(b.main) - Number(a.main))
    || (Number(a.likelyAdvertisement) - Number(b.likelyAdvertisement))
    || (Number(b.score || 0) - Number(a.score || 0)));
  const hasMain = sorted.some((item) => item.main && !item.likelyAdvertisement
    && !String(item.displayUrl || "").startsWith("blob:"));
  const shown = mainOnlyElement.checked && hasMain
    ? sorted.filter((item) => item.main && !item.likelyAdvertisement)
    : sorted;
  summaryElement.textContent = t("detect.candidateCount", { count: shown.length });
  candidatesElement.replaceChildren();
  if (!shown.length) {
    candidatesElement.append(text("div", "empty-state", t("detect.empty")));
    return 0;
  }
  for (const candidate of shown) {
    const card = document.createElement("article");
    card.className = "candidate-card";
    card.dataset.candidateId = candidate.id;
    const info = document.createElement("div");
    info.className = "candidate-info";
    info.append(
      text("h2", "candidate-title", candidate.pageTitle || t("detect.untitled")),
      text("p", "candidate-origin", candidate.pageOrigin || ""),
      text("p", "candidate-url", candidate.displayUrl || ""),
    );
    const meta = document.createElement("div");
    meta.className = "candidate-meta";
    const label = mediaTypeLabel(candidate.mediaType);
    meta.append(text("span", "badge", candidate.main ? t("media.mainSuffix", { label }) : label));
    const button = text("button", "download-button", t("action.download"));
    button.type = "button";
    button.disabled = !isDownloadableMediaType(candidate.mediaType);
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = t("action.requesting");
      try {
        const response = await sendBackground({
          type: "download-candidate",
          candidateId: candidate.id,
        });
        if (!response?.ok) throw new Error(handoffErrorMessage(response, "link.startFailed"));
        button.textContent = t("action.sent");
      } catch (error) {
        statusElement.textContent = error?.message || t("link.startFailed");
        button.disabled = false;
        button.textContent = t("action.tryAgain");
      }
    });
    meta.append(button);
    info.append(meta);
    card.append(info);
    candidatesElement.append(card);
  }
  return shown.length;
}

async function requestCandidates() {
  statusElement.textContent = t("detect.scanning");
  try {
    const response = await sendBackground({ type: "list-candidates" });
    const count = renderCandidates(response?.candidates || []);
    statusElement.textContent = t("detect.ready");
    return count;
  } catch {
    statusElement.textContent = t("detect.reloadExtension");
    return 0;
  }
}

function isYouTubeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.hostname === "youtu.be"
      || url.hostname === "youtube.com"
      || url.hostname.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

function updateLinkPanel() {
  byId("youtube-quality-row").hidden = !isYouTubeUrl(byId("direct-url").value);
}

async function directDownload() {
  const input = byId("direct-url");
  const button = byId("download-url");
  if (!input.value.trim()) { setDirectStatus(t("link.needAddress")); return; }
  button.disabled = true;
  setDirectStatus(t("link.checking"));
  try {
    const value = input.value.trim();
    const response = isYouTubeUrl(value)
      ? await sendBackground({
        type: "youtube-download",
        url: value,
        quality: byId("youtube-quality").value,
      })
      : await sendBackground({
        type: "download-url",
        url: value,
      });
    if (!response?.ok) {
      throw new Error(handoffErrorMessage(response, isYouTubeUrl(value) ? "link.youtubeFailed" : "link.startFailed"));
    }
    setDirectStatus(t("link.started"));
  } catch (error) {
    setDirectStatus(error?.message || t("link.startFailed"));
  } finally {
    button.disabled = false;
  }
}

async function rescan() {
  const button = byId("rescan");
  button.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await sendBackground({ type: "clear-tab", tabId: tab.id }).catch(() => {});
      // A player usually lives in a subframe. Inject missing detectors into all
      // frames, then wake every existing detector through a same-world DOM
      // event so the button also works after the popup was opened pre-playback.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["content.js"],
      }).catch(() => {});
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: (eventType) => window.dispatchEvent(new Event(eventType)),
        args: [RESCAN_EVENT_TYPE],
      }).catch(() => {});

      for (const delayMs of [200, 600, 1_200]) {
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
        if (await requestCandidates() > 0) break;
      }
      return;
    }
    await requestCandidates();
  } finally {
    button.disabled = false;
  }
}

function applyLocale(locale) {
  t = translator(locale);
  document.documentElement.lang = t.locale;
  document.title = t("app.title");
  applyStaticTranslations(document, t);
  renderLocaleMenu();
  renderCandidates(lastCandidates);
  void refreshCompanionStatus();
}

byId("locale")?.addEventListener("click", (event) => {
  event.stopPropagation();
  const menu = byId("locale-menu");
  const opening = menu.hidden;
  menu.hidden = !opening;
  byId("locale").setAttribute("aria-expanded", String(opening));
  if (opening) menu.querySelector('[aria-checked="true"]')?.focus();
});
document.addEventListener("click", (event) => {
  if (byId("locale-menu").hidden) return;
  if (!event.target.closest(".locale-menu-wrap")) closeLocaleMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!byId("locale-menu")?.hidden) closeLocaleMenu();
});

for (const tab of tabs) {
  tab.addEventListener("click", () => showTab(tab.dataset.tab));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const visibleTabs = tabs.filter((item) => !item.hidden);
    const current = visibleTabs.indexOf(tab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? visibleTabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + visibleTabs.length) % visibleTabs.length;
    showTab(visibleTabs[Math.min(next, visibleTabs.length - 1)].dataset.tab, true);
  });
}

byId("refresh").addEventListener("click", () => {
  void refreshCompanionStatus();
  const active = tabs.find((tab) => tab.getAttribute("aria-selected") === "true")?.dataset.tab;
  if (active === "detect") void requestCandidates();
});
byId("rescan").addEventListener("click", () => void rescan());
byId("download-url").addEventListener("click", () => void directDownload());
byId("direct-url").addEventListener("keydown", (event) => { if (event.key === "Enter") void directDownload(); });
byId("direct-url").addEventListener("input", updateLinkPanel);
byId("companion-open").addEventListener("click", () => void openCompanion());
mainOnlyElement.addEventListener("change", () => renderCandidates(lastCandidates));

chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local" || !changes[LOCALE_STORAGE_KEY]) return;
  const next = normalizeLocale(changes[LOCALE_STORAGE_KEY].newValue);
  if (next && next !== t.locale) applyLocale(next);
});

window.addEventListener("focus", () => void refreshCompanionStatus());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshCompanionStatus();
});

async function start() {
  applyLocale(await loadLocale());
  updateLinkPanel();
  void requestCandidates();
}

void start();
