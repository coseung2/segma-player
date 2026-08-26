export const jamakRegressions = Object.freeze([
  Object.freeze({
    id: "jamak-gallery-83-streamtape-player-frame",
    liveUrl: "https://www.jamak.cc/bbs/board.php?bo_table=gallery&wr_id=83&page=5",
    recommendedAdblockMode: "site-allow",
    settleMs: 15_000,
    expected: Object.freeze({
      primaryHost: "streamtape.com",
      primaryPlayer: "streamtape",
    }),
    candidates: Object.freeze([
      Object.freeze({
        pageTitle: "FC2-PPV-1788676 한글자막",
        pageUrl: "https://streamtape.com/e/2PXX3pz824FZg6X",
        siteUrl: "https://www.jamak.cc/bbs/board.php?bo_table=gallery&wr_id=83&page=5",
        resourceUrl: "https://streamtape.com/get_video?id=fixture&expires=1787658444&token=fixture",
        contentType: "video/mp4",
        frameId: 2116,
        source: "player-page-resolver",
        player: "streamtape",
        confidence: 100,
        main: true,
      }),
    ]),
    frameStates: Object.freeze({
      2116: Object.freeze({ playing: true, visible: true, mediaCount: 1 }),
    }),
  }),
]);
