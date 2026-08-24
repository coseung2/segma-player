# Media module refactor plan

> [!NOTE]
> Historical plan completed in 0.3.89. The resulting browser-side module
> boundary remains documented in `SITE_DOWNLOAD_MODES.md`; this file is not the
> current product roadmap.

## Goal

Make a site-local regression repairable without first editing the common media
pipeline. Sites declare module selection; providers implement reusable player or
authentication behavior; downloaders implement transport behavior.

## Boundaries

1. **Site profiles — `sites/<id>/profile.js`**
   - Hosts and top-level site identity
   - Expected mode order
   - Primary/fallback downloader IDs
   - Preferred provider IDs
   - No fetch, parser, token, key, or file code
2. **Site regressions — `sites/<id>/regressions.js`**
   - Deterministic and live-only reproductions for that site
3. **Providers — `providers/*.js`**
   - Reusable player/API/source-frame behavior
   - Current providers: Dood, Level5, hls.js, structured player API
4. **Downloaders — `downloaders/*.js`**
   - Progressive, HLS, and DASH preparation/save orchestration
5. **Shared engine**
   - Request context, bounded fetches, keys, segments, checkpoints, sinks, and
     protocol parsers shared by more than one downloader

## Execution flow

```text
candidate + top-level site URL
  -> sites/registry.js
  -> providers/registry.js
  -> download-policy.js
  -> downloaders/registry.js
  -> selected transport module
  -> shared bounded media capabilities
```

Candidate diagnostics retain `siteId`, `providerId`, `downloadMode`, and
`downloaderId`. The top-level tab URL is stored separately from the iframe
referrer so an external player frame remains attributable to the original site.

## Repair decision

- One site fails: change `sites/<id>/` first.
- One player/provider fails across sites: change `providers/<provider>.js`.
- Progressive/HLS/DASH fails across unrelated sites: change the corresponding
  `downloaders/<transport>.js` or shared protocol code.
- Do not add transport implementation to a site profile.

## Migration completed in 0.3.89

- Added runtime site profiles and registry.
- Added provider registry and isolated Dood source-frame policy.
- Added progressive/HLS/DASH downloader registry and moved high-level dispatch
  out of the monolithic media engine.
- Colocated MissAV, AV19, and live target regressions under their site folders.
- Preserved compatibility pointers for the former shared JSON registries.
- Added DASH CENC/ContentProtection fail-closed handling for GitHub issue #2.

## Validation contract

Before handoff:

1. Site/profile/provider/downloader focused tests
2. `npm run test:media-sites`
3. Full `npm test`
4. Pro staging build
5. `git diff --check`
6. Real browser checks remain `LIVE-UNVERIFIED` until explicitly run
