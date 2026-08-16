# Site QA Log

This is the versioned record of real site checks. It is separate from
deterministic unit tests and from `INCIDENTS.md`:

- `media-site-regressions.json` defines reusable site fixtures.
- `site-regression.test.mjs` checks deterministic ranking and detection rules.
- `scripts/live-media-smoke.mjs` checks a live page, candidate stability, and
  optional playback/progressive probes.
- This file records what was actually tested in a browser for a specific
  extension version, including download and subtitle results that the live
  smoke script does not cover.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `PASS` | The named surface passed for the stated browser, version, and mode. |
| `PARTIAL` | At least one surface passed, but another failed or was not run. |
| `FAIL` | The named surface was run and failed. |
| `BLOCKED` | The site, server, browser, extension, or access policy prevented a valid check. |
| `NOT_RUN` | No claim is made because that surface was not tested. |
| `UNKNOWN` | Historical evidence exists but did not capture the extension version or required context. |

## Required dimensions

Every new row must identify:

`date/time`, `extension version`, `browser/channel`, `site ID`, `surface`,
`AdBlock/VPN mode`, `status`, `failure code or short reason`, and an evidence
file or screenshot path.

Use these surface names consistently:

- `detect`: the media candidate appeared and the correct primary was selected.
- `playback`: the browser player could play the selected candidate.
- `progressive-probe`: the live smoke probe confirmed a usable progressive
  response. This is not proof that the extension saved the file.
- `extension-download`: the actual popup/detection-tab download completed and
  the file was verified.
- `subtitle`: the actual subtitle generation completed and the output file was
  verified.
- `overlay`: the job remained visible while moving between tabs.

## Current site coverage

The reusable fixture set currently contains:

| Site ID | Fixture purpose | Default AdBlock mode |
| --- | --- | --- |
| `missav-simd-012-ad-iframe-priority` | Reject the advertisement iframe and keep the playing stream primary | `site-allow` |
| `av19-level5-iframe-session` | Preserve the Level5 iframe session and token route | `on` |
| `asianporn-korean-bj-193189-live` | Live candidate detection and playback | `on` |
| `onlyjerk-rikakodesu-airi-minami-live` | Live candidate detection and playback | `on` |
| `playmogo-j8k8xq9gilty-live` | Site-allow detection and progressive probe | `site-allow` |
| `beeg-0211503327065170-live` | Live candidate detection and playback | `on` |

## Imported historical evidence

The reports below were already present locally from 2026-08-16. They predate
version-aware reporting, so their extension version is intentionally recorded
as `UNKNOWN`; do not treat them as proof for `0.3.70` or any later version.

| Site ID | Historical result | Evidence | What remains unverified |
| --- | --- | --- | --- |
| `missav-simd-012-ad-iframe-priority` | `PARTIAL`: detection passed in the all-site/assisted runs; the latest playback-fixed run failed with `playback-failed` | `artifacts/live-media-all-auto.json`, `artifacts/live-media-missav-playback-fixed.json` | Versioned Chrome download, subtitle, and current playback |
| `av19-level5-iframe-session` | `PARTIAL`: detection passed in headed/all-site runs; the latest playback-fixed run failed with `playback-failed` | `artifacts/live-media-all-auto.json`, `artifacts/live-media-av19-playback-fixed.json` | Versioned Chrome download, subtitle, and current playback |
| `asianporn-korean-bj-193189-live` | `PASS` for the recorded live detection/playback smoke run | `artifacts/live-media-asianporn-playback-headless.json` | Versioned extension download and subtitle |
| `onlyjerk-rikakodesu-airi-minami-live` | `PASS` for the recorded fixed playback smoke run | `artifacts/live-media-onlyjerk-playback-fixed.json` | Versioned extension download and subtitle |
| `playmogo-j8k8xq9gilty-live` | `PARTIAL`: detection passed in assisted/all-site runs; progressive-size probes remained unknown | `artifacts/live-media-all-auto.json`, `artifacts/live-media-playmogo-playback-headless.json` | Versioned Chrome download, subtitle, and progressive save |
| `beeg-0211503327065170-live` | `PARTIAL`: fixed playback run passed while headless/adblock-off runs failed; treat as profile-dependent | `artifacts/live-media-beeg-playback-fixed.json`, `artifacts/live-media-beeg-playback-headless.json` | Versioned Chrome download and subtitle |

These historical rows are a baseline, not a release sign-off. The report JSON
files under `artifacts/` are local evidence and are ignored by Git; the
summary above is the durable record of what they showed.

## 2026-08-17 02:36 KST — v0.3.71 live smoke

- Browser/channel: Chrome, headless (`browserChannel=chrome`, `headless=true`)
- AdBlock/VPN mode: `not-loaded`
- Test scope: live detection, candidate selection, playback when available,
  and progressive probe when applicable
