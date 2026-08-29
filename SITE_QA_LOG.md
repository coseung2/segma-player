# Site QA Log

This is the versioned record of real site checks. It is separate from
deterministic unit tests and from `INCIDENTS.md`:

- `sites/<id>/regressions.js` defines reusable fixtures beside each site profile.
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

1. Add a thin module declaration in `sites/<id>/profile.js`.
2. Add a stable fixture id, live URL, expected behavior, and recommended AdBlock
   mode in `sites/<id>/regressions.js`; the shared regression runner discovers it
   through `sites/regressions.js`.
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

### 2026-08-17 06:12 KST — v0.3.76 request-context and detection validation

- Browser/channel: headed Playwright Chromium ARM64 under Xvfb
- AdBlock/VPN mode: fixture recommendation through `--adblock=auto`; the local Aura AdBlock checkout lacked packaged icons, so a test-only copy supplied those static icons before loading the same runtime source
- Test scope: live detection, candidate selection, progressive probe, Aura playback, native-page playback snapshot, challenge/access-restriction classification, and redacted media-request diagnostics
- Report status: `BLOCKED` for all seven cases in this server environment; no case is recorded as a confirmed product failure from this run
- Evidence: `artifacts/live-media-0.3.76-final-headed.json`
- Extension download, subtitle, and overlay surfaces: `NOT_RUN`

| Site ID | Overall | Surface results | Observation |
| --- | --- | --- | --- |
| `missav-simd-012-ad-iframe-priority` | `BLOCKED` | detect/playback/download/subtitle/overlay `NOT_RUN` | Top-level navigation returned HTTP 403 with a visible Cloudflare challenge |
| `av19-level5-iframe-session` | `BLOCKED` | detect/playback/download/subtitle/overlay `NOT_RUN` | Outer page loaded, but the Level5 iframe displayed a Korean access-restriction page |
| `asianporn-korean-bj-193189-live` | `BLOCKED` | detect `PASS`; progressive-probe `PASS`; playback `BLOCKED`; download/subtitle/overlay `NOT_RUN` | Authenticated range probe confirmed 101,508,754 bytes; ARM64 Chromium could not decode the media and returned media error 4 |
| `onlyjerk-rikakodesu-airi-minami-live` | `BLOCKED` | detect `PASS`; playback `BLOCKED`; progressive/download/subtitle/overlay `NOT_RUN` | The new bounded JSON API observer found the actual HLS source; manifest requests returned HTTP 200, then hls.js reported `manifestIncompatibleCodecsError` in the ARM64 test browser |
| `playmogo-j8k8xq9gilty-live` | `BLOCKED` | detect/playback/progressive/download/subtitle/overlay `NOT_RUN` | The previous RUM/CSS/font/player-page false candidates were removed; the embedded player currently shows a visible Turnstile/captcha challenge |
| `missav-docp-259-live` | `BLOCKED` | detect/playback/download/subtitle/overlay `NOT_RUN` | Top-level navigation returned HTTP 403 with a visible Cloudflare challenge, so the user-reported player-only failure could not be reproduced from this server |
| `beeg-0211503327065170-live` | `BLOCKED` | detect `PASS`; progressive-probe `PASS`; playback `BLOCKED`; download/subtitle/overlay `NOT_RUN` | Authenticated range probe confirmed 102,237,763 bytes. Request diagnostics selected the exact observed context and replayed the recorded Referer, Accept-Language, and Cookie header names; ARM64 Chromium returned media error 4 |

This run distinguishes environment blocks from product failures. Scheduled monitoring may use `AURA_MONITOR_ALLOW_BLOCKED=1` so a report containing only explicit `BLOCKED` results uploads evidence without marking the workflow as a product regression; `rawOk` remains false in the JSON. A release still requires a Windows Chrome/Whale pass for the named user surfaces.

#### User-observed MissAV baseline for v0.3.75 and earlier

- Browser/channel: user Chrome environment; exact build artifact not captured in this log
- Site ID: `missav-docp-259-live`
- Surfaces:
  - native site playback: `PASS`
  - detect: `PASS`
  - extension-download: `PASS`
  - Aura playback: `FAIL`
  - subtitle: `NOT_RUN`
  - overlay: `NOT_RUN`
- Evidence: direct user observation, no attached report artifact
- Incident: `INC-2026-08-17-006`
- Notes: this is the primary reproduction contract for 0.3.76 user-side verification. It narrows the issue to Aura Player request/media processing rather than a provider-wide outage, but it is not release proof without a versioned report.

### 2026-08-17 14:22 KST — v0.3.76 local Windows live recheck

- Browser/channel: headed Playwright Chromium cache on Windows; installed Chrome 151 was also checked but rejected command-line unpacked-extension loading (`extension-workers-unavailable`)
- AdBlock/VPN mode: Aura AdBlock loaded from `C:\Users\coseung2\Desktop\Projects\aura-vpn\adblock-extension`; per-fixture `auto` mode
- Test scope: seven configured live targets with `--headed --autoplay`; detection, native-page playback snapshot, Aura playback where candidate evaluation allowed it, and progressive probe where applicable
- Report status: `FAIL` for the av19 detection path; other failures are recorded as `BLOCKED` or `INCONCLUSIVE` environment/network outcomes, not resolved product passes
- Evidence: `artifacts/live-media-0.3.76-20260817T042032Z.json`, `artifacts/live-media-0.3.76-retry-av19.json`, `artifacts/live-media-0.3.76-retry-onlyjerk.json`, `artifacts/live-media-0.3.76-retry-beeg.json`
- Deterministic validation before live run: `test:media-sites` 16/16, `npm test` 398/398

