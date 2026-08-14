import { ensureSaveDirectory, getStoredSaveDirectory } from "./save-directory.js";
import { LICENSE_API_URL } from "./license.js";
const PURCHASE_API_ORIGIN = LICENSE_API_URL.replace(/\/api\/license$/, "");
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
const purchaseOrderBox = document.querySelector("#purchase-order");
const purchaseAddress = document.querySelector("#purchase-address");
const purchaseAmount = document.querySelector("#purchase-amount");
const purchaseTxInput = document.querySelector("#purchase-tx");
const purchaseVerifyButton = document.querySelector("#purchase-verify");
const purchaseStatus = document.querySelector("#purchase-status");
let purchaseOrderId = null;

async function refreshParallelStatus() {
  const handle = await getStoredSaveDirectory();
  parallelStatusElement.textContent = handle
    ? `저장 경로: ${handle.name}`
    : "저장 폴더가 아직 없습니다. 아래 버튼으로 새 폴더를 만들어 선택해 주세요.";
}

parallelFolderButton.addEventListener("click", async () => {
  try {
    const handle = await ensureSaveDirectory({ pick: true });
    parallelStatusElement.textContent = handle
      ? `저장 경로: ${handle.name}`
      : "폴더 선택이 취소되었습니다.";
  } catch {
    parallelStatusElement.textContent = "폴더 선택이 차단됐어요. Downloads 루트 대신 새 폴더를 만들어 선택해 주세요.";
  }
});

void refreshParallelStatus();


async function refreshLicenseStatus() {
  licenseStatusElement.textContent = "확인 중…";
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
      ? `키당 기기 ${limit}개 제한`
      : `키당 기기 ${limit}개 제한 · 현재 ${devices}/${limit}`;
    const authenticated = Boolean(response?.ok && response.edition === "pro" && key);
    licenseAuthStatusElement.textContent = authenticated ? "인증됨" : "미인증";
    licenseAuthStatusElement.classList.toggle("authenticated", authenticated);
    licenseStatusElement.textContent = "";
  } catch {
    licenseStatusElement.textContent = "상태를 확인할 수 없습니다.";
  }
}

licenseCopyButton.addEventListener("click", async () => {
  const key = licenseKeyInput.value.trim();
  if (!key) {
    licenseStatusElement.textContent = "복사할 키가 없습니다.";
    return;
  }
  try {
    await navigator.clipboard.writeText(key);
    licenseStatusElement.textContent = "키를 복사했습니다.";
  } catch {
    licenseKeyInput.focus();
    licenseKeyInput.select();
    try {
      document.execCommand("copy");
      licenseStatusElement.textContent = "키를 복사했습니다.";
    } catch {
      licenseStatusElement.textContent = "키를 직접 선택해 복사해 주세요.";
    }
  }
});

licenseActivateButton.addEventListener("click", async () => {
  const key = licenseKeyInput.value.trim();
  if (!key) {
    licenseStatusElement.textContent = "키를 입력해 주세요.";
    return;
  }
  licenseStatusElement.textContent = "확인 중…";
  const response = await chrome.runtime.sendMessage({ type: "license-activate", key });
  if (response?.ok) {
    await refreshLicenseStatus();
  } else if (response?.error === "license-pending") {
    licenseStatusElement.textContent = "키가 등록되었습니다. 개발자 승인 후 자동으로 Pro가 적용됩니다.";
  } else if (response?.error === "invalid-key") {
    licenseStatusElement.textContent = "키 형식이 올바르지 않습니다.";
  } else if (response?.error === "license-server-unreachable") {
    licenseStatusElement.textContent = "라이선스 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.";
  } else if (response?.error === "device-limit-reached") {
    licenseStatusElement.textContent = "기기 3개 제한에 도달했습니다.";
  } else {
    licenseStatusElement.textContent = "아직 승인되지 않은 키입니다.";
  }
});

void refreshLicenseStatus();

purchaseCreateButton.addEventListener("click", async () => {
  purchaseCreateButton.disabled = true;
  purchaseStatus.textContent = "주문 생성 중…";
  try {
    const response = await fetch(`${PURCHASE_API_ORIGIN}/api/pay/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ period: purchasePeriodSelect.value }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      purchaseStatus.textContent = data?.error === "payment-not-configured"
        ? "결제가 아직 설정되지 않았습니다."
        : "주문을 생성하지 못했습니다.";
      return;
    }
    purchaseOrderId = data.orderId;
    purchaseAddress.textContent = `${String(data.network).toUpperCase()} 주소: ${data.walletAddress}`;
    purchaseAmount.textContent = `결제 금액: ${data.amountUsdt} USDT`;
    purchaseOrderBox.hidden = false;
    purchaseStatus.textContent = "위 주소로 정확한 금액을 보낸 뒤 TxID를 입력해 주세요.";
  } catch {
    purchaseStatus.textContent = "주문을 생성하지 못했습니다.";
  } finally {
    purchaseCreateButton.disabled = false;
  }
});

purchaseVerifyButton.addEventListener("click", async () => {
  const txHash = purchaseTxInput.value.trim();
  if (!txHash || !purchaseOrderId) {
    purchaseStatus.textContent = "TxID를 입력해 주세요.";
    return;
  }
  purchaseVerifyButton.disabled = true;
  purchaseStatus.textContent = "결제 확인 중…";
  try {
    const response = await fetch(`${PURCHASE_API_ORIGIN}/api/pay/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: purchaseOrderId, txHash }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      purchaseStatus.textContent = data?.error === "transaction-not-confirmed"
        ? "아직 블록체인에 확정되지 않았습니다. 잠시 후 다시 시도하세요."
        : (data?.error || "결제 확인에 실패했습니다.");
      return;
    }
    licenseKeyInput.value = data.key;
    purchaseStatus.textContent = "결제가 확인되었습니다. 라이선스 키가 자동 입력됐습니다.";
    purchaseOrderBox.hidden = true;
    licenseActivateButton.click();
  } catch {
    purchaseStatus.textContent = "결제 확인에 실패했습니다.";
  } finally {
    purchaseVerifyButton.disabled = false;
  }
});
