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
const payCreate = document.getElementById("pay-create");
const payOrder = document.getElementById("pay-order");
const payAddress = document.getElementById("pay-address");
const payAmount = document.getElementById("pay-amount");
const payTx = document.getElementById("pay-tx");
const payVerify = document.getElementById("pay-verify");
const payResult = document.getElementById("pay-result");
const payKey = document.getElementById("pay-key");
const payStatus = document.getElementById("pay-status");
let payOrderId = null;

function openPayModal() {
  payOverlay.hidden = false;
  payStatus.textContent = "";
  payOrder.hidden = true;
  payResult.hidden = true;
  payTx.value = "";
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

payCreate?.addEventListener("click", async () => {
  payCreate.disabled = true;
  payStatus.textContent = "주문 생성 중…";
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
    payCreate.disabled = false;
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
    payKey.textContent = data.key;
    payOrder.hidden = true;
    payResult.hidden = false;
    payStatus.textContent = "결제가 확인되었습니다.";
  } catch {
    payStatus.textContent = "결제 확인에 실패했습니다.";
  } finally {
    payVerify.disabled = false;
  }
});