| Site ID | Overall | Surface results | Failure reason / observation |
| --- | --- | --- | --- |
| `missav-simd-012-ad-iframe-priority` | `BLOCKED` | detect `NOT_RUN`; playback/download/subtitle/overlay `NOT_RUN` | headed navigation returned `ERR_CONNECTION_RESET` |
| `av19-level5-iframe-session` | `FAIL` | native-page playback `PASS`; detect `FAIL`; Aura playback/download/subtitle/overlay `NOT_RUN` | Level5 iframe video was actually playing (`readyState=4`, `currentTime≈13.5s`, `1080x460`, HTTP 206), but the extension selected `k.vdnext.com/.../thumbs.vtt` as `PROGRESSIVE` primary with empty player metadata instead of the Level5 HLS candidate |
| `asianporn-korean-bj-193189-live` | `INCONCLUSIVE` | detect `PASS`; progressive-probe `FAIL`; playback/download/subtitle/overlay `NOT_RUN` | extension-authenticated probe returned a network error and no size; no product failure isolated |
| `onlyjerk-rikakodesu-airi-minami-live` | `BLOCKED` | detect/playback/download/subtitle/overlay `NOT_RUN` | repeated headed navigation `ERR_CONNECTION_RESET` |
| `playmogo-j8k8xq9gilty-live` | `BLOCKED` | detect/playback/download/subtitle/overlay `NOT_RUN` | navigation redirected to `example.com`; no candidate; the separate progressive-probe retry was stopped after an unbounded extension message wait |
| `missav-docp-259-live` | `BLOCKED` | detect/playback/download/subtitle/overlay `NOT_RUN` | Cloudflare HTTP 403/challenge remained after the configured 90-second headed wait |
| `beeg-0211503327065170-live` | `BLOCKED` | detect/playback/download/subtitle/overlay `NOT_RUN` | repeated headed navigation `ERR_CONNECTION_RESET` |

The av19 result is a confirmed current live detection regression and remains the actionable product issue. No extension-download or subtitle surface passed in this run; no release or `RESOLVED` claim is justified until the Windows Chrome/Whale user path is retested after the candidate-ranking fix.

### 2026-08-17 14:28 KST — v0.3.77 av19 text-track regression recheck

- Browser/channel: headed Playwright Chromium cache on Windows
- AdBlock/VPN mode: Aura AdBlock `on`
- Site ID: `av19-level5-iframe-session`
- Surfaces:
  - native-page playback: `PASS` — Level5 iframe video `readyState=4`, `currentTime≈14.3s`, `1080x460`, error code 0
  - detect: `FAIL` — candidate count 0; the previous `k.vdnext.com/.../thumbs.vtt` primary false-positive no longer appears
  - Aura playback: `NOT_RUN` — no candidate was available to create a playback session
  - progressive-probe: `NOT_RUN`
  - extension-download: `NOT_RUN`
  - subtitle: `NOT_RUN`
  - overlay: `NOT_RUN`
- Evidence: `artifacts/live-media-0.3.77-retry-av19.json`
- Deterministic validation: focused candidate tests 22/22, `npm test` 399/399, `test:media-sites` 16/16
- Status: `CODE-FIXED / LIVE-UNVERIFIED`; text-track false-positive fixed, but the current live frame still does not expose a selectable Level5 HLS candidate.

### 2026-08-17 — provider drift conclusion and daily QA response

- Conclusion: the prior known-good av19 evidence had native playback plus two candidates, including a Level5 HLS primary; the current run had native playback but zero candidates. The current evidence therefore indicates a changing provider/player source exposure path, not a proven extension-wide detection regression.
- Do not treat a single live URL run as a stable contract. Keep the text-track false-positive guard, but do not add provider-specific URL rules from this observation alone.
- Daily response matrix:

| Signal | Classification | Action |
| --- | --- | --- |
| Native playback `PASS`, detect `PASS`, download/subtitle untested | Partial provider check | Record only the tested surfaces; keep other surfaces `NOT_RUN` |
| Native playback `PASS`, detect `0` on both main and candidate | Provider/source drift candidate | Capture redacted network/source diagnostics; do not patch immediately |
| Native playback `PASS`, main detect/download `PASS`, candidate detect/download `FAIL` | Product regression candidate | Run focused code diff and open/update an incident |
| Native playback `PASS`, candidate detect `FAIL`, source host/path/content type changed | Provider drift likely | Update fixture evidence and wait for a second confirmation |
| Cloudflare, connection reset, codec, or access restriction | Environment/provider block | Keep `BLOCKED` and exclude from product regression counts |

- Required canary procedure: run the known-good main artifact and the candidate artifact against the same URL, browser/channel, AdBlock/VPN mode, and time window; compare native playback, candidate count/primary metadata, manifest host, and redacted request diagnostics.
- Adapter policy: prefer bounded generic player-source and manifest-MIME evidence, reject text tracks/static assets, and avoid fixed provider URLs, DOM selectors, or unbounded page parsing.
- Promotion gate: require deterministic tests plus one main-vs-candidate live A/B pass for the named surface; require a second live observation before marking a provider-drift hypothesis as a code regression.

### 2026-08-17 15:06 KST — AV19 97526 user Chrome recheck

- Browser/channel: user's headed Chrome session; exact loaded extension version was not independently visible through the browser bridge
- AdBlock/VPN mode: not independently captured
- Site ID: `av19-level5-iframe-session` (`https://av19t.com/korea/97526`)
- Surfaces:
  - native-page playback: `PASS` — visible video playing inside the cross-origin `p.nnvivi.site/player.php` iframe
  - detect: `FAIL` — the extension produced a candidate/job for the page, but the selected result completed as `0 MB`
  - progressive-probe: `NOT_RUN`
  - extension-download: `FAIL` — overlay reported `다운로드를 완료했습니다 (0 MB)`
  - subtitle: `NOT_RUN`
  - overlay: `PASS` — download overlay was visible on the source page
