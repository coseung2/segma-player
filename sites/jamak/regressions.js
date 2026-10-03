export const jamakRegressions = Object.freeze([
  Object.freeze({
    // User Chrome 0.4.82 path: default BS server (DoodStream/PlayMogo). The
    // token endpoint /pass_md5/ was promoted as the download and got 403.
    id: "jamak-gallery-83-dood-default-server",
    liveOnly: true,
    liveUrl: "https://www.jamak.cc/bbs/board.php?bo_table=gallery&wr_id=83&page=5",
    recommendedAdblockMode: "site-allow",
    settleMs: 25_000,
    activationSelector: "#videoOverlay",
    expected: Object.freeze({
      minimumCandidateCount: 1,
      requireNonAdvertisementPrimary: true,
      rejectedPrimaryPathPrefixes: Object.freeze(["/pass_md5/"]),
    }),
  }),
  Object.freeze({
    id: "jamak-gallery-83-streamtape-player-frame",
    liveUrl: "https://www.jamak.cc/bbs/board.php?bo_table=gallery&wr_id=83&page=5",
    recommendedAdblockMode: "site-allow",
    settleMs: 15_000,
    // The board defaults to Dood (BS); choose Streamtape (DT), then start playback.
    activationSelector: Object.freeze(["button.server-btn:has-text('DT')", "#videoOverlay"]),
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
