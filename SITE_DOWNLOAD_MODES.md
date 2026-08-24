# Site, provider, and downloader modules

The Aura browser connector separates three kinds of change so a failure on one
site does not immediately modify a shared media pipeline. Companion ownership
and migration direction are defined separately in `PRODUCT_DIRECTION.md`.

## Runtime layers

| Layer | Location | Responsibility |
| --- | --- | --- |
| Site profile | `sites/<id>/profile.js` | Thin declaration of expected modes, primary/fallback downloader modules, and provider modules |
| Site regression | `sites/<id>/regressions.js` | Deterministic and live-only fixtures owned by that site |
| Provider adapter | `providers/*.js` | Player/API/token/source-frame behavior such as Dood or Level5 |
| Downloader | `downloaders/*.js` | Progressive, HLS, and DASH preparation/save orchestration |
| Shared engine | `hls-download.js`, protocol parsers, request-context modules | Bounded fetch, key/segment handling, checkpoints, file sinks, and common security rules |

`sites/registry.js` is the runtime site registry. `providers/registry.js` selects a
provider using candidate evidence and the site's preferred provider order.
`downloaders/registry.js` selects the actual transport from the candidate media
type. `download-policy.js` combines those decisions into one diagnostic policy.

## Download modes

| Mode | Downloader/provider response |
| --- | --- |
| `DIRECT_PROGRESSIVE` | `downloaders/progressive.js` |
| `HLS_MANIFEST` | `downloaders/hls.js` |
| `DASH_MANIFEST` | `downloaders/dash.js` |
| `PLAYER_API` | A provider adapter refreshes the source, then the observed media type selects a downloader |
| `PLAYER_PAGE_GRAPH` | The bounded player-page resolver produces a progressive or HLS candidate |
| `AUTHENTICATED_SOURCE_FRAME` | A provider policy preserves the exact source tab/frame; the media type still selects the downloader |
| `REMOTE_SERVICE` | Separate remote-service flow, currently YouTube |
| `UNKNOWN` | No downloader is selected |

## Site-local repair workflow

For a MissAV-only failure, inspect these files first:

1. `sites/missav/profile.js`
2. `sites/missav/regressions.js`
3. The provider selected by that profile, normally `providers/hlsjs.js` or
   `providers/player-api.js`
4. `downloaders/hls.js` only when the same HLS defect also reproduces on an
   unrelated site or a protocol-level fixture proves a common bug

A site profile must remain declarative. It must not contain HLS parsing, token
construction, key decoding, network fetches, or file writing.

## Adding or changing a site

1. Add or edit only `sites/<id>/profile.js` to declare the module order.
2. Add the reproduction to `sites/<id>/regressions.js`.
3. Add a provider adapter only when the player/API authentication mechanism is
   reusable across sites.
4. Change a downloader only for a transport-level defect.
5. Run the focused site/provider/downloader tests, the site-regression suite,
   the full suite, and the staging build.
6. Record live surfaces independently in `SITE_QA_LOG.md`.

`site-download-modes.json` and `media-site-regressions.json` are retained only as
compatibility pointers to the colocated JavaScript source of truth.
