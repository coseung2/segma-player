export const playmogoRegressions = Object.freeze([
  Object.freeze({
    id: "playmogo-0p6sbp4xtvw1-dood-frame-replacement",
    liveOnly: true,
    liveUrl: "https://playmogo.com/d/0p6sbp4xtvw1",
    recommendedAdblockMode: "site-allow",
    settleMs: 15_000,
    expected: Object.freeze({
      minimumCandidateCount: 1,
      requireNonAdvertisementPrimary: true,
    }),
  }),
  Object.freeze({
    id: "playmogo-j8k8xq9gilty-live",
    liveOnly: true,
    liveUrl: "https://playmogo.com/d/j8k8xq9gilty",
    recommendedAdblockMode: "site-allow",
    settleMs: 15_000,
    expected: Object.freeze({
      minimumCandidateCount: 1,
      requireNonAdvertisementPrimary: true,
      rejectedPrimaryPathPrefixes: Object.freeze([
        "/cdn-cgi/challenge-platform/",
        "/favicon.ico",
      ]),
    }),
  }),
]);