- Evidence: `artifacts/live-media-av19-97526-user-chrome-20260817.png`; top-frame inspection found 12 `k.vdnext.com/.../preview.gif` thumbnail videos, all `readyState=0`, `0x0`, paused; the actual player is the cross-origin iframe
- Interpretation: this confirms a wrong/empty media selection symptom, but the exact selected resource URL was not exposed by the current bridge. Do not attribute it to the filtered `preview.gif` thumbnails without candidate metadata; retest after reloading the current extension and capture the candidate URL plus probe result.

### 2026-08-17 15:12 KST — candidate diagnostics staged for AV19 retest

- Staging version: `0.3.78`
- Change: media download jobs now expose token-redacted candidate metadata through `#aura-media-progress-host[data-aura-qa-candidates]`
- Captured fields: candidate `host/path`, media type, frame, player/session/source metadata, request type, main flag, and score
- Live result: `NOT_RUN` pending reload of the staging extension and a fresh AV19 97526 download attempt

### 2026-08-17 15:16 KST — persistent candidate diagnostics adjustment

- Staging version: `0.3.79`
- Adjustment: candidate diagnostics are now also retained on `document.documentElement.dataset.auraQaCandidates` after the visible overlay expires
- Live result: `NOT_RUN` pending reload of staging and a fresh AV19 97526 attempt

### 2026-08-17 15:18 KST — AV19 97526 candidate trace

- Staging version under test: `0.3.79`
- Candidate trace: `https://cdn.plyr.io/static/blank.mp4` (query redacted), `PROGRESSIVE`, `main=true`, `frameId=164`, `source=web-response`, `score=67`
- Failure: the Plyr blank placeholder became the primary candidate and completed as `0 MB`
- Native-page playback: `PASS`; extension detect/download: `FAIL`; subtitle/progressive-probe/Aura playback: `NOT_RUN`
- Confirmed root cause: generic blank media placeholder was not excluded by the candidate URL filter
- Code action: add generic `blank|empty|placeholder` media placeholder rejection and a focused regression test; next staging version `0.3.80`
- Live result after code action: `LIVE-UNVERIFIED`

### 2026-08-17 15:22 KST — candidate-list diagnostic expansion

- Staging version: `0.3.81`
- Adjustment: the source content script now requests the current tab's redacted candidate list without starting a download and stores it in `document.documentElement.dataset.auraQaDetectedCandidates`
- Purpose: distinguish true zero-candidate detection from a stale/expired download overlay diagnostic
- Live result: `NOT_RUN` pending staging reload and AV19 97526 refresh

### 2026-08-17 15:27 KST — automatic candidate-list query on page load

- Staging version: `0.3.82`
- Adjustment: content script requests the tab-scoped candidate list once at page load, even when no download overlay exists
- Live result: `NOT_RUN` pending staging reload and AV19 97526 page refresh

### 2026-08-17 15:42 KST — webRequest trace diagnostic

- Staging version: `0.3.83`
- Adjustment: bounded token-redacted webRequest trace is exposed as `document.documentElement.dataset.auraQaRequestTrace`
- Captured fields: resource host/path, request type, frame IDs, document URL, MIME, HTTP status, phases, cache, and network error
- Purpose: identify the actual AV19 iframe media request that is not becoming a candidate
- Live result: `NOT_RUN` pending staging reload and AV19 page refresh

### 2026-08-17 15:34 KST — AV19 97526 post-placeholder live result

- Browser/channel: user's headed Chrome session
- Staging version: `0.3.82`
- Site ID: `av19-level5-iframe-session` (`https://av19t.com/korea/97526`)
- Native-page playback: `PASS` — the cross-origin player iframe visibly plays
- Detect: `FAIL` — `document.documentElement.dataset.auraQaDetectedCandidates` is exactly `[]` after the blank placeholder filter
- Extension-download: `NOT_RUN`; progressive-probe/Aura playback/subtitle/overlay: `NOT_RUN`
- Conclusion: the 0MB placeholder false-positive is fixed, but the real player source is not exposed as a downloadable candidate in the current user Chrome path. This is now a confirmed provider/player source-exposure gap, not a remaining 0MB-ranking issue.
- Evidence: persistent DOM diagnostic read from the live AV19 tab; previous 0MB trace remains `https://cdn.plyr.io/static/blank.mp4`

### 2026-08-17 16:05 KST — AV19 Level5 inline-source repair

- Browser/channel: user's headed Chrome session
- Staging version: `0.3.84`
- Site ID: `av19-level5-iframe-session` (`https://av19t.com/korea/97526`)
- Native-page playback: `PASS` — cross-origin Level5 iframe reaches `readyState=4` and exposes a playing `blob:` video source
- Detect: `LIVE-UNVERIFIED` — source extraction code is staged; fresh extension reload and candidate read are pending
- Progressive-probe/extension-download/subtitle/overlay: `NOT_RUN`
- Confirmed evidence: iframe inline `Level5Player.play({ url })` URL returns HLS playlist MIME with the iframe referrer; bridge now reports that URL as a Level5 player source
- Regression test: `level5-page-bridge.test.mjs` focused suite passes (7/7)

### 2026-08-17 — AV19 Level5 live request confirmation

- Browser/channel: user's headed Chrome session
- Staging version: `0.3.84`
- Site ID: `av19-level5-iframe-session`
- Native-page playback: `PASS` — iframe video reaches `readyState=4` with a `blob:` source
- Detect: `PASS (source request observed)` — iframe request trace records the Level5 `v.html` URL as HTTP 200 `application/vnd.apple.mpegurl`, followed by `v/session` and media chunks
- Candidate diagnostic: `INCONCLUSIVE` — `auraQaDetectedCandidates` is a one-shot page-load snapshot captured before the delayed iframe HLS request and remains `[]`
- Extension-download/progressive-probe/subtitle/overlay: `NOT_RUN`
- Evidence: token-redacted iframe request trace in `data-aura-qa-request-trace`; current page navigation moved from `97526` to a subsequent AV19 entry during playback

