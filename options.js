import { ensureSaveDirectory, getStoredSaveDirectory } from "./save-directory.js";
import { LICENSE_API_URL } from "./license.js";
import {
  LOCALE_STORAGE_KEY,
  applyStaticTranslations,
  loadLocale,
  normalizeLocale,
  translator,
} from "./i18n.js";

const PURCHASE_API_ORIGIN = LICENSE_API_URL.replace(/\/api\/license$/, "");
let t = translator();
const licenseStatusElement = document.querySelector("#license-status");
const licenseDeviceStatusElement = document.querySelector("#license-device-status");
const licenseAuthStatusElement = document.querySelector("#license-auth-status");
const licenseKeyInput = document.querySelector("#license-key");
const licenseActivateButton = document.querySelector("#license-activate");
const licenseCopyButton = document.querySelector("#license-copy");
const licenseSection = document.querySelector("#license-section");
const parallelFolderButton = document.querySelector("#parallel-folder");
const parallelStatusElement = document.querySelector("#parallel-status");
const purchasePeriodSelect = document.querySelector("#purchase-period");
const purchaseCreateButton = document.querySelector("#purchase-create");
const purchaseToggleButton = document.querySelector("#purchase-toggle");
const purchasePanel = document.querySelector("#purchase-panel");
const purchaseOrderBox = document.querySelector("#purchase-order");
const purchaseAddress = document.querySelector("#purchase-address");
const purchaseAmount = document.querySelector("#purchase-amount");
const purchaseTxInput = document.querySelector("#purchase-tx");
const purchaseVerifyButton = document.querySelector("#purchase-verify");
const purchaseStatus = document.querySelector("#purchase-status");
let purchaseOrderId = null;

purchaseToggleButton.addEventListener("click", () => {
  const opening = purchasePanel.hidden;
  purchasePanel.hidden = !opening;
  purchaseToggleButton.setAttribute("aria-expanded", String(opening));
});

async function refreshParallelStatus() {
  const handle = await getStoredSaveDirectory();
  parallelStatusElement.textContent = handle
    ? t("save.path", { name: handle.name })
    : t("settings.folderMissing");
}

parallelFolderButton.addEventListener("click", async () => {
  try {
    const handle = await ensureSaveDirectory({ pick: true });
    parallelStatusElement.textContent = handle
      ? t("save.path", { name: handle.name })
      : t("settings.folderCancelled");
  } catch {
    parallelStatusElement.textContent = t("settings.folderBlocked");
  }
});

async function refreshLicenseStatus() {
  licenseStatusElement.textContent = t("settings.checking");
  try {
    const response = await chrome.runtime.sendMessage({ type: "license-status" });
    const key = typeof response?.key === "string" ? response.key : "";
    licenseSection.hidden = false;
    licenseKeyInput.disabled = false;
    licenseActivateButton.disabled = false;
    licenseCopyButton.disabled = !key;
    if (key) licenseKeyInput.value = key;
    const devices = typeof response?.devices === "number" ? response.devices : null;
    const limit = typeof response?.limit === "number" ? response.limit : 3;
    licenseDeviceStatusElement.textContent = devices === null
      ? t("settings.deviceLimit", { limit })
      : t("settings.deviceLimitUsed", { limit, devices });
    const authenticated = Boolean(response?.ok && response.edition === "pro" && key);
    licenseAuthStatusElement.textContent = authenticated
      ? t("settings.authenticated")
      : t("settings.unauthenticated");
    licenseAuthStatusElement.classList.toggle("authenticated", authenticated);
    licenseStatusElement.textContent = "";
  } catch {
    licenseStatusElement.textContent = t("settings.statusUnavailable");
  }
}

licenseCopyButton.addEventListener("click", async () => {
  const key = licenseKeyInput.value.trim();
  if (!key) {
    licenseStatusElement.textContent = t("settings.noKeyToCopy");
    return;
  }
  try {
    await navigator.clipboard.writeText(key);
    licenseStatusElement.textContent = t("settings.keyCopied");
  } catch {
    licenseKeyInput.focus();
    licenseKeyInput.select();
    try {
      document.execCommand("copy");
      licenseStatusElement.textContent = t("settings.keyCopied");
    } catch {
      licenseStatusElement.textContent = t("settings.copyManually");
    }
  }
});

