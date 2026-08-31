const header = document.querySelector("[data-header]");
const menuToggle = document.querySelector(".menu-toggle");
const navigation = document.querySelector("#site-nav");

function updateHeader() {
  header?.classList.toggle("scrolled", window.scrollY > 16);
}

menuToggle?.addEventListener("click", () => {
  const open = menuToggle.getAttribute("aria-expanded") !== "true";
  menuToggle.setAttribute("aria-expanded", String(open));
  navigation?.classList.toggle("open", open);
});

navigation?.addEventListener("click", (event) => {
  if (!(event.target instanceof HTMLAnchorElement)) return;
  menuToggle?.setAttribute("aria-expanded", "false");
  navigation.classList.remove("open");
});

document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
  anchor.addEventListener("click", (event) => {
    const hash = anchor.getAttribute("href");
    if (!hash || hash === "#") return;
    const target = document.querySelector(hash);
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  });
});

window.addEventListener("scroll", updateHeader, { passive: true });
updateHeader();

document.querySelectorAll("[data-year]").forEach((node) => {
  node.textContent = String(new Date().getFullYear());
});

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const reveals = [...document.querySelectorAll(".reveal")];
if (reduceMotion || !("IntersectionObserver" in window)) {
  reveals.forEach((node) => node.classList.add("is-visible"));
} else {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -8%", threshold: 0.08 });
  reveals.forEach((node) => observer.observe(node));
}

const payOverlay = document.getElementById("pay-overlay");
const payClose = document.getElementById("pay-close");
const openPay = document.getElementById("open-pay");
const payPeriod = document.getElementById("pay-period");
const payPaddle = document.getElementById("pay-paddle");
const payUsdt = document.getElementById("pay-usdt");
const payOrder = document.getElementById("pay-order");
const payAddress = document.getElementById("pay-address");
const payAmount = document.getElementById("pay-amount");
const payTx = document.getElementById("pay-tx");
const payVerify = document.getElementById("pay-verify");
const payResult = document.getElementById("pay-result");
const payKey = document.getElementById("pay-key");
const payStatus = document.getElementById("pay-status");
let payOrderId = null;
let paddleInitializedToken = null;
let paddleEnvironment = null;

function openPayModal() {
  payOverlay.hidden = false;
  payStatus.textContent = "";
  payOrder.hidden = true;
  payResult.hidden = true;
  payTx.value = "";
  payKey.textContent = "";
  payOrderId = null;
}

function closePayModal() {
  payOverlay.hidden = true;
}

openPay?.addEventListener("click", openPayModal);
payClose?.addEventListener("click", closePayModal);
payOverlay?.addEventListener("click", (event) => {
  if (event.target === payOverlay) closePayModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !payOverlay?.hidden) closePayModal();
});

function setPaymentButtonsDisabled(disabled) {
  if (payPaddle) payPaddle.disabled = disabled;
  if (payUsdt) payUsdt.disabled = disabled;
}

function showLicenseResult(data) {
  payKey.textContent = data.key;
  payOrder.hidden = true;
  payResult.hidden = false;
  payStatus.textContent = "결제가 확인되었습니다. 라이선스 키를 안전하게 보관하세요.";
}

async function pollPaddleOrder(orderId, attempts = 12) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(`/api/pay/paddle/status?orderId=${encodeURIComponent(orderId)}`);
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.status === "confirmed") return data;
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

async function handlePaddleCompleted(orderId) {
  payStatus.textContent = "Paddle 결제를 확인하는 중…";
  const result = await pollPaddleOrder(orderId);
  if (result) {
    showLicenseResult(result);
    return;
  }
  payStatus.textContent = "결제는 완료되었지만 서버 확인이 지연되고 있습니다. 잠시 후 페이지를 새로고침해 주세요.";
}