### 2026-08-17 — AV19 `.html` HLS candidate promotion fix

- Browser/channel: user's headed Chrome session
- Staging version: `0.3.85`
- Site ID: `av19-level5-iframe-session`
- Native-page playback: `PASS`
- Detect: `LIVE-UNVERIFIED` pending extension reload — confirmed root cause fixed in candidate admission
- Main-only scope: popup already defaults to `Main only`; no additional candidate box is required
- Extension-download/progressive-probe/subtitle/overlay: `NOT_RUN`
- Regression: explicit HLS MIME on a `.html` provider endpoint is accepted; ordinary `.html` remains rejected

### 2026-08-17 — user live confirmation: MissAV and AV19 downloads

- Browser/channel: user's headed Chrome session
- Staging version: `0.3.85`
- AdBlock/VPN mode: `NOT_REPORTED`
- MissAV: extension-download `PASS` (user-confirmed); detect/playback/progressive-probe/subtitle/overlay `NOT_RUN`
- AV19: extension-download `PASS` (user-confirmed); detect/native-page playback already `PASS`; progressive-probe/subtitle/overlay `NOT_RUN`
- Scope: confirms the extension download path only; it does not imply subtitle or Aura browser-playback support

### 2026-08-17 — aggregate user live result: download vs browser playback

- Browser/channel: user's headed Chrome session
- Staging version: `0.3.85`
- Extension-download: `PASS` for all tested sites except Dood; Dood remains `FAIL`
- Browser/Aura playback: `PASS` only for `asianporn`; other tested sites including MissAV and AV19 are `FAIL` for this surface despite successful downloads
- Native-page playback: separate surface; not inferred from the extension playback result
- Subtitle/progressive-probe/overlay: `NOT_RUN`
- Evidence: direct user report; retain site-specific entries and do not collapse download and playback into one support status

### 2026-08-17 — download mode taxonomy

- Staging version: `0.3.86`
- Added evidence-based mode labels to candidates and download diagnostics: direct progressive, HLS, DASH, player API, player-page graph, authenticated source frame, remote service, and unknown
- Added [site-download-modes.json](site-download-modes.json) and [SITE_DOWNLOAD_MODES.md](SITE_DOWNLOAD_MODES.md) for current mappings and new-site registration
- Validation: full `npm test` pass; Pro staging build pass (`FILES=60`)
- Live site statuses remain those recorded above; taxonomy addition itself is not a live compatibility result

### 2026-08-17 Dood authenticated source-frame finding and fix

- Browser/channel: user's headed Chrome session (browser version `NOT_REPORTED`)
- Extension version: `0.3.86` during reproduction; `0.3.87` staging contains the fix
- Site ID: `doodstream-authenticated-frame`
- AdBlock/VPN mode: `NOT_REPORTED`
- Detect: `PASS` — a tokenized Dood CDN media candidate was available
- Playback: `PASS` — Aura browser player played the candidate
- Progressive-probe: `NOT_RUN`; subtitle/overlay: `NOT_RUN`
- Extension-download: `FAIL` on `0.3.86`
- Direct top-level media URL check: `BLOCKED` — expected hotlink protection and not evidence that the media source is absent
- Confirmed cause: the download refresh path did not preserve the candidate's exact iframe `frameId`, while Dood requires the player-frame request context
- Code action: `0.3.87` passes `videoFrameId` to the Dood refresh request and prefers the authenticated source-frame handoff for Dood progressive candidates
- Regression: `hls-download.test.mjs` focused suite passes
- Live result after fix: `LIVE-UNVERIFIED`; reload the actual Dood page and retest extension-download separately

### 2026-08-17 download overlay global-session behavior fix

- Browser/channel: user's headed Chrome session (browser version `NOT_REPORTED`)
- Extension version: `0.3.87` during reproduction; `0.3.88` staging contains the fix
- Surface: overlay; download and subtitle-generation job history
- Reproduction: overlay state was local to each tab; closing one tab's panel did not suppress panels in other tabs
- Code action: background owns a session-persisted job ID list, sends it on every tab activation/navigation, and broadcasts global hide on close; terminal records remain until that global close
- Live result after fix: `LIVE-UNVERIFIED`; detect/playback/progressive-probe/extension-download/subtitle are not changed by this overlay-only fix

### 2026-08-23 — PlayMogo Dood user Chrome confirmation (0.3.88)

- Browser/channel: user's headed Chrome session; site `https://playmogo.com/d/37fhiw3581dr` (DoodStream title)
- Extension version: `0.3.88` (staging-pro)
- Site ID: `playmogo` / `doodstream-authenticated-frame`
- AdBlock/VPN mode: `NOT_REPORTED`
- Detect: `PASS` — 8 candidates; primary tokenized `DIRECT_PROGRESSIVE` cloudatacdn candidates plus Dood `AUTHENTICATED_SOURCE_FRAME`
- native-page playback: `PASS` (user-confirmed; Aura Media Player session tab open)
- extension-download: `PASS` (user-confirmed on `0.3.88`)
- progressive-probe/subtitle/overlay: `NOT_RUN` downstream surfaces not remeasured
- Evidence: `C:\Users\coseung2\AppData\Local\Temp\aura-mdownloader-dood\playmogo-claimed.json` (token-redacted candidate + request trace) and direct user confirmation
- Note: no code change was made in this turn; this closes INC-2026-08-17-008 for Chrome, Whale remains unverified

### 2026-08-23 — PlayMogo Pro focus-loss pause reproduction (0.3.88)