- Overall result: `FAIL` (2 sites passed, 4 sites had a failed surface)
- Evidence: `artifacts/live-media-0.3.71-20260816T173353Z.json`
- Extension download, subtitle, and tab-overlay surfaces: `NOT_RUN`
- Incident: no new incident opened from this smoke run; failures remain
  site/environment observations until reproduced in the real user path

| Site ID | Overall | Surface results | Observation |
| --- | --- | --- | --- |
| `missav-simd-012-ad-iframe-priority` | `PARTIAL` | detect `PASS`; playback `FAIL`; progressive/download/subtitle `NOT_RUN` | 23 candidates; playback ended as `playback-failed` |
| `av19-level5-iframe-session` | `PARTIAL` | detect `PASS`; playback `FAIL`; progressive/download/subtitle `NOT_RUN` | 2 candidates; playback ended as `playback-failed` |
| `asianporn-korean-bj-193189-live` | `PARTIAL` | detect `PASS`; progressive-probe `FAIL`; playback/download/subtitle `NOT_RUN` | 31 candidates; response classified as media but was `progressive-too-small` |
| `onlyjerk-rikakodesu-airi-minami-live` | `PASS` for smoke scope | detect `PASS`; playback `PASS`; progressive/download/subtitle `NOT_RUN` | 5 candidates; `downloadable-primary-detected` |
| `playmogo-j8k8xq9gilty-live` | `PARTIAL` | detect `PASS`; progressive-probe `FAIL`; playback/download/subtitle `NOT_RUN` | 2 candidates; authenticated probe returned HTTP 405 and size was unknown |
| `beeg-0211503327065170-live` | `PASS` for smoke scope | detect `PASS`; playback `PASS`; progressive/download/subtitle `NOT_RUN` | 2 candidates; `downloadable-primary-detected` |

This run is a versioned smoke result, not a claim that all six sites support
the complete extension workflow. The next real-browser QA pass must test
`extension-download`, `subtitle`, and `overlay` separately for `0.3.71`.

## 2026-08-17 02:46 KST — v0.3.71 DOCP-259 reproduction

- Browser/channel: Chrome, headed and headless comparison
- Site ID: `missav-docp-259-live`
- AdBlock/VPN mode: `site-allow`
- Surfaces:
  - detect: `PASS` — 3 candidates; the selected primary was an HLS stream on `surrit.com`
  - playback: `FAIL` — manifest HTTP 200, first `video0.jpeg` fragment HTTP 403; `fragLoadError`
  - progressive-probe: `NOT_RUN`
  - extension-download: `NOT_RUN`
  - subtitle: `NOT_RUN`
  - overlay: `NOT_RUN`
- Evidence: `artifacts/live-media-0.3.71-20260816T174528Z.json`
- Incident: `INC-2026-08-17-006`
- Notes: headed and headless live runs reproduced the same server response. The
  player was not marked supported just because the manifest was detected.

## Append-only run record

Add one entry after every real site check. Do not overwrite an old result when
the same site changes behavior in a new version.

```text
### YYYY-MM-DD HH:mm KST — vX.Y.Z

- Browser/channel: Chrome 136 / Whale / headed or headless
- Site ID: `fixture-id`
- AdBlock/VPN mode: on / off / site-allow / unknown
- Surfaces:
  - detect: PASS | FAIL | BLOCKED | NOT_RUN — reason
  - playback: PASS | FAIL | BLOCKED | NOT_RUN — reason
  - progressive-probe: PASS | FAIL | BLOCKED | NOT_RUN — reason
  - extension-download: PASS | FAIL | BLOCKED | NOT_RUN — reason
  - subtitle: PASS | FAIL | BLOCKED | NOT_RUN — reason
  - overlay: PASS | FAIL | BLOCKED | NOT_RUN — reason
- Evidence: `path/to/report.json`, screenshot, or downloaded filename
- Incident: `INC-YYYY-MM-DD-NNN` or `none`
- Notes: environment, reproducibility, and next check
```

## New site procedure

1. Add a stable `id`, live URL, expected behavior, and recommended AdBlock mode
   to `media-site-regressions.json`.
2. Add or update the deterministic fixture assertions in
   `site-regression.test.mjs`.
3. Run the live smoke check and save its report with a unique filename that
   includes the extension version and browser mode.
4. Test the actual extension download and subtitle path separately; mark
   untested surfaces `NOT_RUN` rather than inferring success from detection.
5. Append the result here and add an incident entry when a failure is a code or
   environment regression.
6. On later versions, append a new row and compare against the previous version
   before changing code. Keep both the pass and the regression evidence.

## Release gate

A site is not considered supported for a release merely because its fixture
test passes. For each supported site, the release review must show the target
version and browser for `detect`, `extension-download`, and `subtitle`; add
`playback` and `overlay` when those surfaces are in scope. Missing evidence is
`NOT_RUN`, not `PASS`.

### 2026-08-17 03:18 KST — v0.3.72

