export const av19Regressions = Object.freeze([
  Object.freeze({
    id: "av19-level5-iframe-session",
    liveUrl: "https://av19t.com/bj/39141",
    recommendedAdblockMode: "on",
    settleMs: 15_000,
    expected: Object.freeze({
      primaryHost: "media.nnvivi.site",
      primaryPlayer: "level5",
      livePrimaryHostFlexible: true,
    }),
    candidates: Object.freeze([
      Object.freeze({
        pageTitle: "BJ 39141",
        pageUrl: "https://av19t.com/bj/39141",
        siteUrl: "https://av19t.com/bj/39141",
        resourceUrl: "https://metrics.example/assets/live.m3u8",
        frameId: 0,
        source: "performance",
        confidence: 35,
      }),
      Object.freeze({
        pageTitle: "BJ 39141",
        pageUrl: "https://p.nnvivi.site/embed/39141",
        siteUrl: "https://av19t.com/bj/39141",
        resourceUrl: "https://media.nnvivi.site/level5/master.m3u8?token=fixture-fresh",
        frameId: 7,
        source: "player-adapter",
        player: "level5",
        sessionId: "level5:fixture-1",
        confidence: 100,
      }),
    ]),
    frameStates: Object.freeze({
      0: Object.freeze({
        playing: false,
        muted: false,
        visibleArea: 0,
        viewportRatio: 0,
        durationMs: 0,
        topFrame: true,
      }),
      7: Object.freeze({
        playing: true,
        muted: false,
        visibleArea: 640_000,
        viewportRatio: 0.5,
        durationMs: 1_800_000,
        topFrame: false,
      }),
    }),
    frameLayouts: Object.freeze([
      Object.freeze({
        pageUrl: "https://p.nnvivi.site/embed/39141",
        viewportRatio: 0.5,
        adHint: false,
      }),
    ]),
  }),
]);