payPaddle?.addEventListener("click", async () => {
  setPaymentButtonsDisabled(true);
  payOrder.hidden = true;
  payResult.hidden = true;
  payStatus.textContent = "Paddle 결제를 준비하는 중…";
  try {
    const response = await fetch("/api/pay/paddle/order", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ period: payPeriod.value }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      payStatus.textContent = data?.error === "paddle-not-configured"
        ? "Paddle 결제가 아직 설정되지 않았습니다. USDT 결제를 이용해 주세요."
        : "Paddle 결제를 준비하지 못했습니다.";
      return;
    }
    if (!window.Paddle) {
      payStatus.textContent = "Paddle 결제 모듈을 불러오지 못했습니다.";
      return;
    }
    if (paddleEnvironment && paddleEnvironment !== data.environment) {
      payStatus.textContent = "Paddle 환경이 변경되었습니다. 페이지를 새로고침해 주세요.";
      return;
    }
    if (!paddleInitializedToken) {
      if (data.environment === "sandbox") window.Paddle.Environment.set("sandbox");
      window.Paddle.Initialize({
        token: data.clientToken,
        eventCallback(event) {
          if (event?.name !== "checkout.completed") return;
          const completedOrderId = event?.data?.custom_data?.segma_order_id || payOrderId;
          if (completedOrderId) handlePaddleCompleted(completedOrderId);
        },
      });
      paddleInitializedToken = data.clientToken;
      paddleEnvironment = data.environment;
    } else if (paddleInitializedToken !== data.clientToken) {
      payStatus.textContent = "Paddle 설정이 변경되었습니다. 페이지를 새로고침해 주세요.";
      return;
    }
    payOrderId = data.orderId;
    window.Paddle.Checkout.open({
      items: [{ priceId: data.priceId, quantity: 1 }],
      customData: { segma_order_id: data.orderId },
      settings: { displayMode: "overlay", theme: "light", locale: "ko" },
    });
    payStatus.textContent = "Paddle 결제창에서 결제를 완료해 주세요.";
  } catch {
    payStatus.textContent = "Paddle 결제를 준비하지 못했습니다.";
  } finally {
    setPaymentButtonsDisabled(false);
  }
});

payUsdt?.addEventListener("click", async () => {
  setPaymentButtonsDisabled(true);
  payStatus.textContent = "주문 생성 중…";
  payOrder.hidden = true;
  payResult.hidden = true;
  try {
    const response = await fetch("/api/pay/order", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ period: payPeriod.value }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      payStatus.textContent = data?.error === "payment-not-configured"
        ? "결제가 아직 준비되지 않았습니다. 잠시 후 다시 시도해 주세요."
        : "주문을 생성하지 못했습니다.";
      return;
    }
    payOrderId = data.orderId;
    payAddress.textContent = `입금 주소 (${String(data.network).toUpperCase()}): ${data.walletAddress}`;
    payAmount.textContent = `결제 금액: ${data.amountUsdt} USDT`;
    payOrder.hidden = false;
    payStatus.textContent = "위 주소로 정확한 금액을 보낸 뒤 TxID를 입력해 주세요.";
  } catch {
    payStatus.textContent = "주문을 생성하지 못했습니다.";
  } finally {
    setPaymentButtonsDisabled(false);
  }
});

payVerify?.addEventListener("click", async () => {
  const txHash = payTx.value.trim();
  if (!txHash || !payOrderId) {
    payStatus.textContent = "TxID를 입력해 주세요.";
    return;
  }
  payVerify.disabled = true;
  payStatus.textContent = "결제 확인 중…";
  try {
    const response = await fetch("/api/pay/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: payOrderId, txHash }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      payStatus.textContent = data?.error === "transaction-not-confirmed"
        ? "아직 블록체인에 확정되지 않았습니다. 잠시 후 다시 시도하세요."
        : (data?.error || "결제 확인에 실패했습니다.");
      return;
    }
    showLicenseResult(data);
  } catch {
    payStatus.textContent = "결제 확인에 실패했습니다.";
  } finally {
    payVerify.disabled = false;
  }
});
