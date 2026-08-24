// Exact structures observed on the live AVsee board page on 2026-08-24:
// https://01.avsee.is/bbs/board.php?bo_table=javmgs&wr_id=90512
//
// The page keeps only the board code in `<title>` ("MFC-361") and the full media
// title in the post body. The player is a same-origin `/player/player.php`
// iframe whose own title is the generic "AVseeTV player".
export const avseeRegressions = Object.freeze([
  Object.freeze({
    id: "avsee-javmgs-90512-progressive-in-player-iframe",
    liveUrl: "https://01.avsee.is/bbs/board.php?bo_table=javmgs&wr_id=90512",
    recommendedAdblockMode: "on",
    settleMs: 8_000,
    expected: Object.freeze({
      primaryHost: "cdn.apiavsee.com",
      primaryPlayer: "media-element",
    }),
    candidates: Object.freeze([
      Object.freeze({
        // The tab title, which is what the fix supplies for an iframe candidate.
        pageTitle: "MFC-361 さな - 사나",
        pageUrl: "https://01.avsee.is/player/player.php?720=http://cdn.apiavsee.com/h/2026/08/19/MFC-361.mp4",
        siteUrl: "https://01.avsee.is/bbs/board.php?bo_table=javmgs&wr_id=90512",
        resourceUrl: "https://cdn.apiavsee.com/h/2026/08/19/MFC-361.mp4",
        frameId: 1,
        source: "media-element",
        player: "media-element",
        sessionId: "media-element:1",
        confidence: 100,
        main: true,
      }),
    ]),
    frameStates: Object.freeze({
      1: Object.freeze({ playing: true, visible: true, mediaCount: 1 }),
    }),
  }),
]);

/// Title-resolution cases for this site, asserted by `avsee-title.test.mjs`.
///
/// Kept beside the site profile because the selectors and the player frame path
/// are site-local facts, not transport behaviour.
export const avseeTitleFixtures = Object.freeze([
  Object.freeze({
    id: "board-page-title-lives-in-the-post-body",
    documentTitle: "MFC-361",
    // First `h2` inside `div.view-content`, verified against the served HTML.
    bodyHtml: '<div itemprop="description" class="view-content"><h2>MFC-361 さな - 사나</h2><br>출연 : 泡白さな</div>',
    expectedTitle: "MFC-361 さな - 사나",
  }),
  Object.freeze({
    id: "document-title-is-kept-when-no-selector-matches",
    documentTitle: "MFC-361",
    bodyHtml: "<div class=\"other\"><p>no heading here</p></div>",
    expectedTitle: "MFC-361",
  }),
  Object.freeze({
    id: "a-heading-repeating-the-document-title-is-not-preferred",
    documentTitle: "MFC-361",
    bodyHtml: '<div class="view-content"><h2>MFC-361</h2></div>',
    expectedTitle: "MFC-361",
  }),
]);

/// The player iframe URL whose own document title must never win.
export const avseePlayerFrameUrl =
  "https://01.avsee.is/player/player.php?720=http://cdn.apiavsee.com/h/2026/08/19/MFC-361.mp4";
