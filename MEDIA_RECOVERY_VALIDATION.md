# Media recovery and subtitle ingest validation

> [!NOTE]
> Historical snapshot for version 0.3.76. Preserve this as implementation and
> verification evidence; use `PRODUCT_DIRECTION.md`, `README.md`,
> `SITE_DOWNLOAD_MODES.md`, `INCIDENTS.md`, and `SITE_QA_LOG.md` for current
> direction and runtime status.

## Scope

This document records the implementation and evidence for the 0.3.76 media-recovery work. The starting user reproduction was:

- the native MissAV player played successfully;
- Aura detected the media successfully;
- Aura downloaded the media successfully;
- only Aura Browser Player failed.

That baseline makes the working download path the reference implementation. The changes below align playback request preparation with that path, distinguish request failures from HLS state-machine failures, remove live-monitor false positives, and add an audio-first subtitle path.

## Implemented architecture

### Shared media request context

`media-request-context.js` now resolves the request context used by both download and playback consumers:

```text
observed candidate
  + source tab/frame
  + recorded request headers
  + exact recorded Referer when available
  + fallback referrer
            |
            v
resolveMediaRequestContext
            |
       +----+----+
       |         |
 download lease playback lease
```

The recorded request context wins over a generic page fallback. Consumers identify themselves as `download-media`, `probe-progressive`, `subtitle-audio`, `playback-hls`, or `playback-progressive`, while continuing to receive tab-scoped DNR leases.

### Redacted request diagnostics

The diagnostic store correlates each prepared lease with `webRequest` completion, failure, and redirect events. It records only:

- consumer name;
- target host, file extension, and a one-way path hash;
- exact/origin-path/no header match classification;
- fallback or recorded referrer source and its origin;
- source and request tab/frame identifiers;
- request header names and credential-header names, never values;
- HTTP status or browser network error;
- cache flag, redirect host/status, and duration.

It does not record full URLs, query strings, cookies, authorization values, tokens, or response bodies. `media-request-context.test.mjs` verifies that representative URL, cookie, and authorization secrets do not appear in serialized output.

The diagnostic data can be retrieved only by trusted extension surfaces:

```js
await chrome.runtime.sendMessage({
  type: "get-media-request-diagnostics",
  limit: 100,
});
```

The player also exposes bounded HLS state in `globalThis.__auraPlaybackDiagnostics` for an explicit DevTools verification session.

### HLS recovery separation

Aura previously treated nonfatal hls.js `aborted` notifications as fragment network failures. That could consume the one permitted alternate-candidate recovery while hls.js was internally changing state.

0.3.76 separates recovery decisions:

| Event | Aura action |
| --- | --- |
| nonfatal `aborted` | diagnostic only; leave recovery to hls.js |
| `fragLoadError` or `fragLoadTimeOut` | refresh with an alternate candidate |
| fatal fragment error | fatal recovery with alternate candidate |
| other fatal error | fatal recovery without forcing another media-family candidate |
| other nonfatal error | diagnostic only |

Player diagnostics now include `MEDIA_ATTACHED`, `MANIFEST_PARSED`, `FRAG_LOADING`, `FRAG_LOADED`, `FRAG_PARSED`, and `FRAG_BUFFERED`. This separates HTTP success from parse, decode, append, and playback readiness failures.

### Progressive fallback and candidate classification

The existing source-frame download fallback is now used when Dood-compatible providers reject an authenticated range probe with an explicit response such as HTTP 405, as well as when the probe is unavailable because of browser-origin constraints.

The candidate pipeline now rejects known non-media resources even when a page or response labels them as media:

- Cloudflare RUM and speculation endpoints;
- CSS, fonts, SVG, HTML, JavaScript, JSON, maps, text, and XML resources;
- generic `/d/` and `/e/` player pages.

The MAIN-world observer now performs bounded extraction of known media URL keys from JSON player API responses. It does not replace or call the page's JSON parser, evaluate page code, or walk arbitrary object graphs. This recovered the current OnlyJerk `streaming_url` HLS source while preserving the existing observer security tests.

### Audio-first subtitle ingest

When an HLS master exposes a separate audio rendition, subtitle generation uses this path:

```text
source-page request context
        |
        v
separate HLS audio rendition only
        |
        v
bounded raw audio request stream
        |
        v
Cloudflare Worker validation/proxy
        |
        v
Modal CPU ingest + ffmpeg normalization
        |
        v
16 kHz mono WAV on temporary Volume
        |
        v
GPU ASR + translation only
```

The browser path is bounded to 80 MiB and does not request the selected video rendition. If no separate audio rendition is present, or audio preparation fails for a non-cancellation reason, the existing URL-based path remains the fallback.

Modal work is split so URL acquisition, streamed-upload normalization, and ffmpeg run in CPU functions. The web endpoint writes request chunks directly to a size-checked temporary file instead of buffering the complete audio body in memory. The GPU class mounts the Volume read-only, reads a prepared WAV, and performs only ASR and translation. Distinct temporary inputs use a dedicated Modal Volume v2 and are removed after the job; a bounded stale-file sweep handles interrupted jobs.

