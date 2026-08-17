export const playmogoRegressions = Object.freeze([
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
