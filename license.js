import { PRODUCT_EDITION } from "./edition.js";
import { productPlan } from "./product-plan.js";

export const LICENSE_STORAGE_KEY = "auraLicense";
export const LICENSE_API_URL = "https://aura.mdownloader.workers.dev/api/license";
const LICENSE_FETCH_TIMEOUT_MS = 12_000;

function normalizeKey(value) {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!/^[A-Za-z0-9-]{8,128}$/.test(key)) return null;
  return key.toUpperCase();
}

async function readStored() {
  try {
    const stored = await chrome.storage.local.get(LICENSE_STORAGE_KEY);
    const entry = stored?.[LICENSE_STORAGE_KEY];
    if (!entry || typeof entry !== "object") return null;
    if (typeof entry.key !== "string" || !entry.key) return null;
    return entry;
  } catch {
    return null;
  }
}

async function writeStored(entry) {
  try {
    await chrome.storage.local.set({ [LICENSE_STORAGE_KEY]: entry });
  } catch {
    // Storage is best effort; the resolved result still applies this session.
  }
}

async function fetchLicense(key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LICENSE_FETCH_TIMEOUT_MS);
  timer?.unref?.();
  try {
    const response = await fetch(`${LICENSE_API_URL}?key=${encodeURIComponent(key)}`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data && data.ok === true ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getStoredLicense() {
  return readStored();
}

export async function activateLicense(rawKey) {
  const key = normalizeKey(rawKey);
  if (!key) return { ok: false, error: "invalid-key" };
  const data = await fetchLicense(key);
  if (!data) return { ok: false, error: "license-server-unreachable" };
  if (data.status === "pending") return { ok: false, error: "license-pending", status: "pending" };
  if (data.edition !== "pro") return { ok: false, error: "license-not-approved" };
  await writeStored({
    key,
    edition: "pro",
    status: "approved",
    approvedAt: typeof data.approvedAt === "string" ? data.approvedAt : null,
  });
  return { ok: true, edition: "pro", status: "approved" };
}

export async function refreshLicense() {
  const stored = await readStored();
  if (!stored) return null;
  const data = await fetchLicense(stored.key);
  if (!data || data.edition !== "pro") return null;
  return stored;
}

export async function resolveEdition() {
  const stored = await readStored();
  return stored?.edition === "pro" ? "pro" : PRODUCT_EDITION;
}

export async function resolvePlan() {
  return productPlan(await resolveEdition());
}
