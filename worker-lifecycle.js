export const HEARTBEAT_PORT_PREFIX = "aura-worker-heartbeat:";
export const DEFAULT_HEARTBEAT_SCOPE = "worker";
export const HEARTBEAT_ALARM_NAME = "aura-worker-heartbeat";
export const MIN_HEARTBEAT_CADENCE_MS = 30_000;
export const MAX_HEARTBEAT_CADENCE_MS = 5 * 60_000;
export const DEFAULT_HEARTBEAT_CADENCE_MS = 60_000;
export const MIN_HEARTBEAT_STALE_AFTER_MS = 60_000;
export const MAX_HEARTBEAT_STALE_AFTER_MS = 15 * 60_000;
export const DEFAULT_HEARTBEAT_STALE_AFTER_MS = 3 * DEFAULT_HEARTBEAT_CADENCE_MS;
export const MAX_HEARTBEAT_SCOPE_LENGTH = 48;

const HEARTBEAT_SCOPE_PATTERN = /^[A-Za-z0-9._-]+$/;
const ACTIVE_WORK_STATUS_SET = new Set([
  "queued",
  "pending",
  "starting",
  "preparing",
  "running",
  "active",
  "capturing",
  "recording",
]);

function normalizedScope(scope) {
  const value = typeof scope === "number" && Number.isInteger(scope)
    ? String(scope)
    : typeof scope === "string" ? scope.trim() : "";
  if (!value || value.length > MAX_HEARTBEAT_SCOPE_LENGTH || !HEARTBEAT_SCOPE_PATTERN.test(value)) {
    throw new Error("invalid-heartbeat-scope");
  }
  return value;
}

export function heartbeatPortName(scope = DEFAULT_HEARTBEAT_SCOPE) {
  return `${HEARTBEAT_PORT_PREFIX}${normalizedScope(scope)}`;
}

export function isHeartbeatPortName(value) {
  if (typeof value !== "string" || !value.startsWith(HEARTBEAT_PORT_PREFIX)) return false;
  try {
    normalizedScope(value.slice(HEARTBEAT_PORT_PREFIX.length));
    return true;
  } catch {
    return false;
  }
}

export function normalizeHeartbeatCadence(value = DEFAULT_HEARTBEAT_CADENCE_MS) {
  if (!Number.isFinite(value)) return DEFAULT_HEARTBEAT_CADENCE_MS;
  return Math.min(MAX_HEARTBEAT_CADENCE_MS, Math.max(MIN_HEARTBEAT_CADENCE_MS, Math.round(value)));
}

export function normalizeHeartbeatStaleAfter(value = DEFAULT_HEARTBEAT_STALE_AFTER_MS) {
  if (!Number.isFinite(value)) return DEFAULT_HEARTBEAT_STALE_AFTER_MS;
  return Math.min(
    MAX_HEARTBEAT_STALE_AFTER_MS,
    Math.max(MIN_HEARTBEAT_STALE_AFTER_MS, Math.round(value)),
  );
}

export function heartbeatStaleAfterMs(cadenceMs = DEFAULT_HEARTBEAT_CADENCE_MS) {
  return normalizeHeartbeatStaleAfter(normalizeHeartbeatCadence(cadenceMs) * 3);
}

export function heartbeatAlarmSpec(cadenceMs = DEFAULT_HEARTBEAT_CADENCE_MS) {
  const periodMs = normalizeHeartbeatCadence(cadenceMs);
  return {
    name: HEARTBEAT_ALARM_NAME,
    periodInMinutes: periodMs / 60_000,
  };
}

export function isHeartbeatStale(lastHeartbeatAt, {
  now = Date.now(),
  staleAfterMs = DEFAULT_HEARTBEAT_STALE_AFTER_MS,
} = {}) {
  if (!Number.isFinite(lastHeartbeatAt) || !Number.isFinite(now)) return true;
  return now - lastHeartbeatAt > normalizeHeartbeatStaleAfter(staleAfterMs);
}

function isActiveWorkItem(value) {
  if (value === true) return true;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (Array.isArray(value)) return value.some(isActiveWorkItem);
  if (!value || typeof value !== "object") return false;
  if (value.active === true || value.running === true || value.capturing === true || value.recording === true) {
    return true;
  }
  const status = typeof value.status === "string" ? value.status
    : typeof value.state === "string" ? value.state : "";
  return ACTIVE_WORK_STATUS_SET.has(status.trim().toLowerCase());
}

export function hasActiveWork(value) {
  return isActiveWorkItem(value);
}

export function shouldKeepWorkerAlive({
  activeDownloads,
  downloads,
} = {}) {
  const downloadWork = activeDownloads === undefined ? downloads : activeDownloads;
  return hasActiveWork(downloadWork);
}