licenseActivateButton.addEventListener("click", async () => {
  const key = licenseKeyInput.value.trim();
  if (!key) {
    licenseStatusElement.textContent = t("settings.enterKey");
    return;
  }
  licenseStatusElement.textContent = t("settings.checking");
  const response = await chrome.runtime.sendMessage({ type: "license-activate", key });
  if (response?.ok) {
    await refreshLicenseStatus();
  } else if (response?.error === "license-pending") {
    licenseStatusElement.textContent = t("settings.keyPending");
  } else if (response?.error === "invalid-key") {
    licenseStatusElement.textContent = t("settings.keyInvalid");
  } else if (response?.error === "license-server-unreachable") {
    licenseStatusElement.textContent = t("settings.keyServerDown");
  } else if (response?.error === "device-limit-reached") {
    licenseStatusElement.textContent = t("settings.keyDeviceLimit");
  } else {
    licenseStatusElement.textContent = t("settings.keyNotApproved");
  }
});

purchaseCreateButton.addEventListener("click", async () => {
  purchaseCreateButton.disabled = true;
  purchaseStatus.textContent = t("settings.creatingOrder");
  try {
    const response = await fetch(`${PURCHASE_API_ORIGIN}/api/pay/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ period: purchasePeriodSelect.value }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      purchaseStatus.textContent = data?.error === "payment-not-configured"
        ? t("settings.paymentNotConfigured")
        : t("settings.orderFailed");
      return;
    }
    purchaseOrderId = data.orderId;
    purchaseAddress.textContent = t("settings.walletAddress", {
      network: String(data.network).toUpperCase(),
      address: data.walletAddress,
    });
    purchaseAmount.textContent = t("settings.payAmount", { amount: data.amountUsdt });
    purchaseOrderBox.hidden = false;
    purchaseStatus.textContent = t("settings.sendThenVerify");
  } catch {
    purchaseStatus.textContent = t("settings.orderFailed");
  } finally {
    purchaseCreateButton.disabled = false;
  }
});

purchaseVerifyButton.addEventListener("click", async () => {
  const txHash = purchaseTxInput.value.trim();
  if (!txHash || !purchaseOrderId) {
    purchaseStatus.textContent = t("settings.txRequired");
    return;
  }
  purchaseVerifyButton.disabled = true;
  purchaseStatus.textContent = t("settings.verifyingPayment");
  try {
    const response = await fetch(`${PURCHASE_API_ORIGIN}/api/pay/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: purchaseOrderId, txHash }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Raw server codes are not user-facing; map the known ones and fall back
      // to a generic failure so a code like `trongrid-http-429` never surfaces.
      const messages = {
        "transaction-not-confirmed": "settings.txUnconfirmed",
        "usdt-transfer-not-found": "settings.txNotFound",
        "order-not-found": "settings.orderExpired",
        "already-confirmed": "settings.alreadyConfirmed",
        "payment-not-configured": "settings.paymentNotConfigured",
        "invalid-request": "settings.txRequired",
      };
      const key = messages[data?.error];
      purchaseStatus.textContent = key ? t(key) : t("settings.verifyFailed");
      return;
    }
    licenseKeyInput.value = data.key;
    purchaseStatus.textContent = t("settings.paymentConfirmed");
    purchaseOrderBox.hidden = true;
    licenseActivateButton.click();
  } catch {
    purchaseStatus.textContent = t("settings.verifyFailed");
  } finally {
    purchaseVerifyButton.disabled = false;
  }
});

function applyLocale(locale) {
  t = translator(locale);
  document.documentElement.lang = t.locale;
  document.title = t("settings.title");
  applyStaticTranslations(document, t);
  void refreshParallelStatus();
  void refreshLicenseStatus();
}

chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local" || !changes[LOCALE_STORAGE_KEY]) return;
  const next = normalizeLocale(changes[LOCALE_STORAGE_KEY].newValue);
  if (next && next !== t.locale) applyLocale(next);
});

async function start() {
  applyLocale(await loadLocale());
}

void start();