- Browser/channel: Chrome, headless Playwright cache
- Site ID: `missav-docp-259-live`
- AdBlock/VPN mode: `site-allow`
- Surfaces:
  - detect: PASS — primary remained an HLS candidate on `surrit.com`
  - playback: FAIL — first `surrit.com` fragment changed from 403 to 200, but HLS ended with `aborted`, `readyState=0`
  - progressive-probe: NOT_RUN
  - extension-download: NOT_RUN
  - subtitle: NOT_RUN
  - overlay: NOT_RUN
- Evidence: `artifacts/live-media-0.3.72-docp-259-after-loader-fix.json`
- Incident: `INC-2026-08-17-006`
- Notes: loader-context fix removed the observed fragment 403; actual playback remained unverified.

### 2026-08-17 03:22 KST — v0.3.72

- Browser/channel: Chrome, headless Playwright cache
- Site ID: `missav-docp-259-live`
- AdBlock/VPN mode: `site-allow`
- Surfaces:
  - detect: PASS — primary remained an HLS candidate on `surrit.com`
  - playback: FAIL — fragment HTTP 200, HLS `aborted`, `readyState=0`
  - progressive-probe: NOT_RUN
  - extension-download: NOT_RUN
  - subtitle: NOT_RUN
  - overlay: NOT_RUN
- Evidence: `artifacts/live-media-0.3.72-docp-259-after-loader-baseline.json`
- Incident: `INC-2026-08-17-006`
- Notes: restoring the committed HLS start order did not produce a playable frame.

### 2026-08-17 03:26 KST — v0.3.73

- Browser/channel: Chrome, headless Playwright cache
- Site ID: `missav-docp-259-live`
- AdBlock/VPN mode: `site-allow`
- Surfaces:
  - detect: PASS — primary and alternate HLS candidates were present on `surrit.com`
  - playback: FAIL — primary/alternate recovery did not reach `readyState>=2`; observed fragment HTTP 200 and HLS `aborted`
  - progressive-probe: NOT_RUN
  - extension-download: NOT_RUN
  - subtitle: NOT_RUN
  - overlay: NOT_RUN
- Evidence: `artifacts/live-media-0.3.73-docp-259-after-alternate.json`
- Incident: `INC-2026-08-17-006`
- Notes: one-shot alternate recovery was exercised; no successful playback evidence.

### 2026-08-17 03:29 KST — v0.3.74

- Browser/channel: Chrome, headless Playwright cache
- Site ID: `missav-docp-259-live`
- AdBlock/VPN mode: `site-allow`
- Surfaces:
  - detect: PASS — primary and alternate HLS candidates were present on `surrit.com`
  - playback: FAIL — fragment HTTP 200, HLS `aborted`, `readyState=0`; no successful frame
  - progressive-probe: NOT_RUN
  - extension-download: NOT_RUN
  - subtitle: NOT_RUN
  - overlay: NOT_RUN
- Evidence: `artifacts/live-media-0.3.74-docp-259-after-alternate-tab-fix.json`
- Incident: `INC-2026-08-17-006`
- Notes: alternate selection now falls back to the candidate tab ID when the player payload omits it; live playback remains unverified.

### 2026-08-17 04:13 KST — v0.3.75 old-playback-compatibility A/B

- Browser/channel: Chrome, headed Playwright Chromium
- Site ID: `missav-docp-259-live`
- AdBlock/VPN mode: `site-allow`
- Surfaces:
  - detect: PASS — primary HLS candidate was present on `surrit.com`
  - playback: FAIL — manifest HTTP 200, first fragment HTTP 403, HLS `fragLoadError`, `readyState=0`
  - progressive-probe: NOT_RUN
  - extension-download: NOT_RUN
  - subtitle: NOT_RUN
  - overlay: NOT_RUN
- Evidence: `artifacts/live-media-0.3.75-docp-259-old-compat.json`
- Incident: `INC-2026-08-17-006`
- Notes: restoring the 0.3.54 HLS start order and playlist loader did not change the provider-side fragment rejection.

### 2026-08-17 04:15 KST — v0.3.54 package recheck

- Browser/channel: Chrome, headed Playwright Chromium
- Site ID: `missav-docp-259-live`
- AdBlock/VPN mode: `site-allow`
- Surfaces:
  - detect: PASS — primary HLS candidate was present on `surrit.com`
  - playback: FAIL — manifest HTTP 200, first fragment HTTP 403, HLS `fragLoadError`, `readyState=0`
  - progressive-probe: NOT_RUN
  - extension-download: NOT_RUN
  - subtitle: NOT_RUN
  - overlay: NOT_RUN
- Evidence: `C:\Users\coseung2\AppData\Local\Temp\aura-mdownloader-054\artifacts\live-media-0.3.54-docp-259-package.json`
- Incident: `INC-2026-08-17-006`
- Notes: the actual 0.3.54 package fails under the same current URL and browser conditions, so the failure is not isolated to the latest extension source.
