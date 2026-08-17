export const beegRegressions = Object.freeze([
  Object.freeze({
    id: "beeg-0211503327065170-live",
    liveOnly: true,
    liveUrl: "https://beeg.com/-0211503327065170",
    recommendedAdblockMode: "on",
    settleMs: 15_000,
    expected: Object.freeze({
      minimumCandidateCount: 1,
      requireNonAdvertisementPrimary: true,
    }),
  }),
]);