- Browser/channel: user's headed Chrome session (explicitly not Whale)
- Extension version: `0.3.88` Pro
- Site URL / ID: `https://playmogo.com/d/0p6sbp4xtvw1` / `playmogo`
- AdBlock/VPN mode: `NOT_REPORTED`
- Extension-download: `FAIL` for background-continuation behavior — losing Chrome window focus displayed `일시정지 — 원래 페이지로 돌아가주세요.` despite Pro
- Detect/playback/progressive-probe/subtitle/overlay: `NOT_RUN` on this exact URL in this check
- Confirmed cause: the `WINDOW_ID_NONE` handler bypassed the product plan and directly paused every job
- Fix candidate: `0.3.91`; deterministic regression added, live Chrome retest `NOT_RUN`

### 2026-08-23 — PlayMogo Dood frame churn diagnosis (0.3.88)

- Browser/channel: user's headed Chrome session, explicitly selected by extension instance ID; Whale was not used
- Extension version: `0.3.88` Pro
- Site URL / ID: `https://playmogo.com/d/0p6sbp4xtvw1` / `playmogo`
- AdBlock/VPN mode: `NOT_REPORTED`
- Browser playback: `PASS` by direct user report
- Extension-download: `FAIL/INTERMITTENT` by direct user report; exact failed request could not be captured
- Live diagnostic: the exact PlayMogo tab was listed, but the controllable tab changed to a `ty.tyrotation.com` advertising redirect while it was claimed and the original tab ID became unavailable. This is evidence of active tab/frame churn, not a successful download test.
- Code defect found: Dood fallback cache was tab-wide for ten minutes and refreshed frame IDs were not propagated to the source-frame click
- Fix candidate: `0.3.91`; exact-frame cache, 60-second freshness, playing-frame rediscovery, and downstream frame rebinding added
- Detect/progressive-probe/subtitle/overlay: `NOT_RUN`; post-fix extension-download remains `NOT_RUN`
- Evidence: `C:\Users\coseung2\AppData\Local\Temp\aura-mdownloader-dood-unstable\live-report.json`, `post-claim-tabs.json`, and `reclaim-report.json`

### 2026-08-24 — PlayMogo resume/frame and Dood refresh diagnosis (0.3.92)

- Browser/channel: user's headed Chrome 151 session, selected by extension instance ID; Whale was not used
- Extension version: `0.3.92`, unpacked from `artifacts/chrome-web-store/staging-pro`
- Site URL / ID: `https://playmogo.com/d/0p6sbp4xtvw1` / `playmogo`
- AdBlock/VPN mode: `NOT_REPORTED`
- Native-page playback: `PARTIAL` — user reported that the target video was playing after the resume prompt; during the later read-only inspection the `/e/` frame had already changed to a Google connection-refused document with zero video elements
- Detect: `PASS` for background candidate collection — 14 Dood progressive candidates were present and a tokenized `cloudatacdn` `video.js` candidate was primary; current-playing correlation was stale after frame replacement
- Extension-download: `FAIL` — four recorded jobs ended with the video-preparation-no-response status; target `cloudatacdn` media later produced `net::ERR_FAILED`
- Progressive-probe/subtitle: `NOT_RUN`
- Overlay: `FAIL` — `refreshDownloadOverlay()` repeatedly threw while assigning `dataset` on a returned `ShadowRoot`, interrupting page overlay rendering
- Confirmed failure reason: forced Dood refresh scans the whole `documentElement.outerHTML`; Aura's own candidate diagnostics serialize a previous `/pass_md5/` URL into a root data attribute, allowing the resolver to re-extract an HTML-escaped, malformed path. Those malformed refreshes were followed by failed preparation. The HTTP 200 `text/html` MIME is not independently a failure because the prior successful Dood baseline used the same MIME with an exact URL body.
- Evidence: `C:\Users\coseung2\AppData\Local\Temp\aura-playmogo-diagnosis\aura-qa-summary.json`, `player-frame-state.json`, `live-state.json`, and `extension-version.json`
- Code/version action: `NOT_RUN`; diagnosis only, no source change and no manifest increment

### 2026-08-24 — Shackledshow MxDrop Companion 1% stall diagnosis (0.3.94)

- Browser/channel: user's headed Chrome 151 profile `사용자 이름 1`, selected by extension instance ID; Whale was not used
- Extension version: staging `0.3.94`; the exact unpacked extension ID was confirmed, while direct inspection of extension-scheme pages is browser-policy blocked
- Site URL / ID: `https://shackledshow.cc/videos/1692b65a-48d5-4a6e-a477-9ed151f65568` / `generic` during reproduction, registered as `shackledshow` in fix candidate `0.3.95`
- AdBlock/VPN mode: `NOT_REPORTED`
- Detect: `PASS` for the recorded failing job — tokenized `mxcontent.net` `DIRECT_PROGRESSIVE` media from the `miixdrop.top` `video.js` iframe was present; a fresh diagnostic tab did not start playback and therefore did not create a fresh candidate
- Native-page playback: `PASS` by direct user report
- Progressive-probe: `NOT_RUN` independently; the recorded percentage establishes a known total but does not preserve the exact probe response
- Extension-download: `FAIL` by direct user report — Companion repeatedly remained at 1%; the recorded job was later cancelled
- Subtitle/overlay: `NOT_RUN`
- Separate context-menu retry: `FAIL` with HTTP 403 after losing iframe context; kept separate from the original frame-bound 1% job
- Confirmed code failure: the Companion progressive writer bypassed bounded Range reception and used one unbounded stream even when preparation had established Range support; the folder writer used the resilient six-way Range path
- Evidence: `C:\Users\coseung2\AppData\Local\Temp\aura-shackledshow-1692\page-state.json`, `after-play.json`, `after-second-play.json`, `after-third-play.json`, and user report
- Code/version action: fix candidate `0.3.95`; deterministic native Range and Shackledshow fixture tests pass, post-reload extension-download remains `NOT_RUN`

### 2026-08-24 — Generated subtitle browser-folder save failure with Companion installed

