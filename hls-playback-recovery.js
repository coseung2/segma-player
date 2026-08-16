const FRAGMENT_NETWORK_FAILURES = new Set([
  "fragLoadError",
  "fragLoadTimeOut",
]);

const FRAGMENT_FAILURE_PREFIX = /^frag/i;

export function hlsPlaybackRecoveryDecision(value = {}) {
  const details = typeof value?.details === "string" ? value.details : "";
  const fatal = value?.fatal === true;

  if (!fatal && details === "aborted") {
    return Object.freeze({
      recover: false,
      alternate: false,
      classification: "nonfatal-internal-abort",
    });
  }

  if (FRAGMENT_NETWORK_FAILURES.has(details)) {
    return Object.freeze({
      recover: true,
      alternate: true,
      classification: "fragment-network-failure",
    });
  }

  if (fatal) {
    return Object.freeze({
      recover: true,
      alternate: FRAGMENT_FAILURE_PREFIX.test(details),
      classification: "fatal-hls-error",
    });
  }

  return Object.freeze({
    recover: false,
    alternate: false,
    classification: details ? "nonfatal-hls-error" : "unknown-hls-event",
  });
}
