import { COMPANION_INSTALL_URL } from "../../edition.js";
import {
  LOCALE_STORAGE_KEY,
  applyStaticTranslations,
  loadLocale,
  normalizeLocale,
  translator,
} from "../../i18n.js";

const MEDIA_DOWNLOAD_CAPABILITY = "media-download-v1";

let t = translator();
const companionStatusElement = document.querySelector("#companion-status");
const companionOpenButton = document.querySelector("#companion-open");
const companionHelpLink = document.querySelector("#companion-help");

function sendBackground(message) {
  return chrome.runtime.sendMessage(message);
}

function configuredInstallUrl() {
  return /^https:\/\//i.test(COMPANION_INSTALL_URL) ? COMPANION_INSTALL_URL : "";
}

function companionNeedsUpdate(status) {
  if (!status?.ok) return false;
  if (status.updateRequired === true || status.needsUpdate === true) return true;
  const capabilities = Array.isArray(status.capabilities) ? status.capabilities : [];
  if (!capabilities.length) return false;
  return !capabilities.includes(MEDIA_DOWNLOAD_CAPABILITY);
}

function renderCompanionStatus(status) {
  const installUrl = configuredInstallUrl();
  companionOpenButton.disabled = false;
  companionHelpLink.hidden = true;
  companionHelpLink.removeAttribute("href");
  companionStatusElement.classList.remove("is-error", "is-ready");

  if (status?.ok && companionNeedsUpdate(status)) {
    companionStatusElement.textContent = t("companion.update");
    companionStatusElement.classList.add("is-error");
    if (installUrl) {
      companionHelpLink.href = installUrl;
      companionHelpLink.textContent = t("companion.updateAction");
      companionHelpLink.hidden = false;
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
    companionHelpLink.href = installUrl;
    companionHelpLink.textContent = t("companion.install");
    companionHelpLink.hidden = false;
  }
}

async function refreshCompanionStatus() {
  companionStatusElement.textContent = t("companion.checking");
  companionStatusElement.classList.remove("is-error", "is-ready");
  companionHelpLink.hidden = true;
  try {
    const status = await sendBackground({ type: "companion-status" });
    renderCompanionStatus(status);
  } catch {
    renderCompanionStatus({ ok: false });
  }
}

async function openCompanion() {
  companionOpenButton.disabled = true;
  try {
    const response = await sendBackground({ type: "show-companion-ui" });
    if (!response?.ok) throw new Error(response?.error || "media-companion-unavailable");
  } catch {
    companionStatusElement.textContent = t("companion.openFailed");
    companionStatusElement.classList.add("is-error");
    companionStatusElement.classList.remove("is-ready");
    const installUrl = configuredInstallUrl();
    if (installUrl) {
      companionHelpLink.href = installUrl;
      companionHelpLink.textContent = t("companion.install");
      companionHelpLink.hidden = false;
    }
  } finally {
    companionOpenButton.disabled = false;
  }
}

function applyLocale(locale) {
  t = translator(locale);
  document.documentElement.lang = t.locale;
  document.title = t("settings.title");
  applyStaticTranslations(document, t);
  void refreshCompanionStatus();
}

companionOpenButton.addEventListener("click", () => void openCompanion());

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
}

void start();