- Browser/channel: user's headed Chrome 151 profile `사용자 이름 1`, selected by extension instance ID; Whale was not used
- Extension version: exact loaded version `NOT_VERIFIED` because extension-scheme inspection is blocked; source/development staging before the fix was `0.3.95`
- Site URL / ID: exact subtitle source not established; current source tabs were AVsee and MissAV with one Aura Player tab
- AdBlock/VPN mode: `NOT_REPORTED`
- Subtitle generation: `PASS` by direct user report
- Subtitle output save: `FAIL` by direct user report — generated result reached the SRT save step but browser subtitle-folder permission was unavailable
- Detect/native-page playback/progressive-probe/extension-download/overlay: `NOT_RUN` for this subtitle incident
- Live diagnostic: current source-page `data-aura-*` diagnostics no longer contained the subtitle job record, so no terminal job payload is inferred beyond the user report
- Confirmed code failure: completed subtitle output attempted only the File System Access subtitle folder and never used the installed Companion native writer
- Evidence: `C:\Users\coseung2\AppData\Local\Temp\aura-subtitle-companion\tabs.json`, `page-diagnostics.json`, user report, and the verified `download-worker.js` save path
- Code/version action: fix candidate `0.3.96` makes Companion the first SRT/media destination and reuses the generated subtitle cache; post-reload subtitle save remains `NOT_RUN`

### 2026-08-24 — AVsee board job title used the board code only (INC-2026-08-24-018)

- Browser/channel: `NOT_RUN` in a browser for this entry; page structure was verified by direct server fetch. Whale was not used
- Extension version: `0.3.99` as reported by the user; fix candidate is `0.4.0`
- Site URL / ID: `https://01.avsee.is/bbs/board.php?bo_table=javmgs&wr_id=90512`, site id `avsee`
- AdBlock/VPN mode: `NOT_REPORTED`
- Detect: `PASS` by direct user report — the download started, so the progressive candidate was found
- Job naming: `FAIL` by direct user report — the job was named `MFC-361` instead of `MFC-361 さな - 사나`
- Playback / progressive-probe / extension-download / subtitle / overlay: `NOT_RUN` for this naming issue
- Live diagnostic: the served page has `<title>MFC-361</title>` and the same `og:title`, while the full title is the first `h2` inside `div.view-content`. The player is a same-origin iframe at `/player/player.php?720=http://cdn.apiavsee.com/h/2026/08/19/MFC-361.mp4`, and fetching that iframe returns `<title>AVseeTV player</title>`
- Confirmed code failure: `content.js` reported `document.title` unconditionally, and a candidate detected inside the player iframe reported the iframe's own generic title because the frame-supplied title outranked the tab title
- Evidence: direct `Invoke-WebRequest` fetches of the board page and the player iframe on 2026-08-24; deterministic fixtures in `sites/avsee/regressions.js`
- Code/version action: `0.4.0` adds an `avsee` site profile with verified read-only title selectors, pushes them from the background to the reporting frame, and prefers the tab title for a player-frame candidate. Post-reload job naming in a real browser remains `NOT_RUN`
- Scope limit: only the `javmgs` board layout was inspected. Other AVsee board tables may use a different heading element and are `NOT_RUN`

### 2026-08-25 — PlayMogo Companion manager auto-open diagnosis (0.4.1)

- Browser/channel: user's headed Chrome profile `사용자 이름 1`; screenshot shows `https://playmogo.com/d/0p6sbp4xtvw1`
- Extension version: source and installed Companion baseline `0.4.1`; fix candidate `0.4.2`
- Site URL / ID: `https://playmogo.com/d/0p6sbp4xtvw1` / `playmogo`
- AdBlock/VPN mode: `NOT_REPORTED`
- Native-page playback: `PASS` by user screenshot; the resume prompt is visible over the playing-page surface
- Detect: `PASS` by direct user report; pressing the extension download button starts saving
- Extension-download: `PARTIAL` — native saving starts, but the manager window does not open and the transfer remains visible only in the extension
- Companion manager: `FAIL` on `0.4.1` — normal `media-open` never called `show-ui` and created no manager-readable state file
- Progressive-probe / subtitle / overlay: `NOT_RUN`
- Confirmed code failure: installed-Companion detection selected the native writer, but the writer and manager were disconnected contracts; `media-open` used a random writer ID and the native host only opened the window for the separate `show-ui` command
- Code/version action: `0.4.2` carries the extension job ID and metadata into `media-open`, persists native progress to the manager job folder, and opens or focuses the manager. Post-reload live download remains `NOT_RUN`

### 2026-08-25 — Jamak DS / PlayMogo Dood slow-download diagnosis (0.4.2)

- Browser/channel: user's headed Chrome profile `사용자 이름 1`; Whale was not used
- Extension version: installed/source baseline `0.4.2`; fix candidate `0.4.3`
- Site URL / ID: `https://jamak.cc/bbs/board.php?bo_table=gallery&wr_id=126&sst=wr_hit&sod=desc&sop=and&page=4`; top-level site is unregistered, embedded provider site is `playmogo` / provider `dood`
- AdBlock/VPN mode: `NOT_REPORTED`
- Playback: `PASS` — activating the DS server loaded `https://playmogo.com/e/6rspotukejm4` and exposed the media source
- Detect: `PASS` — primary candidate was a tokenized `cloudatacdn.com` `PROGRESSIVE` MP4 with `providerId=dood`, `siteId=playmogo`
- Progressive-probe: `PASS` — fresh real URL returned HTTP 206 to `Range: bytes=0-0`, `Content-Range: bytes 0-0/780363155`, `Content-Type: video/mp4`; token values are not recorded
- Extension-download: `FAIL/SLOW` by direct user report on `0.4.2`; confirmed routing chose the browser source-frame path before the Companion bounded Range path
- Subtitle/overlay: `NOT_RUN`
- Code/version action: `0.4.3` retains source-frame fallback for Dood authorization failures but lets prepared Range-capable direct MP4 media use the six-way Companion Range downloader. Post-reload completion and measured throughput are `NOT_RUN`

