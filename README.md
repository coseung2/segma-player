# Aura Media Downloader

Chrome/Whale Manifest V3 extension for detecting compatible media resources
and saving media the user is authorized to download. Saving runs entirely
inside the extension — no native helper or companion app is required.

## Editions

| Capability | General | Pro |
| --- | --- | --- |
| Concurrent media jobs | 1 | Unlimited |
| Per-download byte limit | 1 GiB | No artificial cap |
| YouTube tab | Not included in the store General edition | Direct Pro distribution only |

The development checkout uses the Pro profile in `edition.js`. The Chrome Web Store packager always replaces it with the audited General profile.

## Architecture

- `page-media-observer.js` collects bounded MAIN-world evidence from hls.js,
  video.js, Plyr, JWPlayer, Level5, Fetch, and XHR without patching MSE buffers.
- `content.js` reports exact frame playback state and structured iframe layout;
  `candidate-ranking.js` combines that evidence into primary/alternate/ad scores.
- `background.js` owns candidate state, short-lived playback sessions, exact
  request-context leases, and source-frame token refresh.
- `download-worker.js` keeps accepted downloads running in an offscreen document
  and `hls-download.js` refreshes short-lived manifests after 401/403 responses.
- `contextual-hls-loader.js` applies the captured iframe Referer/Origin/Cookie
  context to each manifest, segment, and key request made by the browser player.
- `save-directory.js` keeps a one-time File System Access folder handle so the
  extension writes files itself with 6-way parallel reception
  (`parallel-download.js`) — no native helper is involved.
- The notebook YouTube server accepts only HMAC capability tokens issued by the
  license worker (`/api/youtube-token`); free tokens are quota- and
  rate-limited, Pro tokens require an approved key, and the server enforces a
  global daily cap, queue cap, and disk guard.
- The commercial runtime has no VPN, proxy, private egress, or private native bridge dependency.

The store ZIP excludes private page-key code, static site-specific redirect rules, tests, native source, build scripts, and fixed extension keys.

## Development

Bug fixes and regression history are tracked in [INCIDENTS.md](INCIDENTS.md).
Read it before changing a failing path and update it after every handoff.
Real site behavior by extension version, browser, and surface is tracked in
[SITE_QA_LOG.md](SITE_QA_LOG.md); live detection is not treated as proof of
download or subtitle success.

```powershell
rtk npm test
rtk npm run test:media-sites
rtk cargo test --manifest-path native-host/Cargo.toml
rtk cargo fmt --check --manifest-path native-host/Cargo.toml
```

The deterministic media-site fixtures cover the MissAV ad-iframe priority and
AV19/Level5 token-session regressions. An opt-in live smoke probe is available
with `npm run monitor:media-sites`; it writes only redacted candidate URLs to a
versioned, timestamped report under `artifacts/`. The default live target set also permanently
includes the configured AsianPorn, OnlyJerk, Playmogo, and Beeg reproduction
URLs; provider hosts are intentionally not pinned for these rotating live-only
cases. See `MEDIA_PIPELINE_TECHNICAL_REVIEW.md` for the architecture review,
remaining risks, and phased roadmap.

The live monitor prefers the newest unbranded Chromium already present in
`PLAYWRIGHT_BROWSERS_PATH` because it supports unpacked-extension automation.
It falls back to the installed Chrome channel on Windows. Set
`AURA_MONITOR_CHANNEL` or `AURA_MONITOR_EXECUTABLE_PATH` to override detection;
`npm run monitor:media-sites -- --headed` uses a temporary visible profile, and
`--cases=<fixture-id>` runs one configured target.

Use `--adblock=auto`, `--adblock=on`, `--adblock=quiet`,
`--adblock=site-allow`, or `--adblock=off` to load the separate Aura AdBlock
extension in the same temporary profile. Auto mode applies each fixture's
recorded recommendation; the other modes test full blocking, reduced page
intervention, a per-site exception, or a global-off control. Add
`--report=<path>` to keep each matrix result separately.
Add `--autoplay` only for an explicit playback probe; normal monitoring remains
detection-only.

For Cloudflare or Turnstile cases, `--headed --wait-for-challenge=180` brings
the temporary browser forward and pauses for one user verification. It never
automates CAPTCHA interaction; after the challenge disappears, playback,
detection, and reporting resume automatically.

Load the repository root as an unpacked extension for development. No
companion installation is needed; the first download asks for a save folder
once (create a new empty folder under Downloads) and every later download
saves silently with parallel reception.

## Chrome Web Store package

Dry-run package with the Pro link disabled:

```powershell
rtk pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-store-package.ps1
```

Release package after the HTTPS upgrade page exists:

```powershell
rtk pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-store-package.ps1 `
  -UpgradeUrl "https://example.com/aura-media/pro"
```

The deterministic ZIP is written under `artifacts/chrome-web-store`. Follow `STORE_SUBMISSION_CHECKLIST.md` before upload.

## Legacy companion (optional)

The extension no longer uses the native companion (`com.aura.media_companion`)
for saving. The `native-host/`, `install-media-companion.ps1`, and
`scripts/build-companion-installer.ps1` files remain only as legacy references
for older deployments and are not required by the current runtime.

```powershell
rtk pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-companion-installer.ps1 `
  -ExtensionId "<published-store-id>" `
  -ToolsDirectory "<reviewed-tools-directory>" `
  -SignToolName "<configured-inno-sign-tool>"
```

Code signing, HTTPS hosting, store account registration, support contact, legal publisher details, and final policy URLs remain publisher-owned release prerequisites.

## Authorized use

Use the extension only for media you own or are authorized to download. It does not grant rights to third-party content and the store edition does not claim to bypass DRM, authentication, paywalls, or private-video controls.
