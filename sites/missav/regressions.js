export const missavRegressions = Object.freeze([
  Object.freeze({
    id: "missav-simd-012-ad-iframe-priority",
    liveUrl: "https://missav123.com/ko/simd-012",
    recommendedAdblockMode: "site-allow",
    settleMs: 12_000,
    expected: Object.freeze({
      primaryHost: "surrit.com",
      rejectedAdvertisementHost: "ads.example",
    }),
    candidates: Object.freeze([
      Object.freeze({
        pageTitle: "Advertisement",
        pageUrl: "https://ads.example/preroll/frame",
        siteUrl: "https://missav123.com/ko/simd-012",
        resourceUrl: "https://ads.example/preroll/master.m3u8?token=fixture-ad",
        frameId: 2,
        source: "web-response",
        confidence: 90,
        main: true,
      }),
      Object.freeze({
        pageTitle: "SIMD-012",
        pageUrl: "https://missav123.com/ko/simd-012",
        siteUrl: "https://missav123.com/ko/simd-012",
        resourceUrl: "https://surrit.com/hls/simd-012/master.m3u8?token=fixture-feature",
        frameId: 0,
        source: "player-adapter",
        player: "hls.js",
        sessionId: "hls.js:fixture-1",
        confidence: 100,
      }),
    ]),
    frameStates: Object.freeze({
      0: Object.freeze({
        playing: true,
        muted: false,
        visibleArea: 921_600,
        viewportRatio: 0.7,
        durationMs: 2_700_000,
        topFrame: true,
      }),
      2: Object.freeze({
        playing: true,
        muted: true,
        visibleArea: 921_600,
        viewportRatio: 0.7,
        durationMs: 8_000,
        topFrame: false,
      }),
    }),
    frameLayouts: Object.freeze([
      Object.freeze({
        pageUrl: "https://ads.example/preroll/frame",
        viewportRatio: 0.7,
        adHint: true,
      }),
    ]),
  }),
  Object.freeze({
    id: "missav-docp-259-live",
    liveOnly: true,
    liveUrl: "https://missav123.com/dm31/ko/docp-259",
    recommendedAdblockMode: "site-allow",
    settleMs: 15_000,
    expected: Object.freeze({
      minimumCandidateCount: 1,
      requireNonAdvertisementPrimary: true,
    }),
  }),
]);
