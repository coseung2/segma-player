# Site download mode matrix

Sites are classified by the observed download mechanism before a site-specific fix is considered. The classifier is evidence-first: host names are used for reporting, while runtime mode selection comes from the candidate media type and player evidence.

## Modes

| Mode | Detection signal | Download response |
| --- | --- | --- |
| `DIRECT_PROGRESSIVE` | `PROGRESSIVE` candidate from a direct media response/element | Range download, then browser-download fallback when needed |
| `HLS_MANIFEST` | `HLS_MASTER`/`HLS_MEDIA` without a protected player context | Playlist, key, and segment saver |
| `DASH_MANIFEST` | `DASH` candidate | MPD and segment saver |
| `PLAYER_API` | `api-json`, fetch, or XHR player evidence | Refresh source from the API/player context, then use its media mode |
| `PLAYER_PAGE_GRAPH` | bounded `/d/` or `/e/` player-page URL | Resolve the player graph before downloading |
| `AUTHENTICATED_SOURCE_FRAME` | Level5/Dood/player-frame evidence, tokenized source, exact frame context | Refresh from the source frame and preserve its request context |
| `REMOTE_SERVICE` | YouTube page/resource | Use the configured remote YouTube job flow |
| `UNKNOWN` | No safe classification | Do not add a site-specific bypass; capture evidence first |

## Current site map

The machine-readable registry is [site-download-modes.json](site-download-modes.json). Current user-reported status is deliberately separate for download and browser playback:

- AsianPorn: direct progressive; download and browser playback pass.
- MissAV: HLS/player source; download pass, browser playback fail.
- AV19: protected Level5 HLS/source-frame; download pass, browser playback fail.
- OnlyJerk: structured player API to HLS; download pass, browser playback fail.
- Beeg: direct progressive; download pass, browser playback fail.
- Dood: authenticated/player-frame path; Aura browser playback passes, extension-download failed on `0.3.86`; `0.3.87` source-frame fix is live-unverified.

## Adding a site

1. Capture the first usable candidate and its evidence: media type, source, player, session, frame, request type, and whether the URL is tokenized.
2. Assign one primary mode and at most two fallback modes in `site-download-modes.json`.
3. Add a deterministic fixture or live-only target with the mode expectation.
4. Run the separate surfaces: detect, extension-download, browser playback, progressive probe, subtitle, and overlay. Use `NOT_RUN` when a surface was not tested.
5. Add an append-only `SITE_QA_LOG.md` entry before calling the site supported.

Do not add a host-specific URL exception when a generic mode classifier or existing response/player evidence can express the behavior safely.