## Deterministic verification

### Complete JavaScript suite

Command:

```text
npm test
```

Result:

```text
398 tests
394 passed
0 failed
4 skipped
```

Two skips are the existing PowerShell ZIP-package tests because PowerShell is not installed on this Linux host. The other two are optional popup layout probes because Chrome or Edge is not installed on the host PATH; the separate Playwright live matrix was executed with an explicitly installed Chromium. No deterministic test failed.

### Focused coverage added

The new or strengthened tests cover:

- recorded request context taking precedence over generic fallback;
- diagnostic secret-value exclusion;
- redirects retaining one diagnostic lease;
- parallel identical request correlation;
- nonfatal HLS abort recovery behavior;
- Dood-compatible HTTP 405 source-frame fallback;
- HLS separate-audio rendition selection without video-rendition fetching;
- raw subtitle audio streaming, size metadata validation, and Worker forwarding;
- static resource and generic player-page rejection;
- JSON player API source detection;
- cross-platform Pro staging without creating a ZIP.

### Modal validation

Commands:

```text
python3 -m py_compile modal/asr_app.py
```

and a module load under an isolated environment containing the official Modal SDK 1.5.4.

Results:

- Python syntax compilation: passed;
- Modal `App`, image, Volume, function, class, method, and ASGI decorator construction: passed during module load;
- no remote Modal deployment or GPU invocation was performed from this host.

### Development staging

Command:

```text
npm run build:dev-staging
```

Result:

```text
DEV_STAGING_OK
VERSION=0.3.76
EDITION=pro
FILES=59
STAGING=artifacts/chrome-web-store/staging-pro
```

The cross-platform staging builder:

- uses the explicit audited runtime allowlist;
- includes the new background and player module dependencies;
- applies the store-safe Level5 bridge transformation;
- writes the development popup and `bookmarks` permission;
- audits identifiers and the final exact file list;
- creates no ZIP.

## Browser verification

Evidence file:

```text
artifacts/live-media-0.3.76-final-headed.json
```

Environment:

- headed Playwright Chromium ARM64;
- Xvfb display;
- fixture-recommended Aura AdBlock modes;
- autoplay enabled;
- native-page video snapshot and redacted Aura request diagnostics enabled.

| Site | Detect | Progressive probe | Aura playback | Environment/result |
| --- | --- | --- | --- | --- |
| MissAV SIMD | NOT_RUN | NOT_RUN | NOT_RUN | BLOCKED by top-level HTTP 403/Cloudflare challenge |
| AV19 Level5 | NOT_RUN | NOT_RUN | NOT_RUN | BLOCKED by access-restriction page in the player iframe |
| AsianPorn | PASS | PASS, 101,508,754 bytes | BLOCKED | ARM64 Chromium media codec error 4 |
| OnlyJerk | PASS through JSON API source | NOT_RUN | BLOCKED after manifest HTTP 200 | hls.js `manifestIncompatibleCodecsError` in ARM64 Chromium |
| Playmogo | NOT_RUN after false-positive removal | NOT_RUN | NOT_RUN | BLOCKED by visible Turnstile/captcha |
| MissAV DOCP-259 | NOT_RUN | NOT_RUN | NOT_RUN | BLOCKED by top-level HTTP 403/Cloudflare challenge |
| Beeg | PASS | PASS, 102,237,763 bytes | BLOCKED | exact recorded context selected; ARM64 Chromium media codec error 4 |

The server-side browser run found no confirmed product playback failure because every non-passing case had an explicit site-access or test-browser codec block. It also could not verify the user-reported MissAV player-only failure because the server environment did not reach the page.

`AURA_MONITOR_ALLOW_BLOCKED=1` lets scheduled CI upload evidence when every non-pass is explicitly classified as `BLOCKED`. The report retains `rawOk: false`; actual product failures still fail the workflow.

## Remaining release gates

### MissAV player-only regression

Use `artifacts/chrome-web-store/staging-pro` version 0.3.76 in the user's Windows browser environment. For DOCP-259 and SIMD, test in the same session and in this order:

1. native site playback;
2. Aura detection;
3. Aura extension download;
4. Aura Browser Player;
5. collect `get-media-request-diagnostics` and `__auraPlaybackDiagnostics` only if step 4 fails.

Do not close `INC-2026-08-17-006` until Chrome and Whale show the intended user path. A diagnostic containing HTTP success is not playback proof; `readyState`, frame dimensions, time advancement, and non-paused state must pass.

### Subtitle audio ingest

Before closing `INC-2026-08-17-004`:

1. deploy the updated Cloudflare Worker;
2. deploy the updated Modal app and confirm its secrets and Volumes;
3. run a Pro subtitle job on an HLS source with a separate audio rendition;
4. confirm the browser uploads only the audio rendition;
5. verify progress, cancellation, GPU start after input preparation, VTT result, and SRT save;
6. separately verify the legacy URL fallback on a source without a separate audio rendition.

### Packaging

The staging directory is current at 0.3.76. No development or store ZIP was created because no ZIP was requested. The Windows PowerShell ZIP audits remain required only when a ZIP handoff is explicitly requested.
