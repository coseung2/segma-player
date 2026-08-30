# Site, provider, and downloader modules

The Aura browser connector separates three kinds of change so a failure on one
site does not immediately modify a shared media pipeline. Companion ownership
and migration direction are defined separately in `PRODUCT_DIRECTION.md`.

## Runtime layers

| Layer | Location | Responsibility |
| --- | --- | --- |
| Site profile | `sites/<id>/profile.js` | Thin declaration of expected modes plus diagnostic downloader/provider IDs |
| Site regression | `sites/<id>/regressions.js` | Deterministic and live-only fixtures owned by that site |
| Provider adapter | `providers/*.js` | Browser-side player/API/source evidence such as Dood or Level5 |
| Downloader ID | `downloaders/ids.js` | Diagnostic intent attached to candidates and Companion handoff policy |
| Companion | `native-host/` | Progressive, HLS, DASH, and YouTube execution plus durable state |

`sites/registry.js` is the runtime site registry. `providers/registry.js` selects a
provider using candidate evidence and the site's preferred provider order.
`download-policy.js` maps candidate media type and provider evidence to a
diagnostic downloader ID. The retained implementations under `downloaders/`
other than `ids.js` are legacy reference/test code and are not packaged.

## Download modes

| Mode | Downloader/provider response |
| --- | --- |
| `DIRECT_PROGRESSIVE` | Handoff intent for Companion progressive execution |
| `HLS_MANIFEST` | Handoff intent for Companion HLS execution |
| `DASH_MANIFEST` | Handoff intent for Companion DASH execution |
| `PLAYER_API` | A provider adapter refreshes the source, then handoff uses the observed media type |
| `PLAYER_PAGE_GRAPH` | The bounded player-page resolver produces a progressive or HLS candidate |
| `AUTHENTICATED_SOURCE_FRAME` | A provider policy preserves exact browser source evidence before handoff |
| `REMOTE_SERVICE` | Companion's separate YouTube command |
| `UNKNOWN` | No execution intent is selected |

## Site-local repair workflow

For a MissAV-only failure, inspect these files first:

1. `sites/missav/profile.js`
2. `sites/missav/regressions.js`
3. The provider selected by that profile, normally `providers/hlsjs.js` or
   `providers/player-api.js`
4. Companion HLS execution only when the same defect also reproduces on an
   unrelated site or a protocol-level fixture proves a common bug

A site profile must remain declarative. It must not contain HLS parsing, token
construction, key decoding, network fetches, or file writing.

## Adding or changing a site

1. Add or edit only `sites/<id>/profile.js` to declare the module order.
2. Add the reproduction to `sites/<id>/regressions.js`.
3. Add a provider adapter only when the player/API authentication mechanism is
   reusable across sites.
4. Change Companion transport only for a transport-level defect.
5. Run the focused site/provider/policy tests, the site-regression suite,
   the full suite, and the staging build.
6. Record live surfaces independently in `SITE_QA_LOG.md`.

`site-download-modes.json` and `media-site-regressions.json` are retained only as
compatibility pointers to the colocated JavaScript source of truth.
