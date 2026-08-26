export const recuRegressions = Object.freeze([
  Object.freeze({
    id: "recu-ellinrose-195409102-archive-hls",
    liveUrl: "https://recu.me/ellinrose/video/195409102/play",
    recommendedAdblockMode: "site-allow",
    settleMs: 15_000,
    expected: Object.freeze({
      primaryHost: "f62.mediafront.net",
    }),
    candidates: Object.freeze([
      Object.freeze({
        pageTitle: "ellinrose show from Chaturbate on 2026-08-23 23:29, #1 Webcam Archive – Recurbate",
        pageUrl: "https://recu.me/ellinrose/video/195409102/play",
        siteUrl: "https://recu.me/ellinrose/video/195409102/play",
        // Token-redacted deterministic fixture for the observed mediafront HLS
        // family. Transport behavior is covered by hls-download.test.mjs.
        resourceUrl: "https://f62.mediafront.net/hl/ellinrose/2026-08-23,21-24/media.m3u8?token=fixture",
        contentType: "application/vnd.apple.mpegurl",
        frameId: 0,
        source: "web-response",
        confidence: 90,
        main: true,
      }),
    ]),
    frameStates: Object.freeze({
      0: Object.freeze({ playing: true, visible: true, mediaCount: 1 }),
    }),
  }),
]);
