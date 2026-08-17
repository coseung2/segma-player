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