### 2026-08-25 — Jamak Streamtape detection repair (0.4.3)

- Browser/channel: user's headed Chrome profile `사용자 이름 1`; Whale was not used
- Extension version: baseline `0.4.3`; fix candidate `0.4.4`
- Site URL / ID: `https://www.jamak.cc/bbs/board.php?bo_table=gallery&wr_id=83&page=5` / `jamak`
- AdBlock/VPN mode: `NOT_REPORTED`
- Native-page playback: `PASS` — Streamtape iframe `https://streamtape.com/e/2PXX3pz824FZg6X` and player controls loaded
- Detect: `FAIL` on baseline — candidate list remained empty; `CODE-FIXED / LIVE-UNVERIFIED` on `0.4.4`
- Player-page resolution: `PASS` in current live diagnosis — the rotated Streamtape element expression resolved to a validated same-origin `/get_video` URL with the iframe URL as referrer; token values are not recorded
- Progressive-probe / extension-download / subtitle / overlay: `NOT_RUN`
- Code/version action: `0.4.4` accepts the current known Streamtape element-name rotation, resolves known player iframe responses immediately, and registers the narrow Jamak fixture. A fresh extension reload and download are still required

### 2026-08-25 — Companion YouTube link transient 403 (0.4.3)

- Browser/channel: extension link input feeding the locally installed Companion; browser profile/version not re-read for this job
- Extension/Companion baseline: source `0.4.3`; fix candidate `0.4.4`
- URL: `https://www.youtube.com/watch?v=GKLEMACUWps`; quality `1080`
- Link input: `FAIL` — job `1e96253e-708e-499d-935e-93ef6d4420dc` ended with yt-dlp HTTP 403 while downloading video data
- Reproduction comparison: `PASS` when the same URL, quality, and installed tools were immediately rerun, indicating transient or expired Googlevideo media URLs rather than permanent unavailability
- Code/version action: `0.4.4` retries bounded transport failures and performs one fresh yt-dlp extraction after a terminal 403. Post-install explicit Retry and completed-file verification remain `NOT_RUN`
- Detect / native-page playback / progressive-probe / subtitle / overlay: `NOT_RUN`

### 2026-08-25 — Recu mediafront archive HLS 422 (0.4.4)

- Browser/channel: user-reported browser session; exact browser version/channel was not re-read
- Extension version: baseline inferred as the installed pre-fix build; fix candidate `0.4.5`
- Site URL / ID: `https://recu.me/ellinrose/video/195409102/play` / `recu`
- AdBlock/VPN mode: `NOT_REPORTED`
- Native-page playback: `PASS` by direct user report
- Detect: `PASS` by failure evidence — the extension obtained the mediafront HLS playlist and attempted segment 1
- Extension-download: `FAIL` — `https://f62.mediafront.net/hl/ellinrose/2026-08-23,21-24/seg-1-v1-a1.ts` returned HTTP 422 during the job
- Follow-up network observation: the same historical segment later returned 404 under multiple ordinary header combinations, indicating an expired or replaced generation path; this is not a post-fix download success
- Progressive-probe / subtitle / overlay: `NOT_RUN`
- Code/version action: `0.4.5` refreshes the source-page HLS candidate on 404/410/422 and permits the same media sequence and ordered segment filenames to move to a new generation directory. Deterministic regression is required to pass; live extension-download remains `NOT_RUN` until staging is reloaded

### 2026-08-26 — Segma connector detection and Companion readiness after feature split (0.4.26)

- Browser/channel: Playwright cached Chromium, isolated temporary profile, exact `artifacts/chrome-web-store/staging-pro`; the user's active Chrome/Whale profiles were not restarted or modified
- Extension/Companion version: extension `0.4.26`, installed Segma Player `0.4.26`, extension ID `fnnilboncpjgaachejfhednccmfflmkl`
- Site URL / ID: `https://beeg.com/-0211503327065170` / `beeg`
- AdBlock/VPN mode: Aura AdBlock `on`; VPN `NOT_REPORTED`
- Detect: `PASS` — 14 candidates, including main `video.beeg.com` `HLS_MEDIA` candidates
- Companion detection: `PASS` — protocol 2, `toolsReady=true`, capability `media-download-v1`
- Playback: `NOT_RUN` — browser playback is no longer a shipped extension surface
- Progressive-probe / extension-download / subtitle / overlay: `NOT_RUN`
- Evidence: `artifacts/live-media-0.4.26-staging-beeg-pass.json`; `ok=true`, `rawOk=true`, `companionReady=true`
- Scope limit: the user's existing Chrome/Whale service workers still require an extension reload before their popup and settings surfaces can adopt the corrected background code

### 2026-08-26 — Pre-playback URL discovery expansion and static de-obfuscation (0.4.28)

- Browser/channel: source-only detection patch; no live Chrome/Whale profile was reloaded for this version
- Extension version: `0.4.28`
- Site URL / ID: generic adult streaming URL discovery (`detect` only)
- AdBlock/VPN mode: `NOT_RUN`
- Detect: `CODE-FIXED / LIVE-UNVERIFIED` — deterministic tests cover data-src/JSON-LD/og:video harvest, JSON `play_url` without `.m3u8`, Filemoon/Mixdrop/Voe player pages, and Shadow/`srcdoc` media
- Playback / progressive-probe / extension-download / subtitle / overlay: `NOT_RUN`
- Evidence: focused detection/site regressions 146/146; `npm run build:dev-staging` = `DEV_STAGING_OK` version `0.4.28`
- De-obfuscation evidence: deterministic tests cover Dean Edwards Packer script unpacking, hex-escaped URL decoding, string reversal, percent decoding, and Base64 JSON config extraction without `eval()` (146/146 focused pass)
- Remaining live gap: reload staging `0.4.28` on a page that previously needed playback before an address appeared, plus one Filemoon/Mixdrop/Voe embed

