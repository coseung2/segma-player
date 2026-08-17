export function providerSignals(candidate = {}) {
  const evidence = Array.isArray(candidate?.evidence) ? candidate.evidence : [];
  return [
    candidate?.player,
    candidate?.detectionSource,
    ...evidence.flatMap((item) => [item?.player, item?.source]),
  ].map((value) => String(value || "").toLowerCase());
}

export function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}
