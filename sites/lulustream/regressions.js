export const lulustreamRegressions = Object.freeze([
  Object.freeze({
    id: "lulustream-browser-bound-master-hls",
    liveUrl: "https://luluvdo.com/e/1mq6hx0bz91y",
    recommendedAdblockMode: "on",
    settleMs: 10_000,
    expected: Object.freeze({
      primaryHost: "cdn1029.cdn-tnmr.org",
      primaryPlayer: "hlsjs",
      livePrimaryHostFlexible: true,
    }),
    candidates: Object.freeze([
      Object.freeze({
        pageTitle: "LuluStream sample",
        pageUrl: "https://luluvdo.com/e/1mq6hx0bz91y",
        siteUrl: "https://luluvdo.com/e/1mq6hx0bz91y",
        resourceUrl: "https://cdn1029.cdn-tnmr.org/hls2/fixture/master.m3u8?t=fixture&s=fixture&e=28800&f=fixture&i=0",
        contentType: "application/vnd.apple.mpegurl",
        frameId: 0,
        source: "player-adapter",
        player: "hlsjs",
        sessionId: "hlsjs:1",
        confidence: 100,
        main: true,
      }),
    ]),
    frameStates: Object.freeze({
      0: Object.freeze({ playing: true, visible: true, mediaCount: 1 }),
    }),
  }),
]);