## 2026-08-28 PimpBunny progressive redirect diagnosis

- Extension version: active Chrome development build not re-read during this check; current staging source is `0.4.34`.
- Browser/channel: Chrome; stored Companion jobs from the user's active path.
- Site IDs: `pimpbunny` (unregistered profile at diagnosis time).
- AdBlock/VPN mode: not reported.
- detect: `NOT_RUN` — this check began from already persisted candidate jobs.
- progressive-probe: `PASS` — authenticated candidate with its page referrer returned HTTP 200, `Content-Type: video/mp4`, inline MP4 filename, and 216,533,486-byte length. The final CDN URL path nevertheless ended in `.php`.
- extension-download: `FAIL` — yt-dlp generic extraction rejected the final `.php` path as an unusual extracted extension before saving, despite the MP4 response headers.
- playback, subtitle, overlay: `NOT_RUN`.
- Confirmed diagnosis: PimpBunny serves MP4 bytes through a PHP-named CDN endpoint. This is a yt-dlp URL-extension safety false positive, not evidence that the response body is PHP. No downloader fix was applied in this diagnostic check.

## 2026-08-28 PimpBunny progressive direct-save retest (0.4.35)

- Extension version: source/staging `0.4.35`; the retest replayed the exact persisted Chrome candidate through the newly installed Companion host.
- Browser/channel: Chrome candidate context, installed Windows Companion.
- Site ID: `pimpbunny`.
- AdBlock/VPN mode: not re-read during the persisted-request replay.
- detect: `NOT_RUN` — the exact previously detected request was replayed.
- progressive-probe: `PASS` — prior live probe established HTTP 200, `video/mp4`, inline MP4 filename, and 216,533,486 bytes through the final `.php` CDN path.
- extension-download: `PASS` — completed in 22.6 seconds at 100%; output was 216,533,486 bytes with `.mp4`, and ffprobe reported an MP4-family container with duration 1381.171458 seconds. The previous unusual-PHP-extension error did not recur.
- playback, subtitle, overlay: `NOT_RUN`.
- Evidence: installed host SHA-256 `66c5af52e00c7a69aeab7e5f75307070af613cfb283dc952a397ccbc152e07c5` matched the release binary; Native Host tests 38/38 and focused site/staging/package tests 31/31 passed.

## 2026-08-28 LuluStream browser-bound HLS diagnosis and code fix (0.4.36)

- Extension version: source/staging target `0.4.36`; the active unpacked Chrome extension version was not re-read during diagnosis.
- Browser/channel: Chrome 151 request characteristics, stored Companion job, and direct header-isolation probes.
- Site ID: `lulustream`; page host `luluvdo.com`.
- AdBlock/VPN mode: not reported.
- detect: `NOT_RUN` — diagnosis began from the already persisted `HLS_MEDIA` candidate.
- playback: `NOT_RUN`.
- progressive-probe: `NOT_RUN` — the affected transport is HLS.
- extension-download: `CODE-FIXED / LIVE-UNVERIFIED` — the original Companion request failed at the master manifest with HTTP 403. The token was not expired. The CDN returned 200 when the current browser User-Agent and Accept-Language accompanied Referer/Origin/media Accept; Referer alone and partial combinations returned 403. Cookies were not needed. Installed yt-dlp successfully opened and parsed the exact still-live stored manifest with the new bounded combination (`LULUSTREAM_YTDLP_CONTEXT_OK`), but a freshly reloaded extension job has not yet completed.
- subtitle, overlay: `NOT_RUN`.
- Evidence: exact tokenized URL and secret-bearing probe details remain redacted. Native Host 38/38 and focused protocol/site/package tests 44/44 passed; staging build reported `DEV_STAGING_OK`, version `0.4.36`, 51 files. Installed Host SHA-256 `31f4b51f2ac54154496a847a925a34102e9115c636cff16f46c88c260c92e67f` matches the release build. Manual unpacked-extension reload and fresh Chrome download remain required.

## 2026-08-29 MissAV Cloudflare HLS diagnosis and code fix (0.4.40)

- Extension version: source/staging target `0.4.40`; failed-request baseline `0.4.39`. The active unpacked browser version was not re-read.
- Browser/channel: not supplied; stored Companion request and installed yt-dlp `2026.08.19` were used for the transport A/B.
- Site ID: `missav`; page path `jur-655-uncensored-leak`; media host `surrit.com`.
- AdBlock/VPN mode: not reported.
- detect: `PASS` from the persisted request contract only; the detected candidate was `HLS_MEDIA` on `surrit.com`.
- playback, progressive-probe, subtitle, overlay, tab switching, and Aura AdBlock on/off: `NOT_RUN`.
- extension-download: `PASS` — the exact existing request reproduced Cloudflare HTTP 403 with browser headers. The extractor-local impersonation hint still returned 403, while global Chrome impersonation parsed the live manifest as `generic:m3u8_native`. Installed Native Host `0.4.40` then exercised the Cloudflare-only retry and completed the exact persisted Companion job at 100%.
- Evidence: tokenized URLs remain redacted. Native Host 40/40 and focused architecture/staging/package/site tests 35/35 pass. Build and installed Host SHA-256 both equal `a5e196313f5e482a93ab449e5759d60d8680ce45cd9e9424355f511f8c7046e3`. The saved MP4 is 3,076,881,087 bytes; ffprobe reports duration 7,112.363167 seconds, 1920x1080 H.264 video, and AAC audio. Full `npm test` has only the pre-existing encoded-workspace-path `ENOENT` failures.
- Incident: `INC-2026-08-29-045`.
